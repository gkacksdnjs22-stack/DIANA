import {offerKey,newIdentity} from '../lib/e2ee.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {once,EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createControlServer} from '../lib/control.mjs';
import {pairRequest} from './helpers/phone-pair.mjs';
import {checkPhoneApproval,confirmPhoneOnPc} from '../agent/pair-approval.mjs';

test('unavailable desktop, process errors, empty output and abort are not user rejection',async()=>{
 const pending={deviceName:'Fixture',expiresAt:new Date(Date.now()+30000).toISOString()};
 for(const [code,output,expected] of [[1,'',null],[0,'',null],[0,'unknown',null],[0,'approve',true],[0,'reject',false],[1,'reject',null]]){
  const spawnImpl=()=>{const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};setImmediate(()=>{child.stdout.end(output);child.emit('close',code);});return child;};
  assert.equal(await confirmPhoneOnPc(pending,{platform:'win32',spawnImpl,logger:{error(){}}}),expected);
 }
 assert.equal(await confirmPhoneOnPc(pending,{platform:'linux'}),null);
 assert.equal(await confirmPhoneOnPc(pending,{platform:'win32',spawnImpl(){throw Error('unavailable');},logger:{error(){}}}),null);
 assert.equal(await confirmPhoneOnPc(pending,{signal:AbortSignal.abort()}),null);
});

test('approval launch is process scoped and failure logs exclude raw stderr and request data',async()=>{
 const secret='private-token-and-device-name';
 for(const [stderr,reason] of [['PSSecurityException UnauthorizedAccess '+secret,'execution-policy-blocked'],['DIANA_PAIR_UI_UNAVAILABLE '+secret,'desktop-unavailable'],['unexpected '+secret,'script-error']]){
  const logs=[];
  const spawnImpl=(command,args,options)=>{
   assert.equal(command,'powershell.exe');assert.deepEqual(args.slice(0,6),['-NoProfile','-NonInteractive','-STA','-ExecutionPolicy','Bypass','-File']);
   assert(args.at(-1).endsWith('pair-approval.ps1'));assert.deepEqual(options.stdio,['pipe','pipe','pipe']);assert.equal(options.windowsHide,true);
   assert(!args.join(' ').includes(secret));
   const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};
   setImmediate(()=>{child.stderr.end(stderr);child.emit('close',1);});return child;
  };
  assert.equal(await confirmPhoneOnPc({deviceName:secret,expiresAt:new Date(Date.now()+30000).toISOString()},{platform:'win32',spawnImpl,logger:{error:message=>logs.push(message)}}),null);
  assert.equal(logs.length,1);assert(logs[0].includes(reason));assert(!logs[0].includes(secret));
 }
});

const USER='u'.repeat(40),AGENT='a'.repeat(40),GATEWAY='g'.repeat(40);
async function fixture(t){
  let now=Date.now();
  const server=createControlServer({allowLegacyPlaintextTransfers:true,userToken:USER,agentToken:AGENT,gatewayToken:GATEWAY,now:()=>now,transfers:{async put(){},async read(){return null;},async remove(){}}});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
  const request=async(route,{method='GET',token=USER,body}={})=>{
    const r=await fetch(`http://127.0.0.1:${server.address().port}`+route,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
    return {status:r.status,data:await r.json()};
  };
  const code=(await request('/api/phone/pair-code',{method:'POST'})).data.code;
  const body=pairRequest({code,deviceName:'Test phone'});
  const offer=offerKey(body.publicKey,body.requestId);
  return {request,body,pair:()=>request('/api/phone/pair',{method:'POST',token:'',body}),advance:ms=>now+=ms,
    pending:async()=>(await request('/api/agent/pair-pending',{token:AGENT})).data.pending,
    decide:async(id,approve,token=AGENT)=>request('/api/agent/pair-approve',{token,method:'POST',body:{id,approve,e2ee:offer.reply}})};
}
test('pending enrollment has no usable credential; only the agent can approve the exact request',async t=>{
  const f=await fixture(t);
  assert.deepEqual((await f.request('/api/phone/devices')).data.devices,[]);
  for(let i=0;i<12;i++){const r=await f.pair();assert.equal(r.status,202);assert.equal(r.data.phoneToken,undefined);}
  assert.deepEqual((await f.request('/api/phone/devices')).data.devices,[]);
  const pending=await f.pending();assert.equal(pending.deviceName,'Test phone');
  assert.deepEqual(Object.keys(pending).sort(),['deviceName','expiresAt','id','publicKey','requestId']);
  for(const token of ['',USER,GATEWAY])assert.equal((await f.decide(pending.id,true,token)).status,401);
  assert.equal((await f.decide('wrong',true)).status,409);
  assert.equal((await f.decide(pending.id,true)).status,200);
  assert.equal((await f.decide(pending.id,true)).status,200);
  assert.equal((await f.decide(pending.id,false)).status,409);
  const connected=await f.pair();assert.equal(connected.status,201);
  assert.equal((await f.request('/api/jobs',{token:connected.data.phoneToken})).status,200);
});
test('a copied code and matching name cannot steal a pending claim',async t=>{
  const f=await fixture(t);assert.equal((await f.pair()).status,202);
  const pending=await f.pending();
  const body=pairRequest({code:f.body.code,deviceName:f.body.deviceName});
  assert.equal((await f.request('/api/phone/pair',{method:'POST',token:'',body})).status,401);
  assert.equal((await f.decide(pending.id,true)).status,200);
  assert.equal((await f.pair()).status,201);
});

test('an unavailable UI leaves the same server request pending for later explicit approval',async t=>{
 const f=await fixture(t);assert.equal((await f.pair()).status,202);const first=await f.pending();
 const changed=await checkPhoneApproval({request:async(route,options)=>{const r=await f.request(route,{...options,token:AGENT});assert.equal(r.status,200);return r.data;},confirm:async()=>null});
 assert.equal(changed,false);assert.equal((await f.pending()).id,first.id);assert.equal((await f.pair()).status,202);
 assert.equal((await f.decide(first.id,true)).status,200);assert.equal((await f.pair()).status,201);
});
test('denial, expiry, code replacement and legacy clients never produce a phone token',async t=>{
  const f=await fixture(t);assert.equal((await f.pair()).status,202);
  assert.equal((await f.decide((await f.pending()).id,false)).status,200);
  assert.equal((await f.pair()).status,403);
  assert.deepEqual((await f.request('/api/phone/devices')).data.devices,[]);
  f.body.code=(await f.request('/api/phone/pair-code',{method:'POST'})).data.code;
  assert.equal((await f.pair()).status,202);const prior=await f.pending();
  f.advance(300000);assert.equal((await f.decide(prior.id,true)).status,409);assert.equal((await f.pair()).status,401);
  f.body.code=(await f.request('/api/phone/pair-code',{method:'POST'})).data.code;
  assert.equal((await f.pair()).status,202);const obsolete=await f.pending();
  await f.request('/api/phone/pair-code',{method:'POST'});assert.equal((await f.decide(obsolete.id,true)).status,409);
  const legacy=await f.request('/api/phone/pair',{method:'POST',token:'',body:{code:f.body.code,deviceName:'old client'}});assert.equal(legacy.status,400);
});
test('PC confirmation changes state only after an explicit approval or rejection',async()=>{
  for(const decision of [true,false,undefined,null]){
    const sent=[];
    await checkPhoneApproval({request:async(route,options)=>{if(!options)return{pending:{id:'request',deviceName:'Test',publicKey:newIdentity().publicKey,requestId:'test-request',expiresAt:new Date(Date.now()+30000).toISOString()}};sent.push(options.body);},confirm:async()=>decision,keys:{async get(){return null;},async set(){}}});
    assert.equal(sent.length,typeof decision==='boolean'?1:0);
    if(sent.length){assert.equal(sent[0].approve,decision);assert.equal(!!sent[0].e2ee,decision);}
  }
});
