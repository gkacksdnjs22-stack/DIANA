import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomBytes,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,writeFile,rm,readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createControlServer} from '../lib/control.mjs';
import {sendPhoneFile} from '../scripts/send-phone-file.mjs';
import {fileCipher} from '../agent/file-cipher.mjs';
import {openEnvelope} from '../lib/e2ee.mjs';

const OWNER='u'.repeat(40),AGENT='a'.repeat(40),GATEWAY='g'.repeat(40),PHONE='p'.repeat(40);
const hash=b=>createHash('sha256').update(b).digest('hex');
async function fixture(t){
 const directory=await mkdtemp(path.join(os.tmpdir(),'diana-reconnect-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const db=new DatabaseSync(':memory:'),files=new Map();
 const server=createControlServer({userToken:OWNER,agentToken:AGENT,gatewayToken:GATEWAY,db,transfers:{async put(id,bytes){assert(!files.has(id),'accepted ciphertext must never be overwritten');files.set(id,Buffer.from(bytes));},async read(id){return files.get(id);},async remove(id){files.delete(id);}}});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
 const base='http://127.0.0.1:'+server.address().port,stateDir=path.join(directory,'ledger'),agentDir=path.join(directory,'agent');
 let saved={};
 const replacePhone=()=>{const key=randomBytes(32).toString('hex');db.prepare('DELETE FROM phone_devices').run();db.prepare('INSERT INTO phone_devices(id,token_hash,name,created_at) VALUES(?,?,?,?)').run('phone-'+key.slice(0,8),hash(PHONE),'Fixture',new Date().toISOString());saved={['device:phone-'+key.slice(0,8)]:{key}};return key;};
 const firstKey=replacePhone(),plain=Buffer.from('synthetic reconnect retry document'),filename=path.join(directory,'fixture.txt');await writeFile(filename,plain);
 const cipher=()=>fileCipher({stateDir:agentDir,keys:{async all(){return saved;}},request:async()=>{const r=await fetch(base+'/api/phone/devices',{headers:{Authorization:'Bearer '+OWNER}});assert.equal(r.status,200);return r.json();}});
 const options=()=>({env:{API_BASE_URL:base,USER_TOKEN:OWNER},stateDir,cipher:cipher()});
 const ledger=async()=>JSON.parse(await readFile(path.join(stateDir,(await readdir(stateDir)).find(n=>n.endsWith('.json'))),'utf8'));
 const status=(id,token=OWNER)=>fetch(base+'/api/deliveries/'+id,{headers:{Authorization:'Bearer '+token}});
 return{directory,db,files,base,plain,filename,firstKey,replacePhone,options,ledger,status,agentDir};
}

test('a failed unaccepted delivery retries under the same ID with the replacement phone key',async t=>{
 const f=await fixture(t);let oldWire;
 await assert.rejects(()=>sendPhoneFile(f.filename,{...f.options(),fetchImpl:async(url,init)=>{if(init.method==='POST'){oldWire=Buffer.from(init.body);throw Error('before server acceptance');}return fetch(url,init);}}),/before server/);
 const pending=await f.ledger();assert.equal(f.files.size,0);assert.equal((await (await f.status(pending.id)).json()).job,null);
 const nextKey=f.replacePhone(),result=await sendPhoneFile(f.filename,f.options());assert.equal(result.id,pending.id);
 const wire=f.files.get(result.id+'.bin'),meta={id:result.id,filename:'fixture.txt',direction:'pc-phone'};
 assert.notDeepEqual(wire,oldWire);assert.deepEqual(openEnvelope(wire,[nextKey],meta),f.plain);assert.throws(()=>openEnvelope(wire,[f.firstKey],meta));
 const snapshots=await Promise.all((await readdir(path.join(f.agentDir,'e2ee-spool'))).filter(n=>n.endsWith('.complete')).map(n=>readFile(path.join(f.agentDir,'e2ee-spool',n))));
 assert(snapshots.some(b=>b.equals(oldWire)));assert(snapshots.some(b=>b.equals(wire)));
});

test('a lost acceptance response is reconciled without local keys or replacing server ciphertext',async t=>{
 const f=await fixture(t);let posts=0;
 await assert.rejects(()=>sendPhoneFile(f.filename,{...f.options(),fetchImpl:async(url,init)=>{const r=await fetch(url,init);if(init.method==='POST'){posts++;assert.equal(r.status,201);await r.json();throw Error('lost accepted response');}return r;}}),/lost accepted/);
 const pending=await f.ledger(),before=Buffer.from(f.files.get(pending.id+'.bin'));f.replacePhone();
 const result=await sendPhoneFile(f.filename,{...f.options(),cipher:{encrypt(){assert.fail('accepted transfer must not use current device keys');}},fetchImpl:async(url,init)=>{if(init.method==='POST')posts++;return fetch(url,init);}});
 assert.equal(result.id,pending.id);assert.equal(result.duplicate,true);assert.equal(posts,1);assert.deepEqual(f.files.get(result.id+'.bin'),before);
 for(const token of ['',PHONE,AGENT,GATEWAY])assert.equal((await f.status(result.id,token)).status,401);
});

test('unknown acceptance status never permits re-encryption or a new upload',async t=>{
 const f=await fixture(t);
 for(const response of [()=>new Response('missing',{status:404}),()=>new Response('outage',{status:503}),()=>new Response('{}'),()=>new Response('{"job":false}'),()=>new Response('bad json')]){
  await assert.rejects(()=>sendPhoneFile(f.filename,{...f.options(),cipher:{encrypt(){assert.fail('ambiguous acceptance must not encrypt');}},fetchImpl:async(_url,init)=>{assert.equal(init.method,'GET');return response();}}));
 }
 assert.equal(f.files.size,0);assert.equal((await readdir(path.join(f.directory,'ledger'))).length,1);
});

test('a late old upload racing a reconnected retry cannot overwrite the winning accepted ciphertext',async t=>{
 const f=await fixture(t);let release,waiting;
 const ready=new Promise(r=>waiting=r),hold=new Promise(r=>release=r);
 const old=sendPhoneFile(f.filename,{...f.options(),fetchImpl:async(url,init)=>{if(init.method==='POST'){waiting();await hold;}return fetch(url,init);}});
 await ready;const nextKey=f.replacePhone();let current;
 try{current=await sendPhoneFile(f.filename,f.options());}finally{release();}
 const late=await old;assert.equal(late.id,current.id);assert.equal(late.duplicate,true);
 const wire=f.files.get(current.id+'.bin');assert.deepEqual(openEnvelope(wire,[nextKey],{id:current.id,filename:'fixture.txt',direction:'pc-phone'}),f.plain);
 assert.throws(()=>openEnvelope(wire,[f.firstKey],{id:current.id,filename:'fixture.txt',direction:'pc-phone'}));
 assert.equal(f.files.size,1);
});
