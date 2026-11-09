import path from 'node:path';
import {mkdir,open,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {checkedDirectory,digest} from '../personal-ai/documents/files.mjs';
import {boundedRead,verifyOpenedOutput} from './files.mjs';
import {keys,strictJSON,fail} from './strict-json.mjs';
import {UUID} from '../lib/financial-contract.mjs';

const canonical=v=>JSON.stringify(v===null||typeof v!=='object'?v:Array.isArray(v)?v.map(x=>JSON.parse(canonical(x))):Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(canonical(v[k]))])));
const hash=v=>digest(canonical(v)),need=(v,code='LOCAL_PATCH_INVALID')=>{if(!v)fail(code);};
const within=(a,b)=>{const r=path.relative(a,b);return !r||r!=='..'&&!r.startsWith('..'+path.sep)&&!path.isAbsolute(r);};

/** Local-only append-only receipts. Pending plans are server memory, not browser
 * plans, remote jobs, or approvals that survive process restart. */
export class RecordPatches{
 #root;#protected;#with;#review;#record;#tickets=new Map();
 constructor({stateDir,protectedRoots,withLocalPatch,getReview,getRecord}){
  this.#root=path.resolve(stateDir+'.request-patches');this.#protected=[...protectedRoots,stateDir,stateDir+'.request-records',stateDir+'.request-reviews',stateDir+'.registrations'].map(p=>path.resolve(p));
  this.#with=withLocalPatch;this.#review=getReview;this.#record=getRecord;
 }
 async #storage(){await checkedDirectory(path.dirname(this.#root));for(const p of this.#protected)need(!within(p,this.#root)&&!within(this.#root,p),'LOCAL_PATCH_STORAGE_BOUNDARY');await mkdir(this.#root,{recursive:true,mode:0o700});await checkedDirectory(this.#root);}
 async #write(id,suffix,value){need(UUID.test(id));await this.#storage();const filename=path.join(this.#root,id+'-'+suffix+'.json'),h=await open(filename,'ax',0o600);try{await verifyOpenedOutput(h,filename,this.#root);await h.writeFile(JSON.stringify(value)+'\n');await h.sync();await verifyOpenedOutput(h,filename,this.#root);}finally{await h.close();}}
 async #read(id,suffix){need(UUID.test(id));await this.#storage();try{return strictJSON((await boundedRead(path.join(this.#root,id+'-'+suffix+'.json'),16_000_000)).content);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
 async #locked(fn){need(typeof this.#with==='function','LOCAL_PATCH_UNAVAILABLE');return this.#with(fn);}
 async #current(execution){const r=await this.#record(execution.record_id);need(r.version===execution.record_version&&hash(r)===execution.record_hash,'LOCAL_PATCH_RECORD_CHANGED');return r;}
 async #final(id){const claim=await this.#read(id,'approve');if(!claim)return null;need(claim.patch_id===id,'LOCAL_PATCH_STORAGE_CHANGED');const saved=await this.#read(id,'result');
  if(!saved)return{...claim,state:'uncertain',saved:false,reason:'LOCAL_PATCH_UNCERTAIN'};
  need(saved.claim_hash===hash(claim)&&saved.result.patch_id===id&&saved.result.review_id===claim.review_id&&saved.result.record_id===claim.record_id,'LOCAL_PATCH_STORAGE_CHANGED');return saved.result;
 }
 async cancelForRecord(recordId){for(const[id,t]of this.#tickets)if(t.record_id===recordId){await this.#locked(ops=>ops.cancel(id));this.#tickets.delete(id);}}
 async close(){for(const[id]of this.#tickets)await this.#locked(ops=>ops.cancel(id));this.#tickets.clear();}
 async handle(body){
  if(body.action==='patch-history'){
   keys(body,['action','reviewId']);const e=await this.#review(body.reviewId);need(e,'LOCAL_PATCH_REVIEW_REQUIRED');await this.#record(e.record_id);await this.#storage();const names=await readdir(this.#root);need(names.length<=10000,'LOCAL_PATCH_LIMIT');const results=[];
   for(const name of names.filter(n=>/^[a-f0-9-]{36}-approve\.json$/u.test(n))){const r=await this.#final(name.slice(0,36));if(r.review_id===body.reviewId)results.push(r);}return{results};
  }
  if(body.action==='patch-prepare'){
   keys(body,['action','reviewId','itemIds']);const e=await this.#review(body.reviewId);
   need(e?.state==='completed'&&e.review?.reason==='REVIEW_RESULT'&&e.selection?.format==='md','LOCAL_PATCH_REVIEW_REQUIRED');await this.#current(e);
   need(Array.isArray(body.itemIds)&&body.itemIds.length>0&&new Set(body.itemIds).size===body.itemIds.length,'LOCAL_PATCH_ITEMS_REQUIRED');
   for(const id of body.itemIds)need(e.review.items.some(x=>x.item_id===id&&x.status==='MISSING_WITH_EVIDENCE'),'LOCAL_PATCH_ITEM_NOT_ELIGIBLE');
   return this.#locked(async(ops,ctx)=>{
    need(hash(ctx)===e.input_snapshot.catalog_hash,'LOCAL_PATCH_CHANGED');const snapshot=await ops.inspect(e.selection);need(snapshot.input_hash===e.input_snapshot.input_hash,'LOCAL_PATCH_CHANGED');
    const id=randomUUID(),selection={...e.selection,action:'patch',item_ids:[...body.itemIds].sort()};
    const {plan,expires}=await ops.prepare(selection,id);
    try{
     const t={patch_id:id,review_id:e.execution_id,record_id:e.record_id,record_version:e.record_version,record_hash:e.record_hash,selection,plan,expires,catalog_hash:hash(ctx)};
     await this.#write(id,'prepare',{...t,origin:'pc_local_explicit_patch',created_at:new Date().toISOString(),approval:false});this.#tickets.set(id,t);
     return{patchId:id,expires_at:new Date(expires).toISOString(),target:ctx.documents.find(d=>d.id===selection.target_doc)?.display_name??selection.target_doc,format:'md',items:e.review.items.filter(x=>body.itemIds.includes(x.item_id)),before:e.review.body,after:plan.expected_body,diff:plan.unified_diff,changes:plan.changes,unresolved:plan.unresolved,saved:false};
    }catch(err){await ops.cancel(id);throw err;}
   });
  }
  if(body.action==='patch-cancel'){
   keys(body,['action','patchId']);need(UUID.test(body.patchId));const t=this.#tickets.get(body.patchId);if(t){await this.#locked(ops=>ops.cancel(body.patchId));this.#tickets.delete(body.patchId);await this.#write(body.patchId,'cancel',{patch_id:body.patchId,cancelled_at:new Date().toISOString(),origin:'pc_local_explicit_cancel'});}return{cancelled:true,saved:false};
  }
  if(body.action==='patch-approve'){
   keys(body,['action','patchId','confirmed']);need(UUID.test(body.patchId)&&body.confirmed===true);
   const previous=await this.#final(body.patchId);if(previous){await this.#record(previous.record_id);return{result:previous,duplicate:true};}
   const t=this.#tickets.get(body.patchId);need(t&&t.expires>=Date.now(),'LOCAL_PATCH_EXPIRED');
   await this.#current({...t,record_version:t.record_version});
   return this.#locked(async(ops,ctx)=>{
    need(hash(ctx)===t.catalog_hash,'LOCAL_PATCH_CHANGED');
    const claim={patch_id:t.patch_id,review_id:t.review_id,record_id:t.record_id,record_version:t.record_version,origin:'pc_local_explicit_approval',approved_at:new Date().toISOString(),selection:t.selection,plan_hash:t.plan.plan_hash,approval_basis:'authenticated_local_click_not_independent_annotation'};
    await this.#write(t.patch_id,'approve',claim);this.#tickets.delete(t.patch_id);
    let result;
    try{const saved=await ops.commit(t.patch_id,t.plan);result={...claim,state:saved.status==='UNCERTAIN'?'uncertain':saved.saved&&saved.storage_verified?'saved':'failed',saved:saved.saved===true&&saved.storage_verified===true,storage:saved};
     if(result.saved){try{result.savedReview=await ops.saved(t.patch_id,t.selection);}catch(err){result.readbackReviewError=err.code||'SAVED_REVIEW_FAILED';}}
    }catch(err){await ops.cancel(t.patch_id);result={...claim,state:'uncertain',saved:false,reason:err.code||'LOCAL_PATCH_UNCERTAIN'};}
    try{await this.#write(t.patch_id,'result',{claim_hash:hash(claim),result});need(hash((await this.#read(t.patch_id,'result')).result)===hash(result),'LOCAL_PATCH_STORAGE_CHANGED');}
    catch{return{result:{...claim,state:'uncertain',saved:false,reason:'LOCAL_PATCH_RECEIPT_UNCERTAIN'},duplicate:false};}
    return{result,duplicate:false};
   });
  }
  if(body.action==='patch-recheck'){
   keys(body,['action','patchId']);const r=await this.#final(body.patchId);need(r?.saved===true&&r.state==='saved','LOCAL_PATCH_NOT_SAVED');await this.#record(r.record_id);
   const review=await this.#locked(ops=>ops.saved(r.patch_id,r.selection));return{review};
  }
  if(body.action==='patch-result'){
   keys(body,['action','patchId']);const claim=await this.#read(body.patchId,'approve'),t=await this.#read(body.patchId,'prepare');
   need(claim&&t&&t.patch_id===body.patchId&&claim.plan_hash===t.plan.plan_hash&&hash(claim.selection)===hash(t.selection),'RECOVERY_UNCERTAIN');
   await this.#current(t);
   return this.#locked(async ops=>{
    const storage=await ops.recover(t.patch_id,t.selection,t.plan),savedReview=await ops.saved(t.patch_id,t.selection);
    const result={...claim,state:'saved',saved:true,storage,savedReview,recovered:true};
    // Preserve the first result, append a distinct reconciliation event.
    await this.#write(t.patch_id,'recovery-'+randomUUID(),{claim_hash:hash(claim),result,checked_at:new Date().toISOString()});
    return{result};
   });
  }
  fail('LOCAL_PATCH_INVALID');
 }
}
