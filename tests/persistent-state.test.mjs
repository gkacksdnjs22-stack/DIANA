import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { createPersistentState } from '../lib/persistent-state.mjs';
import { createControlServer } from '../lib/control.mjs';

const PHONE_COLUMNS = ['id','token_hash','name','created_at','last_seen_at','fcm_token','revoked_at'];

class FakeSupabasePool {
  jobs = new Map(); settings = new Map(); phones = new Map(); nextSeq = 0; failWrites = false;
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

test('a failed remote write is never acknowledged by flush or bypassed', async () => {
  const pool = new FakeSupabasePool();
  const db = await createPersistentState({pool});
  pool.failWrites = true;
  db.prepare('INSERT INTO jobs(id,data) VALUES(?,?)').run('job-2','{}');
  await assert.rejects(db.flush(),/Supabase temporarily unavailable/);
  assert.throws(()=>db.prepare('SELECT data FROM jobs').all(),/Supabase 저장이 실패/);
  db.close();
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
