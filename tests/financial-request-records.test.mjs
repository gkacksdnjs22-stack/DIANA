import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdtemp,mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {RequestRecords,snapshotHash,emptyConfirmation,checkConfirmation} from '../financial-documents/request-records.mjs';
import {confirmationGate} from '../financial-documents/review-ui/request-records.mjs';
import {createReviewViewer} from '../financial-documents/review-viewer.mjs';

// Isolated synthetic records only; never an evaluation corpus or real approval.
async function fixture(){
 await mkdir('.local',{recursive:true});const root=await mkdtemp(path.resolve('.local/request-record-test-')),state=path.join(root,'state');await mkdir(state);
 let context={revision:0,documents:[{id:'A',display_name:'가상 문서 A',aliases:[],roles:['review','source'],version:'1',classification:'synthetic'},{id:'B',display_name:'가상 문서 B',aliases:['가상 B'],roles:['source'],version:'1',classification:'synthetic'},{id:'G',display_name:'가상 지침',aliases:[],roles:['guideline'],version:'1',classification:'synthetic'}],tasks:[],coverage:{scope:'synthetic_fixture_registered_candidates',complete:true,aliases:'fixture',roles:'fixture'}};
 const options={stateDir:state,protectedRoots:[path.join(root,'documents'),path.join(root,'output')],withContext:async fn=>fn(structuredClone(context)),appVersion:'synthetic-test'};
 let store=new RequestRecords(options);
 return{root,state,get store(){return store;},get context(){return context;},set context(v){context=v;},restart(){store=new RequestRecords(options);},async draft(overrides={}){return{action:'preview',id:randomUUID(),baseVersion:0,request:'📎 가상 문서 A와 가상 B를 확인해 주세요.',contextHash:snapshotHash(context),selection:{taskId:null,format:null,action:null},confirmation:emptyConfirmation(),dataOrigin:'synthetic',jobId:null,...overrides};}};
}
const save=(f,b,p)=>f.store.handle({action:'save',id:b.id,previewId:p.previewId,confirmationHash:p.confirmationHash});
test('preview does not persist; unknown/none remain different; no fabricated UTF16 gold',async()=>{
 const f=await fixture(),b=await f.draft();b.confirmation.target={state:'none',ids:[]};const p=await f.store.handle(b);
 assert.deepEqual((await f.store.handle({action:'list'})).records,[]);assert.equal(p.snapshot.raw_user_confirmation.target.state,'none');assert.equal(p.snapshot.raw_user_confirmation.guideline.state,'unknown');assert.equal(p.snapshot.contract_annotation.utf16_mentions,null);assert.equal(p.snapshot.contract_annotation.output,null);assert.equal(p.snapshot.input.request,b.request);assert.equal(p.snapshot.input.candidates.length,3);assert.equal(p.snapshot.input_snapshot_hash,snapshotHash(p.snapshot.input));assert.equal(p.snapshot.annotation_provenance,'user_self_confirmation');
 await save(f,b,p);assert.equal((await f.store.handle({action:'list'})).records.length,1);
});
test('candidate/context revision invalidates pending confirmation; no stale save',async()=>{const f=await fixture(),b=await f.draft(),p=await f.store.handle(b);f.context.documents[1].display_name='변경된 가상 이름';await assert.rejects(()=>save(f,b,p),{code:'RECORD_CONTEXT_CHANGED'});await assert.rejects(()=>f.store.handle(b),{code:'RECORD_CONTEXT_CHANGED'});assert.equal((await f.store.handle({action:'list'})).records.length,0);});
test('browser confirmation generation invalidates request/settings/selection edits and stale async previews',()=>{const gate=confirmationGate();const at=gate.capture();assert.equal(gate.accept(at,{id:1}),true);gate.change();assert.equal(gate.value,null);assert.equal(gate.accept(at,{id:2}),false);});
test('new request/settings preview revokes the earlier confirmation for the same record',async()=>{const f=await fixture(),b=await f.draft(),p=await f.store.handle(b);const next=await f.store.handle({...b,request:'변경된 가상 요청',selection:{taskId:null,format:'txt',action:null}});await assert.rejects(()=>save(f,b,p),{code:'RECORD_CONFIRMATION_EXPIRED'});await save(f,b,next);});
test('save concurrent retry, restart exact retry and historical correction append versions',async()=>{
 const f=await fixture(),b=await f.draft(),p=await f.store.handle(b);const results=await Promise.all([save(f,b,p),save(f,b,p)]);assert.equal(results.filter(x=>x.duplicate).length,1);f.restart();assert.equal((await save(f,b,p)).duplicate,true);
 f.context.documents=[];f.context.revision++;const correction={...b,baseVersion:1};correction.confirmation={...emptyConfirmation(),intent:'question'};const edit=await f.store.handle(correction);await save(f,correction,edit);
 const record=await f.store.handle({action:'detail',id:b.id});assert.equal(record.versions.length,2);assert.deepEqual(record.versions[0].input,record.versions[1].input);assert.equal(record.versions[1].input.candidates.length,3);assert.equal(record.versions[0].raw_user_confirmation.intent,'uncertain');assert.equal(record.versions[1].raw_user_confirmation.intent,'question');assert.equal(record.versions[1].previous_hash,snapshotHash(record.versions[0]));
 await assert.rejects(()=>f.store.handle({...correction,baseVersion:2,request:'다른 요청'}),{code:'RECORD_INPUT_IMMUTABLE'});
});
test('delete removes all contents, survives restart and forbids resurrection',async()=>{const f=await fixture(),b=await f.draft(),p=await f.store.handle(b);await save(f,b,p);await f.store.handle({action:'delete',id:b.id});f.restart();assert.deepEqual((await f.store.handle({action:'list'})).records,[]);await f.store.handle({action:'delete',id:b.id});await assert.rejects(()=>save(f,b,p),{code:'RECORD_DELETED'});const files=await readdir(f.store.directory);assert.deepEqual(files,[b.id+'-deleted.json']);assert.ok(!(await readFile(path.join(f.store.directory,files[0]),'utf8')).includes(b.request));});
test('arbitrary paths, unknown candidates, permission mismatch, surrogate splits and secrets rejected',async()=>{const f=await fixture(),b=await f.draft();await assert.rejects(()=>f.store.handle({...b,path:'C:/escape.json'}));await assert.rejects(()=>f.store.handle({action:'detail',id:'../escape'}));for(const text of ['\ud83d','api_key=SECRET','C:\\private\\file.txt','Bearer abcdef'])await assert.rejects(()=>f.store.handle({...b,request:text}));const raw=emptyConfirmation();raw.target={state:'selected',ids:['G']};assert.throws(()=>checkConfirmation(raw,f.context.documents));raw.target={state:'selected',ids:['UNKNOWN']};assert.throws(()=>checkConfirmation(raw,f.context.documents));});
test('write conflict and corrupt storage are failures, not successful saves',async()=>{const f=await fixture(),b=await f.draft(),p=await f.store.handle(b);await writeFile(path.join(f.store.directory,b.id+'-v1.json'),'broken');await assert.rejects(()=>save(f,b,p));});
test('record folder overlap rejected and no write outside dedicated folder',async()=>{const f=await fixture(),s=new RequestRecords({stateDir:f.state,protectedRoots:[f.root],withContext:async fn=>fn(f.context)});await assert.rejects(()=>s.handle({action:'list'}),{code:'RECORD_STORAGE_BOUNDARY'});});
test('authenticated localhost API, no financial commands or data in normal view',async t=>{
 const f=await fixture();let approvals=0,rechecks=0;const viewer=await createReviewViewer({onCommand:()=>{approvals++;},onRecheck:()=>{rechecks++;},onRequestRecords:(b,j)=>f.store.handle(b,j)});t.after(()=>viewer.close());const u=new URL(viewer.url),token=new URLSearchParams(u.hash.slice(1)).get('view');
 const req=(body,headers={})=>fetch(u.origin+'/api/request-records',{method:'POST',headers:{Authorization:'Bearer '+token,Origin:u.origin,'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
 assert.equal((await req({action:'list'},{Authorization:''})).status,401);assert.equal((await req({action:'list'},{Origin:'https://example.invalid'})).status,403);assert.equal((await req({action:'list'},{Origin:''})).status,403);assert.equal((await req({action:'list'},{'Sec-Fetch-Site':'cross-site'})).status,403);
 assert.equal((await req({action:'list',path:'C:/escape'})).status,409);assert.equal((await req({action:'preview',request:'x'.repeat(40000)})).status,409);
 const b=await f.draft(),preview=await(await req(b)).json();const response=await req({action:'save',id:b.id,previewId:preview.previewId,confirmationHash:preview.confirmationHash});assert.equal(response.status,200);assert.equal(approvals,0);assert.equal(rechecks,0);
 const v=await fetch(u.origin+'/api/view',{headers:{Authorization:'Bearer '+token}});assert.ok(!(await v.text()).includes(b.request));assert.equal((await req({action:'detail',id:b.id})).status,200);
});
