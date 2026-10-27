import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, mkdtemp, cp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createControlServer } from '../lib/control.mjs';
import { FinancialWorker, financialTransport } from '../financial-documents/remote-worker.mjs';
import { publicFinanceJob } from '../lib/financial-contract.mjs';

const tokens={userToken:'u'.repeat(40),agentToken:'a'.repeat(40),gatewayToken:'g'.repeat(40)};
const python=process.env.DIANA_TEST_PYTHON || path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/python',process.platform==='win32'?'python.exe':'bin/python');
const privateMarker='PRIVATE_FINANCE_BODY_CANARY_8271';
async function fixture(t,{ttl=300_000}={}){
  const parent=path.resolve('.local');await mkdir(parent,{recursive:true});const root=await mkdtemp(path.join(parent,'financial-mobile-test-'));
  const input=path.join(root,'input'),output=path.join(root,'output'),generic=path.join(root,'generic'),state=path.join(root,'state');
  await cp(path.resolve('financial-documents/fixtures/fund-a'),input,{recursive:true});await mkdir(output);await mkdir(generic);
  await writeFile(path.join(input,'review.md'),(await readFile(path.join(input,'review.md'),'utf8'))+'\n'+privateMarker+'\n');
  const coreConfig=path.join(root,'core.json'),workerConfig=path.join(root,'worker.json');
  const core={schema_version:1,principal:'test-analyst',role:'analyst',readRoots:[input],outputRoot:output,python,write_roles:['analyst'],approval_ttl_ms:ttl,
    documents:[['REVIEW_A','review.md'],['DD_A','due-diligence.txt'],['PE-02','guideline.json']].map(([id,relativePath])=>({id,relativePath,rootIndex:0,version:'1',classification:'synthetic',read_roles:['analyst']}))};
  await writeFile(coreConfig,JSON.stringify(core));
  const task={id:randomUUID(),label:'가상 검토서 보완',actions:['patch','convert','checklist_review'],formats:['md','txt','json'],target_doc:'REVIEW_A',source_ids:['DD_A'],guideline_id:'PE-02',item_ids:['KEY_MAN']};
  const config={schema_version:1,coreConfig,stateDir:state,tasks:[task]};await writeFile(workerConfig,JSON.stringify(config));
  let now=Date.now(),server,base,deviceId='home-pc';const wire=[],consoleOutput=[];
  const dbPath=path.join(root,'control.sqlite');
  const start=async()=>{server=createControlServer({...tokens,deviceId,dbPath,transferDir:path.join(root,'relay'),now:()=>now});server.listen(0,'127.0.0.1');await once(server,'listening');base='http://127.0.0.1:'+server.address().port;};
  const stop=async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));};
  await start();
  let dropState=null;let saveStarts=0;let onGate=null;
  const api=async(route,body)=>{
    if(body?.state==='LOCAL_SAVING')saveStarts++;
    const r=await request(route,{method:'POST',token:tokens.agentToken,body});
    if(r.status>=400)throw Object.assign(Error('CONTROL_REJECTED'),{status:r.status});
    if(body?.state==='LOCAL_SAVING'&&onGate)await onGate();
    if(dropState&&body?.state===dropState){dropState=null;throw Error('TEST_ACK_LOST');}return r.data;
  };
  let worker;
  t.after(async()=>{if(worker)await worker.close();await stop();assert.equal(path.dirname(root),parent);assert.match(path.basename(root),/^financial-mobile-test-/u);await rm(root,{recursive:true,force:true});});
  worker=await FinancialWorker.create({configPath:workerConfig,api,output:s=>consoleOutput.push(s),documentRoot:generic});
  async function request(route,{method='GET',token=tokens.userToken,body,raw}={}){
    const text=raw??(body===undefined?undefined:JSON.stringify(body));
    const res=await fetch(base+route,{method,headers:{Authorization:'Bearer '+token,...(text===undefined?{}:{'Content-Type':'application/json'})},body:text});
    const response=await res.text();wire.push({route,request:text,response});return{status:res.status,data:JSON.parse(response)};
  }
  async function pair(){const code=(await request('/api/phone/pair-code',{method:'POST'})).data.code;return(await request('/api/phone/pair',{method:'POST',token:'',body:{code,deviceName:'Finance test phone'}})).data.phoneToken;}
  const phoneToken=await pair();
  const phone=(route,opts={})=>request(route,{...opts,token:phoneToken});
  const create=async(action='patch',format='md',id=randomUUID())=>{const body={requestId:id,taskId:task.id,action,format};const r=await phone('/api/financial/jobs',{method:'POST',body});assert.ok([200,201].includes(r.status),JSON.stringify(r));return r.data.job;};
  const get=async id=>(await phone('/api/financial/jobs/'+id)).data.job;
  const files=async()=>(await readdir(output)).filter(n=>/^DIANA-finance-/.test(n));
  return {root,input,output,generic,state,task,config,core,coreConfig,workerConfig,wire,consoleOutput,request,phone,pair,create,get,files,
    get worker(){return worker;},advance:n=>now+=n,drop:s=>dropState=s,gate:fn=>onGate=fn,get saveStarts(){return saveStarts;},
    restartServer:async(nextDevice)=>{await stop();if(nextDevice)deviceId=nextDevice;await start();},restartWorker:async()=>{await worker.close();worker=await FinancialWorker.create({configPath:workerConfig,api,output:s=>consoleOutput.push(s),documentRoot:generic});},
    dump:()=>{const db=new DatabaseSync(dbPath);try{return db.prepare('SELECT key,value FROM settings').all();}finally{db.close();}}
  };
}

test('real paired phone → existing Python core → local test approval → save/readback → minimal state; queue does not invalidate review',async t=>{
  const f=await fixture(t);await f.worker.tick();
  const catalog=await f.phone('/api/financial/tasks');assert.equal(catalog.data.online,true);assert.deepEqual(Object.keys(catalog.data.tasks[0]).sort(),['actions','formats','id','label']);
  const j=await f.create();await f.worker.tick();assert.equal((await f.get(j.id)).state,'PC_REVIEW_REQUIRED');assert.equal((await f.files()).length,0);
  const next=await f.create('convert','json');await f.worker.tick();assert.equal((await f.get(next.id)).state,'QUEUED');
  assert.ok(f.consoleOutput.join('').includes(privateMarker));assert.ok(f.consoleOutput.join('').includes('output_content'));assert.ok(f.consoleOutput.join('').includes('unified_diff'));
  await f.worker.localCommand('approve',j.id);const done=await f.get(j.id);
  assert.equal(done.state,'LOCAL_SAVE_COMPLETED');assert.equal(done.saved,true);assert.equal(done.reviewComplete,false);assert.equal(f.saveStarts,1);
  const names=await f.files();assert.equal(names.length,1);const bytes=await readFile(path.join(f.output,names[0]),'utf8');assert.ok(bytes.includes(privateMarker));assert.ok(bytes.includes('LPAC'));assert.ok(bytes.includes('KEY_MAN'));
  await f.worker.tick();await f.worker.tick();assert.equal((await f.get(next.id)).state,'PC_REVIEW_REQUIRED');await f.worker.localCommand('reject',next.id);assert.equal((await f.get(next.id)).state,'CANCELLED');assert.equal((await f.files()).length,1);
  const ordinary=await f.phone('/api/jobs');assert.equal(ordinary.data.jobs.length,0);
  for(const route of ['/api/jobs/'+j.id+'/download','/api/jobs/'+j.id+'/artifacts','/api/agent/jobs/'+j.id+'/file'])assert.ok((await f.request(route,{token:route.includes('/agent/')?tokens.agentToken:tokens.userToken})).status>=400);
  const normalNext=await f.request('/api/agent/next',{token:tokens.agentToken});assert.equal(normalNext.data.job,null);
  const db=JSON.stringify(f.dump()),wire=JSON.stringify(f.wire);
  const hashes=[...f.consoleOutput.join('').matchAll(/\b[a-f0-9]{64}\b/gu)].map(m=>m[0]);
  for(const needle of [privateMarker,'REVIEW_A','DD_A','PE-02','KEY_MAN','LPAC','expected_body','output_content','unified_diff','plan_hash','approval_id',f.input.replaceAll('\\','\\\\'),'review.md','핵심 운용역',...hashes]){assert.ok(!wire.includes(needle),'wire excludes '+needle.slice(0,30));assert.ok(!db.includes(needle),'store excludes '+needle.slice(0,30));}
  assert.deepEqual(Object.keys(done).sort(),Object.keys(publicFinanceJob(done)).sort());
});

test('strict schema, paired-phone isolation, role isolation, no remote approval or metadata exfiltration',async t=>{
  const f=await fixture(t);await f.worker.tick();const j=await f.create();const other=await f.pair();
  for(const route of ['/api/financial/jobs/'+j.id,'/api/financial/jobs/'+j.id+'/cancel'])assert.equal((await f.request(route,{method:route.endsWith('/cancel')?'POST':'GET',token:other,body:route.endsWith('/cancel')?{}:undefined})).status,404);
  assert.equal((await f.request('/api/financial/jobs',{token:other})).data.jobs.length,0);
  for(const token of [tokens.agentToken,tokens.gatewayToken,'wrong'])assert.equal((await f.request('/api/financial/tasks',{token})).status,401);
  assert.equal((await f.phone('/api/agent/financial/register',{method:'POST',body:{}})).status,401);
  const forbidden='FORBIDDEN_PAYLOAD_CANARY_6452';
  for(const key of ['confirmed','owner','deviceId','target_doc','python','expected_body','plan_hash','token','output_content','unified_diff']){
    const r=await f.phone('/api/financial/jobs',{method:'POST',body:{requestId:randomUUID(),taskId:f.task.id,action:'patch',format:'md',[key]:forbidden}});assert.equal(r.status,400);assert.ok(!JSON.stringify(r.data).includes(forbidden));
  }
  assert.equal((await f.phone('/api/financial/jobs',{method:'POST',raw:'{"requestId":"'+randomUUID()+'","requestId":"'+randomUUID()+'","taskId":"'+f.task.id+'","action":"patch","format":"md"}'})).status,400);
  for(const action of ['export','shell','approve'])assert.equal((await f.phone('/api/financial/jobs',{method:'POST',body:{requestId:randomUUID(),taskId:f.task.id,action,format:'md'}})).status,400);
  for(const route of ['/api/financial/jobs/'+j.id+'/approve','/api/financial/jobs/'+j.id+'/execute'])assert.equal((await f.phone(route,{method:'POST',body:{confirmed:true,token:forbidden}})).status,404);
  assert.equal((await f.create('patch','md',j.id)).id,j.id);
  assert.equal((await f.phone('/api/financial/jobs',{method:'POST',body:{requestId:j.id,taskId:f.task.id,action:'convert',format:'md'}})).status,409);
  assert.ok(!JSON.stringify(f.dump()).includes(forbidden));assert.equal((await f.files()).length,0);
});

test('remote cancellation wins before save; cancelling completed save preserves actual outcome',async t=>{
  const f=await fixture(t);await f.worker.tick();const j=await f.create();await f.worker.tick();
  assert.equal((await f.phone('/api/financial/jobs/'+j.id+'/cancel',{method:'POST',body:{}})).data.job.state,'CANCELLED');
  await assert.rejects(f.worker.localCommand('approve',j.id));await f.worker.tick();assert.equal((await f.files()).length,0);
  const second=await f.create();await f.worker.tick();await f.worker.localCommand('approve',second.id);
  assert.equal((await f.phone('/api/financial/jobs/'+second.id+'/cancel',{method:'POST',body:{}})).data.job.state,'LOCAL_SAVE_COMPLETED');
  assert.equal((await f.files()).length,1);
});

test('lost final ACK retries the exact report without a second execution, including after server restart',async t=>{
  const f=await fixture(t);await f.worker.tick();const j=await f.create();await f.worker.tick();f.drop('LOCAL_SAVE_COMPLETED');
  await assert.rejects(f.worker.localCommand('approve',j.id));assert.equal((await f.files()).length,1);
  await f.restartServer();await f.worker.tick();assert.equal((await f.get(j.id)).state,'LOCAL_SAVE_COMPLETED');assert.equal((await f.files()).length,1);assert.equal(f.saveStarts,1);
  const reports=f.wire.filter(w=>w.request&&JSON.parse(w.request).state==='LOCAL_SAVE_COMPLETED');assert.equal(reports.length,2);assert.equal(reports[0].request,reports[1].request);
});

test('lost save-gate ACK becomes uncertain and never resumes document execution',async t=>{
  const f=await fixture(t);await f.worker.tick();const j=await f.create();await f.worker.tick();f.drop('LOCAL_SAVING');await assert.rejects(f.worker.localCommand('approve',j.id));
  await f.worker.tick();assert.equal((await f.get(j.id)).state,'UNCERTAIN');assert.equal((await f.files()).length,0);
});

test('lost review ACK followed by cancellation clears the outbox and lets the next job proceed',async t=>{
  const f=await fixture(t);await f.worker.tick();const j=await f.create();f.drop('PC_REVIEW_REQUIRED');await assert.rejects(f.worker.tick());
  await f.phone('/api/financial/jobs/'+j.id+'/cancel',{method:'POST',body:{}});const next=await f.create('convert');
  await f.worker.tick();await f.worker.tick();assert.equal((await f.get(j.id)).state,'CANCELLED');assert.equal((await f.get(next.id)).state,'PC_REVIEW_REQUIRED');assert.equal((await f.files()).length,0);
});

for(const mutation of ['source','policy','expiry'])test('local '+mutation+' change invalidates pending approval without save',async t=>{
  const f=await fixture(t,{ttl:mutation==='expiry'?30:300_000});await f.worker.tick();const j=await f.create();await f.worker.tick();
  if(mutation==='source')await writeFile(path.join(f.input,'review.md'),'changed');
  if(mutation==='policy')await writeFile(f.coreConfig,JSON.stringify({...f.core,write_roles:[]}));
  if(mutation==='expiry')await new Promise(r=>setTimeout(r,80));
  try{await f.worker.localCommand('approve',j.id);}catch{}
  try{await f.worker.tick();}catch{}
  assert.equal((await f.get(j.id)).state,'BLOCKED');assert.equal((await f.files()).length,0);
});

test('PC restart drops approval and blocks abandoned work; offline/expiry uses fixed states',async t=>{
  const f=await fixture(t);await f.worker.tick();const j=await f.create();await f.worker.tick();await f.restartWorker();f.advance(91_000);await f.worker.tick();
  assert.equal((await f.get(j.id)).state,'BLOCKED');await assert.rejects(f.worker.localCommand('approve',j.id));assert.equal((await f.files()).length,0);
  f.advance(91_000);assert.equal((await f.phone('/api/financial/tasks')).data.online,false);
  const queued=await f.create();f.advance(24*3600_000+1);assert.equal((await f.get(queued.id)).code,'REQUEST_EXPIRED');
});

test('dedicated worker rejects overlap with ordinary remote document catalog',async t=>{
  const f=await fixture(t);await assert.rejects(FinancialWorker.create({configPath:f.workerConfig,api:async()=>{},documentRoot:f.input}),{code:'FINANCE_CATALOG_OVERLAP'});
});

test('server device binding cannot be changed by reusing phone or agent credentials for another PC',async t=>{
  const f=await fixture(t);await f.worker.tick();const j=await f.create();await f.worker.tick();await f.restartServer('other-pc');
  assert.equal((await f.phone('/api/financial/jobs/'+j.id)).status,404);assert.equal((await f.phone('/api/financial/jobs/'+j.id+'/cancel',{method:'POST',body:{}})).status,404);
  assert.equal((await f.phone('/api/financial/jobs')).data.jobs.length,0);assert.equal((await f.phone('/api/financial/tasks')).data.tasks.length,0);
  await assert.rejects(f.worker.tick(),{status:409});assert.equal((await f.files()).length,0);
});

test('financial transport restricts destinations/routes and only posts metadata',async()=>{
  const calls=[];const api=financialTransport({API_BASE_URL:'https://example.invalid',AGENT_TOKEN:'x'.repeat(40)},async(url,opts)=>{calls.push({url,opts});return new Response('{"ok":true}');});
  await api('/api/agent/financial/register',{workerId:randomUUID(),tasks:[]});assert.equal(calls.length,1);assert.equal(calls[0].opts.redirect,'error');
  await assert.rejects(api('/api/agent/catalog',{}),{code:'NETWORK_ROUTE_DENIED'});
  assert.throws(()=>financialTransport({API_BASE_URL:'http://example.invalid',AGENT_TOKEN:'x'.repeat(40)}),{code:'INVALID_SERVER_CONFIG'});
});

test('stale/wrong-worker reports and concurrent claims cannot steal an active review',async t=>{
  const f=await fixture(t);await f.worker.tick();const j=await f.create();await f.worker.tick();
  const nextCall=f.wire.find(w=>w.route==='/api/agent/financial/next'&&JSON.parse(w.response).job);
  const claim=JSON.parse(nextCall.response).job,workerId=claim.workerId;
  const report={workerId,generation:claim.generation,revision:claim.revision,reportId:randomUUID(),state:'LOCAL_SAVING',code:'PC_SAVING',saved:false,reviewComplete:false};
  const status=body=>f.request('/api/agent/financial/jobs/'+j.id+'/status',{method:'POST',token:tokens.agentToken,body});
  assert.equal((await status(report)).status,409); // old revision
  const current=await f.get(j.id);
  assert.equal((await status({...report,revision:current.revision,workerId:randomUUID()})).status,409);
  assert.equal((await status({...report,revision:current.revision,generation:claim.generation+1})).status,409);
  assert.equal((await status({...report,revision:current.revision,confirmed:true})).status,400);
  assert.equal((await f.request('/api/agent/financial/register',{method:'POST',token:tokens.agentToken,body:{workerId:randomUUID(),tasks:[]}})).status,409);
  const queued=await f.create('convert');
  const claims=await Promise.all([1,2].map(()=>f.request('/api/agent/financial/next',{method:'POST',token:tokens.agentToken,body:{workerId}})));
  for(const r of claims)assert.equal(r.data.job.id,j.id);assert.equal((await f.get(queued.id)).state,'QUEUED');
  f.advance(91_000);assert.equal((await f.get(j.id)).state,'BLOCKED');assert.equal((await status({...report,revision:current.revision})).status,409);assert.equal((await f.files()).length,0);
});

test('save I/O failure yields UNCERTAIN, never false completion or retry execution',async t=>{
  const f=await fixture(t);await f.worker.tick();const j=await f.create();await f.worker.tick();
  // The core uses an exclusive output open. Occupy exactly its preview destination.
  const consoleText=f.consoleOutput.join(''),hash=consoleText.match(/"plan_hash": "([a-f0-9]{64})"/u)[1];
  const dest=path.join(f.output,'DIANA-finance-'+hash+'.md');await writeFile(dest,'TEST_EXISTING_OUTPUT',{flag:'wx'});
  await f.worker.localCommand('approve',j.id);assert.equal((await f.get(j.id)).state,'UNCERTAIN');assert.equal((await f.get(j.id)).saved,false);
  assert.equal(await readFile(dest,'utf8'),'TEST_EXISTING_OUTPUT');await f.worker.tick();assert.equal(f.saveStarts,1);
});

test('cancellation after the atomic save gate reports the actual saved state',async t=>{
  const f=await fixture(t);await f.worker.tick();const j=await f.create();await f.worker.tick();
  let gateCancelState;
  f.gate(async()=>{gateCancelState=(await f.phone('/api/financial/jobs/'+j.id+'/cancel',{method:'POST',body:{}})).data.job.state;});
  await f.worker.localCommand('approve',j.id);
  assert.equal(gateCancelState,'LOCAL_SAVING');
  const c=await f.phone('/api/financial/jobs/'+j.id+'/cancel',{method:'POST',body:{}});assert.equal(c.data.job.saved,true);assert.equal(c.data.job.state,'LOCAL_SAVE_COMPLETED');assert.equal((await f.files()).length,1);
});
