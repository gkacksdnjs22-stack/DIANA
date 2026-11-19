import {approvedRequest as approveRequest} from './helpers/phone-pair.mjs';
const approvedRequest=(request,options)=>approveRequest(request,options,tokens.agentToken);
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,cp,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import {createControlServer} from '../lib/control.mjs';
import {FinancialWorker} from '../financial-documents/remote-worker.mjs';
import {LocalRegistration} from '../financial-documents/local-registration.mjs';
import {createReviewViewer} from '../financial-documents/review-viewer.mjs';
import {digest} from '../personal-ai/documents/files.mjs';

const python=process.env.DIANA_TEST_PYTHON||path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/python',process.platform==='win32'?'python.exe':'bin/python');
const tokens={agentToken:'a'.repeat(40),userToken:'u'.repeat(40),gatewayToken:'g'.repeat(40)},marker='REGISTRATION_PC_ONLY_CANARY_73';
async function fixture(t){
 const parent=path.resolve('.local');await mkdir(parent,{recursive:true});const root=await mkdtemp(path.join(parent,'financial-registration-test-'));
 const input=path.join(root,'input'),output=path.join(root,'output'),generic=path.join(root,'generic'),state=path.join(root,'state');
 await cp('financial-documents/fixtures/fund-a',input,{recursive:true});await mkdir(output);await mkdir(generic);
 const corePath=path.join(root,'core.json'),configPath=path.join(root,'worker.json');
 const core={schema_version:1,principal:'test-analyst',role:'analyst',readRoots:[input],outputRoot:output,python,write_roles:['analyst'],approval_ttl_ms:300000,documents:[['REVIEW_A','review.md'],['DD_A','due-diligence.txt'],['PE-02','guideline.json']].map(([id,relativePath])=>({id,relativePath,rootIndex:0,version:'1',classification:'synthetic',read_roles:['analyst']}))};
 const task={id:randomUUID(),label:'기존 보완',actions:['patch','checklist_review','convert'],formats:['md','txt','json'],target_doc:'REVIEW_A',source_ids:['DD_A'],guideline_id:'PE-02',item_ids:['KEY_MAN']};
 const config={schema_version:1,coreConfig:corePath,stateDir:state,tasks:[task]};await writeFile(corePath,JSON.stringify(core));await writeFile(configPath,JSON.stringify(config));
 const wire=[],events=[];const server=createControlServer({allowLegacyPlaintextTransfers:true,...tokens,deviceId:'registration-test',dbPath:path.join(root,'relay.sqlite'),transferDir:path.join(root,'relay')});server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
 async function req(route,{token=tokens.userToken,body}={}){const response=await fetch(base+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});const data=await response.json();wire.push({route,body,data});return{status:response.status,data};}
 const api=async(route,body)=>{const r=await req(route,{token:tokens.agentToken,body});if(r.status>=400)throw Object.assign(Error('CONTROL_REJECTED'),{status:r.status});return r.data;};
 let worker=await FinancialWorker.create({configPath,api,documentRoot:generic,detailOutput:false,onEvent:event=>{events.push(event);viewer?.accept(event);}}),viewer;
 let registry=await LocalRegistration.open(worker);
 viewer=await createReviewViewer({onCommand:(action,id)=>worker.localCommand(action,id),onRecheck:id=>worker.reviewSaved(id),onReadCatalog:()=>registry.view(),onRegister:(type,body)=>registry.register(type,body)});
 const viewURL=new URL(viewer.url),session=new URLSearchParams(viewURL.hash.slice(1)).get('view');
 async function local(route,body,headers={}){const response=await fetch(viewURL.origin+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+session,...(body?{Origin:viewURL.origin,'Content-Type':'application/json'}:{}),...headers},body:body?JSON.stringify(body):undefined});return{status:response.status,text:await response.text()};}
 const code=(await req('/api/phone/pair-code',{body:{}})).data.code,phone=(await approvedRequest(req,{token:'',body:{code,deviceName:'Registration QA phone'}})).data.phoneToken;
 t.after(async()=>{await worker.close();await viewer.close();server.closeAllConnections();await new Promise(r=>server.close(r));assert.equal(path.dirname(root),parent);assert.match(path.basename(root),/^financial-registration-test-/u);await rm(root,{recursive:true,force:true});});
 const upload=async values=>registry.register('document',{requestId:randomUUID(),revision:registry.revision,id:'PRIVATE_REVIEW_B',version:'1',kind:'target',classification:'internal',name:'private-review.md',content:'# '+marker+'\n\n원문입니다.',...values});
 return{root,input,output,generic,state,core,corePath,config,configPath,task,wire,events,req,local,upload,session,viewURL,phone,get worker(){return worker;},get registry(){return registry;},
  async tick(){const revision=registry.revision;await worker.tick();registry.markPublished(revision);},
  async job(taskId=task.id){const requestId=randomUUID();const r=await req('/api/financial/jobs',{token:phone,body:{requestId,taskId,action:'patch',format:'md'}});assert.equal(r.status,201,JSON.stringify(r));return requestId;},
  async restart(){await worker.close();worker=await FinancialWorker.create({configPath,api,documentRoot:generic,detailOutput:false,onEvent:event=>{events.push(event);viewer.accept(event);}});registry=await LocalRegistration.open(worker);},
 };
}
async function registerSet(f){
 await f.upload({content:(await readFile(path.join(f.input,'review.md'),'utf8'))+'\n'+marker+'\n'});
 await f.upload({id:'PRIVATE_DD_B',kind:'source',name:'private-due-diligence.txt',content:await readFile(path.join(f.input,'due-diligence.txt'),'utf8')});
 const guideline=JSON.parse(await readFile(path.join(f.input,'guideline.json'),'utf8'));guideline.id='PRIVATE_PE_B';for(const rule of guideline.rules)rule.source_ids=['PRIVATE_DD_B'];
 await f.upload({id:'PRIVATE_PE_B',kind:'guideline',name:'private-guideline.json',content:JSON.stringify(guideline)});
 const body={requestId:randomUUID(),revision:f.registry.revision,label:'휴대폰에서 요청할 검토',targetId:'PRIVATE_REVIEW_B',sourceIds:['PRIVATE_DD_B'],guidelineId:'PRIVATE_PE_B',itemIds:['KEY_MAN'],actions:['patch','checklist_review'],formats:['md','txt','json']};
 await f.registry.register('task',body);return body;
}

test('PC document/task registration persists and paired mobile receives only public catalog metadata',async t=>{
 const f=await fixture(t),original=[digest(await readFile(f.corePath)),digest(await readFile(f.configPath)),digest(await readFile(path.join(f.input,'review.md')))];
 await f.tick();const task=await registerSet(f);await f.tick();const view=await f.registry.view();assert.equal(view.revision,4);assert.equal(view.synced,true);assert.equal(view.documents.length,6);
 const mobile=await f.req('/api/financial/tasks',{token:f.phone});assert.equal(mobile.status,200);const publicEntry=mobile.data.tasks.find(x=>x.id===task.requestId);assert.deepEqual(publicEntry,{id:task.requestId,label:task.label,actions:task.actions,formats:task.formats});
 const id=await f.job(task.requestId);await f.tick();const local=JSON.parse((await f.local('/api/view')).text),entry=local.jobs.find(x=>x.job.id===id);assert.equal(entry.job.state,'PC_REVIEW_REQUIRED');assert.ok(entry.review.after.includes(marker));
 const approval=await f.local('/api/local-action',{requestId:id,viewId:entry.reviewId,action:'approve'});assert.equal(approval.status,200);
 const result=(await f.req('/api/financial/jobs/'+id,{token:f.phone})).data.job;assert.equal(result.state,'LOCAL_SAVE_COMPLETED');assert.equal(result.reviewComplete,false);
 const files=(await readdir(f.output)).filter(x=>x.startsWith('DIANA-finance-'));assert.equal(files.length,1);const text=await readFile(path.join(f.output,files[0]),'utf8');assert.ok(text.includes(marker));assert.ok(text.includes('KEY_MAN'));
 const network=JSON.stringify(f.wire);for(const privateValue of [marker,'PRIVATE_REVIEW_B','PRIVATE_DD_B','PRIVATE_PE_B','private-review.md',f.root])assert.ok(!network.includes(privateValue),privateValue);
 assert.equal(new Set(f.wire.filter(w=>w.route.endsWith('/register')).map(w=>w.body.workerId)).size,1,'Registration must not replace the live worker identity');
 assert.deepEqual([digest(await readFile(f.corePath)),digest(await readFile(f.configPath)),digest(await readFile(path.join(f.input,'review.md')))],original);
 await f.restart();const restored=await f.registry.view();assert.equal(restored.revision,4);assert.equal(restored.tasks.length,2);assert.ok(restored.documents.some(d=>d.id==='PRIVATE_REVIEW_B'));
});
test('registration cannot invalidate an existing pending approval or stage files while busy',async t=>{
 const f=await fixture(t);await f.tick();const id=await f.job();await f.tick();const before=await readdir(f.state+'.registrations');
 await assert.rejects(()=>f.upload(),{code:'REGISTRATION_BUSY'});assert.deepEqual(await readdir(f.state+'.registrations'),before);
 const view=JSON.parse((await f.local('/api/view')).text),entry=view.jobs.find(x=>x.job.id===id);assert.equal((await f.local('/api/local-action',{requestId:id,viewId:entry.reviewId,action:'approve'})).status,200);
 assert.equal((await f.req('/api/financial/jobs/'+id,{token:f.phone})).data.job.state,'LOCAL_SAVE_COMPLETED');
});
test('same-revision concurrent registration has one commit and exact retry is idempotent',async t=>{
 const f=await fixture(t),body={requestId:randomUUID(),revision:0,id:'REVIEW_B',version:'1',kind:'target',classification:'internal',name:'review-b.txt',content:'새 검토서'};
 const both=await Promise.allSettled([f.registry.register('document',body),f.registry.register('document',{...body,requestId:randomUUID(),id:'REVIEW_C'})]);
 assert.equal(both.filter(r=>r.status==='fulfilled').length,1);assert.equal(both.find(r=>r.status==='rejected').reason.code,'REGISTRATION_CHANGED');
 assert.equal((await f.registry.register('document',body)).revision,1);assert.equal(f.registry.revision,1);
 await assert.rejects(()=>f.registry.register('document',{...body,content:'변경 내용'}),{code:'REGISTRATION_CONFLICT'});
});
test('local catalog routes require the local session and same Origin and never accept PC paths',async t=>{
 const f=await fixture(t);
 assert.equal((await f.local('/api/local-catalog',undefined,{Authorization:'Bearer '+tokens.agentToken})).status,401);
 assert.equal((await f.local('/api/local-catalog',undefined,{Origin:'https://external.invalid'})).status,403);
 assert.equal((await f.local('/api/local-catalog/documents',{}, {Origin:'https://external.invalid'})).status,403);
 const bad=await f.local('/api/local-catalog/documents',{requestId:randomUUID(),revision:0,path:'C:/outside/file.txt'});assert.equal(bad.status,400);assert.ok(!bad.text.includes('C:/outside'));
 const value=JSON.parse((await f.local('/api/local-catalog')).text);assert.equal(value.documents.length,3);assert.ok(!JSON.stringify(value).includes('readRoots'));assert.ok(!JSON.stringify(value).includes(f.root));
});
test('invalid copies, duplicate IDs and unsupported formats do not commit or alter original sources',async t=>{
 const f=await fixture(t),original=digest(await readFile(path.join(f.input,'review.md')));
 for(const values of [{name:'../escape.md'},{name:'file.pdf'},{id:'../BAD'},{id:'REVIEW_A'},{content:'password=PRIVATE_VALUE'},{content:'\u0000'},{content:'x'.repeat(262145)},{kind:'guideline',name:'guide.json',content:'{"id":"WRONG","version":"1","rules":[]}'}])await assert.rejects(()=>f.upload(values));
 assert.equal(f.registry.revision,0);assert.equal(digest(await readFile(path.join(f.input,'review.md'))),original);
});
test('an incomplete revision remains inert while changed registered bytes block recovery without overwrite',async t=>{
 const f=await fixture(t);await f.upload();const stage=path.join(f.state+'.registrations',randomUUID());await mkdir(stage);await writeFile(path.join(stage,'state.json'),'incomplete');await f.restart();assert.equal(f.registry.revision,1);
 const snapshot=f.worker.registrationBase(),entry=snapshot.core.documents.find(d=>d.id==='PRIVATE_REVIEW_B'),filename=path.join(snapshot.core.readRoots[entry.rootIndex],entry.relativePath);await writeFile(filename,'changed copy');
 await assert.rejects(()=>f.registry.view(),{code:'CONTENT_CHANGED'});await assert.rejects(()=>f.restart(),{code:'CONTENT_CHANGED'});assert.equal(await readFile(filename,'utf8'),'changed copy');
});
test('editing the original policy still revokes operation after switching to a registered revision',async t=>{
 const f=await fixture(t);await f.upload();const changed={...f.core,write_roles:[]};await writeFile(f.corePath,JSON.stringify(changed));await assert.rejects(()=>f.worker.tick(),{code:'LOCAL_POLICY_CHANGED'});await assert.rejects(()=>f.upload({id:'REVIEW_C'}),{code:'LOCAL_POLICY_CHANGED'});
});
test('a changed catalog commit is preserved and cannot be extended into a false successful registration',async t=>{
 const f=await fixture(t);await f.upload();const root=f.state+'.registrations',revision=(await readdir(root)).find(name=>/^[a-f0-9-]{36}$/u.test(name));const filename=path.join(root,revision,'commit.json');await writeFile(filename,'unknown preexisting bytes');
 await assert.rejects(()=>f.registry.view(),{code:'REGISTRATION_STORAGE_CHANGED'});await assert.rejects(()=>f.upload({id:'PRIVATE_C'}),{code:'REGISTRATION_STORAGE_CHANGED'});assert.equal(await readFile(filename,'utf8'),'unknown preexisting bytes');assert.equal(f.registry.revision,1);
});
test('invalid full guideline diagnostics cannot publish a task as a successful review',async t=>{
 const f=await fixture(t);const guideline=JSON.parse(await readFile(path.join(f.input,'guideline.json'),'utf8'));guideline.id='BAD_GUIDE';guideline.rules[0].positive_statements=['unrelated affirmative'];
 await f.upload({id:'BAD_GUIDE',kind:'guideline',name:'guide.json',content:JSON.stringify(guideline)});
 await assert.rejects(()=>f.registry.register('task',{requestId:randomUUID(),revision:f.registry.revision,label:'잘못된 지침 작업',targetId:'REVIEW_A',sourceIds:['DD_A'],guidelineId:'BAD_GUIDE',itemIds:[],actions:['checklist_review'],formats:['md']}),{code:'REGISTRATION_REVIEW_INVALID'});
 assert.equal(f.registry.revision,1);await f.tick();const mobile=(await f.req('/api/financial/tasks',{token:f.phone})).data;assert.equal(mobile.tasks.length,1);
});

test('shutdown rejects a late registration after the worker lease has been released',async t=>{
 const f=await fixture(t);await f.worker.close();const before=await readdir(f.state+'.registrations');
 await assert.rejects(()=>f.upload(),{code:'DESKTOP_STOPPING'});
 assert.equal(f.registry.revision,0);assert.deepEqual(await readdir(f.state+'.registrations'),before);
});
test('shutdown prevents a staged registration from committing while close drains its queue',async t=>{
 const f=await fixture(t);let enter,release,commits=0;const entered=new Promise(resolve=>enter=resolve),held=new Promise(resolve=>release=resolve);
 const pending=f.worker.withRegistration(async install=>{enter();await held;await install(f.configPath,async()=>commits++);});
 await entered;const closed=f.worker.close();release();await assert.rejects(()=>pending,{code:'DESKTOP_STOPPING'});await closed;assert.equal(commits,0);
});

