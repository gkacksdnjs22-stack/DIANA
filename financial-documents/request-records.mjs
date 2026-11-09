import {RecordConversions} from './record-conversions.mjs';
import {RecordDrafts} from './record-drafts.mjs';
import {Corrections} from './corrections.mjs';
import path from 'node:path';
import {mkdir,open,readdir,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {checkedDirectory,digest} from '../personal-ai/documents/files.mjs';
import {boundedRead,verifyOpenedOutput} from './files.mjs';
import {keys,strictJSON,fail} from './strict-json.mjs';
import {UUID} from '../lib/financial-contract.mjs';
import {RecordReviews} from './record-reviews.mjs';
import {EvidenceSearch} from './evidence-search.mjs';
import {AiPreview} from './ai-preview.mjs';

export const RECORD_VERSION='request-records-v1';
const canonical=v=>JSON.stringify(v===null||typeof v!=='object'?v:Array.isArray(v)?v.map(x=>JSON.parse(canonical(x))):Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(canonical(v[k]))])));
export const snapshotHash=v=>digest(canonical(v));
const demand=(yes,code='RECORD_INVALID')=>{if(!yes)fail(code);};
const within=(a,b)=>{const r=path.relative(a,b);return !r||r!=='..'&&!r.startsWith('..'+path.sep)&&!path.isAbsolute(r);};
const sensitive=/-----BEGIN .*PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{30,})|(?:api[_-]?key|private_key|client_secret|password|approval[_-]?token|authorization)\s*[=:]|\bBearer\s+\S+|[A-Za-z]:[\\/]|\\\\[^\s\\]+\\/iu;
function requestText(s){demand(typeof s==='string'&&s.trim()&&s.length<=2000&&!/[\x00-\x08\x0b-\x1f\x7f]/u.test(s));demand(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(s));demand(!sensitive.test(s),'RECORD_SENSITIVE_TEXT');}
export function checkConfirmation(raw,candidates){
  keys(raw,['intent','target','sources','guideline','format']);
  demand(['perform','question','cancel','mixed','uncertain'].includes(raw.intent));
  for(const [field,role,max]of [['target','review',1],['sources','source',16],['guideline','guideline',1]]){
    const value=raw[field];keys(value,['state','ids']);demand(['selected','none','unknown'].includes(value.state)&&Array.isArray(value.ids)&&value.ids.length<=max&&new Set(value.ids).size===value.ids.length);
    demand(value.state==='selected'?value.ids.length>0:value.ids.length===0);
    for(const id of value.ids)demand(candidates.some(c=>c.id===id&&c.roles.includes(role)));
  }
  keys(raw.format,['state','value']);demand(['selected','none','unknown'].includes(raw.format.state));demand(raw.format.state==='selected'?['md','txt','json'].includes(raw.format.value):raw.format.value===null);
}
export const emptyConfirmation=()=>({intent:'uncertain',target:{state:'unknown',ids:[]},sources:{state:'unknown',ids:[]},guideline:{state:'unknown',ids:[]},format:{state:'unknown',value:null}});

/** Private local records. Saving labels never runs a task; explicit review-* actions
 * delegate to the same worker's read-only review boundary. No model or business save. */
export class RequestRecords{
 #root;#protected;#withContext;#app;#chain=Promise.resolve();#previews=new Map();#reviews;#ai;#corrections;#drafts;#conversions;#search;
 constructor({stateDir,protectedRoots,withContext,withEvidenceSearch=null,withLocalReview=null,withLocalPatch=null,aiPython=null,appVersion='source-0.1.0+request-records-v1'}){this.#search=new EvidenceSearch(withEvidenceSearch);this.#conversions=new RecordConversions(withLocalPatch);this.#drafts=new RecordDrafts(withLocalPatch);this.#root=path.resolve(stateDir+'.request-records');this.#protected=[...protectedRoots,stateDir,stateDir+'.registrations'].map(p=>path.resolve(p));this.#withContext=withContext;this.#app=appVersion;this.#ai=new AiPreview({stateDir,protectedRoots,withContext,python:aiPython});this.#reviews=new RecordReviews({stateDir,protectedRoots,withLocalReview,withLocalPatch,getRecord:async(id,version)=>{const rows=await this.#versions(id);const record=version===undefined?rows.at(-1):rows.find(r=>r.version===version);demand(record,'RECORD_NOT_FOUND');return structuredClone(record);}});this.#corrections=new Corrections({stateDir,protectedRoots,getRecord:async(id,version)=>{const rows=await this.#versions(id);const record=version===undefined?rows.at(-1):rows.find(r=>r.version===version);demand(record,'RECORD_NOT_FOUND');return structuredClone(record);},getExposure:async id=>({ai:await this.#ai.exposure(id),ai_history:await this.#ai.auditHistory(id),review:await this.#reviews.exposureForRecord(id)})});}
 async close(){await this.#conversions.close();await this.#drafts.close();await this.#reviews.close();await this.#ai.close();}
 get directory(){return this.#root;}
 async #storage(){await checkedDirectory(path.dirname(this.#root));for(const p of this.#protected)demand(!within(p,this.#root)&&!within(this.#root,p),'RECORD_STORAGE_BOUNDARY');await mkdir(this.#root,{recursive:true,mode:0o700});await checkedDirectory(this.#root);}
 async #write(name,data){await this.#storage();const filename=path.join(this.#root,name),h=await open(filename,'ax',0o600);try{await verifyOpenedOutput(h,filename,this.#root);await h.writeFile(JSON.stringify(data)+'\n');await h.sync();await verifyOpenedOutput(h,filename,this.#root);}finally{await h.close();}}
 async #read(name){return strictJSON((await boundedRead(path.join(this.#root,name),1_000_000)).content);}
 async #names(){await this.#storage();const names=await readdir(this.#root);demand(names.length<=10000,'RECORD_LIMIT');return names;}
 async #versions(id){demand(UUID.test(id));const names=await this.#names();if(names.includes(id+'-deleted.json'))fail('RECORD_DELETED');const selected=names.filter(n=>n.startsWith(id+'-v')&&/^.*-v[1-9][0-9]*\.json$/u.test(n)).sort((a,b)=>Number(a.match(/-v(\d+)/)[1])-Number(b.match(/-v(\d+)/)[1]));const values=[];for(const name of selected){const v=await this.#read(name);demand(v.record_id===id&&v.version===values.length+1&&v.previous_hash===(values.length?snapshotHash(values.at(-1)):null),'RECORD_STORAGE_CHANGED');values.push(v);}return values;}
 async #context(){return this.#withContext(c=>({context:structuredClone(c),context_hash:snapshotHash(c)}));}
 async handle(body,observedJobs=[]){body=structuredClone(body);if(body?.action?.startsWith('ai-'))return this.#ai.handle(body);observedJobs=structuredClone(observedJobs);const action=()=>this.#handle(body,observedJobs);const p=this.#chain.then(action);this.#chain=p.catch(()=>{});return p;}
 async #handle(body,jobs){
  demand(body&&typeof body==='object');
  if(body.action?.startsWith('search-')){const r=await this.#search.handle(body);if(body.action==='search-apply'){this.#previews.clear();this.#reviews.invalidateSearch();}return r;}
  if(typeof body.action==='string'&&body.action.startsWith('conversion-'))return this.#conversions.handle(body);
  if(typeof body.action==='string'&&body.action.startsWith('draft-'))return this.#drafts.handle(body);
  if(typeof body.action==='string'&&body.action.startsWith('correction-'))return this.#corrections.handle(body);
  if(typeof body.action==='string'&&(body.action.startsWith('review-')||body.action.startsWith('patch-')))return this.#reviews.handle(body);
  if(body.action==='context'){keys(body,['action']);return this.#context();}
  if(body.action==='list'){keys(body,['action']);const names=await this.#names(),ids=[...new Set(names.filter(n=>/^[-a-f0-9]{36}-v[1-9][0-9]*\.json$/u.test(n)).map(n=>n.slice(0,36)))].filter(id=>!names.includes(id+'-deleted.json'));const records=[];for(const id of ids){const v=(await this.#versions(id)).at(-1);records.push({id,version:v.version,created_at:v.created_at,confirmed_at:v.confirmed_at,request:v.input.request,origin:v.data_origin,annotation:'user_self_confirmed_needs_review'});}return{records:records.sort((a,b)=>b.confirmed_at.localeCompare(a.confirmed_at))};}
  if(body.action==='detail'){keys(body,['action','id']);const versions=await this.#versions(body.id);demand(versions.length,'RECORD_NOT_FOUND');return{versions};}
  if(body.action==='delete'){keys(body,['action','id']);demand(UUID.test(body.id));const names=await this.#names();if(!names.includes(body.id+'-deleted.json')){const versions=await this.#versions(body.id);demand(versions.length,'RECORD_NOT_FOUND');await this.#write(body.id+'-deleted.json',{schema_version:1,record_id:body.id,deleted_at:new Date().toISOString()});}for(const name of names.filter(n=>n.startsWith(body.id+'-v')&&/^.*-v[1-9][0-9]*\.json$/u.test(n))){await this.#read(name);await checkedDirectory(this.#root);await unlink(path.join(this.#root,name));}await this.#reviews.deleteForRecord(body.id);return{deleted:true,id:body.id};}
  if(body.action==='preview'){
    keys(body,['action','id','baseVersion','request','contextHash','selection','confirmation','dataOrigin','jobId']);
    demand(UUID.test(body.id)&&Number.isSafeInteger(body.baseVersion)&&body.baseVersion>=0&&['real','synthetic'].includes(body.dataOrigin));requestText(body.request);
    keys(body.selection,['taskId','format','action']);demand(body.selection.action===null||['checklist_review','patch','convert'].includes(body.selection.action));demand(body.selection.taskId===null||UUID.test(body.selection.taskId));demand(body.selection.format===null||['md','txt','json'].includes(body.selection.format));demand(body.jobId===null||UUID.test(body.jobId));
    const old=await this.#versions(body.id);demand((old.at(-1)?.version??0)===body.baseVersion,'RECORD_CHANGED');
    // Editing labels always uses the historical input; never rebuild with today's catalog.
    const oldRecord=old.at(-1),current=oldRecord?null:await this.#context(),ctx=oldRecord?oldRecord.catalog_snapshot:current.context;
    demand(body.contextHash===(oldRecord?oldRecord.catalog_hash:current.context_hash),'RECORD_CONTEXT_CHANGED');
    if(oldRecord)demand(body.request===oldRecord.input.request&&canonical(body.selection)===canonical(oldRecord.selection)&&body.dataOrigin===oldRecord.data_origin&&body.jobId===oldRecord.linked_job_id,'RECORD_INPUT_IMMUTABLE');
    const task=ctx.tasks.find(t=>t.id===body.selection.taskId);demand(body.selection.taskId===null||!!task);demand(!task||body.selection.format===null||task.formats.includes(body.selection.format));demand(!task||body.selection.action===null||task.actions.includes(body.selection.action));
    const candidates=ctx.documents.map(({id,display_name,aliases,roles})=>({id,display_name,aliases,roles}));checkConfirmation(body.confirmation,candidates);
    demand(candidates.length<=100&&candidates.every(c=>c.display_name.length<=120&&c.aliases.every(a=>a.length<=120))&&!sensitive.test(canonical(ctx)),'RECORD_CATALOG_INVALID');
    const linked=body.jobId===null?null:jobs.find(j=>j.job?.id===body.jobId&&j.job.taskId===body.selection.taskId);demand(oldRecord||body.jobId===null||!!linked,'RECORD_JOB_CHANGED');
    const now=new Date().toISOString(),previewId=randomUUID();
    const input=oldRecord?oldRecord.input:{schema_version:1,request:body.request,context:{allowed_action:'checklist_review',confirmed_format:body.selection.format},candidates};
    const snapshot={schema_version:1,record_id:body.id,version:body.baseVersion+1,previous_hash:oldRecord?snapshotHash(oldRecord):null,created_at:oldRecord?.created_at??now,authored_at:oldRecord?.authored_at??now,authored_time_basis:'first_server_preview_of_user_local_text',confirmed_at:null,input_path:'pc_local_request_record_editor',request_origin:'user_authored_locally_not_mobile_original',data_origin:body.dataOrigin,purpose:'user_confirmed_development_candidate',admitted_to_evaluation:false,app_version:this.#app,contract_version:'financial-review-input-v1',record_version:RECORD_VERSION,input,input_snapshot_hash:snapshotHash(input),catalog_snapshot:ctx,catalog_hash:snapshotHash(ctx),selection:body.selection,explicit_selection_draft:oldRecord?.explicit_selection_draft??(task?{target:task.targetId,sources:task.sourceIds,guideline:task.guidelineId,format:body.selection.format,action:body.selection.action}:null),linked_task_id:body.selection.taskId,linked_job_id:body.jobId,execution_observation:oldRecord?.execution_observation??(linked?{observed_at:now,state:linked.job.state,action:linked.job.action??null,format:linked.job.format??null,saved:linked.result?.saved===true,storage_verified:linked.result?.storageVerified===true}:null),raw_user_confirmation:body.confirmation,annotation_provenance:(await this.#ai.exposure(body.id)).length?'user_confirmation_after_ai_preview':'user_self_confirmation',ai_exposure:await this.#ai.exposure(body.id),review_exposure_at_preview:await this.#reviews.exposureForRecord(body.id),contract_annotation:{state:'partial_needs_review',output:null,utf16_mentions:null,reason:'No independently verified status/intent/issues or mention spans; clicks are not full gold labels.'}};
    for(const [key,value]of this.#previews)if(value.snapshot.record_id===body.id)this.#previews.delete(key);
    this.#previews.set(previewId,{snapshot,expires:Date.now()+600000,base:body.baseVersion,old:!!oldRecord});while(this.#previews.size>32)this.#previews.delete(this.#previews.keys().next().value);
    return{previewId,confirmationHash:snapshotHash(snapshot),snapshot:structuredClone(snapshot)};
  }
  if(body.action==='save'){
    keys(body,['action','id','previewId','confirmationHash']);demand(UUID.test(body.id)&&UUID.test(body.previewId)&&/^[a-f0-9]{64}$/u.test(body.confirmationHash));
    const old=await this.#versions(body.id),found=old.find(v=>v.confirmation_id===body.previewId);if(found){demand(found.confirmation_hash===body.confirmationHash,'RECORD_CHANGED');return{saved:true,id:body.id,version:found.version,duplicate:true};}
    const p=this.#previews.get(body.previewId);demand(p&&p.snapshot.record_id===body.id&&p.expires>=Date.now()&&snapshotHash(p.snapshot)===body.confirmationHash,'RECORD_CONFIRMATION_EXPIRED');demand((old.at(-1)?.version??0)===p.base,'RECORD_CHANGED');
    const commit=async()=>{const record={...p.snapshot,confirmed_at:new Date().toISOString(),confirmation_id:body.previewId,confirmation_hash:body.confirmationHash,review_exposure_at_save:await this.#reviews.exposureForRecord(body.id)};await this.#write(body.id+'-v'+record.version+'.json',record);const read=await this.#read(body.id+'-v'+record.version+'.json');demand(snapshotHash(read)===snapshotHash(record),'RECORD_STORAGE_CHANGED');return{saved:true,id:body.id,version:record.version,duplicate:false};};
    if(p.old)return commit();return this.#withContext(async ctx=>{demand(snapshotHash(ctx)===p.snapshot.catalog_hash,'RECORD_CONTEXT_CHANGED');return commit();});
  }
  fail('RECORD_INVALID');
 }
}
