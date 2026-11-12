import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {newIdentity,offerKey,acceptKey,seal,openEnvelope,inspectEnvelope,digest} from '../lib/e2ee.mjs';
import {createControlServer} from '../lib/control.mjs';
import {checkPhoneApproval} from '../agent/pair-approval.mjs';
import {pairRequest} from './helpers/phone-pair.mjs';
import {keyStore} from '../agent/secure-keys.mjs';
import {mkdtemp,readFile,rm,mkdir,writeFile,readdir,open} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileCipher,publishCiphertext} from '../agent/file-cipher.mjs';

test('a failed cache write publishes nothing and the next process can retry',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'diana-cache-write-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const target=path.join(dir,'fixture.complete'),wire=Buffer.from('synthetic complete ciphertext');
 await assert.rejects(()=>publishCiphertext(target,wire,{openFile:async(...args)=>{const handle=await open(...args);return{async writeFile(b){await handle.writeFile(b.subarray(0,4));throw Error('interrupted write');},sync:()=>handle.sync(),close:()=>handle.close()};}}),/interrupted write/);
 assert.deepEqual(await readdir(dir),[]);assert.deepEqual(await publishCiphertext(target,wire),wire);assert.deepEqual(await readFile(target),wire);
});

test('a complete old cache retains its exact ciphertext when migrated',async t=>{
 const stateDir=await mkdtemp(path.join(os.tmpdir(),'diana-old-cache-'));t.after(()=>rm(stateDir,{recursive:true,force:true}));
 const key=randomBytes(32).toString('hex'),bytes=Buffer.from('old immutable ciphertext'),meta={id:randomUUID(),filename:'fixture.txt'};
 const bound={...meta,direction:'pc-phone',sha256:digest(bytes),bytes:bytes.length},wire=seal(bytes,[key],bound),directory=path.join(stateDir,'e2ee-spool');await mkdir(directory);
 await writeFile(path.join(directory,digest(Buffer.from(JSON.stringify(bound)))+'.bin'),wire);
 const options={stateDir,request:async()=>({devices:[{id:'phone'}]}),keys:{async all(){return{'device:phone':{key}};}}};
 assert.deepEqual(await fileCipher(options).encrypt(bytes,meta),wire);assert.deepEqual(await fileCipher(options).encrypt(bytes,meta),wire);
});

test('a partial legacy cache and abandoned temporary write cannot poison retries',async t=>{
 const stateDir=await mkdtemp(path.join(os.tmpdir(),'diana-partial-cache-'));t.after(()=>rm(stateDir,{recursive:true,force:true}));
 const key=randomBytes(32).toString('hex'),bytes=Buffer.from('interrupted cache fixture'),meta={id:randomUUID(),filename:'fixture.txt'};
 const directory=path.join(stateDir,'e2ee-spool');await mkdir(directory);
 const stem=digest(Buffer.from(JSON.stringify({...meta,direction:'pc-phone',sha256:digest(bytes),bytes:bytes.length})));
 await writeFile(path.join(directory,stem+'.bin'),'DIANA-E2EE-1\n{"v":1');
 await writeFile(path.join(directory,stem+'.interrupted.tmp'),'partial uncommitted bytes');
 const options={stateDir,request:async()=>({devices:[{id:'phone'}]}),keys:{async all(){return{'device:phone':{key}};}}};
 const wires=await Promise.all(Array.from({length:4},()=>fileCipher(options).encrypt(bytes,meta)));
 assert(wires.every(w=>w.equals(wires[0])));assert.deepEqual(openEnvelope(wires[0],[key],{...meta,direction:'pc-phone'}),bytes);
 assert.deepEqual(await fileCipher(options).encrypt(bytes,meta),wires[0]);
 const committed=(await readdir(directory)).filter(p=>p.endsWith('.complete'));assert.equal(committed.length,1);
 assert.deepEqual(await readFile(path.join(directory,committed[0])),wires[0]);
});

test('PC file sender retries immutable ciphertext and excludes revoked devices from new files',async t=>{
 const stateDir=await mkdtemp(path.join(os.tmpdir(),'diana-file-fixture-'));t.after(()=>rm(stateDir,{recursive:true,force:true}));
 const first=randomBytes(32).toString('hex'),second=randomBytes(32).toString('hex');let active=['first','second'];
 const saved={'device:first':{key:first},'device:second':{key:second}};
 const options={stateDir,request:async()=>({devices:active.map(id=>({id}))}),keys:{async all(){return saved;}}};
 const plain=Buffer.from('synthetic encrypted sender fixture'),meta={id:randomUUID(),filename:'example.txt'};
 const wire=await fileCipher(options).encrypt(plain,meta);
 assert.deepEqual(await fileCipher(options).encrypt(plain,meta),wire);
 assert.deepEqual(openEnvelope(wire,[second],{...meta,direction:'pc-phone'}),plain);
 active=['first'];const next={...meta,id:randomUUID()},fresh=await fileCipher(options).encrypt(plain,next);
 assert.throws(()=>openEnvelope(fresh,[second],{...next,direction:'pc-phone'}));
 assert.deepEqual(openEnvelope(fresh,[first],{...next,direction:'pc-phone'}),plain);
 active=[];await assert.rejects(()=>fileCipher(options).encrypt(plain,{...meta,id:randomUUID()}));
});

test('maximum existing attachments survive encryption and JSON wrapping',()=>{
 const key=randomBytes(32),meta={id:randomUUID(),filename:'request.json',direction:'phone-pc'};
 const payload=Buffer.from(JSON.stringify({at:Date.now(),body:{op:'job',action:'desk-upload',base64:Buffer.alloc(8000000,75).toString('base64')}}));
 const wire=seal(payload,[key],meta);assert(Buffer.byteLength(JSON.stringify({op:'encrypted',id:meta.id,data:wire.toString('base64')}))<32000000);
 assert.deepEqual(openEnvelope(wire,[key],meta),payload);
 const file=Buffer.alloc(10*1024*1024,76),fileMeta={...meta,filename:'largest.bin'};
 const encrypted=seal(file,[key],fileMeta);assert(encrypted.length<15*1024*1024);assert.deepEqual(openEnvelope(encrypted,[key],fileMeta),file);
});

test('Windows protected key creation is atomic across concurrent approval retries',{skip:process.platform!=='win32'},async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'diana-key-fixture-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const store=keyStore(dir);let created=0;
 const values=await Promise.all(Array.from({length:3},()=>store.ensure('pending:fixture',()=>{created++;return{key:randomBytes(32).toString('hex')};})));
 assert.equal(created,1);assert(values.every(v=>v.key===values[0].key));
 assert(!(await readFile(path.join(dir,'transfer-keys.dpapi'))).includes(Buffer.from(values[0].key)));
});

test('P-256 handshake confirms the same key and rejects substituted keys, request IDs and confirmation',()=>{
 const phone=newIdentity(),id=randomUUID(),offer=offerKey(phone.publicKey,id),key=acceptKey(phone,offer.reply,id);
 assert.equal(key.toString('hex'),offer.key);
 assert.throws(()=>acceptKey(newIdentity(),offer.reply,id));
 assert.throws(()=>acceptKey(phone,offer.reply,randomUUID()));
 assert.throws(()=>acceptKey(phone,{...offer.reply,confirm:'0'.repeat(64)},id));
});
test('files bind direction, transfer, filename, content and recipient; fresh sends use fresh nonces',()=>{
 const key=randomBytes(32),other=randomBytes(32),plain=Buffer.from('private synthetic document'),meta={id:randomUUID(),filename:'시험 파일.txt',direction:'pc-phone'};
 const a=seal(plain,[key,other],meta),b=seal(plain,[key,other],meta);
 assert.notDeepEqual(a,b);assert(!a.includes(plain));assert.deepEqual(openEnvelope(a,[key],meta),plain);assert.deepEqual(openEnvelope(a,[other],meta),plain);
 for(const expected of [{...meta,direction:'phone-pc'},{...meta,id:randomUUID()},{...meta,filename:'wrong.txt'}])assert.throws(()=>openEnvelope(a,[key],expected));
 assert.throws(()=>openEnvelope(a,[randomBytes(32)],meta));assert.throws(()=>openEnvelope(plain,[key],meta));
 const rewrite=edit=>{const v=inspectEnvelope(a);edit(v);return Buffer.from('DIANA-E2EE-1\n'+JSON.stringify(v));};
 for(const wire of [rewrite(v=>{const d=Buffer.from(v.data,'base64');d[0]^=1;v.data=d.toString('base64');}),rewrite(v=>v.meta.sha256='0'.repeat(64)),rewrite(v=>v.recipients[0].key=v.recipients[1].key),rewrite(v=>v.v=2),rewrite(v=>v.recipients.push(v.recipients[0]))])assert.throws(()=>openEnvelope(wire,[key],meta));
});
test('production relay keeps ciphertext only, denies plaintext uploads, and supports both file directions',async t=>{
 const db=new DatabaseSync(':memory:'),files=new Map(),tokens={userToken:'u'.repeat(40),agentToken:'a'.repeat(40),gatewayToken:'g'.repeat(40)};
 const server=createControlServer({...tokens,db,transfers:{async put(id,b){files.set(id,Buffer.from(b));},async read(id){return files.get(id);},async remove(id){files.delete(id);}}});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});const base='http://127.0.0.1:'+server.address().port;
 const request=async(route,{method='GET',token=tokens.userToken,body,bytes,headers={}}={})=>{const r=await fetch(base+route,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json',...headers},body:bytes|| (body?JSON.stringify(body):undefined)});return{status:r.status,data:r.headers.get('content-type')?.includes('application/json')?await r.json():Buffer.from(await r.arrayBuffer())};};
 const phone=newIdentity(),code=(await request('/api/phone/pair-code',{method:'POST'})).data.code,body=pairRequest({code,deviceName:'Synthetic',publicKey:phone.publicKey});
 assert.equal((await request('/api/phone/pair',{method:'POST',token:'',body})).status,202);
 const map=new Map();const keys={async get(id){return map.get(id);},async set(id,v){map.set(id,v);}};
 await checkPhoneApproval({request:async(route,opts)=>{const r=await request(route,{...opts,token:tokens.agentToken});assert.equal(r.status,200);return r.data;},confirm:async()=>true,keys});
 const paired=await request('/api/phone/pair',{method:'POST',token:'',body});assert.equal(paired.status,201);const key=acceptKey(phone,paired.data.e2ee,body.requestId);
 const settings=JSON.stringify(db.prepare('SELECT * FROM settings').all());assert(!settings.includes(key.toString('hex')));assert(!settings.includes(phone.privateKey));
 const plain=Buffer.from('SYNTHETIC_PRIVATE_DOC_MARKER'),filename='example.txt';
 for(const direction of ['phone-pc','pc-phone']){
  const id=randomUUID(),meta={id,filename,direction},wire=seal(plain,[key],meta),route='/api/'+(direction==='phone-pc'?'uploads':'deliveries')+'/'+id,token=direction==='phone-pc'?paired.data.phoneToken:tokens.userToken;
  const headers={'X-File-Name':encodeURIComponent(filename),'X-File-SHA256':digest(plain)};
  assert.equal((await request(route,{method:'POST',token,bytes:plain,headers})).status,409);
  const sent=await request(route,{method:'POST',token,bytes:wire,headers});assert.equal(sent.status,201);
  assert.equal((await request(route,{method:'POST',token,bytes:wire,headers})).status,200);
  assert([...files.values()].every(b=>!b.includes(plain)));
  let downloaded;
  if(direction==='phone-pc'){await request('/api/agent/uploads/next',{token:tokens.agentToken});downloaded=await request('/api/agent/uploads/'+id+'/file',{token:tokens.agentToken});}
  else downloaded=await request('/api/jobs/'+id+'/file',{token:paired.data.phoneToken});
  assert.equal(downloaded.status,200);assert.deepEqual(downloaded.data,wire);assert.deepEqual(openEnvelope(downloaded.data,[key],meta),plain);
 }
});
