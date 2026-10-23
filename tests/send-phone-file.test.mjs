import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { sendPhoneFile } from '../scripts/send-phone-file.mjs';
import { isUploadId, MAX_UPLOAD_BYTES } from '../lib/upload-contract.mjs';

const testsRoot = path.resolve(import.meta.dirname);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const contents = Buffer.concat([Buffer.from('DIANA 앱 배포 검증\r\n'), Buffer.from([0, 255, 128, 13, 10])]);
const syntheticEnv = { API_BASE_URL: 'https://control.invalid', USER_TOKEN: 'synthetic-owner-token' };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

async function fixture(t) {
  const directory = await mkdtemp(path.join(testsRoot, '.tmp-send-phone-'));
  t.after(async () => {
    const cleanup = await realpath(directory);
    const relative = path.relative(testsRoot, cleanup);
    if (path.isAbsolute(relative) || path.dirname(relative) !== '.' || !path.basename(relative).startsWith('.tmp-send-phone-')) {
      throw new Error('Refusing cleanup outside the phone delivery test fixture.');
    }
    await rm(cleanup, { recursive: true, force: true });
  });
  const filename = path.join(directory, 'DIANA 설치 파일.apk');
  const stateDir = path.join(directory, 'delivery-state');
  await writeFile(filename, contents);
  return { directory, filename, stateDir };
}

function accepted(url, options, overrides = {}) {
  const id = new URL(url).pathname.split('/').at(-1);
  return { job: { id, kind: 'delivery', state: 'download_ready', artifact: {
    filename: decodeURIComponent(options.headers['X-File-Name']), sha256: options.headers['X-File-SHA256'], bytes: options.body.length,
  }, ...overrides } };
}

async function ledgerEntries(stateDir) {
  const names = await readdir(stateDir);
  assert(names.every(name => name.endsWith('.json')), 'Successful ledger writes leave no temporary files.');
  return Promise.all(names.map(async name => ({ name, value: JSON.parse(await readFile(path.join(stateDir, name), 'utf8')) })));
}

test('explicit phone delivery sends exact bytes and authenticated metadata without changing the local file', async t => {
  const { filename, stateDir } = await fixture(t);
  const before = await stat(filename);
  const calls = [];
  const env = { ...syntheticEnv, USER_TOKEN: `  ${syntheticEnv.USER_TOKEN}  ` };
  const result = await sendPhoneFile(filename, { env, stateDir, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert(options.signal instanceof AbortSignal);
    assert.equal(options.headers.Authorization, `Bearer ${syntheticEnv.USER_TOKEN}`);
    assert.equal(options.headers['Content-Type'], 'application/octet-stream');
    assert.equal(options.headers['X-File-Name'], encodeURIComponent(path.basename(filename)));
    assert.equal(options.headers['X-File-SHA256'], hash(contents));
    assert.deepEqual(options.body, contents);
    return json(accepted(url, options));
  } });
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).origin, syntheticEnv.API_BASE_URL);
  assert.match(new URL(calls[0].url).pathname, /^\/api\/deliveries\//);
  assert(isUploadId(result.id));
  assert.deepEqual(result, { id: result.id, filename: path.basename(filename), bytes: contents.length, sha256: hash(contents), state: 'download_ready', duplicate: false });
  const after = await stat(filename);
  assert.equal(before.ino, after.ino);
  assert.equal(before.mtimeMs, after.mtimeMs);
  assert.deepEqual(await readFile(filename), contents);
  const entries = await ledgerEntries(stateDir);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].value.id, result.id);
  assert.equal(JSON.stringify(entries).includes(syntheticEnv.USER_TOKEN), false);
  assert.equal(JSON.stringify(entries).includes(filename), false);
});

test('a new invocation after an ambiguous network response reuses the persisted UUID and payload', async t => {
  const { filename, stateDir } = await fixture(t);
  const requests = [];
  const lost = async (url, options) => { requests.push({ url, options }); throw new TypeError('synthetic ambiguous connection loss'); };
  await assert.rejects(sendPhoneFile(filename, { env: syntheticEnv, stateDir, fetchImpl: lost }), /connection loss/);
  const pending = await ledgerEntries(stateDir);
  assert.equal(pending.length, 1);
  const result = await sendPhoneFile(filename, { env: syntheticEnv, stateDir, fetchImpl: async (url, options) => {
    requests.push({ url, options }); return json({ ...accepted(url, options), duplicate: true });
  } });
  assert.equal(result.id, pending[0].value.id);
  assert.equal(requests[0].url, requests[1].url);
  assert.deepEqual(requests[0].options.body, requests[1].options.body);
  assert.deepEqual(requests[0].options.headers, requests[1].options.headers);
  assert.equal(result.duplicate, true);
  assert.equal((await ledgerEntries(stateDir)).length, 1);
});

for (const field of ['id', 'kind', 'state', 'filename', 'sha256', 'bytes', 'missing artifact']) {
  test(`a mismatched ${field} response preserves the delivery UUID for a valid retry`, async t => {
    const { filename, stateDir } = await fixture(t);
    const requests = [];
    await assert.rejects(sendPhoneFile(filename, { env: syntheticEnv, stateDir, fetchImpl: async (url, options) => {
      requests.push(url);
      const result = accepted(url, options);
      if (field === 'id') result.job.id = 'wrong-id';
      else if (field === 'kind') result.job.kind = 'upload';
      else if (field === 'state') result.job.state = 'failed';
      else if (field === 'missing artifact') delete result.job.artifact;
      else if (field === 'bytes') result.job.artifact.bytes += 1;
      else result.job.artifact[field] = 'incorrect';
      return json(result);
    } }), /응답/);
    const result = await sendPhoneFile(filename, { env: syntheticEnv, stateDir, fetchImpl: async (url, options) => { requests.push(url); return json(accepted(url, options)); } });
    assert.equal(requests[0], requests[1]);
    assert.equal(result.id, (await ledgerEntries(stateDir))[0].value.id);
    assert.deepEqual(await readFile(filename), contents);
  });
}

test('invalid JSON and HTTP errors preserve a pending request for a later retry', async t => {
  const { filename, stateDir } = await fixture(t);
  const urls = [];
  for (const makeResponse of [() => new Response('not json'), () => new Response('temporary server error', { status: 503 })]) {
    await assert.rejects(sendPhoneFile(filename, { env: syntheticEnv, stateDir, fetchImpl: async url => { urls.push(url); return makeResponse(); } }));
  }
  const result = await sendPhoneFile(filename, { env: syntheticEnv, stateDir, fetchImpl: async (url, options) => { urls.push(url); return json(accepted(url, options)); } });
  assert.equal(new Set(urls).size, 1);
  assert.equal(result.id, (await ledgerEntries(stateDir))[0].value.id);
});

test('a server-confirmed phone save is returned without guessing from upload success', async t => {
  const { filename, stateDir } = await fixture(t);
  const phoneSavedAt = '2026-10-23T06:00:00.000Z';
  const result = await sendPhoneFile(filename, { env: syntheticEnv, stateDir, fetchImpl: async (url, options) => json(accepted(url, options, { phoneSavedAt })) });
  assert.equal(result.phoneSavedAt, phoneSavedAt);
});

test('missing, empty, oversized and unsafe-named files fail before any network call', async t => {
  const { directory, stateDir } = await fixture(t);
  const empty = path.join(directory, 'empty.apk');
  const oversized = path.join(directory, 'oversized.apk');
  const invalidName = path.join(directory, '.hidden.apk');
  await writeFile(empty, Buffer.alloc(0));
  await writeFile(invalidName, contents);
  const handle = await open(oversized, 'wx');
  try { await handle.truncate(MAX_UPLOAD_BYTES + 1); } finally { await handle.close(); }
  for (const filename of [path.join(directory, 'missing.apk'), empty, oversized, invalidName, directory]) {
    await assert.rejects(sendPhoneFile(filename, { env: syntheticEnv, stateDir, fetchImpl: () => assert.fail('Invalid files must not be transmitted.') }));
  }
  await assert.rejects(stat(stateDir), { code: 'ENOENT' });
  assert.deepEqual(await readFile(invalidName), contents);
});

test('the delivery UUID is reused before 24 hours and renewed at the retention boundary', async t => {
  const { filename, stateDir } = await fixture(t);
  const initialTime = Date.parse('2026-10-23T01:00:00.000Z');
  let time = initialTime;
  const options = { env: syntheticEnv, stateDir, now: () => time, fetchImpl: async (url, request) => json(accepted(url, request)) };
  const first = await sendPhoneFile(filename, options);
  time += 24 * 3600_000 - 1;
  const beforeExpiry = await sendPhoneFile(filename, options);
  assert.equal(first.id, beforeExpiry.id);
  time += 1;
  const expired = await sendPhoneFile(filename, options);
  assert.notEqual(expired.id, first.id);
  assert(isUploadId(expired.id));
  const entries = await ledgerEntries(stateDir);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].value.id, expired.id);
  assert.equal(Date.parse(entries[0].value.createdAt), time);
});

test('changed file contents create a distinct delivery without disturbing the first ledger', async t => {
  const { filename, stateDir } = await fixture(t);
  const options = { env: syntheticEnv, stateDir, fetchImpl: async (url, request) => json(accepted(url, request)) };
  const first = await sendPhoneFile(filename, options);
  const replacement = Buffer.from('a separately built APK');
  await writeFile(filename, replacement);
  const second = await sendPhoneFile(filename, options);
  assert.notEqual(first.id, second.id);
  assert.equal(second.sha256, hash(replacement));
  assert.equal((await ledgerEntries(stateDir)).length, 2);
  assert.deepEqual(await readFile(filename), replacement);
});

test('invalid server URLs and malformed owner tokens fail before any network request', async t => {
  const { filename, stateDir } = await fixture(t);
  const overrides = [
    { API_BASE_URL: '' }, { API_BASE_URL: 'http://remote.invalid' }, { API_BASE_URL: 'ftp://control.invalid' },
    { API_BASE_URL: 'https://user:password@control.invalid' }, { API_BASE_URL: 'https://control.invalid?secret=value' },
    { API_BASE_URL: 'https://control.invalid#fragment' }, { USER_TOKEN: '' }, { USER_TOKEN: '   ' },
    { USER_TOKEN: 'owner\r\ninjected:value' }, { USER_TOKEN: 'owner\nvalue' },
  ];
  for (const override of overrides) {
    await assert.rejects(sendPhoneFile(filename, { env: { ...syntheticEnv, ...override }, stateDir, fetchImpl: () => assert.fail('Invalid configuration must not reach the network.') }));
  }
  await assert.rejects(stat(stateDir), { code: 'ENOENT' });
});

test('loopback HTTP remains usable for a local test server', async t => {
  const { filename, stateDir } = await fixture(t);
  const env = { ...syntheticEnv, API_BASE_URL: 'http://127.0.0.1:3410/' };
  const result = await sendPhoneFile(filename, { env, stateDir, fetchImpl: async (url, options) => {
    assert.equal(new URL(url).origin, 'http://127.0.0.1:3410');
    assert.match(new URL(url).pathname, /^\/api\/deliveries\//);
    return json(accepted(url, options));
  } });
  assert.equal(result.state, 'download_ready');
});

test('a corrupt pending ledger is never replaced with a new request automatically', async t => {
  const { filename, stateDir } = await fixture(t);
  await sendPhoneFile(filename, { env: syntheticEnv, stateDir, fetchImpl: async (url, options) => json(accepted(url, options)) });
  const [{ name }] = await ledgerEntries(stateDir);
  const ledger = path.join(stateDir, name);
  for (const corrupted of ['not json', JSON.stringify({ id: '../wrong', createdAt: new Date().toISOString() }), JSON.stringify({ id: '9f258b2d-b2f2-4638-8b37-c1e75fe7928b', createdAt: 'invalid date' })]) {
    await writeFile(ledger, corrupted);
    await assert.rejects(sendPhoneFile(filename, { env: syntheticEnv, stateDir, fetchImpl: () => assert.fail('An ambiguous ledger must not create a new delivery.') }));
    assert.equal(await readFile(ledger, 'utf8'), corrupted);
  }
});
