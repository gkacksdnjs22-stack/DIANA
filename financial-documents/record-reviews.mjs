import path from 'node:path';
import {mkdir,open,readdir,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {checkedDirectory,digest} from '../personal-ai/documents/files.mjs';
import {boundedRead,verifyOpenedOutput} from './files.mjs';
import {keys,strictJSON,fail} from './strict-json.mjs';
import {explicitOperation} from './operation.mjs';
import {UUID} from '../lib/financial-contract.mjs';

const canonical=v=>JSON.stringify(v===null||typeof v!=='object'?v:Array.isArray(v)?v.map(x=>JSON.parse(canonical(x))):Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(canonical(v[k]))])));
const hash=v=>digest(canonical(v)),demand=(yes,code='RECORD_REVIEW_INVALID')=>{if(!yes)fail(code);};
const inside=(a,b)=>{const r=path.relative(a,b);return !r||r!=='..'&&!r.startsWith('..'+path.sep)&&!path.isAbsolute(r);};
const diagnostic=e=>({code:/^[A-Z][A-Z0-9_]{0,63}$/u.test(e?.code||'')?e.code:'LOCAL_REVIEW_FAILED',coreStatus:/^[A-Z][A-Z0-9_]{0,63}$/u.test(e?.coreStatus||'')?e.coreStatus:null});
const metadata=e=>({execution_id:e.execution_id,record_id:e.record_id,record_version:e.record_version,state:e.state,started_at:e.started_at,ended_at:e.ended_at,selection:e.selection,saved:false,reviewComplete:e.review?.reviewComplete??null,diagnostic:e.diagnostic??null});

/** Called only inside RequestRecords' queue, then the existing worker lease/serial
 * boundary. These are local inspection receipts, never financial save receipts. */
export class RecordReviews{
 #root;#protected;#withReview;#record;#tickets=new Map();
 constructor({stateDir,protectedRoots,withLocalReview,getRecord}){this.#root=path.resolve(stateDir+'.request-reviews');this.#protected=[...protectedRoots,stateDir,stateDir+'.registrations',stateDir+'.request-records'].map(p=>path.resolve(p));this.#withReview=withLocalReview;this.#record=getRecord;}
 async #storage(){await checkedDirectory(path.dirname(this.#root));for(const p of this.#protected)demand(!inside(p,this.#root)&&!inside(this.#root,p),'RECORD_REVIEW_STORAGE_BOUNDARY');await mkdir(this.#root,{recursive:true,mode:0o700});await checkedDirectory(this.#root);}
 async #names(){await this.#storage();const n=await readdir(this.#root);demand(n.length<=10000,'RECORD_REVIEW_LIMIT');return n;}
 async #write(name,value){await this.#storage();const filename=path.join(this.#root,name),h=await open(filename,'ax',0o600);try{await verifyOpenedOutput(h,filename,this.#root);await h.writeFile(JSON.stringify(value)+'\n');await h.sync();await verifyOpenedOutput(h,filename,this.#root);}finally{await h.close();}}
 async #read(name){return strictJSON((await boundedRead(path.join(this.#root,name),16_000_000)).content);}
 async #optional(name){try{return await this.#read(name);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
 async #existing(id){
  demand(UUID.test(id));const claim=await this.#optional(id+'-start.json');if(!claim)return null;
  demand(claim.execution_id===id&&UUID.test(claim.record_id)&&Number.isSafeInteger(claim.record_version),'RECORD_REVIEW_STORAGE_CHANGED');
  let final;try{final=await this.#optional(id+'-result.json');}catch{return{...claim,state:'uncertain',ended_at:null,diagnostic:{code:'LOCAL_REVIEW_UNCERTAIN',coreStatus:null},saved:false};}
  if(final){demand(final.claim_hash===hash(claim)&&final.execution?.execution_id===id,'RECORD_REVIEW_STORAGE_CHANGED');
   for(const key of Object.keys(claim).filter(k=>!['state','ended_at'].includes(k)))demand(canonical(final.execution[key])===canonical(claim[key]),'RECORD_REVIEW_STORAGE_CHANGED');
   demand(['completed','failed'].includes(final.execution.state)&&typeof final.execution.ended_at==='string','RECORD_REVIEW_STORAGE_CHANGED');return final.execution;}
  return{...claim,state:'uncertain',ended_at:null,diagnostic:{code:'LOCAL_REVIEW_UNCERTAIN',coreStatus:null},saved:false};
 }
 async #expose(execution){
  const name=execution.execution_id+'-exposure.json';if(!await this.#optional(name))await this.#write(name,{schema_version:1,execution_id:execution.execution_id,record_id:execution.record_id,record_version:execution.record_version,presented_at:new Date().toISOString(),basis:'result_returned_to_authenticated_local_screen_not_proof_of_reading'});
 }
 async exposureForRecord(recordId){
  const names=await this.#names(),events=[];for(const name of names.filter(n=>/^[a-f0-9-]{36}-exposure\.json$/u.test(n))){const e=await this.#read(name);if(e.record_id===recordId)events.push(e);}return events;
 }
 async deleteForRecord(recordId){
  for(const name of (await this.#names()).filter(n=>/^[a-f0-9-]{36}-start\.json$/u.test(n))){const id=name.slice(0,36),claim=await this.#read(name);demand(UUID.test(id)&&claim.execution_id===id,'RECORD_REVIEW_STORAGE_CHANGED');if(claim.record_id!==recordId)continue;
   for(const suffix of ['result','exposure','start']){const filename=path.join(this.#root,id+'-'+suffix+'.json');try{await boundedRead(filename,16_000_000);await checkedDirectory(this.#root);await unlink(filename);}catch(e){if(e.code!=='ENOENT')throw e;}}
  }
  for(const [id,t]of this.#tickets)if(t.record.record_id===recordId)this.#tickets.delete(id);
 }
 async #history(recordId){const results=[];for(const name of (await this.#names()).filter(n=>/^[a-f0-9-]{36}-start\.json$/u.test(n))){const id=name.slice(0,36),claim=await this.#read(name);demand(UUID.test(id)&&claim.execution_id===id,'RECORD_REVIEW_STORAGE_CHANGED');if(claim.record_id===recordId)results.push(metadata(await this.#existing(id)));}return results.sort((a,b)=>b.started_at.localeCompare(a.started_at));}
 async #locked(fn){demand(typeof this.#withReview==='function','RECORD_REVIEW_UNAVAILABLE');try{return await this.#withReview(fn);}catch(e){
  if(e.code==='LOCAL_REVIEW_BUSY')fail('RECORD_REVIEW_BUSY');if(['LOCAL_POLICY_CHANGED','ACCESS_DENIED','POLICY_CHANGED','DESKTOP_STOPPING'].includes(e.code))fail('RECORD_REVIEW_POLICY_CHANGED');if(e.code==='ENOENT')fail('RECORD_REVIEW_DOCUMENT_MISSING');if(['PATH_DENIED','FILE_DENIED','SENSITIVE_CONTENT'].includes(e.code))fail('RECORD_REVIEW_DOCUMENT_DENIED');if(['CONTENT_CHANGED','FILE_CHANGED'].includes(e.code))fail('RECORD_REVIEW_CHANGED');throw e;
 }}
 #selection(input,context){
  let s;try{s=explicitOperation(input);}catch{fail('RECORD_REVIEW_SELECTION_REQUIRED');}
  demand(s.action==='checklist_review'&&s.source_ids.length>0&&s.item_ids.length===0&&new Set([s.target_doc,...s.source_ids,s.guideline_id]).size===s.source_ids.length+2,'RECORD_REVIEW_SELECTION_REQUIRED');
  for(const [ids,role]of [[[s.target_doc],'review'],[s.source_ids,'source'],[[s.guideline_id],'guideline']])for(const id of ids)demand(context.documents.some(d=>d.id===id&&d.roles.includes(role)),'RECORD_REVIEW_SELECTION_REQUIRED');
  return{action:'checklist_review',target_doc:s.target_doc,source_ids:s.source_ids,guideline_id:s.guideline_id,item_ids:[],format:s.format};
 }
 async handle(body){
  if(body.action==='review-context'){
   keys(body,['action','recordId','recordVersion']);const record=await this.#record(body.recordId,body.recordVersion),history=await this.#history(body.recordId);
   return this.#locked(async(_,ctx)=>({record_id:record.record_id,record_version:record.version,request:record.input.request,original_intent:record.raw_user_confirmation.intent,original_action:record.selection.action,historical_catalog_hash:record.catalog_hash,current_context:ctx,current_context_hash:hash(ctx),history}));
  }
  if(body.action==='review-history'){keys(body,['action','recordId']);await this.#record(body.recordId);return{executions:await this.#history(body.recordId)};}
  if(body.action==='review-detail'){
   keys(body,['action','recordId','executionId']);await this.#record(body.recordId);const e=await this.#existing(body.executionId);demand(e&&e.record_id===body.recordId,'RECORD_REVIEW_NOT_FOUND');await this.#expose(e);return{execution:e};
  }
  if(body.action==='review-preview'){
   keys(body,['action','recordId','recordVersion','selection']);const record=await this.#record(body.recordId,body.recordVersion);
   return this.#locked(async(ops,ctx)=>{
    const selection=this.#selection(body.selection,ctx),snapshot=await ops.inspect(selection),executionId=randomUUID(),confirmationId=randomUUID(),expires=Date.now()+600000;
    for(const [id,t]of this.#tickets)if(t.record.record_id===record.record_id)this.#tickets.delete(id);
    this.#tickets.set(executionId,{record,recordHash:hash(record),selection,snapshot,catalogHash:hash(ctx),confirmationId,expires});while(this.#tickets.size>32)this.#tickets.delete(this.#tickets.keys().next().value);
    return{executionId,confirmationId,record_id:record.record_id,record_version:record.version,request:record.input.request,selection,documents:snapshot.bindings,input_hash:snapshot.input_hash,historical_catalog_hash:record.catalog_hash,current_context_hash:hash(ctx),expires_at:new Date(expires).toISOString()};
   });
  }
  if(body.action==='review-start'){
   keys(body,['action','executionId','confirmationId','confirmed']);demand(UUID.test(body.executionId)&&UUID.test(body.confirmationId)&&body.confirmed===true);
   await this.#storage();const existing=await this.#existing(body.executionId);
   if(existing){demand(existing.confirmation_id===body.confirmationId,'RECORD_REVIEW_CHANGED');await this.#record(existing.record_id,existing.record_version);await this.#expose(existing);return{execution:existing,duplicate:true};}
   const t=this.#tickets.get(body.executionId);demand(t&&t.confirmationId===body.confirmationId&&t.expires>=Date.now(),'RECORD_REVIEW_EXPIRED');
   demand(hash(await this.#record(t.record.record_id,t.record.version))===t.recordHash,'RECORD_REVIEW_CHANGED');
   const execution=await this.#locked(async(ops,ctx)=>{
    const claim={schema_version:1,execution_id:body.executionId,confirmation_id:body.confirmationId,record_id:t.record.record_id,record_version:t.record.version,record_hash:t.recordHash,historical_input_hash:t.record.input_snapshot_hash,origin:'pc_record_explicit_review',inference_mode:'explicit',action:'checklist_review',selection:t.selection,input_snapshot:{...t.snapshot,catalog_hash:t.catalogHash},started_at:new Date().toISOString(),ended_at:null,state:'started',saved:false};
    // Durable exclusive claim BEFORE any core invocation. Unfinished claims never rerun.
    await this.#write(body.executionId+'-start.json',claim);
    let result;
    try{demand(hash(ctx)===t.catalogHash,'RECORD_REVIEW_CHANGED');this.#selection(t.selection,ctx);const review=await ops.run(t.selection,t.snapshot,body.executionId);
     demand(review.saved===false&&review.reason==='REVIEW_RESULT'&&['READY','ACTION_REQUIRED'].includes(review.status)&&Array.isArray(review.items)&&review.items.length>0,'RECORD_REVIEW_INVALID_RESULT');
     result={...claim,state:'completed',ended_at:new Date().toISOString(),review};
    }catch(e){result={...claim,state:'failed',ended_at:new Date().toISOString(),diagnostic:diagnostic(e)};}
    try{await this.#write(body.executionId+'-result.json',{schema_version:1,claim_hash:hash(claim),execution:result});const reread=await this.#read(body.executionId+'-result.json');demand(hash(reread.execution)===hash(result),'RECORD_REVIEW_STORAGE_CHANGED');return result;}
    catch{return{...claim,state:'uncertain',ended_at:null,diagnostic:{code:'LOCAL_REVIEW_UNCERTAIN',coreStatus:null}};}
   });
   await this.#expose(execution);return{execution,duplicate:false};
  }
  fail('RECORD_REVIEW_INVALID');
 }
}
