import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { createPersistentState } from '../lib/persistent-state.mjs';
import { createControlServer } from '../lib/control.mjs';

const PHONE_COLUMNS = ['id','token_hash','name','created_at','last_seen_at','fcm_token','revoked_at'];

class FakeSupabasePool {
  jobs = new Map(); settings = new Map(); phones = new Map(); nextSeq = 0; failWrites = false;
  writeCount = 0; failAtWrite = null;
  async connect() {
    let snapshot = null;
    return {
      query: async (sql, args = []) => {
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
      },
      release() {},
    };
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

test('HTTP 503 after an outage is followed by automatic recovery on the next API request', async () => {
  const pool = new FakeSupabasePool();
  const db = await createPersistentState({pool, retryDelays: []});
  const tokens = {userToken:'u'.repeat(40),agentToken:'a'.repeat(40),gatewayToken:'g'.repeat(40)};
  const server = createControlServer({...tokens,db});
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: `Bearer ${tokens.userToken}` };
  const jobId = randomUUID();
  try {
    pool.failWrites = true;
    const createResponse = await fetch(base+'/api/jobs', {
      method:'POST', headers:{...headers,'Content-Type':'application/json'},
      body:JSON.stringify({requestId:jobId,query:'test document',delivery:'download'}),
    });
    assert.equal(createResponse.status,503);
    assert.equal(pool.jobs.has(jobId),false,'failed writes must not be acknowledged as durable');

    pool.failWrites = false;
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
    const server = createControlServer({...tokens,db,transfers});
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
    const paired = await app.request('/api/phone/pair',{method:'POST',token:'',body:{code,deviceName:'Galaxy'}});
    assert.equal(paired.status,201);
    const {phoneToken} = await paired.json();

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
