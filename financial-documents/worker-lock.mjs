import path from 'node:path';
import { constants } from 'node:fs';
import { open, lstat, realpath, readdir, link, unlink } from 'node:fs/promises';
import { checkedDirectory } from '../personal-ai/documents/files.mjs';
import { strictJSON, keys, fail } from './strict-json.mjs';
import { UUID } from '../lib/financial-contract.mjs';

const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs&&a.nlink===b.nlink;
const regular=s=>s.isFile()&&!s.isSymbolicLink()&&s.size>0n&&s.size<=4096n;
const archiveName=id=>'abandoned-'+id+'.lock';
const dead=pid=>{try{process.kill(pid,0);return false;}catch(e){return e.code==='ESRCH';}};

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

export async function acquireWorkerLock(directory) {
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
