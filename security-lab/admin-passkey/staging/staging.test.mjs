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
import {startSessionCleanup} from './session-cleanup.mjs';
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
  for(let i=0;i<120;i++)assert.equal(await send('/admin/'),200);
  assert.equal(await send('/admin/'),429);assert.equal(await send('/admin/',{forwarded:'203.0.113.1'}),429);
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

test('connected console assets use the existing staging origin, auth API and test database',async t=>{
  const f=await setup(t),server=createStagingServer(f.auth,{origin,rpID,androidRedirect:redirect});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
  const send=(path,{method='GET',body,headers={}}={})=>new Promise((resolve,reject)=>{
    const req=request({hostname:'127.0.0.1',port:server.address().port,path,method,headers:{Host:rpID,'X-Forwarded-Proto':'https',Origin:origin,...(body?{'Content-Type':'application/json'}:{}),...headers}},res=>{const parts=[];res.on('data',b=>parts.push(b));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text:Buffer.concat(parts).toString()}));});req.on('error',reject);req.end(body?JSON.stringify(body):undefined);
  });
  const cfg=await send('/admin/config.json');assert.equal(cfg.status,200);assert.deepEqual(JSON.parse(cfg.text),{configured:true,basePath:'/admin/',apiBasePath:'/api/',origin,rpID,documentAccess:false});
  assert.ok(!cfg.text.includes(f.session));const page=await send('/admin/');assert.match(page.text,/<title>DIANA 관리자<\/title>/);assert.match(page.headers['content-security-policy'],/style-src 'self'/);
  const root=await send('/');assert.equal(root.status,308);assert.equal(root.headers.location,'/admin/');assert.equal((await send('/app.js')).status,403);
  assert.equal((await send('/admin/browser.js')).text,(await send('/browser.js')).text);
  assert.equal((await send('/admin/app.js')).text,await readFile(new URL('../../../admin-console/ui/app.js',import.meta.url),'utf8'));
  const state=await send('/api/list',{method:'POST',body:{},headers:{Authorization:'Bearer '+f.session}});assert.equal(state.status,200);assert.equal(JSON.parse(state.text).me.id,f.owner.userId);
  const canonical=await send('/admin');assert.equal(canonical.status,308);assert.equal(canonical.headers.location,'/admin/');
  assert.equal((await send('/admin/',{headers:{Host:'attacker.example'}})).status,403);
  assert.equal((await send('/admin/config.json',{headers:{'X-Forwarded-Proto':'http'}})).status,403);
});
test('console integration adds no alternate bootstrap, recovery or native API paths',async t=>{
  const f=await setup(t),server=createStagingServer(f.auth,{origin,rpID,androidRedirect:redirect});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
  const send=path=>new Promise((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port:server.address().port,path,method:'POST',headers:{Host:rpID,'X-Forwarded-Proto':'https',Origin:origin,'Content-Type':'application/json',Authorization:'Bearer '+f.session}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end('{}');});
  for(const path of ['/admin/api/stage/bootstrap','/admin/api/recover','/admin/api/native/token','/admin/api/list'])assert.equal(await send(path),403);
  assert.equal((await f.auth.session(f.session)).role,'owner');assert.equal((await f.store.get("SELECT COUNT(*) n FROM credentials WHERE state='active'")).n,1);
});

test('bulk account purge removes linked credentials, web/native sessions and capabilities, preserving owner and unselected accounts',async t=>{
  const f=await setup(t),admin=await f.invite('admin'),other=await f.invite('auditor');
  const raw=(await f.login(admin.key)).sessionToken,issued=(await f.exchange(await f.issue(raw))).access_token,code=await f.issue(raw);
  const oldTicket=await f.auth.issueTicket(admin.userId,'invite');
  await f.call('recovery/codes',{grant:await f.grant('recovery',raw,admin.key)},raw);
  await f.grant('credential',raw,admin.key);await f.call('login/begin',{scope:'manage'},raw);
  const pending=await f.call('invite',{role:'admin',grant:await f.grant()},f.session);
  const grant=await f.grant('cleanup'),before=await f.store.get('SELECT * FROM users WHERE id=?',f.owner.userId);
  const ownerKey=await f.store.get('SELECT * FROM credentials WHERE user_id=?',f.owner.userId);
  const ownerSession=await f.auth.session(f.session);
  const result=await f.call('accounts/purge',{userIds:[admin.userId,pending.userId],grant},f.session);
  assert.deepEqual(result,{deleted:true,accounts:2,credentials:1,sessions:2});
  for(const table of ['users','credentials','sessions','tickets','challenges','recovery']){
    const column=table==='users'?'id':'user_id';assert.equal((await f.store.get('SELECT COUNT(*) n FROM '+table+' WHERE '+column+' IN (?,?)',admin.userId,pending.userId)).n,0);
  }
  assert.equal((await f.store.get('SELECT COUNT(*) n FROM session_authentication m LEFT JOIN sessions s ON s.hash=m.session_hash WHERE s.hash IS NULL')).n,0);
  assert.equal((await f.store.get('SELECT COUNT(*) n FROM native_codes c LEFT JOIN sessions s ON s.hash=c.source WHERE s.hash IS NULL')).n,0);
  assert.equal((await f.store.get('SELECT COUNT(*) n FROM grants g LEFT JOIN sessions s ON s.hash=g.session_hash WHERE s.hash IS NULL')).n,0);
  assert.deepEqual(await f.store.get('SELECT * FROM users WHERE id=?',f.owner.userId),before);
  assert.deepEqual(await f.store.get('SELECT * FROM credentials WHERE user_id=?',f.owner.userId),ownerKey);
  assert.deepEqual(await f.auth.session(f.session),ownerSession);
  assert.ok(await f.store.get('SELECT id FROM users WHERE id=?',other.userId));
  for(const token of [raw,issued])await assert.rejects(f.auth.session(token));
  await assert.rejects(f.login(admin.key));await assert.rejects(f.exchange(code));await assert.rejects(f.call('register/begin',{ticket:oldTicket}));
  const audit=await f.store.all("SELECT * FROM audit WHERE operation='accounts/purge' AND success=1");assert.equal(audit.length,1);
  assert.deepEqual(Object.keys(audit[0]).sort(),['at','id','operation','success']);
  assert.ok(!JSON.stringify(audit).includes(admin.userId));
  await assert.rejects(f.call('accounts/purge',{userIds:[other.userId],grant},f.session));
});

test('bulk purge rejects missing, duplicate, oversized or owner-containing targets atomically',async t=>{
  const f=await setup(t),admin=await f.invite('admin'),owner2=await f.invite('owner');
  for(const ids of [[],null,'all',[admin.userId,admin.userId],Array(51).fill(admin.userId),[admin.userId,'missing'],[admin.userId,'00000000-0000-4000-8000-000000000000'],[admin.userId,f.owner.userId],[admin.userId,owner2.userId]]){
    await assert.rejects(f.call('accounts/purge',{userIds:ids,grant:await f.grant('cleanup')},f.session));
    assert.ok(await f.store.get('SELECT id FROM users WHERE id=?',admin.userId));assert.equal((await f.auth.session(f.session)).role,'owner');
  }
});

test('bulk purge requires an active owner, matching cleanup scope and an unexpired one-use reauthentication',async t=>{
  const f=await setup(t),admin=await f.invite('admin'),raw=(await f.login(admin.key)).sessionToken,target=await f.invite('auditor');
  for(const token of [undefined,random(),raw])await assert.rejects(f.call('accounts/purge',{userIds:[target.userId],grant:await f.grant('cleanup')},token));
  for(const grant of [undefined,random(),await f.grant('manage'),await f.grant('cleanup',raw,admin.key)])await assert.rejects(f.call('accounts/purge',{userIds:[target.userId],grant},f.session));
  const expired=await f.grant('cleanup');f.advance(60001);await assert.rejects(f.call('accounts/purge',{userIds:[target.userId],grant:expired},f.session));
  const grant=await f.grant('cleanup');await f.call('role',{userId:target.userId,role:'owner',grant:await f.grant()},f.session);
  await assert.rejects(f.call('accounts/purge',{userIds:[target.userId],grant},f.session));assert.ok(await f.store.get("SELECT id FROM users WHERE id=? AND role='owner'",target.userId));
});

test('bulk purge rolls back every deletion and grant consumption on write or audit failure',async t=>{
  const f=await setup(t),a=await f.invite('admin'),b=await f.invite('auditor');
  for(const failed of ['second-account','success-audit']){
    const grant=await f.grant('cleanup'),original=f.store.run.bind(f.store);let deleted=0;
    f.store.run=async(sql,...args)=>{if(failed==='second-account'&&sql==='DELETE FROM users WHERE id=?'&&++deleted===2)throw Error('INJECTED');if(failed==='success-audit'&&sql.startsWith('INSERT INTO audit')&&args[1]==='accounts/purge'&&args[2]===1)throw Error('INJECTED');return original(sql,...args);};
    try{await assert.rejects(f.call('accounts/purge',{userIds:[a.userId,b.userId],grant},f.session));}finally{f.store.run=original;}
    for(const id of [a.userId,b.userId]){assert.ok(await f.store.get('SELECT id FROM users WHERE id=?',id));assert.equal((await f.store.get('SELECT COUNT(*) n FROM credentials WHERE user_id=?',id)).n,1);}
    assert.ok(await f.store.get('SELECT hash FROM grants WHERE hash=?',createHash('sha256').update(grant).digest('hex')));
  }
});

test('concurrent purge retries commit once and do not affect the owner',async t=>{
  const f=await setup(t),a=await f.invite('admin'),b=await f.invite('auditor'),grant=await f.grant('cleanup');
  const results=await Promise.allSettled([1,2].map(()=>f.call('accounts/purge',{userIds:[a.userId,b.userId],grant},f.session)));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal((await f.store.get('SELECT COUNT(*) n FROM users')).n,1);assert.equal((await f.auth.session(f.session)).role,'owner');
});

test('expired session cleanup removes dependencies but keeps live sessions, keys, accounts and recovery hashes',async t=>{
  const f=await setup(t),oldSession=await f.auth.session(f.session),admin=await f.invite('admin');
  const raw=(await f.login(admin.key)).sessionToken,native=(await f.exchange(await f.issue(raw))).access_token,code=await f.issue(raw);
  const grant=await f.grant(),ticket=await f.auth.issueTicket(admin.userId,'invite',oldSession.hash);
  await f.call('login/begin',{scope:'manage'},f.session);
  await f.call('recovery/codes',{grant:await f.grant('recovery')},f.session);
  const users=await f.store.all('SELECT * FROM users ORDER BY id'),keys=await f.store.all('SELECT * FROM credentials ORDER BY id'),recovery=await f.store.all('SELECT * FROM recovery');
  f.advance(900000);await assert.rejects(f.auth.session(f.session));
  const current=(await f.login(f.owner.key)).sessionToken,live=await f.auth.session(current),liveGrant=await f.grant('manage',current),pending=await f.call('invite',{role:'auditor',grant:liveGrant},current);
  const loginChallenge=await f.call('login/begin',{scope:'manage'},current),request=random();
  await f.store.run('INSERT INTO native_requests VALUES(?,?,?,?,?,?)',request,f.params.client_id,redirect,f.params.state,f.params.code_challenge,f.auth.now()+120000);
  const result=await f.auth.cleanupExpired();assert.equal(result.sessions,3);assert.equal(result.authentication,3);
  assert.ok(result.nativeCodes>0);assert.ok(result.tickets>0);assert.ok(result.challenges>0);assert.ok(result.grants>0);
  assert.deepEqual(await f.auth.session(current),live);assert.ok(await f.store.get('SELECT id FROM challenges WHERE id=?',loginChallenge.ceremonyId));
  assert.ok(await f.store.get('SELECT id FROM native_requests WHERE id=?',request));assert.ok(await f.store.get('SELECT id FROM users WHERE id=?',pending.userId));
  assert.equal((await f.store.get('SELECT COUNT(*) n FROM tickets WHERE user_id=?',pending.userId)).n,1);
  for(const token of [f.session,raw,native])await assert.rejects(f.auth.session(token));
  await assert.rejects(f.exchange(code));await assert.rejects(f.call('register/begin',{ticket}));await assert.rejects(f.call('invite',{role:'admin',grant},current));
  for(const user of users)assert.deepEqual(await f.store.get('SELECT * FROM users WHERE id=?',user.id),user);
  for(const key of keys){const actual=await f.store.get('SELECT * FROM credentials WHERE id=?',key.id);assert.ok(actual);assert.equal(actual.state,key.state);assert.deepEqual(actual.public_key,key.public_key);}
  assert.deepEqual(await f.store.all('SELECT * FROM recovery'),recovery);
  const audit=await f.store.all("SELECT * FROM audit WHERE operation='session/cleanup'");assert.equal(audit.length,1);assert.deepEqual(Object.keys(audit[0]).sort(),['at','id','operation','success']);
  assert.ok(!JSON.stringify(audit).includes(oldSession.hash));assert.equal((await f.auth.cleanupExpired()).sessions,0);assert.equal((await f.store.get("SELECT COUNT(*) n FROM audit WHERE operation='session/cleanup'")).n,1);
});

test('cleanup respects native absolute deadlines and preserves a live native session after its source browser logs out',async t=>{
  const f=await setup(t),token=(await f.exchange(await f.issue())).access_token;
  await f.call('logout',{},f.session);assert.equal((await f.auth.cleanupExpired()).sessions,1);assert.equal((await f.auth.session(token)).role,'owner');
  const native=await f.auth.session(token);await f.store.run('UPDATE session_authentication SET absolute_expires=? WHERE session_hash=?',f.auth.now()-1000,native.hash);
  assert.equal((await f.auth.cleanupExpired()).sessions,1);await assert.rejects(f.auth.session(token));
  const legacy=random();await f.store.run('INSERT INTO sessions VALUES(?,?,?,?,0)',createHash('sha256').update(legacy).digest('hex'),f.owner.userId,f.owner.credentialId,Date.now()+100000);
  await assert.rejects(f.auth.session(legacy));assert.equal((await f.auth.cleanupExpired()).sessions,1);
});

test('expired independent challenges, grants, tickets and native requests are swept without removing valid sessions',async t=>{
  const f=await setup(t);await f.call('login/begin');await f.grant();await f.auth.issueTicket(f.owner.userId,'invite');await f.native.begin(f.params);
  f.advance(600001);const result=await f.auth.cleanupExpired();assert.equal(result.sessions,0);assert.ok(result.challenges>0);assert.ok(result.grants>0);assert.ok(result.tickets>0);assert.ok(result.nativeRequests>0);
  assert.equal((await f.auth.session(f.session)).role,'owner');
  await assert.rejects(f.call('session/cleanup',{},f.session)); // No public operator endpoint.
});

test('expiry cleanup rolls back dependencies, parent rows and audit on database failure, then retries',async t=>{
  const f=await setup(t),source=await f.auth.session(f.session);await f.issue();await f.grant();await f.auth.issueTicket(f.owner.userId,'invite',source.hash);
  f.advance(900000);const tables=['sessions','session_authentication','native_codes','grants','tickets'];
  const before=await Promise.all(tables.map(table=>f.store.all('SELECT * FROM '+table)));
  const original=f.store.run.bind(f.store);f.store.run=async(sql,...args)=>{if(sql.startsWith('DELETE FROM sessions WHERE hash IN'))throw Error('PRIVATE_DATABASE_ERROR');return original(sql,...args);};
  try{await assert.rejects(f.auth.cleanupExpired());}finally{f.store.run=original;}
  for(let i=0;i<tables.length;i++)assert.deepEqual(await f.store.all('SELECT * FROM '+tables[i]),before[i]);
  assert.equal((await f.store.get("SELECT COUNT(*) n FROM audit WHERE operation='session/cleanup'")).n,0);
  assert.equal((await f.auth.cleanupExpired()).sessions,1);
});

test('automatic sweeper starts immediately, retries a failed tick, prevents overlap and drains on stop',async()=>{
  let tick,cleared=false,calls=0,errors=0,release;const pending=new Promise(r=>release=r);
  const auth={async cleanupExpired(){calls++;if(calls===1)throw Error('PRIVATE_ERROR');if(calls===2)await pending;return{sessions:0};}};
  const worker=await startSessionCleanup(auth,{setIntervalFn:(fn,ms)=>{assert.equal(ms,60000);tick=fn;return{unref(){}};},clearIntervalFn:()=>cleared=true,onError:(...args)=>{assert.equal(args.length,0);errors++;}});
  assert.equal(calls,1);assert.equal(errors,1);tick();await Promise.resolve();tick();assert.equal(calls,2);
  let stopped=false;const stopping=worker.stop().then(()=>stopped=true);await Promise.resolve();assert.equal(stopped,false);assert.equal(cleared,true);
  release();await stopping;tick();await Promise.resolve();assert.equal(calls,2);
});

test('session lists hide ended records before their scheduled physical cleanup',async t=>{
  const f=await setup(t),old=await f.auth.session(f.session),second=(await f.login(f.owner.key)).sessionToken;
  await f.call('logout',{},f.session);const state=await f.call('list',{},second);assert.ok(!state.sessions.some(s=>s.hash===old.hash));assert.equal(state.sessions.length,1);
  assert.equal((await f.store.get('SELECT COUNT(*) n FROM sessions')).n,2);
  await f.auth.cleanupExpired();assert.equal((await f.store.get('SELECT COUNT(*) n FROM sessions')).n,1);
});

test('each sweep bounds session deletion to 500 and leaves the active owner session intact',async t=>{
  const f=await setup(t),source=await f.auth.session(f.session);
  await f.store.run("INSERT INTO sessions SELECT 'expired-'||n,?,?,?,0 FROM generate_series(1,501) n",f.owner.userId,f.owner.credentialId,f.auth.now()-1000);
  await f.store.run("INSERT INTO session_authentication SELECT hash,?,?, 'webauthn' FROM sessions WHERE hash<>?",f.auth.now()-10000,f.auth.now()-1000,source.hash);
  assert.equal((await f.auth.cleanupExpired()).sessions,500);assert.equal((await f.store.get('SELECT COUNT(*) n FROM sessions')).n,2);
  assert.equal((await f.auth.cleanupExpired()).sessions,1);assert.deepEqual(await f.auth.session(f.session),source);
});
