import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { createControlServer } from '../lib/control.mjs';
import { createIncomingControl } from '../lib/incoming-control.mjs';
import { MAX_UPLOAD_BYTES, isUploadId, validateUploadMetadata } from '../lib/upload-contract.mjs';

const USER = 'user-' + 'u'.repeat(40), AGENT = 'agent-' + 'a'.repeat(40), GATEWAY = 'gateway-' + 'g'.repeat(40);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sample = Buffer.from('휴대폰에서 보낸 파일입니다.\n', 'utf8');
const spec = (bytes = sample, filename = '휴대폰 메모.txt') => ({ filename, sha256:sha(bytes), bytes:bytes.length });
function memoryStore() {
  const files = new Map();
  return { files,
    async put(name, bytes) { assert.match(name, /^incoming-[0-9a-f-]+\.bin$/i); if (files.has(name)) assert.equal(sha(files.get(name)), sha(bytes)); files.set(name, Buffer.from(bytes)); },
    async read(name) { return files.get(name) || null; },
    async remove(name) { files.delete(name); },
  };
}
async function fixture(t, options = {}) {
  const transfers = options.transfers || memoryStore();
  let time = Date.parse('2026-10-23T04:00:00Z');
  const server = createControlServer({ userToken:USER, agentToken:AGENT, gatewayToken:GATEWAY, transfers, now:() => time, ...options });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const request = async (path, { token = USER, method = 'GET', body, headers = {} } = {}) => {
    const response = await fetch(base + path, { method, headers:{ Authorization:`Bearer ${token}`, ...(body !== undefined ? { 'Content-Type':'application/json' } : {}), ...headers }, body:body === undefined ? undefined : JSON.stringify(body) });
    return { status:response.status, data:await response.json() };
  };
  const upload = async ({ id = randomUUID(), bytes = sample, filename = '휴대폰 메모.txt', digest = sha(bytes), token = USER, headers = {} } = {}) => {
    const response = await fetch(`${base}/api/uploads/${id}`, { method:'POST', headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/octet-stream', 'X-File-Name':encodeURIComponent(filename), 'X-File-SHA256':digest, ...headers }, body:bytes });
    return { id, status:response.status, data:await response.json() };
  };
  const claim = () => request('/api/agent/uploads/next', { token:AGENT });
  const receipt = (id, body = spec()) => request(`/api/agent/uploads/${id}/received`, { token:AGENT, method:'POST', body });
  return { base, transfers, request, upload, claim, receipt, advance:ms => { time += ms; } };
}

test('upload metadata accepts ordinary Korean names and rejects paths, devices, controls, bidi, bad hashes and sizes', () => {
  assert.deepEqual(validateUploadMetadata(spec()), spec());
  for (const filename of ['', '.env', '../a.txt', 'a/b.txt', 'a\\b.txt', 'C:a.txt', 'a<b.txt', 'a>b.txt', 'a"b.txt', 'a|b.txt', 'a?b.txt', 'a*b.txt', 'a.txt ', 'a.', 'CON', 'con.txt', 'PRN.pdf', 'NUL.txt', 'COM1.txt', 'lpt9', 'COM¹.txt', 'CONIN$.txt', 'CLOCK$', 'a\u0000.txt', 'a\u0085.txt', 'a\u202e.txt', 'a\u2066.txt', 'a'.repeat(181)]) {
    assert.throws(() => validateUploadMetadata(spec(sample, filename)), /파일명/, filename);
  }
  for (const sha256 of ['0'.repeat(63), 'A'.repeat(64), null]) assert.throws(() => validateUploadMetadata({ ...spec(), sha256 }), /해시/);
  for (const bytes of [0, -1, 1.5, MAX_UPLOAD_BYTES + 1, '1', NaN]) assert.throws(() => validateUploadMetadata({ ...spec(), bytes }), /10MB/);
  assert.equal(isUploadId(randomUUID()), true); assert.equal(isUploadId('../x'), false);
});

test('owner upload is inert, exact binary is relayed, and only verified PC receipt completes it', async t => {
  const f = await fixture(t), uploaded = await f.upload();
  assert.equal(uploaded.status, 201); assert.equal(uploaded.data.job.kind, 'upload'); assert.equal(uploaded.data.job.state, 'waiting_pc');
  assert.equal(uploaded.data.job.pcSavedAt, undefined); assert.deepEqual(uploaded.data.job.request, spec());
  const claimed = (await f.claim()).data.upload;
  assert.deepEqual(claimed, { id:uploaded.id, deviceId:'home-pc', ...spec() });
  assert.equal((await f.claim()).data.upload.id, uploaded.id, 'lost claim is re-delivered');
  const response = await fetch(`${f.base}/api/agent/uploads/${uploaded.id}/file`, { headers:{ Authorization:`Bearer ${AGENT}` } });
  assert.equal(response.status, 200); assert.equal(Number(response.headers.get('content-length')), sample.length);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), sample);
  const receipt = await f.receipt(uploaded.id); assert.equal(receipt.status, 200); assert.equal(receipt.data.job.state, 'pc_saved'); assert(receipt.data.job.pcSavedAt);
  const repeat = await f.receipt(uploaded.id); assert.equal(repeat.status, 200); assert.equal(repeat.data.duplicate, true); assert.equal(repeat.data.job.pcSavedAt, receipt.data.job.pcSavedAt);
  assert.equal((await f.claim()).data.upload, null);
  const listed = (await f.request('/api/jobs')).data.jobs[0]; assert.equal(listed.state, 'pc_saved'); assert.equal(listed.pcSavedAt, receipt.data.job.pcSavedAt);
  assert(!JSON.stringify(listed).includes(USER)); assert(!JSON.stringify(listed).includes('C:\\'));
});

test('paired phone may upload but revoked credentials and unrelated role tokens cannot', async t => {
  const f = await fixture(t);
  const code = (await f.request('/api/phone/pair-code', { method:'POST' })).data.code;
  const pairing = await f.request('/api/phone/pair', { method:'POST', token:'', body:{ code, deviceName:'업로드 테스트폰' } });
  assert.equal(pairing.status, 201); const token = pairing.data.phoneToken;
  assert.equal((await f.upload({ token })).status, 201);
  const devices = (await f.request('/api/phone/devices')).data.devices;
  assert.equal((await f.request(`/api/phone/devices/${devices[0].id}`, { method:'DELETE' })).status, 200);
  assert.equal((await f.upload({ token })).status, 401);
  assert.equal((await f.upload({ token:AGENT })).status, 401);
  assert.equal((await f.upload({ token:GATEWAY })).status, 401);
});

test('PC claim, file and receipt endpoints reject owner and phone tokens', async t => {
  const f = await fixture(t), upload = await f.upload();
  for (const token of [USER, GATEWAY, '']) {
    assert.equal((await f.request('/api/agent/uploads/next', { token })).status, 401);
    assert.equal((await f.request(`/api/agent/uploads/${upload.id}/file`, { token })).status, 401);
    assert.equal((await f.request(`/api/agent/uploads/${upload.id}/received`, { token, method:'POST', body:spec() })).status, 401);
  }
  assert.equal((await f.upload({ headers:{ Origin:'https://elsewhere.example' } })).status, 403);
});

test('invalid metadata, mismatched payload, zero-length and oversized upload never enter the queue', async t => {
  const f = await fixture(t);
  assert.equal((await f.upload({ filename:'../unsafe.txt' })).status, 400);
  assert.equal((await f.upload({ filename:'CON.txt' })).status, 400);
  assert.equal((await f.upload({ digest:'A'.repeat(64) })).status, 400);
  assert.equal((await f.upload({ digest:'0'.repeat(64) })).status, 409);
  assert.equal((await f.upload({ bytes:Buffer.alloc(0) })).status, 400);
  assert.equal((await f.upload({ bytes:Buffer.alloc(MAX_UPLOAD_BYTES + 1) })).status, 413);
  assert.equal((await f.request('/api/jobs')).data.jobs.length, 0);
});

test('same upload ID is idempotent only for identical metadata and bytes, including concurrent attempts', async t => {
  const f = await fixture(t), id = randomUUID();
  const results = await Promise.all([f.upload({ id }), f.upload({ id }), f.upload({ id, filename:'다른이름.txt' }), f.upload({ id, bytes:Buffer.from('다른 파일') })]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 201, 409, 409]);
  assert.equal((await f.request('/api/jobs')).data.jobs.length, 1);
  assert.deepEqual(f.transfers.files.get(`incoming-${id}.bin`), sample);
  assert.equal((await f.upload({ id, digest:'0'.repeat(64) })).status, 409);
});

test('different upload IDs are limited to twenty pending files even while storage yields', async t => {
  const transfers = memoryStore(), originalPut = transfers.put;
  transfers.put = async (...args) => { await new Promise(resolve => setTimeout(resolve, 1)); return originalPut(...args); };
  const f = await fixture(t, { transfers });
  const replies = await Promise.all(Array.from({ length:21 }, () => f.upload()));
  assert.equal(replies.filter(r => r.status === 201).length, 20); assert.equal(replies.filter(r => r.status === 429).length, 1);
  assert.equal(transfers.files.size, 20);
  const first = (await f.claim()).data.upload; await f.receipt(first.id);
  assert.equal((await f.upload()).status, 201, 'completed receipt releases pending quota');
});

test('legacy queues and mutations cannot claim or alter a phone upload', async t => {
  const f = await fixture(t), uploaded = await f.upload();
  assert.equal((await f.request('/api/agent/next', { token:AGENT })).data.job, null);
  const wake = await f.request('/api/gateway/wake', { token:GATEWAY }); assert.deepEqual(wake.data.job, { id:uploaded.id, deviceId:'home-pc' });
  for (const action of ['candidates', 'result', 'error']) assert.equal((await f.request(`/api/agent/jobs/${uploaded.id}/${action}`, { token:AGENT, method:'POST', body:{ status:'failed', error:'test' } })).status, 409);
  assert.equal((await f.request(`/api/agent/jobs/${uploaded.id}/file`, { token:AGENT, method:'POST', body:{} })).status, 409);
  assert.equal((await f.request(`/api/jobs/${uploaded.id}/selection`, { method:'POST', body:{} })).status, 409);
  assert.equal((await f.request(`/api/jobs/${uploaded.id}/file`)).status, 409);
  assert.equal((await f.request('/api/jobs')).data.jobs[0].state, 'waiting_pc');
});

test('receipt must follow claim and match all immutable file metadata', async t => {
  const f = await fixture(t), uploaded = await f.upload();
  assert.equal((await f.receipt(uploaded.id)).status, 409); await f.claim();
  for (const bad of [{ ...spec(), filename:'다른이름.txt' }, { ...spec(), bytes:sample.length + 1 }, { ...spec(), sha256:'0'.repeat(64) }]) assert.equal((await f.receipt(uploaded.id, bad)).status, 409);
  assert.equal((await f.request('/api/jobs')).data.jobs[0].pcSavedAt, undefined);
  const outcomes = await Promise.all([f.receipt(uploaded.id), f.receipt(uploaded.id)]);
  assert(outcomes.every(reply => reply.status === 200)); assert.equal(outcomes.filter(reply => reply.data.duplicate).length, 1);
  assert.equal((await f.receipt(uploaded.id, { ...spec(), filename:'다른이름.txt' })).status, 409);
});

test('corrupt or missing relay file cannot be downloaded as successful bytes', async t => {
  const f = await fixture(t), uploaded = await f.upload(); await f.claim();
  f.transfers.files.set(`incoming-${uploaded.id}.bin`, Buffer.from('corrupted'));
  assert.equal((await f.request(`/api/agent/uploads/${uploaded.id}/file`, { token:AGENT })).status, 409);
  f.transfers.files.delete(`incoming-${uploaded.id}.bin`);
  assert.equal((await f.request(`/api/agent/uploads/${uploaded.id}/file`, { token:AGENT })).status, 404);
});

test('failed relay storage does not falsely register a waiting file and safe retry succeeds', async t => {
  const transfers = memoryStore(), originalPut = transfers.put; let failing = true;
  transfers.put = async (...args) => { if (failing) throw new Error('private storage detail'); return originalPut(...args); };
  const f = await fixture(t, { transfers }), id = randomUUID();
  const failed = await f.upload({ id }); assert.equal(failed.status, 500); assert(!failed.data.error.includes('private'));
  assert.equal((await f.request('/api/jobs')).data.jobs.length, 0); failing = false;
  assert.equal((await f.upload({ id })).status, 201);
});

test('upload expiry prevents late claim/download/first receipt while successful receipt replay remains valid', async t => {
  const f = await fixture(t), completed = await f.upload(); await f.claim(); await f.receipt(completed.id);
  const pending = await f.upload(); await f.claim();
  f.advance(24 * 3600_000);
  assert.equal((await f.claim()).data.upload, null);
  assert.equal((await f.request(`/api/agent/uploads/${pending.id}/file`, { token:AGENT })).status, 410);
  assert.equal((await f.receipt(pending.id)).status, 410);
  assert.equal((await f.receipt(completed.id)).status, 200);
  const jobs = (await f.request('/api/jobs')).data.jobs;
  assert.equal(jobs.find(job => job.id === pending.id).state, 'failed'); assert.match(jobs.find(job => job.id === pending.id).error, /24시간/);
  assert.equal(jobs.find(job => job.id === completed.id).state, 'pc_saved');
});

test('PC failure acknowledgement stores only a safe message and cannot fail an unclaimed or completed upload', async t => {
  const f = await fixture(t), uploaded = await f.upload();
  const fail = body => f.request(`/api/agent/uploads/${uploaded.id}/failed`, { token:AGENT, method:'POST', body });
  assert.equal((await fail({ error:'PC 파일 저장 오류' })).status, 409); await f.claim();
  assert.equal((await fail({ error:'bad\ncontrol' })).status, 400);
  const failed = await fail({ error:'C:\\private\\secret-file.txt permission denied' }); assert.equal(failed.status, 200);
  assert.equal(failed.data.job.state, 'failed'); assert(!failed.data.job.error.includes('private')); assert(!failed.data.job.error.includes('C:'));
  assert.equal((await f.receipt(uploaded.id)).status, 409);
});

test('relay cleanup persists expiration, retries a failed deletion, and retains completed history', async () => {
  const time = Date.parse('2026-10-25T04:00:00Z'), pendingId = randomUUID(), completeId = randomUUID();
  const rows = new Map([pendingId, completeId].map(id => [id, { id, kind:'upload', state:id === pendingId ? 'waiting_pc' : 'pc_saved', pcSavedAt:id === completeId ? new Date(time - 3600_000).toISOString() : undefined, request:spec(), createdAt:new Date(time - 24 * 3600_000).toISOString(), events:[] }]));
  let flushes = 0, firstFailed = false; const removed = [];
  const get = id => structuredClone(rows.get(id));
  const control = createIncomingControl({ all:() => [...rows.values()].map(job => structuredClone(job)), requireJob:get, save:job => { rows.set(job.id, structuredClone(job)); return job; }, event:(job, text) => job.events.push({ text }), clock:() => time, db:{ async flush() { flushes++; } }, transfers:{ async remove(name) { if (name === `incoming-${pendingId}.bin` && !firstFailed) { firstFailed = true; throw new Error('offline'); } removed.push(name); } } });
  await control.cleanExpiredTransfers();
  assert.equal(rows.get(pendingId).state, 'failed'); assert.equal(rows.get(pendingId).transferExpired, undefined);
  assert.equal(rows.get(completeId).transferExpired, true); assert.equal(rows.get(completeId).state, 'pc_saved'); assert(rows.get(completeId).pcSavedAt);
  await control.cleanExpiredTransfers(); assert.equal(rows.get(pendingId).transferExpired, true); assert.equal(removed.length, 2); assert.equal(flushes, 2);
  await control.cleanExpiredTransfers(); assert.equal(removed.length, 2, 'durably expired records do not delete repeatedly');
});
