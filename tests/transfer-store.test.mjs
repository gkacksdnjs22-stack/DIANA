import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { createSupabaseTransferStore } from '../lib/transfer-store.mjs';
import { createControlServer } from '../lib/control.mjs';

const CONTENT = Buffer.from('verified file contents');
const TOKENS = { userToken: 'u'.repeat(40), agentToken: 'a'.repeat(40), gatewayToken: 'g'.repeat(40) };

// Return HTTP responses through the real Supabase SDK, so its conversion of
// payload.code into StorageApiError.statusCode is part of every regression.
function storageFixture(t, responses) {
  const pending = [...responses];
  const calls = [];
  const store = createSupabaseTransferStore({
    url: 'https://transfer-tests.supabase.co',
    serviceRoleKey: 'test-service-role-key',
    fetch: async (input, options = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      const method = options.method || input.method || 'GET';
      const response = pending.shift();
      assert.ok(response, `Unexpected Storage ${method} ${url.pathname}`);
      assert.equal(url.origin, 'https://transfer-tests.supabase.co');
      assert.equal(method, response.method);
      assert.equal(url.pathname, `/storage/v1/object/diana-transfers/${response.name || 'file.bin'}`);
      calls.push({ method, body: options.body, headers: new Headers(options.headers) });
      return response.bytes
        ? new Response(response.bytes, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } })
        : Response.json(response.json, { status: response.status });
    },
  });
  t.after(() => assert.equal(pending.length, 0, 'All expected Storage requests must be made'));
  return { store, calls };
}

test('a new-format NoSuchKey response is a missing file through the actual Supabase SDK', async t => {
  const { store } = storageFixture(t, [
    { method: 'GET', status: 404, json: { code: 'NoSuchKey', message: 'The specified key does not exist' } },
  ]);
  assert.equal(await store.read('file.bin'), null);
});

for (const status of [400, 404]) {
  test(`a legacy numeric 404 payload remains a missing file over HTTP ${status}`, async t => {
    const { store } = storageFixture(t, [
      { method: 'GET', status, json: { statusCode: '404', error: 'not_found', message: 'Object not found' } },
    ]);
    assert.equal(await store.read('file.bin'), null);
  });
}

test('a legacy not_found code over HTTP 400 remains a missing object', async t => {
  const { store } = storageFixture(t, [
    { method: 'GET', status: 400, json: { httpStatusCode: 400, code: 'not_found', message: 'Object not found' } },
  ]);
  assert.equal(await store.read('file.bin'), null);
});

const duplicateResponses = [
  { label: 'ResourceAlreadyExists', status: 409, json: { code: 'ResourceAlreadyExists', message: 'The resource already exists' } },
  { label: 'KeyAlreadyExists', status: 409, json: { code: 'KeyAlreadyExists', message: 'The key already exists' } },
  { label: 'legacy numeric 409 over HTTP 409', status: 409, json: { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' } },
  { label: 'legacy numeric 409 over HTTP 400', status: 400, json: { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' } },
  { label: 'legacy already_exists code over HTTP 400', status: 400, json: { httpStatusCode: 400, code: 'already_exists', message: 'The resource already exists' } },
];

for (const { label, status, json } of duplicateResponses) {
  test(`${label} permits replay only after downloading and comparing the existing file`, async t => {
    const { store, calls } = storageFixture(t, [
      { method: 'POST', status, json },
      { method: 'GET', bytes: CONTENT },
    ]);
    await store.put('file.bin', CONTENT);
    assert.deepEqual(calls.map(call => call.method), ['POST', 'GET']);
    assert.deepEqual(Buffer.from(calls[0].body), CONTENT);
    assert.equal(calls[0].headers.get('x-upsert'), 'false');
  });

  test(`${label} rejects a replay containing different bytes`, async t => {
    const { store } = storageFixture(t, [
      { method: 'POST', status, json },
      { method: 'GET', bytes: Buffer.from('another stored file') },
    ]);
    await assert.rejects(store.put('file.bin', CONTENT), /이미 다른 파일이 저장되었습니다/);
  });
}

for (const [status, code] of [[404, 'NoSuchBucket'], [404, 'UnknownStorageError'], [403, 'AccessDenied'], [401, 'InvalidJWT'], [500, 'InternalError']]) {
  test(`a download ${status} ${code} remains an error rather than a missing object`, async t => {
    const { store } = storageFixture(t, [
      { method: 'GET', status, json: { code, message: 'Storage request failed' } },
    ]);
    await assert.rejects(store.read('file.bin'), error => {
      assert.match(error.message, /Supabase 파일 다운로드가 실패/);
      assert.equal(error.cause.status, status);
      assert.equal(error.cause.statusCode, code);
      return true;
    });
  });
}

for (const [status, code] of [[404, 'NoSuchBucket'], [403, 'AccessDenied'], [401, 'InvalidJWT'], [413, 'EntityTooLarge'], [500, 'InternalError'], [409, 'BucketAlreadyExists'], [409, 'UnknownStorageError']]) {
  test(`an upload ${status} ${code} is not treated as an existing-file replay`, async t => {
    const { store, calls } = storageFixture(t, [
      { method: 'POST', status, json: { code, message: 'Storage request failed' } },
    ]);
    await assert.rejects(store.put('file.bin', CONTENT), error => {
      assert.match(error.message, /Supabase 파일 업로드가 실패/);
      assert.equal(error.cause.status, status);
      assert.equal(error.cause.statusCode, code);
      return true;
    });
    assert.equal(calls.length, 1, 'A failed upload must not be followed by a replay download');
  });
}

test('recognized Storage codes cannot hide transport authentication failures or server errors', async t => {
  for (const [method, status, json] of [
    ['GET', 503, { code: 'NoSuchKey' }],
    ['GET', 403, { statusCode: '404' }],
    ['POST', 503, { code: 'ResourceAlreadyExists' }],
    ['POST', 403, { statusCode: '409' }],
  ]) {
    const { store, calls } = storageFixture(t, [{ method, status, json }]);
    const operation = method === 'GET' ? store.read('file.bin') : store.put('file.bin', CONTENT);
    await assert.rejects(operation, error => {
      assert.match(error.message, /Supabase 파일 (다운로드|업로드)가 실패/);
      assert.equal(error.cause.status, status);
      assert.equal(error.cause.statusCode, json.statusCode || json.code);
      return true;
    });
    assert.equal(calls.length, 1);
  }
});

test('the first control API upload reaches Storage upload after a new-format missing-file response', async t => {
  let server;
  t.after(async () => {
    if (!server?.listening) return;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const id = randomUUID();
  const name = `${id}.bin`;
  const { store, calls } = storageFixture(t, [
    { method: 'GET', name, status: 404, json: { code: 'NoSuchKey', message: 'The specified key does not exist' } },
    { method: 'POST', name, status: 200, json: { Key: `diana-transfers/${name}`, Id: randomUUID() } },
    { method: 'GET', name, bytes: CONTENT },
  ]);
  server = createControlServer({allowLegacyPlaintextTransfers:true, ...TOKENS, transfers: store });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, { token = TOKENS.userToken, method = 'GET', body } = {}) {
    const response = await fetch(base + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, data: await response.json() };
  }
  const digest = createHash('sha256').update(CONTENT).digest('hex');
  assert.equal((await request('/api/jobs', { method: 'POST', body: { requestId: id, query: 'report', delivery: 'download' } })).status, 201);
  assert.equal((await request('/api/agent/next', { token: TOKENS.agentToken })).data.job.action, 'search');
  assert.equal((await request(`/api/agent/jobs/${id}/candidates`, {
    token: TOKENS.agentToken,
    method: 'POST',
    body: { mode: 'lexical', candidates: [{ id: digest, sha256: digest, filename: 'report.txt', bytes: CONTENT.length, score: 1 }] },
  })).status, 200);
  assert.equal((await request(`/api/jobs/${id}/selection`, { method: 'POST', body: { candidateId: digest, approve: true } })).status, 200);
  assert.equal((await request('/api/agent/next', { token: TOKENS.agentToken })).data.job.action, 'send');

  const uploaded = await fetch(`${base}/api/agent/jobs/${id}/file`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKENS.agentToken}`,
      'Content-Type': 'application/octet-stream',
      'X-Source-File-Id': digest,
      'X-File-Sha256': digest,
      'X-File-Name': 'report.txt',
    },
    body: CONTENT,
  });
  assert.equal(uploaded.status, 200);
  assert.deepEqual(await uploaded.json(), { ok: true });
  const job = (await request('/api/jobs')).data.jobs[0];
  assert.equal(job.artifact.sha256, digest);
  assert.equal(job.artifact.bytes, CONTENT.length);
  const downloaded = await fetch(`${base}/api/jobs/${id}/file`, { headers: { Authorization: `Bearer ${TOKENS.userToken}` } });
  assert.equal(downloaded.status, 200);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), CONTENT);
  assert.deepEqual(calls.map(call => call.method), ['GET', 'POST', 'GET']);
});
