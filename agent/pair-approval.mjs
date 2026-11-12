import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {offerKey} from '../lib/e2ee.mjs';

export async function confirmPhoneOnPc(pending, {signal,spawnImpl=spawn,platform=process.platform,logger=console} = {}) {
  if(platform!=='win32'||signal?.aborted)return null;
  const timeout=Math.min(300000,Date.parse(pending.expiresAt)-Date.now());
  if(!(timeout>0))return null;
  return new Promise(resolve=>{
    // Never log raw stderr, device names or stdin: only bounded, known failure categories.
    const report=(reason,code)=>logger.error(`[DIANA pairing] approval-ui ${reason}${Number.isInteger(code)?' (exit '+code+')':''}; pending retained`);
    let child;
    // Process scope only; do not change machine/user policy or override Group Policy.
    try{child=spawnImpl('powershell.exe',['-NoProfile','-NonInteractive','-STA','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./pair-approval.ps1',import.meta.url))],{windowsHide:true,stdio:['pipe','pipe','pipe']});}catch(error){report(['ENOENT','EACCES','EPERM'].includes(error.code)?error.code:'spawn-failed');return resolve(null);}
    let result='',stderr='',finished=false;
    const finish=value=>{if(finished)return;finished=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);child.kill();resolve(value);};
    const fail=(reason,code)=>{if(!finished){report(reason,code);finish(null);}};
    const abort=()=>finish(null),timer=setTimeout(()=>fail('timeout'),timeout);
    signal?.addEventListener('abort',abort,{once:true});
    child.stdout.on('data',part=>{result+=part;if(result.length>100)fail('invalid-response');});
    child.stderr.on('data',part=>{stderr=(stderr+part).slice(0,4096);});
    child.on('error',error=>fail(['ENOENT','EACCES','EPERM'].includes(error.code)?error.code:'process-error'));
    child.stdin.on('error',()=>fail('stdin-error'));
    child.on('close',code=>{
      if(finished)return;
      if(code!==0)return fail(/UnauthorizedAccess|PSSecurityException/.test(stderr)?'execution-policy-blocked':stderr.includes('DIANA_PAIR_UI_UNAVAILABLE')?'desktop-unavailable':'script-error',code);
      const answer=result.trim();
      if(Date.now()>=Date.parse(pending.expiresAt))return fail('expired');
      if(answer!=='approve'&&answer!=='reject')return fail('invalid-response');
      finish(answer==='approve');
    });
    if(signal?.aborted){abort();return;}
    // Untrusted names are data on stdin, never executable PowerShell text.
    child.stdin.end(JSON.stringify({deviceName:pending.deviceName}));
  });
}

export async function checkPhoneApproval({request,confirm=confirmPhoneOnPc,signal,keys,logger=console}) {
  const {pending}=await request('/api/agent/pair-pending');
  if(!pending)return false;
  if(typeof pending.id!=='string'||typeof pending.deviceName!=='string'||pending.deviceName.length>100||!Number.isFinite(Date.parse(pending.expiresAt)))throw Error('Invalid pairing request');
  const approve=await confirm(pending,{signal,logger});
  if(signal?.aborted||typeof approve!=='boolean')return false;
  let offer;
  if(approve===true){if(!keys)throw Error('PC 키 저장소를 확인하세요.');offer=await keys.get('device:'+pending.id);if(!offer){offer=offerKey(pending.publicKey,pending.requestId);await keys.set('device:'+pending.id,offer);}}
  await request('/api/agent/pair-approve',{method:'POST',body:{id:pending.id,approve:approve===true,...(offer?{e2ee:offer.reply}:{})}});
  return true;
}
