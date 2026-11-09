import {reviewOptions,connectReview,validateReview} from './paired-review.mjs';
import http from 'node:http';
import https from 'node:https';
import {randomBytes,randomInt,randomUUID,createHash,scryptSync,timingSafeEqual} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {mkdir,readFile,writeFile,lstat,unlink} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import readline from 'node:readline';
import {FinancialWorker} from '../financial-documents/remote-worker.mjs';
import {LocalRegistration} from '../financial-documents/local-registration.mjs';
import {RequestRecords} from '../financial-documents/request-records.mjs';
import {Workbench} from '../financial-documents/workbench.mjs';
import {checkedDirectory} from '../personal-ai/documents/files.mjs';
import {safeRoot,within} from './source-roots.mjs';
import {desktopVersion} from './version.mjs';
import {privateStateDirectory,profileDirectory,startupFailure} from './paired-storage.mjs';
import {createDeviceLink,RELAY_ORIGIN} from './device-link.mjs';
const digest=b=>createHash('sha256').update(b).digest('hex'),secret=()=>randomBytes(32).toString('hex'),day=86400000;
const deny=(message,status=400)=>{throw Object.assign(Error(message),{status});};
async function init(p,value){try{await writeFile(p,JSON.stringify(value),{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;}}
export async function start(cfg){
 const {state,known,python}=cfg;await privateStateDirectory(state);
 const profilesRoot=await profileDirectory(state,known.documents);
 const db=new DatabaseSync(path.join(state,'devices.sqlite'));db.exec('PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE,salt TEXT,pw TEXT);CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY,user TEXT,kind TEXT,pc TEXT,active INT);CREATE UNIQUE INDEX IF NOT EXISTS local_pc ON devices(user) WHERE kind=\'pc\';CREATE TABLE IF NOT EXISTS sessions(h TEXT PRIMARY KEY,user TEXT,device TEXT,expires INTEGER);CREATE TABLE IF NOT EXISTS codes(h TEXT PRIMARY KEY,user TEXT,pc TEXT,expires INTEGER);CREATE TABLE IF NOT EXISTS receipts(device TEXT,file TEXT,hash TEXT,at INTEGER,PRIMARY KEY(device,file));CREATE TABLE IF NOT EXISTS delivery(device TEXT,file TEXT,PRIMARY KEY(device,file));');
 db.exec('CREATE TABLE IF NOT EXISTS private_dirs(dir TEXT PRIMARY KEY,pc TEXT); CREATE TABLE IF NOT EXISTS relay_grants(id TEXT PRIMARY KEY,user TEXT,pc TEXT,expires INTEGER,claim TEXT,device TEXT)');
 let link;
 const profiles=new Map(),owner=secret(),tries=new Map();
 const get=(sql,...args)=>db.prepare(sql).get(...args),run=(sql,...args)=>db.prepare(sql).run(...args);
 function session(user,device='',ttl=90*day){const token=secret();run('INSERT INTO sessions VALUES(?,?,?,?)',digest(token),user,device,Date.now()+ttl);return {token,device};}
 function attempt(key,limit){const entry=tries.get(key)||{n:0,end:0};if(entry.end<Date.now()){entry.n=0;entry.end=Date.now()+600000;}entry.n++;tries.set(key,entry);if(entry.n>limit)deny('잠시 뒤 다시 시도하세요.',429);}
 async function profile(id){if(!profiles.has(id))profiles.set(id,openProfile(id).catch(e=>{profiles.delete(id);throw e;}));return profiles.get(id);}
 async function openProfile(id){
 const dir=path.join(profilesRoot,id),input=path.join(dir,'inputs'),generic=path.join(dir,'generic'),out=path.join(known.documents,'DIANA','결과',id);
 for(const p of [input,generic,out]){await mkdir(p,{recursive:true});await checkedDirectory(p);}
 const coreConfig=path.join(dir,'core.json'),configPath=path.join(dir,'worker.json'),stateDir=path.join(dir,'local-state');
 await init(coreConfig,{schema_version:1,principal:id,role:'analyst',readRoots:[input],outputRoot:out,python,write_roles:['analyst'],approval_ttl_ms:300000,documents:[]});
 await init(configPath,{schema_version:1,coreConfig,stateDir,tasks:[]});
 const worker=await FinancialWorker.create({allowEmpty:true,configPath,runtimePython:python,documentRoot:generic,api:async()=>deny('원격 작업은 이 연결에서 사용할 수 없습니다.'),detailOutput:false});
 try{const base=worker.registrationBase(),reg=await LocalRegistration.open(worker);
 const records=new RequestRecords({stateDir,protectedRoots:[input,out,generic],withContext:f=>reg.withRecordingContext(f),withEvidenceSearch:f=>reg.withEvidenceSearch(f),withLocalReview:f=>reg.withLocalReview(f),withLocalPatch:f=>reg.withLocalPatch(f),aiPython:python,appVersion:'desktop-'+desktopVersion});
 const w=await Workbench.open({base,registry:reg,records,python,pick:async()=>null});
 const defaults=Object.entries({바탕화면:known.desktop,문서:known.documents,다운로드:known.downloads}).filter(x=>x[1]).map(([label,p])=>({label,path:p}));
 w.searchConfig=()=>({roots:JSON.parse(w.get('roots')||JSON.stringify(defaults)),excluded:[state,path.join(known.documents,'DIANA'),...db.prepare('SELECT dir FROM private_dirs').all().map(r=>r.dir),...JSON.parse(w.get('exclusions')||'[]'),...w.db.prepare("SELECT DISTINCT v FROM settings WHERE k='output' OR k LIKE 'location-%'").all().map(x=>x.v)]});
 w.db.exec("CREATE TABLE IF NOT EXISTS ends(id TEXT PRIMARY KEY,at INTEGER); CREATE TRIGGER IF NOT EXISTS ended AFTER UPDATE OF status ON jobs WHEN NEW.status IN ('done','failed','cancelled') AND OLD.status<>NEW.status BEGIN INSERT OR REPLACE INTO ends VALUES(NEW.id,unixepoch()*1000); END;");
 w.db.prepare("INSERT OR IGNORE INTO ends SELECT id,? FROM jobs WHERE status IN ('done','failed','cancelled')").run(Date.now());
 return {w,worker,records,reg,out};}catch(e){await worker.close();throw e;}}
 function maintain(w,pc){
 for(const f of w.db.prepare('SELECT id FROM files').all())run('INSERT OR IGNORE INTO delivery SELECT id,? FROM devices WHERE pc=? AND active=1 AND kind=\'phone\'',f.id,pc);
 const protectedFiles=new Set(db.prepare('SELECT DISTINCT d.file FROM delivery d JOIN devices v ON v.id=d.device AND v.active=1 LEFT JOIN receipts r ON r.device=d.device AND r.file=d.file WHERE v.pc=? AND r.file IS NULL').all(pc).map(r=>r.file));
 for(const r of w.db.prepare("SELECT j.id FROM jobs j JOIN ends e ON j.id=e.id WHERE e.at<? AND j.status IN ('done','failed','cancelled')").all(Date.now()-7*day)){if(!protectedFiles.has(r.id)){w.db.prepare('DELETE FROM jobs WHERE id=?').run(r.id);w.db.prepare('DELETE FROM ends WHERE id=?').run(r.id);}}
 }
 async function handler(req,res){
 try{if(req.method!=='POST'||req.url!=='/v1'||req.headers.origin||!/^application\/json\b/.test(req.headers['content-type']||''))deny('허용되지 않은 요청입니다.',403);
 let n=0,chunks=[];for await(const c of req){if((n+=c.length)>11000000)deny('첨부 크기 한도를 넘었습니다.',413);chunks.push(c);}const b=JSON.parse(Buffer.concat(chunks)),op=b.op;
 const local=req.headers['x-local-owner']===owner;let answer;
 if(op==='signup'||op==='login'){attempt(req.socket.remoteAddress+':auth',35);const email=String(b.email||'').trim().toLowerCase(),pw=b.password;
 if(!/^[^@\s]{1,80}@[^@\s]{1,100}$/.test(email)||typeof pw!=='string'||pw.length<10||pw.length>200)deny('메일 주소와 10자 이상의 비밀번호를 확인하세요.');
 let u=get('SELECT * FROM users WHERE email=?',email);
 if(op==='signup'){if(u)deny('이미 등록한 메일 주소입니다.');const salt=secret(),id=randomUUID();run('INSERT INTO users VALUES(?,?,?,?)',id,email,salt,scryptSync(pw,salt,32).toString('hex'));u={id};}
 else if(!timingSafeEqual(scryptSync(pw,u?.salt||owner,32),Buffer.from(u?.pw||'00'.repeat(32),'hex'))||!u)deny('로그인 정보를 확인하세요.',401);
 answer=session(u.id,'',600000);
 }else{
 const s=get('SELECT * FROM sessions WHERE h=?',digest(String(req.headers.authorization||'').replace(/^Bearer /,'')));if(!s||s.expires<Date.now())deny('인증이 만료되었습니다. 다시 로그인하세요.',401);
 if(op==='register'&&!s.device){if(!local)deny('현재 PC에서만 등록할 수 있습니다.',403);let pc=get("SELECT * FROM devices WHERE user=? AND kind='pc'",s.user)?.id||randomUUID();run("INSERT OR IGNORE INTO devices VALUES(?,?,'pc',?,1)",pc,s.user,pc);await profile(pc);answer=session(s.user,pc);run('DELETE FROM sessions WHERE h=?',s.h);}
 else if(op==='pair'&&!s.device){attempt(req.socket.remoteAddress+':pair',16);attempt(s.user+':pair',8);const h=digest(s.user+'|'+String(b.code));const c=get('SELECT * FROM codes WHERE h=? AND expires>?',h,Date.now());if(!c)deny('연결 코드가 만료됐거나 일치하지 않습니다.',403);
 const id=randomUUID();db.exec('BEGIN');try{run('DELETE FROM codes WHERE h=?',h);run("INSERT INTO devices VALUES(?,?,'phone',?,1)",id,s.user,c.pc);answer=session(s.user,id);run('DELETE FROM sessions WHERE h=?',s.h);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}}
 else{const dev=get('SELECT * FROM devices WHERE id=? AND user=?',s.device,s.user);if(!dev||!dev.active)deny('기기 연결이 해제되었습니다.',403);const pc=dev.kind==='pc'&&local;if(dev.kind==='pc'&&!pc)deny('PC 기기 인증을 확인하세요.',403);
 const {w,out,reg}=await profile(dev.pc);maintain(w,dev.pc);const only=()=>{if(!pc)deny('현재 PC에서 확인하세요.',403);};
 if(op==='state'){
  const offset=Math.max(0,Math.floor(Number(b.offset)||0)),v=await w.view('owner',offset);
  const jobs=pc?v.jobs:v.jobs.map(({id,status,error})=>({id,status,error}));
  const files=v.files.map(f=>({...f,
   location:pc?path.join(w.fileDir(f.id),w.db.prepare('SELECT physical FROM files WHERE id=?').get(f.id).physical):undefined,
   received:!!get('SELECT 1 FROM receipts WHERE device=? AND file=?',dev.id,f.id),
   delivered:!!get('SELECT 1 FROM receipts WHERE file=?',f.id)
  }));
  answer={device:dev.id,jobs,legacy:pc?v.legacy:undefined,files,more:v.more};
 }
 else if(op==='settings'){only();answer={roots:w.searchConfig().roots,excluded:JSON.parse(w.get('exclusions')||'[]'),output:w.get('output')||out,devices:db.prepare("SELECT id,kind,active FROM devices WHERE user=? AND pc=?").all(s.user,dev.pc)};}
 else if(op==='code'){only();if(link){const grant=secret();run('DELETE FROM relay_grants WHERE (pc=? AND claim IS NULL) OR expires<?',dev.pc,Date.now()-600000);run('INSERT INTO relay_grants VALUES(?,?,?,?,NULL,NULL)',grant,s.user,dev.pc,Date.now()+300000);try{answer=await link.code(grant);}catch(e){run('DELETE FROM relay_grants WHERE id=?',grant);throw e;}}else{const code=randomInt(100000,1000000).toString();run('DELETE FROM codes WHERE pc=? OR expires<?',dev.pc,Date.now());run('INSERT INTO codes VALUES(?,?,?,?)',digest(s.user+'|'+code),s.user,dev.pc,Date.now()+300000);answer={code};}}
 else if(op==='revoke'){if(!pc&&b.device!==dev.id)deny('이 기기만 해제할 수 있습니다.',403);if(!run("UPDATE devices SET active=0 WHERE user=? AND pc=? AND id=? AND kind='phone'",s.user,dev.pc,b.device).changes)deny('연결된 휴대폰을 확인하세요.');answer={ok:true};}
 else if(op==='directory'){only();const p=await safeRoot(b.path),roots=w.searchConfig().roots; if(within(state,p)||within(p,state))deny('앱 설정 위치는 지정할 수 없습니다.');if(b.kind==='output'){if(db.prepare('SELECT dir FROM private_dirs WHERE pc<>?').all(dev.pc).some(r=>within(p,r.dir)||within(r.dir,p))||within(path.join(known.documents,'DIANA'),p)||Object.values(known).some(r=>within(p,r)))deny('결과 전용 하위 폴더를 선택하세요.');run('INSERT OR IGNORE INTO private_dirs VALUES(?,?)',p,dev.pc);w.set('output',p);}else if(b.kind==='exclude'){w.set('roots',JSON.stringify(roots.filter(r=>r.path!==p)));w.set('exclusions',JSON.stringify([...new Set([...JSON.parse(w.get('exclusions')||'[]'),p])]));}else if(b.kind==='root'){w.set('exclusions',JSON.stringify(JSON.parse(w.get('exclusions')||'[]').filter(x=>x!==p)));w.set('roots',JSON.stringify([...roots.filter(r=>r.path!==p),{label:Object.entries({바탕화면:known.desktop,문서:known.documents,다운로드:known.downloads}).find(([,v])=>v?.toLowerCase()===p.toLowerCase())?.[0]||path.basename(p),path:p}]));}else deny('설정을 확인하세요.');w.invalidate();answer={ok:true};}
 else if(op==='review-options'){only();answer=await reviewOptions(w);}
 else if(op==='review-connect'){only();answer=await connectReview(w,reg,b);}
 else if(op==='job'){b.requestId??=b.id||randomUUID();const allowed=['desk-start','desk-convert','desk-upload','desk-select','desk-answer','desk-retry','desk-cancel','desk-approve','desk-invalidate','select','approve','recover'];if(!allowed.includes(b.action))deny('지원하지 않는 작업입니다.');if(['desk-convert','approve','recover','select','desk-approve','desk-select','desk-answer'].includes(b.action))only();if(b.action==='approve')await validateReview(w);answer=await w.handle(b,pc?'owner':'mobile');if(['approve','recover'].includes(b.action)&&answer?.state?.files){for(const f of answer.state.files){if(w.get('deleted-'+f.id))continue;const payload=await w.old.download(f.id,'owner');if(digest(payload.bytes)!==f.sha256)deny('저장된 검토 파일을 확인하세요.');w.set('location-'+f.id,out);w.db.prepare('INSERT OR IGNORE INTO files VALUES(?,?,?,?,?,?,0)').run(f.id,f.name,f.name,f.format,f.sha256,payload.bytes.length);}answer={ok:answer.ok!==false,notice:answer.state.messages?.at(-1)?.text};}if(answer?.ok===false)deny(answer.error||'작업을 완료하지 못했습니다.');}
 else if(op==='file'||op==='receipt'||op==='delete'){const f=w.db.prepare('SELECT * FROM files WHERE id=?').get(b.id);if(!f)deny('보관 파일을 찾지 못했습니다.',404);
 if(op==='receipt'){if(pc||b.hash!==f.hash||b.bytes!==f.size)deny('수신 내용이 일치하지 않습니다.');run('INSERT OR REPLACE INTO receipts VALUES(?,?,?,?)',dev.id,f.id,f.hash,Date.now());answer={ok:true};}
 else{const raw=await w.download(f.id,'owner');if(op==='file')answer={name:f.name,hash:f.hash,bytes:f.size,data:raw.bytes.toString('base64')};
 else{only();if(b.confirm!==true||b.hash!==f.hash)deny('삭제할 파일을 다시 확인하세요.');const target=path.join(w.fileDir(f.id),f.physical);await unlink(target);w.set('deleted-'+f.id,'1');w.db.prepare('DELETE FROM files WHERE id=?').run(f.id);w.db.prepare('DELETE FROM settings WHERE k=?').run('sources-'+f.id);run('DELETE FROM delivery WHERE file=?',f.id);answer={ok:true};}}}
 else deny('지원하지 않는 요청입니다.');}}
 res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(answer));
 }catch(e){const status=e.status||400;const message=/[가-힣]/u.test(e.message)&&!/[\\/:]/.test(e.message)?e.message:'작업에 실패했습니다. 파일과 연결 상태를 확인하세요.';if(cfg.debug)process.stderr.write((e.code||e.message)+'\n');res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify({error:message}));}}
 const server=http.createServer(handler);try{await new Promise((ok,no)=>server.once('error',no).listen(cfg.port??43871,'127.0.0.1',ok));}catch(e){db.close();throw e;}let tls;
 try{if(cfg.tls){tls=https.createServer({cert:await readFile(cfg.tls.cert),key:await readFile(cfg.tls.key),minVersion:'TLSv1.2'},handler);await new Promise((ok,no)=>tls.once('error',no).listen(cfg.tls.port,cfg.tls.host,ok));}}catch(e){await new Promise(ok=>server.close(ok));db.close();throw e;}
 const timer=setInterval(async()=>{for(const [pc,p] of profiles)try{maintain((await p).w,pc);}catch{}},3600000);timer.unref();
 const origin='http://127.0.0.1:'+server.address().port;
 if(cfg.relayOrigin)try{link=await createDeviceLink({state,origin:cfg.relayOrigin,
  pair:async m=>{if(!/^[a-f0-9]{64}$/.test(m.grant)||!/^[a-f0-9]{64}$/.test(m.pairKey)||!/^[a-f0-9-]{36}$/.test(m.requestId))deny('연결 정보를 확인하세요.',403);const c=get('SELECT * FROM relay_grants WHERE id=?',m.grant);const claim=digest(m.requestId+'|'+m.pairKey);if(!c||c.expires<Date.now()&&!c.claim||c.expires+600000<Date.now()||c.claim&&c.claim!==claim)deny('연결 코드가 만료됐거나 이미 사용됐습니다.',403);if(!get("SELECT 1 FROM devices WHERE id=? AND user=? AND kind='pc' AND active=1",c.pc,c.user))deny('PC 연결을 확인하세요.',403);
   if(c.claim){if(!get('SELECT 1 FROM devices WHERE id=? AND active=1',c.device))deny('기기 연결이 해제되었습니다.',403);return{token:m.token,device:c.device};}
   const id=randomUUID();db.exec('BEGIN');try{run("INSERT INTO devices VALUES(?,?,'phone',?,1)",id,c.user,c.pc);run('INSERT INTO sessions VALUES(?,?,?,?)',digest(m.token),c.user,id,Date.now()+90*day);run('UPDATE relay_grants SET claim=?,device=? WHERE id=?',claim,id,c.id);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}return{token:m.token,device:id};},
  dispatch:async(token,b)=>{const allowed=['state','file','receipt','revoke'].includes(b?.op)||b?.op==='job'&&['desk-start','desk-upload','desk-retry','desk-cancel','desk-invalidate'].includes(b.action);if(!allowed)return{status:403,body:{error:'현재 PC에서 확인하세요.'}};const r=await fetch(origin+'/v1',{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify(b)});return{status:r.status,body:await r.json()};}});}catch(e){clearInterval(timer);await new Promise(ok=>server.close(ok));if(tls)await new Promise(ok=>tls.close(ok));db.close();throw e;}
 let closing;
 return {origin,owner,close:()=>closing??=(async()=>{clearInterval(timer);await link?.close();await Promise.all([new Promise(ok=>server.close(ok)),tls?new Promise(ok=>tls.close(ok)):Promise.resolve()]);for(const p of profiles.values()){try{const {worker,records,w}=await p;await records.close();await worker.close();w.db.close();}catch{}}db.close();})()};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const input=readline.createInterface({input:process.stdin});let host;try{for await(const line of input){if(host)break;const cfg=JSON.parse(line);cfg.relayOrigin??=RELAY_ORIGIN;const tlsPath=path.join(cfg.state,'tls.json');try{cfg.tls=JSON.parse(await readFile(tlsPath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}host=await start(cfg);console.log(JSON.stringify({origin:host.origin,owner:host.owner}));}}catch(e){console.log(JSON.stringify(startupFailure(e)));process.exitCode=1;input.close();}finally{await host?.close();}
}

