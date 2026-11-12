import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { createOvernightControl } from '../lib/overnight-control.mjs';
import { createControlServer } from '../lib/control.mjs';

const DAY = 24 * 3600_000;
const NOW = Date.parse('2026-10-23T00:00:00Z');
const iso = time => new Date(time).toISOString();
const artifact = digit => ({ id:digit.repeat(64), sha256:digit.repeat(64), filename:'보고서.md', bytes:1, mime:'text/markdown' });
function overnightJob(extra = {}) {
  return { id:randomUUID(), kind:'overnight', state:'processing', artifacts:[], events:[],
    request:{ deadlineAt:iso(NOW + 1000) }, updatedAt:iso(NOW - 2 * DAY), ...extra };
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function controlFixture(initialJobs, remove, initialTime = NOW) {
  let time = initialTime;
  const jobs = new Map(initialJobs.map(job => [job.id, structuredClone(job)]));
  let durable = structuredClone([...jobs.values()]);
  const db = { exec() {}, async flush() { durable = structuredClone([...jobs.values()]); } };
  const save = job => { job.updatedAt = iso(time); jobs.set(job.id, structuredClone(job)); return job; };
  const get = id => structuredClone(jobs.get(id));
  const control = createOvernightControl({ db, all:() => [...jobs.values()].map(job => structuredClone(job)),
    save, requireJob:get, event:(job, text) => job.events.push({ at:iso(time), text }), transfers:{ remove }, clock:() => time });
  return { control, get, save, durable:() => structuredClone(durable), advance:ms => { time += ms; } };
}

test('pending cleanup preserves a completed job and receipts added during remote deletion', async () => {
  const expired = overnightJob({ state:'download_ready', artifacts:[artifact('1')], completedAt:iso(NOW - 2 * DAY) });
  const working = overnightJob();
  const deleting = deferred(), resume = deferred();
  const f = controlFixture([expired, working], async () => { deleting.resolve(); await resume.promise; });
  f.control.refresh();
  const cleanup = f.control.cleanExpiredTransfers();
  await deleting.promise;
  const receipt = { savedAt:iso(NOW), confirmedAt:iso(NOW) };
  f.save({ ...f.get(working.id), state:'download_ready', artifacts:[artifact('2')], completedAt:iso(NOW),
    phoneReceipts:{ galaxy:receipt }, phoneSavedAt:iso(NOW) });
  f.save({ ...f.get(expired.id), phoneReceipts:{ galaxy:receipt }, phoneSavedAt:iso(NOW) });
  f.advance(2000);
  resume.resolve();
  await cleanup;
  f.control.refresh();
  const completed = f.get(working.id);
  assert.equal(completed.state, 'download_ready');
  assert.deepEqual(completed.artifacts, [artifact('2')]);
  assert.deepEqual(completed.phoneReceipts, { galaxy:receipt });
  assert.equal(completed.phoneSavedAt, iso(NOW));
  assert.equal(completed.error, undefined);
  assert.equal(f.get(expired.id).artifactsExpired, true);
  assert.deepEqual(f.get(expired.id).phoneReceipts, { galaxy:receipt });
});

test('partial cleanup persists each deleted file and resumes once after a restart', async () => {
  const job = overnightJob({ state:'failed', _artifactManifest:[artifact('1'), artifact('2')] });
  const calls = [];
  const first = controlFixture([job], async name => {
    calls.push(name);
    if (name.includes(artifact('2').id)) throw new Error('Storage unavailable');
    first.save({ ...first.get(job.id), wakeStatus:'signaled' });
  });
  await first.control.cleanExpiredTransfers();
  assert.deepEqual(calls, [job.id+'-'+artifact('1').id+'.bin', job.id+'-'+artifact('2').id+'.bin']);
  assert.deepEqual(first.get(job.id)._artifactCleanup.deletedIds, [artifact('1').id]);
  assert.equal(first.get(job.id).wakeStatus, 'signaled');
  assert.equal(first.get(job.id).artifactsExpired, undefined);
  const restarted = controlFixture(first.durable(), async name => { calls.push(name); });
  await restarted.control.cleanExpiredTransfers();
  await restarted.control.cleanExpiredTransfers();
  assert.equal(calls.filter(name => name.includes(artifact('1').id)).length, 1);
  assert.equal(calls.filter(name => name.includes(artifact('2').id)).length, 2);
  assert.equal(restarted.durable()[0].artifactsExpired, true);
  assert.equal(restarted.control.publicJob(first.get(job.id))._artifactCleanup, undefined);
  const completedRestart = controlFixture(restarted.durable(), async () => { assert.fail('completed cleanup must not delete again'); });
  await completedRestart.control.cleanExpiredTransfers();
});

test('overlapping cleanup passes share deletion work and a failing job does not block other jobs', async () => {
  const failing = overnightJob({ state:'failed', _artifactManifest:[artifact('1')] });
  const succeeding = overnightJob({ state:'failed', _artifactManifest:[artifact('2')] });
  const deleting = deferred(), resume = deferred(), calls = [];
  const f = controlFixture([failing, succeeding], async name => {
    calls.push(name);
    if (name.includes(artifact('1').id)) { deleting.resolve(); await resume.promise; throw new Error('Storage unavailable'); }
  });
  const first = f.control.cleanExpiredTransfers();
  await deleting.promise;
  const second = f.control.cleanExpiredTransfers();
  assert.equal(first, second);
  resume.resolve();
  await Promise.all([first, second]);
  assert.equal(calls.length, 2);
  assert.equal(f.get(failing.id).artifactsExpired, undefined);
  assert.equal(f.get(succeeding.id).artifactsExpired, true);
});

test('Storage cleanup does not delay job, agent, or phone management APIs', async t => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE jobs(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  const expired = overnightJob({ state:'failed', _artifactManifest:[artifact('1')] });
  db.prepare('INSERT INTO jobs(id,data) VALUES(?,?)').run(expired.id, JSON.stringify(expired));
  const deleting = deferred(), resume = deferred(), finished = deferred();
  const tokens = { userToken:'u'.repeat(40), agentToken:'a'.repeat(40), gatewayToken:'g'.repeat(40) };
  const server = createControlServer({allowLegacyPlaintextTransfers:true, ...tokens, db, now:() => NOW, transfers:{
    async remove() { deleting.resolve(); await resume.promise; finished.resolve(); throw new Error('Storage unavailable'); },
  } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    resume.resolve(); await finished.promise;
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  });
  await deleting.promise;
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const [path, token] of [['/api/jobs', tokens.userToken], ['/api/agent/next', tokens.agentToken], ['/api/phone/devices', tokens.userToken]]) {
    const response = await fetch(base+path, { headers:{ Authorization:`Bearer ${token}` }, signal:AbortSignal.timeout(1500) });
    assert.equal(response.status, 200, path);
    await response.json();
  }
  resume.resolve(); await finished.promise;
  const response = await fetch(base+'/api/jobs', { headers:{ Authorization:`Bearer ${tokens.userToken}` }, signal:AbortSignal.timeout(1500) });
  assert.equal(response.status, 200, 'a failed background deletion must not fail the next API request');
});

test('single-file expiry returns 410 without Storage and preserves a concurrent phone receipt', async t => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE jobs(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  const id = randomUUID(), file = { ...artifact('1'), createdAt:iso(NOW - 2 * DAY) };
  const job = { id, state:'download_ready', request:{ delivery:'download' }, artifact:file, events:[] };
  db.prepare('INSERT INTO jobs(id,data) VALUES(?,?)').run(id, JSON.stringify(job));
  const deleting = deferred(), resume = deferred();
  let deleteCalls = 0;
  const tokens = { userToken:'u'.repeat(40), agentToken:'a'.repeat(40), gatewayToken:'g'.repeat(40) };
  const server = createControlServer({allowLegacyPlaintextTransfers:true, ...tokens, db, now:() => NOW, transfers:{
    async remove() { deleteCalls++; deleting.resolve(); await resume.promise; },
  } });
  const phoneToken = 'p'.repeat(40);
  db.prepare('INSERT INTO phone_devices(id,token_hash,name,created_at) VALUES(?,?,?,?)')
    .run('galaxy', createHash('sha256').update(phoneToken).digest('hex'), 'Galaxy', iso(NOW));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { resume.resolve(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await deleting.promise;
  const base = `http://127.0.0.1:${server.address().port}`;
  const expired = await fetch(`${base}/api/jobs/${id}/file`, {
    headers:{ Authorization:`Bearer ${tokens.userToken}` }, signal:AbortSignal.timeout(1500),
  });
  assert.equal(expired.status, 410);
  await expired.json();
  const received = await fetch(`${base}/api/phone/jobs/${id}/received`, {
    method:'POST', headers:{ Authorization:`Bearer ${phoneToken}`, 'Content-Type':'application/json' },
    body:JSON.stringify({ savedAt:iso(NOW), artifacts:[{ id:file.sha256, sha256:file.sha256 }] }), signal:AbortSignal.timeout(1500),
  });
  assert.equal(received.status, 200);
  await received.json();
  resume.resolve();
  await new Promise(resolve => setImmediate(resolve));
  const saved = JSON.parse(db.prepare('SELECT data FROM jobs WHERE id=?').get(id).data);
  assert.equal(saved.artifact.expired, true);
  assert.equal(saved.phoneSavedAt, iso(NOW));
  assert.equal(saved.phoneReceipts.galaxy.confirmedAt, iso(NOW));
  assert.equal(deleteCalls, 1);
});
