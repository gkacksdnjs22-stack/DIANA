import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createControlServer } from '../lib/control.mjs';

const OWNER = 'push-owner-' + 'u'.repeat(40);
const AGENT = 'push-agent-' + 'a'.repeat(40);
const GATEWAY = 'push-gateway-' + 'g'.repeat(40);
const FCM = 'fixture-fcm-registration-' + 'f'.repeat(120);
const HASH = bytes => createHash('sha256').update(bytes).digest('hex');
const FIREBASE = { enabled:true, applicationId:'1:123456789012:android:abcdef123456', apiKey:'AIza' + 'p'.repeat(35), projectId:'diana-push-test', senderId:'123456789012' };

async function settle() { await nextTurn(); await nextTurn(); await nextTurn(); }
function assertPublicFirebase(value) {
  assert.deepEqual(value, FIREBASE);
  assert.deepEqual(Object.keys(value).sort(), ['apiKey','applicationId','enabled','projectId','senderId']);
  const serialized = JSON.stringify(value);
  for (const secret of [OWNER, AGENT, GATEWAY, FCM, 'private_key', 'client_email']) assert(!serialized.includes(secret));
}
async function fixture(t, { configured = true } = {}) {
  let time = Date.parse('2026-10-23T08:00:00Z'), activeSends = 0;
  const files = new Map(), calls = [];
  const transfers = {
    async put(name, bytes) { assert(!files.has(name) || HASH(files.get(name)) === HASH(bytes)); files.set(name, Buffer.from(bytes)); },
    async read(name) { return files.get(name) || null; },
    async remove(name) { files.delete(name); },
  };
  const sender = { async send(...args) {
    activeSends++;
    try { calls.push({ args, files:new Map(files) }); return { accepted:true }; }
    finally { activeSends--; }
  } };
  const server = createControlServer({ userToken:OWNER, agentToken:AGENT, gatewayToken:GATEWAY, transfers,
    now:() => time, push:{ publicConfig:configured ? FIREBASE : { enabled:false }, sender:configured ? sender : null }, pushPollMs:0 });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    // Let the immediate fake sender and dispatcher receipt writes finish before
    // the server close handler closes SQLite. Never terminate an active request.
    await settle(); assert.equal(activeSends, 0);
    server.closeIdleConnections(); await new Promise(resolve => server.close(resolve));
  });
  const request = async (path, { token = OWNER, method = 'GET', body, bytes, headers = {} } = {}) => {
    const response = await fetch(base + path, { method, headers:{ ...(token ? { Authorization:`Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type':'application/json' }), ...headers }, body:bytes ?? (body === undefined ? undefined : JSON.stringify(body)) });
    const data = response.headers.get('content-type')?.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer());
    return { status:response.status, data };
  };
  const pair = async (fcmToken, name = '푸시 확인 갤럭시') => {
    const issued = await request('/api/phone/pair-code', { method:'POST' }); assert.equal(issued.status, 200);
    const result = await request('/api/phone/pair', { token:'', method:'POST', body:{ code:issued.data.code, deviceName:name, ...(fcmToken ? { fcmToken } : {}) } });
    assert.equal(result.status, 201); return result.data;
  };
  const register = async (phone, fcmToken = FCM) => request('/api/phone/token', { token:phone.phoneToken, method:'POST', body:{ fcmToken } });
  const deliver = async (id = randomUUID(), bytes = Buffer.from('explicitly selected file fixture')) => request(`/api/deliveries/${id}`, {
    method:'POST', bytes, headers:{ 'X-File-Name':encodeURIComponent('휴대폰 전달 확인.txt'), 'X-File-SHA256':HASH(bytes) },
  });
  return { base, request, pair, register, deliver, files, calls, now:() => new Date(time).toISOString(), advance:ms => { time += ms; } };
}

test('pairing returns allowlisted Firebase fields and each authenticated phone retrieves its own ID', async t => {
  const f = await fixture(t), first = await f.pair(), second = await f.pair(undefined, '두 번째 갤럭시');
  assert.deepEqual(Object.keys(first).sort(), ['firebase','phoneId','phoneToken']);
  assertPublicFirebase(first.firebase); assertPublicFirebase(second.firebase);
  assert.notEqual(first.phoneId, second.phoneId); assert.notEqual(first.phoneToken, second.phoneToken);
  for (const phone of [first, second]) {
    const config = await f.request('/api/phone/config', { token:phone.phoneToken });
    assert.equal(config.status, 200); assert.equal(config.data.phoneId, phone.phoneId);
    assert.deepEqual(Object.keys(config.data).sort(), ['firebase','phoneId']); assertPublicFirebase(config.data.firebase);
    assert(!JSON.stringify(config.data).includes(phone.phoneToken));
  }
});

test('phone configuration refuses anonymous, PC, gateway, owner and revoked-phone credentials', async t => {
  const f = await fixture(t), phone = await f.pair();
  for (const [token, expected] of [['',401], [AGENT,401], [GATEWAY,401], [OWNER,403]]) {
    const response = await f.request('/api/phone/config', { token });
    assert.equal(response.status, expected); assert.equal(response.data.firebase, undefined);
  }
  assert.equal((await f.request(`/api/phone/devices/${phone.phoneId}`, { method:'DELETE' })).status, 200);
  assert.equal((await f.request('/api/phone/config', { token:phone.phoneToken })).status, 401);
});

test('FCM registration returns public configuration and owner status exposes only active registration counts', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.request('/api/phone/push-status')).data, { configured:true, registeredPhones:0 });
  const phone = await f.pair();
  assert.deepEqual((await f.request('/api/phone/push-status')).data, { configured:true, registeredPhones:0 });
  const registered = await f.register(phone); assert.equal(registered.status, 200);
  assert.deepEqual(Object.keys(registered.data).sort(), ['firebase','ok']); assert.equal(registered.data.ok, true); assertPublicFirebase(registered.data.firebase);
  const second = await f.pair(FCM + '-second', '두 번째 등록 갤럭시');
  const status = await f.request('/api/phone/push-status'); assert.equal(status.status, 200);
  assert.deepEqual(status.data, { configured:true, registeredPhones:2 });
  for (const secret of [phone.phoneId, phone.phoneToken, FCM, OWNER, AGENT]) assert(!JSON.stringify(status.data).includes(secret));
  for (const token of ['', AGENT, GATEWAY, phone.phoneToken]) assert.equal((await f.request('/api/phone/push-status', { token })).status, 401);
  for (const [token, expected] of [['',401], [AGENT,401], [OWNER,403]]) {
    assert.equal((await f.request('/api/phone/token', { token, method:'POST', body:{ fcmToken:FCM } })).status, expected);
  }
  assert.equal((await f.request(`/api/phone/devices/${second.phoneId}`, { method:'DELETE' })).status, 200);
  assert.deepEqual((await f.request('/api/phone/push-status')).data, { configured:true, registeredPhones:1 });
});

test('unconfigured Firebase remains visibly disabled without preventing pairing or registration', async t => {
  const f = await fixture(t, { configured:false }), phone = await f.pair();
  assert.deepEqual(phone.firebase, { enabled:false });
  assert.deepEqual((await f.request('/api/phone/config', { token:phone.phoneToken })).data, { phoneId:phone.phoneId, firebase:{ enabled:false } });
  assert.deepEqual((await f.register(phone)).data, { ok:true, firebase:{ enabled:false } });
  assert.deepEqual((await f.request('/api/phone/push-status')).data, { configured:false, registeredPhones:1 });
  assert.equal((await f.deliver()).status, 201); await settle(); assert.deepEqual(f.calls, []);
});

test('direct delivery pushes once after file publication and replay or phone receipt never repeats it', async t => {
  const f = await fixture(t), phone = await f.pair(); await f.register(phone);
  const id = randomUUID(), bytes = Buffer.from('ready direct relay file');
  assert.equal((await f.deliver(id, bytes)).status, 201); await settle();
  assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0].args, [FCM], 'dispatcher passes only the registration token, never file names or job content');
  assert.deepEqual(f.calls[0].files.get(`${id}.bin`), bytes, 'relay bytes must exist before the wake-up');
  const duplicate = await f.deliver(id, bytes); assert.equal(duplicate.status, 200); assert.equal(duplicate.data.duplicate, true);
  const downloaded = await f.request(`/api/jobs/${id}/file`, { token:phone.phoneToken });
  assert.equal(downloaded.status, 200); assert.deepEqual(downloaded.data, bytes);
  const receipt = { savedAt:f.now(), artifacts:[{ id:HASH(bytes), sha256:HASH(bytes) }] };
  assert.equal((await f.request(`/api/phone/jobs/${id}/received`, { token:phone.phoneToken, method:'POST', body:receipt })).status, 200);
  await f.request('/api/jobs', { token:phone.phoneToken }); await settle();
  assert.equal(f.calls.length, 1);
});

test('search results and uploaded bytes do not push until the agent publishes download_ready', async t => {
  const f = await fixture(t), phone = await f.pair(FCM), id = randomUUID(), bytes = Buffer.from('PC selected original document');
  const digest = HASH(bytes), candidate = { id:digest, sha256:digest, filename:'선택한 원본.txt', bytes:bytes.length, modifiedAt:f.now(), score:0.99, excerpt:'fixture document', reason:'explicit selection fixture' };
  assert.equal((await f.request('/api/jobs', { method:'POST', body:{ requestId:id, query:'선택한 원본', delivery:'download', autoSend:false } })).status, 201);
  assert.equal((await f.request('/api/agent/next', { token:AGENT })).data.job.action, 'search');
  assert.equal((await f.request(`/api/agent/jobs/${id}/candidates`, { token:AGENT, method:'POST', body:{ mode:'lexical', candidates:[candidate] } })).status, 200);
  assert.equal((await f.request(`/api/jobs/${id}/selection`, { method:'POST', body:{ candidateId:digest, approve:true } })).status, 200);
  assert.equal((await f.request('/api/agent/next', { token:AGENT })).data.job.action, 'send');
  await settle(); assert.equal(f.calls.length, 0);
  const upload = await f.request(`/api/agent/jobs/${id}/file`, { token:AGENT, method:'POST', bytes, headers:{ 'X-File-Name':encodeURIComponent(candidate.filename), 'X-File-SHA256':digest, 'X-Source-File-Id':digest } });
  assert.equal(upload.status, 200); await settle(); assert.equal(f.calls.length, 0);
  assert.equal((await f.request('/api/jobs')).data.jobs[0].state, 'sending');
  const ready = await f.request(`/api/agent/jobs/${id}/result`, { token:AGENT, method:'POST', body:{ status:'download_ready' } });
  assert.equal(ready.status, 200); await settle(); assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].args, [FCM]); assert.deepEqual(f.calls[0].files.get(`${id}.bin`), bytes);
  assert.equal((await f.request(`/api/agent/jobs/${id}/result`, { token:AGENT, method:'POST', body:{ status:'download_ready' } })).data.duplicate, true);
  await f.request('/api/jobs', { token:phone.phoneToken }); await settle(); assert.equal(f.calls.length, 1);
});

test('overnight work pushes only after all five files are published and keeps one receipt across phone completion', async t => {
  const f = await fixture(t), phone = await f.pair(FCM), id = randomUUID();
  const source = { id:'1'.repeat(64), sha256:'2'.repeat(64), filename:'원문.txt', bytes:100, modifiedAt:f.now(), excerpt:'보고서 원문 테스트' };
  assert.equal((await f.request('/api/agent/catalog', { token:AGENT, method:'POST', body:{ documents:[source] } })).status, 200);
  const startAt = new Date(Date.parse(f.now()) + 60_000).toISOString(), deadlineAt = new Date(Date.parse(f.now()) + 3600_000).toISOString();
  const created = await f.request('/api/jobs', { method:'POST', body:{ requestId:id, kind:'overnight', sourceId:source.id, instruction:'원문을 근거로 정리', criteria:['원문 근거 확인'], startAt, deadlineAt, delivery:'download', slideCount:6 } });
  assert.equal(created.status, 201); f.advance(60_000);
  assert.equal((await f.request('/api/agent/next', { token:AGENT })).data.job.action, 'overnight');
  const outputs = [
    ['보고서.md','text/markdown'], ['보고서.hwpx','application/vnd.hancom.hwpx'], ['보고서.pdf','application/pdf'],
    ['발표자료.pptx','application/vnd.openxmlformats-officedocument.presentationml.presentation'], ['발표자료.pdf','application/pdf'],
  ].map(([filename,mime]) => { const bytes = Buffer.from(`protocol fixture only: ${filename}`); return { filename, mime, bytes:bytes.length, id:HASH(bytes), sha256:HASH(bytes), content:bytes }; });
  const manifest = outputs.map(({ content, ...file }) => file);
  const prefix = `/api/agent/jobs/${id}`;
  assert.equal((await f.request(`${prefix}/artifacts`, { token:AGENT, method:'POST', body:{ artifacts:manifest } })).status, 201);
  for (const file of outputs.slice(0, 4)) assert.equal((await f.request(`${prefix}/artifacts/${file.id}`, { token:AGENT, method:'POST', bytes:file.content })).status, 200);
  assert.equal((await f.request(`${prefix}/result`, { token:AGENT, method:'POST', body:{ status:'download_ready' } })).status, 409);
  await settle(); assert.equal(f.calls.length, 0);
  const last = outputs[4]; assert.equal((await f.request(`${prefix}/artifacts/${last.id}`, { token:AGENT, method:'POST', bytes:last.content })).status, 200);
  await settle(); assert.equal(f.calls.length, 0);
  const ready = await f.request(`${prefix}/result`, { token:AGENT, method:'POST', body:{ status:'download_ready' } });
  assert.equal(ready.status, 200); assert.equal(ready.data.job.state, 'awaiting_phone'); assert.equal(ready.data.job.artifacts.length, 5);
  await settle(); assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0].args, [FCM]);
  for (const file of outputs) assert.deepEqual(f.calls[0].files.get(`${id}-${file.id}.bin`), file.content);
  const receipt = { savedAt:f.now(), artifacts:manifest.map(({ id, sha256 }) => ({ id, sha256 })) };
  const saved = await f.request(`/api/phone/jobs/${id}/received`, { token:phone.phoneToken, method:'POST', body:receipt });
  assert.equal(saved.status, 200); assert.equal(saved.data.onTime, true);
  assert.equal((await f.request('/api/jobs')).data.jobs[0].state, 'download_ready');
  await settle(); assert.equal(f.calls.length, 1, 'phone completion must keep the existing notification identity');
});
