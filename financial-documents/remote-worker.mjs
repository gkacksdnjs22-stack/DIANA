import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, open, lstat, realpath } from 'node:fs/promises';
import { FinancialDocuments } from './adapter.mjs';
import { boundedRead, readSelectedText, verifyOpenedOutput } from './files.mjs';
import { strictJSON, keys, fail } from './strict-json.mjs';
import { createFilePolicy } from '../local-ai/files.mjs';
import { checkedDirectory, digest } from '../personal-ai/documents/files.mjs';
import { UUID, FINANCE_FINAL, publicTask, publicFinanceJob, validTask } from '../lib/financial-contract.mjs';
import { acquireWorkerLock } from './worker-lock.mjs';
import { reviewFailure } from './saved-review.mjs';

const within = (root, target) => { const r = path.relative(root, target); return !r || r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r); };
const safeConsole = value => JSON.stringify(value, null, 2).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4,'0'));
const taskSelection=(task,action,format)=>({action,format,target_doc:task.target_doc,source_ids:task.source_ids,guideline_id:task.guideline_id,item_ids:action==='patch'?task.item_ids:[]});

// Resolve a not-yet-created directory via its checked existing ancestor. Reject
// overlaps BEFORE mkdir/lock/journal can place anything in a protected tree.
async function plannedDirectory(directory) {
  let ancestor=path.resolve(directory); const tail=[];
  for (;;) {
    try { await lstat(ancestor); break; }
    catch(e) { if(e.code!=='ENOENT')throw e; const parent=path.dirname(ancestor);if(parent===ancestor)throw e;tail.unshift(path.basename(ancestor));ancestor=parent; }
  }
  await checkedDirectory(ancestor);
  return path.join(await realpath(ancestor),...tail);
}
async function stateBoundary(state, core, configPaths) {
  for(const p of [...core.readRoots,core.outputRoot]) {
    const root=await realpath(p);
    if(within(root,state)||within(state,root))fail('FINANCE_STATE_OVERLAP');
  }
  for(const p of configPaths)if(within(state,await realpath(p)))fail('FINANCE_STATE_OVERLAP');
}

/** Only fixed financial routes. No catalog, transfer, mail, push or AI imports. */
export function financialTransport(env = process.env, fetchImpl = fetch) {
  let base; try { base = new URL(env.API_BASE_URL); } catch { fail('INVALID_SERVER_CONFIG'); }
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/' ||
      !(base.protocol === 'https:' || base.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(base.hostname)) ||
      typeof env.AGENT_TOKEN !== 'string' || env.AGENT_TOKEN.length < 32 || /[\r\n]/u.test(env.AGENT_TOKEN)) fail('INVALID_SERVER_CONFIG');
  return async (route, body) => {
    if (!/^\/api\/agent\/financial\/(?:register|next|jobs\/[a-f0-9-]{36}\/(?:status|observe))$/u.test(route)) fail('NETWORK_ROUTE_DENIED');
    let response;
    try { response = await fetchImpl(base.origin + route, { method:'POST', redirect:'error', signal:AbortSignal.timeout(20_000), headers:{Authorization:'Bearer '+env.AGENT_TOKEN,'Content-Type':'application/json'}, body:JSON.stringify(body) }); }
    catch { fail('CONTROL_OFFLINE'); }
    if (!response.ok) throw Object.assign(new Error('CONTROL_REJECTED'), { code:'CONTROL_REJECTED', status:response.status });
    const bytes = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > 40_000) fail('CONTROL_RESPONSE_INVALID'); bytes.push(chunk); }
    try { return strictJSON(Buffer.concat(bytes).toString('utf8')); } catch { fail('CONTROL_RESPONSE_INVALID'); }
  };
}

export class FinancialWorker {
  #configPath; #configHash; #config; #coreConfig; #coreHash; #adapter; #policy; #api; #out; #onEvent; #detailOutput; #active = null; #lock; #stateRoot; #workerId = randomUUID(); #chain = Promise.resolve();
  static async create({ configPath, api, output = () => {}, onEvent = () => {}, detailOutput = true, documentRoot = path.resolve('sample-documents') }) {
    const w = new FinancialWorker(); w.#configPath = path.resolve(configPath); w.#api = api; w.#out = output; w.#onEvent = onEvent; w.#detailOutput = detailOutput;
    const raw = await boundedRead(w.#configPath, 100_000); w.#configHash = raw.hash; const c = strictJSON(raw.content);
    keys(c, ['schema_version','coreConfig','stateDir','tasks']);
    if (c.schema_version !== 1 || !path.isAbsolute(c.coreConfig) || !path.isAbsolute(c.stateDir) || !Array.isArray(c.tasks) || !c.tasks.length || c.tasks.length > 20) fail('INVALID_WORKER_CONFIG');
    const seen = new Set();
    for (const t of c.tasks) {
      keys(t, ['id','label','actions','formats','target_doc','source_ids','guideline_id','item_ids']);
      if (!validTask(publicTask(t)) || seen.has(t.id)) fail('INVALID_WORKER_CONFIG'); seen.add(t.id);
    }
    w.#config = c;
    const core = await boundedRead(c.coreConfig, 100_000); w.#coreHash = core.hash; w.#coreConfig = strictJSON(core.content);
    w.#adapter = await FinancialDocuments.create({ configPath:c.coreConfig });
    w.#stateRoot=await plannedDirectory(c.stateDir);
    await stateBoundary(w.#stateRoot,w.#coreConfig,[c.coreConfig,w.#configPath]);
    // Fail closed if the ordinary document catalog could reach finance inputs/outputs/state/config.
    // Check real roots too; symlinks/alternate spelling cannot evade this overlap check.
    const generic = await realpath(path.resolve(documentRoot));
    await mkdir(c.stateDir, {recursive:true, mode:0o700}); await checkedDirectory(c.stateDir);
    for (const p of [...w.#coreConfig.readRoots, w.#coreConfig.outputRoot, c.stateDir]) {
      const real = await realpath(p);
      if (within(generic, real) || within(real, generic)) fail('FINANCE_CATALOG_OVERLAP');
    }
    for (const p of [c.coreConfig,w.#configPath]) if (within(generic,await realpath(p))) fail('FINANCE_CATALOG_OVERLAP');
    for (const t of c.tasks) {
      for (const a of t.actions) for (const f of t.formats) {
        const { explicitOperation } = await import('./operation.mjs');
        explicitOperation({ action:a, format:f, target_doc:t.target_doc, source_ids:t.source_ids, guideline_id:t.guideline_id, item_ids:a === 'patch' ? t.item_ids : [] });
      }
    }
    w.#policy = await createFilePolicy(w.#coreConfig.readRoots, w.#coreConfig.outputRoot);
    // Lifetime coordinator lease + O_EXCL: one local approval owner, including
    // stale-file recovery and release.
    w.#lock=await acquireWorkerLock(c.stateDir,{pid:process.pid,workerId:w.#workerId});
    try{await w.#restoreSaved();}catch(e){await w.#lock.close();w.#lock=null;throw e;}
    return w;
  }
  serial(action) { const p = this.#chain.then(action); this.#chain = p.catch(() => {}); return p; }
  #emit(type,data) {
    // Local presentation only. Never hand the renderer a live executable plan.
    try { this.#onEvent(structuredClone({type,...data})); } catch {}
  }
  #presentJob(a) {
    this.#emit('job',{job:publicFinanceJob(a.job),label:a.task?.label||'금융 문서 작업',phase:a.phase,
      approvalReady:a.phase==='review'&&a.job.state==='PC_REVIEW_REQUIRED'&&!a.outbox&&!a.noJournal&&Date.now()<=a.approvalExpires,
      approvalExpires:a.approvalExpires||null});
  }
  #presentResult(id,result,historical=false){
    this.#emit('result',{requestId:id,result:{status:result.status,saved:result.saved===true,storageVerified:result.storage_verified===true,
      reviewComplete:typeof result.review_complete==='boolean'?result.review_complete:null,outputFile:result.outputFile||'',unresolved:result.unresolved||[],historical}});
  }
  async #restoreSaved(){
    const candidates=[];for(const task of this.#config.tasks)for(const action of task.actions)for(const format of task.formats)if(['patch','convert'].includes(action))candidates.push({task,input:taskSelection(task,action,format)});
    const saved=await this.#adapter.loadSavedResults(candidates.map(c=>c.input));
    for(const entry of saved.reverse()){
      if(!UUID.test(entry.requestId))continue;const{task,input}=candidates[entry.selectionIndex];
      // A completed storage receipt alone is not a confirmed worker outcome:
      // audit/close/report failures can still have ended UNCERTAIN. Require the
      // worker's last durable, acknowledged completion too; never repair state.
      let last;try{const raw=(await boundedRead(path.join(this.#stateRoot,entry.requestId+'.jsonl'),2_000_000)).content;
        last=strictJSON(raw.trimEnd().split('\n').at(-1));keys(last,['version','job','phase','outbox']);
      }catch{continue;}
      const job=last.job;
      if(last.version!==1||last.outbox!==null||job?.id!==entry.requestId||job.taskId!==task.id||job.action!==input.action||job.format!==input.format||job.state!=='LOCAL_SAVE_COMPLETED'||job.code!=='PC_SAVED'||job.saved!==true||!Number.isSafeInteger(job.revision))continue;
      this.#emit('job',{job:publicFinanceJob(job),label:task.label,phase:'finished',approvalReady:false,approvalExpires:null});
      this.#presentResult(entry.requestId,{...entry.result,review_complete:job.reviewComplete===true},true);
    }
  }
  async reviewSaved(id){return this.serial(async()=>{
    if(!UUID.test(id))fail('LOCAL_REVIEW_INVALIDATED');
    try{
      if(!await this.#policyCurrent())fail('LOCAL_REVIEW_INVALIDATED');
      const review=await this.#adapter.reviewSaved(id);this.#emit('recheck',{requestId:id,recheck:review});
    }catch(error){this.#emit('recheck',{requestId:id,recheck:{...reviewFailure(error),checkedAt:new Date().toISOString()}});throw error;}
  });}
  async #policyCurrent() {
    return (await boundedRead(this.#configPath,100_000)).hash === this.#configHash && (await boundedRead(this.#config.coreConfig,100_000)).hash === this.#coreHash;
  }
  async #journal(a) {
    // A preexisting/legacy file is evidence to block execution, not permission
    // to replace it with a failure report. Such reports remain metadata-only.
    if(a.noJournal)return;
    try { await this.#appendJournal(a); }
    catch(e) {
      // Losing journal ownership disarms approval and all further disk writes.
      // A later tick may report BLOCKED/UNCERTAIN, never resume execution.
      a.noJournal=true;this.#adapter.cancelPending();
      try{await this.#closeJournal(a);}catch{}
      throw e;
    }
  }
  async #appendJournal(a) {
    await checkedDirectory(this.#config.stateDir);
    if(await realpath(this.#config.stateDir)!==this.#stateRoot)fail('FINANCE_STATE_OVERLAP');
    await stateBoundary(this.#stateRoot,this.#coreConfig,[this.#config.coreConfig,this.#configPath]);
    const destination=path.join(this.#stateRoot,a.job.id+'.jsonl');
    if(!a.journal) {
      try { a.journal={handle:await open(destination,'ax',0o600),bytes:Buffer.alloc(0)}; }
      catch(e) { if(e.code==='EEXIST'){a.noJournal=true;fail('JOURNAL_CONFLICT');}throw e; }
    }
    const j=a.journal;
    await verifyOpenedOutput(j.handle,destination,this.#stateRoot);
    if(j.bytes.length)await boundedRead(destination,2_000_000,digest(j.bytes));
    const line=Buffer.from(JSON.stringify({version:1,job:a.job,phase:a.phase,outbox:a.outbox||null})+'\n');
    const next=Buffer.concat([j.bytes,line]);if(next.length>2_000_000)fail('JOURNAL_LIMIT');
    // Append to the exclusively created, verified open handle. No rename,
    // truncate, or overwrite of any existing journal/source file.
    await j.handle.writeFile(line);await j.handle.sync();
    await verifyOpenedOutput(j.handle,destination,this.#stateRoot);
    await boundedRead(destination,2_000_000,digest(next));j.bytes=next;
  }
  async #closeJournal(a) { if(a?.journal){const j=a.journal;a.journal=null;await j.handle.close();} }
  async #finishPreparation(a, observed=false) {
    if(!observed)await this.#observe(a);
    if(FINANCE_FINAL.has(a.job.state)){this.#adapter.cancelPending();return;}
    if(a.phase==='preparation_failed'){
      await this.#report(a,a.failureState||'FAILED',a.failureCode||'LOCAL_OPERATION_FAILED');return;
    }
    if(!a.plan){this.#adapter.cancelPending();await this.#report(a,'FAILED','LOCAL_OPERATION_FAILED');return;}
    if(Date.now()>a.approvalExpires){this.#adapter.cancelPending();await this.#report(a,'BLOCKED','LOCAL_CHECK_FAILED');return;}
    if(a.plan.status==='AWAITING_APPROVAL'){
      a.phase='review';
      if(await this.#report(a,'PC_REVIEW_REQUIRED','PC_CHECK_REQUIRED'))this.#reviewInstructions(a);
    }else{
      const state=['ACTION_REQUIRED','CLARIFICATION_REQUIRED'].includes(a.plan.status)?'WAITING_FOR_INFORMATION':a.plan.status==='READY'?'REVIEW_COMPLETED':a.plan.status==='BLOCKED'?'BLOCKED':'FAILED';
      const code={WAITING_FOR_INFORMATION:'PC_INFORMATION_REQUIRED',REVIEW_COMPLETED:a.plan.reason==='ALREADY_SATISFIED'?'NO_CHANGE_REQUIRED':'PC_REVIEWED',BLOCKED:'LOCAL_CHECK_FAILED',FAILED:'LOCAL_OPERATION_FAILED'}[state];
      await this.#report(a,state,code,false,a.plan.review_complete===true&&state==='REVIEW_COMPLETED');
    }
  }
  #reviewInstructions(a) {
    if(a.phase==='review'&&a.job.state==='PC_REVIEW_REQUIRED'&&!a.outbox&&!a.noJournal&&!a.reviewAnnounced){
      this.#out(`로컬 최종 승인: approve ${a.job.id}\n거절: reject ${a.job.id}\n취소: cancel ${a.job.id}\n`);
      a.reviewAnnounced=true;
    }
  }
  async register() {
    if (!await this.#policyCurrent()) fail('LOCAL_POLICY_CHANGED');
    await this.#api('/api/agent/financial/register', { workerId:this.#workerId, tasks:this.#config.tasks.map(publicTask) });
  }
  async #observe(a) {
    const j = (await this.#api(`/api/agent/financial/jobs/${a.job.id}/observe`, {workerId:this.#workerId})).job;
    if (!j || j.id !== a.job.id || !Number.isSafeInteger(j.revision)) fail('CONTROL_RESPONSE_INVALID');
    a.job = j; this.#presentJob(a); return j;
  }
  async #report(a, state, code, saved = false, reviewComplete = false) {
    a.outbox = {workerId:this.#workerId, generation:a.generation, revision:a.job.revision, reportId:randomUUID(), state, code, saved, reviewComplete};
    try { await this.#journal(a); } catch(e) { a.outbox=null;throw e; }
    return this.#flush(a);
  }
  async #flush(a) {
    try {
      const result = await this.#api(`/api/agent/financial/jobs/${a.job.id}/status`, a.outbox);
      if (!result.job || result.job.id !== a.job.id) fail('CONTROL_RESPONSE_INVALID');
      const matched=result.job.state === a.outbox.state;
      // The report may have been accepted before its ACK was lost, followed by
      // cancellation/expiry. The retry returns CURRENT state, never resurrect it.
      if(!matched && (!FINANCE_FINAL.has(result.job.state)||result.job.revision<a.outbox.revision))fail('CONTROL_RESPONSE_INVALID');
      a.job = result.job; a.outbox = null;
      if(!matched){this.#adapter.cancelPending();a.phase='terminal';}
      await this.#journal(a); this.#presentJob(a); return matched;
    } catch (e) {
      if (e.status === 409) {
        await this.#observe(a); a.outbox = null;
        if (FINANCE_FINAL.has(a.job.state)) { this.#adapter.cancelPending(); a.phase = 'terminal'; await this.#journal(a); return false; }
      }
      throw e;
    }
  }
  async tick() { return this.serial(() => this.#tick()); }
  async #tick() {
    if (!await this.#policyCurrent()) {
      this.#adapter.cancelPending();
      if (this.#active && !FINANCE_FINAL.has(this.#active.job.state)) {
        const a=this.#active; await this.#observe(a);
        if (!FINANCE_FINAL.has(a.job.state)) await this.#report(a, a.job.state === 'LOCAL_SAVING' ? 'UNCERTAIN' : 'BLOCKED', a.job.state === 'LOCAL_SAVING' ? 'RECOVERY_REQUIRED' : 'POLICY_CHANGED');
      }
      fail('LOCAL_POLICY_CHANGED');
    }
    await this.register();
    if (this.#active) {
      const a = this.#active;
      if (a.outbox) await this.#flush(a);
      await this.#observe(a);
      if (FINANCE_FINAL.has(a.job.state)) { this.#adapter.cancelPending(); await this.#closeJournal(a); this.#active = null; return; }
      if(a.noJournal){this.#adapter.cancelPending();await this.#report(a,a.job.state==='LOCAL_SAVING'?'UNCERTAIN':'BLOCKED',a.job.state==='LOCAL_SAVING'?'RECOVERY_REQUIRED':'LOCAL_CHECK_FAILED');return;}
      if(a.phase==='preparing'||a.phase==='preparation_failed'){await this.#finishPreparation(a,true);return;}
      if (a.phase === 'executing' || a.phase === 'save_gate') {
        // Never resume an execution after a network exception or restart.
        this.#adapter.cancelPending(); await this.#report(a,'UNCERTAIN','RECOVERY_REQUIRED'); return;
      }
      if (Date.now() > a.approvalExpires) { this.#adapter.cancelPending(); await this.#report(a,'BLOCKED','LOCAL_CHECK_FAILED'); }
      else this.#reviewInstructions(a);
      return;
    }
    const received = (await this.#api('/api/agent/financial/next', {workerId:this.#workerId})).job;
    if (!received) return;
    if (!UUID.test(received.id) || received.workerId !== this.#workerId || received.state !== 'PROCESSING' || !Number.isSafeInteger(received.generation)) fail('CONTROL_RESPONSE_INVALID');
    const task = this.#config.tasks.find(t => t.id === received.taskId && t.actions.includes(received.action) && t.formats.includes(received.format));
    const a = {job:received, task, generation:received.generation, phase:'preparing', outbox:null}; this.#active = a; this.#presentJob(a);
    try {
      // An existing journal is never treated as permission to execute again.
      for(const extension of ['.json','.jsonl']) {
        let exists=false;try { await lstat(path.join(this.#stateRoot,received.id+extension));exists=true; }
        catch(e){if(e.code!=='ENOENT')throw e;}
        if(exists){a.noJournal=true;await this.#report(a,'BLOCKED','LOCAL_CHECK_FAILED');return;}
      }
      await this.#journal(a);
      if (!task) { await this.#report(a,'BLOCKED','LOCAL_CHECK_FAILED'); return; }
      a.task = task;
      a.plan = await this.#adapter.prepare(taskSelection(task,received.action,received.format), {requestId:received.id});
      a.approvalExpires=Date.now()+this.#coreConfig.approval_ttl_ms;
      // Source, evidence and output go ONLY to the local PC presentation.
      const localDocs = [];
      for (const id of [task.target_doc,...task.source_ids,task.guideline_id]) {
        const entry = this.#coreConfig.documents.find(d => d.id === id && d.read_roles.includes(this.#coreConfig.role));
        if (!entry) fail('ACCESS_DENIED'); localDocs.push(await readSelectedText(this.#policy,entry));
      }
      this.#emit('review',{requestId:received.id,documents:localDocs.map(({id,format,content})=>({id,format,content})),
        review:{status:a.plan.status,reason:a.plan.reason,items:a.plan.items||[],unresolved:a.plan.unresolved||[],
          before:localDocs[0]?.content||'',after:a.plan.expected_body||'',diff:a.plan.unified_diff||'',output:a.plan.output_content||'',reviewComplete:a.plan.review_complete===true}});
      if(this.#detailOutput)this.#out('PC 전용 검토 · 문서 내용/최종 승인/결과 파일은 PC에만 유지\n' + safeConsole({requestId:received.id, operation:{action:received.action,format:received.format}, localDocuments:localDocs, plan:a.plan}) + '\n');
    } catch (e) {
      if (a.outbox) throw e; // An ACK failure only retries its metadata report.
      this.#adapter.cancelPending();
      a.phase='preparation_failed';a.failureState=e.code==='JOURNAL_CONFLICT'?'BLOCKED':'FAILED';a.failureCode=e.code==='JOURNAL_CONFLICT'?'LOCAL_CHECK_FAILED':'LOCAL_OPERATION_FAILED';
    }
    // Communication failures here retain the prepared plan or fixed failure
    // outcome. The next tick explicitly resumes this phase, never prepare().
    await this.#finishPreparation(a);
  }
  /** Local terminal or authenticated loopback UI only; never the relay server. */
  async localCommand(command, id) { return this.serial(async () => {
    const a = this.#active;
    if (!['approve','reject','cancel'].includes(command) || !UUID.test(id) || !a || a.job.id !== id || a.phase !== 'review' || a.outbox || a.noJournal) fail('NO_LOCAL_REVIEW');
    await this.register(); await this.#observe(a);
    if (a.job.state !== 'PC_REVIEW_REQUIRED' || !await this.#policyCurrent()) { this.#adapter.cancelPending(); fail('LOCAL_REVIEW_INVALIDATED'); }
    if (command !== 'approve') { this.#adapter.cancelPending(); await this.#report(a,'CANCELLED',command==='reject'?'PC_REJECTED':'USER_CANCELLED'); return; }
    const approved = await this.#adapter.approve(a.plan.plan_id,a.plan.plan_hash);
    if (!approved.token) { await this.#report(a,'BLOCKED','LOCAL_CHECK_FAILED'); return; }
    if (!await this.#policyCurrent()) { this.#adapter.cancelPending(); await this.#report(a,'BLOCKED','POLICY_CHANGED'); return; }
    // Durable local intent then atomic server gate. Cancel wins before this gate;
    // once LOCAL_SAVING is acknowledged, remote cancellation cannot claim success.
    a.phase='save_gate'; await this.#journal(a);
    if (!await this.#report(a,'LOCAL_SAVING','PC_SAVING')) { this.#adapter.cancelPending(); return; }
    a.phase='executing'; await this.#journal(a);
    if (!await this.#policyCurrent() || Date.now() >= Date.parse(a.job.expiresAt)) {
      this.#adapter.cancelPending(); a.phase='finished'; await this.#report(a,'UNCERTAIN','RECOVERY_REQUIRED'); return;
    }
    let result;
    const expire=setTimeout(()=>this.#adapter.cancelPending(),Math.max(1,Math.min(approved.expires_at,Date.parse(a.job.expiresAt))-Date.now()));
    try { result=await this.#adapter.execute(approved.token); }
    catch { result={status:'UNCERTAIN'}; }
    finally { clearTimeout(expire); }
    this.#presentResult(a.job.id,result);
    if(this.#detailOutput)this.#out('PC 전용 저장 결과\n'+safeConsole(result)+'\n');
    const saved=result.status==='COMPLETED' && result.saved===true && result.storage_verified===true;
    a.phase='finished';
    // Persist this outcome before attempting its network ACK; never execute twice.
    await this.#report(a,saved?'LOCAL_SAVE_COMPLETED':'UNCERTAIN',saved?'PC_SAVED':'RECOVERY_REQUIRED',saved,saved && result.review_complete===true);
  }); }
  async close() {
    await this.#chain; this.#adapter.cancelPending();
    await this.#closeJournal(this.#active);
    if (this.#lock) { const lease=this.#lock;this.#lock=null;await lease.close(); }
  }
}
