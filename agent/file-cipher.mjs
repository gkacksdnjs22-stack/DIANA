import path from 'node:path';
import {mkdir,readFile,open,link,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {digest,keyId,seal,openEnvelope,inspectEnvelope} from '../lib/e2ee.mjs';
import {keyStore} from './secure-keys.mjs';

// openEnvelope selects one matching key for receivers. A sender holds every
// recipient key and must authenticate each wrapped file key before using a cache.
function verifyAllRecipients(wire,recipients,meta){
  for(const key of recipients)openEnvelope(wire,[key],meta);
}

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
  async function currentRecipients(){
    const active=new Set((await request('/api/agent/phone-devices')).devices.map(d=>d.id));
    const saved=await keys.all(),recipients=Object.entries(saved).filter(([id])=>id.startsWith('device:')&&active.has(id.slice(7))).map(([,v])=>v.key);
    if(!recipients.length)throw Error('암호화 연결된 휴대폰이 없습니다. PC에서 새 연결을 승인하세요.');
    return recipients;
  }
  return {
    async recipientIds(){return (await currentRecipients()).map(key=>keyId(Buffer.from(key,'hex'))).sort();},
    async verifyReceipt(bytes,{id,filename},receipt){
      const recipients=await currentRecipients(),recipientIds=recipients.map(key=>keyId(Buffer.from(key,'hex'))).sort();
      const meta={id,filename,direction:'pc-phone',sha256:digest(bytes),bytes:bytes.length};
      const stem=path.join(stateDir,'e2ee-spool',digest(Buffer.from(JSON.stringify(meta))));
      if(JSON.stringify(recipientIds)!==JSON.stringify([...receipt.recipientKeyIds].sort()))throw Error('암호문 수신 기기가 변경됐습니다. 다시 확인하세요.');
      // Acceptance is proved against an existing, authenticated local payload.
      // Never generate a replacement merely to validate an accepted transfer.
      for(const file of [stem+'.'+digest(Buffer.from(JSON.stringify(recipientIds)))+'.complete',stem+'.complete',stem+'.bin']){
        let wire;try{wire=await readFile(file);}catch(e){if(e.code==='ENOENT')continue;throw e;}
        if(digest(wire)!==receipt.sha256)continue;
        const envelope=inspectEnvelope(wire);
        if(JSON.stringify(envelope.recipients.map(r=>r.kid).sort())!==JSON.stringify(recipientIds))continue;
        verifyAllRecipients(wire,recipients,meta);return;
      }
      throw Error('저장된 암호문이 PC 전송 기록과 일치하지 않습니다.');
    },
    async encrypt(bytes,{id,filename},{unaccepted=false}={}){
      const recipients=await currentRecipients();
      const meta={id,filename,direction:'pc-phone',sha256:digest(bytes),bytes:bytes.length};
      const stem=path.join(stateDir,'e2ee-spool',digest(Buffer.from(JSON.stringify(meta))));
      // Only a caller that confirmed server non-acceptance may select a new recipient generation.
      // Separate immutable files avoid overwriting a cached payload in use by another sender.
      const recipientIds=recipients.map(key=>keyId(Buffer.from(key,'hex'))).sort();
      const file=stem+(unaccepted?'.'+digest(Buffer.from(JSON.stringify(recipientIds))):'')+'.complete';
      try{const old=await readFile(file);verifyAllRecipients(old,recipients,meta);return old;}catch(e){if(e.code!=='ENOENT')throw e;}
      let wire;
      if(unaccepted){
        try{const old=await readFile(stem+'.complete'),envelope=inspectEnvelope(old);
          if(JSON.stringify(envelope.recipients.map(r=>r.kid).sort())===JSON.stringify(recipientIds)){verifyAllRecipients(old,recipients,meta);wire=old;}
        }catch(e){if(e.code!=='ENOENT')throw e;}
      }
      try{const old=await readFile(stem+'.bin');
        // Earlier versions could leave a partial file at the published filename.
        let complete=false;try{inspectEnvelope(old);complete=true;}catch{}
        if(complete&&(!unaccepted||JSON.stringify(inspectEnvelope(old).recipients.map(r=>r.kid).sort())===JSON.stringify(recipientIds))){verifyAllRecipients(old,recipients,meta);wire??=old;}
      }catch(e){if(e.code!=='ENOENT')throw e;}
      wire??=seal(bytes,recipients,meta);await mkdir(path.dirname(file),{recursive:true});
      const published=await publishCiphertext(file,wire);verifyAllRecipients(published,recipients,meta);return published;
    },
    async decrypt(wire,expected){const saved=await keys.all();return openEnvelope(wire,Object.entries(saved).filter(([id])=>id.startsWith('device:')).map(([,v])=>v.key),{...expected,direction:'phone-pc'});}
  };
}
