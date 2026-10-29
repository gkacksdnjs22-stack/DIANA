import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {lstat,realpath} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {strictJSON,keys,fail} from '../financial-documents/strict-json.mjs';
const project=fileURLToPath(new URL('../',import.meta.url));
let choosing=false;
export async function pickLocalFolder({signal}={}){
  if(choosing)fail('REGISTRATION_BUSY');choosing=true;
  try{return await choose(signal);}finally{choosing=false;}
}
async function choose(signal){
  if(process.platform!=='win32')fail('FOLDER_PICKER_UNAVAILABLE');
  const locations=[path.resolve(project,'../runtime/native/DIANA-FolderPicker.exe'),path.join(project,'.local/financial-desktop-tools/DIANA-FolderPicker.exe')];
  let executable;
  for(const candidate of locations){try{const stat=await lstat(candidate);if(stat.isFile()&&!stat.isSymbolicLink()&&await realpath(candidate)===candidate){executable=candidate;break;}}catch(error){if(error.code!=='ENOENT')throw error;}}
  if(!executable)fail('FOLDER_PICKER_UNAVAILABLE');
  const env=Object.fromEntries(['SystemRoot','WINDIR','SystemDrive','TEMP','TMP'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]));
  // This is a GUI-subsystem EXE (no console). Its first folder dialog must not
  // inherit SW_HIDE from a background worker's startup information.
  let result;try{const{stdout}=await promisify(execFile)(executable,[],{windowsHide:false,shell:false,timeout:180000,maxBuffer:16384,encoding:'utf8',env,signal});result=strictJSON(stdout.replace(/^\uFEFF/u,''));}catch{if(signal?.aborted)return null;fail('FOLDER_PICKER_FAILED');}
  if(result.cancelled===true){keys(result,['cancelled']);return null;}
  keys(result,['folder']);if(typeof result.folder!=='string'||!path.isAbsolute(result.folder)||result.folder.startsWith('\\\\'))fail('FOLDER_PICKER_FAILED');
  return result.folder;
}
