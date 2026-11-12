import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createControlServer} from '../lib/control.mjs';
import {sendPhoneFile} from '../scripts/send-phone-file.mjs';

const sha=b=>createHash('sha256').update(b).digest('hex');
const OWNER='owner-'+ 'u'.repeat(40),AGENT='agent-'+'a'.repeat(40),GATEWAY='gateway-'+'g'.repeat(40),PHONE='existing-phone-'+'p'.repeat(40);
const apk=Buffer.from([80,75,3,4,...Buffer.from('inert public installer fixture; never executed')]);
async function fixture(t){
 const directory=await mkdtemp(path.join(os.tmpdir(),'diana-update-fixture-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const filename=path.join(directory,'DIANA-next.apk'),registry={android:{path:'/downloads/DIANA-next.apk',sha256:sha(apk),bytes:apk.length}};
 await writeFile(filename,apk);await writeFile(path.join(directory,'releases.json'),JSON.stringify(registry));
 const db=new DatabaseSync(':memory:'),files=new Map();
 const server=createControlServer({userToken:OWNER,agentToken:AGENT,gatewayToken:GATEWAY,db,publicDownloadsDir:directory,transfers:{async put(id,b){if(files.has(id))assert.deepEqual(files.get(id),b);files.set(id,Buffer.from(b));},async read(id){return files.get(id);},async remove(id){files.delete(id);}}});
 // An installation predating E2EE: only its existing token is present, no key or new pairing.
 db.prepare('INSERT INTO phone_devices(id,token_hash,name,created_at) VALUES(?,?,?,?)').run('old-phone',sha(PHONE),'Legacy fixture',new Date().toISOString());
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
 const base='http://127.0.0.1:'+server.address().port,metadata={filename:'DIANA-next.apk',sha256:sha(apk),bytes:apk.length};
 const request=async(route,{token=OWNER,body,method=body?'POST':'GET',headers={}}={})=>{const r=await fetch(base+route,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json',...headers},body:body?JSON.stringify(body):undefined});return{status:r.status,data:await r.json()};};
 return{directory,filename,registry,base,metadata,request,files,db};
}

test('an existing keyless phone receives a published APK through the unchanged download and receipt protocol',async t=>{
 const f=await fixture(t),seen=[];
 const options={env:{API_BASE_URL:f.base,USER_TOKEN:OWNER,AGENT_STATE_DIR:path.join(f.directory,'keys')},stateDir:path.join(f.directory,'ledger'),appUpdate:true,cipher:{async encrypt(){assert.fail('public update must not require the new pairing key');}},fetchImpl:async(url,init)=>{seen.push(url);assert.deepEqual(JSON.parse(init.body),f.metadata);return fetch(url,init);}};
 const first=await sendPhoneFile(f.filename,options),again=await sendPhoneFile(f.filename,options);assert.equal(again.id,first.id);assert.equal(again.duplicate,true);assert(seen.every(url=>url.includes('/api/app-updates/')));
 const jobs=await f.request('/api/jobs',{token:PHONE});const job=jobs.data.jobs.find(j=>j.id===first.id);assert.equal(job.artifacts[0].transferEncoding,'public-app-update');
 const response=await fetch(f.base+'/api/jobs/'+first.id+'/file',{headers:{authorization:'Bearer '+PHONE}});assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),apk);
 const receipt=await f.request('/api/phone/jobs/'+first.id+'/received',{token:PHONE,body:{savedAt:new Date().toISOString(),artifacts:[{id:f.metadata.sha256,sha256:f.metadata.sha256,bytes:apk.length}]}});assert.equal(receipt.status,200);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM phone_devices').get().n,1);
 await writeFile(path.join(f.directory,'releases.json'),JSON.stringify({android:{...f.registry.android,sha256:'0'.repeat(64)}}));
 const replay=await sendPhoneFile(f.filename,options);assert.ok(replay.phoneSavedAt);assert.equal(replay.id,first.id);
});

test('public update rejects unregistered bytes, document disguises, caller paths, unauthorized callers and plaintext fallback',async t=>{
 const f=await fixture(t),route='/api/app-updates/'+randomUUID();
 for(const token of ['',PHONE,AGENT,GATEWAY])assert.equal((await f.request(route,{token,body:f.metadata})).status,401);
 assert.equal((await f.request(route,{body:f.metadata,headers:{Origin:'https://other.invalid'}})).status,403);
 for(const body of [{...f.metadata,filename:'private.txt'},{...f.metadata,sha256:sha(Buffer.from('private document'))},{...f.metadata,bytes:apk.length+1},{...f.metadata,filename:'../private.apk'}])assert([400,409].includes((await f.request(route,{body})).status));
 const raw=await fetch(f.base+'/api/deliveries/'+randomUUID(),{method:'POST',headers:{authorization:'Bearer '+OWNER,'x-file-name':'private.apk','x-file-sha256':sha(apk),'x-diana-app-update':'true'},body:apk});assert.equal(raw.status,409);
 await assert.rejects(()=>sendPhoneFile(f.filename,{env:{API_BASE_URL:f.base,USER_TOKEN:OWNER,AGENT_STATE_DIR:path.join(f.directory,'missing-keys')},stateDir:path.join(f.directory,'ordinary')}),/암호화 연결/);
 await writeFile(f.filename,Buffer.concat([apk.subarray(0,-1),Buffer.from('!')]));assert.equal((await f.request(route,{body:f.metadata})).status,409);
 f.registry.android.path='/downloads/../private.apk';await writeFile(path.join(f.directory,'releases.json'),JSON.stringify(f.registry));assert.equal((await f.request(route,{body:f.metadata})).status,409);
 assert.equal(f.files.size,0);
});

test('public and encrypted deliveries cannot reuse one ID to change encoding',async t=>{
 const f=await fixture(t),id=randomUUID();assert.equal((await f.request('/api/app-updates/'+id,{body:f.metadata})).status,201);
 const row=f.db.prepare('SELECT data FROM jobs WHERE id=?').get(id),job=JSON.parse(row.data);delete job.artifact.transferEncoding;f.db.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify(job),id);
 assert.equal((await f.request('/api/app-updates/'+id,{body:f.metadata})).status,409);
});
