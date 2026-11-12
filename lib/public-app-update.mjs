import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFile,open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {MAX_UPLOAD_BYTES,validateUploadMetadata} from './upload-contract.mjs';

const downloads=fileURLToPath(new URL('../public/downloads/',import.meta.url));
const deny=()=>{throw Object.assign(Error('공개 배포 목록의 APK와 일치하지 않습니다. 배포 파일과 SHA-256을 확인하세요.'),{status:409});};

// Accept only bytes already published by this server, never caller-supplied plaintext.
export async function publicAppUpdate(request,{directory=downloads}={}){
  let metadata;try{metadata=validateUploadMetadata(request);}catch{deny();}
  if(!/\.apk$/i.test(metadata.filename))deny();
  let registry;try{registry=JSON.parse(await readFile(path.join(directory,'releases.json'),'utf8'));}catch{deny();}
  const release=[registry.android,registry.legacy?.android].find(r=>r?.sha256===metadata.sha256&&r.bytes===metadata.bytes);
  if(!release||!/^\/downloads\/[A-Za-z0-9][A-Za-z0-9._-]*\.apk$/.test(release.path)||release.bytes>MAX_UPLOAD_BYTES)deny();
  const handle=await open(path.join(directory,path.basename(release.path)),'r');
  try{
    const stat=await handle.stat();if(!stat.isFile()||stat.size!==release.bytes)deny();
    const bytes=Buffer.alloc(release.bytes+1);let count=0;
    while(count<bytes.length){const r=await handle.read(bytes,count,bytes.length-count,count);if(!r.bytesRead)break;count+=r.bytesRead;}
    const body=bytes.subarray(0,count);
    if(count!==release.bytes||!body.subarray(0,4).equals(Buffer.from([80,75,3,4]))||createHash('sha256').update(body).digest('hex')!==release.sha256)deny();
    return body;
  }finally{await handle.close();}
}
