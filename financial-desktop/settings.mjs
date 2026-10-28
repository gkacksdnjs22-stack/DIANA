import path from 'node:path';
import {constants} from 'node:fs';
import {open,lstat,realpath} from 'node:fs/promises';
import {parseEnv} from 'node:util';
import {strictJSON,keys,fail} from '../financial-documents/strict-json.mjs';

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

// The launcher explicitly selects this inert profile, including its shared
// LocalAppData location. Document scanning deliberately forbids AppData; do not
// relax that policy to read a launcher-owned configuration file.
async function profileParent(filename){
  const parent=path.dirname(filename),root=path.parse(parent).root;
  if(filename.startsWith('\\\\'))fail('DESKTOP_SETTINGS_INVALID');
  let current=root;
  for(const part of parent.slice(root.length).split(path.sep).filter(Boolean)){
    current=path.join(current,part);
    const stat=await lstat(current);
    if(!stat.isDirectory()||stat.isSymbolicLink())fail('DESKTOP_SETTINGS_INVALID');
  }
}
const profileStat=stat=>stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1n&&stat.size>=1n&&stat.size<=16384n;
const sameProfile=(a,b)=>['dev','ino','size','mtimeNs','ctimeNs','nlink'].every(key=>a[key]===b[key]);
export async function loadDesktopSettings(filename){
  let handle;
  try{
    filename=path.resolve(filename);
    await profileParent(filename);
    const named=await lstat(filename,{bigint:true});
    if(!profileStat(named))fail('DESKTOP_SETTINGS_INVALID');
    // A packaged Windows process can have AppData redirected by the OS
    // without a symlink. Pin its physical target, validate both ancestor
    // chains, and require both names to keep identifying the opened file.
    const resolved=await realpath(filename);
    await profileParent(resolved);
    const physical=await lstat(resolved,{bigint:true});
    if(!profileStat(physical)||!sameProfile(named,physical))fail('DESKTOP_SETTINGS_INVALID');
    handle=await open(resolved,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
    const before=await handle.stat({bigint:true});
    if(!profileStat(before)||!sameProfile(named,before))fail('DESKTOP_SETTINGS_INVALID');
    const bytes=Buffer.alloc(Number(before.size)+1);let count=0;
    while(count<bytes.length){const result=await handle.read(bytes,count,bytes.length-count,count);if(!result.bytesRead)break;count+=result.bytesRead;}
    const after=await handle.stat({bigint:true}),current=await lstat(filename,{bigint:true}),physicalAfter=await lstat(resolved,{bigint:true});
    if(!profileStat(after)||!profileStat(current)||!profileStat(physicalAfter)||!sameProfile(before,after)||!sameProfile(after,current)||!sameProfile(after,physicalAfter)||count!==Number(before.size)||await realpath(filename)!==resolved||await realpath(resolved)!==resolved)fail('DESKTOP_SETTINGS_INVALID');
    await profileParent(filename);await profileParent(resolved);
    const content=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes.subarray(0,count));
    return desktopSettings(strictJSON(content));
  }catch{fail('DESKTOP_SETTINGS_INVALID');}
  finally{await handle?.close();}
}
