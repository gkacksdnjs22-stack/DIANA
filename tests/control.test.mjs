import {approvedRequest as approveRequest} from './helpers/phone-pair.mjs';
const approvedRequest=(request,options)=>approveRequest(request,options,AGENT);
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { randomUUID,createHash } from 'node:crypto';
import { mkdir,mkdtemp,rm,writeFile } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { createControlServer } from '../lib/control.mjs';
import {runOnce as secureRunOnce} from '../agent/run.mjs';
const testCipher={async encrypt(b){return b;},async decrypt(b){return b;}};
const runOnce=opts=>secureRunOnce({...opts,cipher:testCipher});

const root=resolve(import.meta.dirname,'..');
const USER='user-'+ 'u'.repeat(40), AGENT='agent-'+ 'a'.repeat(40), GATEWAY='gateway-'+ 'g'.repeat(40);
async function fixture(t){
  const tempParent=join(root,'.local');await mkdir(tempParent,{recursive:true});
  const dir=await mkdtemp(join(tempParent,'test-control-'));
  const server=createControlServer({allowLegacyPlaintextTransfers:true,userToken:USER,agentToken:AGENT,gatewayToken:GATEWAY,transferDir:join(dir,'transfers')});
  server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));assert(dir.startsWith(tempParent+'\\')||dir.startsWith(tempParent+'/'));await rm(dir,{recursive:true,force:true});});
  const request=async(route,{token=USER,method='GET',body,headers={}}={})=>{
    const res=await fetch(base+route,{method,headers:{Authorization:`Bearer ${token}`,...(body!==undefined?{'Content-Type':'application/json'}:{}),...headers},body:body!==undefined?JSON.stringify(body):undefined});
    return {status:res.status,data:await res.json()};
  };
  return {dir,server,base,request,env:{API_BASE_URL:base,AGENT_TOKEN:AGENT,DEVICE_ID:'home-pc',DOCUMENT_ROOT:join(root,'sample-documents'),AI_MODE:'lexical',MAIL_MODE:'dry-run',MAIL_FROM:'demo@example.com'}};
}
function newJob(extra={}){return {requestId:randomUUID(),query:'가람상사 최종본',recipient:'review@example.com',...extra};}

async function deferredWake(t,f,id){
  const marker=randomUUID();let ready,request;
  const started=new Promise(resolve=>{ready=resolve;});
  const listener=req=>{
    if(req.headers['x-test-deferred']!==marker)return;
    f.server.removeListener('request',listener);
    req.once('readable',()=>setImmediate(ready));
  };
  f.server.on('request',listener);
  const result=new Promise((resolve,reject)=>{
    request=httpRequest(f.base+'/api/gateway/wake/'+id,{method:'POST',headers:{Authorization:'Bearer '+GATEWAY,'Content-Type':'application/json','X-Test-Deferred':marker}},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));
      res.on('end',()=>{try{resolve({status:res.statusCode,data:JSON.parse(Buffer.concat(chunks))});}catch(e){reject(e);}});
    });
    request.on('error',reject);request.write('{');
  });
  result.catch(()=>{});
  t.after(()=>{f.server.removeListener('request',listener);request.destroy();});
  await started;
  return {finish:status=>{request.end(JSON.stringify({status}).slice(1));return result;}};
}

test('role tokens are separate; cross-origin requests cannot operate a PC',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request('/api/jobs',{token:AGENT})).status,401);
  assert.equal((await f.request('/api/agent/next',{token:USER})).status,401);
  assert.equal((await f.request('/api/jobs',{headers:{Origin:'https://unrelated.example'}})).status,403);
  assert.equal((await f.request('/api/jobs',{method:'POST',body:newJob({recipient:'a@example.com\r\nBcc:other@example.com'})})).status,400);
});
test('repeating a request reuses the same job; recipient changes cannot reuse its ID',async t=>{
  const f=await fixture(t);const body=newJob();
  assert.equal((await f.request('/api/jobs',{method:'POST',body})).status,201);
  const duplicate=await f.request('/api/jobs',{method:'POST',body});assert.equal(duplicate.status,200);assert.equal(duplicate.data.duplicate,true);
  assert.equal((await f.request('/api/jobs',{method:'POST',body:{...body,recipient:'different@example.com'}})).status,409);
  assert.equal((await f.request('/api/jobs')).data.jobs.length,1);
});
test('wake gateway sees only device/job identifiers and signal acknowledgement never pretends the PC is online',async t=>{
  const f=await fixture(t);const body=newJob();await f.request('/api/jobs',{method:'POST',body});
  const wake=await f.request('/api/gateway/wake',{token:GATEWAY});assert.deepEqual(Object.keys(wake.data.job).sort(),['deviceId','id']);
  await f.request(`/api/gateway/wake/${body.requestId}`,{method:'POST',token:GATEWAY,body:{status:'signaled'}});
  assert.equal((await f.request('/api/jobs')).data.jobs[0].state,'waiting_pc');
});
for(const state of ['searching','failed'])test('delayed wake acknowledgement preserves '+state+' and current agent events',{timeout:10000},async t=>{
  const f=await fixture(t),body=newJob();
  await f.request('/api/jobs',{method:'POST',body});
  const pending=await deferredWake(t,f,body.requestId);
  await f.request('/api/agent/next',{token:AGENT});
  if(state==='failed')await f.request('/api/agent/jobs/'+body.requestId+'/candidates',{method:'POST',token:AGENT,body:{mode:'lexical',candidates:[]}});
  const before=(await f.request('/api/jobs')).data.jobs[0];
  assert.equal(before.state,state);
  assert.equal((await pending.finish('signaled')).status,200);
  const after=(await f.request('/api/jobs')).data.jobs[0];
  assert.equal(after.state,state);assert.equal(after.wakeStatus,'signaled');
  assert.deepEqual(after.events.slice(0,-1),before.events);
  assert.equal(after.mode,before.mode);assert.deepEqual(after.candidates,before.candidates);
  if(state==='failed')assert.equal((await f.request('/api/agent/next',{token:AGENT})).data.job,null);
});
test('delayed duplicate wake acknowledgement keeps the first recorded result',{timeout:10000},async t=>{
  const f=await fixture(t),body=newJob();
  await f.request('/api/jobs',{method:'POST',body});
  const pending=await deferredWake(t,f,body.requestId);
  assert.equal((await f.request('/api/gateway/wake/'+body.requestId,{method:'POST',token:GATEWAY,body:{status:'signaled'}})).status,200);
  const before=(await f.request('/api/jobs')).data.jobs[0];
  const duplicate=await pending.finish('failed');
  assert.equal(duplicate.status,200);assert.equal(duplicate.data.duplicate,true);
  assert.deepEqual((await f.request('/api/jobs')).data.jobs[0],before);
});
test('lost PC claim response can be recovered without changing the job ID',async t=>{
  const f=await fixture(t);const body=newJob();await f.request('/api/jobs',{method:'POST',body});
  const first=await f.request('/api/agent/next',{token:AGENT});const again=await f.request('/api/agent/next',{token:AGENT});
  assert.equal(first.data.job.id,again.data.job.id);assert.equal(again.data.job.action,'search');
});
test('real local agent finds document content and prepares authenticated phone download without sending mail',async t=>{
  const f=await fixture(t);const body=newJob({delivery:'download',recipient:'',autoSend:true});await f.request('/api/jobs',{method:'POST',body});
  const search=await runOnce({env:f.env,stateDir:join(f.dir,'agent')});assert.equal(search.mode,'lexical');
  let job=(await f.request('/api/jobs')).data.jobs[0];assert.equal(job.state,'needs_selection','keyword search must never pretend to satisfy AI autosend confidence');
  const selected=job.candidates.find(c=>c.filename==='資料-002.txt'||c.filename==='자료-002.txt');assert(selected);
  await f.request(`/api/jobs/${job.id}/selection`,{method:'POST',body:{candidateId:selected.id,approve:true}});
  const result=await runOnce({env:f.env,stateDir:join(f.dir,'agent'),mailSender:()=>{throw new Error('phone-only job must not send mail');}});assert.equal(result.status,'download_ready');
  job=(await f.request('/api/jobs')).data.jobs[0];assert.equal(job.state,'download_ready');assert.equal(job.artifact.filename,'자료-002.txt');
  assert.equal((await fetch(`${f.base}/api/jobs/${job.id}/file`)).status,401);
  const received=await fetch(`${f.base}/api/jobs/${job.id}/file`,{headers:{Authorization:`Bearer ${USER}`}});assert.equal(received.status,200);
  const bytes=Buffer.from(await received.arrayBuffer());assert.equal(createHash('sha256').update(bytes).digest('hex'),selected.sha256);assert.match(bytes.toString('utf8'),/最終本|최종본/);
});
test('paired Galaxy can fetch a single search file and acknowledge its verified hash',async t=>{
  const f=await fixture(t);await f.request('/api/jobs',{method:'POST',body:newJob({delivery:'download',recipient:''})});
  await runOnce({env:f.env,stateDir:join(f.dir,'agent')});let job=(await f.request('/api/jobs')).data.jobs[0];
  await f.request(`/api/jobs/${job.id}/selection`,{method:'POST',body:{candidateId:job.candidates[0].id,approve:true}});
  await runOnce({env:f.env,stateDir:join(f.dir,'agent')});job=(await f.request('/api/jobs')).data.jobs[0];
  assert.equal(job.state,'download_ready');assert.equal(job.phoneSavedAt,undefined);
  const code=(await f.request('/api/phone/pair-code',{method:'POST'})).data.code;
  const pair=await approvedRequest(f.request,{method:'POST',token:'',body:{code,deviceName:'테스트 갤럭시'}});
  assert.equal(pair.status,201);const phoneToken=pair.data.phoneToken;
  const file=await fetch(`${f.base}/api/jobs/${job.id}/file`,{headers:{Authorization:`Bearer ${phoneToken}`}});
  assert.equal(file.status,200);
  const bytes=Buffer.from(await file.arrayBuffer());const digest=createHash('sha256').update(bytes).digest('hex');
  assert.equal(digest,job.artifact.sha256);assert.equal(bytes.length,job.artifact.bytes);
  const path=`/api/phone/jobs/${job.id}/received`;
  const receipt={savedAt:new Date().toISOString(),artifacts:[{id:digest,sha256:digest}]};
  assert.equal((await f.request(path,{method:'POST',body:receipt})).status,403,'a web token cannot impersonate a paired phone');
  assert.equal((await f.request(path,{method:'POST',token:phoneToken,body:{...receipt,artifacts:[{id:digest,sha256:'0'.repeat(64)}]}})).status,409);
  assert.equal((await f.request('/api/jobs')).data.jobs[0].phoneSavedAt,undefined,'bad digest cannot mark the job saved');
  const saved=await f.request(path,{method:'POST',token:phoneToken,body:receipt});
  assert.equal(saved.status,200);assert.equal(saved.data.onTime,true);
  job=(await f.request('/api/jobs')).data.jobs[0];assert(job.phoneSavedAt);assert.equal(job.state,'download_ready');
});
test('both delivery retains phone file and creates exactly one dry-run email on the PC',async t=>{
  const f=await fixture(t);const body=newJob({delivery:'both'});await f.request('/api/jobs',{method:'POST',body});
  await runOnce({env:f.env,stateDir:join(f.dir,'agent')});let job=(await f.request('/api/jobs')).data.jobs[0];
  await f.request(`/api/jobs/${job.id}/selection`,{method:'POST',body:{candidateId:job.candidates[0].id,approve:true}});
  const result=await runOnce({env:f.env,stateDir:join(f.dir,'agent')});assert.equal(result.status,'dry_run');
  job=(await f.request('/api/jobs')).data.jobs[0];assert(job.artifact);assert.equal(job.state,'dry_run');
  const code=(await f.request('/api/phone/pair-code',{method:'POST'})).data.code;
  const paired=await approvedRequest(f.request,{method:'POST',token:'',body:{code,deviceName:'테스트 갤럭시'}});
  assert.equal(paired.status,201);
  const digest=job.artifact.sha256;
  const acknowledged=await f.request(`/api/phone/jobs/${job.id}/received`,{method:'POST',token:paired.data.phoneToken,body:{savedAt:new Date().toISOString(),artifacts:[{id:digest,sha256:digest}]}});
  assert.equal(acknowledged.status,200);
  job=(await f.request('/api/jobs')).data.jobs[0];assert(job.phoneSavedAt);assert.equal(job.state,'dry_run','phone receipt must not rewrite the mail result');
  const terminal=await f.request('/api/agent/next',{token:AGENT});assert.equal(terminal.data.job,null);
});

test('edited Python and JSON files can be transferred only with their original extension',async t=>{
  for (const [extension,source] of [['py','def run():\n    return 1\n'],['json','{"run":false}\n']]) {
    const f=await fixture(t);const docs=join(f.dir,'documents');await mkdir(docs);
    const filename=`settings.${extension}`;const sourcePath=join(docs,filename);await writeFile(sourcePath,source);
    const env={...f.env,DOCUMENT_ROOT:docs};const body=newJob({query:'settings',delivery:'download',recipient:'',editInstruction:'정리해 주세요.'});
    await f.request('/api/jobs',{method:'POST',body});
    const stateDir=join(f.dir,'agent');const search=await runOnce({env,stateDir});
    let job=(await f.request('/api/jobs')).data.jobs[0];
    await f.request(`/api/jobs/${job.id}/selection`,{method:'POST',body:{candidateId:search.candidates[0].id,approve:true}});
    const output=Buffer.from(source.replace('1','2').replace('false','true'));
    const result=await runOnce({env,stateDir,artifactPreparer:async request=>{
      assert.equal(request.sourcePath,sourcePath);const directory=join(stateDir,'edited-output');await mkdir(directory,{recursive:true});
      const attachmentPath=join(directory,`settings_수정본.${extension}`);await writeFile(attachmentPath,output);
      return {attachmentPath,attachmentName:`settings_수정본.${extension}`,sha256:createHash('sha256').update(output).digest('hex'),edited:true};
    }});
    assert.equal(result.status,'download_ready');
    job=(await f.request('/api/jobs')).data.jobs[0];assert.equal(job.artifact.filename,`settings_수정본.${extension}`);
    assert.equal(await (await fetch(`${f.base}/api/jobs/${job.id}/file`,{headers:{Authorization:`Bearer ${USER}`}})).text(),output.toString());
  }
});
