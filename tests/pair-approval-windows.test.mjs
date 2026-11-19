import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {confirmPhoneOnPc} from '../agent/pair-approval.mjs';

test('Windows approval launcher runs its script with a Restricted inherited policy without changing persistent policy',{skip:process.platform!=='win32'},async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'diana-policy-probe-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const probe=path.join(directory,'probe.ps1');
 // The test runner may inherit PowerShell 7's module paths. Let Windows PowerShell
 // initialize its own module path, as it does when launched from the desktop.
 const env=Object.fromEntries(Object.entries(process.env).filter(([name])=>name.toLowerCase()!=='psmodulepath'));
 // Exercise script execution and WinForms construction without showing or approving a real request.
 await writeFile(probe,"$ErrorActionPreference='Stop'\nAdd-Type -AssemblyName System.Windows.Forms\n$f=New-Object System.Windows.Forms.Form\n$f.CreateControl()\n$f.Dispose()\n[Console]::Out.Write('approve')\n");
 const policies=()=>{const r=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command','Get-ExecutionPolicy -List | ConvertTo-Json -Compress'],{encoding:'utf8',windowsHide:true,env});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout).filter(p=>p.Scope!==2);};
 const before=policies();
 const blocked=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Restricted','-File',probe],{encoding:'utf8',windowsHide:true,env});
 assert.notEqual(blocked.status,0);assert.match(blocked.stderr,/UnauthorizedAccess|PSSecurityException/);
 const logs=[];
 const approved=await confirmPhoneOnPc({deviceName:'synthetic probe',expiresAt:new Date(Date.now()+30000).toISOString()},{logger:{error:m=>logs.push(m)},spawnImpl:(command,args,options)=>{
  assert(args.at(-1).endsWith('pair-approval.ps1'));
  return spawn(command,[...args.slice(0,-1),probe],{...options,env:{...env,PSExecutionPolicyPreference:'Restricted'}});
 }});
 assert.equal(approved,true);assert.deepEqual(logs,[]);assert.deepEqual(policies(),before);
 // Keep the Korean Windows PowerShell 5.1 UI script UTF-8 BOM.
 const source=await readFile(new URL('../agent/pair-approval.ps1',import.meta.url));assert.deepEqual([...source.subarray(0,3)],[239,187,191]);
});
