import path from 'node:path';
import {open,lstat,realpath} from 'node:fs/promises';
import {parseEnv} from 'node:util';
import {strictJSON,keys,fail} from '../financial-documents/strict-json.mjs';
import {boundedRead} from '../financial-documents/files.mjs';

export function desktopSettings(value){
  keys(value,['schema_version','configPath','envFile','documentRoot','apiBaseUrl','autoOpen']);
  if(value.schema_version!==1||typeof value.autoOpen!=='boolean')fail('DESKTOP_SETTINGS_INVALID');
  for(const key of ['configPath','envFile','documentRoot'])if(typeof value[key]!=='string'||!path.isAbsolute(value[key])||value[key].startsWith('\\\\')||/[\x00-\x1f]/u.test(value[key]))fail('DESKTOP_SETTINGS_INVALID');
  let url;try{url=new URL(value.apiBaseUrl);}catch{fail('DESKTOP_SETTINGS_INVALID');}
  if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||!(url.protocol==='https:'||url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)))fail('DESKTOP_SETTINGS_INVALID');
  return Object.freeze({...value,apiBaseUrl:url.origin});
}

// The .env is explicitly selected by the PC user. Read it as inert data:
// no Node --env-file, NODE_OPTIONS, shell expansion, or broad environment merge.
export async function desktopEnvironment(filename,apiBaseUrl){
  const stat=await lstat(filename,{bigint:true});
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1n||stat.size>100_000n||await realpath(filename)!==path.resolve(filename))fail('DESKTOP_ENV_INVALID');
  const handle=await open(filename,'r');
  try{
    const before=await handle.stat({bigint:true});
    if(before.dev!==stat.dev||before.ino!==stat.ino||before.size!==stat.size)fail('DESKTOP_ENV_INVALID');
    const bytes=Buffer.alloc(Number(stat.size)+1);let count=0;
    while(count<bytes.length){const read=await handle.read(bytes,count,bytes.length-count,count);if(!read.bytesRead)break;count+=read.bytesRead;}
    const after=await handle.stat({bigint:true}),named=await lstat(filename,{bigint:true});
    for(const current of [after,named])for(const key of ['dev','ino','size','mtimeNs','ctimeNs','nlink'])if(current[key]!==stat[key])fail('DESKTOP_ENV_INVALID');
    if(count!==Number(stat.size)||await realpath(filename)!==path.resolve(filename))fail('DESKTOP_ENV_INVALID');
    const env=parseEnv(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,count)));
    if(typeof env.AGENT_TOKEN!=='string'||env.AGENT_TOKEN.length<32||/[\r\n]/u.test(env.AGENT_TOKEN))fail('DESKTOP_ENV_INVALID');
    return {API_BASE_URL:apiBaseUrl,AGENT_TOKEN:env.AGENT_TOKEN};
  }finally{await handle.close();}
}

export async function loadDesktopSettings(filename){return desktopSettings(strictJSON((await boundedRead(filename,16384)).content));}
