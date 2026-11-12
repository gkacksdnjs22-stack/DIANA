import path from 'node:path';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {digest,seal,openEnvelope} from '../lib/e2ee.mjs';
import {keyStore} from './secure-keys.mjs';

export function fileCipher({stateDir,request,keys=keyStore(path.join(stateDir,'e2ee'))}){
  return {
    async encrypt(bytes,{id,filename}){
      const active=new Set((await request('/api/agent/phone-devices')).devices.map(d=>d.id));
      const saved=await keys.all(),recipients=Object.entries(saved).filter(([id])=>id.startsWith('device:')&&active.has(id.slice(7))).map(([,v])=>v.key);
      if(!recipients.length)throw Error('암호화 연결된 휴대폰이 없습니다. PC에서 새 연결을 승인하세요.');
      const meta={id,filename,direction:'pc-phone',sha256:digest(bytes),bytes:bytes.length};
      const file=path.join(stateDir,'e2ee-spool',digest(Buffer.from(JSON.stringify(meta)))+'.bin');
      try{const old=await readFile(file);openEnvelope(old,recipients,meta);return old;}catch(e){if(e.code!=='ENOENT')throw e;}
      const wire=seal(bytes,recipients,meta);await mkdir(path.dirname(file),{recursive:true});
      try{await writeFile(file,wire,{flag:'wx',mode:0o600});return wire;}
      catch(e){if(e.code!=='EEXIST')throw e;const old=await readFile(file);openEnvelope(old,recipients,meta);return old;}
    },
    async decrypt(wire,expected){const saved=await keys.all();return openEnvelope(wire,Object.entries(saved).filter(([id])=>id.startsWith('device:')).map(([,v])=>v.key),{...expected,direction:'phone-pc'});}
  };
}
