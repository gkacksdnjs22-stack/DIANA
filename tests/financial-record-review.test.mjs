import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,copyFile,readFile,writeFile,readdir,unlink} from 'node:fs/promises';
import {FinancialWorker} from '../financial-documents/remote-worker.mjs';
import {LocalRegistration} from '../financial-documents/local-registration.mjs';
import {RequestRecords,emptyConfirmation} from '../financial-documents/request-records.mjs';
import {createReviewViewer} from '../financial-documents/review-viewer.mjs';

const python=process.env.DIANA_TEST_PYTHON||path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/python',process.platform==='win32'?'python.exe':'bin/python');
const operation=()=>({action:'checklist_review',target_doc:'REVIEW_A',source_ids:['DD_A'],guideline_id:'PE-02',item_ids:[],format:'md'});
// Only the checked-in synthetic fixtures are copied. No model/evaluation data.
async function fixture(t){
 await mkdir('.local',{recursive:true});const root=await mkdtemp(path.resolve('.local/financial-record-review-test-'));
 const input=path.join(root,'input'),output=path.join(root,'output'),generic=path.join(root,'generic'),state=path.join(root,'state');
 await Promise.all([input,output,generic].map(d=>mkdir(d)));
 for(const name of ['review.md','due-diligence.txt','guideline.json'])await copyFile(path.join('financial-documents/fixtures/fund-a',name),path.join(input,name));
 await writeFile(path.join(input,'denied.txt'),'SYNTHETIC_DENIED_BODY_NEVER_VISIBLE');
 const corePath=path.join(root,'core.json'),configPath=path.join(root,'worker.json');
 const core={schema_version:1,principal:'synthetic-record-review',role:'analyst',readRoots:[input],outputRoot:output,python,write_roles:['analyst'],approval_ttl_ms:300000,documents:[['REVIEW_A','review.md'],['DD_A','due-diligence.txt'],['PE-02','guideline.json'],['DENIED','denied.txt']].map(([id,relativePath])=>({id,relativePath,rootIndex:0,version:'1',classification:'synthetic',read_roles:id==='DENIED'?['admin']:['analyst']}))};
 const task={id:randomUUID(),label:'가상 검토 작업',actions:['checklist_review','patch'],formats:['md','txt','json'],target_doc:'REVIEW_A',source_ids:['DD_A'],guideline_id:'PE-02',item_ids:['KEY_MAN']};
 await writeFile(corePath,JSON.stringify(core));await writeFile(configPath,JSON.stringify({schema_version:1,coreConfig:corePath,stateDir:state,tasks:[task]}));
 const apiCalls=[],events=[];
 const worker=await FinancialWorker.create({configPath,documentRoot:generic,detailOutput:false,onEvent:e=>events.push(e),api:async(route,body)=>{apiCalls.push({route,body});return route.endsWith('/next')?{job:null}:{ok:true};}});
 t.after(()=>worker.close());const registry=await LocalRegistration.open(worker);
 const options={stateDir:state,protectedRoots:[input,output,generic],withContext:fn=>registry.withRecordingContext(fn),withLocalReview:fn=>registry.withLocalReview(fn),appVersion:'synthetic-integration'};
 let records=new RequestRecords(options);
 const f={root,input,output,state,corePath,core,worker,registry,apiCalls,events,get records(){return records;},restartRecords(){records=new RequestRecords(options);}};
 f.saveRecord=async(overrides={})=>{
  const ctx=await records.handle({action:'context'});
  const confirmation=emptyConfirmation();confirmation.intent='question';confirmation.target={state:'selected',ids:['REVIEW_A']};confirmation.sources={state:'selected',ids:['DD_A']};confirmation.guideline={state:'selected',ids:['PE-02']};confirmation.format={state:'selected',value:'md'};
  const body={action:'preview',id:randomUUID(),baseVersion:0,request:'가상 문서의 검토 요청이 어떤 뜻인지 설명해 주세요. 📎',contextHash:ctx.context_hash,selection:{taskId:null,format:'md',action:'patch'},confirmation,dataOrigin:'synthetic',jobId:null,...overrides};
  const preview=await records.handle(body);await records.handle({action:'save',id:body.id,previewId:preview.previewId,confirmationHash:preview.confirmationHash});return body;
 };
 f.reviewPreview=record=>records.handle({action:'review-preview',recordId:record.id,recordVersion:1,selection:operation()});
 f.start=preview=>records.handle({action:'review-start',executionId:preview.executionId,confirmationId:preview.confirmationId,confirmed:true});
 return f;
}

test('saved record without mobile job needs separate explicit review; actual selected core result stays local',async t=>{
 const f=await fixture(t),record=await f.saveRecord(),original=await readFile(path.join(f.records.directory,record.id+'-v1.json'));
 assert.deepEqual(await readdir(f.output),[]);assert.equal(f.apiCalls.length,0);assert.equal(f.events.length,0);
 const context=await f.records.handle({action:'review-context',recordId:record.id,recordVersion:1});
 assert.equal(context.original_intent,'question');assert.equal(context.original_action,'patch');assert.equal(context.request,record.request);assert.equal(context.current_context.documents.length,3);assert.ok(!JSON.stringify(context).includes('DENIED'));
 const preview=await f.reviewPreview(record);assert.deepEqual(preview.selection,operation());assert.deepEqual(preview.documents.map(d=>d.id),['REVIEW_A','DD_A','PE-02']);assert.ok(preview.documents.every(d=>/^[a-f0-9]{64}$/u.test(d.hash)));assert.deepEqual(await readdir(f.output),[]);
 await assert.rejects(()=>f.records.handle({action:'review-start',executionId:preview.executionId,confirmationId:preview.confirmationId,confirmed:false}));
 const result=await f.start(preview),execution=result.execution;assert.equal(execution.state,'completed');assert.equal(execution.record_id,record.id);assert.equal(execution.record_version,1);assert.equal(execution.saved,false);assert.equal(execution.review.saved,false);assert.equal(execution.review.reason,'REVIEW_RESULT');assert.equal(execution.review.reviewComplete,false);
 assert.deepEqual(execution.review.documents.map(d=>d.id),['REVIEW_A','DD_A','PE-02']);assert.ok(execution.review.items.some(i=>i.item_id==='KEY_MAN'&&i.status==='MISSING_WITH_EVIDENCE'));assert.ok(execution.review.items.some(i=>i.item_id==='LPAC'&&i.status==='MISSING_NO_EVIDENCE'));assert.ok(execution.review.unresolved.length>0);assert.ok(execution.review.body.length>0);
 assert.deepEqual(await readdir(f.output),[],'No business output or ledger/approval file');assert.equal(f.apiCalls.length,0,'No relay register/status/observe calls');assert.equal(f.events.length,0,'No fake mobile job or result event');assert.deepEqual(await readFile(path.join(f.records.directory,record.id+'-v1.json')),original);
 const detail=await f.records.handle({action:'detail',id:record.id});assert.equal(detail.versions[0].contract_annotation.output,null);assert.equal(detail.versions[0].raw_user_confirmation.intent,'question');
 assert.ok(!JSON.stringify(execution).includes('approval_payload'));assert.ok(!JSON.stringify(execution).includes('approval_token'));
});

test('same execution ID is idempotent for double click and retry after service restart',async t=>{
 const f=await fixture(t),record=await f.saveRecord(),preview=await f.reviewPreview(record),pair=await Promise.all([f.start(preview),f.start(preview)]);
 assert.equal(pair[0].execution.execution_id,pair[1].execution.execution_id);assert.equal(pair.filter(r=>r.duplicate).length,1);
 f.restartRecords();const retry=await f.start(preview);assert.equal(retry.duplicate,true);assert.equal(retry.execution.state,'completed');
 const history=await f.records.handle({action:'review-history',recordId:record.id});assert.equal(history.executions.length,1);assert.equal(f.apiCalls.length,0);assert.deepEqual(await readdir(f.output),[]);
});

test('selected document mutation after confirmation is a failed CONTENT_CHANGED, not empty success',async t=>{
 const f=await fixture(t),record=await f.saveRecord(),preview=await f.reviewPreview(record),filename=path.join(f.input,'due-diligence.txt');await writeFile(filename,(await readFile(filename,'utf8'))+'\n가상 변경 내용');
 const result=await f.start(preview);assert.equal(result.execution.state,'failed');assert.equal(result.execution.diagnostic.code,'CONTENT_CHANGED');assert.ok(!result.execution.review);assert.equal(result.execution.saved,false);assert.equal((await f.start(preview)).duplicate,true);assert.deepEqual(await readdir(f.output),[]);
});

test('unknown/denied IDs, incomplete selections, paths and non-review actions are rejected',async t=>{
 const f=await fixture(t),record=await f.saveRecord();
 for(const selection of [{...operation(),target_doc:'DENIED'},{...operation(),target_doc:'ABSENT'},{...operation(),source_ids:[]},{...operation(),format:null},{...operation(),action:'patch'},{...operation(),path:'C:/outside/file'}])await assert.rejects(()=>f.records.handle({action:'review-preview',recordId:record.id,recordVersion:1,selection}));
 assert.deepEqual(await readdir(f.output),[]);assert.equal(f.apiCalls.length,0);
});

test('missing current document is reported before review execution',async t=>{
 const f=await fixture(t),record=await f.saveRecord();await unlink(path.join(f.input,'due-diligence.txt'));
 await assert.rejects(()=>f.reviewPreview(record),{code:'RECORD_REVIEW_DOCUMENT_MISSING'});
 assert.deepEqual(await readdir(f.output),[]);assert.equal(f.apiCalls.length,0);
});

test('actual core diagnostic remains failure and exposes no false completed review',async t=>{
 const f=await fixture(t),record=await f.saveRecord();await writeFile(path.join(f.input,'guideline.json'),JSON.stringify({id:'PE-02',version:'1',rules:[]}));
 const preview=await f.reviewPreview(record),result=await f.start(preview);
 assert.equal(result.execution.state,'failed');assert.match(result.execution.diagnostic.code,/^[A-Z][A-Z0-9_]+$/u);assert.notEqual(result.execution.diagnostic.code,'REVIEW_RESULT');assert.ok(!result.execution.review);assert.equal(result.execution.saved,false);assert.deepEqual(await readdir(f.output),[]);
});

test('durable start without result is uncertain after restart and never automatically reruns',async t=>{
 const f=await fixture(t),record=await f.saveRecord(),preview=await f.reviewPreview(record);await f.start(preview);
 // Simulate the exact persisted crash boundary using this test's own artifact.
 const resultFile=path.join(f.state+'.request-reviews',preview.executionId+'-result.json');assert.equal(path.dirname(resultFile),f.state+'.request-reviews');await unlink(resultFile);
 f.restartRecords();const recovered=await f.start(preview);assert.equal(recovered.execution.state,'uncertain');assert.equal(recovered.duplicate,true);assert.ok(!recovered.execution.review);
 await assert.rejects(()=>readFile(resultFile),{code:'ENOENT'});assert.equal(f.apiCalls.length,0);assert.deepEqual(await readdir(f.output),[]);
});

test('tampered durable claim cannot redirect execution-history deletion outside its directory',async t=>{
 const f=await fixture(t),record=await f.saveRecord(),preview=await f.reviewPreview(record);await f.start(preview);
 const claimFile=path.join(f.state+'.request-reviews',preview.executionId+'-start.json'),claim=JSON.parse(await readFile(claimFile,'utf8'));
 const sentinelFiles=['start','result','exposure'].map(suffix=>path.join(f.root,'sentinel-'+suffix+'.json'));
 for(const filename of sentinelFiles)await writeFile(filename,'SYNTHETIC_OUTSIDE_HISTORY_SENTINEL');
 await writeFile(claimFile,JSON.stringify({...claim,execution_id:'../sentinel'}));
 await assert.rejects(()=>f.records.handle({action:'delete',id:record.id}),{code:'RECORD_REVIEW_STORAGE_CHANGED'});
 for(const filename of sentinelFiles)assert.equal(await readFile(filename,'utf8'),'SYNTHETIC_OUTSIDE_HISTORY_SENTINEL');
 assert.deepEqual(await readdir(f.output),[]);assert.equal(f.apiCalls.length,0);
});

test('tampered result record identity or version cannot be presented as the claimed execution',async t=>{
 const f=await fixture(t),record=await f.saveRecord(),preview=await f.reviewPreview(record);await f.start(preview);
 const resultFile=path.join(f.state+'.request-reviews',preview.executionId+'-result.json'),original=JSON.parse(await readFile(resultFile,'utf8'));
 for(const patch of [{record_version:2},{record_id:randomUUID()}]){
  await writeFile(resultFile,JSON.stringify({...original,execution:{...original.execution,...patch}}));
  await assert.rejects(()=>f.records.handle({action:'review-detail',recordId:record.id,executionId:preview.executionId}),{code:'RECORD_REVIEW_STORAGE_CHANGED'});
 }
 assert.deepEqual(await readdir(f.output),[]);assert.equal(f.apiCalls.length,0);
});

test('review result exposure is preserved on later user-label correction without changing original gold',async t=>{
 const f=await fixture(t),record=await f.saveRecord(),preview=await f.reviewPreview(record);await f.start(preview);await f.records.handle({action:'review-detail',recordId:record.id,executionId:preview.executionId});
 const correction={...record,baseVersion:1,confirmation:{...record.confirmation,intent:'perform'}};const revised=await f.records.handle(correction);await f.records.handle({action:'save',id:record.id,previewId:revised.previewId,confirmationHash:revised.confirmationHash});
 const detail=await f.records.handle({action:'detail',id:record.id});assert.equal(detail.versions.length,2);assert.equal(detail.versions[0].raw_user_confirmation.intent,'question');assert.equal(detail.versions[1].raw_user_confirmation.intent,'perform');assert.equal(detail.versions[1].contract_annotation.output,null);assert.ok(detail.versions[1].review_exposure_at_save.length>=1);assert.ok(JSON.stringify(detail.versions[1].review_exposure_at_save).includes(preview.executionId));
});

test('review actions reuse localhost session/Origin checks and never accept arbitrary path fields',async t=>{
 const f=await fixture(t),record=await f.saveRecord(),viewer=await createReviewViewer({onRequestRecords:(body,jobs)=>f.records.handle(body,jobs)});t.after(()=>viewer.close());const u=new URL(viewer.url),token=new URLSearchParams(u.hash.slice(1)).get('view');
 const req=(body,headers={})=>fetch(u.origin+'/api/request-records',{method:'POST',headers:{Authorization:'Bearer '+token,Origin:u.origin,'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
 const body={action:'review-preview',recordId:record.id,recordVersion:1,selection:operation()};assert.equal((await req(body,{Authorization:''})).status,401);assert.equal((await req(body,{Origin:'https://example.invalid'})).status,403);assert.equal((await req({...body,path:'C:/escape'})).status,409);
 const response=await req(body);assert.equal(response.status,200);const preview=await response.json();assert.equal((await req({action:'review-start',executionId:preview.executionId,confirmationId:preview.confirmationId,confirmed:true})).status,200);assert.equal(f.apiCalls.length,0);assert.deepEqual(await readdir(f.output),[]);
});
