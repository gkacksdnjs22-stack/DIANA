import {randomUUID} from 'node:crypto';
import {keys,fail} from './strict-json.mjs';
import {draftOperation} from './draft-operation.mjs';
import {snapshotHash} from './request-records.mjs';
// PC-local explicit approval context, using the same worker reservation/adapter.
// No mobile job, AI prediction, or fabricated target is involved.
export class RecordDrafts{
 #with;#ticket=null;#result=null;#attempt=null;
 constructor(withLocalPatch){this.#with=withLocalPatch;}
 async close(){if(this.#ticket)await this.#with(ops=>ops.cancel(this.#ticket.id));this.#ticket=null;}
 async handle(body){
  if(typeof this.#with!=='function')fail('LOCAL_PATCH_UNAVAILABLE');
  if(body.action==='draft-cancel'){keys(body,['action']);await this.close();this.#result=null;return{cancelled:true,saved:false};}
  if(body.action==='draft-prepare'){
   keys(body,['action','selection']);const s=draftOperation(body.selection);await this.close();this.#result=null;
   return this.#with(async(ops,ctx)=>{
    for(const [id,role]of [[s.guideline_id,'guideline'],...s.source_ids.map(id=>[id,'source'])])if(!ctx.documents.some(d=>d.id===id&&d.roles.includes(role)))fail('LOCAL_PATCH_INVALID');
    if(this.#attempt&&!this.#attempt.resolved)fail('RECOVERY_UNCERTAIN');
    this.#attempt=null;
    const id=randomUUID(),{plan,expires}=await ops.prepare(s,id);this.#ticket={id,plan,selection:s,expires,context:snapshotHash(ctx)};
    return{id,plan,expires_at:new Date(expires).toISOString(),saved:false};
   });
  }
  if(body.action==='draft-approve'){
   keys(body,['action','id','consent']);const t=this.#ticket;
   if(!t||t.id!==body.id||body.consent!==true||t.expires<Date.now())fail('LOCAL_PATCH_EXPIRED');
   return this.#with(async(ops,ctx)=>{
    if(snapshotHash(ctx)!==t.context)fail('LOCAL_PATCH_CHANGED');
    this.#ticket=null;this.#attempt=t;const saved=await ops.commit(t.id,t.plan);
    if(saved.status!=='UNCERTAIN'&&!saved.saved)this.#attempt=null;
    if(!saved.saved||!saved.storage_verified) return{...saved,body:null};
    const verified=await ops.draftSaved(t.id);
    this.#attempt.resolved=true;this.#result={...saved,filename:saved.outputFile,sha256:saved.output_hash,body:verified.body,unresolved:verified.unresolved};return this.#result;
   });
  }
  if(body.action==='draft-result'){
   keys(body,['action']);const t=this.#attempt;if(!t)fail('RESULT_UNAVAILABLE');
   return this.#with(async ops=>{const saved=await ops.recover(t.id,t.selection,t.plan),v=await ops.draftSaved(t.id);
    t.resolved=true;this.#result={...saved,...v,filename:saved.outputFile,sha256:saved.output_hash,recovered:true};return this.#result;});
  }
  if(body.action==='draft-read'){keys(body,['action']);if(!this.#result)fail('LOCAL_PATCH_NOT_SAVED');return this.#with(ops=>ops.draftSaved(this.#result.request_id));}
  fail('LOCAL_PATCH_INVALID');
 }
}
