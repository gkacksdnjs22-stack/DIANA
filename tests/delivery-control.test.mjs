import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createControlServer } from '../lib/control.mjs';
import { MAX_UPLOAD_BYTES } from '../lib/upload-contract.mjs';

const OWNER = 'owner-' + 'u'.repeat(40), AGENT = 'agent-' + 'a'.repeat(40), GATEWAY = 'gateway-' + 'g'.repeat(40);
const content = Buffer.from('APK relay test bytes. This fixture is never executed.');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const metadata = { filename:'DIANA-debug.apk', sha256:sha(content), bytes:content.length };
function memoryStore() {
  const files = new Map();
  return { files,
    async read(name) { return files.get(name) || null; },
    async put(name, bytes) { if (files.has(name)) assert.equal(sha(files.get(name)), sha(bytes)); files.set(name, Buffer.from(bytes)); },
    async remove(name) { files.delete(name); },
  };
}
async function fixture(t, options = {}) {
  let time = Date.parse('2026-10-23T05:00:00Z');
  const transfers = options.transfers || memoryStore();
  const server = createControlServer({ userToken:OWNER, agentToken:AGENT, gatewayToken:GATEWAY, transfers, now:() => time, ...options });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, { token = OWNER, method = 'GET', body, headers = {} } = {}) => {
    const response = await fetch(base + path, { method, headers:{ Authorization:`Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type':'application/json' }), ...headers }, body:body === undefined ? undefined : JSON.stringify(body) });
    return { status:response.status, data:await response.json() };
  };
  const deliver = async ({ id = randomUUID(), bytes = content, filename = metadata.filename, digest = sha(bytes), token = OWNER, route = 'deliveries', headers = {} } = {}) => {
    const response = await fetch(`${base}/api/${route}/${id}`, { method:'POST', headers:{ Authorization:`Bearer ${token}`, 'X-File-Name':encodeURIComponent(filename), 'X-File-SHA256':digest, ...headers }, body:bytes });
    return { id, status:response.status, data:await response.json() };
  };
  const pair = async () => {
    const code = (await request('/api/phone/pair-code', { method:'POST' })).data.code;
    const paired = await request('/api/phone/pair', { method:'POST', token:'', body:{ code, deviceName:'갤럭시 전달 테스트' } });
    assert.equal(paired.status, 201); return paired.data.phoneToken;
  };
  return { base, transfers, deliver, request, pair, now:() => time, advance:ms => { time += ms; } };
}

test('owner delivery becomes an existing-protocol single file that paired Galaxy can download and acknowledge', async t => {
  const f = await fixture(t), phone = await f.pair(), delivered = await f.deliver();
  assert.equal(delivered.status, 201); const job = delivered.data.job;
  assert.equal(job.kind, 'delivery'); assert.equal(job.state, 'download_ready'); assert.equal(job.wakeStatus, 'skipped');
  assert.equal(job.phoneSavedAt, undefined); assert.equal(job.request.delivery, 'download');
  assert.equal(job.request.query, '휴대폰으로 보내기 · DIANA-debug.apk'); assert.equal(job.request.subject, metadata.filename);
  assert.deepEqual(job.artifact, { ...metadata, mime:'application/vnd.android.package-archive', createdAt:new Date(f.now()).toISOString() });
  assert.deepEqual(job.artifacts, [{ id:metadata.sha256, ...metadata, mime:'application/vnd.android.package-archive' }]);
  assert.equal(job.artifacts[0].id, job.artifact.sha256);
  assert.deepEqual(f.transfers.files.get(delivered.id + '.bin'), content);
  const response = await fetch(`${f.base}/api/jobs/${delivered.id}/file`, { headers:{ Authorization:`Bearer ${phone}` } });
  assert.equal(response.status, 200); assert.equal(Number(response.headers.get('content-length')), content.length);
  const downloaded = Buffer.from(await response.arrayBuffer()); assert.deepEqual(downloaded, content); assert.equal(sha(downloaded), metadata.sha256);
  const receipt = { savedAt:new Date(f.now()).toISOString(), artifacts:[{ id:metadata.sha256, sha256:metadata.sha256 }] };
  assert.equal((await f.request(`/api/phone/jobs/${job.id}/received`, { token:OWNER, method:'POST', body:receipt })).status, 403);
  const confirmed = await f.request(`/api/phone/jobs/${job.id}/received`, { token:phone, method:'POST', body:receipt });
  assert.equal(confirmed.status, 200); assert(confirmed.data.phoneSavedAt);
  const saved = (await f.request('/api/jobs', { token:phone })).data.jobs[0]; assert.equal(saved.state, 'download_ready'); assert(saved.phoneSavedAt);
});

test('new delivery requires owner authority even when a paired phone may download files', async t => {
  const f = await fixture(t), phone = await f.pair();
  for (const token of [phone, AGENT, GATEWAY, '']) assert.equal((await f.deliver({ token })).status, 401);
  assert.equal((await f.deliver({ headers:{ Origin:'https://untrusted.example' } })).status, 403);
  assert.equal((await f.request('/api/jobs')).data.jobs.length, 0);
});

test('delivery validates safe names, UUID, actual binary digest and nonempty 10MB limit', async t => {
  const f = await fixture(t);
  for (const filename of ['../app.apk', 'CON.apk', 'secret:app.apk', '.env', 'app.apk ']) assert.equal((await f.deliver({ filename })).status, 400);
  assert.equal((await f.deliver({ id:'invalid' })).status, 400);
  assert.equal((await f.deliver({ digest:'A'.repeat(64) })).status, 400);
  assert.equal((await f.deliver({ digest:'0'.repeat(64) })).status, 409);
  assert.equal((await f.deliver({ bytes:Buffer.alloc(0) })).status, 400);
  assert.equal((await f.deliver({ bytes:Buffer.alloc(MAX_UPLOAD_BYTES + 1) })).status, 413);
  assert.equal((await f.request('/api/jobs')).data.jobs.length, 0);
  const generic = await f.deliver({ filename:'안내문.txt' }); assert.equal(generic.status, 201); assert.equal(generic.data.job.artifact.mime, 'application/octet-stream');
});

test('duplicate delivery ID accepts exactly the same immutable file and never resets its saved or expiry metadata', async t => {
  const f = await fixture(t), id = randomUUID();
  const replies = await Promise.all([f.deliver({ id }), f.deliver({ id }), f.deliver({ id, filename:'different.apk' }), f.deliver({ id, bytes:Buffer.from('different') })]);
  assert.deepEqual(replies.map(reply => reply.status).sort(), [200, 201, 409, 409]);
  assert.equal((await f.request('/api/jobs')).data.jobs.length, 1); assert.equal(f.transfers.files.size, 1);
  const first = replies.find(reply => reply.status === 201).data.job;
  f.advance(25 * 3600_000);
  const duplicate = await f.deliver({ id }); assert.equal(duplicate.status, 200); assert.equal(duplicate.data.duplicate, true); assert.equal(duplicate.data.job.artifact.createdAt, first.artifact.createdAt);
  assert.equal((await f.request(`/api/jobs/${id}/file`)).status, 410);
});

test('direct delivery never enters PC search, incoming upload, or wake queues and cannot be mutated by a legacy agent', async t => {
  const f = await fixture(t), sent = await f.deliver();
  assert.equal((await f.request('/api/agent/next', { token:AGENT })).data.job, null);
  assert.equal((await f.request('/api/agent/uploads/next', { token:AGENT })).data.upload, null);
  assert.equal((await f.request('/api/gateway/wake', { token:GATEWAY })).data.job, null);
  for (const action of ['candidates', 'result', 'error', 'file']) assert.equal((await f.request(`/api/agent/jobs/${sent.id}/${action}`, { token:AGENT, method:'POST', body:{ status:'failed' } })).status, 409);
  assert.equal((await f.request(`/api/jobs/${sent.id}/selection`, { method:'POST', body:{ approve:true } })).status, 409);
  const job = (await f.request('/api/jobs')).data.jobs[0]; assert.equal(job.state, 'download_ready'); assert.equal(job.artifact.sha256, metadata.sha256);
});

test('cross-endpoint concurrent same-ID creation cannot overwrite a delivery or orphan a second registered job', async t => {
  const transfers = memoryStore(), put = transfers.put; let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), enteredPut = new Promise(resolve => { entered = resolve; });
  transfers.put = async (...args) => { entered(); await gate; return put(...args); };
  const f = await fixture(t, { transfers }), id = randomUUID();
  const delivery = f.deliver({ id }); await enteredPut;
  const incoming = f.deliver({ id, route:'uploads' });
  const search = f.request('/api/jobs', { method:'POST', body:{ requestId:id, query:'문서 검색', delivery:'download' } });
  release();
  const outcomes = await Promise.all([delivery, incoming, search]); assert.deepEqual(outcomes.map(reply => reply.status), [201, 409, 409]);
  const jobs = (await f.request('/api/jobs')).data.jobs; assert.equal(jobs.length, 1); assert.equal(jobs[0].kind, 'delivery');
  assert.equal(transfers.files.size, 1); assert.deepEqual(transfers.files.get(id + '.bin'), content);
});

test('a preexisting search or phone upload ID cannot be reused for direct delivery', async t => {
  const f = await fixture(t), searchId = randomUUID(), uploadId = randomUUID();
  assert.equal((await f.request('/api/jobs', { method:'POST', body:{ requestId:searchId, query:'기존 문서', delivery:'download' } })).status, 201);
  assert.equal((await f.deliver({ id:searchId })).status, 409);
  assert.equal((await f.deliver({ id:uploadId, route:'uploads' })).status, 201);
  assert.equal((await f.deliver({ id:uploadId })).status, 409);
  assert.equal(f.transfers.files.has(searchId + '.bin'), false); assert.equal(f.transfers.files.has(uploadId + '.bin'), false);
});

test('relay storage failure never publishes an unavailable delivery and can be retried safely', async t => {
  const transfers = memoryStore(), put = transfers.put; let unavailable = true;
  transfers.put = async (...args) => { if (unavailable) throw new Error('private credential or path detail'); return put(...args); };
  const f = await fixture(t, { transfers }), id = randomUUID();
  const failed = await f.deliver({ id }); assert.equal(failed.status, 500); assert(!failed.data.error.includes('private'));
  assert.equal((await f.request('/api/jobs')).data.jobs.length, 0);
  unavailable = false; assert.equal((await f.deliver({ id })).status, 201);
});

test('existing 24-hour cleanup deletes direct relay bytes and persists expiry while retaining job history', async t => {
  const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE jobs(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  const id = randomUUID(), old = '2026-10-22T04:00:00.000Z', transfers = memoryStore();
  const job = { id, kind:'delivery', deviceId:'home-pc', request:{ query:metadata.filename, delivery:'download', subject:metadata.filename }, state:'download_ready', wakeStatus:'skipped', createdAt:old, events:[], artifact:{ ...metadata, createdAt:old } };
  db.prepare('INSERT INTO jobs VALUES(?,?)').run(id, JSON.stringify(job)); transfers.files.set(id + '.bin', content);
  const f = await fixture(t, { db, transfers });
  await f.request('/api/health');
  const saved = (await f.request('/api/jobs')).data.jobs[0]; assert.equal(saved.artifact.expired, true); assert.equal(saved.kind, 'delivery'); assert.equal(saved.state, 'download_ready');
  assert.equal(transfers.files.size, 0); assert.equal((await f.request(`/api/jobs/${id}/file`)).status, 410);
});
