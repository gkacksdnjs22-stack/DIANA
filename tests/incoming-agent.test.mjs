import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { receiveIncomingOnce, INCOMING_FOLDER } from '../agent/incoming.mjs';
import { sha256 } from '../agent/documents.mjs';
import { runAgent } from '../agent/run.mjs';
import { MAX_UPLOAD_BYTES } from '../lib/upload-contract.mjs';

const testsRoot = path.resolve(import.meta.dirname);
const sample = Buffer.concat([Buffer.from('휴대폰에서 보낸 원본 파일\r\n', 'utf8'), Buffer.from([0, 255, 128, 13, 10])]);
const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

async function fixture(t) {
  const directory = await mkdtemp(path.join(testsRoot, '.tmp-incoming-'));
  const documentRoot = path.join(directory, 'documents');
  await mkdir(documentRoot);
  t.after(async () => {
    const cleanup = await realpath(directory);
    const relative = path.relative(testsRoot, cleanup);
    if (path.isAbsolute(relative) || path.dirname(relative) !== '.' || !path.basename(relative).startsWith('.tmp-incoming-')) {
      throw new Error('Refusing cleanup outside the incoming test fixture.');
    }
    await rm(cleanup, { recursive: true, force: true });
  });
  const config = { apiBase: 'https://control.invalid', token: 'synthetic-agent-token', deviceId: 'incoming-test-pc', documentRoot };
  return { directory, documentRoot, config };
}

function manifest(overrides = {}, bytes = sample) {
  return { id: randomUUID(), deviceId: 'incoming-test-pc', filename: '휴대폰 원본.bin', sha256: sha256(bytes), bytes: bytes.length, ...overrides };
}

function server({ upload, bytes = sample, download, received, failed } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer synthetic-agent-token');
    assert.equal(options.redirect, 'error');
    assert(options.signal instanceof AbortSignal);
    const route = new URL(url).pathname;
    const call = { route, method: options.method, ...(options.body ? { body: JSON.parse(options.body) } : {}) };
    calls.push(call);
    if (route === '/api/agent/uploads/next') return jsonResponse({ upload });
    assert(upload, `Unexpected route without an upload: ${route}`);
    if (route === `/api/agent/uploads/${upload.id}/file`) return download ? download(call, calls) : new Response(bytes);
    if (route === `/api/agent/uploads/${upload.id}/received`) return received ? received(call, calls) : jsonResponse({ job: { id: upload.id, kind: 'upload', state: 'pc_saved', pcSavedAt: new Date().toISOString() } });
    if (route === `/api/agent/uploads/${upload.id}/failed`) return failed ? failed(call, calls) : jsonResponse({ job: { id: upload.id, kind: 'upload', state: 'failed' } });
    assert.fail(`Unexpected route: ${route}`);
  };
  return { fetchImpl, calls };
}

const targetFor = (config, upload) => path.join(config.documentRoot, INCOMING_FOLDER, upload.id, upload.filename);
const receipts = calls => calls.filter(call => call.route.endsWith('/received'));
const failures = calls => calls.filter(call => call.route.endsWith('/failed'));
const downloads = calls => calls.filter(call => call.route.endsWith('/file'));

test('incoming receiver saves exact bytes in the fixed job folder and confirms only the manifest', async t => {
  const { config, documentRoot } = await fixture(t);
  const upload = manifest();
  const mock = server({ upload });
  const result = await receiveIncomingOnce({ config, fetchImpl: mock.fetchImpl });
  assert.deepEqual(result, { idle: false, action: 'receive', jobId: upload.id, status: 'pc_saved' });
  assert.deepEqual(await readFile(targetFor(config, upload)), sample);
  assert.deepEqual(await readdir(documentRoot), [INCOMING_FOLDER]);
  assert.deepEqual(await readdir(path.dirname(targetFor(config, upload))), [upload.filename]);
  assert.deepEqual(receipts(mock.calls).map(call => call.body), [{ filename: upload.filename, sha256: upload.sha256, bytes: upload.bytes }]);
  assert.deepEqual(mock.calls.map(call => call.method), ['GET', 'GET', 'POST']);
  assert.equal(failures(mock.calls).length, 0);
  assert.equal(JSON.stringify(receipts(mock.calls)).includes(documentRoot), false);
});

test('incoming receiver leaves preexisting originals untouched and separates identical names by job', async t => {
  const { config, documentRoot } = await fixture(t);
  const original = path.join(documentRoot, 'same.txt');
  await writeFile(original, 'existing PC original');
  const first = manifest({ filename: 'same.txt' });
  const secondBytes = Buffer.from('a different phone file');
  const second = manifest({ filename: 'same.txt' }, secondBytes);
  await receiveIncomingOnce({ config, fetchImpl: server({ upload: first }).fetchImpl });
  await receiveIncomingOnce({ config, fetchImpl: server({ upload: second, bytes: secondBytes }).fetchImpl });
  assert.equal(await readFile(original, 'utf8'), 'existing PC original');
  assert.deepEqual(await readFile(targetFor(config, first)), sample);
  assert.deepEqual(await readFile(targetFor(config, second)), secondBytes);
});

test('invalid IDs, device routing and unsafe metadata never download or create a directory', async t => {
  const { config, documentRoot } = await fixture(t);
  const cases = [
    { id: '../outside' }, { deviceId: 'another-pc' }, { filename: '../escape.txt' },
    { filename: 'C:\\outside.txt' }, { filename: '.env' }, { filename: 'CON.txt' },
    { filename: 'name\u202e.txt' }, { filename: 'trailing.' }, { filename: 'a'.repeat(181) },
    { sha256: 'A'.repeat(64) }, { sha256: 'bad' }, { bytes: 0 }, { bytes: MAX_UPLOAD_BYTES + 1 },
  ];
  for (const overrides of cases) {
    const mock = server({ upload: manifest(overrides) });
    await assert.rejects(receiveIncomingOnce({ config, fetchImpl: mock.fetchImpl }));
    assert.deepEqual(mock.calls.map(call => call.route), ['/api/agent/uploads/next']);
    assert.deepEqual(await readdir(documentRoot), []);
  }
});

test('a lost save receipt retries the same local file without redownloading or duplicating it', async t => {
  const { config } = await fixture(t);
  const upload = manifest();
  let loseReceipt = true;
  const mock = server({ upload, received: () => {
    if (loseReceipt) { loseReceipt = false; throw new TypeError('synthetic receipt connection loss'); }
    return jsonResponse({ job: { id: upload.id, kind: 'upload', state: 'pc_saved', pcSavedAt: new Date().toISOString() } });
  } });
  await assert.rejects(receiveIncomingOnce({ config, fetchImpl: mock.fetchImpl }), /connection loss/);
  const before = await lstat(targetFor(config, upload));
  await receiveIncomingOnce({ config, fetchImpl: mock.fetchImpl });
  const after = await lstat(targetFor(config, upload));
  assert.equal(downloads(mock.calls).length, 1);
  assert.equal(receipts(mock.calls).length, 2);
  assert.equal(failures(mock.calls).length, 0);
  assert.equal(before.ino, after.ino);
  assert.equal(before.mtimeMs, after.mtimeMs);
  assert.deepEqual(await readdir(path.dirname(targetFor(config, upload))), [upload.filename]);
});

test('an existing wrong file fails without overwrite, download or success acknowledgement', async t => {
  const { config } = await fixture(t);
  const upload = manifest();
  const target = targetFor(config, upload);
  await mkdir(path.dirname(target), { recursive: true });
  const wrong = Buffer.alloc(sample.length, 65);
  await writeFile(target, wrong);
  const mock = server({ upload });
  const result = await receiveIncomingOnce({ config, fetchImpl: mock.fetchImpl });
  assert.equal(result.status, 'failed');
  assert.deepEqual(await readFile(target), wrong);
  assert.equal(downloads(mock.calls).length, 0);
  assert.equal(receipts(mock.calls).length, 0);
  assert.equal(failures(mock.calls).length, 1);
  assert.deepEqual(Object.keys(failures(mock.calls)[0].body), ['error']);
  assert.equal(JSON.stringify(failures(mock.calls)).includes(config.documentRoot), false);
  assert.equal(JSON.stringify(failures(mock.calls)).includes(config.token), false);
});

for (const [name, makeResponse] of [
  ['corrupt bytes', () => new Response(Buffer.alloc(sample.length, 66))],
  ['empty bytes', () => new Response(new Uint8Array())],
  ['too many streamed bytes', () => new Response(Buffer.alloc(MAX_UPLOAD_BYTES + 1, 67))],
  ['an oversized declared length', () => new Response(sample, { headers: { 'Content-Length': String(MAX_UPLOAD_BYTES + 1) } })],
  ['an invalid declared length', () => new Response(sample, { headers: { 'Content-Length': 'not-a-number' } })],
]) {
  test(`incoming receiver rejects ${name} without publishing or acknowledging`, async t => {
    const { config } = await fixture(t);
    const upload = manifest();
    const mock = server({ upload, download: makeResponse });
    const result = await receiveIncomingOnce({ config, fetchImpl: mock.fetchImpl });
    assert.equal(result.status, 'failed');
    assert.equal(receipts(mock.calls).length, 0);
    assert.equal(failures(mock.calls).length, 1);
    assert.deepEqual(await readdir(path.dirname(targetFor(config, upload))), []);
  });
}

for (const level of ['inbox', 'job']) {
  test(`incoming receiver refuses an outside ${level} junction or symlink`, async t => {
    const { directory, config } = await fixture(t);
    const outside = path.join(directory, 'outside');
    await mkdir(outside);
    const upload = manifest();
    const inbox = path.join(config.documentRoot, INCOMING_FOLDER);
    if (level === 'job') await mkdir(inbox);
    try { await symlink(outside, level === 'inbox' ? inbox : path.join(inbox, upload.id), process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { if (error.code === 'EPERM') { t.skip('This Windows sandbox does not permit junctions.'); return; } throw error; }
    const mock = server({ upload });
    const result = await receiveIncomingOnce({ config, fetchImpl: mock.fetchImpl });
    assert.equal(result.status, 'failed');
    assert.deepEqual(await readdir(outside), []);
    assert.equal(downloads(mock.calls).length, 0);
    assert.equal(receipts(mock.calls).length, 0);
    assert.equal(failures(mock.calls).length, 1);
  });
}

test('abort at the end of downloading cannot publish or acknowledge a file', async t => {
  const { config } = await fixture(t);
  const upload = manifest();
  const controller = new AbortController();
  let reads = 0;
  const mock = server({ upload, download: () => ({
    ok: true, headers: new Headers(), body: { getReader: () => ({
      read: async () => { if (reads++ === 0) return { done: false, value: sample }; controller.abort(); return { done: true }; },
      releaseLock() {},
    }) },
  }) });
  await assert.rejects(receiveIncomingOnce({ config, fetchImpl: mock.fetchImpl, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(receipts(mock.calls).length, 0);
  assert.equal(failures(mock.calls).length, 0);
  assert.deepEqual(await readdir(path.dirname(targetFor(config, upload))), []);
});

for (const [name, download] of [
  ['connection loss', () => { throw new TypeError('synthetic network failure'); }],
  ['HTTP error', () => new Response('temporarily unavailable', { status: 503 })],
  ['stream connection loss', () => new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('synthetic broken stream')); } }))],
]) {
  test(`incoming ${name} stays pending and can be retried`, async t => {
    const { config } = await fixture(t);
    const upload = manifest();
    const mock = server({ upload, download });
    await assert.rejects(receiveIncomingOnce({ config, fetchImpl: mock.fetchImpl }));
    assert.equal(receipts(mock.calls).length, 0);
    assert.equal(failures(mock.calls).length, 0);
    assert.deepEqual(await readdir(path.dirname(targetFor(config, upload))), []);
    const retried = await receiveIncomingOnce({ config, fetchImpl: server({ upload }).fetchImpl });
    assert.equal(retried.status, 'pc_saved');
  });
}

test('an older server missing the endpoint is idle without creating files', async t => {
  const { config, documentRoot } = await fixture(t);
  let polls = 0;
  const result = await receiveIncomingOnce({ config, fetchImpl: async () => { polls++; return new Response('not found', { status: 404 }); } });
  assert.deepEqual(result, { idle: true, unsupported: true });
  assert.equal(polls, 1);
  assert.deepEqual(await readdir(documentRoot), []);
});

test('invalid save acknowledgement remains retryable without changing the published file', async t => {
  const { config } = await fixture(t);
  const upload = manifest();
  let invalid = true;
  const mock = server({ upload, received: () => jsonResponse({ job: {
    id: invalid ? 'wrong-id' : upload.id, kind: 'upload', state: 'pc_saved', pcSavedAt: new Date().toISOString(),
  } }) });
  await assert.rejects(receiveIncomingOnce({ config, fetchImpl: mock.fetchImpl }), /응답/);
  const before = await lstat(targetFor(config, upload));
  invalid = false;
  await receiveIncomingOnce({ config, fetchImpl: mock.fetchImpl });
  const after = await lstat(targetFor(config, upload));
  assert.equal(downloads(mock.calls).length, 1);
  assert.equal(receipts(mock.calls).length, 2);
  assert.equal(failures(mock.calls).length, 0);
  assert.equal(before.ino, after.ino);
  assert.equal(before.mtimeMs, after.mtimeMs);
  assert.deepEqual(await readFile(targetFor(config, upload)), sample);
});

test('the normal agent receives a file and refreshes its searchable catalog', async t => {
  const { config } = await fixture(t);
  const content = Buffer.from('휴대폰에서 전송한 검색 가능 문서');
  const upload = manifest({ filename: '모바일 문서.txt' }, content);
  const mock = server({ upload, bytes: content });
  const controller = new AbortController();
  const catalogs = [];
  const env = { API_BASE_URL: config.apiBase, AGENT_TOKEN: config.token, DEVICE_ID: config.deviceId, DOCUMENT_ROOT: config.documentRoot, AI_MODE: 'lexical', MAIL_MODE: 'dry-run' };
  await runAgent({ env, signal: controller.signal, logger: { log() {}, error(message) { assert.fail(message); } }, fetchImpl: async (url, options) => {
    if (url.endsWith('/api/agent/catalog')) { catalogs.push(JSON.parse(options.body)); controller.abort(); return jsonResponse({ ok: true }); }
    if (url.endsWith('/api/agent/next')) return jsonResponse({ job: null });
    return mock.fetchImpl(url, options);
  } });
  assert.equal(catalogs.length, 1);
  assert.equal(catalogs[0].documents.length, 1);
  assert.equal(catalogs[0].documents[0].filename, upload.filename);
  assert.equal(catalogs[0].documents[0].sha256, upload.sha256);
  assert.equal(catalogs[0].documents[0].bytes, content.length);
  assert.equal(receipts(mock.calls).length, 1);
});
