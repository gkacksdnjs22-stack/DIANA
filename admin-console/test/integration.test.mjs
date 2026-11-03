import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {request,createServer} from 'node:http';
import {mkdtemp,mkdir,rm,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createControlServer} from '../../lib/control.mjs';
import {pgliteStore} from '../../security-lab/admin-passkey/staging/test-support.mjs';
import {StagingAdminAuth} from '../../security-lab/admin-passkey/staging/auth.mjs';
import {Authenticator} from '../../security-lab/admin-passkey/test/software-authenticator.mjs';
import {createAdminConsole} from '../router.mjs';
import {mountAdminConsole} from '../mount.mjs';
const origin='https://admin-console.example',rpID='admin-console.example';
const USER='legacy-user-'+'u'.repeat(40),AGENT='legacy-agent-'+'a'.repeat(40),GATEWAY='legacy-gateway-'+'g'.repeat(40);
async function fixture(t,{mode='connected',trustedProxyIPs=['127.0.0.1'],handlerOverride}={}){
  await mkdir(new URL('../generated/',import.meta.url),{recursive:true});
  const dir=await mkdtemp(new URL('../generated/integration-',import.meta.url));
  let store,auth,owner,raw;
  if(mode==='connected'){
    store=await pgliteStore();auth=new StagingAdminAuth({store,origin,rpID});
    owner=new Authenticator();const ticket=(await auth.bootstrap()).enrollmentTicket;
    const c=await auth.dispatch('register/begin',{ticket});await auth.dispatch('register/finish',{ceremonyId:c.ceremonyId,response:owner.register(c.options,{rp:rpID,client:{origin}})});
    const l=await auth.dispatch('login/begin');raw=(await auth.dispatch('login/finish',{ceremonyId:l.ceremonyId,response:owner.login(l.options,{rp:rpID,client:{origin}})})).sessionToken;
  }
  const server=createControlServer({userToken:USER,agentToken:AGENT,gatewayToken:GATEWAY,appOrigin:origin,transferDir:dir});
  const handler=handlerOverride??createAdminConsole(mode==='preview'?{}:{mode,auth,origin,rpID,trustedProxyIPs});
  mountAdminConsole(server,handler);server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await store?.close();assert.ok(dir.startsWith(resolve(import.meta.dirname,'../generated')));await rm(dir,{recursive:true,force:true});});
  const send=(path,{method='GET',token,body,headers={},bytes}={})=>new Promise((resolve,reject)=>{
    const req=request({host:'127.0.0.1',port:server.address().port,path,method,headers:{Host:rpID,'X-Forwarded-Proto':'https',Origin:origin,...(body!==undefined?{'Content-Type':'application/json'}:{}),...(token?{Authorization:'Bearer '+token}:{}),...headers}},res=>{
      const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{const text=Buffer.concat(chunks).toString();let data;try{data=JSON.parse(text);}catch{}resolve({status:res.statusCode,headers:res.headers,text,data});});
    });req.on('error',reject);req.end(bytes??(body===undefined?undefined:JSON.stringify(body)));
  });
  const call=(action,body={},token=raw)=>send('/admin/api/'+action,{method:'POST',body,token});
  const grant=async(scope='manage',token=raw,key=owner)=>{const b=await call('login/begin',{scope},token);assert.equal(b.status,200);const r=await call('login/finish',{ceremonyId:b.data.ceremonyId,response:key.login(b.data.options,{rp:rpID,client:{origin}})},token);assert.equal(r.status,200);return r.data.grant;};
  return{server,store,auth,owner,raw,send,call,grant};
}
test('preview has no auth adapter, no automatic database writes and no API mutation path',async t=>{
  const f=await fixture(t,{mode:'preview'});const cfg=await f.send('/admin/config.json');assert.equal(cfg.status,200);assert.deepEqual(cfg.data,{configured:false,basePath:'/admin/',origin:null,rpID:null,documentAccess:false});
  for(const action of ['invite','role','register/begin','stage/bootstrap','recovery/codes'])assert.equal((await f.call(action)).status,503);
  assert.equal((await f.send('/admin/')).status,200);assert.equal((await f.send('/api/jobs',{token:USER})).status,200);
});
test('an explicitly configured auth adapter and exact HTTPS origin/RP are required',()=>{
  const auth={origin,rpID,session(){},dispatch(){}};
  for(const input of [{mode:'connected'},{mode:'connected',auth,origin:'http://admin-console.example',rpID},{mode:'connected',auth,origin,rpID:'other.example'},{mode:'preview',auth},{mode:'connected',auth,origin:'https://attacker.example',rpID:'attacker.example'}])assert.throws(()=>createAdminConsole(input));
});
test('same server preserves legacy pages/tokens while admin sessions do not grant document APIs',async t=>{
  const f=await fixture(t);
  assert.equal((await f.send('/')).text,await readFile(new URL('../../public/index.html',import.meta.url),'utf8'));
  assert.equal((await f.send('/console')).status,200);assert.equal((await f.send('/api/jobs',{token:USER})).status,200);
  for(const token of [f.raw,AGENT,GATEWAY])assert.equal((await f.send('/api/jobs',{token})).status,401);
  for(const token of [USER,AGENT,GATEWAY])assert.equal((await f.call('list',{},token)).status,403);
  const state=await f.call('list');assert.equal(state.data.me.role,'owner');assert.ok(!('jobs' in state.data));assert.ok(!('documents' in state.data));
  const page=await f.send('/admin/');assert.equal(page.status,200);assert.match(page.headers['content-security-policy'],/frame-ancestors 'none'/);assert.equal(page.headers['cache-control'],'no-store');
});
test('admin mount never derives trust from a forged host, origin or forwarding header',async t=>{
  const f=await fixture(t);
  for(const headers of [{Origin:'https://attacker.example'},{Host:'attacker.example'},{'X-Forwarded-Proto':'http'},{'X-Forwarded-Proto':'https,http'}])assert.equal((await f.send('/admin/api/list',{method:'POST',token:f.raw,body:{},headers})).status,403);
  assert.equal((await f.send('/admin/api/list',{method:'GET',token:f.raw})).status,403);
  assert.equal((await f.send('/admin/api/list',{method:'POST',token:f.raw,body:{},headers:{'Content-Type':'text/plain'}})).status,403);
});
test('forwarded HTTPS requires an explicitly trusted immediate peer',async t=>{
  const f=await fixture(t,{trustedProxyIPs:[]});assert.equal((await f.send('/admin/')).status,403);assert.equal((await f.call('list')).status,403);
});
test('reserved paths cannot traverse into legacy routes or expose bootstrap/recovery operators',async t=>{
  const f=await fixture(t);
  for(const path of ['/admin/../api/jobs','/admin/%2e%2e/.env','/admin//app.js','/admin/app.js?token=ignored'])assert.ok([403,404].includes((await f.send(path,{token:USER})).status));
  for(const action of ['stage/bootstrap','recover','native/token','unknown'])assert.equal((await f.call(action)).status,403);
  const large=await f.send('/admin/api/list',{method:'POST',token:f.raw,headers:{'Content-Type':'application/json'},bytes:'{"x":"'+'x'.repeat(33000)+'"}'});assert.equal(large.status,403);
});
test('WebAuthn enrollment/login, owner reauthentication and revocation work under the new prefix',async t=>{
  const f=await fixture(t);
  assert.equal((await f.call('invite',{role:'owner'})).status,403);
  const invited=await f.call('invite',{role:'admin',grant:await f.grant()});assert.equal(invited.status,200);
  const key=new Authenticator(),begin=await f.call('register/begin',{ticket:invited.data.enrollmentTicket},'');assert.equal(begin.status,200);
  assert.equal((await f.call('register/finish',{ceremonyId:begin.data.ceremonyId,response:key.register(begin.data.options,{rp:rpID,client:{origin}})},'')).status,200);
  const login=await f.call('login/begin',{},'');const result=await f.call('login/finish',{ceremonyId:login.data.ceremonyId,response:key.login(login.data.options,{rp:rpID,client:{origin}})},'');const raw=result.data.sessionToken;
  assert.equal((await f.call('list',{},raw)).data.me.role,'admin');
  const ownGrant=await f.grant('manage',raw,key);assert.equal((await f.call('invite',{role:'owner',grant:ownGrant},raw)).status,403);
  const changed=await f.call('role',{userId:invited.data.userId,role:'auditor',grant:await f.grant()});assert.equal(changed.status,200);assert.equal((await f.call('list',{},raw)).status,403);
  assert.equal((await f.call('credential/revoke',{credentialId:key.id,grant:await f.grant('credential')})).status,200);
  const challenge=await f.call('login/begin',{},'');assert.equal((await f.call('login/finish',{ceremonyId:challenge.data.ceremonyId,response:key.login(challenge.data.options,{rp:rpID,client:{origin}})},'')).status,403);
  const audit=JSON.stringify(await f.auth.all('SELECT at,operation,success FROM audit'));for(const secret of [raw,f.raw,invited.data.enrollmentTicket])assert.ok(!audit.includes(secret));
});
test('anonymous requests cannot consume authenticated admin limits',async t=>{
  const f=await fixture(t);for(let i=0;i<30;i++)assert.equal((await f.call('list',{},USER)).status,403);
  assert.equal((await f.call('list',{},USER)).status,429);assert.equal((await f.call('list')).status,200);assert.equal((await f.send('/api/jobs',{token:USER})).status,200);
});
test('mount rejects an already started or ambiguous request handler without removing it',async t=>{
  const f=await fixture(t,{mode:'preview'});const n=f.server.listeners('request').length;assert.throws(()=>mountAdminConsole(f.server,createAdminConsole()));assert.equal(f.server.listeners('request').length,n);
});

test('bulk account purge is routed through the protected console prefix and rejects cross-origin requests',async t=>{
  const f=await fixture(t),a=await f.call('invite',{role:'admin',grant:await f.grant()}),b=await f.call('invite',{role:'auditor',grant:await f.grant()});
  const body={userIds:[a.data.userId,b.data.userId],grant:await f.grant('cleanup')};
  assert.equal((await f.send('/admin/api/accounts/purge',{method:'POST',token:f.raw,body,headers:{Origin:'https://attacker.example'}})).status,403);
  assert.equal((await f.call('accounts/purge',body,'')).status,403);
  const deleted=await f.call('accounts/purge',body);assert.equal(deleted.status,200);assert.equal(deleted.data.accounts,2);
  assert.equal((await f.call('list')).data.users.length,1);assert.equal((await f.call('list')).data.me.role,'owner');
});
test('a second mount is rejected before listening and the first handler remains intact',()=>{
  const server=createServer((_req,res)=>res.end('legacy'));mountAdminConsole(server,createAdminConsole());const listener=server.listeners('request')[0];
  assert.throws(()=>mountAdminConsole(server,createAdminConsole()));assert.equal(server.listeners('request').length,1);assert.equal(server.listeners('request')[0],listener);
});
test('an administrator handler failure is contained and the legacy server stays available',async t=>{
  const f=await fixture(t,{mode:'preview',handlerOverride:{handle(){throw Error('private-diagnostic');}}});
  const failed=await f.send('/admin/');assert.equal(failed.status,503);assert.deepEqual(failed.data,{code:'ADMIN_UNAVAILABLE'});assert.ok(!failed.text.includes('private-diagnostic'));
  assert.equal((await f.send('/api/jobs',{token:USER})).status,200);
});
