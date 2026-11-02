import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {mkdir,mkdtemp,open,readFile,writeFile,stat} from 'node:fs/promises';
import {pgliteStore} from './test-support.mjs';
import {StagingAdminAuth} from './auth.mjs';
import {StagingNativeAuthorization,pkce} from './native.mjs';
import {Authenticator} from '../test/software-authenticator.mjs';
import {stageConfig} from './config.mjs';
import {prepareSQL} from './store.mjs';
import {createStagingServer} from './server.mjs';
import {request} from 'node:http';
import {recoverToFile} from './recovery-file.mjs';
import {StagingRateLimits,sourceResolver} from './rate-limit.mjs';
const origin='https://diana-admin-passkey-stage.onrender.com',rpID=new URL(origin).hostname,redirect='kr.nightdesk.phone.lab.passkey.stage://oauth2/callback';
const random=()=>randomBytes(32).toString('base64url');
async function setup(t){let now=Date.now();const store=await pgliteStore();t.after(()=>store.close());const auth=new StagingAdminAuth({store,origin,rpID,now:()=>now});
  const call=(action,body={},raw)=>auth.dispatch(action,body,raw);
  const enroll=async(ticket,key=new Authenticator())=>{const c=await call('register/begin',{ticket});const r=await call('register/finish',{ceremonyId:c.ceremonyId,response:key.register(c.options,{rp:rpID,client:{origin}})});return{...r,key};};
  const login=async(key,raw,scope)=>{const c=await call('login/begin',scope?{scope}:{},raw);return call('login/finish',{ceremonyId:c.ceremonyId,response:key.login(c.options,{rp:rpID,client:{origin}})},raw);};
  const owner=await enroll((await auth.bootstrap()).enrollmentTicket),session=(await login(owner.key)).sessionToken;
  const grant=async(scope='manage',raw=session,key=owner.key)=>(await login(key,raw,scope)).grant;
  const invite=async role=>{const r=await call('invite',{role,grant:await grant()},session);return enroll(r.enrollmentTicket);};
  const native=new StagingNativeAuthorization(auth,redirect),verifier=random(),params={client_id:'diana-lab-android',redirect_uri:redirect,response_type:'code',code_challenge_method:'S256',code_challenge:pkce(verifier),state:random()};
  const issue=async(raw=session)=>new URL((await native.approve({requestId:await native.begin(params)},raw)).redirect).searchParams.get('code');
  const exchange=code=>native.exchange({grant_type:'authorization_code',code,code_verifier:verifier,client_id:params.client_id,redirect_uri:redirect});
  return{store,auth,call,enroll,login,owner,session,grant,invite,native,params,issue,exchange,advance:ms=>now+=ms};
}
test('PostgreSQL async WebAuthn registration, login and native PKCE retain authentication provenance',async t=>{
  const f=await setup(t);assert.equal((await f.call('list',{},f.session)).me.role,'owner');const source=await f.auth.session(f.session),code=await f.issue();f.advance(50000);const issued=await f.exchange(code),native=await f.auth.session(issued.access_token);
  assert.equal(issued.expires_in,850);assert.equal(native.expires,source.expires);assert.equal(native.webauthn_at,source.webauthn_at);await assert.rejects(f.issue(issued.access_token));await assert.rejects(f.exchange(code));
});
test('PostgreSQL roles and revocations invalidate already issued native sessions',async t=>{
  const f=await setup(t),admin=await f.invite('admin'),raw=(await f.login(admin.key)).sessionToken,token=(await f.exchange(await f.issue(raw))).access_token;
  await f.call('role',{userId:admin.userId,role:'auditor',grant:await f.grant()},f.session);await assert.rejects(f.auth.session(token));await assert.rejects(f.call('invite',{role:'owner'},raw));
  const next=(await f.login(admin.key)).sessionToken;assert.equal((await f.auth.session(next)).role,'auditor');await f.call('credential/revoke',{credentialId:admin.credentialId,grant:await f.grant('credential')},f.session);await assert.rejects(f.auth.session(next));await assert.rejects(f.login(admin.key));
});
test('PostgreSQL enforces reauthentication scope, last owner and offline recovery',async t=>{
  const f=await setup(t);await assert.rejects(f.call('invite',{role:'admin'},f.session));await assert.rejects(f.call('disable',{userId:f.owner.userId,grant:await f.grant()},f.session));await assert.rejects(f.call('role',{userId:f.owner.userId,role:'admin',grant:await f.grant()},f.session));
  const codes=(await f.call('recovery/codes',{grant:await f.grant('recovery')},f.session)).recoveryCodes;await assert.rejects(f.auth.recoverOffline(f.owner.userId,'forged'));const ticket=(await f.auth.recoverOffline(f.owner.userId,codes[0])).enrollmentTicket;await assert.rejects(f.auth.recoverOffline(f.owner.userId,codes[0]));await assert.rejects(f.auth.session(f.session));
  const restored=await f.enroll(ticket);assert.equal((await f.auth.session((await f.login(restored.key)).sessionToken)).role,'owner');await assert.rejects(f.auth.recoverOffline(f.owner.userId,codes[1]));
});
test('PostgreSQL consumes concurrent assertion replay exactly once',async t=>{const f=await setup(t),c=await f.call('login/begin'),response=f.owner.key.login(c.options,{rp:rpID,client:{origin}});const r=await Promise.allSettled([f.call('login/finish',{ceremonyId:c.ceremonyId,response}),f.call('login/finish',{ceremonyId:c.ceremonyId,response})]);assert.equal(r.filter(x=>x.status==='fulfilled').length,1);});
for(const [name,tweak]of Object.entries({origin:{client:{origin:'http://localhost:43871'}},rp:{rp:'localhost'},uv:{flags:1},signature:{badSignature:true},crossOrigin:{client:{origin,crossOrigin:true}}}))test('PostgreSQL rejects '+name,async t=>{
  const f=await setup(t),c=await f.call('login/begin');await assert.rejects(f.call('login/finish',{ceremonyId:c.ceremonyId,response:f.owner.key.login(c.options,{rp:rpID,client:{origin},...tweak})}));
});
test('PostgreSQL challenge, grant and absolute deadlines are enforced',async t=>{const f=await setup(t),c=await f.call('login/begin'),r=f.owner.key.login(c.options,{rp:rpID,client:{origin}});f.advance(120001);await assert.rejects(f.call('login/finish',{ceremonyId:c.ceremonyId,response:r}));f.advance(780000);await assert.rejects(f.auth.session(f.session));});
test('PostgreSQL files preserve credentials, metadata and revoked state after reopen',async()=>{
  const dir=resolve(import.meta.dirname,'../generated/staging-persistence',random());await mkdir(dir,{recursive:true});let store=await pgliteStore({dataDir:dir});let auth=new StagingAdminAuth({store,origin,rpID});const key=new Authenticator(),ticket=(await auth.bootstrap()).enrollmentTicket,c=await auth.dispatch('register/begin',{ticket});await auth.dispatch('register/finish',{ceremonyId:c.ceremonyId,response:key.register(c.options,{rp:rpID,client:{origin}})});
  const l=await auth.dispatch('login/begin'),raw=(await auth.dispatch('login/finish',{ceremonyId:l.ceremonyId,response:key.login(l.options,{rp:rpID,client:{origin}})})).sessionToken;const metadata=await store.get('SELECT instance_id FROM staging_metadata WHERE id=1');await auth.dispatch('logout',{},raw);await store.close();
  store=await pgliteStore({dataDir:dir});auth=new StagingAdminAuth({store,origin,rpID});try{assert.equal((await store.get('SELECT instance_id FROM staging_metadata WHERE id=1')).instance_id,metadata.instance_id);assert.equal((await store.get('SELECT COUNT(*) n FROM credentials')).n,1);await assert.rejects(auth.session(raw));}finally{await store.close();}
});
test('SQL namespace and placeholders never rewrite quoted literals',()=>{assert.equal(prepareSQL("SELECT * FROM users WHERE role='users?' AND id=?"),"SELECT * FROM diana_admin_stage_v1.users WHERE role='users?' AND id=$1");});
test('PostgreSQL numeric-looking credential IDs remain text',async t=>{const f=await setup(t),row=await f.store.get("SELECT '123456'::text AS id,12::bigint AS counter");assert.equal(row.id,'123456');assert.equal(row.counter,12);});
test('staging config requires explicit HTTPS origin, matching RP ID and dedicated DB',()=>{
  const env={DIANA_STAGE:'admin-passkey',ADMIN_ORIGIN:origin,ADMIN_RP_ID:rpID,ADMIN_DATABASE_URL:'postgresql://stage:fake@db.example/diana_admin_stage',ADMIN_BOOTSTRAP_SHA256:'a'.repeat(64)};assert.equal(stageConfig(env).rpID,rpID);
  for(const patch of [{DIANA_STAGE:''},{ADMIN_ORIGIN:'http://localhost:43871'},{ADMIN_RP_ID:'localhost'},{ADMIN_DATABASE_URL:'postgres://user:fake@db.example/production'},{ADMIN_DATABASE_URL:'postgres://user:fake@db.example/diana_admin_stage?sslmode=no-verify'},{ADMIN_BOOTSTRAP_SHA256:''}])assert.throws(()=>stageConfig({...env,...patch}));
  assert.throws(()=>stageConfig({...env,ADMIN_DATABASE_TRANSPORT:'render-private'}));
  assert.throws(()=>stageConfig({...env,RENDER:'true',ADMIN_DATABASE_TRANSPORT:'render-private'}));
  assert.throws(()=>stageConfig({...env,ADMIN_DATABASE_TRANSPORT:'insecure'}));
  assert.equal(stageConfig({...env,RENDER:'true',ADMIN_DATABASE_TRANSPORT:'render-private',ADMIN_DATABASE_URL:'postgres://stage:fake@dpg-dbk9huuc6qcc73duefng-a/diana_admin_stage'}).privateNetwork,true);
  assert.throws(()=>stageConfig({...env,ADMIN_TRUSTED_PROXY_IPS:'*'}));
});
test('HTTPS proxy, Host, Origin and initial administrator capability are enforced over HTTP',async t=>{
  const token=random(),bootstrapHash=createHash('sha256').update(token).digest('hex'),store=await pgliteStore({bootstrapHash}),auth=new StagingAdminAuth({store,origin,rpID});
  const config={origin,rpID,androidRedirect:redirect},server=createStagingServer(auth,config);await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await store.close();});
  const base='http://127.0.0.1:'+server.address().port;
  const post=(action,body={},extra={})=>new Promise((resolve,reject)=>{const req=request(base+'/api/'+action,{method:'POST',headers:{Host:rpID,'X-Forwarded-Proto':'https',Origin:origin,'Content-Type':'application/json',...extra}},res=>{const parts=[];res.on('data',b=>parts.push(b));res.on('end',()=>resolve({status:res.statusCode,json:async()=>JSON.parse(Buffer.concat(parts).toString())}));});req.on('error',reject);req.end(JSON.stringify(body));});
  assert.equal((await fetch(base+'/healthz')).status,200);
  assert.equal((await post('stage/bootstrap',{token},{'X-Forwarded-Proto':'http'})).status,403);
  assert.equal((await post('stage/bootstrap',{token},{Host:'evil.example'})).status,403);
  assert.equal((await post('stage/bootstrap',{token},{Origin:'http://localhost:43871'})).status,403);
  assert.equal((await post('stage/bootstrap',{token:'forged'})).status,403);
  const bootstrap=await post('stage/bootstrap',{token});assert.equal(bootstrap.status,200);const ticket=(await bootstrap.json()).enrollmentTicket;
  const begin=await(await post('register/begin',{ticket})).json(),key=new Authenticator();
  assert.equal((await post('register/finish',{ceremonyId:begin.ceremonyId,response:key.register(begin.options,{rp:rpID,client:{origin}})})).status,200);
  assert.equal((await post('stage/bootstrap',{token})).status,403);
  const c=await(await post('login/begin')).json(),signed=key.login(c.options,{rp:rpID,client:{origin}}),login=await(await post('login/finish',{ceremonyId:c.ceremonyId,response:signed})).json();
  const headers={Authorization:'Bearer '+login.sessionToken};assert.equal((await post('native/status',{},headers)).status,200);
  const persisted=await(await post('stage/persistence',{},headers)).json();assert.equal(persisted.instance.length,32);
  const audit=JSON.stringify(await store.all('SELECT * FROM audit'));assert.ok(!audit.includes(token));assert.ok(!audit.includes(login.sessionToken));assert.ok(!audit.includes(ticket));
  assert.equal((await post('recover',{token})).status,403);
});

test('recovery output reservation and write/sync/close failures preserve every recovery code, key and session',async t=>{
  const f=await setup(t),codes=(await f.call('recovery/codes',{grant:await f.grant('recovery')},f.session)).recoveryCodes;
  const dir=await mkdtemp(resolve(import.meta.dirname,'../generated/recovery-file-')),existing=resolve(dir,'existing.json');await writeFile(existing,'keep existing file');
  const input={userId:f.owner.userId,recoveryCode:codes[0],outputPath:existing};
  const unchanged=async()=>{
    assert.equal((await f.store.get('SELECT COUNT(*) n FROM recovery WHERE user_id=?',f.owner.userId)).n,2);
    assert.equal((await f.store.get("SELECT COUNT(*) n FROM credentials WHERE user_id=? AND state='active'",f.owner.userId)).n,1);
    assert.equal((await f.auth.session(f.session)).role,'owner');
    assert.equal((await f.store.get("SELECT COUNT(*) n FROM tickets WHERE kind='recovery'")).n,0);
  };
  await assert.rejects(recoverToFile(f.auth,input),{code:'EEXIST'});await unchanged();assert.equal(await readFile(existing,'utf8'),'keep existing file');
  await assert.rejects(recoverToFile(f.auth,{...input,outputPath:resolve(dir,'missing','ticket.json')}),{code:'ENOENT'});await unchanged();
  await assert.rejects(recoverToFile(f.auth,input,{openFile:async()=>{throw Object.assign(Error('permission denied'),{code:'EACCES'});}}),{code:'EACCES'});await unchanged();
  for(const [index,failed]of ['writeFile','sync','close'].entries()){
    const outputPath=resolve(dir,failed+'.json');let closed=false;
    const openFile=async(...args)=>{const file=await open(...args);return{
      async writeFile(data,encoding){if(failed==='writeFile'){await file.writeFile(data.slice(0,12),encoding);throw Object.assign(Error('disk full'),{code:'ENOSPC'});}return file.writeFile(data,encoding);},
      async sync(){if(failed==='sync')throw Error('SYNC_FAILED');return file.sync();},
      async close(){await file.close();closed=true;if(failed==='close')throw Error('CLOSE_FAILED');}
    };};
    await assert.rejects(recoverToFile(f.auth,{...input,recoveryCode:codes[index%2],outputPath},{openFile}));assert.equal(closed,true);
    await assert.rejects(stat(outputPath),{code:'ENOENT'});await unchanged();
  }
  const outputPath=resolve(dir,'success.json'),result=await recoverToFile(f.auth,{...input,outputPath});assert.deepEqual(JSON.parse(await readFile(outputPath,'utf8')),result);
  assert.equal((await f.store.get('SELECT COUNT(*) n FROM recovery WHERE user_id=?',f.owner.userId)).n,1);await assert.rejects(f.auth.session(f.session));await assert.rejects(f.login(f.owner.key));
  const restored=await f.enroll(result.enrollmentTicket);assert.equal((await f.auth.session((await f.login(restored.key)).sessionToken)).role,'owner');
  await assert.rejects(f.auth.recoverOffline(f.owner.userId,codes[0]));
});

test('source limits isolate callers, verified accounts and request classes with bounded expiry',()=>{
  let now=100000;const limits=new StagingRateLimits({now:()=>now,maxSources:2});
  for(let i=0;i<120;i++)assert.equal(limits.allow('read','source-a'),true);
  assert.equal(limits.allow('read','source-a'),false);assert.equal(limits.allow('read','source-b'),true);
  assert.equal(limits.allow('anonymous','source-a'),true);assert.equal(limits.allow('administrator','owner-a'),true);
  for(let i=0;i<29;i++)assert.equal(limits.allow('anonymous','source-a'),true);
  assert.equal(limits.allow('anonymous','source-a'),false);assert.equal(limits.allow('anonymous','source-b'),true);
  assert.equal(limits.allow('read','source-c'),false);assert.equal(limits.allow('administrator','owner-b'),true);
  now+=60000;assert.equal(limits.allow('read','source-c'),true);assert.equal(limits.allow('anonymous','source-a'),true);
});

test('source identity ignores forged forwarding headers unless every skipped proxy is explicitly trusted',()=>{
  const req=(peer,forwarded)=>({socket:{remoteAddress:peer},headers:{'x-forwarded-for':forwarded}});
  const direct=sourceResolver();assert.equal(direct(req('::ffff:192.0.2.9','198.51.100.8')),'192.0.2.9');assert.equal(direct(req('192.0.2.9','malformed')),'192.0.2.9');
  const proxy=sourceResolver(['10.0.0.2','10.0.0.3']);
  assert.equal(proxy(req('10.0.0.2','203.0.113.99, 192.0.2.9, 10.0.0.3')),'192.0.2.9');
  assert.equal(proxy(req('198.51.100.8','203.0.113.99')),'198.51.100.8');
  assert.equal(proxy(req('10.0.0.2','malformed, 192.0.2.9')),'10.0.0.2');assert.throws(()=>sourceResolver(['not-an-ip']));
  assert.equal(direct(req('2001:0db8:0:0:0:0:0:1','192.0.2.1')),'2001:db8::1');
});

test('anonymous HTTP floods cannot exhaust owner status, management or a new login ceremony',async t=>{
  const f=await setup(t),config={origin,rpID,androidRedirect:redirect},server=createStagingServer(f.auth,config);await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
  const send=(path,{method='GET',body={},token,forwarded}={})=>new Promise((resolve,reject)=>{
    const req=request({hostname:'127.0.0.1',port:server.address().port,path,method,headers:{Host:rpID,'X-Forwarded-Proto':'https',Origin:origin,'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...(forwarded?{'X-Forwarded-For':forwarded}:{})}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end(method==='POST'?JSON.stringify(body):undefined);
  });
  for(let i=0;i<120;i++)assert.equal(await send('/'),200);
  assert.equal(await send('/'),429);assert.equal(await send('/',{forwarded:'203.0.113.1'}),429);
  assert.equal(await send('/healthz'),200);assert.equal(await send('/api/login/begin',{method:'POST'}),200);
  for(let i=0;i<29;i++)assert.equal(await send('/api/list',{method:'POST',token:random()}),403);
  assert.equal(await send('/api/list',{method:'POST',token:random()}),429);
  assert.equal(await send('/api/native/status',{method:'POST',token:f.session}),200);
  assert.equal(await send('/api/list',{method:'POST',token:f.session}),200);
  assert.equal(await send('/api/invite',{method:'POST',token:f.session,body:{role:'admin',grant:await f.grant()}}),200);
  assert.equal(await send('/api/invite',{method:'POST',token:random(),body:{role:'owner'}}),429);
  assert.equal(await send('/api/native/status',{method:'POST',token:f.session}),200);
});

test('HTTP authentication limits distinguish client IPs behind an explicitly trusted proxy',async t=>{
  const f=await setup(t),server=createStagingServer(f.auth,{origin,rpID,androidRedirect:redirect,trustedProxyIPs:['127.0.0.1']});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
  const begin=forwarded=>new Promise((resolve,reject)=>{
    const req=request({hostname:'127.0.0.1',port:server.address().port,path:'/api/login/begin',method:'POST',headers:{Host:rpID,'X-Forwarded-Proto':'https',Origin:origin,'Content-Type':'application/json','X-Forwarded-For':forwarded}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end('{}');
  });
  for(let i=0;i<30;i++)assert.equal(await begin('192.0.2.1'),200);
  assert.equal(await begin('192.0.2.1'),429);
  assert.equal(await begin('198.51.100.99, 192.0.2.1'),429); // Attacker-controlled left prefix is not a new source.
  assert.equal(await begin('192.0.2.2'),200);
});
