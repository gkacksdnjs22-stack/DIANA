import test from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {randomUUID} from 'node:crypto';
import {createReviewViewer} from '../financial-documents/review-viewer.mjs';
import {openReviewWindow} from '../financial-documents/worker-cli.mjs';
import {recheckView} from '../financial-documents/review-ui/recheck-view.mjs';

async function fixture(t,options={}){const view=await createReviewViewer(options);t.after(()=>view.close());const url=new URL(view.url),token=new URLSearchParams(url.hash.slice(1)).get('view');return{view,base:url.origin,token,read:()=>fetch(url.origin+'/api/view',{headers:{Authorization:'Bearer '+token}}),post:body=>fetch(url.origin+'/api/local-action',{method:'POST',headers:{Authorization:'Bearer '+token,Origin:url.origin,'Content-Type':'application/json'},body:JSON.stringify(body)})};}
function reviewJob(f){const id=randomUUID();f.view.accept({type:'job',job:{id,state:'PC_REVIEW_REQUIRED'},label:'가상 검토',phase:'review',approvalReady:true,approvalExpires:Date.now()+300000});f.view.accept({type:'review',requestId:id,review:{before:'원문',after:'수정안'},documents:[]});return id;}
test('core diagnostic responses and empty review-shaped objects never render as completed',()=>{
 for(const response of [{status:'ACTION_REQUIRED',reason:'UNRESOLVED_LABEL_REQUIRED'},
   {status:'ACTION_REQUIRED',reason:'UNRESOLVED_LABEL_REQUIRED',items:[],body:'',reviewComplete:false},
   {status:'READY',reason:'REVIEW_RESULT',items:[],body:'',reviewComplete:true},
   {status:'FAILED',reason:'CONTENT_CHANGED'}]){
  const view=recheckView(response);assert.equal(view.state,'failed');assert.match(view.title,/완료하지 못/);assert.ok(!view.note.includes('충족 0'));assert.equal(view.body,'');assert.deepEqual(view.items,[]);
 }
 const diagnostic=recheckView({status:'ACTION_REQUIRED',reason:'UNRESOLVED_LABEL_REQUIRED'});assert.equal(diagnostic.reason,'UNRESOLVED_LABEL_REQUIRED');assert.match(diagnostic.note,/지침/);
});
test('genuine complete and incomplete saved reviews retain their distinct UI states',()=>{
 const normal={status:'ACTION_REQUIRED',reason:'REVIEW_RESULT',reviewComplete:false,items:[{status:'SATISFIED'},{status:'MISSING_NO_EVIDENCE'}],body:'검증된 본문',checkedAt:'2026-10-27T00:00:00Z'};
 assert.equal(recheckView(null).state,'idle');const incomplete=recheckView(normal);assert.equal(incomplete.state,'completed');assert.match(incomplete.note,/충족 1 \/ 전체 2/);assert.equal(incomplete.body,'검증된 본문');
 const complete=recheckView({...normal,status:'READY',reviewComplete:true,items:[{status:'SATISFIED'}]});assert.equal(complete.state,'completed');assert.match(complete.title,/모든 검토 항목/);
});
test('recheck failure replaces previous success and preserves only its fixed diagnostic code',async t=>{
 const f=await fixture(t,{onRecheck:async()=>{throw Object.assign(Error('PRIVATE_DIAGNOSTIC_TEXT'),{code:'UNRESOLVED_LABEL_REQUIRED',coreStatus:'ACTION_REQUIRED'});}}),id=reviewJob(f);
 f.view.accept({type:'result',requestId:id,result:{saved:true,storageVerified:true}});f.view.accept({type:'recheck',requestId:id,recheck:{status:'READY',reason:'REVIEW_RESULT',items:[{status:'SATISFIED'}],body:'OLD_BODY',reviewComplete:true}});
 const e=(await(await f.read()).json()).jobs[0],response=await f.post({requestId:id,viewId:e.resultId,action:'recheck'});assert.equal(response.status,409);
 const result=await response.json();assert.equal(result.review.reason,'UNRESOLVED_LABEL_REQUIRED');assert.equal(result.review.coreStatus,'ACTION_REQUIRED');assert.ok(!JSON.stringify(result).includes('PRIVATE_DIAGNOSTIC_TEXT'));
 const current=(await(await f.read()).json()).jobs[0].recheck;assert.equal(current.status,'FAILED');assert.equal(current.items,undefined);assert.equal(current.body,undefined);assert.equal(recheckView(current).state,'failed');
});
test('only same-origin authenticated decisions for the exact current review reach the local bridge',async t=>{
 const calls=[],f=await fixture(t,{onCommand:async(...args)=>calls.push(args)}),id=reviewJob(f),entry=(await(await f.read()).json()).jobs[0],body={requestId:id,viewId:entry.reviewId,action:'approve'};
 for(const [headers,expected]of [[{'Content-Type':'application/json'},401],[{Authorization:'Bearer '+f.token,'Content-Type':'application/json'},403],[{Authorization:'Bearer '+f.token,Origin:'https://example.invalid','Content-Type':'application/json'},403]])assert.equal((await fetch(f.base+'/api/local-action',{method:'POST',headers,body:JSON.stringify(body)})).status,expected);
 assert.equal((await f.post({...body,outputFile:'C:/arbitrary'})).status,400);assert.equal((await f.post({...body,viewId:randomUUID()})).status,409);assert.equal(calls.length,0);
 assert.equal((await f.post(body)).status,200);assert.deepEqual(calls,[['approve',id]]);assert.equal((await f.post(body)).status,409);assert.equal(calls.length,1);
});
test('busy decisions, expired reviews and replacement review tickets cannot be reused',async t=>{
 let release,started;const startedPromise=new Promise(r=>started=r),hold=new Promise(r=>release=r),f=await fixture(t,{onCommand:async()=>{started();await hold;}}),id=reviewJob(f),entry=(await(await f.read()).json()).jobs[0],body={requestId:id,viewId:entry.reviewId,action:'reject'};
 const first=f.post(body);await startedPromise;assert.equal((await f.post(body)).status,409);release();assert.equal((await first).status,200);
 f.view.accept({type:'review',requestId:id,review:{before:'old',after:'new'},documents:[]});f.view.accept({type:'job',job:{id,state:'PC_REVIEW_REQUIRED'},approvalReady:true,approvalExpires:Date.now()-1});assert.equal((await f.post(body)).status,409);
 const next=(await(await f.read()).json()).jobs[0];assert.equal((await f.post({...body,viewId:next.reviewId})).status,409);
});
test('a decision body arriving after cancellation rechecks the latest job',async t=>{
 let calls=0;const f=await fixture(t,{onCommand:async()=>calls++}),id=reviewJob(f),entry=(await(await f.read()).json()).jobs[0],body=JSON.stringify({requestId:id,viewId:entry.reviewId,action:'approve'});
 let req;const done=new Promise((resolve,reject)=>{req=request(f.base+'/api/local-action',{method:'POST',headers:{Authorization:'Bearer '+f.token,Origin:f.base,'Content-Type':'application/json'}},res=>{res.resume();res.once('end',()=>resolve(res.statusCode));});req.once('error',reject);req.write(body.slice(0,1));});
 f.view.accept({type:'job',job:{id,state:'CANCELLED'},approvalReady:false});req.end(body.slice(1));assert.equal(await done,409);assert.equal(calls,0);
});
test('saved review bridge is bound to a verified saved entry and accepts no path',async t=>{
 const calls=[],f=await fixture(t,{onRecheck:async id=>calls.push(id)}),id=reviewJob(f);f.view.accept({type:'result',requestId:id,result:{saved:true,storageVerified:true,outputFile:'LOCAL_ONLY'}});const e=(await(await f.read()).json()).jobs[0],body={requestId:id,viewId:e.resultId,action:'recheck'};
 assert.equal((await f.post({...body,path:'../escape'})).status,400);assert.equal((await f.post({...body,viewId:e.reviewId})).status,409);assert.equal((await f.post(body)).status,200);assert.deepEqual(calls,[id]);
});
test('local review view requires its ephemeral session and rejects writes and foreign origins',async t=>{
 const f=await fixture(t);assert.equal(new URL(f.base).hostname,'127.0.0.1');assert.equal((await fetch(f.base+'/api/view')).status,401);
 for(const route of ['/api/approve','/api/execute','/api/view'])assert.equal((await fetch(f.base+route,{method:'POST',headers:{Authorization:'Bearer '+f.token}})).status,405);
 for(const headers of [{Origin:'https://example.invalid'},{'Sec-Fetch-Site':'cross-site'},{Host:'localhost:'+new URL(f.base).port}]){
  const status=await new Promise((resolve,reject)=>{const r=request(f.base+'/api/view',{headers:{Authorization:'Bearer '+f.token,...headers}},res=>{res.resume();res.once('end',()=>resolve(res.statusCode));});r.once('error',reject);r.end();});assert.equal(status,403,JSON.stringify(headers));
 }
 assert.equal((await fetch(f.base+'/api/view?token='+f.token)).status,404);
 const r=await f.read();assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(r.headers.get('access-control-allow-origin'),null);assert.match(r.headers.get('content-security-policy'),/frame-ancestors 'none'/);const data=await r.json();assert.deepEqual(data.jobs,[]);assert.deepEqual(data.capabilities,{approve:false,recheck:false});
});
test('local view preserves only eight session snapshots and cannot mutate worker-owned data',async t=>{
 const f=await fixture(t);let last;for(let i=0;i<10;i++){last={type:'job',job:{id:randomUUID(),state:'PROCESSING'},label:'가상 '+i,phase:'preparing',approvalReady:false};f.view.accept(last);}
 f.view.accept({type:'review',requestId:last.job.id,documents:[{id:'TEST',content:'<script>PRIVATE_LOCAL_TEXT</script>'}],review:{before:'원문',after:'수정'}});last.label='MUTATED';
 const r=await f.read(),data=await r.json();assert.equal(data.jobs.length,8);assert.equal(data.jobs[0].label,'가상 9');assert.equal(data.jobs[0].documents[0].content,'<script>PRIVATE_LOCAL_TEXT</script>');assert.equal(data.jobs[0].approvalReady,false);
 f.view.accept({type:'connection',connected:true});assert.equal((await(await f.read()).json()).connection.connected,true);
 const page=await(await fetch(f.base)).text();assert.ok(!page.includes('PRIVATE_LOCAL_TEXT'));assert.ok(!page.includes(f.token));
 assert.match(page,/<script type="module"/);const module=await fetch(f.base+'/recheck-view.mjs');assert.equal(module.status,200);assert.match(module.headers.get('content-type'),/javascript/);
 const js=await(await fetch(f.base+'/review.js')).text();assert.ok(!js.includes('innerHTML'));assert.ok(!js.includes('eval('));assert.ok(!js.includes('document.write'));assert.ok(!/https?:\/\//.test(js));
});
test('malformed local request URLs are rejected without stopping the viewer',async t=>{
 const f=await fixture(t);const status=await new Promise((resolve,reject)=>{const r=request(f.base,{path:'http://[',headers:{Host:new URL(f.base).host}},res=>{res.resume();res.once('end',()=>resolve(res.statusCode));});r.once('error',reject);r.end();});assert.equal(status,400);assert.equal((await f.read()).status,200);
});
test('browser opener accepts only generated loopback view URLs and never invokes a shell',()=>{
 const calls=[];const launch=(...args)=>{calls.push(args);return{once(){},unref(){}};};
 for(const url of ['https://example.invalid','http://127.0.0.1:1234/#view=bad','file:///C:/test','http://127.0.0.1:1234/#view='+'a'.repeat(64)+'&run'])assert.throws(()=>openReviewWindow(url,launch));
 openReviewWindow('http://127.0.0.1:1234/#view='+'a'.repeat(64),launch);
 if(process.platform==='win32'){assert.equal(calls.length,1);assert.equal(calls[0][0],'rundll32.exe');assert.equal(calls[0][2].shell,undefined);assert.equal(calls[0][2].windowsHide,true);}else assert.equal(calls.length,0);
});
