import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {mkdir,writeFile,readFile,copyFile,lstat,realpath,rename} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {loadDesktopSettings} from './settings.mjs';

// Explicit, offline synthetic workspace. This is not a remote approval service.
export const demoRequest='검토 대상은 옅은모래입니다. 적용 지침은 넓은안개입니다. 근거 자료는 늦은바위입니다. 검토해 주세요.';
const names=['이른바위','옅은모래','넓은안개','늦은바위'];
const ids=['d25ef5d15a2befe1','da9b494f19bde994','db7e132e09ecf1e6','db8be71d61da99cd'];
const files=['extra.txt','review.md','guideline.json','due-diligence.txt'];
const hash=b=>createHash('sha256').update(b).digest('hex');
const error=()=>{throw Object.assign(Error('DESKTOP_SETTINGS_INVALID'),{code:'DESKTOP_SETTINGS_INVALID'});};
export const demoProfile=root=>path.join(root,'.local','가상 체험','desktop.json');
export async function canonicalDemoRoot(root){
 root=path.resolve(root);let current=path.parse(root).root;
 for(const part of root.slice(current.length).split(path.sep).filter(Boolean)){current=path.join(current,part);const s=await lstat(current);if(!s.isDirectory()||s.isSymbolicLink())error();}
 const physical=await realpath(root);
 if(process.platform==='win32'?physical.toLowerCase()!==root.toLowerCase():physical!==root)error();
 return physical;
}
const json=async(p,v)=>writeFile(p,JSON.stringify(v,null,2),{flag:'wx',mode:0o600});
async function regular(p){const s=await lstat(p);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||await realpath(p)!==path.resolve(p))error();return readFile(p);}

export async function prepareDemo(root){
 root=await canonicalDemoRoot(root);const base=path.dirname(demoProfile(root));
 let exists=false;try{await lstat(base);exists=true;}catch(e){if(e.code!=='ENOENT')throw e;}
 if(exists){await loadDemo(root);return demoProfile(root);}
 if(await realpath(root)!==root||(await lstat(root)).isSymbolicLink())error();
 try{const parent=path.dirname(base),s=await lstat(parent);if(!s.isDirectory()||s.isSymbolicLink()||await realpath(parent)!==parent)error();}catch(e){if(e.code!=='ENOENT')throw e;}
 await mkdir(path.dirname(base),{recursive:true});
 // No partial workspace can be mistaken for a completed first run.
 const staging=base+'-준비-'+randomUUID();await mkdir(staging);
 for(const f of ['input','output','generic'])await mkdir(path.join(staging,f));
 const fixtures=fileURLToPath(new URL('../financial-documents/fixtures/fund-a/',import.meta.url));
 for(const f of files.slice(1))await copyFile(path.join(fixtures,f),path.join(staging,'input',f));
 await writeFile(path.join(staging,'input','extra.txt'),'가상 체험용 참고 문서입니다. 실제 업무 자료가 아닙니다.\n',{flag:'wx'});
 const guideline=JSON.parse(await readFile(path.join(staging,'input','guideline.json'),'utf8'));guideline.id=ids[2];for(const r of guideline.rules)r.source_ids=[ids[3]];
 await writeFile(path.join(staging,'input','guideline.json'),JSON.stringify(guideline,null,2));
 const documents=ids.map((id,i)=>({id,display_name:names[i],relativePath:files[i],rootIndex:0,version:'1',classification:'synthetic',read_roles:['analyst']}));
 const core={schema_version:1,principal:'synthetic-local-demo',role:'analyst',readRoots:[path.join(base,'input')],outputRoot:path.join(base,'output'),python:path.join(root,'runtime/python/python.exe'),write_roles:['analyst'],approval_ttl_ms:300000,documents};
 const order=[1,3,2,0],tasks=order.map((_,i)=>({id:randomUUID(),label:i===0?'가상 문서 보완 체험':'가상 후보 역할 허용 '+i,actions:['checklist_review'],formats:['md'],target_doc:ids[order[i]],source_ids:[ids[order[(i+1)%4]]],guideline_id:ids[order[(i+2)%4]],item_ids:[]}));
 const worker={schema_version:1,coreConfig:path.join(base,'core.json'),stateDir:path.join(base,'state'),tasks};
 const settings={schema_version:1,configPath:path.join(base,'worker.json'),envFile:path.join(base,'offline.env'),documentRoot:path.join(base,'generic'),apiBaseUrl:'http://127.0.0.1',autoOpen:true};
 await json(path.join(staging,'core.json'),core);await json(path.join(staging,'worker.json'),worker);await json(path.join(staging,'desktop.json'),settings);
 await writeFile(path.join(staging,'offline.env'),'# 가상 체험 전용. 서버 연결과 인증키를 사용하지 않습니다.\n',{flag:'wx'});
 await writeFile(path.join(staging,'예제 요청.txt'),demoRequest+'\n',{flag:'wx'});
 const protectedFiles=['core.json','worker.json','offline.env'];
 await json(path.join(staging,'demo-manifest.json'),{schema_version:1,synthetic_only:true,configHashes:Object.fromEntries(await Promise.all(protectedFiles.map(async f=>[f,hash(await readFile(path.join(staging,f)))]))),sourceHashes:Object.fromEntries(await Promise.all(files.map(async f=>[f,hash(await readFile(path.join(staging,'input',f)))])))});
 await rename(staging,base);await loadDemo(root);return demoProfile(root);
}
export async function loadDemo(root){
 root=await canonicalDemoRoot(root);const profile=demoProfile(root),base=path.dirname(profile),settings=await loadDesktopSettings(profile);
 const m=JSON.parse(await regular(path.join(base,'demo-manifest.json')));
 if(m.schema_version!==1||m.synthetic_only!==true)error();
 for(const f of ['core.json','worker.json','offline.env'])if(hash(await regular(path.join(base,f)))!==m.configHashes?.[f])error();
 if(settings.configPath!==path.join(base,'worker.json')||settings.envFile!==path.join(base,'offline.env')||settings.documentRoot!==path.join(base,'generic')||settings.apiBaseUrl!=='http://127.0.0.1')error();
 const w=JSON.parse(await regular(settings.configPath));
 if(w.coreConfig!==path.join(base,'core.json')||w.stateDir!==path.join(base,'state'))error();
 const c=JSON.parse(await regular(w.coreConfig));
 if(c.principal!=='synthetic-local-demo'||JSON.stringify(c.readRoots)!==JSON.stringify([path.join(base,'input')])||c.outputRoot!==path.join(base,'output'))error();
 // All ordinary core permissions, locks and approval checks still run.
 const api=async(route)=>{if(route==='/api/agent/financial/register')return{ok:true};if(route==='/api/agent/financial/next')return{job:null};throw Object.assign(Error('DEMO_REMOTE_DISABLED'),{code:'DEMO_REMOTE_DISABLED'});};
 const documents=await Promise.all(names.map(async(name,i)=>{const bytes=await regular(path.join(base,'input',files[i]));if(bytes.length>100000)error();return{name,file:files[i],content:bytes.toString('utf8')};}));
 return{settings,api,help:{request:demoRequest,selection:{target_doc:ids[1],source_ids:[ids[3]],guideline_id:ids[2]},folder:base,documents,note:'가상 자료 · 이 PC 전용 · 원격 작업 수신 없음. 예제 입력은 선택 제안이나 업무 승인이 아닙니다.'}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const root=process.argv[2];if(process.argv.length!==3||!path.isAbsolute(root))throw Error('DEMO_ROOT_REQUIRED');
 prepareDemo(root).then(()=>process.stdout.write('DEMO_READY\n')).catch(()=>{process.stderr.write('DEMO_PREPARE_FAILED\n');process.exitCode=1;});
}
