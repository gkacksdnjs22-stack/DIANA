import {spawn} from 'node:child_process';
import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

async function protect(bytes,decrypt=false){
  if(process.platform!=='win32')throw Error('Protected PC keys require Windows DPAPI.');
  const operation=decrypt?'Unprotect':'Protect';
  const script=`$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;$v=[Convert]::FromBase64String([Console]::In.ReadToEnd());$r=[Security.Cryptography.ProtectedData]::${operation}($v,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($r))`;
  return new Promise((resolve,reject)=>{const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,stdio:['pipe','pipe','ignore']});let out='';const timer=setTimeout(()=>child.kill(),20000);
    child.on('error',()=>{clearTimeout(timer);reject(Error('PC 암호화 키 저장소를 열지 못했습니다.'));});child.stdin.on('error',()=>{});
    child.stdout.on('data',b=>{out+=b;if(out.length>1024*1024)child.kill();});child.on('close',code=>{clearTimeout(timer);if(code!==0)reject(Error('PC 암호화 키 저장소를 열지 못했습니다.'));else resolve(Buffer.from(out,'base64'));});child.stdin.end(bytes.toString('base64'));});
}
const instances=new Map();
export function keyStore(directory){
  const file=path.resolve(directory,'transfer-keys.dpapi');if(instances.has(file))return instances.get(file);
  let data,queue=Promise.resolve();
  async function load(){if(data)return data;try{data=JSON.parse((await protect(await readFile(file),true)).toString());}catch(e){if(e.code!=='ENOENT')throw e;data={};}return data;}
  async function update(id,make,onlyIfAbsent=false){
    const task=queue.then(async()=>{
      const next={...await load()};if(onlyIfAbsent&&next[id])return next[id];
      const value=make();if(value===null)delete next[id];else next[id]=value;
      const bytes=await protect(Buffer.from(JSON.stringify(next)));await mkdir(path.dirname(file),{recursive:true});
      const temp=file+'.'+randomUUID()+'.tmp';await writeFile(temp,bytes,{flag:'wx',mode:0o600});await rename(temp,file);data=next;return value;
    });queue=task.catch(()=>{});return task;
  }
  const store={async get(id){await queue;return(await load())[id];},async all(){await queue;return{...await load()};},set:(id,value)=>update(id,()=>value),ensure:(id,make)=>update(id,make,true)};
  instances.set(file,store);return store;
}
