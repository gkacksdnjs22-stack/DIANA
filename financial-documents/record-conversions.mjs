import {randomUUID} from 'node:crypto';
import {keys,fail} from './strict-json.mjs';
import {conversionOperation} from './conversion-operation.mjs';
export class RecordConversions{
 #with;#ticket=null;#result=null;#attempt=null;
 constructor(withLocalPatch){this.#with=withLocalPatch;}
 async close(){if(this.#ticket)await this.#with(ops=>ops.cancel(this.#ticket.id));this.#ticket=null;}
 async handle(b){
  if(typeof this.#with!=='function')fail('LOCAL_PATCH_UNAVAILABLE');
  if(b.action==='conversion-list'){keys(b,['action']);return this.#with(ops=>ops.conversionCandidates());}
  if(b.action==='conversion-cancel'){keys(b,['action']);await this.close();this.#result=null;return{cancelled:true,saved:false};}
  if(b.action==='conversion-prepare'){
   keys(b,['action','selection']);const s=conversionOperation(b.selection);await this.close();this.#result=null;
   if(this.#attempt&&!this.#attempt.resolved)fail('RECOVERY_UNCERTAIN');
   this.#attempt=null;
   return this.#with(async ops=>{const id=randomUUID(),{plan,expires}=await ops.prepare(s,id);this.#ticket={id,plan,selection:s,expires};return{id,plan,saved:false};});
  }
  if(b.action==='conversion-approve'){
   keys(b,['action','id','consent']);const t=this.#ticket;if(!t||b.id!==t.id||b.consent!==true||t.expires<Date.now())fail('LOCAL_PATCH_EXPIRED');
   return this.#with(async ops=>{this.#ticket=null;this.#attempt=t;const s=await ops.commit(t.id,t.plan);if(s.status!=='UNCERTAIN'&&!s.saved)this.#attempt=null;if(!s.saved||!s.storage_verified)return s;
    const v=await ops.conversionSaved(t.id);t.resolved=true;this.#result={...s,...v,filename:s.outputFile,sha256:s.output_hash};return this.#result;});
  }
  if(b.action==='conversion-result'){
   keys(b,['action']);const t=this.#attempt;if(!t)fail('RESULT_UNAVAILABLE');
   return this.#with(async ops=>{const s=await ops.recover(t.id,t.selection,t.plan),v=await ops.conversionSaved(t.id);
    t.resolved=true;this.#result={...s,...v,filename:s.outputFile,sha256:s.output_hash,recovered:true};return this.#result;});
  }
  if(b.action==='conversion-read'){keys(b,['action']);if(!this.#result)fail('NO_SAVED_RESULT');return this.#with(ops=>ops.conversionSaved(this.#result.request_id));}
  fail('INVALID_CONVERSION');
 }
}
