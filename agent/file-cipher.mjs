import path from 'node:path';
import {mkdir,readFile,open,link,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {digest,seal,openEnvelope,inspectEnvelope} from '../lib/e2ee.mjs';
import {keyStore} from './secure-keys.mjs';

// A hard link publishes a closed, synced file without replacing another writer's winner.
export async function publishCiphertext(file,wire,{openFile=open}={}){
  const temporary=file+'.'+randomUUID()+'.tmp';let handle;
  try{
    handle=await openFile(temporary,'wx',0o600);await handle.writeFile(wire);await handle.sync();await handle.close();handle=null;
    try{await link(temporary,file);return wire;}
    catch(error){if(error.code!=='EEXIST')throw error;return await readFile(file);}
  }finally{
    await handle?.close();await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});
  }
}

export function fileCipher({stateDir,request,keys=keyStore(path.join(stateDir,'e2ee'))}){
  return {
    async encrypt(bytes,{id,filename}){
      const active=new Set((await request('/api/agent/phone-devices')).devices.map(d=>d.id));
      const saved=await keys.all(),recipients=Object.entries(saved).filter(([id])=>id.startsWith('device:')&&active.has(id.slice(7))).map(([,v])=>v.key);
      if(!recipients.length)throw Error('암호화 연결된 휴대폰이 없습니다. PC에서 새 연결을 승인하세요.');
      const meta={id,filename,direction:'pc-phone',sha256:digest(bytes),bytes:bytes.length};
      const stem=path.join(stateDir,'e2ee-spool',digest(Buffer.from(JSON.stringify(meta))));
      const file=stem+'.complete';
      try{const old=await readFile(file);openEnvelope(old,recipients,meta);return old;}catch(e){if(e.code!=='ENOENT')throw e;}
      let wire;
      try{const old=await readFile(stem+'.bin');
        // Earlier versions could leave a partial file at the published filename.
        let complete=false;try{inspectEnvelope(old);complete=true;}catch{}
        if(complete){openEnvelope(old,recipients,meta);wire=old;}
      }catch(e){if(e.code!=='ENOENT')throw e;}
      wire??=seal(bytes,recipients,meta);await mkdir(path.dirname(file),{recursive:true});
      const published=await publishCiphertext(file,wire);openEnvelope(published,recipients,meta);return published;
    },
    async decrypt(wire,expected){const saved=await keys.all();return openEnvelope(wire,Object.entries(saved).filter(([id])=>id.startsWith('device:')).map(([,v])=>v.key),{...expected,direction:'phone-pc'});}
  };
}
