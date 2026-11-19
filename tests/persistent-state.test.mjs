import {approvedPhone} from './helpers/phone-pair.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { createPersistentState } from '../lib/persistent-state.mjs';
import { createControlServer } from '../lib/control.mjs';

const PHONE_COLUMNS = ['id','token_hash','name','created_at','last_seen_at','fcm_token','revoked_at'];

class FakeSupabasePool extends EventEmitter {
  jobs = new Map(); settings = new Map(); phones = new Map(); nextSeq = 0; failWrites = false;
  writeCount = 0; failAtWrite = null;
  clients = []; idleClients = []; onClientQuery = null;
  async connect() {
    let snapshot = null;
    const client = this.idleClients.pop() || new EventEmitter();
    if (!this.clients.includes(client)) this.clients.push(client);
    client.idleErrorListener ||= error => {
      this.idleClients = this.idleClients.filter(idle => idle !== client);
      client.removeListener('error', client.idleErrorListener);
      this.emit('error', error, client);
    };
    client.removeListener('error', client.idleErrorListener);
    client.query = async (sql, args = []) => {
      const result = this.onClientQuery?.(sql, args, client);
      if (result !== undefined) return result;
      if (sql === 'BEGIN') {
        snapshot = {
          jobs: new Map(this.jobs), settings: new Map(this.settings), phones: new Map(this.phones), nextSeq: this.nextSeq,
        };
        return { rows: [] };
      }
      if (sql === 'COMMIT') { snapshot = null; return { rows: [] }; }
      if (sql === 'ROLLBACK') {
        if (snapshot) {
          Object.assign(this, snapshot);
          snapshot = null;
        }
        return { rows: [] };
      }
      this.writeCount++;
      if (this.failAtWrite === this.writeCount) {
        this.failAtWrite = null;
        throw new Error('Partial transaction failure');
      }
      return this.query(sql, args);
    };
    client.release = error => {
      client.releaseError = error;
      if (error) {
        // The backend rolls back a transaction when its connection is lost.
        if (snapshot) Object.assign(this, snapshot);
      } else {
        this.idleClients.push(client);
        client.on('error', client.idleErrorListener);
      }
    };
    return client;
  }
  async query(sql, args = []) {
    const query = sql.replace(/\s+/g,' ').trim();
    if (/^SELECT id,data FROM diana\.jobs/.test(query)) return { rows: [...this.jobs].sort((a,b)=>a[1].seq-b[1].seq).map(([id,j])=>({id,data:j.data})) };
    if (/^SELECT key,value FROM diana\.settings/.test(query)) return { rows: [...this.settings].map(([key,value])=>({key,value})) };
    if (/^SELECT .* FROM diana\.phone_devices/.test(query)) return { rows: [...this.phones.values()] };
    if (this.failWrites) throw new Error('Supabase temporarily unavailable');
    if (/^INSERT INTO diana\.jobs/.test(query)) {
      this.jobs.set(args[0], {data:args[1],seq:this.jobs.get(args[0])?.seq ?? ++this.nextSeq}); return {rows:[]};
    }
    if (/^DELETE FROM diana\.jobs/.test(query)) { this.jobs.delete(args[0]); return {rows:[]}; }
    if (/^INSERT INTO diana\.settings/.test(query)) { this.settings.set(args[0],args[1]); return {rows:[]}; }
    if (/^DELETE FROM diana\.settings/.test(query)) { this.settings.delete(args[0]); return {rows:[]}; }
    if (/^INSERT INTO diana\.phone_devices/.test(query)) {
      this.phones.set(args[0],Object.fromEntries(PHONE_COLUMNS.map((column,i)=>[column,args[i]]))); return {rows:[]};
    }
    if (/^DELETE FROM diana\.phone_devices/.test(query)) { this.phones.delete(args[0]); return {rows:[]}; }
    throw new Error('Unexpected SQL: '+query);
  }
}

test('a job, settings, and phone pairing are restored after server restart', async () => {
  const pool = new FakeSupabasePool();
  const first = await createPersistentState({pool});
  first.prepare('INSERT INTO jobs(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run('job-1','{"state":"waiting_pc"}');
  first.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('catalog','{"documents":[]}');
  first.prepare('INSERT INTO phone_devices(id,token_hash,name,created_at,last_seen_at,fcm_token) VALUES(?,?,?,?,?,?)')
    .run('phone-1','hashed-token','Galaxy','2026-10-22',null,null);
  first.prepare('UPDATE phone_devices SET last_seen_at=? WHERE id=?').run('2026-10-23','phone-1');
  first.prepare("INSERT INTO settings(key,value) VALUES('agentLastSeenAt',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run('2026-10-23');
  await first.flush();
  first.close();

  const second = await createPersistentState({pool});
  assert.equal(second.prepare('SELECT data FROM jobs WHERE id=?').get('job-1').data,'{"state":"waiting_pc"}');
  assert.equal(second.prepare('SELECT value FROM settings WHERE key=?').get('catalog').value,'{"documents":[]}');
  assert.equal(second.prepare("SELECT value FROM settings WHERE key='agentLastSeenAt'").get().value,'2026-10-23');
  assert.equal(second.prepare('SELECT last_seen_at FROM phone_devices WHERE id=?').get('phone-1').last_seen_at,'2026-10-23');
  second.prepare('DELETE FROM settings WHERE key=?').run('catalog');
  second.prepare('UPDATE phone_devices SET revoked_at=?,fcm_token=NULL WHERE id=?').run('2026-10-24','phone-1');
  await second.flush();
  second.close();

  const third = await createPersistentState({pool});
  assert.equal(third.prepare('SELECT value FROM settings WHERE key=?').get('catalog'),undefined);
  assert.equal(third.prepare('SELECT revoked_at FROM phone_devices WHERE id=?').get('phone-1').revoked_at,'2026-10-24');
  third.close();
});

test('a failed write blocks access until a later request replays it successfully', async () => {
  const pool = new FakeSupabasePool();
  const db = await createPersistentState({pool, retryDelays: []});
  pool.failWrites = true;
  db.prepare('INSERT INTO jobs(id,data) VALUES(?,?)').run('job-2','{}');
  await assert.rejects(db.flush(),/Supabase temporarily unavailable/);
  assert.throws(()=>db.prepare('SELECT data FROM jobs').all(),/Supabase 저장이 실패/);
  pool.failWrites = false;
  await db.recover();
  assert.equal(db.prepare('SELECT data FROM jobs WHERE id=?').get('job-2').data,'{}');
  assert.equal(pool.jobs.get('job-2').data,'{}');
  db.close();
});

test('pairing insert and one-time code removal commit atomically after a mid-batch failure', async () => {
  const pool = new FakeSupabasePool();
  const db = await createPersistentState({pool, retryDelays: []});
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('phonePairCode','{"hash":"code"}');
  await db.flush();

  db.prepare('INSERT INTO phone_devices(id,token_hash,name,created_at,last_seen_at,fcm_token) VALUES(?,?,?,?,?,?)')
    .run('phone-2','new-hash','Galaxy','2026-10-22',null,null);
  db.prepare('DELETE FROM settings WHERE key=?').run('phonePairCode');
  pool.failAtWrite = pool.writeCount + 2;

  await assert.rejects(db.flush(),/Partial transaction failure/);
  assert.equal(pool.phones.has('phone-2'),false,'a failed transaction must not partially pair a phone');
  assert.equal(pool.settings.has('phonePairCode'),true,'the code must remain if the pairing insert is rolled back');

  await db.recover();
  assert.equal(pool.phones.has('phone-2'),true);
  assert.equal(pool.settings.has('phonePairCode'),false);
  db.close();
});

test('transient database failures are retried before acknowledging success', async () => {
  const pool = new FakeSupabasePool();
  const db = await createPersistentState({pool, retryDelays: [0]});
  db.prepare('INSERT INTO jobs(id,data) VALUES(?,?)').run('job-3','{"ok":true}');
  pool.failAtWrite = pool.writeCount + 1;
  await db.flush();
  assert.equal(pool.jobs.get('job-3').data,'{"ok":true}');
  db.close();
});

test('idle connection errors are handled by the pool and the next write reconnects', async () => {
  const pool = new FakeSupabasePool();
  const db = await createPersistentState({pool});
  try {
    db.prepare('INSERT INTO jobs(id,data) VALUES(?,?)').run('idle-job', '{}');
    await db.flush();
    const disconnected = pool.clients[0];
    assert.doesNotThrow(() => disconnected.emit('error', new Error('Idle connection terminated')));
    assert.equal(pool.idleClients.length, 0);
    db.prepare('INSERT INTO jobs(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data')
      .run('idle-job', '{"reconnected":true}');
    await db.flush();
    assert.equal(pool.jobs.get('idle-job').data, '{"reconnected":true}');
    assert.equal(pool.clients.length, 2);
    assert.equal(pool.listenerCount('error'), 1);
  } finally { db.close(); }
  assert.equal(pool.listenerCount('error'), 0, 'closing an adapter removes its pool listener');
});

test('an event-only checked-out connection failure discards the client and retries the batch', {timeout: 2000}, async () => {
  const pool = new FakeSupabasePool();
  const db = await createPersistentState({pool, retryDelays: [0]});
  const outage = new Error('Checked-out connection terminated');
  let failed = false;
  pool.onClientQuery = (sql, args, client) => {
    if (!failed && sql.startsWith('INSERT')) {
      failed = true;
      queueMicrotask(() => client.emit('error', outage));
      return new Promise(() => {});
    }
  };
  try {
    db.prepare('INSERT INTO jobs(id,data) VALUES(?,?)').run('retry-job', '{"durable":true}');
    await db.flush();
    assert.equal(pool.jobs.get('retry-job').data, '{"durable":true}');
    assert.equal(pool.clients.length, 2);
    assert.equal(pool.clients[0].releaseError, outage, 'a broken connection must be destroyed');
    assert.equal(pool.clients[0].listenerCount('error'), 0);
    assert.equal(pool.clients[1].listenerCount('error'), 1, 'only the pool idle listener remains');
  } finally { db.close(); }
});

test('checked-out connection events retain the failed batch for later recovery', {timeout: 2000}, async () => {
  const pool = new FakeSupabasePool();
  const db = await createPersistentState({pool, retryDelays: []});
  const outage = new Error('Database network unavailable');
  pool.onClientQuery = (sql, args, client) => {
    if (sql.startsWith('INSERT')) {
      client.emit('error', outage);
      return {rows: []};
    }
  };
  try {
    db.prepare('INSERT INTO jobs(id,data) VALUES(?,?)').run('recover-job', '{"durable":true}');
    await assert.rejects(db.flush(), error => error === outage);
    assert.equal(pool.jobs.has('recover-job'), false);
    assert.throws(() => db.prepare('SELECT data FROM jobs').all(), /Supabase 저장이 실패/);
    assert.equal(pool.clients[0].releaseError, outage);

    pool.onClientQuery = null;
    await db.recover();
    assert.equal(pool.jobs.get('recover-job').data, '{"durable":true}');
    assert.equal(db.prepare('SELECT data FROM jobs WHERE id=?').get('recover-job').data, '{"durable":true}');
  } finally { db.close(); }
});

test('a disconnect during rollback also settles the failed batch and destroys the client', {timeout: 2000}, async () => {
  const pool = new FakeSupabasePool();
  const db = await createPersistentState({pool, retryDelays: []});
  const outage = new Error('Connection terminated during rollback');
  pool.failAtWrite = 1;
  pool.onClientQuery = (sql, args, client) => {
    if (sql === 'ROLLBACK') {
      queueMicrotask(() => client.emit('error', outage));
      return new Promise(() => {});
    }
  };
  try {
    db.prepare('INSERT INTO jobs(id,data) VALUES(?,?)').run('rollback-job', '{}');
    await assert.rejects(db.flush(), /Partial transaction failure/);
    assert.equal(pool.clients[0].releaseError, outage);
    assert.equal(pool.clients[0].listenerCount('error'), 0);
    pool.onClientQuery = null;
    await db.recover();
    assert.equal(pool.jobs.has('rollback-job'), true);
  } finally { db.close(); }
});

test('reusing clients does not accumulate transaction error listeners', async () => {
  const pool = new FakeSupabasePool();
  const db = await createPersistentState({pool});
  try {
    for (let i = 0; i < 15; i++) {
      db.prepare('INSERT INTO jobs(id,data) VALUES(?,?)').run(`listener-job-${i}`, '{}');
      await db.flush();
      assert.equal(pool.clients[0].listenerCount('error'), 1);
    }
    assert.equal(pool.clients.length, 1);
  } finally { db.close(); }
});

test('a failed startup removes the pool error listener', async () => {
  const pool = new FakeSupabasePool();
  pool.query = async () => {
    pool.emit('error', new Error('Idle startup connection terminated'));
    throw new Error('Startup query failed');
  };
  await assert.rejects(createPersistentState({pool}), /DIANA 테이블을 불러오지 못했습니다/);
  assert.equal(pool.listenerCount('error'), 0);
});

test('HTTP 503 after a checked-out connection event is followed by automatic recovery', async () => {
  const pool = new FakeSupabasePool();
  const db = await createPersistentState({pool, retryDelays: []});
  const tokens = {userToken:'u'.repeat(40),agentToken:'a'.repeat(40),gatewayToken:'g'.repeat(40)};
  const server = createControlServer({allowLegacyPlaintextTransfers:true,...tokens,db});
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: `Bearer ${tokens.userToken}` };
  const jobId = randomUUID();
  try {
    pool.onClientQuery = (sql, args, client) => {
      if (sql.startsWith('INSERT')) {
        client.emit('error', new Error('HTTP transaction connection terminated'));
        return {rows: []};
      }
    };
    const createResponse = await fetch(base+'/api/jobs', {
      method:'POST', headers:{...headers,'Content-Type':'application/json'},
      body:JSON.stringify({requestId:jobId,query:'test document',delivery:'download'}),
    });
    assert.equal(createResponse.status,503);
    assert.equal(pool.jobs.has(jobId),false,'failed writes must not be acknowledged as durable');

    pool.onClientQuery = null;
    const listResponse = await fetch(base+'/api/jobs',{headers});
    assert.equal(listResponse.status,200);
    const {jobs} = await listResponse.json();
    assert.equal(jobs.some(job=>job.id===jobId),true);
    assert.equal(pool.jobs.has(jobId),true,'a subsequent request must replay the failed batch');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
  }
});

test('phone pairing and a verified document remain usable after server restart', async () => {
  const pool = new FakeSupabasePool();
  const files = new Map();
  const transfers = {
    async read(name) { return files.get(name) ?? null; },
    async put(name, bytes) { files.set(name, Buffer.from(bytes)); },
    async remove(name) { files.delete(name); },
  };
  const tokens = {userToken:'u'.repeat(40),agentToken:'a'.repeat(40),gatewayToken:'g'.repeat(40)};
  async function start() {
    const db = await createPersistentState({pool});
    const server = createControlServer({allowLegacyPlaintextTransfers:true,...tokens,db,transfers});
    server.listen(0,'127.0.0.1');
    await once(server,'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    async function request(path, {method='GET',token=tokens.userToken,body,bytes,headers={}}={}) {
      const response = await fetch(base+path,{
        method,
        headers:{Authorization:`Bearer ${token}`,...(body?{'Content-Type':'application/json'}:{}),...headers},
        body:body?JSON.stringify(body):bytes,
      });
      return response;
    }
    async function close() { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
    return {request,close};
  }
  const source = Buffer.from('DIANA transfer verified after restart');
  const digest = createHash('sha256').update(source).digest('hex');
  const jobId = randomUUID();

  let app = await start();
  try {
    assert.equal((await app.request('/api/jobs',{method:'POST',body:{requestId:jobId,query:'document',delivery:'download'}})).status,201);
    assert.equal((await app.request('/api/agent/next',{token:tokens.agentToken})).status,200);
    const candidate = {id:digest,sha256:digest,filename:'report.txt',bytes:source.length,score:0.9};
    assert.equal((await app.request(`/api/agent/jobs/${jobId}/candidates`,{method:'POST',token:tokens.agentToken,body:{mode:'lexical',candidates:[candidate]}})).status,200);
    assert.equal((await app.request(`/api/jobs/${jobId}/selection`,{method:'POST',body:{candidateId:digest,approve:true}})).status,200);
    assert.equal((await app.request('/api/agent/next',{token:tokens.agentToken})).status,200);
    assert.equal((await app.request(`/api/agent/jobs/${jobId}/file`,{method:'POST',token:tokens.agentToken,bytes:source,headers:{'x-source-file-id':digest,'x-file-sha256':digest,'x-file-name':'report.txt'}})).status,200);
    assert.equal((await app.request(`/api/agent/jobs/${jobId}/result`,{method:'POST',token:tokens.agentToken,body:{status:'download_ready'}})).status,200);
    const code = (await (await app.request('/api/phone/pair-code',{method:'POST'})).json()).code;
    const paired = await approvedPhone(async(route,options)=>{const r=await app.request(route,options);return{status:r.status,data:await r.json()};},{code,deviceName:'Galaxy'},tokens.agentToken);
    assert.equal(paired.status,201);
    const {phoneToken} = paired.data;

    await app.close();
    app = await start();
    const response = await app.request(`/api/jobs/${jobId}/file`,{token:phoneToken});
    assert.equal(response.status,200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()),source);
    const receipt = await app.request(`/api/phone/jobs/${jobId}/received`,{method:'POST',token:phoneToken,body:{savedAt:new Date().toISOString(),artifacts:[{id:digest,sha256:digest}]}});
    assert.equal(receipt.status,200);
    const data = await (await app.request('/api/jobs',{token:phoneToken})).json();
    assert.equal(data.jobs[0].phoneSavedAt != null,true);
  } finally {
    await app.close();
  }
});
