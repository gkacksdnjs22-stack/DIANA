import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readFile,readdir,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {desktopVersionInfo as expected,resolveDesktopVersion} from '../financial-desktop/version.mjs';
import {nativeVersionSource,renderDesktopReadme} from './desktop-version-generation.mjs';

const project=fileURLToPath(new URL('../',import.meta.url)),exec=promisify(execFile);
const hash=b=>createHash('sha256').update(b).digest('hex');
const equal=(actual,wanted,label)=>{if(JSON.stringify(actual)!==JSON.stringify(wanted))throw Error('WINDOWS_VERSION_MISMATCH: '+label);};
export function checkExeMetadata(meta,v=expected){
  equal(meta.fileVersion,v.numericVersion,'EXE FileVersion');
  equal(meta.assemblyVersion,v.numericVersion,'EXE AssemblyVersion');
  equal(meta.productVersion,v.version,'EXE ProductVersion');
  equal(meta.informationalVersion,v.version,'EXE InformationalVersion');
  for(const [key,value]of Object.entries({ProductVersion:v.version,NumericVersion:v.numericVersion,MainTitle:v.mainTitle,SettingsTitle:v.settingsTitle,DemoSettingsTitle:v.demoSettingsTitle,PickerTitle:v.pickerTitle}))equal(meta.constants?.[key],value,'EXE '+key);
}
export async function inspectExe(exe){
  const ps=path.join(process.env.WINDIR,'System32/WindowsPowerShell/v1.0/powershell.exe');
  const result=await exec(ps,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(project,'scripts/inspect-desktop-version.ps1'),'-ExePath',exe],{windowsHide:true,encoding:'utf8',maxBuffer:100000});
  return JSON.parse(result.stdout.replace(/^\uFEFF/u,''));
}
export async function checkDesktopSources(){
  const sources=await Promise.all(['financial-desktop/native/DesktopLauncher.cs','financial-desktop/native/FolderPicker.cs','financial-desktop/worker.mjs','scripts/build-financial-desktop.mjs','financial-desktop/README.txt'].map(p=>readFile(path.join(project,p),'utf8')));
  const [launcher, picker, , builder] = sources;
  if (!launcher.includes('BuildVersion.MainTitle') || !picker.includes('BuildVersion.PickerTitle') ||
      !builder.includes('nativeVersionSource()')) throw Error('WINDOWS_VERSION_SOURCE');

  renderDesktopReadme(sources[4]);
}
export async function checkDesktopBundle({root,archive,python,checkInputs=true}){
  await checkDesktopSources();
  const read=p=>readFile(path.join(root,p)),json=async p=>JSON.parse(await read(p));
  const manifest=await json('manifest.json');
  equal(manifest.version,expected.version,'manifest');
  equal(manifest.windowsVersion,expected,'manifest Windows metadata');
  equal((await json('app/package.json')).version,expected.version,'package');
  equal(resolveDesktopVersion(await json('app/financial-desktop/version.json')),expected,'packaged version source');
  equal(await read('app/financial-desktop/version.json'),await readFile(path.join(project,'financial-desktop/version.json')),'version source');
  equal((await read('runtime/native/BuildVersion.g.cs')).toString(),nativeVersionSource(),'generated C#');
  equal((await read('사용방법.txt')).toString(),renderDesktopReadme(await readFile(path.join(project,'financial-desktop/README.txt'),'utf8')),'README');
  const paths=new Set();
  for(const item of manifest.files){
    if(!/^[^\\:]+$/u.test(item.path)||item.path.startsWith('/')||item.path.split('/').some(s=>s==='..'||s==='.')||paths.has(item.path))throw Error('WINDOWS_MANIFEST_PATH');
    if(/(^|\/)(?:\.env(?:\.|$)|desktop\.json$|worker\.json$|core\.json$|tests?\/|fixture-version|.*\.(?:jks|keystore)$)/iu.test(item.path))throw Error('WINDOWS_PRIVATE_FILE');
    paths.add(item.path);
    const bytes=await read(item.path);equal(bytes.length,item.bytes,item.path+' size');equal(hash(bytes),item.sha256,item.path+' hash');
  }
  const found=[];
  async function walk(dir){for(const e of await readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isSymbolicLink())throw Error('WINDOWS_BUNDLE_LINK');if(e.isDirectory())await walk(p);else if(!(await lstat(p)).isFile())throw Error('WINDOWS_BUNDLE_FILE');else found.push(path.relative(root,p).replaceAll('\\','/'));}}
  await walk(root);equal(found.sort(),[...paths,'manifest.json'].sort(),'file whitelist');
  for(const required of ['DIANA.exe','runtime/native/DIANA-FolderPicker.exe','runtime/node/node.exe','runtime/python/python.exe','runtime/python/python312.zip','runtime/numpy/numpy/__init__.py','LICENSES/Node.txt','LICENSES/Python.txt','LICENSES/NumPy.txt','app/financial-documents/document_plan.py','app/financial-documents/office_layout.py','app/financial-desktop/paired-host.mjs'])if(!paths.has(required))throw Error('WINDOWS_REQUIRED_FILE: '+required);
  if(checkInputs)for(const item of manifest.build_inputs)equal(hash(await readFile(path.join(project,item.path))),item.sha256,'build input '+item.path);
  const exe=await inspectExe(path.join(root,'DIANA.exe'));checkExeMetadata(exe);
  const picker=await inspectExe(path.join(root,'runtime/native/DIANA-FolderPicker.exe'));checkExeMetadata(picker);
  if(archive){
    equal(path.basename(archive),expected.archiveName,'ZIP name');
    if(!python)throw Error('WINDOWS_ZIP_CHECK_PYTHON_REQUIRED');
    // Read every archive member and compare actual bytes with the verified tree.
    const script="import os,sys,json,zipfile;root,archive=sys.argv[1:];m=json.load(open(os.path.join(root,'manifest.json'),encoding='utf-8'));wanted=['DIANA-PC/'+x['path'] for x in m['files']]+['DIANA-PC/manifest.json']\nwith zipfile.ZipFile(archive) as z:\n assert len(z.namelist())==len(set(z.namelist())) and sorted(z.namelist())==sorted(wanted),'ZIP_WHITELIST'\n for name in wanted:\n  with open(os.path.join(root,name[len('DIANA-PC/'):]),'rb') as f: assert z.read(name)==f.read(),'ZIP_CONTENT: '+name\nprint('ZIP_ALL_BYTES_MATCH')";
    const result=await exec(python,['-I','-B','-c',script,root,archive],{windowsHide:true,maxBuffer:10000});
    if(result.stdout.trim()!=='ZIP_ALL_BYTES_MATCH')throw Error('WINDOWS_ZIP_CHECK_FAILED');
  }
  return {passed:true,version:expected,exe,picker,files:paths.size,archive:archive??null,archiveSha256:archive?hash(await readFile(archive)):null,nativeWindowObserved:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const [root,archive,python]=process.argv.slice(2);if(!root)throw Error('Usage: node scripts/check-desktop-version.mjs ROOT [ZIP PYTHON]');
  console.log(JSON.stringify(await checkDesktopBundle({root,archive,python}),null,2));
}
