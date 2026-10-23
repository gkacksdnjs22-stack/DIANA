import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createPushDispatcher, readyPushKeys } from '../lib/push-dispatcher.mjs';

const NOW = Date.parse('2026-10-23T05:00:00Z');
const DAY = 24 * 3600_000;
const sha = value => createHash('sha256').update(value).digest('hex');
const stamp = time => new Date(time).toISOString();
const file = (name = 'photo.jpg', overrides = {}) => ({ filename:name, sha256:sha(name), bytes:123, ...overrides });
const job = (id = 'job-1', overrides = {}) => ({ id, kind:'delivery', state:'download_ready', request:{ delivery:'download' }, artifact:{ ...file(), createdAt:stamp(NOW) }, ...overrides });
const overnight = (id = 'overnight-1', overrides = {}) => ({ id, kind:'overnight', state:'awaiting_phone', completedAt:stamp(NOW), artifacts:[file('report.pdf'), file('slides.pptx')], ...overrides });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(t, { send = async () => ({ accepted:true }), jobs = [job()] } = {}) {
  const sql = new DatabaseSync(':memory:');
  sql.exec(`CREATE TABLE jobs(id TEXT PRIMARY KEY,data TEXT NOT NULL);
    CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE phone_devices(id TEXT PRIMARY KEY,token_hash TEXT UNIQUE NOT NULL,name TEXT NOT NULL,
      created_at TEXT NOT NULL,last_seen_at TEXT,fcm_token TEXT,revoked_at TEXT);`);
  let time = NOW;
  const calls = [], events = [], dispatchers = [];
  const db = {
    prepare:sql.prepare.bind(sql),
    async recover() { events.push('recover'); },
    async flush() { events.push('flush'); },
  };
  const addPhone = (id = 'phone-1', token = 'fcm-registration-1', revoked = null) => sql.prepare('INSERT INTO phone_devices(id,token_hash,name,created_at,fcm_token,revoked_at) VALUES(?,?,?,?,?,?)').run(id, sha(id), 'Test phone', stamp(NOW), token, revoked);
  const addJob = value => sql.prepare('INSERT INTO jobs(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(value.id, JSON.stringify(value));
  jobs.forEach(addJob);
  const create = (options = {}) => {
    const dispatcher = createPushDispatcher({ db, allJobs:() => sql.prepare('SELECT data FROM jobs ORDER BY id').all().map(row => JSON.parse(row.data)), sender:{ async send(token) { calls.push(token); events.push('send'); return send(token); } }, now:() => time, pollMs:0, ...options });
    dispatchers.push(dispatcher);
    return dispatcher;
  };
  t.after(() => { dispatchers.forEach(dispatcher => dispatcher.close()); sql.close(); });
  const ledger = () => {
    const row = sql.prepare('SELECT value FROM settings WHERE key=?').get('phonePushOutboxV1');
    return row ? JSON.parse(row.value) : null;
  };
  return { sql, db, calls, events, create, addPhone, addJob, ledger, setTime:value => { time = value; }, token:id => sql.prepare('SELECT fcm_token FROM phone_devices WHERE id=?').get(id).fcm_token };
}

test('readyPushKeys accepts only published file states for single-file and overnight jobs', () => {
  for (const state of ['download_ready','dry_run','submitted','send_unknown']) {
    for (const delivery of ['download','both']) assert.equal(readyPushKeys([job('single', { state, request:{ delivery } })], NOW).length, 1, `${state}/${delivery}`);
  }
  for (const state of ['awaiting_phone','download_ready','deadline_exceeded']) assert.equal(readyPushKeys([overnight('report', { state })], NOW).length, 1, state);
  for (const state of ['queued','sending','searching','needs_attention','failed','pc_saved']) {
    assert.deepEqual(readyPushKeys([job('single', { state }), overnight('report', { state })], NOW), [], state);
  }
  for (const delivery of [undefined, 'email', 'none']) assert.deepEqual(readyPushKeys([job('single', { request:{ delivery } })], NOW), []);
  assert.deepEqual(readyPushKeys([job('phone-upload', { kind:'upload' })], NOW), []);
});

test('readyPushKeys excludes incomplete metadata and files at the 24-hour expiry boundary', () => {
  const invalid = [
    job('missing', { artifact:null }),
    job('bad-hash', { artifact:{ ...file(), sha256:'invalid', createdAt:stamp(NOW) } }),
    job('uppercase-hash', { artifact:{ ...file(), sha256:'A'.repeat(64), createdAt:stamp(NOW) } }),
    job('zero', { artifact:{ ...file(), bytes:0, createdAt:stamp(NOW) } }),
    job('fraction', { artifact:{ ...file(), bytes:1.5, createdAt:stamp(NOW) } }),
    job('unsafe-size', { artifact:{ ...file(), bytes:Number.MAX_SAFE_INTEGER + 1, createdAt:stamp(NOW) } }),
    job('missing-date', { artifact:file() }),
    job('invalid-date', { artifact:{ ...file(), createdAt:'not-a-date' } }),
    job('expired-time', { artifact:{ ...file(), createdAt:stamp(NOW - DAY) } }),
    job('expired-file', { artifact:{ ...file(), createdAt:stamp(NOW), expired:true } }),
    job('expired-job', { artifactsExpired:true }),
    overnight('empty', { artifacts:[] }),
    overnight('missing-files', { artifacts:null }),
    overnight('partial', { artifacts:[file(), file('bad.pdf', { sha256:null })] }),
    overnight('missing-completion', { completedAt:null }),
    overnight('expired-report', { completedAt:stamp(NOW - DAY) }),
    overnight('expired-report-flag', { artifactsExpired:true }),
  ];
  assert.deepEqual(readyPushKeys(invalid, NOW), []);
  assert.equal(readyPushKeys([job('almost-expired', { artifact:{ ...file(), createdAt:stamp(NOW - DAY + 1) } })], NOW).length, 1);
});

test('readyPushKeys deduplicates jobs and changes identity when a result file changes', () => {
  const first = job(), duplicate = structuredClone(first);
  assert.equal(readyPushKeys([first, duplicate], NOW).length, 1);
  assert.notEqual(readyPushKeys([first], NOW)[0], readyPushKeys([job('job-1', { artifact:{ ...first.artifact, sha256:sha('new file') } })], NOW)[0]);
});

test('one generic push per phone coalesces multiple ready jobs and persists the receipts', async t => {
  const f = fixture(t, { jobs:[job('one'), job('two'), overnight()] });
  f.addPhone(); f.addPhone('phone-2', 'fcm-registration-2');
  const dispatcher = f.create();
  await dispatcher.drain();
  assert.deepEqual(f.calls, ['fcm-registration-1','fcm-registration-2']);
  assert.deepEqual(f.events.slice(0, 3), ['recover','flush','send']);
  const ledger = f.ledger();
  assert.equal(ledger.phones['phone-1'].notified.length, 3);
  assert.equal(ledger.phones['phone-2'].notified.length, 3);
  assert.equal(ledger.phones['phone-1'].registration, sha('fcm-registration-1'));
  assert.equal(JSON.stringify(ledger).includes('fcm-registration-1'), false);
  await dispatcher.drain();
  assert.equal(f.calls.length, 2);
});

test('recreating the dispatcher keeps deduplication and a new ready job sends once', async t => {
  const f = fixture(t); f.addPhone();
  const first = f.create(); await first.drain(); first.close();
  const second = f.create(); await second.drain();
  assert.equal(f.calls.length, 1);
  f.addJob(job('new-job'));
  await second.drain(); await second.drain();
  assert.equal(f.calls.length, 2);
  assert.equal(f.ledger().phones['phone-1'].notified.length, 2);
});

test('a rotated registration receives current files once without inheriting old receipts', async t => {
  const f = fixture(t); f.addPhone(); const dispatcher = f.create();
  await dispatcher.drain();
  f.sql.prepare('UPDATE phone_devices SET fcm_token=? WHERE id=?').run('new-registration', 'phone-1');
  await dispatcher.drain(); await dispatcher.drain();
  assert.deepEqual(f.calls, ['fcm-registration-1','new-registration']);
  assert.equal(f.ledger().phones['phone-1'].registration, sha('new-registration'));
  assert.equal(f.ledger().phones['phone-1'].notified.length, 1);
});

test('revoked, absent, empty and oversized registrations are never sent', async t => {
  const f = fixture(t);
  f.addPhone('revoked', 'revoked-registration', stamp(NOW));
  f.addPhone('absent', null); f.addPhone('empty', ''); f.addPhone('oversized', 'x'.repeat(4097));
  await f.create().drain();
  assert.deepEqual(f.calls, []);
});

test('transient failures back off, redact provider detail, and recover after acceptance', async t => {
  let attempts = 0;
  const f = fixture(t, { send:async () => {
    attempts++;
    if (attempts === 1) throw Object.assign(new Error('secret provider response and private registration'), { code:'HTTP_RESPONSE_CONTAINING_SECRET' });
    if (attempts === 2) throw Object.assign(new Error('sensitive transport detail'), { code:'FIREBASE_TRANSPORT' });
    return { accepted:true };
  } });
  f.addPhone(); const dispatcher = f.create(); await dispatcher.drain();
  let entry = f.ledger().phones['phone-1'];
  assert.equal(entry.attempts, 1); assert.equal(entry.nextAt, NOW + 5000); assert.equal(entry.errorCode, 'FIREBASE_SEND');
  assert.equal(JSON.stringify(f.ledger()).includes('secret'), false);
  f.setTime(NOW + 4999); await dispatcher.drain(); assert.equal(f.calls.length, 1);
  f.setTime(NOW + 5000); await dispatcher.drain();
  entry = f.ledger().phones['phone-1'];
  assert.equal(entry.attempts, 2); assert.equal(entry.nextAt, NOW + 15000); assert.equal(entry.errorCode, 'FIREBASE_TRANSPORT');
  f.setTime(NOW + 14999); await dispatcher.drain(); assert.equal(f.calls.length, 2);
  f.setTime(NOW + 15000); await dispatcher.drain();
  entry = f.ledger().phones['phone-1'];
  assert.equal(f.calls.length, 3); assert.equal(entry.attempts, 0); assert.equal(entry.nextAt, 0); assert.equal(entry.errorCode, undefined); assert.equal(entry.notified.length, 1);
});

test('an unaccepted send result is retried and never records successful delivery', async t => {
  const f = fixture(t, { send:async () => ({ accepted:false }) }); f.addPhone();
  await f.create().drain();
  const entry = f.ledger().phones['phone-1'];
  assert.equal(entry.errorCode, 'FIREBASE_SEND'); assert.equal(entry.notified.length, 0); assert.equal(entry.nextAt, NOW + 5000);
});

test('an unregistered response clears the obsolete token and its receipts', async t => {
  const f = fixture(t, { send:async () => { throw Object.assign(new Error('unregistered'), { unregistered:true }); } });
  f.addPhone(); const dispatcher = f.create(); await dispatcher.drain();
  assert.equal(f.token('phone-1'), null); assert.equal(f.ledger().phones['phone-1'], undefined);
  await dispatcher.drain(); assert.equal(f.calls.length, 1);
});

test('an old asynchronous unregistered response cannot clear a fresh token', async t => {
  const pending = deferred(), entered = deferred();
  const f = fixture(t, { send:async token => {
    if (token === 'fcm-registration-1') { entered.resolve(); return pending.promise; }
    return { accepted:true };
  } });
  f.addPhone(); const dispatcher = f.create(); const running = dispatcher.drain(); await entered.promise;
  f.sql.prepare('UPDATE phone_devices SET fcm_token=? WHERE id=?').run('fresh-registration', 'phone-1');
  pending.reject(Object.assign(new Error('old token is gone'), { unregistered:true })); await running;
  assert.equal(f.token('phone-1'), 'fresh-registration');
  await dispatcher.drain();
  assert.deepEqual(f.calls, ['fcm-registration-1','fresh-registration']);
  assert.equal(f.ledger().phones['phone-1'].registration, sha('fresh-registration'));
});

test('concurrent drain and kick calls share one in-flight send', async t => {
  const pending = deferred(), entered = deferred();
  const f = fixture(t, { send:async () => { entered.resolve(); return pending.promise; } }); f.addPhone();
  const dispatcher = f.create(); const first = dispatcher.drain(), second = dispatcher.drain();
  assert.equal(first, second); dispatcher.kick(); await entered.promise;
  assert.equal(f.calls.length, 1); pending.resolve({ accepted:true }); await first;
  await dispatcher.drain(); assert.equal(f.calls.length, 1);
});

test('a durable flush failure prevents sending or recording a receipt', async t => {
  const f = fixture(t); f.addPhone();
  f.db.flush = async () => { throw new Error('database flush failed'); };
  await assert.rejects(f.create().drain(), /database flush failed/);
  assert.deepEqual(f.calls, []); assert.equal(f.ledger(), null);
});

test('a dispatcher closed during a successful callback never writes its receipt', async t => {
  const pending = deferred(), entered = deferred();
  const f = fixture(t, { send:async () => { entered.resolve(); return pending.promise; } }); f.addPhone();
  const dispatcher = f.create(), running = dispatcher.drain(); await entered.promise; dispatcher.close();
  pending.resolve({ accepted:true }); await running;
  assert.equal(f.ledger(), null); assert.equal(f.events.filter(event => event === 'flush').length, 1);
  await dispatcher.drain(); assert.equal(f.calls.length, 1);
});

test('a dispatcher closed during an unregistered callback does not mutate the device', async t => {
  const pending = deferred(), entered = deferred();
  const f = fixture(t, { send:async () => { entered.resolve(); return pending.promise; } }); f.addPhone();
  const dispatcher = f.create(), running = dispatcher.drain(); await entered.promise; dispatcher.close();
  pending.reject(Object.assign(new Error('unregistered'), { unregistered:true })); await running;
  assert.equal(f.token('phone-1'), 'fcm-registration-1'); assert.equal(f.ledger(), null);
});

test('missing sender leaves readiness untouched and reports unconfigured state', async t => {
  const f = fixture(t); f.addPhone(); const dispatcher = f.create({ sender:null });
  await dispatcher.drain(); dispatcher.kick();
  assert.deepEqual(dispatcher.status(), { configured:false, registeredPhones:1 });
  assert.deepEqual(f.calls, []); assert.deepEqual(f.events, []); assert.equal(f.ledger(), null);
});
