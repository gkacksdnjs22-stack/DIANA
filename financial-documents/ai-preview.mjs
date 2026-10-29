import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {mkdir,open,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {checkedDirectory,digest} from '../personal-ai/documents/files.mjs';
import {boundedRead,verifyOpenedOutput} from './files.mjs';
import {keys,strictJSON,fail} from './strict-json.mjs';
import {UUID} from '../lib/financial-contract.mjs';
import {buildModelInput,validateInterpretation} from '../experiments/financial-review/contract.mjs';
const canonical=x=>x===null||typeof x!=='object'?x:Array.isArray(x)?x.map(canonical):Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])]));
const hash=x=>digest(JSON.stringify(canonical(x)));
export class AiPreview {
 #root;#protected;#context;#python;#active=null;#closed=false;#cancelled=new Set();
 constructor({stateDir,protectedRoots,withContext,python}){this.#root=path.resolve(stateDir+'.ai-previews');this.#protected=[...protectedRoots,stateDir,stateDir+'.request-records',stateDir+'.request-reviews'];this.#context=withContext;this.#python=python;}
 async #storage(){for(const p of this.#protected){const a=path.relative(path.resolve(p),this.#root),b=path.relative(this.#root,path.resolve(p));if(!a||!a.startsWith('..')||!b.startsWith('..'))fail('RECORD_AI_STORAGE_BOUNDARY');}await checkedDirectory(path.dirname(this.#root));await mkdir(this.#root,{recursive:true});await checkedDirectory(this.#root);}
 async #write(id,suffix,data){await this.#storage();const p=path.join(this.#root,id+'-'+suffix+'.json'),h=await open(p,'ax',0o600);try{await verifyOpenedOutput(h,p,this.#root);await h.writeFile(JSON.stringify(data));await h.sync();}finally{await h.close();}}
 async #read(id){if(!UUID.test(id))fail('RECORD_AI_INVALID');return strictJSON((await boundedRead(path.join(this.#root,id+'-result.json'),1000000)).content);}
 async auditHistory(id){await this.#storage();const events=[];for(const n of await readdir(this.#root)){if(!/^[a-f0-9-]{36}-[a-f0-9-]{36}\.json$/.test(n))continue;const e=strictJSON((await boundedRead(path.join(this.#root,n),1000000)).content);if(e.record_id===id)events.push(e);}return events.sort((a,b)=>a.at.localeCompare(b.at));}
 async exposure(id){await this.#storage();const events=[];for(const n of await readdir(this.#root)){if(!/^[a-f0-9-]{36}-[a-f0-9-]{36}\.json$/.test(n))continue;const e=strictJSON((await boundedRead(path.join(this.#root,n),1000000)).content);if(e.record_id===id&&e.phase==='viewed'){const p=await this.#read(e.prediction_id);events.push({prediction_id:p.predictionId,input_hash:p.input_hash,presented_at:e.at,model:p.model,annotation_provenance:'user_confirmation_after_ai_preview'});}}return events;}
 async #run(input,signal){return new Promise((resolve,reject)=>{
  const child=spawn(this.#python,['-I','-B',fileURLToPath(new URL('./local-ai-preview/inference.py',import.meta.url))],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...Object.fromEntries(['SystemRoot','WINDIR','TEMP','TMP','PATH'].filter(k=>process.env[k]).map(k=>[k,process.env[k]])),OPENBLAS_NUM_THREADS:'1',OMP_NUM_THREADS:'1'}});
  let output='',error=null;const abort=()=>{error='RECORD_AI_CANCELLED';child.kill();};signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
  const timer=setTimeout(()=>{error='RECORD_AI_TIMEOUT';child.kill();},15000);
  child.stderr.resume();child.stdout.on('data',b=>{output+=b.toString();if(Buffer.byteLength(output)>500000){error='RECORD_AI_RESULT_LIMIT';child.kill();}});
  child.on('error',()=>{error='RECORD_AI_RUNTIME_MISSING';});child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(input));
  child.on('close',code=>{clearTimeout(timer);signal.removeEventListener('abort',abort);try{if(error)fail(error);const r=strictJSON(output);if(code!==0||r.ok!==true)fail('RECORD_AI_RUNTIME_FAILED');resolve(r);}catch(e){reject(e);}});
 });}
 async close(){this.#closed=true;this.#active?.controller.abort();await this.#active?.promise.catch(()=>{});}
 async handle(b){
  if(b.action==='ai-note'){keys(b,['action','recordId','predictionId','phase','request','confirmation']);if(!UUID.test(b.recordId)||!UUID.test(b.predictionId)||!['before_inference','viewed','edited','applied'].includes(b.phase)||typeof b.request!=='string'||b.request.length>2000)fail('RECORD_AI_INVALID');await this.#write(b.predictionId,randomUUID(),{record_id:b.recordId,prediction_id:b.predictionId,phase:b.phase,request:b.request,confirmation:b.confirmation,at:new Date().toISOString(),provenance:'browser_user_selection_audit_only_not_model_input'});return{noted:true};}
  if(b.action==='ai-cancel'){keys(b,['action','predictionId']);if(!UUID.test(b.predictionId))fail('RECORD_AI_INVALID');this.#cancelled.add(b.predictionId);if(this.#cancelled.size>100)this.#cancelled.delete(this.#cancelled.values().next().value);if(this.#active?.id===b.predictionId)this.#active.controller.abort();return{cancelled:true};}
  if(b.action==='ai-apply'){
   keys(b,['action','predictionId','recordId','request','confirmedFormat','contextHash']);const p=await this.#read(b.predictionId);
   if(p.record_id!==b.recordId||!p.applicable||this.#cancelled.has(b.predictionId))fail('RECORD_AI_CHANGED');
   return this.#context(async ctx=>{const input=buildModelInput(b.request,ctx.documents,ctx.documents.map(({id,display_name,aliases,roles})=>({id,display_name,aliases,roles})),{confirmedFormat:b.confirmedFormat});if(hash(input)!==p.input_hash||hash(ctx)!==p.context_hash)fail('RECORD_AI_CHANGED');await this.#write(b.predictionId,randomUUID(),{type:'applied',at:new Date().toISOString(),record_id:b.recordId,input_hash:p.input_hash});return{operation:p.contract.operation};});
  }
  keys(b,['action','predictionId','recordId','request','confirmedFormat','contextHash']);if(b.action!=='ai-infer'||!UUID.test(b.recordId)||!UUID.test(b.predictionId)||this.#closed)fail('RECORD_AI_INVALID');
  if(this.#active)fail('RECORD_AI_BUSY');const controller=new AbortController();if(this.#cancelled.has(b.predictionId))controller.abort();
  const work=async()=>{let receipt={predictionId:b.predictionId,record_id:b.recordId,started_at:new Date().toISOString()};
   try{return await this.#context(async ctx=>{
    if(controller.signal.aborted)fail('RECORD_AI_CANCELLED');if(hash(ctx)!==b.contextHash)fail('RECORD_AI_CHANGED');
    const input=buildModelInput(b.request,ctx.documents,ctx.documents.map(({id,display_name,aliases,roles})=>({id,display_name,aliases,roles})),{confirmedFormat:b.confirmedFormat});
    receipt={...receipt,input,input_hash:hash(input),context_hash:hash(ctx)};await this.#write(b.predictionId,'start',receipt);
    const r=await this.#run(input,controller.signal);if(controller.signal.aborted)fail('RECORD_AI_CANCELLED');
    const output=r.prediction.output,contract=validateInterpretation(JSON.stringify(output),input);
    const result={...receipt,raw_heads:r.prediction.raw_heads,output,diagnostic:r.prediction,model:r.model,seconds:r.seconds,contract,applicable:contract.status==='VALIDATED',returned_at:new Date().toISOString(),status:'completed',score_policy:'uncalibrated model output; not correctness probability'};
    await this.#write(b.predictionId,'result',result);return result;
   });}catch(e){await this.#write(b.predictionId,'failure',{...receipt,status:'failed',code:/^RECORD_AI_[A-Z_]+$/.test(e.code||'')?e.code:'RECORD_AI_FAILED',ended_at:new Date().toISOString()}).catch(()=>{});throw e;}
  };
  const promise=work();this.#active={id:b.predictionId,controller,promise};try{return await promise;}finally{this.#active=null;}
 }
}
