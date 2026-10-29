import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readFile,writeFile,mkdir,copyFile,readdir,lstat,realpath} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const exec=promisify(execFile),project=fileURLToPath(new URL('../',import.meta.url));
const desktopVersion='0.3.5';
export const desktopSources=Object.freeze([
  'financial-documents/corrections.mjs','financial-documents/correction-rules.mjs','financial-documents/review-ui/corrections.mjs','financial-documents/review-ui/annotation-spans.mjs','financial-documents/check-correction-bundle.py','experiments/financial-review/evaluation-intake-v1/core.mjs','experiments/financial-review/evaluation-intake-v1/schema.mjs',
  'financial-documents/ai-preview.mjs','financial-documents/review-ui/ai-preview.mjs','experiments/financial-review/contract.mjs',
  'financial-documents/local-ai-preview/inference.py','financial-documents/local-ai-preview/runtime/model.py','financial-documents/local-ai-preview/runtime/byte_encoding.py',
  'financial-documents/local-ai-preview/assets/manifest.json','financial-documents/local-ai-preview/assets/char-vocab.json','financial-documents/local-ai-preview/assets/vocab.json','financial-documents/local-ai-preview/assets/model-config.json','financial-documents/local-ai-preview/assets/final-update1100.npz',
  'financial-desktop/settings.mjs','financial-desktop/worker.mjs','financial-desktop/folder-picker.mjs',
  'financial-documents/adapter.mjs','financial-documents/files.mjs','financial-documents/operation.mjs','financial-documents/python.mjs','financial-documents/strict-json.mjs','financial-documents/saved-review.mjs','financial-documents/remote-worker.mjs','financial-documents/worker-lock.mjs','financial-documents/review-viewer.mjs','financial-documents/local-registration.mjs','financial-documents/local-discovery.mjs','financial-documents/request-records.mjs','financial-documents/record-reviews.mjs',
  'financial-documents/review-ui/index.html','financial-documents/review-ui/review.js','financial-documents/review-ui/registration.mjs','financial-documents/review-ui/automatic.mjs','financial-documents/review-ui/recheck-view.mjs','financial-documents/review-ui/request-records.mjs','financial-documents/review-ui/local-review.mjs','financial-documents/review-ui/review.css','financial-documents/review-ui/diana-icon.png',
  'financial-documents/fixtures/fund-a/review.md','financial-documents/fixtures/fund-a/due-diligence.txt','financial-documents/fixtures/fund-a/guideline.json',
  'financial_core/__init__.py','financial_core/schemas.py','financial_core/doc_parser.py','financial_core/deterministic_tools.py','financial_core/state_planner.py','financial_core/interface.py',
  'local-ai/files.mjs','local-ai/provider.mjs','personal-ai/documents/files.mjs','lib/financial-contract.mjs','scripts/init-financial-mobile-demo.mjs'
]);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const minimalEnv=()=>Object.fromEntries(['SystemRoot','WINDIR','SystemDrive','TEMP','TMP'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]));
async function regular(filename){const stat=await lstat(filename);if(!stat.isFile()||stat.isSymbolicLink()||await realpath(filename)!==path.resolve(filename))throw Error('BUILD_INPUT_INVALID');return stat;}
async function existingIcon(){
  // Existing launcher PNG pixels are reused unchanged inside an ICO container.
  const images=await Promise.all(['mdpi','hdpi','xhdpi','xxhdpi','xxxhdpi'].map(async density=>{
    const bytes=await readFile(path.join(project,'android-app/app/src/main/res/mipmap-'+density+'/ic_launcher.png'));
    const width=bytes.readUInt32BE(16);if(bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||width!==bytes.readUInt32BE(20)||width>256)throw Error('ICON_INVALID');return{bytes,width};
  }));
  const header=Buffer.alloc(6+16*images.length);header.writeUInt16LE(1,2);header.writeUInt16LE(images.length,4);let offset=header.length;
  for(const[i,item]of images.entries()){const index=6+16*i;header[index]=item.width%256;header[index+1]=item.width%256;header.writeUInt16LE(1,index+4);header.writeUInt16LE(32,index+6);header.writeUInt32LE(item.bytes.length,index+8);header.writeUInt32LE(offset,index+12);offset+=item.bytes.length;}
  return Buffer.concat([header,...images.map(item=>item.bytes)]);
}
export async function buildDesktop({python,node=process.execPath,outputParent=path.join(project,'.local/financial-desktop-builds'),updateDevPicker=true}={}){
  if(process.platform!=='win32'||process.arch!=='x64')throw Error('WINDOWS_X64_BUILD_REQUIRED');
  await regular(python);await regular(node);
  const nodeVersion=(await exec(node,['-p','process.versions.node'],{env:minimalEnv(),windowsHide:true})).stdout.trim();
  if(nodeVersion!=='24.22.1')throw Error('REVIEWED_NODE_24_22_1_REQUIRED');
  const buildRoot=path.join(outputParent,new Date().toISOString().replace(/[:.]/gu,'-')+'-'+randomUUID().slice(0,8)),root=path.join(buildRoot,'DIANA-PC');
  await mkdir(root,{recursive:true});
  for(const relative of desktopSources){const source=path.join(project,relative);await regular(source);const target=path.join(root,'app',relative);await mkdir(path.dirname(target),{recursive:true});await copyFile(source,target);}
  await writeFile(path.join(root,'app/package.json'),JSON.stringify({name:'diana-financial-desktop',version:desktopVersion,private:true,type:'module'}));
  await mkdir(path.join(root,'LICENSES'));await copyFile(path.join(project,'financial-desktop/README.txt'),path.join(root,'사용방법.txt'));
  await mkdir(path.join(root,'runtime/node'),{recursive:true});await copyFile(node,path.join(root,'runtime/node/node.exe'));
  await copyFile(path.join(project,'financial-desktop/licenses/Node-24.22.1.txt'),path.join(root,'LICENSES/Node.txt'));
  const pythonRoot=path.dirname(python),pythonOut=path.join(root,'runtime/python');await mkdir(pythonOut,{recursive:true});
  for(const file of ['python.exe','python3.dll','python312.dll','vcruntime140.dll','vcruntime140_1.dll']){await regular(path.join(pythonRoot,file));await copyFile(path.join(pythonRoot,file),path.join(pythonOut,file));}
  await copyFile(path.join(pythonRoot,'LICENSE.txt'),path.join(root,'LICENSES/Python.txt'));
  // Standard library only. Never recursively copy site-packages, user settings,
  // training weights, .env, or the dirty repository into the release.
  const zipStdlib="import os,sys,zipfile;root,out=sys.argv[1:];z=zipfile.ZipFile(out,'x',zipfile.ZIP_DEFLATED);excluded={'site-packages','test','tests','__pycache__','idlelib','tkinter','turtledemo','ensurepip','venv'}\nfor current,dirs,files in os.walk(root):\n dirs[:]=sorted(d for d in dirs if d not in excluded and not os.path.islink(os.path.join(current,d)))\n for name in sorted(files):\n  p=os.path.join(current,name)\n  if name.endswith('.py') and not os.path.islink(p):z.write(p,os.path.relpath(p,root))\nz.close()";
  await exec(python,['-I','-B','-c',zipStdlib,path.join(pythonRoot,'Lib'),path.join(pythonOut,'python312.zip')],{env:minimalEnv(),windowsHide:true});
  for(const file of await readdir(path.join(pythonRoot,'DLLs')))if(/\.(?:pyd|dll)$/iu.test(file)){await regular(path.join(pythonRoot,'DLLs',file));await copyFile(path.join(pythonRoot,'DLLs',file),path.join(pythonOut,file));}
  await writeFile(path.join(pythonOut,'python312._pth'),'python312.zip\n.\n');
  // One explicitly reviewed local NumPy wheel, never arbitrary site-packages.
  const numpyBase=path.join(pythonRoot,'Lib/site-packages'),numpyOut=path.join(root,'runtime/numpy');
  async function numpyCopy(relative){const from=path.join(numpyBase,relative),to=path.join(numpyOut,relative);await mkdir(to,{recursive:true});for(const e of await readdir(from,{withFileTypes:true})){if(e.isSymbolicLink())throw Error('NUMPY_LINK');if(e.isDirectory()){if(!['tests','test','__pycache__','include','benchmarks'].includes(e.name))await numpyCopy(path.join(relative,e.name));}else if(/\.(py|pyd|dll)$/iu.test(e.name)){await regular(path.join(from,e.name));await copyFile(path.join(from,e.name),path.join(to,e.name));}}}
  await numpyCopy('numpy');await numpyCopy('numpy.libs');
  await copyFile(path.join(numpyBase,'numpy-2.3.5.dist-info/LICENSE.txt'),path.join(root,'LICENSES/NumPy.txt'));
  const numpyVersion=(await exec(path.join(pythonOut,'python.exe'),['-I','-B','-c','import sys;sys.path.insert(0,sys.argv[1]);import numpy;print(numpy.__version__)',numpyOut],{env:minimalEnv(),windowsHide:true})).stdout.trim();
  if(numpyVersion!=='2.3.5')throw Error('NUMPY_VERSION_MISMATCH');
  const version=(await exec(path.join(pythonOut,'python.exe'),['-I','-B','-c','import sys,unicodedata,difflib,hashlib,json;print(sys.version.split()[0])'],{env:minimalEnv(),windowsHide:true})).stdout.trim();
  if(!version.startsWith('3.12.'))throw Error('PYTHON_312_REQUIRED');
  const icon=path.join(buildRoot,'diana.ico');await writeFile(icon,await existingIcon());
  const compiler=path.join(process.env.WINDIR,'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  await exec(compiler,['/nologo','/target:winexe','/platform:x64','/optimize+','/utf8output','/win32icon:'+icon,
    '/resource:'+icon+',diana.ico','/resource:'+path.join(project,'financial-documents/review-ui/diana-icon.png')+',diana.png',
    '/reference:System.Windows.Forms.dll','/reference:System.Drawing.dll','/reference:System.Web.Extensions.dll',
    '/out:'+path.join(root,'DIANA.exe'),path.join(project,'financial-desktop/native/DesktopLauncher.cs')],{windowsHide:true,env:minimalEnv(),maxBuffer:20000});
  const picker=path.join(root,'runtime/native/DIANA-FolderPicker.exe');await mkdir(path.dirname(picker),{recursive:true});
  await exec(compiler,['/nologo','/target:winexe','/platform:x64','/optimize+','/utf8output','/win32icon:'+icon,'/reference:System.Windows.Forms.dll','/reference:System.Drawing.dll','/reference:System.Web.Extensions.dll','/out:'+picker,path.join(project,'financial-desktop/native/FolderPicker.cs')],{windowsHide:true,env:minimalEnv(),maxBuffer:20000});
  if(updateDevPicker){const devPicker=path.join(project,'.local/financial-desktop-tools/DIANA-FolderPicker.exe');await mkdir(path.dirname(devPicker),{recursive:true});await copyFile(picker,devPicker);}
  const entries=[];
  async function walk(directory){for(const item of await readdir(directory,{withFileTypes:true})){const full=path.join(directory,item.name);if(item.isDirectory())await walk(full);else{await regular(full);const bytes=await readFile(full);entries.push({path:path.relative(root,full).replaceAll('\\','/'),bytes:bytes.length,sha256:hash(bytes)});}}}
  await walk(root);entries.sort((a,b)=>a.path.localeCompare(b.path));
  const inputPaths=[...desktopSources,'scripts/build-financial-desktop.mjs','financial-desktop/native/DesktopLauncher.cs','financial-desktop/native/FolderPicker.cs','financial-desktop/README.txt','financial-desktop/licenses/Node-24.22.1.txt',...['mdpi','hdpi','xhdpi','xxhdpi','xxxhdpi'].map(d=>'android-app/app/src/main/res/mipmap-'+d+'/ic_launcher.png')];
  const buildInputs=await Promise.all(inputPaths.map(async relative=>({path:relative,sha256:hash(await readFile(path.join(project,relative)))})));
  const manifest={schema_version:1,product:'DIANA PC',version:desktopVersion,platform:'win-x64',node:nodeVersion,python:version,sources:desktopSources,build_inputs:buildInputs,files:entries};
  await writeFile(path.join(root,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  // Archive only the manifest whitelist captured BEFORE any personalized profile.
  const release=path.join(buildRoot,'DIANA-PC-'+desktopVersion+'-win-x64.zip');
  const zipRelease="import os,sys,json,zipfile;root,out=sys.argv[1:];manifest=json.load(open(os.path.join(root,'manifest.json'),encoding='utf-8'));z=zipfile.ZipFile(out,'x',zipfile.ZIP_DEFLATED)\nfor item in manifest['files']+[{'path':'manifest.json'}]:z.write(os.path.join(root,item['path']),'DIANA-PC/'+item['path'])\nz.close()";
  await exec(python,['-I','-B','-c',zipRelease,root,release],{env:minimalEnv(),windowsHide:true,timeout:120000});
  const result={root,release,releaseSha256:hash(await readFile(release)),releaseBytes:(await lstat(release)).size,files:entries.length,python:version};
  await writeFile(path.join(buildRoot,'build-result.json'),JSON.stringify(result,null,2));return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const args=process.argv.slice(2);if(args.length!==2||args[0]!=='--python')throw Error('Usage: node scripts/build-financial-desktop.mjs --python ABSOLUTE_PYTHON_EXE');
  console.log(JSON.stringify(await buildDesktop({python:path.resolve(args[1])}),null,2));
}
