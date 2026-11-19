import {offerKey} from '../lib/e2ee.mjs';
import {pairRequest} from './helpers/phone-pair.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createHash } from 'node:crypto';
import { createPersistentState } from '../lib/persistent-state.mjs';
import { createControlServer } from '../lib/control.mjs';

const PHONE_COLUMNS = ['id', 'token_hash', 'name', 'created_at', 'last_seen_at', 'fcm_token', 'revoked_at'];
const TOKENS = { userToken: 'u'.repeat(40), agentToken: 'a'.repeat(40), gatewayToken: 'g'.repeat(40) };
const sha = value => createHash('sha256').update(value).digest('hex');

// Every connection writes a private transaction view. Only COMMIT makes its
// contents visible to a restarted server, including a lost COMMIT response.
class PairingPool extends EventEmitter {
  jobs = new Map();
  settings = new Map();
  phones = new Map();
  failWrites = false;
  loseCommitResponse = false;

  async query(sql) {
    const query = sql.replace(/\s+/g, ' ').trim();
    if (/^SELECT id,data FROM diana\.jobs/.test(query)) {
      return { rows: [...this.jobs].map(([id, data]) => ({ id, data })) };
    }
    if (/^SELECT key,value FROM diana\.settings/.test(query)) {
      return { rows: [...this.settings].map(([key, value]) => ({ key, value })) };
    }
    if (/^SELECT .* FROM diana\.phone_devices/.test(query)) return { rows: [...this.phones.values()] };
    throw new Error('Unexpected startup SQL: ' + query);
  }

  async connect() {
    let transaction = null;
    const client = new EventEmitter();
    client.query = async (sql, args = []) => {
      const query = sql.replace(/\s+/g, ' ').trim();
      if (query === 'BEGIN') {
        transaction = { jobs: new Map(this.jobs), settings: new Map(this.settings), phones: new Map(this.phones) };
      } else if (query === 'ROLLBACK') {
        transaction = null;
      } else if (query === 'COMMIT') {
        assert.ok(transaction, 'COMMIT requires an open transaction');
        Object.assign(this, transaction);
        transaction = null;
        if (this.loseCommitResponse) {
          this.loseCommitResponse = false;
          throw new Error('Connection lost after COMMIT');
        }
      } else {
        assert.ok(transaction, 'A durable write must run inside a transaction');
        if (this.failWrites) throw new Error('Supabase temporarily unavailable');
        if (/^INSERT INTO diana\.jobs/.test(query)) transaction.jobs.set(args[0], args[1]);
        else if (/^DELETE FROM diana\.jobs/.test(query)) transaction.jobs.delete(args[0]);
        else if (/^INSERT INTO diana\.settings/.test(query)) transaction.settings.set(args[0], args[1]);
        else if (/^DELETE FROM diana\.settings/.test(query)) transaction.settings.delete(args[0]);
        else if (/^INSERT INTO diana\.phone_devices/.test(query)) {
          transaction.phones.set(args[0], Object.fromEntries(PHONE_COLUMNS.map((column, i) => [column, args[i]])));
        } else if (/^DELETE FROM diana\.phone_devices/.test(query)) transaction.phones.delete(args[0]);
        else throw new Error('Unexpected mutation SQL: ' + query);
      }
      return { rows: [] };
    };
    client.release = () => { transaction = null; };
    return client;
  }
}

async function fixture(t) {
  const pool = new PairingPool();
  let time = Date.parse('2026-10-23T00:00:00Z');
  let app;
  async function start() {
    const db = await createPersistentState({ pool, retryDelays: [] });
    const server = createControlServer({allowLegacyPlaintextTransfers:true,
      ...TOKENS, db, now: () => time,
      transfers: { async read() { return null; }, async put() {}, async remove() {} },
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return {
      base: `http://127.0.0.1:${server.address().port}`,
      async close() {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      },
    };
  }
  app = await start();
  t.after(async () => { await app.close(); });
  async function request(path, { method = 'GET', token = TOKENS.userToken, body } = {}) {
    const response = await fetch(app.base + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, data: await response.json() };
  }
  async function issueCode() {
    const result = await request('/api/phone/pair-code', { method: 'POST' });
    assert.equal(result.status, 200);
    return result.data.code;
  }
  return {
    pool, request, issueCode,
    pair: body => request('/api/phone/pair', { method: 'POST', token: '', body:pairRequest(body) }),
    async prepare(body){
      const waiting=await request('/api/phone/pair',{method:'POST',token:'',body:pairRequest(body)});assert.equal(waiting.status,202);
      const pending=await request('/api/agent/pair-pending',{token:TOKENS.agentToken});
      assert.equal((await request('/api/agent/pair-approve',{method:'POST',token:TOKENS.agentToken,body:{id:pending.data.pending.id,approve:true,e2ee:offerKey(pending.data.pending.publicKey,pending.data.pending.requestId).reply}})).status,200);
    },
    advance: ms => { time += ms; },
    async restart() { await app.close(); app = await start(); },
  };
}

test('a pairing that returned 503 can retry its code and receive one usable phone credential', async t => {
  const f = await fixture(t);
  const body = { code: await f.issueCode(), deviceName: 'Galaxy' };
  await f.prepare(body);
  f.pool.failWrites = true;
  const failed = await f.pair(body);
  assert.equal(failed.status, 503);
  assert.equal(failed.data.phoneToken, undefined);
  assert.equal(f.pool.phones.size, 0, 'the rejected transaction must not persist a partial pairing');

  f.pool.failWrites = false;
  const retried = await f.pair(body);
  assert.equal(retried.status, 201);
  assert.equal(f.pool.phones.size, 1);
  assert.equal(f.pool.phones.get(retried.data.phoneId).token_hash, sha(retried.data.phoneToken));
  assert.equal((await f.request('/api/jobs', { token: retried.data.phoneToken })).status, 200);
});

test('a repeated pairing before phone authentication returns the same credential without storing its plaintext', async t => {
  const f = await fixture(t);
  const body = { code: await f.issueCode(), deviceName: ' Galaxy ', fcmToken: 'push-token' };
  await f.prepare(body);
  const first = await f.pair(body);
  assert.equal(first.status, 201);
  const repeated = await f.pair({ ...body, deviceName: 'Galaxy' });
  assert.equal(repeated.status, 201);
  assert.equal(repeated.data.phoneId, first.data.phoneId);
  assert.equal(repeated.data.phoneToken, first.data.phoneToken);
  assert.equal(f.pool.phones.size, 1);
  assert.equal(JSON.stringify([...f.pool.settings]).includes(first.data.phoneToken), false);
  assert.equal(JSON.stringify([...f.pool.phones]).includes(first.data.phoneToken), false);
});

test('an unacknowledged pairing can replay the same credential after a server restart', async t => {
  const f = await fixture(t);
  const body = { code: await f.issueCode(), deviceName: 'Galaxy' };
  await f.prepare(body);
  const first = await f.pair(body);
  assert.equal(first.status, 201);
  await f.restart();
  const repeated = await f.pair(body);
  assert.equal(repeated.status, 201);
  assert.equal(repeated.data.phoneId, first.data.phoneId);
  assert.equal(repeated.data.phoneToken, first.data.phoneToken);
  assert.equal(f.pool.phones.size, 1);
  assert.equal((await f.request('/api/jobs', { token: repeated.data.phoneToken })).status, 200);
});

test('a committed pairing whose COMMIT response was lost survives a restart and retry', async t => {
  const f = await fixture(t);
  const body = { code: await f.issueCode(), deviceName: 'Galaxy' };
  await f.prepare(body);
  f.pool.loseCommitResponse = true;
  const failed = await f.pair(body);
  assert.equal(failed.status, 503);
  assert.equal(failed.data.phoneToken, undefined);
  assert.equal(f.pool.phones.size, 1, 'the commit succeeded despite its lost acknowledgement');
  const [phone] = f.pool.phones.values();
  await f.restart();
  const retried = await f.pair(body);
  assert.equal(retried.status, 201);
  assert.equal(retried.data.phoneId, phone.id);
  assert.equal(sha(retried.data.phoneToken), phone.token_hash);
  assert.equal(f.pool.phones.size, 1);
  assert.equal((await f.request('/api/jobs', { token: retried.data.phoneToken })).status, 200);
});

test('a consumed pairing code rejects a changed phone name or push token without changing the paired phone', async t => {
  const f = await fixture(t);
  const body = { code: await f.issueCode(), deviceName: 'Galaxy', fcmToken: 'push-token' };
  await f.prepare(body);
  const first = await f.pair(body);
  assert.equal(first.status, 201);
  const phone = { ...f.pool.phones.get(first.data.phoneId) };
  assert.equal((await f.pair({ ...body, deviceName: 'Another phone' })).status, 401);
  assert.equal((await f.pair({ ...body, fcmToken: 'different-push-token' })).status, 401);
  assert.equal(f.pool.phones.size, 1);
  assert.deepEqual(f.pool.phones.get(first.data.phoneId), phone);
  const repeated = await f.pair(body);
  assert.equal(repeated.status, 201);
  assert.equal(repeated.data.phoneToken, first.data.phoneToken);
});

test('pairing replay expires at the original code deadline', async t => {
  const f = await fixture(t);
  const body = { code: await f.issueCode(), deviceName: 'Galaxy' };
  await f.prepare(body);
  assert.equal((await f.pair(body)).status, 201);
  f.advance(5 * 60_000);
  assert.equal((await f.pair(body)).status, 401);
  assert.equal(f.pool.phones.size, 1);
});

test('issuing a replacement code invalidates replay of the previous pairing', async t => {
  const f = await fixture(t);
  const body = { code: await f.issueCode(), deviceName: 'Galaxy' };
  await f.prepare(body);
  assert.equal((await f.pair(body)).status, 201);
  let replacement;
  do { replacement = await f.issueCode(); } while (replacement === body.code);
  assert.equal((await f.pair(body)).status, 401);
  assert.equal(f.pool.phones.size, 1);
});

test('revoking a phone prevents its pairing receipt from issuing its credential again', async t => {
  const f = await fixture(t);
  const body = { code: await f.issueCode(), deviceName: 'Galaxy' };
  await f.prepare(body);
  const first = await f.pair(body);
  assert.equal(first.status, 201);
  const revoked = await f.request('/api/phone/devices/' + first.data.phoneId, { method: 'DELETE' });
  assert.equal(revoked.status, 200);
  assert.equal((await f.pair(body)).status, 401);
  assert.equal((await f.request('/api/jobs', { token: first.data.phoneToken })).status, 401);
  assert.equal(f.pool.phones.size, 1);
});

test('the first authenticated phone request removes its pairing replay receipt durably', async t => {
  const f = await fixture(t);
  const body = { code: await f.issueCode(), deviceName: 'Galaxy' };
  await f.prepare(body);
  const first = await f.pair(body);
  assert.equal(first.status, 201);
  assert.equal((await f.request('/api/jobs', { token: first.data.phoneToken })).status, 200);
  assert.equal(f.pool.settings.has('phonePairCode'), false);
  await f.restart();
  assert.equal((await f.pair(body)).status, 401);
  assert.equal((await f.request('/api/jobs', { token: first.data.phoneToken })).status, 200);
  assert.equal(f.pool.phones.size, 1);
});
