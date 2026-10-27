import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';

const waitFor=type=>new Promise(resolve=>{const listen=m=>{if(m.type===type){process.off('message',listen);resolve(m);}};process.on('message',listen);});
if(process.argv[3]==='barrier')registerHooks({
  resolve(specifier,context,next){if(specifier==='node:fs/promises'&&context.parentURL?.endsWith('/financial-documents/worker-lock.mjs'))return{url:'test:financial-lock-fs',shortCircuit:true};return next(specifier,context);},
  load(url,context,next){if(url!=='test:financial-lock-fs')return next(url,context);return{format:'module',shortCircuit:true,source:`
    import * as fs from 'node:fs/promises';import path from 'node:path';
    export const {open,lstat,realpath,readdir,link}=fs;let paused=false;
    export async function unlink(p){if(!paused&&path.resolve(p)===path.resolve(process.argv[2],'worker.lock')){paused=true;
      const released=new Promise(resolve=>{const listener=m=>{if(m.type==='release-unlink'){process.off('message',listener);resolve();}};process.on('message',listener);});
      process.send({type:'before-unlink'});await released;
    }return fs.unlink(p);}
  `};}
});
const {acquireWorkerLock}=await import('../../financial-documents/worker-lock.mjs');
const go=waitFor('go');process.send({type:'ready'});await go;
let lease;
try{
  const owner={pid:process.pid,workerId:randomUUID()};lease=await acquireWorkerLock(path.resolve(process.argv[2]),owner);
  // Compatibility with the old FileHandle API makes the race regression fail
  // on the reviewed version and pass with the lifetime lease implementation.
  if(typeof lease.writeFile==='function'){await lease.writeFile(JSON.stringify(owner));await lease.sync();}
  const close=waitFor('close'),crash=waitFor('crash');
  process.send({type:'result',status:'acquired',pid:process.pid});
  const command=await Promise.race([close,crash]);if(command.type==='crash')process.exit(0);
  await lease.close();process.exit(0);
}catch(e){process.send({type:'result',status:'rejected',code:e.code||'UNEXPECTED_LOCK_ERROR'});process.exit(0);}
