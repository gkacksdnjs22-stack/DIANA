import {approvedRequest as approveRequest} from './helpers/phone-pair.mjs';
const approvedRequest=(request,options)=>approveRequest(request,options,AGENT);
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { createControlServer } from '../lib/control.mjs';

const USER='u'.repeat(40),AGENT='a'.repeat(40),GATEWAY='g'.repeat(40);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const source={id:'1'.repeat(64),sha256:'2'.repeat(64),filename:'보고서.txt',bytes:100,modifiedAt:'2026-10-22T00:00:00.000Z',excerpt:'2026년 보고서'};
async function fixture(t){
  let time=Date.parse('2026-10-22T00:00:00Z');const parent=resolve(import.meta.dirname,'../.local');await mkdir(parent,{recursive:true});const dir=await mkdtemp(join(parent,'test-overnight-'));
  const server=createControlServer({allowLegacyPlaintextTransfers:true,userToken:USER,agentToken:AGENT,gatewayToken:GATEWAY,transferDir:join(dir,'transfers'),now:()=>time});
  server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));assert(dir.startsWith(parent+sep));await rm(dir,{recursive:true,force:true});});
  const request=async(path,{token=USER,method='GET',body,bytes}={})=>{
    const r=await fetch(base+path,{method,headers:{Authorization:`Bearer ${token}`,...(body?{'Content-Type':'application/json'}:{})},body:bytes|| (body?JSON.stringify(body):undefined)});
    const data=r.headers.get('content-type')?.includes('application/json')?await r.json():Buffer.from(await r.arrayBuffer());return{status:r.status,data};
  };
  const mission=(extra={})=>({requestId:randomUUID(),kind:'overnight',sourceId:source.id,instruction:'원문 근거로 정리하고 발표자료를 만들어줘',criteria:['숫자와 출처를 검토'],startAt:new Date(time+60_000).toISOString(),deadlineAt:new Date(time+3600_000).toISOString(),slideCount:6,delivery:'download',...extra});
  await request('/api/agent/catalog',{method:'POST',token:AGENT,body:{documents:[source]}});
  return{request,mission,advance:ms=>time+=ms,now:()=>new Date(time).toISOString()};
}
async function pair(f){
  const code=(await f.request('/api/phone/pair-code',{method:'POST'})).data.code;
  const result=await approvedRequest(f.request,{token:'',method:'POST',body:{code,deviceName:'테스트 갤럭시'}});assert.equal(result.status,201);return {...result.data,code};
}
async function start(f){const payload=f.mission();const created=await f.request('/api/jobs',{method:'POST',body:payload});assert.equal(created.status,201);f.advance(60_000);assert.equal((await f.request('/api/agent/next',{token:AGENT})).data.job.action,'overnight');return payload.requestId;}
function artifacts(){
  return [
    {filename:'보고서.md',mime:'text/markdown',buffer:Buffer.from('# 보고서\n근거 확인')},
    {filename:'보고서.hwpx',mime:'application/vnd.hancom.hwpx',buffer:Buffer.from('fake HWPX bytes for protocol integrity tests only')},
    {filename:'보고서.pdf',mime:'application/pdf',buffer:Buffer.from('%PDF-fake report for protocol integrity tests only')},
    {filename:'발표자료.pptx',mime:'application/vnd.openxmlformats-officedocument.presentationml.presentation',buffer:Buffer.from('fake office bytes for protocol integrity tests only')},
    {filename:'발표자료.pdf',mime:'application/pdf',buffer:Buffer.from('%PDF-fake slides for protocol integrity tests only')},
  ].map(a=>({...a,id:hash(a.buffer),sha256:hash(a.buffer),bytes:a.buffer.length}));
}
async function upload(f,id,list=artifacts()){
  const manifest=list.map(({buffer,...a})=>a);assert.equal((await f.request(`/api/agent/jobs/${id}/artifacts`,{token:AGENT,method:'POST',body:{artifacts:manifest}})).status,201);
  for(const a of list)assert.equal((await f.request(`/api/agent/jobs/${id}/artifacts/${a.id}`,{token:AGENT,method:'POST',bytes:a.buffer})).status,200);
  return list;
}

test('a scheduled mission freezes the source and is not claimed or woken early',async t=>{
  const f=await fixture(t),payload=f.mission();assert.equal((await f.request('/api/jobs',{method:'POST',body:payload})).status,201);
  assert.equal((await f.request('/api/agent/next',{token:AGENT})).data.job,null);assert.equal((await f.request('/api/gateway/wake',{token:GATEWAY})).data.job,null);
  await f.request('/api/agent/catalog',{token:AGENT,method:'POST',body:{documents:[{...source,id:'3'.repeat(64),sha256:'4'.repeat(64)}]}});
  assert.equal((await f.request('/api/jobs',{method:'POST',body:payload})).data.duplicate,true);
  f.advance(60_000);assert.equal((await f.request('/api/gateway/wake',{token:GATEWAY})).data.job.id,payload.requestId);
  const job=(await f.request('/api/agent/next',{token:AGENT})).data.job;assert.equal(job.source.sha256,source.sha256);assert.equal(job.sourceId,source.id);
});
test('unresolved source, impossible deadline and unsupported overnight email are refused',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request('/api/jobs',{method:'POST',body:f.mission({sourceId:'9'.repeat(64)})})).status,409);
  assert.equal((await f.request('/api/jobs',{method:'POST',body:f.mission({deadlineAt:f.now()})})).status,400);
  assert.equal((await f.request('/api/jobs',{method:'POST',body:f.mission({delivery:'both'})})).status,400);
});
test('pairing is one-time, expiring and phone credentials cannot enroll other phones or impersonate PC',async t=>{
  const f=await fixture(t),phone=await pair(f);
  assert.equal((await f.request('/api/jobs',{token:phone.phoneToken})).status,200);
  assert.equal((await f.request('/api/agent/next',{token:phone.phoneToken})).status,401);
  assert.equal((await f.request('/api/phone/pair-code',{token:phone.phoneToken,method:'POST'})).status,401);
  assert.equal((await approvedRequest(f.request,{method:'POST',token:'',body:{code:phone.code,deviceName:'추가 기기'}})).status,401);
  const other=(await f.request('/api/phone/pair-code',{method:'POST'})).data.code;f.advance(5*60_000);
  assert.equal((await approvedRequest(f.request,{token:'',method:'POST',body:{code:other,deviceName:'만료기기'}})).status,401);
  await f.request(`/api/phone/devices/${phone.phoneId}`,{method:'DELETE'});assert.equal((await f.request('/api/jobs',{token:phone.phoneToken})).status,401);
});
test('partial output cannot become a final result; phone acknowledges every hash after publication',async t=>{
  const f=await fixture(t),phone=await pair(f),id=await start(f),list=artifacts(),manifest=list.map(({buffer,...a})=>a);
  const prefix=`/api/agent/jobs/${id}`;
  await f.request(prefix+'/artifacts',{token:AGENT,method:'POST',body:{artifacts:manifest}});
  assert.equal((await f.request(prefix+'/artifacts/'+list[0].id,{token:AGENT,method:'POST',bytes:Buffer.from('corrupt')})).status,409);
  assert.equal((await f.request(prefix+'/result',{token:AGENT,method:'POST',body:{status:'download_ready'}})).status,409);
  assert.equal((await f.request('/api/jobs',{token:phone.phoneToken})).data.jobs[0].artifacts.length,0);
  for(const a of list)await f.request(prefix+'/artifacts/'+a.id,{token:AGENT,method:'POST',bytes:a.buffer});
  assert.equal((await f.request(prefix+'/result',{token:AGENT,method:'POST',body:{status:'download_ready'}})).status,200);
  let job=(await f.request('/api/jobs')).data.jobs[0];assert.equal(job.phoneSavedAt,undefined);assert.equal(job._artifactManifest,undefined);
  const receipt={savedAt:f.now(),artifacts:manifest.map(({id,sha256})=>({id,sha256}))};
  assert.equal((await f.request(`/api/phone/jobs/${id}/received`,{method:'POST',body:receipt})).status,403);
  assert.equal((await f.request(`/api/phone/jobs/${id}/received`,{token:phone.phoneToken,method:'POST',body:{...receipt,artifacts:[receipt.artifacts[0]]}})).status,409);
  const file=await f.request(`/api/jobs/${id}/artifacts/${list[1].id}`,{token:phone.phoneToken});assert.equal(file.status,200);assert.equal(hash(file.data),list[1].sha256);
  assert.equal((await f.request(`/api/phone/jobs/${id}/received`,{token:phone.phoneToken,method:'POST',body:receipt})).status,200);
  job=(await f.request('/api/jobs')).data.jobs[0];assert.equal(job.phoneSavedAt,f.now());
});
test('server deadline prevents late finalization and the phone cannot download unfinished files',async t=>{
  const f=await fixture(t),id=await start(f),list=await upload(f,id);f.advance(3600_000);
  assert.equal((await f.request(`/api/agent/jobs/${id}/result`,{token:AGENT,method:'POST',body:{status:'download_ready'}})).status,409);
  const job=(await f.request('/api/jobs')).data.jobs[0];assert.equal(job.state,'deadline_exceeded');assert.deepEqual(job.artifacts,[]);
  assert.equal((await f.request(`/api/jobs/${id}/artifacts/${list[0].id}`)).status,409);
  assert.equal((await f.request('/api/agent/next',{token:AGENT})).data.job,null);
});
test('artifact manifest is immutable and traversal or active content cannot be published',async t=>{
  const f=await fixture(t),id=await start(f),list=artifacts().map(({buffer,...a})=>a),path=`/api/agent/jobs/${id}/artifacts`;
  assert.equal((await f.request(path,{token:AGENT,method:'POST',body:{artifacts:[{...list[0],filename:'../秘密.md'},list[1]]}})).status,400);
  assert.equal((await f.request(path,{token:AGENT,method:'POST',body:{artifacts:[{...list[0],filename:'x.html',mime:'text/html'},list[1]]}})).status,400);
  assert.equal((await f.request(path,{token:AGENT,method:'POST',body:{artifacts:list}})).status,201);
  assert.equal((await f.request(path,{token:AGENT,method:'POST',body:{artifacts:[{...list[0],filename:'다른결과.md'},list[1]]}})).status,409);
});

test('incomplete converted output set cannot be marked ready',async t=>{
  const f=await fixture(t),id=await start(f),list=artifacts().slice(0,4),prefix=`/api/agent/jobs/${id}`;
  const manifest=list.map(({buffer,...a})=>a);
  assert.equal((await f.request(prefix+'/artifacts',{token:AGENT,method:'POST',body:{artifacts:manifest}})).status,201);
  for(const a of list)assert.equal((await f.request(`${prefix}/artifacts/${a.id}`,{token:AGENT,method:'POST',bytes:a.buffer})).status,200);
  assert.equal((await f.request(prefix+'/result',{token:AGENT,method:'POST',body:{status:'download_ready'}})).status,409);
});
