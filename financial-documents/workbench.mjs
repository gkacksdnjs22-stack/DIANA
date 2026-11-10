import {containsSecret} from './security/content.mjs';
import {discover,scope,sourceQuery,groupsFor,reportOutputStart,fileSendSuffix,fileSendFormatSuffix,fileSendPrefix} from '../financial-desktop/source-roots.mjs';
import {parseLocalDocument} from '../personal-ai/documents/parser.mjs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,readdir,lstat,realpath,open,unlink,stat} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {Conversation} from './conversation.mjs';
import {checkedDirectory} from '../personal-ai/documents/files.mjs';
const sum=b=>createHash('sha256').update(b).digest('hex'),uuid=s=>/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(s),ext=n=>path.extname(n).slice(1).toLowerCase(),supported=['md','txt','docx','pptx','json','pdf','ppt'];
const readable=[...supported.filter(f=>f!=='ppt'),'csv','tsv','pdf','hwp','hwpx','hwpml','xls','xlsx'];
const plainOriginals=['txt','md','json','csv','tsv'];
const canSendOriginal=name=>ext(name)==='pdf'||plainOriginals.includes(ext(name));
const requireThat=(v,s)=>{if(!v)throw Error(s)},safeError=e=>/[가-힣]/u.test(e.message)&&!/[\\/:]/.test(e.message)?e.message:'파일을 읽거나 저장하지 못했습니다. 파일과 권한을 확인하세요.';
const fileName=n=>typeof n==='string'&&n.length>0&&n.length<180&&!/[\\/:<>|?*"\x00-\x1f]/u.test(n)&&!n.startsWith('.')&&!/[. ]$/.test(n);
export async function bytes(p,root,limit=8_000_000,stamp){await checkedDirectory(root);requireThat(path.dirname(p)===root&&fileName(path.basename(p)),'허용 폴더 안의 일반 파일만 읽을 수 있습니다.');const a=await lstat(p,{bigint:true});requireThat(!stamp||[a.dev,a.ino,a.size,a.mtimeNs].join('-')===stamp,'찾은 뒤 원문이 변경되었습니다. 다시 검색하세요.');requireThat(a.isFile()&&!a.isSymbolicLink()&&a.nlink===1n&&a.size>0n&&a.size<=BigInt(limit)&&await realpath(p)===p,'비어 있거나 너무 크거나 연결된 파일입니다.');const h=await open(p,'r');try{const b=await h.stat({bigint:true});requireThat(b.ino===a.ino&&b.dev===a.dev&&b.size===a.size&&b.mtimeNs===a.mtimeNs,'파일이 바뀌었습니다.');const buf=Buffer.alloc(Number(a.size));let n=0;while(n<buf.length){const r=await h.read(buf,n,buf.length-n,n);if(!r.bytesRead)break;n+=r.bytesRead;}const c=await lstat(p,{bigint:true});requireThat(c.ino===b.ino&&c.dev===b.dev&&c.mtimeNs===b.mtimeNs&&c.size===b.size&&c.nlink===1n&&n===buf.length&&await realpath(p)===p,'파일이 바뀌었습니다.');await checkedDirectory(root);return buf;}finally{await h.close();}}
export function route(text){const names=[...text.matchAll(/(?:["“]([^"”]+?\.[a-z0-9]{1,6})["”]|([^\s"'“”]+\.[a-z0-9]{1,6})(?=\s|[,，]|$|을|를|와|과|로|에))/giu)].map(m=>m[1]||m[2]);let q=text;for(const n of names)q=q.replaceAll(n,' ');const body=q.match(/(?:내용|본문)\s*[:：]\s*([\s\S]+)/u)?.[1]?.trim();const cmd=q.split(/(?:내용|본문)\s*[:：]/u)[0];const outputClause=cmd.split(/요약|비교|종합|읽고|읽어서|찾아서/u).at(-1);
const sending=fileSendSuffix.test(cmd),sendPrefix=sending?fileSendPrefix(cmd):'';
const sendFormat=sendPrefix.match(fileSendFormatSuffix)?.[1]?.toLowerCase();
const recentResult=sending&&!names.length&&/^(?:(?:최근|방금|그)\s*(?:만든\s*)?)?(?:작업\s*)?(?:결과(?:\s*파일)?|수정본|그\s*파일|그\s*문서)(?:을|를)?$/u.test(sendPrefix.replace(fileSendFormatSuffix,'').trim());
const fmt=(sendFormat==='텍스트'?'txt':sendFormat==='마크다운'?'md':sendFormat)||outputClause.match(/(?:^|[^a-z])(pptx?|docx|json|txt|md|pdf|hwp[x]?|xlsx?|html|csv|png|jpe?g|rtf|odt|pages|keynote)(?:[^a-z]|$)/iu)?.[1]?.toLowerCase()||(outputClause.includes('마크다운')?'md':outputClause.includes('텍스트')?'txt':null);
let kind=/발표\s*(?:자료|파일|문서|슬라이드)?(?:를|을|로|으로)?\s*(?:만들|작성|제작)|(?:pptx?|슬라이드).{0,12}(?:만들|작성|제작)/iu.test(cmd)?'slides':/비교|종합|수치.{0,12}변화/u.test(cmd)?'compare':/요약|정리해|정리한/u.test(cmd)?'summary':/새\s*(?:문서|파일|보고서|이력서|포트폴리오|메모)/u.test(cmd)?'create':/변환|바꿔/u.test(cmd)?(fmt?'convert':'edit'):/수정|고쳐|교체/u.test(cmd)?'edit':/찾아|찾기|읽어/u.test(cmd)?'read':null;
if(!kind&&reportOutputStart(cmd)!==null)kind='summary';if(kind==='slides'&&body&&!names.length&&/새|파일 없이|첨부 없이/u.test(cmd))kind='create';
if(sending&&(recentResult||!kind||kind==='read'))kind=sendFormat?'convert':'send';
const change=text.match(/["“']([^"”']+)["”'](?:을|를)?\s*["“']([^"”']*)["”']/u)?.slice(1,3);
const title=cmd.match(/제목\s*[:：]\s*([^,;\n]+)/u)?.[1]?.trim();
const term=text.match(/[“"]([^“”"]{1,60})[”"](?:이|가|을|를)?\s*(?:들어간|포함된|언급된|담긴)/u)?.[1];return {kind,term,recentResult,all:/모두|전부|전체/.test(cmd),format:fmt||(['slides','summary','compare','create'].includes(kind)?'pdf':kind==='read'?'txt':'md'),names,title,body,change,unsafe:/하지\s*마|하지\s*말|하지\s*않|삭제|덮어|말고|가능한가|어떻게|알려줘|\?/.test(cmd),multi:/여러|모두|전체|전부|두\s*(?:문서|자료|파일)|비교|종합/.test(cmd)};}
function engine(python,req,signal){return new Promise((resolve,reject)=>{const c=spawn(python,['-I','-B',fileURLToPath(new URL('workbench-content.py',import.meta.url))],{windowsHide:true,stdio:['pipe','pipe','pipe'],signal,env:{SystemRoot:process.env.SystemRoot,PYTHONIOENCODING:'utf-8'}}),buf=[];let size=0;const t=setTimeout(()=>c.kill(),35000);c.stdout.on('data',b=>{size+=b.length;if(size>12_000_000)c.kill();else buf.push(b);});c.stderr.resume();c.stdin.on('error',()=>{});c.on('error',reject);c.on('close',code=>{clearTimeout(t);try{if(code!==0)throw Error('문서 도구가 작업을 마치지 못했습니다.');const v=JSON.parse(Buffer.concat(buf));if(v.error)throw Error(v.error);resolve(v);}catch(e){reject(e);}});c.stdin.end(JSON.stringify(req).replace(/[^\x00-\x7f]/g,ch=>'\\u'+ch.charCodeAt(0).toString(16).padStart(4,'0')));});}
export async function trimDiagnostics(dir,config,now=Date.now()){await checkedDirectory(dir);const rows=[];for(const name of await readdir(dir)){if(!/^d-[0-9]+-[0-9a-f-]{36}\.log$/.test(name))continue;const p=path.join(dir,name),s=await lstat(p);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1)continue;rows.push({p,b:s.size,t:Number(name.split('-')[1])});}rows.sort((a,b)=>b.t-a.t);let kept=0;for(const r of rows){if(now-r.t>config.days*86400000||kept+r.b>config.bytes)await unlink(r.p);else kept+=r.b;}}
export class Workbench{
static async open({base,pick,registry,records,python=base.core.python}){const w=new Workbench();w.base=base;w.python=python;w.pick=pick;w.old=await Conversation.open({base,registry,records});w.dir=base.config.stateDir+'.workbench';for(const p of [w.dir,...['uploads','diagnostics'].map(n=>path.join(w.dir,n))]){await mkdir(p,{recursive:true});await checkedDirectory(p);}w.db=new DatabaseSync(path.join(w.dir,'jobs.sqlite'));w.db.exec("PRAGMA journal_mode=DELETE; PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY,v TEXT); CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,status TEXT,spec TEXT,error TEXT,preview TEXT,data BLOB,hash TEXT,refs TEXT,nonce TEXT);CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY,name TEXT,physical TEXT,fmt TEXT,hash TEXT,size INTEGER,shared INTEGER);CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY,name TEXT,path TEXT,selected INTEGER);");if(!w.db.prepare('PRAGMA table_info(jobs)').all().some(column=>column.name==='request_device'))w.db.exec('ALTER TABLE jobs ADD COLUMN request_device TEXT');w.running=new Map();w.db.exec("UPDATE jobs SET status='failed',error='작업 중 연결이 끊겼습니다. 다시 시도하세요.' WHERE status='reading'");const cfg=path.join(w.dir,'diagnostics.json');try{await writeFile(cfg,JSON.stringify({bytes:20*1024*1024,days:30}),{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;}w.logConfig=JSON.parse(await readFile(cfg,'utf8'));requireThat(Number.isSafeInteger(w.logConfig.bytes)&&w.logConfig.bytes>0&&Number.isFinite(w.logConfig.days)&&w.logConfig.days>0,'진단 보관 설정을 확인하세요.');await trimDiagnostics(path.join(w.dir,'diagnostics'),w.logConfig);return w;}
authorize(t){return this.old.authorize(t);}
get(k){return this.db.prepare('SELECT v FROM settings WHERE k=?').get(k)?.v;}
set(k,v){this.db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run(k,v);}
row(id){return this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id);}
async diag(id){const dir=path.join(this.dir,'diagnostics');await writeFile(path.join(dir,'d-'+Date.now()+'-'+randomUUID()+'.log'),JSON.stringify({id,event:'failed',at:Date.now()}),{flag:'wx'});await trimDiagnostics(dir,this.logConfig);}
async list(request=''){const all=this.db.prepare('SELECT id,name,path,1 AS attached FROM attachments WHERE selected=1 ORDER BY rowid').all();if(this.searchConfig){const c=this.searchConfig();return [...all,...await discover(c.roots,c.excluded,request)];}const root=this.get('folder');if(root){await checkedDirectory(root);let n=0;for(const e of await readdir(root,{withFileTypes:true})){if(!e.isFile()||!fileName(e.name)||!supported.includes(ext(e.name)))continue;requireThat(++n<=1000,'문서가 너무 많습니다. 더 작은 작업 폴더를 허용하세요.');all.push({id:sum(root+'\0'+e.name),name:e.name,path:path.join(root,e.name)});}}return all;}
async view(role,offset=0){const old=await this.old.view(role);const files=this.db.prepare('SELECT id,name,fmt AS format,hash AS sha256,size AS bytes,shared FROM files '+(role==='owner'?'':'WHERE shared=1 ')+' ORDER BY rowid DESC LIMIT 21 OFFSET ?').all(offset);const recent=old.messages.at(-1);return {role,folder:!!this.get('folder'),files:files.slice(0,20).map(f=>({...f,canDownload:true})),more:files.length>20,legacyFiles:old.files.filter(f=>f.canDownload).reverse().slice(offset,offset+20),jobs:this.db.prepare("SELECT id,status,error,preview,nonce FROM jobs WHERE status NOT IN ('done','cancelled') ORDER BY rowid DESC").all().map(j=>({...j,choices:j.status==='choose'?JSON.parse(j.preview):undefined,preview:j.status==='approval'?j.preview:undefined})),legacy:{pending:old.pending,awaiting:old.awaiting,suggestion:old.suggestion,documents:old.awaiting||old.draft?.stage==='materials'?old.documents:[],draft:old.draft?{stage:old.draft.stage}:null,uncertain:old.uncertain,question:old.awaiting||old.draft&&['title','investment','memo','materials'].includes(old.draft.stage)?recent?.text:null,review:old.review?.review?.items||old.review?.items||null}};}
invalidate(except=''){for(const [id,controller] of this.running)if(id!==except)controller.abort();this.db.prepare("UPDATE jobs SET status='cancelled',spec=NULL,preview=NULL,data=NULL,refs=NULL,nonce=NULL,error=NULL WHERE status IN ('reading','choose','question','approval') AND id<>?").run(except);}
async resolveSources(s,j,selection,signal){
 if(s.useLast){
  const f=this.db.prepare('SELECT * FROM files WHERE id=?').get(s.useLast);
  requireThat(f,'최근 결과를 찾지 못했습니다.');
  return [{id:f.id,name:f.name,path:path.join(this.fileDir(f.id),f.physical)}];
 }
 const config=this.searchConfig?.(), where=config?scope(config.roots,s.request):{query:s.request};
 // With an explicit input filename, replacement text cannot become a search term.
 const q=s.kind==='edit'&&s.change&&s.names.length===1
  ?sourceQuery('"'+s.names[0]+'"'):sourceQuery(where.query);
 const fileDelivery=!s.all&&fileSendSuffix.test(s.request)&&['send','convert'].includes(s.kind);
 const canUseFile=fileDelivery?f=>s.kind==='send'?canSendOriginal(f.name):readable.includes(ext(f.name)):undefined;
 let all=this.db.prepare('SELECT id,name,path,1 AS attached FROM attachments WHERE selected=1 ORDER BY rowid').all();
 const referent=q.terms.length===0||q.terms.every(t=>/^(?:(?:첨부한|이|그|두|해당|선택한|여러)\s*)?(?:자료|문서|파일)(?:들)?$/.test(t));
 if(s.kind==='send')requireThat(q.terms.length===1&&!referent&&!q.quarters&&!s.all,'보낼 파일 이름을 한 개 알려 주세요.');
 const attachmentOnly=/^(?:첨부한|첨부된)\s/u.test(where.query);
 if(attachmentOnly&&!all.length)throw Error('현재 요청에 지정한 첨부 자료가 없습니다.');
 if(!attachmentOnly&&(where.named||!all.length||!referent)){
  if(config){
   const disk=await discover(config.roots,config.excluded,s.request,{signal,exactQuery:fileDelivery?q:undefined,canUseFile,allowPartial:s.kind==='send'});
   all=where.named?disk:[...all,...disk];
  }
  else all=await this.list(s.request);
 }
 signal.throwIfAborted();
 const groups=groupsFor(all,q,s.all,canUseFile);
 const cache=new Map();
 for(const g of groups){
  if(q.content){
   requireThat(g.hits.length<=35,'본문 검색 후보가 35개를 넘었습니다. 파일 이름이나 폴더를 좁혀 주세요.');
   const matches=[];
   for(const f of g.hits){
    signal.throwIfAborted();
    if(!cache.has(f.id)){
     requireThat(cache.size<35,'본문 검색 한도에 도달했습니다. 이름이나 위치를 좁혀 주세요.');
     const {doc}=await this.loadSource(f,signal);
     const r=await engine(this.python,{kind:'convert',format:'txt',request:'',docs:[doc]},signal);
     requireThat(!containsSecret(r.preview),'인증 정보가 포함된 자료는 본문 검색에 사용할 수 없습니다.');
     cache.set(f.id,r.preview.normalize('NFKC').toLowerCase().includes(q.content.normalize('NFKC').toLowerCase()));
    }
    if(cache.get(f.id))matches.push(f);
   }
   requireThat(matches.length,'지정한 표현을 본문에서 찾지 못했습니다.');g.hits=matches;
  }
  if(q.latest&&g.hits.length>1){
   requireThat(g.hits.every(f=>Number.isFinite(f.mtime)),'최신 자료를 고르려면 PC 검색 위치를 지정하세요.');
   const newest=Math.max(...g.hits.map(f=>f.mtime));g.hits=g.hits.filter(f=>f.mtime===newest);
  }
 }
 const choices=[...new Map(groups.flatMap(g=>g.hits.map(f=>[f.id,f]))).values()];
 requireThat(choices.length<=120,'선택 후보가 많습니다. 이름이나 위치를 좁혀 주세요.');
 const ambiguous=groups.some(g=>!g.all&&g.hits.length>1);
 if(selection){
  const previous=new Map(JSON.parse(j.preview).map(x=>[x.id,x.stamp]));
  requireThat(selection.length&&selection.every(id=>choices.some(f=>f.id===id&&previous.has(id)&&previous.get(id)===(f.stamp||''))),'선택한 자료가 바뀌었습니다. 다시 검색하세요.');
  const picked=new Set(selection);
  requireThat(picked.size>=groups.length,'서로 다른 원천 자료를 확인하세요.');
  requireThat(groups.every(g=>g.hits.filter(f=>picked.has(f.id)).length===(g.all?g.hits.length:1)),'요청한 각 자료에 맞는 파일을 하나씩 확인하세요.');
  return choices.filter(f=>picked.has(f.id));
 }
 if(ambiguous){
  const items=choices.map(f=>({id:f.id,name:f.name,location:path.dirname(f.path),stamp:f.stamp||'',modified:f.mtime===undefined?'':new Date(f.mtime).toLocaleString('ko-KR'),group:groups.filter(g=>g.hits.some(x=>x.id===f.id)).map(g=>g.label).join(', ')}));
  signal.throwIfAborted();this.db.prepare("UPDATE jobs SET status='choose',preview=? WHERE id=? AND status='reading'").run(JSON.stringify(items),j.id);
  return null;
 }
 requireThat(choices.length>=groups.length,'서로 다른 원천 자료를 구별할 수 없습니다. 이름을 더 구체적으로 입력하세요.');
 return choices;
}
async loadSource(f,signal){
 const extension=ext(f.name);
 requireThat(readable.includes(extension),'파일을 찾았으나 내용을 읽는 기능이 미지원입니다. '+f.name);
 let b;
 try{b=await bytes(f.path,path.dirname(f.path),8_000_000,f.stamp);}
 catch(e){if(e.code==='ENOENT')throw Error('찾은 파일이 삭제되었거나 이동했습니다.');if(['EPERM','EACCES','EBUSY'].includes(e.code))throw Error('파일을 찾았으나 읽기 권한이 없거나 다른 앱에서 사용 중입니다.');throw e;}
 signal.throwIfAborted();
 const doc={name:f.name,data:b.toString('base64')};
 if(['hwp','hwpx','hwpml','xls','xlsx'].includes(extension)){
  try{const r=await parseLocalDocument(b);doc.decoded=r.markdown;delete doc.data;}
  catch{throw Error('파일을 찾았으나 문서 본문을 읽지 못했습니다. 형식이나 읽기 한도를 확인하세요.');}
 }
 if(containsSecret(doc.decoded||(['txt','md','json','csv','tsv'].includes(extension)?b.toString('utf8'):'')))throw Error('인증 정보가 포함된 파일은 문서 작업에 사용할 수 없습니다.');
 return {doc,raw:b,size:b.length,ref:{id:f.id,name:f.name,path:f.path,stamp:f.stamp,hash:sum(b)}};
}

async prepare(id,selection){let j=this.row(id),s=JSON.parse(j.spec);const ctrl=new AbortController();this.running.set(id,ctrl);this.db.prepare("UPDATE jobs SET status='reading',error=NULL,nonce=NULL WHERE id=?").run(id);
try{requireThat(!s.unsafe,'이 요청은 실행하지 않습니다. 원하는 작업 한 가지를 입력하세요.');requireThat(s.kind==='send'||supported.includes(s.format),'요청한 출력 형식을 지원하지 않습니다.');requireThat(s.kind!=='edit'||s.change,'수정은 바꿀 문구와 새 문구를 각각 따옴표로 지정하세요.');if(s.kind==='create'&&!s.body){this.db.prepare("UPDATE jobs SET status='question' WHERE id=?").run(id);return;}
const chosen=s.kind==='create'?[]:await this.resolveSources(s,j,selection,ctrl.signal);
if(!chosen)return;
requireThat(chosen.length<=12,'한 요청에는 원천 파일을 12개까지 사용할 수 있습니다.');
const refs=[];
let preview,raw,hash;
if(s.kind==='send'){
 requireThat(chosen.length===1,'보낼 파일을 한 개 선택하세요.');
 const format=ext(chosen[0].name);
 requireThat(canSendOriginal(chosen[0].name),'이 파일 형식은 원본 전송을 지원하지 않습니다. 출력 형식을 지정해 변환해 주세요.');
 const source=await this.loadSource(chosen[0],ctrl.signal);
 requireThat(format==='pdf'||source.size<=2_000_000,'원본 검사 분량 한도를 넘었습니다. 출력 형식을 지정해 변환해 주세요.');
 const inspection=format==='pdf'
  ? (await engine(this.python,{kind:'inspect-original-pdf',data:source.doc.data},ctrl.signal)).preview
  : new TextDecoder('utf-8',{fatal:true}).decode(source.raw);
 requireThat(!containsSecret(inspection),'인증 정보가 포함된 파일은 보낼 수 없습니다.');
 s.format=format;
 s.title=path.parse(source.ref.name).name;
 preview='보낼 원본 파일 · '+source.ref.name+'\n'+source.size+'바이트\n'
  +(chosen[0].searchLimited?'검색 깊이 한도 안에서 찾은 파일입니다. 파일 이름을 확인해 주세요.\n':'')
  +'승인하면 연결된 휴대폰에서 받을 수 있습니다.';
 raw=source.raw;
 hash=source.ref.hash;
 refs.push(source.ref);
}else{
 const docs=[];let total=0;
 for(const f of chosen){const item=await this.loadSource(f,ctrl.signal);total+=item.size;requireThat(total<=12_000_000,'자료 크기 한도를 넘었습니다.');docs.push(item.doc);refs.push(item.ref);}
 const result=await engine(this.python,{...s,kind:s.kind==='read'?'convert':s.kind,docs},ctrl.signal);
 preview=result.preview;
 raw=Buffer.from(result.data,'base64');
 hash=result.sha256;
}
if(ctrl.signal.aborted||this.row(id).status!=='reading')return;
requireThat(typeof preview==='string'&&preview.length<180000,'미리보기 한도를 넘었습니다.');
if(containsSecret(preview))throw Error('인증 정보가 포함된 결과는 저장할 수 없습니다.');
requireThat(sum(raw)===hash,'작성 결과를 확인할 수 없습니다.');
this.db.prepare("UPDATE jobs SET status='approval',spec=?,preview=?,data=?,hash=?,refs=?,nonce=? WHERE id=?").run(JSON.stringify(s),preview,raw,hash,JSON.stringify(refs),randomUUID(),id);
}catch(e){if(!ctrl.signal.aborted&&this.row(id).status==='reading'){this.db.prepare("UPDATE jobs SET status='failed',error=?,data=NULL,preview=NULL,nonce=NULL WHERE id=?").run(safeError(e),id);await this.diag(id);}}finally{if(this.running.get(id)===ctrl)this.running.delete(id);}}
async commit(id,nonce,authorize){
 const job=this.row(id);
 requireThat(job,'작업을 찾지 못했습니다.');
 if(job.status==='done')return;
 requireThat(['approval','saving'].includes(job.status)&&nonce&&job.nonce===nonce,'이전 승인은 만료되었습니다.');
 if(this.writing?.has(id))return;
 this.writing??=new Set();
 this.writing.add(id);
 try{
  // If the approved bytes were already written, recover only their record.
  if(job.status==='saving'&&await this.finish(id,authorize,{recordOnly:true}))return;
  try{
   for(const ref of JSON.parse(job.refs)){
    const buf=await bytes(ref.path,path.dirname(ref.path),8_000_000,ref.stamp);
    requireThat(sum(buf)===ref.hash,'자료가 바뀌었습니다.');
   }
  }catch(e){
   const msg=e.code==='ENOENT'?'원문이 이동하거나 삭제되었습니다. 다시 검색하세요.':['EPERM','EACCES'].includes(e.code)?'원문을 다시 읽을 권한이 없습니다.':'자료가 바뀌었거나 확인할 수 없습니다. 다시 검색하세요.';
   this.db.prepare("UPDATE jobs SET status='failed',error=?,data=NULL,preview=NULL,refs=NULL,nonce=NULL,hash=NULL WHERE id=? AND nonce=? AND status=?").run(msg,id,nonce,job.status);
   return;
  }
  authorize?.();
  if(job.status==='approval'){
   const changed=this.db.prepare("UPDATE jobs SET status='saving' WHERE id=? AND status='approval' AND nonce=?").run(id,nonce);
   if(!changed.changes)return;
  }
  await this.finish(id,authorize);
 }finally{
  this.writing.delete(id);
 }
}
async finish(id,authorize,{recordOnly=false}={}){
 const job=this.row(id);
 requireThat(job?.status==='saving','저장 상태를 다시 확인하세요.');
 if(recordOnly&&!this.get('location-'+id))return false;
 const s=JSON.parse(job.spec);
 const name=(s.title||({summary:'자료 요약',compare:'자료 비교',slides:'발표 자료',create:'새 문서',edit:'수정본',convert:'변환본',read:'문서 본문'})[s.kind]).replace(/[\\/:<>|?*"\x00-\x1f]/g,' ').trim().slice(0,65)+'-'+id.slice(0,8)+'.'+s.format;
 const dir=this.fileDir(id);
 const destination=path.join(dir,name);
 if(!recordOnly){
  this.set('location-'+id,dir);
  await checkedDirectory(dir);
  authorize?.();
  try{await writeFile(destination,job.data,{flag:'wx'});}
  catch(e){if(e.code!=='EEXIST')throw e;}
 }
 let saved;
 try{saved=await bytes(destination,dir);}
 catch(e){
  if(recordOnly&&e.code==='ENOENT')return false;
  throw e;
 }
 requireThat(sum(saved)===job.hash,'저장 결과가 불확실합니다. 기존 파일을 확인하세요.');
 authorize?.();
 this.db.exec('BEGIN');
 try{
  this.db.prepare('INSERT OR IGNORE INTO files VALUES(?,?,?,?,?,?,0)').run(id,name,name,s.format,job.hash,saved.length);
  this.db.prepare("UPDATE jobs SET status='done',spec=NULL,error=NULL,data=NULL,preview=NULL,refs=NULL,nonce=NULL,hash=NULL WHERE id=?").run(id);
  this.set('sources-'+id,job.refs||'[]');
  this.set('last',id);
  this.db.exec('COMMIT');
 }catch(e){
  this.db.exec('ROLLBACK');
  throw e;
 }
 return true;
}
fileDir(id){return this.get('location-'+id)||this.get('output')||this.base.core.outputRoot;}
async download(id,role){const f=this.db.prepare('SELECT * FROM files WHERE id=?').get(id);if(!f)return this.old.download(id,role);requireThat(role==='owner'||f.shared,'전달이 허용되지 않았습니다.');const b=await bytes(path.join(this.fileDir(id),f.physical),this.fileDir(id));requireThat(sum(b)===f.hash,'파일이 바뀌었습니다.');return {bytes:b,name:f.name,sha256:f.hash};}
async handle(b,role,requestDevice=null){if(b.action==='desk-start'&&uuid(b.id||b.requestId)){this.starts??=new Map();const k=b.id||b.requestId;const same=this.starts.get(k);if(same)return same.text===b.text&&same.requestDevice===requestDevice?same.promise:{ok:false,error:'같은 작업 번호의 요청 내용이 다릅니다.'};const promise=this.dispatch(b,role,requestDevice);this.starts.set(k,{text:b.text,requestDevice,promise});try{return await promise;}finally{this.starts.delete(k);}}return this.dispatch(b,role,requestDevice);}
async dispatch(b,role,requestDevice){const a=b.action;const owner=()=>requireThat(role==='owner','PC에서 확인하세요.');if(a==='desk-state')return this.view(role,Math.max(0,Math.min(1000000,Number(b.offset)||0)));if(a==='pair')return this.old.handle(b,role);
if(!a.startsWith('desk-')){if(!['state','pair'].includes(a))this.invalidate();const r=await this.old.handle(b,role);if(a==='approve'&&r.executed&&r.state?.latest)this.set('last','');return r;}
try{const id=b.id||b.requestId;requireThat(uuid(id),'잘못된 작업입니다.');if(a==='desk-open'){const f=await this.download(id,role);const r=await engine(this.python,{kind:'convert',request:'',format:'txt',docs:[{name:f.name,data:f.bytes.toString('base64')}]});return{body:r.preview};}if(a==='desk-folder'){owner();const f=await this.pick();if(f){const root=await checkedDirectory(f);requireThat(path.parse(root).root!==root,'드라이브 전체는 허용할 수 없습니다.');this.invalidate();await this.old.handle({action:'invalidate',requestId:randomUUID()},role);this.set('folder',root);}return {ok:true,notice:f?'허용한 폴더를 기억했습니다.':null};}
if(a==='desk-upload'){requireThat(fileName(b.name)&&readable.includes(ext(b.name)),'이 파일 형식은 읽을 수 없습니다.');const raw=Buffer.from(b.base64,'base64');requireThat(raw.length&&raw.length<=8_000_000&&raw.toString('base64')===b.base64&&sum(raw)===b.sha256,'첨부 크기나 내용이 올바르지 않습니다.');const key=sum(b.name+'\0'+b.sha256),dir=path.join(this.dir,'uploads'),dest=path.join(dir,key+'.'+ext(b.name));try{await writeFile(dest,raw,{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;}requireThat(sum(await bytes(dest,dir))===b.sha256,'첨부를 다시 확인하세요.');this.invalidate();this.db.prepare('INSERT OR REPLACE INTO attachments VALUES(?,?,?,1)').run(key,b.name,dest);if(ext(b.name)==='md'&&raw.length<=262144){const r=await this.old.handle({...b,action:'upload'},role);if(r.ok===false)return r;}else await this.old.handle({action:'invalidate',requestId:randomUUID()},role);return{ok:true,notice:b.name+' 첨부됨'};}
if(a==='desk-invalidate'){this.invalidate();await this.old.handle({action:'invalidate',requestId:id},role);return{ok:true};}
if(a==='desk-convert'){owner();requireThat(['pdf','ppt'].includes(b.format)&&uuid(b.sourceId),'변환할 파일과 형식을 확인하세요.');requireThat(this.db.prepare('SELECT 1 FROM files WHERE id=?').get(b.sourceId),'보관 파일을 찾지 못했습니다.');const binding=sum(JSON.stringify([b.sourceId,b.format]));if(this.row(id)){requireThat(this.get('request-'+id)===binding,'같은 작업 번호의 변환 내용이 다릅니다.');return{ok:true,id};}requireThat(!this.get('request-'+id),'보관 기간이 지난 작업입니다.');this.invalidate();await this.old.handle({action:'invalidate',requestId:id},role);const spec={kind:'convert',format:b.format,request:'보관 파일을 '+b.format.toUpperCase()+'로 변환',useLast:b.sourceId,unsafe:false,names:[]};this.set('request-'+id,binding);this.db.prepare("INSERT INTO jobs(id,status,spec) VALUES(?,'reading',?)").run(id,JSON.stringify(spec));void this.prepare(id).catch(()=>{});return{ok:true,id};}
if(a==='desk-start'){requireThat(typeof b.text==='string'&&b.text.trim()&&b.text.length<=8000,'요청을 짧게 입력하세요.');if(this.get('request-'+id)&&!this.row(id))return {ok:false,error:'보관 기간이 지난 작업입니다.'};const existing=this.row(id);if(existing){requireThat(existing.request_device===requestDevice&&this.get('request-'+id)===sum(b.text),'같은 작업 번호의 요청 내용이 다릅니다.');return {ok:true,id};}const old=await this.old.view(role),s=route(b.text),last=this.get('last');if(s.kind==='convert'&&old.latest&&!last&&!s.names.length&&!['md','txt','json'].includes(s.format))throw Error('이 검토 결과의 변환 형식을 지원하지 않습니다.');if(s.recentResult&&!s.unsafe)requireThat(last,'먼저 보낼 작업 결과를 만들어 주세요.');if(!s.unsafe&&last&&(s.recentResult&&s.kind==='send'||!s.kind&&/(?:전달|휴대폰에서 받을|모바일에서 받|공유해)/u.test(b.text))){this.db.prepare('UPDATE files SET shared=1 WHERE id=?').run(last);return{ok:true,notice:'연결한 화면에서 받을 수 있습니다.'};}
if(!s.kind&&!/검토|보완|저장|취소|질문|전달|공유|휴대폰|\?|만들|작성/.test(b.text)&&!old.draft)throw Error('요청한 작업을 구분하지 못했습니다. 요약이나 비교처럼 원하는 작업을 알려 주세요.');if(!s.kind&&!supported.includes(s.format))throw Error('요청한 출력 형식을 지원하지 않습니다.');if(s.kind!=='send'&&(!s.kind||/검토 대상은|검토할 대상은|새\s*검토서|보완안/u.test(b.text)||old.draft&&['title','investment','memo'].includes(old.draft.stage)||s.kind==='convert'&&!last&&!s.names.length&&old.latest)){this.invalidate();if(/검토해|검토해\s*줘/.test(b.text)&&!s.unsafe&&s.names.length===1&&!/검토 대상은|근거 자료는|적용 지침은/.test(b.text)&&!old.draft){const candidates=(await this.list()).filter(f=>f.name===s.names[0]);requireThat(candidates.length===1&&ext(candidates[0].name)==='md','검토할 MD 파일 하나를 확인하세요.');const f=candidates[0],raw=await bytes(f.path,path.dirname(f.path),262144);if(!old.attachments.some(a=>a.sha256===sum(raw))){const reg=await this.old.handle({action:'upload',requestId:randomUUID(),name:f.name,base64:raw.toString('base64'),sha256:sum(raw)},role);requireThat(reg.uploaded,'검토 자료를 등록하지 못했습니다.');}}const r=await this.old.handle({action:'message',requestId:id,text:b.text},role);return this.legacyResult(r);}
this.invalidate();await this.old.handle({action:'invalidate',requestId:randomUUID()},role);if(last&&(s.recentResult||/^(?:그\s*수정본|수정본|방금\s*(?:결과|만든)|그\s*(?:결과|문서)|최근\s*결과)/.test(b.text.trim()))&&!s.names.length)s.useLast=last;s.request=b.text;this.set('request-'+id,sum(b.text));s.title=s.title?.slice(0,120);this.db.prepare("INSERT OR IGNORE INTO jobs(id,status,spec,request_device) VALUES(?,'reading',?,?)").run(id,JSON.stringify(s),requestDevice);void this.prepare(id).catch(()=>{});return{ok:true,id};}
const j=this.row(id);requireThat(j,'작업을 찾지 못했습니다.');if(a==='desk-cancel'){requireThat(j.status!=='saving','저장 중인 결과를 먼저 확인하세요.');this.running.get(id)?.abort();this.db.prepare("UPDATE jobs SET status='cancelled',error=NULL,data=NULL,spec=NULL,refs=NULL,preview=NULL,nonce=NULL WHERE id=? AND status NOT IN ('done','saving')").run(id);}
else if(a==='desk-approve'){owner();await this.commit(id,b.nonce);}
else if(a==='desk-retry'){if(j.status==='saving'){owner();await this.commit(id,j.nonce);}else{requireThat(j.status==='failed','다시 시도할 작업이 아닙니다.');const spec=JSON.parse(j.spec);if(['summary','compare','slides','create'].includes(spec.kind)&&spec.request){const current=route(spec.request);if(current.kind===spec.kind&&supported.includes(current.format)){spec.format=current.format;this.db.prepare('UPDATE jobs SET spec=? WHERE id=? AND status=\'failed\'').run(JSON.stringify(spec),id);}}void this.prepare(id).catch(()=>{});}}
else if(a==='desk-answer'){owner();requireThat(j.status==='question'&&typeof b.answer==='string'&&b.answer.trim()&&b.answer.length<=8000,'작성할 내용을 확인하세요.');const spec=JSON.parse(j.spec);spec.body=b.answer;this.db.prepare('UPDATE jobs SET spec=? WHERE id=?').run(JSON.stringify(spec),id);void this.prepare(id).catch(()=>{});}
else if(a==='desk-select'){owner();requireThat(j.status==='choose'&&Array.isArray(b.ids),'선택할 자료가 없습니다.');void this.prepare(id,b.ids).catch(()=>{});}
else throw Error('지원하지 않는 작업입니다.');return{ok:true,id};}catch(e){return {ok:false,error:safeError(e)};}}
legacyResult(r){const t=r.state?.messages?.at(-1);if(r.state?.latest&&r.executed)this.set('last','');return {ok:r.ok!==false,notice:t?.text||null,legacyError:r.ok===false||r.interpreted===false,reviewItems:t?.items||null};}
}

