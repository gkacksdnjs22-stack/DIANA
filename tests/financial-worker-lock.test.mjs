import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir,mkdtemp,writeFile,readFile,link,rm } from 'node:fs/promises';
import { acquireWorkerLock } from '../financial-documents/worker-lock.mjs';

const childrenByRoot=new Map();
async function fixture(t){const parent=path.resolve('.local');await mkdir(parent,{recursive:true});const root=await mkdtemp(path.join(parent,'financial-worker-lock-test-'));childrenByRoot.set(root,[]);t.after(async()=>{for(const cleanup of childrenByRoot.get(root))await cleanup();childrenByRoot.delete(root);assert.equal(path.dirname(root),parent);assert.match(path.basename(root),/^financial-worker-lock-test-/u);await rm(root,{recursive:true,force:true});});return root;}
function child(t,root,barrier=false){
  const c=spawn(process.execPath,[path.resolve('tests/fixtures/financial-lock-child.mjs'),root,barrier?'barrier':'plain'],{windowsHide:true,stdio:['ignore','pipe','pipe','ipc'],env:Object.fromEntries(['SystemRoot','WINDIR','TEMP','TMP'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]))});
  const log=[],waiters=[];let diagnostics='';c.stdout.on('data',b=>diagnostics+=b);c.stderr.on('data',b=>diagnostics+=b);
  c.on('message',m=>{log.push(m);for(const w of [...waiters])if(w.predicate(m)){waiters.splice(waiters.indexOf(w),1);w.resolve(m);}});
  const exited=once(c,'exit');
  let cleaning;
  const cleanup=()=>cleaning??=(async()=>{if(c.exitCode===null&&c.signalCode===null){if(c.connected){c.send({type:'close'});c.send({type:'release-unlink'});}const done=await Promise.race([exited.then(()=>true),new Promise(r=>setTimeout(()=>r(false),2000))]);if(!done)c.kill();}await exited;})();
  childrenByRoot.get(root).push(cleanup);
  return{send:type=>{if(c.connected)c.send({type});},exited,wait:predicate=>{const found=log.find(predicate);if(found)return Promise.resolve(found);return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('CHILD_TIMEOUT '+diagnostics)),10000);timer.unref();waiters.push({predicate,resolve:m=>{clearTimeout(timer);resolve(m);}});});}};
}

test('two actual processes cannot both acquire a stale lock across delayed unlink',async t=>{
  const root=await fixture(t),old={pid:2147483647,workerId:randomUUID()},lock=path.join(root,'worker.lock');
  await writeFile(lock,JSON.stringify(old),{flag:'wx'});await link(lock,path.join(root,'abandoned-'+old.workerId+'.lock'));
  const a=child(t,root,true),b=child(t,root,true);await Promise.all([a.wait(m=>m.type==='ready'),b.wait(m=>m.type==='ready')]);a.send('go');b.send('go');
  const events=await Promise.all([a,b].map(c=>c.wait(m=>m.type==='before-unlink'||m.type==='result')));
  const index=events.findIndex(e=>e.type==='before-unlink');assert.ok(index>=0,JSON.stringify(events));const first=[a,b][index];
  first.send('release-unlink');const firstResult=await first.wait(m=>m.type==='result');assert.equal(firstResult.status,'acquired');
  const other=first===a?b:a,otherEvent=await other.wait(m=>m.type==='before-unlink'||m.type==='result');
  if(otherEvent.type==='before-unlink')other.send('release-unlink');
  const otherResult=await other.wait(m=>m.type==='result');
  assert.equal([firstResult,otherResult].filter(r=>r.status==='acquired').length,1,JSON.stringify([firstResult,otherResult]));
  assert.equal(JSON.parse(await readFile(lock,'utf8')).pid,firstResult.pid);
});

test('simultaneous cold starts have one owner and losing closes cannot remove its lock',async t=>{
  const root=await fixture(t),children=Array.from({length:6},()=>child(t,root));await Promise.all(children.map(c=>c.wait(m=>m.type==='ready')));children.forEach(c=>c.send('go'));
  const results=await Promise.all(children.map(c=>c.wait(m=>m.type==='result'))),winners=results.filter(r=>r.status==='acquired');assert.equal(winners.length,1,JSON.stringify(results));
  assert.equal(JSON.parse(await readFile(path.join(root,'worker.lock'),'utf8')).pid,winners[0].pid);
});

test('process exit releases the coordination lease and preserves recovery metadata',async t=>{
  const root=await fixture(t),c=child(t,root);await c.wait(m=>m.type==='ready');c.send('go');const first=await c.wait(m=>m.type==='result');assert.equal(first.status,'acquired');c.send('crash');await c.exited;
  const next=await acquireWorkerLock(root,{pid:process.pid,workerId:randomUUID()});try{assert.equal(JSON.parse(await readFile(path.join(root,'worker.lock'),'utf8')).pid,process.pid);}finally{await next.close();}
});

test('unrelated coordination files and sidecars are rejected without modification',async t=>{
  for(const suffix of ['','-journal','-wal','-shm']){
    const root=await fixture(t),filename=path.join(root,'worker-coordination.sqlite'+suffix),bytes=Buffer.from('PRESERVE_UNRELATED_COORDINATOR');await writeFile(filename,bytes,{flag:'wx'});
    let lease;try{await assert.rejects(async()=>{lease=await acquireWorkerLock(root,{pid:process.pid,workerId:randomUUID()});});}finally{await lease?.close();}assert.deepEqual(await readFile(filename),bytes);
  }
});
