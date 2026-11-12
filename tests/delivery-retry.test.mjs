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
import {openEnvelope,inspectEnvelope} from '../lib/e2ee.mjs';
import {createLocalTransferStore,createSupabaseTransferStore} from '../lib/transfer-store.mjs';

const OWNER='u'.repeat(40),AGENT='a'.repeat(40),GATEWAY='g'.repeat(40),PHONE='p'.repeat(40);
const hash=b=>createHash('sha256').update(b).digest('hex');
async function fixture(t,{supabase=false}={}){
 const directory=await mkdtemp(path.join(os.tmpdir(),'diana-reconnect-'));
 let db=new DatabaseSync(path.join(directory,'test.sqlite'));const files=new Map();
 let failWriteAck=false,failRead=false;
 const local=createLocalTransferStore(path.join(directory,'storage'));
 const transfers=supabase?createSupabaseTransferStore({url:'https://retry-fixture.supabase.co',serviceRoleKey:'synthetic-storage-key',fetch:async(input,options={})=>{
   const url=new URL(typeof input==='string'?input:input.url),id=url.pathname.split('/').at(-1),method=options.method||input.method||'GET';
   if(method==='GET'){
     if(failRead){failRead=false;return Response.json({message:'synthetic outage'},{status:503});}
     return files.has(id)?new Response(files.get(id)):Response.json({code:'NoSuchKey'},{status:404});
   }
   assert.equal(method,'POST');if(files.has(id))return Response.json({code:'ResourceAlreadyExists'},{status:409});
   files.set(id,Buffer.from(options.body));
   if(failWriteAck){failWriteAck=false;failRead=true;return Response.json({message:'stored but acknowledgement lost'},{status:503});}
   return Response.json({Key:id});
 }}):{async put(id,bytes){await local.put(id,bytes);files.set(id,Buffer.from(bytes));if(failWriteAck){failWriteAck=false;failRead=true;throw Error('stored but acknowledgement lost');}},async read(id){if(failRead){failRead=false;throw Error('synthetic read outage');}return local.read(id);},async remove(id){files.delete(id);return local.remove(id);}};
 let server,base;
 const start=async()=>{server=createControlServer({userToken:OWNER,agentToken:AGENT,gatewayToken:GATEWAY,db,transfers});server.prependListener('request',(_req,res)=>res.setHeader('Connection','close'));server.listen(0,'127.0.0.1');await once(server,'listening');base='http://127.0.0.1:'+server.address().port;};
 const close=async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));};
 await start();t.after(async()=>{await close();await rm(directory,{recursive:true,force:true});});
 const stateDir=path.join(directory,'ledger'),agentDir=path.join(directory,'agent');
 let saved={};
 const replacePhone=()=>{const key=randomBytes(32).toString('hex');db.prepare('DELETE FROM phone_devices').run();db.prepare('INSERT INTO phone_devices(id,token_hash,name,created_at) VALUES(?,?,?,?)').run('phone-'+key.slice(0,8),hash(PHONE),'Fixture',new Date().toISOString());saved={['device:phone-'+key.slice(0,8)]:{key}};return key;};
 const firstKey=replacePhone(),plain=Buffer.from('synthetic reconnect retry document'),filename=path.join(directory,'fixture.txt');await writeFile(filename,plain);
 const cipher=()=>fileCipher({stateDir:agentDir,keys:{async all(){return saved;}},request:async()=>{const r=await fetch(base+'/api/phone/devices',{headers:{Authorization:'Bearer '+OWNER}});assert.equal(r.status,200);return r.json();}});
 const options=()=>({env:{API_BASE_URL:base,USER_TOKEN:OWNER},stateDir,cipher:cipher()});
 const ledger=async()=>JSON.parse(await readFile(path.join(stateDir,(await readdir(stateDir)).find(n=>n.endsWith('.json'))),'utf8'));
 const status=(id,token=OWNER)=>fetch(base+'/api/deliveries/'+id,{headers:{Authorization:'Bearer '+token}});
 return{directory,get db(){return db;},files,get base(){return base;},plain,filename,firstKey,replacePhone,options,ledger,status,agentDir,transfers,
   loseStorageAck(){failWriteAck=true;},failStorageRead(){failRead=true;},async restart(){const port=server.address().port;await close();db=new DatabaseSync(path.join(directory,'test.sqlite'));server=createControlServer({userToken:OWNER,agentToken:AGENT,gatewayToken:GATEWAY,db,transfers});server.prependListener('request',(_req,res)=>res.setHeader('Connection','close'));server.listen(port,'127.0.0.1');await once(server,'listening');}};
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

test('a lost acceptance response is reconciled for the same recipients without replacing server ciphertext',async t=>{
 const f=await fixture(t);let posts=0;
 await assert.rejects(()=>sendPhoneFile(f.filename,{...f.options(),fetchImpl:async(url,init)=>{const r=await fetch(url,init);if(init.method==='POST'){posts++;assert.equal(r.status,201);await r.json();throw Error('lost accepted response');}return r;}}),/lost accepted/);
 const pending=await f.ledger(),before=Buffer.from(f.files.get(pending.id+'.bin'));
 const current=f.options().cipher;
 const result=await sendPhoneFile(f.filename,{...f.options(),cipher:{recipientIds:()=>current.recipientIds(),encrypt(){assert.fail('accepted transfer must not re-encrypt');}},fetchImpl:async(url,init)=>{if(init.method==='POST')posts++;return fetch(url,init);}});
 assert.equal(result.id,pending.id);assert.equal(result.duplicate,true);assert.equal(posts,1);assert.deepEqual(f.files.get(result.id+'.bin'),before);
 for(const token of ['',PHONE,AGENT,GATEWAY])assert.equal((await f.status(result.id,token)).status,401);
});

test('unknown acceptance status never permits re-encryption or a new upload',async t=>{
 const f=await fixture(t);
 for(const response of [()=>new Response('missing',{status:404}),()=>new Response('outage',{status:503}),()=>new Response('{}'),()=>new Response('{"job":null}'),()=>new Response('{"job":false}'),()=>new Response('bad json')]){
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

for(const supabase of [false,true])for(const changed of [false,true])for(const commitFailure of [false,true])test(`${supabase?'Supabase SDK':'local disk'} ${commitFailure?'DB commit failure':'lost write acknowledgement'} survives restart with ${changed?'replacement':'same'} recipients`,async t=>{
 const f=await fixture(t,{supabase});
 if(commitFailure)f.db.exec("CREATE TRIGGER reject_delivery BEFORE INSERT ON jobs BEGIN SELECT RAISE(ABORT,'synthetic commit failure'); END");
 else f.loseStorageAck();
 await assert.rejects(()=>sendPhoneFile(f.filename,f.options()),/HTTP 500/);
 if(commitFailure)f.db.exec('DROP TRIGGER reject_delivery');
 const previous=await f.ledger(),oldWire=Buffer.from(f.files.get(previous.id+'.bin'));
 assert.equal(f.db.prepare('SELECT count(*) AS n FROM jobs').get().n,0);assert.equal(f.files.size,1);
 await f.restart();const current=changed?f.replacePhone():f.firstKey;
 const status=await f.status(previous.id);assert.equal(status.status,200);const recovered=await status.json();
 assert.equal(recovered.recovered,true);assert.equal(recovered.job.id,previous.id);assert.equal(recovered.ciphertext.sha256,hash(oldWire));
 assert.deepEqual(recovered.ciphertext.recipientKeyIds,inspectEnvelope(oldWire).recipients.map(r=>r.kid).sort());
 const sent=await sendPhoneFile(f.filename,f.options());
 assert.equal(sent.id===previous.id,!changed);assert.equal((await f.ledger()).id,sent.id);
 assert.deepEqual(f.files.get(previous.id+'.bin'),oldWire);
 const meta={id:sent.id,filename:'fixture.txt',direction:'pc-phone'},wire=f.files.get(sent.id+'.bin');
 assert.deepEqual(openEnvelope(wire,[current],meta),f.plain);
 if(changed)assert.throws(()=>openEnvelope(wire,[f.firstKey],meta));
 const again=await sendPhoneFile(f.filename,f.options());assert.equal(again.id,sent.id);assert.equal(again.duplicate,true);
 assert.equal(f.files.size,changed?2:1);
});

for(const failReplacement of [false,true])test(`old upload wins after retry's absence check; current recipient success is verified${failReplacement?' across another process retry':''}`,async t=>{
 const f=await fixture(t);let oldRequest;
 await assert.rejects(()=>sendPhoneFile(f.filename,{...f.options(),fetchImpl:async(url,init)=>{if(init.method==='POST'){oldRequest={url,init};throw Error('not sent');}return fetch(url,init);}}),/not sent/);
 const original=await f.ledger(),current=f.replacePhone();let raced=false,replacement;
 const attempt=()=>sendPhoneFile(f.filename,{...f.options(),fetchImpl:async(url,init)=>{
   if(init.method==='POST'&&!raced){
     raced=true;const old=await fetch(oldRequest.url,oldRequest.init);assert.equal(old.status,201);await old.json();
     const response=await fetch(url,init),data=await response.json();
     assert.equal(data.duplicate,true);assert.equal(data.ciphertext.sha256,hash(oldRequest.init.body));
     assert.notEqual(data.ciphertext.sha256,hash(init.body));
     return Response.json(data);
   }
   if(init.method==='POST'&&failReplacement){replacement=url.split('/').at(-1);throw Error('replacement not sent');}
   return fetch(url,init);
 }});
 let result;
 if(failReplacement){await assert.rejects(attempt,/replacement not sent/);assert.equal((await f.ledger()).id,replacement);result=await sendPhoneFile(f.filename,f.options());assert.equal(result.id,replacement);}
 else result=await attempt();
 assert.notEqual(result.id,original.id);assert.equal(f.files.size,2);assert.deepEqual(f.files.get(original.id+'.bin'),oldRequest.init.body);
 const wire=f.files.get(result.id+'.bin'),meta={id:result.id,filename:'fixture.txt',direction:'pc-phone'};
 assert.deepEqual(openEnvelope(wire,[current],meta),f.plain);assert.throws(()=>openEnvelope(wire,[f.firstKey],meta));
});

test('acceptance lookup fails closed for unreadable, missing or invalid stored ciphertext',async t=>{
 const f=await fixture(t),sent=await sendPhoneFile(f.filename,f.options());
 f.failStorageRead();assert.equal((await f.status(sent.id)).status,500);
 await f.transfers.remove(sent.id+'.bin');assert.equal((await f.status(sent.id)).status,409);
 f.db.prepare('DELETE FROM jobs WHERE id=?').run(sent.id);
 await f.transfers.put(sent.id+'.bin',Buffer.from('DIANA-E2EE-1\npartial'));
 assert.equal((await f.status(sent.id)).status,409);assert.equal(f.db.prepare('SELECT count(*) AS n FROM jobs').get().n,0);
});

test('missing or malformed ciphertext receipt never reports success or rotates the delivery ID',async t=>{
 const f=await fixture(t),sent=await sendPhoneFile(f.filename,f.options());
 for(const info of [undefined,null,{sha256:'0'.repeat(64),recipientKeyIds:[]},{sha256:'bad',recipientKeyIds:['1'.repeat(64)]}]){
   await assert.rejects(()=>sendPhoneFile(f.filename,{...f.options(),fetchImpl:async(url,init)=>{assert.equal(init.method,'GET');const r=await fetch(url,init),data=await r.json();data.ciphertext=info;return Response.json(data);}}),/암호문/);
   assert.equal((await f.ledger()).id,sent.id);
 }
 assert.equal(f.files.size,1);
});

test('concurrent retries converge on one replacement when the old recipient upload wins',async t=>{
 const f=await fixture(t);let oldRequest;
 await assert.rejects(()=>sendPhoneFile(f.filename,{...f.options(),fetchImpl:async(url,init)=>{if(init.method==='POST'){oldRequest={url,init};throw Error('not sent');}return fetch(url,init);}}),/not sent/);
 const original=await f.ledger(),key=f.replacePhone();let entered=0,ready,release;
 const bothReady=new Promise(r=>ready=r),gate=new Promise(r=>release=r);
 const send=()=>sendPhoneFile(f.filename,{...f.options(),fetchImpl:async(url,init)=>{if(init.method==='POST'&&url===oldRequest.url){if(++entered===2)ready();await gate;}return fetch(url,init);}});
 const first=send(),second=send();
 await bothReady;
 try{const accepted=await fetch(oldRequest.url,oldRequest.init);assert.equal(accepted.status,201);await accepted.json();}finally{release();}
 const [a,b]=await Promise.all([first,second]);assert.equal(a.id,b.id);assert.notEqual(a.id,original.id);assert.equal(f.files.size,2);
 assert.deepEqual(openEnvelope(f.files.get(a.id+'.bin'),[key],{id:a.id,filename:'fixture.txt',direction:'pc-phone'}),f.plain);
 assert.equal((await f.ledger()).id,a.id);
});
