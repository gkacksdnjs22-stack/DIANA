import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile} from 'node:fs/promises';
import {AdminAuth} from '../auth.mjs';
import {NativeAuthorization,pkce} from '../native.mjs';
import {createServer} from '../server.mjs';
import {Authenticator} from './software-authenticator.mjs';
const random=()=>randomBytes(32).toString('base64url'),exec=promisify(execFile);
async function setup(t){
  let now=Date.now();const auth=new AdminAuth({dbPath:path.resolve(import.meta.dirname,'../test-data',random()+'.sqlite'),now:()=>now});t.after(()=>auth.close());
  const key=new Authenticator(),ticket=auth.bootstrap().enrollmentTicket,c=await auth.dispatch('register/begin',{ticket});await auth.dispatch('register/finish',{ceremonyId:c.ceremonyId,response:key.register(c.options)});
  const login=async()=>{const c=await auth.dispatch('login/begin');return(await auth.dispatch('login/finish',{ceremonyId:c.ceremonyId,response:key.login(c.options)})).sessionToken;};
  const session=await login(),native=new NativeAuthorization(auth),verifier=random(),params={client_id:'diana-lab-android',redirect_uri:'kr.nightdesk.phone.lab.passkey://oauth2/callback',response_type:'code',code_challenge_method:'S256',code_challenge:pkce(verifier),state:random()};
  const issue=(source=session)=>{const id=native.begin(params);return new URL(native.approve({requestId:id},source).redirect).searchParams.get('code');};
  const exchange=code=>({grant_type:'authorization_code',client_id:params.client_id,redirect_uri:params.redirect_uri,code,code_verifier:verifier});
  return{auth,native,session,params,issue,exchange,login,key,advance:ms=>now+=ms};
}
test('PKCE RFC7636 vector and native authorization return state',async t=>{const f=await setup(t);assert.equal(pkce('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');const id=f.native.begin(f.params),r=new URL(f.native.approve({requestId:id},f.session).redirect);assert.equal(r.searchParams.get('state'),f.params.state);assert.throws(()=>f.native.approve({requestId:id},f.session));});
for(const [name,patch] of Object.entries({client:{client_id:'unregistered'},redirect:{redirect_uri:'https://evil.example/callback'},state:{state:'weak'},plain:{code_challenge_method:'plain'},response:{response_type:'token'},challenge:{code_challenge:'weak'}}))test('authorization rejects '+name,async t=>{const f=await setup(t);assert.throws(()=>f.native.begin({...f.params,...patch}));});
test('desktop redirect only allows exact IPv4 loopback callback and no injected query',async t=>{const f=await setup(t);for(const uri of ['http://localhost:1234/oauth2/callback','http://127.0.0.1:1234/evil','http://127.0.0.1:1234/oauth2/callback?bad=1','http://user@127.0.0.1:1234/oauth2/callback','https://evil.example/oauth2/callback'])assert.throws(()=>f.native.begin({...f.params,client_id:'diana-lab-desktop',redirect_uri:uri}));assert.ok(f.native.begin({...f.params,client_id:'diana-lab-desktop',redirect_uri:'http://127.0.0.1:1234/oauth2/callback'}));});
for(const [name,patch]of Object.entries({verifier:{code_verifier:random()},client:{client_id:'diana-lab-desktop'},redirect:{redirect_uri:'https://evil.example'},grant:{grant_type:'password'}}))test('code exchange rejects '+name+' and consumes code',async t=>{const f=await setup(t),code=f.issue();assert.throws(()=>f.native.exchange({...f.exchange(code),...patch}));assert.throws(()=>f.native.exchange(f.exchange(code)));});
test('authorization, code and fresh-login deadlines enforced',async t=>{const f=await setup(t),id=f.native.begin(f.params);f.advance(120001);assert.throws(()=>f.native.approve({requestId:id},f.session));f.session=await f.login();const id2=f.native.begin(f.params);f.advance(60001);assert.throws(()=>f.native.approve({requestId:id2},f.session));f.session=await f.login();const code=f.issue(f.session);f.advance(60001);assert.throws(()=>f.native.exchange(f.exchange(code)));});
test('native session follows credential revocation and code does not survive source logout',async t=>{const f=await setup(t),code=f.issue(),child=f.native.exchange(f.exchange(code)).access_token;assert.equal(f.auth.session(child).role,'owner');assert.throws(()=>f.native.exchange(f.exchange(code)));const pending=f.issue();await f.auth.dispatch('logout',{},f.session);assert.throws(()=>f.native.exchange(f.exchange(pending)));f.auth.run("UPDATE credentials SET state='revoked'");assert.throws(()=>f.auth.session(child));});
test('a native token cannot renew itself without another WebAuthn ceremony',async t=>{
  const f=await setup(t);let access=f.native.exchange(f.exchange(f.issue())).access_token;
  for(let elapsed=50_000;elapsed<=1_200_000;elapsed+=50_000){
    f.advance(50_000);assert.throws(()=>f.issue(access),'native session accepted as fresh WebAuthn proof');
  }
  assert.throws(()=>f.auth.session(access));
});
test('delayed and multiple exchanges inherit original WebAuthn time and absolute expiry',async t=>{
  const f=await setup(t),original=f.auth.session(f.session),code=f.issue();f.advance(50_000);
  const first=f.native.exchange(f.exchange(code));assert.equal(first.expires_in,850);
  const a=f.auth.session(first.access_token);assert.equal(a.webauthn_at,original.webauthn_at);assert.equal(a.expires,original.expires);assert.equal(a.absolute_expires,original.absolute_expires);assert.equal(a.kind,'native');
  const next=f.issue();f.advance(20_000);const second=f.native.exchange(f.exchange(next));assert.equal(second.expires_in,830);assert.equal(f.auth.session(second.access_token).expires,original.expires);
  f.advance(830_000);assert.throws(()=>f.auth.session(first.access_token));assert.throws(()=>f.auth.session(second.access_token));
  const fresh=await f.login();assert.ok(f.auth.session(fresh).webauthn_at>original.webauthn_at);assert.ok(f.issue(fresh));
});
test('native exchange cannot outlive the original absolute deadline even if session expiry is corrupted',async t=>{
  const f=await setup(t),code=f.issue(),s=f.auth.session(f.session);
  f.auth.run('UPDATE sessions SET expires=? WHERE hash=?',s.expires+900_000,s.hash);f.advance(900_000);
  assert.throws(()=>f.auth.session(f.session));assert.throws(()=>f.native.exchange(f.exchange(code)));
});
test('sessions without WebAuthn provenance are rejected including after database restart',async t=>{
  const f=await setup(t),s=f.auth.session(f.session);f.auth.run('DELETE FROM session_authentication WHERE session_hash=?',s.hash);
  assert.throws(()=>f.auth.session(f.session));assert.throws(()=>f.issue());
  const reopened=new AdminAuth({dbPath:f.auth.db.location()});try{assert.throws(()=>reopened.session(f.session));}finally{reopened.close();}
});
test('compiled EXE client completes loopback PKCE, DPAPI restore and server revocation',async t=>{
  const f=await setup(t),server=createServer(f.auth);await new Promise(r=>server.listen(43871,'127.0.0.1',r));t.after(()=>server.listening?new Promise(r=>server.close(r)):undefined);
  const stage=path.resolve(import.meta.dirname,'../generated/windows');
  const self=await exec(path.join(stage,'native/NativeProbe.exe'),['--selftest'],{windowsHide:true});assert.equal(self.stdout.trim(),'NATIVE CALLBACK CHECKS PASSED');
  await assert.rejects(exec(path.join(stage,'DIANA-LAB-PC/DIANA-LAB-PASSKEY.exe'),['--invalid'],{windowsHide:true}),e=>e.code===2);
  const store=path.join(import.meta.dirname,'../test-data',random()+'.dpapi');
  const child=spawn(path.join(stage,'native/NativeProbe.exe'),[store],{windowsHide:true,stdio:['pipe','pipe','pipe']});t.after(()=>{if(child.exitCode===null)child.kill();});
  let buffer='',lines=[],waiting;child.stdout.on('data',b=>{buffer+=b;let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i).trim();buffer=buffer.slice(i+1);if(waiting){const w=waiting;waiting=null;w(line);}else lines.push(line);}});
  const next=()=>lines.length?Promise.resolve(lines.shift()):new Promise((r,j)=>{const timer=setTimeout(()=>j(Error('NATIVE_PROBE_TIMEOUT')),15000);waiting=x=>{clearTimeout(timer);r(x);};});
  const begin=await next();assert.ok(begin.startsWith('BEGIN '));const authorize=await fetch(begin.slice(6),{redirect:'manual'});assert.equal(authorize.status,302);
  const requestId=new URL(authorize.headers.get('location'),'http://localhost:43871').searchParams.get('request');
  const callback=f.native.approve({requestId},f.session).redirect;assert.equal((await fetch(callback)).status,200);
  assert.equal(await next(),'CONNECTED owner');const encrypted=await readFile(store);assert.ok(encrypted.length>43);assert.equal(encrypted.includes(Buffer.from('access_token')),false);
  const restored=await exec(path.join(stage,'native/NativeProbe.exe'),[store,'restore'],{windowsHide:true});assert.equal(restored.stdout.trim(),'RESTORED owner');
  f.auth.run("UPDATE credentials SET state='revoked'");child.stdin.write('status\n');assert.equal(await next(),'STATUS DENIED');
  await new Promise(r=>server.close(r));child.stdin.write('status\n');assert.equal(await next(),'STATUS DENIED');child.stdin.write('exit\n');
});
