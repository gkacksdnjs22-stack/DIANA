import path from 'node:path';
import { constants } from 'node:fs';
import { open, lstat, realpath, readdir, link, unlink } from 'node:fs/promises';
import { checkedDirectory } from '../personal-ai/documents/files.mjs';
import { strictJSON, keys, fail } from './strict-json.mjs';
import { UUID } from '../lib/financial-contract.mjs';
import { DatabaseSync } from 'node:sqlite';

const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs&&a.nlink===b.nlink;
const regular=s=>s.isFile()&&!s.isSymbolicLink()&&s.size>0n&&s.size<=4096n;
const archiveName=id=>'abandoned-'+id+'.lock';
const dead=pid=>{try{process.kill(pid,0);return false;}catch(e){return e.code==='ESRCH';}};
const COORDINATOR_APP=0x44494c4b;
const COORDINATOR_TABLE='CREATE TABLE diana_worker_lock_protocol(version INTEGER PRIMARY KEY CHECK(version=1))';

function protocol(db){
  const schema=db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all();
  if(db.prepare('PRAGMA application_id').get().application_id!==COORDINATOR_APP||db.prepare('PRAGMA journal_mode').get().journal_mode!=='delete'||schema.length!==1||schema[0].type!=='table'||schema[0].name!=='diana_worker_lock_protocol'||schema[0].sql!==COORDINATOR_TABLE)fail('WORKER_LOCK_UNCERTAIN');
  const rows=db.prepare('SELECT version FROM diana_worker_lock_protocol').all();if(rows.length!==1||rows[0].version!==1)fail('WORKER_LOCK_UNCERTAIN');
}

async function coordination(directory){
  const filename=path.join(directory,'worker-coordination.sqlite');let created=false;
  // An unknown sidecar is not ours to truncate, replay or remove. Our lifetime
  // transaction never writes rows, so a running lease creates no sidecars.
  for(const suffix of ['-journal','-wal','-shm']){
    let exists=false;try{await lstat(filename+suffix);exists=true;}catch(e){if(e.code!=='ENOENT')throw e;}
    if(exists)fail('WORKER_LOCK_UNCERTAIN');
  }
  try{const h=await open(filename,'wx',0o600);await h.close();created=true;}catch(e){if(e.code!=='EEXIST')throw e;}
  if(created){
    const s=await lstat(filename,{bigint:true});if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1n||s.size!==0n||await realpath(filename)!==filename)fail('WORKER_LOCK_UNCERTAIN');
    const db=new DatabaseSync(filename);try{db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA application_id=${COORDINATOR_APP}; ${COORDINATOR_TABLE}; INSERT INTO diana_worker_lock_protocol VALUES(1);`);}finally{db.close();}
  }
  const s=await lstat(filename,{bigint:true});
  if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1n||s.size<100n||s.size>1048576n||await realpath(filename)!==filename)fail('WORKER_LOCK_UNCERTAIN');
  // Validate a known, metadata-only database before allowing a writable open.
  let probe;try{probe=new DatabaseSync(filename,{readOnly:true});protocol(probe);}catch{fail('WORKER_LOCK_UNCERTAIN');}finally{probe?.close();}
  const current=await lstat(filename,{bigint:true});if(!same(current,s))fail('WORKER_LOCK_UNCERTAIN');
  const db=new DatabaseSync(filename);
  try{
    protocol(db);db.exec('PRAGMA busy_timeout=0');
    // Held for the complete lease, including recovery, owner publication and
    // release. SQLite's OS lock is released automatically on process death.
    try{db.exec('BEGIN IMMEDIATE');}catch(e){if(e.errcode===5||e.errcode===6)fail('WORKER_ALREADY_RUNNING');throw e;}
    return db;
  }catch(e){db.close();throw e;}
}

/** Lock metadata only. Document boundedRead keeps its nlink===1 restriction.
 * A two-link record is readable ONLY if both links are accounted for by the
 * worker.lock + abandoned-UUID.lock pair inside this checked state directory.
 */
async function snapshot(directory) {
  await checkedDirectory(directory);
  const filename=path.join(directory,'worker.lock'),named=await lstat(filename,{bigint:true});
  if(!regular(named)||![1n,2n].includes(named.nlink)||await realpath(filename)!==filename)fail('WORKER_LOCK_UNCERTAIN');
  let paired=null;
  if(named.nlink===2n){
    for(const name of await readdir(directory)){
      const id=name.slice('abandoned-'.length,-'.lock'.length);
      if(name!==archiveName(id)||!UUID.test(id))continue;
      const candidate=path.join(directory,name),s=await lstat(candidate,{bigint:true});
      if(regular(s)&&same(s,named)&&await realpath(candidate)===candidate){if(paired)fail('WORKER_LOCK_UNCERTAIN');paired=candidate;}
    }
    if(!paired)fail('WORKER_LOCK_UNCERTAIN');
  }
  const h=await open(filename,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
  try{
    const before=await h.stat({bigint:true});if(!same(before,named)||!regular(before))fail('WORKER_LOCK_UNCERTAIN');
    const bytes=Buffer.alloc(Number(before.size)+1);let count=0;
    while(count<bytes.length){const r=await h.read(bytes,count,bytes.length-count,count);if(!r.bytesRead)break;count+=r.bytesRead;}
    const after=await h.stat({bigint:true}),current=await lstat(filename,{bigint:true});
    if(count!==Number(before.size)||!same(before,after)||!same(after,current)||!regular(current)||await realpath(filename)!==filename)fail('WORKER_LOCK_UNCERTAIN');
    const record=strictJSON(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,count)));
    keys(record,['pid','workerId']);
    if(!Number.isSafeInteger(record.pid)||record.pid<1||record.pid>2147483647||!UUID.test(record.workerId))fail('WORKER_LOCK_UNCERTAIN');
    const archive=path.join(directory,archiveName(record.workerId));
    if(paired&&(paired!==archive||!same(await lstat(archive,{bigint:true}),current)))fail('WORKER_LOCK_UNCERTAIN');
    await checkedDirectory(directory);
    return {record,stat:current,paired:!!paired,archive};
  }finally{await h.close();}
}

async function acquireFile(directory) {
  await checkedDirectory(directory);
  const filename=path.join(directory,'worker.lock');
  try{return await open(filename,'wx',0o600);}catch(e){if(e.code!=='EEXIST')throw e;}
  const previous=await snapshot(directory);
  if(!dead(previous.record.pid))fail('WORKER_ALREADY_RUNNING');
  if(!previous.paired){
    // No replacement: an unrelated existing archive is a conflict, not a file
    // to overwrite. If interrupted here, the next start validates this pair.
    try{await link(filename,previous.archive);}catch(e){if(e.code==='EEXIST')fail('WORKER_LOCK_UNCERTAIN');throw e;}
  }
  const current=await snapshot(directory);
  if(!current.paired||current.record.pid!==previous.record.pid||current.record.workerId!==previous.record.workerId||current.stat.dev!==previous.stat.dev||current.stat.ino!==previous.stat.ino)fail('WORKER_LOCK_UNCERTAIN');
  if(!dead(current.record.pid))fail('WORKER_ALREADY_RUNNING');
  if(!same(await lstat(filename,{bigint:true}),current.stat)||!same(await lstat(current.archive,{bigint:true}),current.stat))fail('WORKER_LOCK_UNCERTAIN');
  await unlink(filename);
  try{return await open(filename,'wx',0o600);}catch(e){if(e.code==='EEXIST')fail('WORKER_ALREADY_RUNNING');throw e;}
}

export async function acquireWorkerLock(directory,owner){
  keys(owner,['pid','workerId']);if(owner.pid!==process.pid||!UUID.test(owner.workerId))fail('WORKER_LOCK_UNCERTAIN');
  await checkedDirectory(directory);
  const db=await coordination(directory);let handle;
  try{
    handle=await acquireFile(directory);await handle.writeFile(JSON.stringify(owner));await handle.sync();
    const owned=await handle.stat({bigint:true}),filename=path.join(directory,'worker.lock');
    if(!regular(owned)||owned.nlink!==1n||!same(owned,await lstat(filename,{bigint:true})))fail('WORKER_LOCK_UNCERTAIN');
    let closed=false;
    return{async close(){
      if(closed)return;closed=true;
      try{
        await checkedDirectory(directory);
        if(!same(owned,await lstat(filename,{bigint:true})))fail('WORKER_LOCK_UNCERTAIN');
        await handle.close();handle=null;
        if(!same(owned,await lstat(filename,{bigint:true})))fail('WORKER_LOCK_UNCERTAIN');
        await unlink(filename);
      }finally{try{await handle?.close();}finally{try{db.exec('ROLLBACK');}finally{db.close();}}}
    }};
  }catch(e){try{await handle?.close();}finally{try{db.exec('ROLLBACK');}finally{db.close();}}throw e;}
}
