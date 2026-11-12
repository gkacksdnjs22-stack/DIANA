import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {offerKey} from '../lib/e2ee.mjs';

export async function confirmPhoneOnPc(pending, {signal,spawnImpl=spawn,platform=process.platform} = {}) {
  if(platform!=='win32'||signal?.aborted)return null;
  const timeout=Math.min(300000,Date.parse(pending.expiresAt)-Date.now());
  if(!(timeout>0))return null;
  return new Promise(resolve=>{
    let child;
    try{child=spawnImpl('powershell.exe',['-NoProfile','-NonInteractive','-STA','-File',fileURLToPath(new URL('./pair-approval.ps1',import.meta.url))],{windowsHide:true,stdio:['pipe','pipe','ignore']});}catch{return resolve(null);}
    let result='',finished=false;
    const finish=value=>{if(finished)return;finished=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);child.kill();resolve(value);};
    const abort=()=>finish(null),timer=setTimeout(abort,timeout);
    signal?.addEventListener('abort',abort,{once:true});
    child.stdout.on('data',part=>{result+=part;if(result.length>100)finish(null);});
    child.on('error',()=>finish(null));child.stdin.on('error',()=>finish(null));
    child.on('close',code=>{const answer=result.trim();finish(code===0&&Date.now()<Date.parse(pending.expiresAt)?(answer==='approve'?true:answer==='reject'?false:null):null);});
    if(signal?.aborted){abort();return;}
    // Untrusted names are data on stdin, never executable PowerShell text.
    child.stdin.end(JSON.stringify({deviceName:pending.deviceName}));
  });
}

export async function checkPhoneApproval({request,confirm=confirmPhoneOnPc,signal,keys}) {
  const {pending}=await request('/api/agent/pair-pending');
  if(!pending)return false;
  if(typeof pending.id!=='string'||typeof pending.deviceName!=='string'||pending.deviceName.length>100||!Number.isFinite(Date.parse(pending.expiresAt)))throw Error('Invalid pairing request');
  const approve=await confirm(pending,{signal});
  if(signal?.aborted||typeof approve!=='boolean')return false;
  let offer;
  if(approve===true){if(!keys)throw Error('PC 키 저장소를 확인하세요.');offer=await keys.get('device:'+pending.id);if(!offer){offer=offerKey(pending.publicKey,pending.requestId);await keys.set('device:'+pending.id,offer);}}
  await request('/api/agent/pair-approve',{method:'POST',body:{id:pending.id,approve:approve===true,...(offer?{e2ee:offer.reply}:{})}});
  return true;
}
