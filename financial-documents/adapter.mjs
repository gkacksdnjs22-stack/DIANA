import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, open, lstat, realpath, opendir } from 'node:fs/promises';
import { createFilePolicy } from '../local-ai/files.mjs';
import { checkedDirectory, digest } from '../personal-ai/documents/files.mjs';
import { boundedRead, readSelectedText, verifyOpenedOutput } from './files.mjs';
import { callCore, verifiedPython } from './python.mjs';
import { conversionOperation } from './conversion-operation.mjs';
import { searchOperation } from './evidence-search.mjs';
import { draftOperation } from './draft-operation.mjs';
import { explicitOperation } from './operation.mjs';
import { fail, keys, strictJSON, validId } from './strict-json.mjs';
import { storedClassification, assertCompletedCoreReview } from './saved-review.mjs';

const HASH = /^[a-f0-9]{64}$/u;
const clone = structuredClone;
const errResult = error => ({ schema_version: 1,
  status: ['ACCESS_DENIED', 'EXTERNAL_EXPORT_DENIED'].includes(error.code) ? 'BLOCKED' :
    ['CONTENT_CHANGED', 'FILE_CHANGED', 'POLICY_CHANGED', 'PLAN_CHANGED', 'APPROVAL_EXPIRED', 'UNKNOWN_OR_CHANGED_PLAN'].includes(error.code) ? 'ABORTED' :
      error.code === 'CANCELLED' ? 'CANCELLED' :
        /^(INVALID_|UNKNOWN_|MISSING_|DUPLICATE_|REQUEST_CONFLICT)/u.test(error.code || '') ? 'CLARIFICATION_REQUIRED' : 'FAILED',
  reason: /^[A-Z0-9_]+$/u.test(error.code || '') ? error.code : 'ADAPTER_FAILED', saved: false, review_complete: false });

function validateConfig(c) {
  keys(c, ['schema_version', 'principal', 'role', 'readRoots', 'outputRoot', 'python', 'write_roles', 'documents', 'approval_ttl_ms']);
  if (c.schema_version !== 1 || !validId(c.principal) || !validId(c.role) || !Array.isArray(c.write_roles) ||
      c.write_roles.some(r => !validId(r)) || !Array.isArray(c.readRoots) || c.readRoots.some(r => typeof r !== 'string' || !path.isAbsolute(r)) ||
      typeof c.outputRoot !== 'string' || !path.isAbsolute(c.outputRoot) ||
      !Number.isInteger(c.approval_ttl_ms) || c.approval_ttl_ms < 1 || c.approval_ttl_ms > 300_000 ||
      !Array.isArray(c.documents) || c.documents.length > 100) fail('INVALID_CONFIG');
  const ids = new Set();
  for (const d of c.documents) {
    keys(d, ['id', 'version', 'rootIndex', 'relativePath', 'classification', 'read_roles','display_name'], ['id', 'version', 'rootIndex', 'relativePath', 'classification', 'read_roles']);
    if(d.display_name!==undefined&&(typeof d.display_name!=='string'||!d.display_name.trim()||d.display_name.length>120||/[\\/:\x00-\x1f\x7f]/u.test(d.display_name)))fail('INVALID_CONFIG');
    if (!validId(d.id) || !validId(d.version) || ids.has(d.id) || !['synthetic', 'internal'].includes(d.classification) ||
        !Array.isArray(d.read_roles) || d.read_roles.some(r => !validId(r))) fail('INVALID_CONFIG');
    ids.add(d.id);
  }
  return c;
}

/** Trusted embedding/CLI selects configPath, never a document/model/request field.
 * This is a local-user trust boundary, not authentication for an HTTP service.
 * All state/tokens are private; caller-visible previews are detached copies.
 */
export class FinancialDocuments {
  #configPath; #configHash; #config; #policy; #python;
  #pending = new Map(); #tokens = new Map(); #requests = new Map(); #saved = new Map(); #generation = 0;

  static async create({ configPath, runtimePython }) {
    const instance = new FinancialDocuments();
    instance.#configPath = path.resolve(configPath);
    const loaded = await boundedRead(instance.#configPath, 100_000);
    instance.#config = validateConfig(strictJSON(loaded.content)); instance.#configHash = loaded.hash;
    const c = instance.#config;
    instance.#policy = await createFilePolicy(c.readRoots, c.outputRoot);
    // Only the trusted application embedding can supply its current bundled runtime.
    // Persisted document policy, its hash and approval checks remain unchanged.
    instance.#python = await verifiedPython(runtimePython ?? c.python);
    return instance;
  }

  async #current(write = false, selected = []) {
    const raw = await boundedRead(this.#configPath, 100_000);
    const current = validateConfig(strictJSON(raw.content));
    // Check access against current policy first; edited policy cannot authorize
    // an old approval even if it still allows the operation.
    if (current.principal !== this.#config.principal || current.role !== this.#config.role ||
        (write && !current.write_roles.includes(current.role))) fail('ACCESS_DENIED');
    for (const id of selected) {
      const entry = current.documents.find(d => d.id === id);
      if (!entry || !entry.read_roles.includes(current.role)) fail('ACCESS_DENIED');
    }
    if (raw.hash !== this.#configHash) fail('POLICY_CHANGED');
    await checkedDirectory(this.#policy.output);
    return current;
  }

  async candidates() {
    await this.#current();
    return this.#config.documents.filter(d => d.read_roles.includes(this.#config.role))
      .map(d => ({ id: d.id, version: d.version, classification: d.classification }));
  }

  async searchSnapshot(ids){
    await this.#current(false,ids);
    const docs=await Promise.all(ids.map(id=>readSelectedText(this.#policy,this.#config.documents.find(d=>d.id===id))));
    return docs.map(({content,...d})=>d);
  }
  async searchEvidence(input,catalog){
    const s=searchOperation(input);await this.#current(false,s.source_ids);
    const docs=await Promise.all(s.source_ids.map(id=>readSelectedText(this.#policy,this.#config.documents.find(d=>d.id===id))));
    const metadata=s.source_ids.map(id=>{const d=catalog.find(d=>d.id===id);if(!d)fail('SEARCH_SCOPE_CHANGED');return{id,display_name:d.display_name,can_select:d.roles.includes('source')};});
    const result=await callCore(this.#python,{schema_version:1,operation:s,documents:docs,catalog:metadata});
    const fresh=await this.searchSnapshot(s.source_ids);
    if(JSON.stringify(fresh)!==JSON.stringify(docs.map(({content,...d})=>d)))fail('SEARCH_STALE');
    return {...result,search_snapshot:fresh};
  }

  #reviewSelection(input) {
    const s=explicitOperation(input);
    if(s.action!=='checklist_review'||s.item_ids.length||!s.source_ids.length||
      new Set([s.target_doc,...s.source_ids,s.guideline_id]).size!==s.source_ids.length+2)fail('INVALID_REVIEW_SELECTION');
    // Stable, public operation shape: no natural-language command, path or plan.
    return{action:s.action,target_doc:s.target_doc,source_ids:s.source_ids,guideline_id:s.guideline_id,item_ids:[],format:s.format};
  }
  #reviewSnapshot(selection,payload) {
    const bindings=[payload.review_doc,...payload.source_docs,payload.guideline].map(({id,version,hash,classification,format})=>({id,version,hash,classification,format}));
    const metadata={selection,bindings,policy_hash:this.#configHash};
    return{...metadata,input_hash:digest(JSON.stringify(metadata))};
  }
  /** Read trusted current inputs without preparing, cancelling, auditing or
   * publishing an approval plan. The returned hashes are for PC reconfirmation. */
  async inspectExplicitReview(input) {
    const selection=this.#reviewSelection(input),payload=await this.#payload(selection,randomUUID());
    return clone(this.#reviewSnapshot(selection,payload));
  }
  /** Same adapter, read-only checklist core call. Unlike prepare(), this never
   * mutates pending plans/tokens/receipts or writes to the business output root. */
  async reviewExplicit(input,expectedSnapshot,{requestId=randomUUID()}={}) {
    if(!validId(requestId))fail('INVALID_REQUEST_ID');
    const selection=this.#reviewSelection(input),expected=clone(expectedSnapshot);
    keys(expected,['selection','bindings','policy_hash','input_hash']);
    if(!HASH.test(expected.input_hash)||!HASH.test(expected.policy_hash))fail('INVALID_REVIEW_SNAPSHOT');
    const payload=await this.#payload(selection,requestId),snapshot=this.#reviewSnapshot(selection,payload);
    if(snapshot.input_hash!==expected.input_hash)fail('CONTENT_CHANGED');
    const plan=await callCore(this.#python,payload);
    const fresh=await this.#payload(selection,requestId);
    if(this.#reviewSnapshot(selection,fresh).input_hash!==snapshot.input_hash)fail('CONTENT_CHANGED');
    assertCompletedCoreReview(plan,requestId);this.#integrity(plan);
    const result={status:plan.status,reason:plan.reason,reviewComplete:plan.review_complete,
      items:plan.items,unresolved:plan.unresolved,body:plan.expected_body,
      documents:[payload.review_doc,...payload.source_docs,payload.guideline].map(({id,version,classification,format,content})=>({id,version,classification,format,content})),
      checkedAt:new Date().toISOString(),saved:false};
    // Leave room for execution metadata inside the separate 2 MB record.
    // Check the whole sanitized UTF-8 result; never truncate evidence or return
    // a successful review that the local history cannot persist and reopen.
    if(Buffer.byteLength(JSON.stringify(result),'utf8')>1_500_000)fail('LOCAL_REVIEW_RESULT_TOO_LARGE');
    return clone(result);
  }

  async #readSaved(requestId, selection) {
    if(!validId(requestId)||!['patch','convert','draft_review','convert_common'].includes(selection.action))fail('NO_SAVED_RESULT');
    if(selection.action==='convert_common')await this.#conversionDoc(selection.document);
    else await this.#current(false,[...(selection.action==='draft_review'?[]:[selection.target_doc]),...selection.source_ids,selection.guideline_id]);
    const directory=path.join(this.#policy.output,'.financial-ledger');
    const receipt=strictJSON((await boundedRead(path.join(directory,'request-'+requestId+'.json'),8192,null,true)).content);
    keys(receipt,['request_id','plan_hash','approval_id','input_hash','status','time','output_hash']);
    if(receipt.request_id!==requestId||receipt.status!=='COMPLETED'||!HASH.test(receipt.plan_hash)||!HASH.test(receipt.output_hash)||
      !validId(receipt.approval_id)||receipt.input_hash!==digest(JSON.stringify(selection))||typeof receipt.time!=='string'||!Number.isFinite(Date.parse(receipt.time)))fail('NO_SAVED_RESULT');
    const outputFile=path.join(this.#policy.output,'DIANA-finance-'+receipt.plan_hash+'.'+selection.format);
    const file=await boundedRead(outputFile,2_000_000,receipt.output_hash);
    return{receipt,file,result:{status:'COMPLETED',saved:true,storage_verified:true,request_id:requestId,outputFile,output_hash:receipt.output_hash,plan_hash:receipt.plan_hash}};
  }

  /** Reconcile an exact server-held attempted plan. Never writes a file, repairs
   * an incomplete ledger, scans guessed names, or restores an approval. */
  async recoverSaved(requestId,input,plan) {
    const selection=input?.action==='draft_review'?draftOperation(input):input?.action==='convert_common'?conversionOperation(input):explicitOperation(input);
    this.#integrity(plan);
    const s=await this.#readSaved(requestId,selection);
    if(s.result.plan_hash!==plan.plan_hash||s.result.output_hash!==plan.approval_payload.output_hash||s.file.content!==plan.output_content)fail('RECOVERY_UNCERTAIN');
    this.#saved.set(requestId,{selection:clone(selection),result:clone(s.result)});
    await this.#audit('COMPLETED','RESULT_RECONFIRMED',{request_id:requestId,plan_hash:plan.plan_hash,output_hash:s.file.hash});
    return clone(s.result);
  }

  async conversionCandidates(){
    await this.#current();
    const rows=this.#config.documents.filter(d=>d.read_roles.includes(this.#config.role)).map(d=>({document:{kind:'registered',id:d.id},name:d.display_name||d.id,format:path.extname(d.relativePath).slice(1).toLowerCase()}));
    for(const [id,r]of this.#saved){try{await this.#readSaved(id,r.selection);rows.push({document:{kind:'saved',id},name:'저장 결과 '+id.slice(0,8),format:r.selection.format});}catch{}}
    return{documents:rows};
  }
  async #conversionDoc(ref){
    if(ref.kind==='registered'){
      await this.#current(false,[ref.id]);return readSelectedText(this.#policy,this.#config.documents.find(d=>d.id===ref.id));
    }
    const record=this.#saved.get(ref.id);if(!record)fail('NO_SAVED_RESULT');
    const s=await this.#readSaved(ref.id,record.selection);
    return{id:ref.id,version:'1',format:record.selection.format,content:s.file.content,hash:s.file.hash,classification:storedClassification(s.file.content,record.selection.format)};
  }
  async readConversionSaved(id){
    const r=this.#saved.get(id);if(r?.selection.action!=='convert_common')fail('NO_SAVED_RESULT');
    const s=await this.#readSaved(id,r.selection),doc={id,version:'1',format:r.selection.format,content:s.file.content,hash:s.file.hash,classification:storedClassification(s.file.content,r.selection.format)};
    const plan=await callCore(this.#python,{schema_version:1,request_id:id,operation:{action:'convert_common',format:doc.format},document:doc,authority:this.#conversionAuthority()});
    if(plan.reason!=='SAME_FORMAT'||plan.output_content!==s.file.content)fail('READBACK_FAILED');this.#integrity(plan);
    return{...s.result,body:plan.expected_body,common_document:plan.common_document,unresolved:plan.unresolved,content:s.file.content,format:doc.format};
  }
  #conversionAuthority(){return{principal:this.#config.principal,role:this.#config.role,policy_hash:this.#configHash,output_root:this.#policy.output};}

  async readDraftSaved(id){
    const record=this.#saved.get(id);if(record?.selection.action!=='draft_review')fail('NO_SAVED_RESULT');
    const r=await this.#readSaved(id,record.selection),payload=await this.#payload(record.selection,id),plan=await callCore(this.#python,payload);
    if(plan.output_content!==r.file.content||plan.plan_hash!==r.result.plan_hash)fail('CONTENT_CHANGED');
    this.#integrity(plan);
    return{...r.result,body:plan.expected_body,unresolved:plan.unresolved,content:r.file.content};
  }

  /** Restore verified completed files only, never pending plans or approvals. */
  async loadSavedResults(inputs) {
    const selections=inputs.map(explicitOperation),byHash=new Map(selections.map((s,index)=>[digest(JSON.stringify(s)),{selection:s,index}]));
    await this.#current();await checkedDirectory(this.#policy.output);
    const directory=path.join(this.#policy.output,'.financial-ledger');
    let stat;try{stat=await lstat(directory);}catch(e){if(e.code==='ENOENT')return[];throw e;}
    if(!stat.isDirectory()||stat.isSymbolicLink()||await realpath(directory)!==directory)fail('LEDGER_UNSAFE');
    const records=[];let count=0;
    for await(const entry of await opendir(directory)){
      if(++count>10000)break;
      const match=/^request-([A-Za-z0-9][A-Za-z0-9_-]{0,63})\.json$/u.exec(entry.name);if(!match||!entry.isFile()||entry.isSymbolicLink())continue;
      try{const r=strictJSON((await boundedRead(path.join(directory,entry.name),8192,null,true)).content);const allowed=byHash.get(r.input_hash);
        if(allowed&&r.status==='COMPLETED'&&Number.isFinite(Date.parse(r.time)))records.push({id:match[1],time:r.time,...allowed});}catch{}
    }
    records.sort((a,b)=>b.time.localeCompare(a.time));const restored=[];
    for(const record of records){
      if(restored.length===8)break;
      try{const saved=await this.#readSaved(record.id,record.selection);this.#saved.set(record.id,{selection:record.selection,result:clone(saved.result)});
        restored.push({requestId:record.id,selectionIndex:record.index,createdAt:saved.receipt.time,result:clone(saved.result)});}catch{}
    }
    return restored;
  }

  /** Read-only review of an exact verified saved file; does not cancel a plan. */
  async reviewSaved(requestId) {
    const record=this.#saved.get(requestId);if(!record)fail('NO_SAVED_RESULT');
    const saved=await this.#readSaved(requestId,record.selection);
    if(saved.result.outputFile!==record.result.outputFile||saved.result.output_hash!==record.result.output_hash||saved.result.plan_hash!==record.result.plan_hash)fail('CONTENT_CHANGED');
    const selection={...record.selection,action:'checklist_review',item_ids:[]};const reviewId=randomUUID();
    const payload=await this.#payload(selection,reviewId);
    const original=[payload.review_doc,...payload.source_docs,payload.guideline];
    payload.review_doc={...payload.review_doc,format:record.selection.format,content:saved.file.content,hash:saved.file.hash,
      classification:storedClassification(saved.file.content,record.selection.format)};
    const plan=await callCore(this.#python,payload);
    const fresh=await this.#payload(selection,reviewId);
    const documents=[fresh.review_doc,...fresh.source_docs,fresh.guideline];
    if(documents.some((d,i)=>d.hash!==original[i].hash||d.version!==original[i].version))fail('CONTENT_CHANGED');
    const after=await this.#readSaved(requestId,record.selection);
    if(after.result.output_hash!==saved.result.output_hash||after.result.plan_hash!==saved.result.plan_hash)fail('CONTENT_CHANGED');
    assertCompletedCoreReview(plan,reviewId);this.#integrity(plan);
    return clone({status:plan.status,reason:plan.reason,classification:payload.review_doc.classification,
      reviewComplete:plan.review_complete,items:plan.items,unresolved:plan.unresolved,
      body:plan.expected_body,checkedAt:new Date().toISOString()});
  }

  async #ledgerDirectory() {
    await checkedDirectory(this.#policy.output);
    const directory = path.join(this.#policy.output, '.financial-ledger');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory) !== directory) fail('LEDGER_UNSAFE');
    return directory;
  }

  async #audit(status, reason, details = {}) {
    const file = path.join(await this.#ledgerDirectory(), `event-${randomUUID()}.json`);
    const record = { schema_version: 1, time: new Date().toISOString(), principal: this.#config.principal,
      status, reason, ...details };
    const handle = await open(file, 'wx', 0o600);
    try {
      await this.#verifyLedgerHandle(handle, file);
      await handle.writeFile(JSON.stringify(record)); await handle.sync();
      await this.#verifyLedgerHandle(handle, file);
    } finally { await handle.close(); }
  }

  async #verifyLedgerHandle(handle, filename) {
    const parent = await this.#ledgerDirectory();
    if (path.dirname(filename) !== parent) fail('LEDGER_UNSAFE');
    const opened = await handle.stat({ bigint: true }); const named = await lstat(filename, { bigint: true });
    if (!opened.isFile() || !named.isFile() || named.isSymbolicLink() || opened.nlink !== 1n || named.nlink !== 1n ||
        opened.ino !== named.ino || opened.dev !== named.dev || await realpath(filename) !== filename) fail('LEDGER_UNSAFE');
  }

  async #receipt(requestId) {
    try {
      const record = strictJSON((await boundedRead(path.join(await this.#ledgerDirectory(), `request-${requestId}.json`), 8192, null, true)).content);
      if (record.request_id !== requestId || !HASH.test(record.input_hash) || !['CLAIMED', 'COMPLETED'].includes(record.status)) fail('RECEIPT_UNCERTAIN');
      return record;
    } catch (error) { if (error.code === 'ENOENT') return null; fail('RECEIPT_UNCERTAIN'); }
  }

  cancelPending() {
    this.#generation++;
    const count = this.#pending.size;
    this.#pending.clear(); this.#tokens.clear();
    return { schema_version: 1, status: 'CANCELLED', reason: 'USER_CANCELLED', count, saved: false, review_complete: false };
  }

  async cancel() {
    const result = this.cancelPending();
    try { await this.#audit('CANCELLED', 'USER_CANCELLED'); return result; }
    catch { return { ...result, status: 'FAILED', reason: 'AUDIT_FAILED' }; }
  }

  #live(record) {
    if (record.generation !== this.#generation || this.#pending.get(record.plan.plan_id) !== record) fail('CANCELLED');
    if (Date.now() > record.expires) fail('APPROVAL_EXPIRED');
  }

  async #payload(selection, requestId) {
    if(selection.action==='convert_common'){await this.#current(true);return{schema_version:1,request_id:requestId,operation:{action:'convert_common',format:selection.format},document:await this.#conversionDoc(selection.document),authority:this.#conversionAuthority()};}
    const drafting=selection.action==='draft_review';
    const ids = [...(drafting?[]:[selection.target_doc]), ...selection.source_ids, selection.guideline_id];
    // All permissions are checked before even the first selected body is read.
    await this.#current(selection.action !== 'checklist_review', ids);
    const documents = [];
    for (const id of ids) {
      const entry = this.#config.documents.find(d => d.id === id);
      documents.push(await readSelectedText(this.#policy, entry));
    }
    if(drafting)return{schema_version:1,request_id:requestId,operation:{action:'draft_review',format:'md',template_version:selection.template_version},user_input:selection.user_input,source_docs:documents.slice(0,-1),guideline:documents.at(-1)};
    return { schema_version: 1, request_id: requestId, request: '',
      operation: { action: selection.action, target_doc: selection.target_doc, item_ids: selection.item_ids, format: selection.format },
      review_doc: documents[0], source_docs: documents.slice(1, -1), guideline: documents.at(-1) };
  }

  #integrity(plan) {
    if (typeof plan.canonical_payload !== 'string' || digest(plan.canonical_payload) !== plan.plan_hash ||
        plan.plan_id !== `plan-${plan.plan_hash}` ||
        digest(plan.output_content) !== plan.approval_payload.output_hash) fail('PLAN_CHANGED');
    // Node never reserializes the canonical approval string for hashing.
    const approved = strictJSON(plan.canonical_payload);
    if (approved.output_content !== plan.output_content || approved.request_id !== plan.request_id ||
        JSON.stringify(approved) !== JSON.stringify(plan.approval_payload)) fail('PLAN_CHANGED');
  }

  async #recheck(record) {
    this.#live(record);
    const payload = await this.#payload(record.selection, record.plan.request_id);
    const old = record.payload;
    for (const [now, before] of [[payload.review_doc, old.review_doc], [payload.guideline, old.guideline],
      [payload.document,old.document],...(payload.source_docs||[]).map((d, i) => [d, old.source_docs[i]])]) {
      if ((now?.hash ?? null) !== (before?.hash ?? null) || (now?.version ?? null) !== (before?.version ?? null)) fail('CONTENT_CHANGED');
    }
    const rebuilt = await callCore(this.#python, payload);
    this.#integrity(record.plan);
    if (rebuilt.canonical_payload !== record.plan.canonical_payload || rebuilt.plan_hash !== record.plan.plan_hash || rebuilt.status !== 'AWAITING_APPROVAL') fail('PLAN_CHANGED');
    this.#live(record);
  }

  async prepare(input, { requestId = randomUUID() } = {}) {
    let record;
    try {
      if (!validId(requestId)) fail('INVALID_REQUEST_ID');
      const selection = input?.action==='convert_common'?conversionOperation(input):input?.action==='draft_review'?draftOperation(input):explicitOperation(input);
      if (selection.action === 'export') { this.cancelPending(); fail('EXTERNAL_EXPORT_DENIED'); }
      const inputHash = digest(JSON.stringify(selection));
      const previous = this.#requests.get(requestId);
      if (previous) {
        if (previous !== inputHash) { this.cancelPending(); fail('REQUEST_CONFLICT'); }
        await this.#audit('ABORTED', 'DUPLICATE_REQUEST', { request_id: requestId });
        return { schema_version: 1, status: 'ABORTED', reason: 'DUPLICATE_REQUEST', saved: false, review_complete: false };
      }
      // Reserve synchronously; a second async prepare cannot publish stale work.
      this.#requests.set(requestId, inputHash);
      const cancelled = this.cancelPending().count; const generation = this.#generation;
      if (cancelled) await this.#audit('CANCELLED', 'NEW_PLAN_INVALIDATED_PREVIOUS', { request_id: requestId });
      await this.#audit('READY', 'EXPLICIT_OPERATION', { request_id: requestId });
      const payload = await this.#payload(selection, requestId);
      const receipt = await this.#receipt(requestId);
      if (receipt) {
        if (receipt.input_hash !== inputHash) fail('REQUEST_CONFLICT');
        await this.#audit(receipt.status === 'COMPLETED' ? 'ABORTED' : 'UNCERTAIN', 'ALREADY_CLAIMED', { request_id: requestId });
        return { schema_version: 1, status: receipt.status === 'COMPLETED' ? 'ABORTED' : 'UNCERTAIN', reason: 'ALREADY_CLAIMED',
          saved: false, review_complete: false, prior_status: receipt.status };
      }
      const plan = await callCore(this.#python, payload);
      if (generation !== this.#generation) fail('CANCELLED');
      if (plan.plan_hash) this.#integrity(plan);
      record = { selection, payload, plan, inputHash, generation, expires: Date.now() + this.#config.approval_ttl_ms };
      if (plan.status === 'AWAITING_APPROVAL') this.#pending.set(plan.plan_id, record);
      await this.#audit(plan.status, plan.reason, { request_id: requestId,
        ...(plan.plan_hash ? { plan_hash: plan.plan_hash, bindings: plan.approval_payload.bindings } : {}) });
      if (generation !== this.#generation) fail('CANCELLED');
      return clone(plan);
    } catch (error) {
      if (record) this.#pending.delete(record.plan.plan_id);
      const result = errResult(error);
      if (error.code === 'RECEIPT_UNCERTAIN') result.status = 'UNCERTAIN';
      try { await this.#audit(result.status, result.reason, validId(requestId) ? { request_id: requestId } : {}); } catch { return { ...result, status: 'FAILED', reason: 'AUDIT_FAILED' }; }
      return result;
    }
  }

  /** Invoke only after the local user has reviewed this exact plan/hash. */
  async approve(planId, planHash) {
    const record = this.#pending.get(planId);
    try {
      if (!record || record.plan.plan_hash !== planHash) fail('UNKNOWN_OR_CHANGED_PLAN');
      await this.#recheck(record);
      const token = randomUUID();
      const approval = { token, approval_id: randomUUID(), principal: this.#config.principal,
        request_id: record.plan.request_id, plan_hash: planHash, original_hash: (record.payload.review_doc?.hash??null),
        expires: record.expires, record, used: false };
      await this.#audit('AWAITING_APPROVAL', 'USER_APPROVED', { request_id: approval.request_id, plan_hash: planHash, approval_id: approval.approval_id });
      this.#live(record); this.#tokens.set(token, approval);
      return { schema_version: 1, status: 'AWAITING_APPROVAL', reason: 'APPROVAL_ISSUED', saved: false,
        review_complete: record.plan.review_complete, token, approval_id: approval.approval_id, expires_at: approval.expires };
    } catch (error) {
      if (record) this.#pending.delete(planId);
      const result = errResult(error);
      try { await this.#audit(result.status, result.reason, record ? { request_id: record.plan.request_id, plan_hash: record.plan.plan_hash } : {}); }
      catch { return { ...result, status: 'FAILED', reason: 'AUDIT_FAILED' }; }
      return result;
    }
  }

  async execute(token) {
    const approval = this.#tokens.get(token);
    if (!approval || approval.used) {
      const result = { schema_version: 1, status: 'ABORTED', reason: 'UNKNOWN_OR_USED_APPROVAL', saved: false, review_complete: false };
      try { await this.#audit(result.status, result.reason); } catch { return { ...result, status: 'FAILED', reason: 'AUDIT_FAILED' }; }
      return result;
    }
    approval.used = true; // consumed before the first await, including failed attempts
    const record = approval.record;
    let receiptHandle, outputFile = null, writeStarted = false, verified = false;
    let result;
    const details = { request_id: approval.request_id, plan_hash: approval.plan_hash, approval_id: approval.approval_id };
    try {
      if (approval.principal !== this.#config.principal || approval.plan_hash !== record.plan.plan_hash ||
          approval.original_hash !== (record.payload.review_doc?.hash??null) || Date.now() > approval.expires) fail('APPROVAL_EXPIRED');
      await this.#recheck(record);
      const ledger = path.join(await this.#ledgerDirectory(), `request-${approval.request_id}.json`);
      this.#live(record);
      try { receiptHandle = await open(ledger, 'wx', 0o600); }
      catch (error) { if (error.code === 'EEXIST') fail('ALREADY_CLAIMED'); throw error; }
      const receipt = { ...details, input_hash: record.inputHash, status: 'CLAIMED', time: new Date().toISOString() };
      await this.#verifyLedgerHandle(receiptHandle, ledger);
      await receiptHandle.writeFile(JSON.stringify(receipt)); await receiptHandle.sync();
      // Recheck all bindings after claiming, immediately before the output open.
      await this.#recheck(record);
      const output = this.#policy.output;
      await checkedDirectory(output); this.#live(record);
      const destination = path.join(output, `DIANA-finance-${approval.plan_hash}.${record.selection.format}`);
      const handle = await open(destination, 'wx', 0o600); outputFile = destination;
      try {
        await verifyOpenedOutput(handle, destination, output);
        await this.#recheck(record); this.#live(record);
        writeStarted = true;
        await handle.writeFile(record.plan.output_content, 'utf8'); await handle.sync();
        await verifyOpenedOutput(handle, destination, output);
      } finally { await handle.close(); }
      const readback = await boundedRead(destination, 2_000_000, record.plan.approval_payload.output_hash);
      if (readback.content !== record.plan.output_content || (record.selection.format === 'json' && !strictJSON(readback.content))) fail('READBACK_FAILED');
      verified = true;
      receipt.status = 'COMPLETED'; receipt.output_hash = readback.hash;
      // The claim stays in place even if updating it fails: never auto-reexecute.
      await this.#verifyLedgerHandle(receiptHandle, ledger);
      await receiptHandle.truncate(0);
      const receiptBytes = Buffer.from(JSON.stringify(receipt)); let written = 0;
      while (written < receiptBytes.length) {
        const part = await receiptHandle.write(receiptBytes, written, receiptBytes.length - written, written);
        if (!part.bytesWritten) fail('RECEIPT_WRITE_FAILED');
        written += part.bytesWritten;
      }
      await receiptHandle.sync();
      await this.#verifyLedgerHandle(receiptHandle, ledger);
      await boundedRead(ledger, 8192, digest(receiptBytes), true);
      await this.#audit('COMPLETED', 'SAVED_AND_REREAD', { ...details, output_hash: readback.hash });
      result = { schema_version: 1, status: 'COMPLETED', reason: 'SAVED_AND_REREAD', saved: true, storage_verified: true,
        review_complete: record.plan.review_complete, all_items_addressed: record.plan.all_items_addressed,
        unresolved: clone(record.plan.unresolved), outputFile, output_hash: readback.hash, ...details };
    } catch (error) {
      result = { ...errResult(error), ...details, outputFile, storage_verified: verified };
      if (outputFile || receiptHandle || error.code === 'ALREADY_CLAIMED') {
        result.status = 'UNCERTAIN'; result.reason = error.code === 'ALREADY_CLAIMED' ? 'ALREADY_CLAIMED' : 'STORAGE_OR_RECORD_INCOMPLETE';
        result.write_started = writeStarted; result.saved = false;
        if (outputFile) {
          try { result.observed_hash = (await boundedRead(outputFile, 2_000_000)).hash; }
          catch { result.observed_hash = null; }
        }
      }
      try { await this.#audit(result.status, result.reason, details); }
      catch { result.status = 'UNCERTAIN'; result.reason = 'AUDIT_FAILED'; }
    } finally {
      this.#pending.delete(record.plan.plan_id);
      if (receiptHandle) { try { await receiptHandle.close(); } catch { result = { ...result, status: 'UNCERTAIN', reason: 'RECEIPT_CLOSE_FAILED', saved: false }; } }
    }
    if(result.status==='COMPLETED'&&result.saved===true&&result.storage_verified===true){
      this.#saved.set(result.request_id,{selection:clone(record.selection),result:clone(result)});
      while(this.#saved.size>16)this.#saved.delete(this.#saved.keys().next().value);
    }
    return result;
  }
}
