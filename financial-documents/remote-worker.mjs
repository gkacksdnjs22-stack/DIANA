import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, lstat, realpath, readFile, unlink } from 'node:fs/promises';
import { FinancialDocuments } from './adapter.mjs';
import { boundedRead, readSelectedText } from './files.mjs';
import { strictJSON, keys, fail } from './strict-json.mjs';
import { createFilePolicy } from '../local-ai/files.mjs';
import { checkedDirectory } from '../personal-ai/documents/files.mjs';
import { UUID, FINANCE_FINAL, publicTask, validTask } from '../lib/financial-contract.mjs';

const within = (root, target) => { const r = path.relative(root, target); return !r || r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r); };
const safeConsole = value => JSON.stringify(value, null, 2).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4,'0'));

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
  #configPath; #configHash; #config; #coreConfig; #coreHash; #adapter; #policy; #api; #out; #active = null; #lock; #workerId = randomUUID(); #chain = Promise.resolve();
  static async create({ configPath, api, output = () => {}, documentRoot = path.resolve('sample-documents') }) {
    const w = new FinancialWorker(); w.#configPath = path.resolve(configPath); w.#api = api; w.#out = output;
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
    // O_EXCL: two local consoles must never own the same approval state.
    const lockPath = path.join(c.stateDir, 'worker.lock');
    try { w.#lock = await open(lockPath, 'wx', 0o600); }
    catch (e) {
      if(e.code!=='EEXIST')throw e;
      const previous=strictJSON((await boundedRead(lockPath,4096)).content);
      if(!Number.isInteger(previous.pid)||previous.pid<1||!UUID.test(previous.workerId))fail('WORKER_LOCK_UNCERTAIN');
      let dead=false;try{process.kill(previous.pid,0);}catch(error){dead=error.code==='ESRCH';}
      if(!dead)fail('WORKER_ALREADY_RUNNING');
      // Retain abandoned metadata for local recovery. Never kill any process.
      await rename(lockPath,path.join(c.stateDir,'abandoned-'+previous.workerId+'.lock'));
      w.#lock=await open(lockPath,'wx',0o600);
    }
    await w.#lock.writeFile(JSON.stringify({pid:process.pid,workerId:w.#workerId})); await w.#lock.sync();
    return w;
  }
  serial(action) { const p = this.#chain.then(action); this.#chain = p.catch(() => {}); return p; }
  async #policyCurrent() {
    return (await boundedRead(this.#configPath,100_000)).hash === this.#configHash && (await boundedRead(this.#config.coreConfig,100_000)).hash === this.#coreHash;
  }
  async #journal(a) {
    await checkedDirectory(this.#config.stateDir);
    const destination = path.join(this.#config.stateDir, a.job.id + '.json'), temporary = destination + '.new';
    const h = await open(temporary, 'wx', 0o600);
    try { await h.writeFile(JSON.stringify({version:1, job:a.job, phase:a.phase, outbox:a.outbox || null})); await h.sync(); }
    finally { await h.close(); }
    await rename(temporary, destination);
  }
  async register() {
    if (!await this.#policyCurrent()) fail('LOCAL_POLICY_CHANGED');
    await this.#api('/api/agent/financial/register', { workerId:this.#workerId, tasks:this.#config.tasks.map(publicTask) });
  }
  async #observe(a) {
    const j = (await this.#api(`/api/agent/financial/jobs/${a.job.id}/observe`, {workerId:this.#workerId})).job;
    if (!j || j.id !== a.job.id || !Number.isSafeInteger(j.revision)) fail('CONTROL_RESPONSE_INVALID');
    a.job = j; return j;
  }
  async #report(a, state, code, saved = false, reviewComplete = false) {
    a.outbox = {workerId:this.#workerId, generation:a.generation, revision:a.job.revision, reportId:randomUUID(), state, code, saved, reviewComplete};
    await this.#journal(a); return this.#flush(a);
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
      await this.#journal(a); return matched;
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
      if (FINANCE_FINAL.has(a.job.state)) { this.#adapter.cancelPending(); this.#active = null; return; }
      if (a.phase === 'executing' || a.phase === 'save_gate') {
        // Never resume an execution after a network exception or restart.
        this.#adapter.cancelPending(); await this.#report(a,'UNCERTAIN','RECOVERY_REQUIRED'); return;
      }
      if (Date.now() > a.approvalExpires) { this.#adapter.cancelPending(); await this.#report(a,'BLOCKED','LOCAL_CHECK_FAILED'); }
      return;
    }
    const received = (await this.#api('/api/agent/financial/next', {workerId:this.#workerId})).job;
    if (!received) return;
    if (!UUID.test(received.id) || received.workerId !== this.#workerId || received.state !== 'PROCESSING' || !Number.isSafeInteger(received.generation)) fail('CONTROL_RESPONSE_INVALID');
    const task = this.#config.tasks.find(t => t.id === received.taskId && t.actions.includes(received.action) && t.formats.includes(received.format));
    const a = {job:received, generation:received.generation, phase:'preparing', outbox:null}; this.#active = a;
    try {
      // An existing journal is never treated as permission to execute again.
      try { await lstat(path.join(this.#config.stateDir,received.id+'.json')); await this.#report(a,'BLOCKED','LOCAL_CHECK_FAILED'); return; }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      await this.#journal(a);
      if (!task) { await this.#report(a,'BLOCKED','LOCAL_CHECK_FAILED'); return; }
      a.task = task;
      a.plan = await this.#adapter.prepare({action:received.action, format:received.format, target_doc:task.target_doc, source_ids:task.source_ids, guideline_id:task.guideline_id, item_ids:received.action === 'patch' ? task.item_ids : []}, {requestId:received.id});
      // Full source, evidence and output are rendered ONLY to the PC console.
      const localDocs = [];
      for (const id of [task.target_doc,...task.source_ids,task.guideline_id]) {
        const entry = this.#coreConfig.documents.find(d => d.id === id && d.read_roles.includes(this.#coreConfig.role));
        if (!entry) fail('ACCESS_DENIED'); localDocs.push(await readSelectedText(this.#policy,entry));
      }
      this.#out('PC 전용 검토 · 문서 내용/최종 승인/결과 파일은 PC에만 유지\n' + safeConsole({requestId:received.id, operation:{action:received.action,format:received.format}, localDocuments:localDocs, plan:a.plan}) + '\n');
      await this.#observe(a);
      if (FINANCE_FINAL.has(a.job.state)) { this.#adapter.cancelPending(); return; }
      if (a.plan.status === 'AWAITING_APPROVAL') {
        a.phase='review'; a.approvalExpires=Date.now()+this.#coreConfig.approval_ttl_ms;
        if(await this.#report(a,'PC_REVIEW_REQUIRED','PC_CHECK_REQUIRED'))
          this.#out(`로컬 최종 승인: approve ${received.id}\n거절: reject ${received.id}\n취소: cancel ${received.id}\n`);
      } else {
        const state = ['ACTION_REQUIRED','CLARIFICATION_REQUIRED'].includes(a.plan.status) ? 'WAITING_FOR_INFORMATION' : a.plan.status === 'READY' ? 'REVIEW_COMPLETED' : a.plan.status === 'BLOCKED' ? 'BLOCKED' : 'FAILED';
        const code = {WAITING_FOR_INFORMATION:'PC_INFORMATION_REQUIRED',REVIEW_COMPLETED:a.plan.reason==='ALREADY_SATISFIED'?'NO_CHANGE_REQUIRED':'PC_REVIEWED',BLOCKED:'LOCAL_CHECK_FAILED',FAILED:'LOCAL_OPERATION_FAILED'}[state];
        await this.#report(a,state,code,false,a.plan.review_complete===true && state==='REVIEW_COMPLETED');
      }
    } catch (e) {
      this.#adapter.cancelPending();
      if (a.outbox) throw e; // An ACK failure only retries its metadata report.
      await this.#observe(a);
      if (!FINANCE_FINAL.has(a.job.state)) await this.#report(a,'FAILED','LOCAL_OPERATION_FAILED');
    }
  }
  /** Called exclusively by local terminal input; there is no network approval API. */
  async localCommand(command, id) { return this.serial(async () => {
    const a = this.#active;
    if (!['approve','reject','cancel'].includes(command) || !UUID.test(id) || !a || a.job.id !== id || a.phase !== 'review' || a.outbox) fail('NO_LOCAL_REVIEW');
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
    this.#out('PC 전용 저장 결과\n'+safeConsole(result)+'\n');
    const saved=result.status==='COMPLETED' && result.saved===true && result.storage_verified===true;
    a.phase='finished';
    // Persist this outcome before attempting its network ACK; never execute twice.
    await this.#report(a,saved?'LOCAL_SAVE_COMPLETED':'UNCERTAIN',saved?'PC_SAVED':'RECOVERY_REQUIRED',saved,saved && result.review_complete===true);
  }); }
  async close() {
    await this.#chain; this.#adapter.cancelPending();
    if (this.#lock) { await this.#lock.close(); this.#lock=null; await unlink(path.join(this.#config.stateDir,'worker.lock')); }
  }
}
