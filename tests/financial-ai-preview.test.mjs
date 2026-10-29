import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,readdir} from 'node:fs/promises';
import path from 'node:path';import {randomUUID} from 'node:crypto';
import {AiPreview} from '../financial-documents/ai-preview.mjs';
import {snapshotHash} from '../financial-documents/request-records.mjs';
// Synthetic software fixtures only. No training/validation/sealed data or model execution.
async function fixture(t){
 await mkdir('.local',{recursive:true});const dir=await mkdtemp(path.resolve('.local/preview-boundary-'));
 const ctx={documents:[{id:'T',display_name:'가상 대상',aliases:[],roles:['review']},{id:'S',display_name:'가상 근거',aliases:[],roles:['source']},{id:'G',display_name:'가상 지침',aliases:[],roles:['guideline']}]};
 const stateDir=path.join(dir,'state'),service=new AiPreview({stateDir,protectedRoots:[],withContext:fn=>fn(ctx),python:path.join(dir,'missing-python.exe')});
 t.after(()=>service.close());
 return{service,stateDir,ctx,body:{action:'ai-infer',predictionId:randomUUID(),recordId:randomUUID(),request:'가상 대상을 가상 근거와 가상 지침으로 검토해줘',confirmedFormat:'md',contextHash:snapshotHash(ctx)}};
}
test('missing local runtime is an explicit failure with no external fallback or applicable result',async t=>{
 const f=await fixture(t);await assert.rejects(()=>f.service.handle(f.body),{code:'RECORD_AI_RUNTIME_MISSING'});
 const names=await readdir(f.stateDir+'.ai-previews');assert(!names.some(n=>n.endsWith('-result.json')));
 const failure=JSON.parse(await readFile(path.join(f.stateDir+'.ai-previews',f.body.predictionId+'-failure.json'),'utf8'));
 assert.equal(failure.status,'failed');assert.equal(failure.code,'RECORD_AI_RUNTIME_MISSING');
 await assert.rejects(()=>f.service.handle({...f.body,action:'ai-apply'}));
});
test('stale context and unknown input fields are rejected before any runtime can execute',async t=>{
 const f=await fixture(t);await assert.rejects(()=>f.service.handle({...f.body,taskId:'forbidden'}));
 await assert.rejects(()=>f.service.handle({...f.body,contextHash:'0'.repeat(64)}),{code:'RECORD_AI_CHANGED'});
});
test('cancellation before inference and single-flight exclusion survive an unavailable runtime',async t=>{
 const f=await fixture(t);await f.service.handle({action:'ai-cancel',predictionId:f.body.predictionId});
 await assert.rejects(()=>f.service.handle(f.body),{code:'RECORD_AI_CANCELLED'});
 const body={...f.body,predictionId:randomUUID()},pending=f.service.handle(body);const settled=assert.rejects(()=>pending);
 await assert.rejects(()=>f.service.handle({...body,predictionId:randomUUID()}),{code:'RECORD_AI_BUSY'});
 await f.service.handle({action:'ai-cancel',predictionId:body.predictionId});await settled;
});
