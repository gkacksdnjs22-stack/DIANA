import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash, randomBytes, sign } from 'node:crypto';
import { resolve } from 'node:path';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { AdminAuth } from '../auth.mjs';
import { createServer } from '../server.mjs';

const b64 = b => Buffer.from(b).toString('base64url');
const digest = b => createHash('sha256').update(b).digest();
// Software authenticator only: private keys never leave this test process.
class Authenticator {
  constructor() {
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    this.privateKey = pair.privateKey; this.pub = pair.publicKey.export({ format: 'jwk' });
    this.id = b64(randomBytes(32)); this.counter = 0;
  }
  data(options, type, tweaks) { return Buffer.from(JSON.stringify({ type, challenge: options.challenge, origin: 'http://localhost:43871', crossOrigin: false, ...tweaks })); }
  authData(flags, rp = 'localhost') { const count = Buffer.alloc(4); count.writeUInt32BE(this.counter); return Buffer.concat([digest(rp), Buffer.from([flags]), count]); }
  register(options, { client = {}, flags = 0x45, rp } = {}) {
    this.user = options.user.id;
    const pub = isoCBOR.encode(new Map([[1,2],[3,-7],[-1,1],[-2,Buffer.from(this.pub.x,'base64url')],[-3,Buffer.from(this.pub.y,'base64url')]]));
    const id = Buffer.from(this.id,'base64url'), len = Buffer.alloc(2); len.writeUInt16BE(id.length);
    const authData = Buffer.concat([this.authData(flags, rp),Buffer.alloc(16),len,id,pub]);
    return { id: this.id, rawId: this.id, type: 'public-key', response: { clientDataJSON: b64(this.data(options,'webauthn.create',client)),
      attestationObject: b64(isoCBOR.encode(new Map([['fmt','none'],['attStmt',new Map()],['authData',authData]]))), transports: ['internal'] }, clientExtensionResults: {} };
  }
  login(options, { client = {}, flags = 0x05, rp, badSignature = false } = {}) {
    this.counter++;
    const data = this.data(options,'webauthn.get',client), ad = this.authData(flags,rp);
    const signature = sign('sha256',Buffer.concat([ad,digest(data)]),this.privateKey);
    if (badSignature) signature[signature.length-1] ^= 1;
    return { id: this.id, rawId: this.id, type: 'public-key', response: { clientDataJSON: b64(data),authenticatorData:b64(ad),signature:b64(signature),userHandle:this.user },clientExtensionResults:{} };
  }
}
async function fixture(t) {
  let now = Date.now();
  const auth = new AdminAuth({ dbPath: resolve(import.meta.dirname,'../test-data', randomBytes(12).toString('hex')+'.sqlite'), now: () => now });
  t.after(() => auth.close());
  const call = (action, b = {}, s) => auth.dispatch(action,b,s);
  const enroll = async (ticket, key = new Authenticator()) => { const c = await call('register/begin',{ticket}); const r = await call('register/finish',{ceremonyId:c.ceremonyId,response:key.register(c.options)}); return {key,...r}; };
  const login = async (key, s, scope) => { const c = await call('login/begin', scope ? {scope} : {},s); return call('login/finish',{ceremonyId:c.ceremonyId,response:key.login(c.options)},s); };
  const first = auth.bootstrap(); const owner = await enroll(first.enrollmentTicket);
  const session = (await login(owner.key)).sessionToken;
  const grant = async (scope='manage', s=session,key=owner.key) => (await login(key,s,scope)).grant;
  const invite = async role => { const i = await call('invite',{role,grant:await grant()},session); const u = await enroll(i.enrollmentTicket); return {...u,session:(await login(u.key)).sessionToken}; };
  return {auth,call,enroll,login,owner,session,grant,invite,advance: ms => {now+=ms;}};
}

test('real ES256 WebAuthn registration, UV login, public-key-only persistence',async t=>{
  const f=await fixture(t), state=await f.call('list',{},f.session);
  assert.equal(state.me.role,'owner'); assert.equal(state.credentials.length,1);
  const row=f.auth.get('SELECT * FROM credentials'); assert.ok(row.public_key.length>0);
  assert.equal(f.auth.get('SELECT COUNT(*) n FROM sessions').n,1);
  assert.equal(f.auth.all('PRAGMA table_info(credentials)').some(x=>/private|pin|biometric/i.test(x.name)),false);
});
test('bootstrap is offline only and cannot repeat',async t=>{const f=await fixture(t);assert.throws(()=>f.auth.bootstrap());await assert.rejects(f.call('bootstrap'));await assert.rejects(f.call('register/begin',{}));});
test('owner invites an admin; normal admin cannot invite or promote',async t=>{
  const f=await fixture(t), admin=await f.invite('admin');
  assert.equal((await f.call('list',{},admin.session)).me.role,'admin');
  await assert.rejects(f.call('invite',{role:'owner',grant:await f.grant('manage',admin.session,admin.key)},admin.session));
  await assert.rejects(f.call('role',{userId:admin.userId,role:'owner',grant:await f.grant('manage',admin.session,admin.key)},admin.session));
});
test('changes require scoped, bound, one-use reauthentication',async t=>{
  const f=await fixture(t); await assert.rejects(f.call('invite',{role:'admin'},f.session));
  await assert.rejects(f.call('invite',{role:'admin',grant:await f.grant('credential')},f.session));
  const g=await f.grant(); await f.call('invite',{role:'admin',grant:g},f.session);await assert.rejects(f.call('invite',{role:'owner',grant:g},f.session));
  const g2=await f.grant();f.advance(60_001);await assert.rejects(f.call('invite',{role:'admin',grant:g2},f.session));
});
test('role change revokes existing sessions and fresh login uses current role',async t=>{
  const f=await fixture(t), admin=await f.invite('admin');
  await f.call('role',{userId:admin.userId,role:'auditor',grant:await f.grant()},f.session);
  await assert.rejects(f.call('list',{},admin.session));
  const s=(await f.login(admin.key)).sessionToken;assert.equal((await f.call('list',{},s)).me.role,'auditor');
});
test('last effective owner cannot be disabled, demoted, or lose last credential',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.call('disable',{userId:f.owner.userId,grant:await f.grant()},f.session));
  await assert.rejects(f.call('role',{userId:f.owner.userId,role:'admin',grant:await f.grant()},f.session));
  await assert.rejects(f.call('credential/revoke',{credentialId:f.owner.credentialId,grant:await f.grant('credential')},f.session));
  assert.equal((await f.call('list',{},f.session)).me.role,'owner');
});
test('pending owner invite does not allow removal of last active owner',async t=>{
  const f=await fixture(t);await f.call('invite',{role:'owner',grant:await f.grant()},f.session);
  await assert.rejects(f.call('disable',{userId:f.owner.userId,grant:await f.grant()},f.session));
});
test('credential revocation blocks login and every session minted from that credential',async t=>{
  const f=await fixture(t), admin=await f.invite('admin'), another=(await f.login(admin.key)).sessionToken;
  await f.call('credential/revoke',{credentialId:admin.credentialId,grant:await f.grant('credential')},f.session);
  await assert.rejects(f.call('list',{},admin.session)); await assert.rejects(f.call('list',{},another)); await assert.rejects(f.login(admin.key));
});
test('separate installation sessions can be revoked without deleting synced credential',async t=>{
  const f=await fixture(t), another=(await f.login(f.owner.key)).sessionToken;
  const id=f.auth.get('SELECT hash FROM sessions WHERE hash!=?',f.auth.session(f.session).hash).hash;
  await f.call('session/revoke',{sessionId:id,grant:await f.grant('credential')},f.session);
  await assert.rejects(f.call('list',{},another));assert.equal((await f.call('list',{},f.session)).credentials[0].state,'active');
});
test('reauth ceremony belongs to original session',async t=>{
  const f=await fixture(t), another=(await f.login(f.owner.key)).sessionToken;
  const c=await f.call('login/begin',{scope:'manage'},f.session);
  await assert.rejects(f.call('login/finish',{ceremonyId:c.ceremonyId,response:f.owner.key.login(c.options)},another));
});
for(const [name,tweak] of Object.entries({origin:{client:{origin:'https://evil.example'}},port:{client:{origin:'http://localhost:9999'}},rp:{rp:'evil.example'},uv:{flags:1},presence:{flags:4},signature:{badSignature:true},challenge:{client:{challenge:'wrong'}},crossOrigin:{client:{crossOrigin:true}},topOrigin:{client:{topOrigin:'https://evil.example'}}})) {
  test('login rejects '+name,async t=>{const f=await fixture(t),c=await f.call('login/begin');await assert.rejects(f.call('login/finish',{ceremonyId:c.ceremonyId,response:f.owner.key.login(c.options,tweak)}));});
}
test('unregistered key, stale counter, wrong user handle, malformed response rejected',async t=>{
  const f=await fixture(t), other=new Authenticator();other.user=f.owner.key.user;
  let c=await f.call('login/begin');await assert.rejects(f.call('login/finish',{ceremonyId:c.ceremonyId,response:other.login(c.options)}));
  c=await f.call('login/begin');f.owner.key.counter=0;await assert.rejects(f.call('login/finish',{ceremonyId:c.ceremonyId,response:f.owner.key.login(c.options)}));
  c=await f.call('login/begin');const r=f.owner.key.login(c.options);r.response.userHandle='wrong';await assert.rejects(f.call('login/finish',{ceremonyId:c.ceremonyId,response:r}));
  c=await f.call('login/begin');await assert.rejects(f.call('login/finish',{ceremonyId:c.ceremonyId,response:{}}));
});
test('challenge expiration, replay and invalid response consumption',async t=>{
  const f=await fixture(t);let c=await f.call('login/begin'),r=f.owner.key.login(c.options);
  f.advance(120_001);await assert.rejects(f.call('login/finish',{ceremonyId:c.ceremonyId,response:r}));
  c=await f.call('login/begin');r=f.owner.key.login(c.options);await f.call('login/finish',{ceremonyId:c.ceremonyId,response:r});await assert.rejects(f.call('login/finish',{ceremonyId:c.ceremonyId,response:r}));
  c=await f.call('login/begin');await assert.rejects(f.call('login/finish',{ceremonyId:c.ceremonyId,response:f.owner.key.login(c.options,{badSignature:true})}));
  await assert.rejects(f.call('login/finish',{ceremonyId:c.ceremonyId,response:f.owner.key.login(c.options)}));
});
for (const [name,tweak] of Object.entries({origin:{client:{origin:'https://evil.example'}},rp:{rp:'evil.example'},uv:{flags:0x41},crossOrigin:{client:{crossOrigin:true}}})) {
  test('registration rejects '+name,async t=>{const f=await fixture(t),i=await f.call('invite',{role:'admin',grant:await f.grant()},f.session),c=await f.call('register/begin',{ticket:i.enrollmentTicket});await assert.rejects(f.call('register/finish',{ceremonyId:c.ceremonyId,response:new Authenticator().register(c.options,tweak)}));});
}
test('registration replay, expiration and invalid/consumed enrollment tickets denied',async t=>{
  const f=await fixture(t),i=await f.call('invite',{role:'admin',grant:await f.grant()},f.session);
  const c=await f.call('register/begin',{ticket:i.enrollmentTicket}),r=new Authenticator().register(c.options);
  await assert.rejects(f.call('register/begin',{ticket:i.enrollmentTicket}));f.advance(120_001);await assert.rejects(f.call('register/finish',{ceremonyId:c.ceremonyId,response:r}));
  await assert.rejects(f.call('register/finish',{ceremonyId:c.ceremonyId,response:r}));await assert.rejects(f.call('register/begin',{ticket:'forged'}));
});
test('inviter revocation during enrollment prevents activation',async t=>{
  const f=await fixture(t), other=await f.invite('owner');
  const i=await f.call('invite',{role:'admin',grant:await f.grant()},f.session),c=await f.call('register/begin',{ticket:i.enrollmentTicket});
  await f.call('disable',{userId:f.owner.userId,grant:await f.grant('manage',other.session,other.key)},other.session);
  await assert.rejects(f.call('register/finish',{ceremonyId:c.ceremonyId,response:new Authenticator().register(c.options)}));
});
test('recovery requires operator access plus issued one-time code; keeps role, revokes old keys and sessions',async t=>{
  const f=await fixture(t), codes=(await f.call('recovery/codes',{grant:await f.grant('recovery')},f.session)).recoveryCodes;
  await assert.rejects(f.call('recover',{userId:f.owner.userId,code:codes[0]}));assert.throws(()=>f.auth.recoverOffline(f.owner.userId,'fake'));
  const r=f.auth.recoverOffline(f.owner.userId,codes[0]);assert.throws(()=>f.auth.recoverOffline(f.owner.userId,codes[0]));
  await assert.rejects(f.call('list',{},f.session));await assert.rejects(f.login(f.owner.key));
  const recovered=await f.enroll(r.enrollmentTicket),s=(await f.login(recovered.key)).sessionToken;
  assert.equal((await f.call('list',{},s)).me.role,'owner');
  assert.throws(()=>f.auth.recoverOffline(f.owner.userId,codes[1]));
  await assert.rejects(f.call('register/begin',{ticket:r.enrollmentTicket}));
});
test('expired initial enrollment can be reissued offline without creating another owner',async t=>{
  let now=Date.now();const a=new AdminAuth({dbPath:resolve(import.meta.dirname,'../test-data',randomBytes(12).toString('hex')+'.sqlite'),now:()=>now});t.after(()=>a.close());
  const first=a.bootstrap();assert.throws(()=>a.bootstrap());now+=600_001;const second=a.bootstrap();assert.equal(first.userId,second.userId);assert.notEqual(first.enrollmentTicket,second.enrollmentTicket);
  await assert.rejects(a.dispatch('register/begin',{ticket:first.enrollmentTicket}));
});
test('disabled account cannot recover or elevate its role',async t=>{
  const f=await fixture(t),a=await f.invite('admin');
  const codes=(await f.call('recovery/codes',{grant:await f.grant('recovery',a.session,a.key)},a.session)).recoveryCodes;
  await f.call('disable',{userId:a.userId,grant:await f.grant()},f.session);assert.throws(()=>f.auth.recoverOffline(a.userId,codes[0]));
});
test('sessions expire and logout revokes immediately',async t=>{
  const f=await fixture(t);await f.call('logout',{},f.session);await assert.rejects(f.call('list',{},f.session));
  const s=(await f.login(f.owner.key)).sessionToken;f.advance(900_001);await assert.rejects(f.call('list',{},s));
});
test('revocation persists across database reopen',async t=>{
  const f=await fixture(t);await f.call('logout',{},f.session);
  const reopened=new AdminAuth({dbPath:f.auth.db.location()});
  try {assert.throws(()=>reopened.session(f.session));} finally {reopened.close();}
});
test('additional synced passkey is not treated as a unique installation',async t=>{
  const f=await fixture(t),key=new Authenticator();
  const c=await f.call('register/begin',{grant:await f.grant('credential')},f.session);
  await f.call('register/finish',{ceremonyId:c.ceremonyId,response:key.register(c.options,{flags:0x5d})});
  const s=(await f.login(key,undefined,undefined)).sessionToken;
  assert.equal((await f.call('list',{},s)).credentials.find(x=>x.id===key.id).device_type,'multiDevice');
});
test('recovery code rotation removes older codes and cannot elevate admin',async t=>{
  const f=await fixture(t),a=await f.invite('admin');
  const old=(await f.call('recovery/codes',{grant:await f.grant('recovery',a.session,a.key)},a.session)).recoveryCodes;
  const codes=(await f.call('recovery/codes',{grant:await f.grant('recovery',a.session,a.key)},a.session)).recoveryCodes;
  assert.throws(()=>f.auth.recoverOffline(a.userId,old[0]));const r=f.auth.recoverOffline(a.userId,codes[0]);
  const recovered=await f.enroll(r.enrollmentTicket);assert.equal((await f.call('list',{},(await f.login(recovered.key)).sessionToken)).me.role,'admin');
});
test('audit schema contains only fixed operation, time and success; secrets and documents excluded',async t=>{
  const f=await fixture(t);await assert.rejects(f.call('invite',{role:'owner',grant:'SECRET_DOCUMENT_CANARY'},f.session));
  const log=JSON.stringify(f.auth.all('SELECT * FROM audit'));assert.ok(!log.includes(f.session));assert.ok(!log.includes('SECRET_DOCUMENT_CANARY'));assert.deepEqual(Object.keys(f.auth.get('SELECT * FROM audit')),['id','at','operation','success']);
});
test('simultaneous replay of the same assertion succeeds only once',async t=>{
  const f=await fixture(t),c=await f.call('login/begin'),body={ceremonyId:c.ceremonyId,response:f.owner.key.login(c.options)};
  const results=await Promise.allSettled([f.call('login/finish',body),f.call('login/finish',body)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
});
test('credential revoked while verification is in flight cannot mint a session',async t=>{
  const f=await fixture(t),a=await f.invite('admin'),grant=await f.grant('credential'),c=await f.call('login/begin');
  const pending=f.call('login/finish',{ceremonyId:c.ceremonyId,response:a.key.login(c.options)});
  await f.call('credential/revoke',{credentialId:a.credentialId,grant},f.session);
  await assert.rejects(pending);
});
test('second recovery invalidates an enrollment already undergoing verification',async t=>{
  const f=await fixture(t),codes=(await f.call('recovery/codes',{grant:await f.grant('recovery')},f.session)).recoveryCodes;
  const ticket=f.auth.recoverOffline(f.owner.userId,codes[0]).enrollmentTicket;
  const c=await f.call('register/begin',{ticket}),pending=f.call('register/finish',{ceremonyId:c.ceremonyId,response:new Authenticator().register(c.options)});
  f.auth.recoverOffline(f.owner.userId,codes[1]);await assert.rejects(pending);
});
test('HTTP origin/host/content type boundaries, UI assets, no recovery endpoint',async t=>{
  const f=await fixture(t),server=createServer(f.auth);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const base='http://localhost:'+server.address().port;f.auth.origin=base;
  const post=(path,origin=base,body={},headers={})=>fetch(base+'/api/'+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  assert.equal((await fetch(base)).status,200);assert.equal((await fetch(base+'/browser.js')).status,200);
  assert.equal((await post('login/begin')).status,200);assert.equal((await post('login/begin','https://evil.example')).status,403);
  assert.equal((await post('recover')).status,403);assert.equal((await post('list',base,{}, {Authorization:'Bearer '+f.session})).status,200);
  assert.equal((await post('login/begin',base,{}, {'Content-Type':'text/plain'})).status,403);
});
