import { createHash, createHmac, randomInt, randomUUID } from 'node:crypto';
import { basename, extname } from 'node:path';

const HASH = /^[a-f0-9]{64}$/;
const TERMINAL = new Set(['failed', 'needs_attention', 'deadline_exceeded', 'download_ready']);
const TYPES = { '.md':'text/markdown', '.txt':'text/plain', '.hwpx':'application/vnd.hancom.hwpx', '.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation', '.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.pdf':'application/pdf', '.json':'application/json' };
const sha = value => createHash('sha256').update(value).digest('hex');

/** Fixed, single-owner task protocol. No commands, executable paths or shell text. */
export function createOvernightControl({ db, all, save, event, requireJob, authorize, json, bodyOf, binaryOf, assert, bounded, deviceId, transfers, clock, pairingSecret }) {
  db.exec('CREATE TABLE IF NOT EXISTS phone_devices(id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT, fcm_token TEXT, revoked_at TEXT)');
  const stamp = () => new Date(clock()).toISOString();
  const setting = key => { const raw = db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value; return raw ? JSON.parse(raw) : null; };
  const setSetting = (key, value) => db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
  const catalog = () => setting('catalog') || { documents: [], updatedAt: null };
  const fileName = (jobId, artifactId) => jobId + '-' + artifactId + '.bin';
  const publicJob = job => { const { _artifactManifest, _artifactCleanup, ...visible } = job; return visible; };
  const isOvernight = job => job.kind === 'overnight';
  function authenticatePhone(token) {
    if (typeof token !== 'string' || token.length < 32) return null;
    const phone = db.prepare('SELECT id FROM phone_devices WHERE token_hash=? AND revoked_at IS NULL').get(sha(token));
    if (phone) {
      db.prepare('UPDATE phone_devices SET last_seen_at=? WHERE id=?').run(stamp(), phone.id);
      // An authenticated request proves delivery of the pairing credential.
      // Stop accepting code-based recovery as soon as the phone uses it.
      if (setting('phonePairCode')?.pairing?.phoneId === phone.id) {
        db.prepare('DELETE FROM settings WHERE key=?').run('phonePairCode');
      }
    }
    return phone?.id || null;
  }
  // Request-time deadline updates must never wait for remote file deletion.
  function refresh() {
    for (const job of all()) {
      if (!isOvernight(job)) continue;
      if (!TERMINAL.has(job.state) && clock() >= Date.parse(job.request.deadlineAt)) {
        job.state = 'deadline_exceeded'; job.error = '완료 시각을 넘겼습니다. 완성본으로 전달하지 않습니다.';
        event(job, job.error); save(job);
      }
    }
  }
  function expiredOutput(job, continuingIncompleteCleanup = false) {
    if (job.artifactsExpired) return null;
    if (job.artifacts?.length) {
      return clock() - Date.parse(job.completedAt) > 24 * 3600_000 ? { kind:'complete', files:job.artifacts } : null;
    }
    // Keep partial cleanup eligible after saving progress or a concurrent wake
    // acknowledgement changes updatedAt during an already-started deletion.
    if (TERMINAL.has(job.state) && job._artifactManifest?.length &&
        (continuingIncompleteCleanup || job._artifactCleanup?.kind === 'incomplete' || clock() - Date.parse(job.updatedAt) > 24 * 3600_000)) {
      return { kind:'incomplete', files:job._artifactManifest };
    }
    return null;
  }
  let cleaning = null;
  function cleanExpiredTransfers() {
    if (cleaning) return cleaning;
    cleaning = (async () => {
      for (const { id } of all()) {
        for (;;) {
          let job = requireJob(id);
          if (!isOvernight(job)) break;
          const output = expiredOutput(job);
          if (!output) break;
          const removed = job._artifactCleanup?.deletedIds || [];
          const artifact = output.files.find(a => !removed.includes(a.id));
          if (!artifact) {
            job.artifactsExpired = true; delete job._artifactCleanup; save(job);
            await db.flush?.();
            break;
          }
          try { await transfers.remove(fileName(id, artifact.id)); }
          catch { break; } // Retry this job next interval; other jobs may still be cleaned.
          // Another request can finish a job or record a phone receipt while
          // Storage is pending. Merge cleanup progress into its latest record.
          job = requireJob(id);
          const latest = expiredOutput(job, output.kind === 'incomplete');
          if (!latest || latest.kind !== output.kind || !latest.files.some(a => a.id === artifact.id)) break;
          job._artifactCleanup = { kind:latest.kind, deletedIds:[...new Set([...(job._artifactCleanup?.deletedIds || []), artifact.id])] };
          if (latest.files.every(a => job._artifactCleanup.deletedIds.includes(a.id))) {
            job.artifactsExpired = true; delete job._artifactCleanup;
          }
          save(job);
          // Persist each successful deletion so a partial failure or restart
          // does not repeatedly delete files that are already gone.
          await db.flush?.();
        }
      }
    })().finally(() => { cleaning = null; });
    return cleaning;
  }
  function create(req, res, data) {
    assert(data.delivery === undefined || data.delivery === 'download', 400, '밤사이 작업은 현재 휴대폰 저장만 지원합니다.');
    const instruction = bounded(data.instruction, 4000, '수정 목표');
    assert(HASH.test(data.sourceId || ''), 400, '미리 확인한 원본 파일을 선택하세요.');
    assert(Array.isArray(data.criteria) && data.criteria.length >= 1 && data.criteria.length <= 10, 400, '검토 기준을 1~10개 지정하세요.');
    const criteria = data.criteria.map(c => bounded(c, 500, '검토 기준'));
    const start = Date.parse(data.startAt), deadline = Date.parse(data.deadlineAt);
    assert(Number.isFinite(start) && Number.isFinite(deadline), 400, '시작·완료 시각을 확인하세요.');
    assert(start <= clock() + 30 * 24 * 3600_000 && deadline <= clock() + 31 * 24 * 3600_000 && deadline - start >= 30 * 60_000 && start <= deadline - 25 * 60_000, 400, '완료 기한을 작업 시작보다 30분 이상 뒤로 지정하세요. 휴대폰 동기화에 여유 시간이 필요합니다.');
    assert([6, 7, 8].includes(data.slideCount ?? 6), 400, '발표자료는 6~8장으로 지정하세요.');
    const subject = data.subject ? bounded(data.subject, 160, '작업 제목') : '밤사이 보고서 작업';
    const request = { kind:'overnight', sourceId:data.sourceId, instruction, criteria, startAt:new Date(start).toISOString(), deadlineAt:new Date(deadline).toISOString(), slideCount:data.slideCount ?? 6, delivery:'download', subject };
    // Compare an idempotent replay before consulting the refreshed catalog or time.
    const previous = all().find(j => j.id === data.requestId);
    if (previous) {
      assert(JSON.stringify(previous.request) === JSON.stringify(request), 409, '같은 요청 ID로 다른 작업을 만들 수 없습니다.');
      return json(res, 200, {job:publicJob(previous), duplicate:true});
    }
    assert(deadline > clock() + 25 * 60_000, 400, '완료 기한을 현재보다 최소 25분 뒤로 지정하세요. 휴대폰 동기화에 여유 시간이 필요합니다.');
    const source = catalog().documents.find(d => d.id === data.sourceId);
    assert(source, 409, 'PC 목록을 새로 불러와 원본 파일을 다시 확인하세요.');
    assert(all().filter(j => !['dry_run','submitted','send_unknown','pc_saved',...TERMINAL].includes(j.state)).length < 20, 429, '대기 작업이 많습니다.');
    const job = save({id:data.requestId,deviceId,kind:'overnight',request,source:{...source},state:'scheduled',stage:'scheduled',artifacts:[],wakeStatus:'pending',createdAt:stamp(),events:[{at:stamp(),text:'원본과 검토 기준을 확정했습니다. 예약 시각에 작업합니다.'}]});
    return json(res, 201, {job:publicJob(job)});
  }
  function claim(queue) {
    const job = queue.filter(j => isOvernight(j) && (j.state === 'processing' || (j.state === 'scheduled' && Date.parse(j.request.startAt) <= clock())))
      .sort((a,b) => Date.parse(a.request.deadlineAt) - Date.parse(b.request.deadlineAt))[0];
    if (!job) return null;
    if (job.state !== 'processing') { job.state='processing'; job.stage='draft'; event(job,'PC에서 검토와 발표자료 생성을 시작했습니다.'); save(job); }
    return {id:job.id,deviceId,action:'overnight',...job.request,source:job.source};
  }
  function ensureWorking(job) {
    assert(isOvernight(job) && job.state === 'processing', 409, '실행 중인 밤사이 작업이 아닙니다.');
    assert(clock() < Date.parse(job.request.deadlineAt), 409, '완료 시각이 지났습니다.');
  }
  function result(res, job, data) {
    assert(['download_ready','needs_attention','deadline_exceeded','failed'].includes(data.status), 400, '작업 결과 상태를 확인하세요.');
    if (TERMINAL.has(job.state)) {
      assert(job.state === data.status, 409, '이미 다른 결과로 끝난 작업입니다.');
      return json(res,200,{job:publicJob(job),duplicate:true});
    }
    ensureWorking(job);
    if (data.status === 'download_ready') {
      const manifest = job._artifactManifest;
      assert(manifest?.length && manifest.every(a => a.uploaded),409,'모든 결과 파일의 전송이 끝나지 않았습니다.');
      const required = new Set(['보고서.md','보고서.hwpx','보고서.pdf','발표자료.pptx','발표자료.pdf']);
      for (const artifact of manifest) required.delete(artifact.filename);
      assert(required.size === 0,409,'보고서(MD·HWPX·PDF)와 발표자료(PPTX·PDF)가 모두 필요합니다.');
      job.artifacts=manifest.map(({uploaded,...a})=>a); job.completedAt=stamp();
    }
    job.state=data.status==='download_ready'?'awaiting_phone':data.status; job.stage=data.status==='download_ready'?'awaiting_phone':data.status; job.error=data.error ? String(data.error).slice(0,500) : null;
    event(job,{download_ready:'보고서(MD·HWPX·PDF)와 발표자료(PPTX·PDF)가 준비되었습니다. 갤럭시의 저장 확인을 기다립니다.',needs_attention:'검토에서 해결되지 않은 문제가 있어 확인이 필요합니다.',deadline_exceeded:'완료 시각 안에 끝내지 못했습니다.',failed:'작업에 실패했습니다.'}[data.status]);
    return json(res,200,{job:publicJob(save(job))});
  }
  const pairRates = new Map();
  async function handle(req,res,path) {
    if (path === '/api/catalog' && req.method==='GET') {
      authorize(req,'user'); json(res,200,catalog()); return true;
    }
    if (path === '/api/agent/catalog' && req.method==='POST') {
      authorize(req,'agent'); const data=await bodyOf(req,256*1024);
      assert(Array.isArray(data.documents) && data.documents.length<=100,400,'원본 목록은 100개 이하여야 합니다.');
      const documents=data.documents.map(d=> {
        assert(HASH.test(d.id||'')&&HASH.test(d.sha256||''),400,'원본 ID와 해시를 확인하세요.');
        const filename=bounded(d.filename,255,'파일명');
        assert(basename(filename)===filename&&!/[\\/\x00-\x1f]/.test(filename),400,'파일명을 확인하세요.');
        assert(Number.isSafeInteger(d.bytes)&&d.bytes>0&&d.bytes<=10*1024*1024,400,'파일 크기를 확인하세요.');
        assert(Number.isFinite(Date.parse(d.modifiedAt)),400,'수정 시각을 확인하세요.');
        return {id:d.id,sha256:d.sha256,filename,bytes:d.bytes,modifiedAt:new Date(d.modifiedAt).toISOString(),excerpt:String(d.excerpt||'').slice(0,1200)};
      });
      assert(new Set(documents.map(d=>d.id)).size===documents.length,400,'원본 ID가 중복되었습니다.');
      setSetting('catalog',{documents,updatedAt:stamp()});json(res,200,{ok:true});return true;
    }
    if (path === '/api/phone/pair-code' && req.method==='POST') {
      authorize(req,'owner'); const code=String(randomInt(100000,1000000));
      const expiresAt=new Date(clock()+5*60_000).toISOString();
      setSetting('phonePairCode',{hash:sha(code),expiresAt,attempts:0});json(res,200,{code,expiresAt});return true;
    }
    if (path === '/api/phone/pair' && req.method==='POST') {
      const minute=Math.floor(clock()/60_000),key=req.socket.remoteAddress;
      const rate=pairRates.get(key);const count=rate?.minute===minute?rate.count+1:1;pairRates.set(key,{minute,count});
      if(pairRates.size>1000) for(const[k,v]of pairRates)if(v.minute!==minute)pairRates.delete(k);
      assert(count<=5,429,'연결 시도가 많습니다. 잠시 후 다시 시도하세요.');
      const data=await bodyOf(req);const entry=setting('phonePairCode');
      const name=bounded(data.deviceName,100,'휴대폰 이름');
      assert(!data.fcmToken || (typeof data.fcmToken==='string'&&data.fcmToken.length<=4096),400,'알림 토큰을 확인하세요.');
      assert(entry&&entry.attempts<5&&Date.parse(entry.expiresAt)>clock(),401,'연결 코드가 없거나 만료되었습니다.');
      if(typeof data.code!=='string'||!/^\d{6}$/.test(data.code)||sha(data.code)!==entry.hash){entry.attempts++;setSetting('phonePairCode',entry);assert(false,401,'연결 코드가 맞지 않습니다.');}
      const requestHash=sha(JSON.stringify({deviceName:name,fcmToken:data.fcmToken||null}));
      assert(!entry.pairing || entry.pairing.requestHash===requestHash,401,'이미 다른 휴대폰 연결에 사용한 코드입니다.');
      const phoneId=entry.pairing?.phoneId || randomUUID();
      // Persist a short-lived receipt with the phone insert. The stable owner
      // secret lets an identical retry recover its token after a failed/ambiguous
      // commit or restart, while the database continues to store only hashes.
      const phoneToken=createHmac('sha256',pairingSecret)
        .update(JSON.stringify(['diana-phone-pair-v1',phoneId,requestHash,entry.hash])).digest('hex');
      if (entry.pairing) {
        const phone=db.prepare('SELECT token_hash,revoked_at FROM phone_devices WHERE id=?').get(phoneId);
        assert(phone && !phone.revoked_at && phone.token_hash===sha(phoneToken),401,'사용할 수 없는 휴대폰 연결입니다.');
      } else {
        db.prepare('INSERT INTO phone_devices(id,token_hash,name,created_at,last_seen_at,fcm_token) VALUES(?,?,?,?,?,?)').run(phoneId,sha(phoneToken),name,stamp(),stamp(),data.fcmToken||null);
        entry.pairing={phoneId,requestHash};setSetting('phonePairCode',entry);
      }
      json(res,201,{phoneId,phoneToken,firebase:{enabled:false}});return true;
    }
    if(path==='/api/phone/devices'&&req.method==='GET'){
      authorize(req,'owner');const devices=db.prepare('SELECT id,name,created_at AS createdAt,last_seen_at AS lastSeenAt FROM phone_devices WHERE revoked_at IS NULL').all();json(res,200,{devices});return true;
    }
    let m=path.match(/^\/api\/phone\/devices\/([^/]+)$/);
    if(m&&req.method==='DELETE'){
      authorize(req,'owner');db.prepare('UPDATE phone_devices SET revoked_at=?,fcm_token=NULL WHERE id=?').run(stamp(),m[1]);json(res,200,{ok:true});return true;
    }
    if(path==='/api/phone/token'&&req.method==='POST'){
      authorize(req,'user');assert(req.phoneId,403,'휴대폰 연결 토큰이 필요합니다.');const data=await bodyOf(req);
      assert(typeof data.fcmToken==='string'&&data.fcmToken.length>0&&data.fcmToken.length<=4096,400,'알림 토큰을 확인하세요.');
      db.prepare('UPDATE phone_devices SET fcm_token=? WHERE id=?').run(data.fcmToken,req.phoneId);json(res,200,{ok:true,firebase:{enabled:false}});return true;
    }
    m=path.match(/^\/api\/agent\/jobs\/([^/]+)\/progress$/);
    if(m&&req.method==='POST'){
      authorize(req,'agent');const job=requireJob(m[1]);ensureWorking(job);const data=await bodyOf(req);
      assert(['draft','review','revise','validate','export','deliver','preparing','validating','reviewing','revising','drafting','exporting','uploading'].includes(data.stage),400,'작업 단계를 확인하세요.');
      job.stage=data.stage;if(Number.isSafeInteger(data.round)&&data.round>=0&&data.round<=3)job.round=data.round;
      if(data.message)event(job,String(data.message).slice(0,300));save(job);json(res,200,{ok:true});return true;
    }
    m=path.match(/^\/api\/agent\/jobs\/([^/]+)\/artifacts$/);
    if(m&&req.method==='POST'){
      authorize(req,'agent');const job=requireJob(m[1]);ensureWorking(job);const data=await bodyOf(req);
      assert(Array.isArray(data.artifacts)&&data.artifacts.length>=2&&data.artifacts.length<=8,400,'결과 파일은 2~8개여야 합니다.');
      const manifest=data.artifacts.map(a=>{
        assert(HASH.test(a.id||'')&&HASH.test(a.sha256||'')&&a.id===a.sha256,400,'결과 파일 ID와 해시를 확인하세요.');
        const filename=bounded(a.filename,255,'결과 파일명'),type=TYPES[extname(filename).toLowerCase()];
        assert(type&&a.mime===type&&basename(filename)===filename&&!/[\\/\x00-\x1f]/.test(filename),400,'허용되지 않은 결과 파일 형식입니다.');
        assert(Number.isSafeInteger(a.bytes)&&a.bytes>0&&a.bytes<=10*1024*1024,400,'결과 파일 크기를 확인하세요.');
        return {id:a.id,sha256:a.sha256,filename,mime:type,bytes:a.bytes};
      });
      assert(new Set(manifest.map(a=>a.id)).size===manifest.length&&new Set(manifest.map(a=>a.filename.toLowerCase())).size===manifest.length,400,'결과 파일이 중복되었습니다.');
      assert(manifest.reduce((n,a)=>n+a.bytes,0)<=50*1024*1024,413,'결과물 전체 크기는 50MB 이하여야 합니다.');
      if(job._artifactManifest){assert(JSON.stringify(job._artifactManifest.map(({uploaded,...a})=>a))===JSON.stringify(manifest),409,'이미 다른 결과물 목록이 등록되었습니다.');json(res,200,{ok:true,duplicate:true});return true;}
      job._artifactManifest=manifest;save(job);json(res,201,{ok:true});return true;
    }
    m=path.match(/^\/api\/agent\/jobs\/([^/]+)\/artifacts\/([^/]+)$/);
    if(m&&req.method==='POST'){
      authorize(req,'agent');const job=requireJob(m[1]);ensureWorking(job);assert(HASH.test(m[2]),400,'결과 파일 ID를 확인하세요.');
      const artifact=job._artifactManifest?.find(a=>a.id===m[2]);assert(artifact,404,'먼저 결과물 목록을 등록하세요.');
      const bytes=await binaryOf(req);assert(bytes.length===artifact.bytes&&sha(bytes)===artifact.sha256,409,'파일 크기 또는 무결성 확인에 실패했습니다.');
      const target=fileName(job.id,artifact.id);
      const existing=await transfers.read(target);
      if(existing)assert(sha(existing)===artifact.sha256,409,'기존 전송 파일이 다릅니다.');
      else await transfers.put(target,bytes);
      artifact.uploaded=true;save(job);json(res,200,{ok:true});return true;
    }
    m=path.match(/^\/api\/jobs\/([^/]+)\/artifacts\/([^/]+)$/);
    if(m&&req.method==='GET'){
      authorize(req,'user');const job=requireJob(m[1]);assert(HASH.test(m[2]),400,'결과 파일 ID를 확인하세요.');
      assert(['awaiting_phone','download_ready','deadline_exceeded'].includes(job.state)&&job.artifacts?.length,409,'검토와 결과물 준비가 끝나지 않았습니다.');
      assert(!job.artifactsExpired&&clock()-Date.parse(job.completedAt)<=24*3600_000,410,'결과물 보관 기간(24시간)이 지났습니다.');
      const artifact=job.artifacts?.find(a=>a.id===m[2]);assert(artifact,404,'결과 파일이 없습니다.');
      const target=fileName(job.id,artifact.id);const bytes=await transfers.read(target);
      assert(bytes,404,'결과 파일을 찾을 수 없습니다.');
      assert(sha(bytes)===artifact.sha256&&bytes.length===artifact.bytes,409,'저장된 파일 무결성 확인에 실패했습니다.');
      res.writeHead(200,{'Content-Type':artifact.mime,'Content-Length':bytes.length,'Cache-Control':'no-store','Content-Disposition':`attachment; filename="result"; filename*=UTF-8''${encodeURIComponent(artifact.filename)}`});res.end(bytes);return true;
    }
    m=path.match(/^\/api\/phone\/jobs\/([^/]+)\/received$/);
    if(m&&req.method==='POST'){
      authorize(req,'user');assert(req.phoneId,403,'휴대폰에서 저장을 확인해야 합니다.');const job=requireJob(m[1]);const data=await bodyOf(req);
      const overnightJob=isOvernight(job);
      const expected=overnightJob
        ? (['awaiting_phone','download_ready','deadline_exceeded'].includes(job.state) ? job.artifacts : null)
        : (['download_ready','dry_run','submitted','send_unknown'].includes(job.state)&&['download','both'].includes(job.request?.delivery)&&HASH.test(job.artifact?.sha256||'')
          ? [{id:job.artifact.sha256,sha256:job.artifact.sha256}] : null);
      assert(expected?.length,409,'준비된 결과물이 없습니다.');
      assert(Array.isArray(data.artifacts)&&data.artifacts.length===expected.length&&new Set(data.artifacts.map(a=>a.id)).size===expected.length&&expected.every(a=>data.artifacts.some(r=>r.id===a.id&&r.sha256===a.sha256)),409,'모든 파일의 저장과 무결성 확인이 필요합니다.');
      const savedAt=Date.parse(data.savedAt);assert(Number.isFinite(savedAt)&&Math.abs(clock()-savedAt)<24*3600_000,400,'저장 시각을 확인하세요.');
      if(!job.phoneReceipts)job.phoneReceipts={};job.phoneReceipts[req.phoneId]={savedAt:new Date(savedAt).toISOString(),confirmedAt:stamp()};
      const confirmedAt=clock();
      if(overnightJob&&job.state==='awaiting_phone'){
        job.state=confirmedAt<=Date.parse(job.request.deadlineAt)?'download_ready':'deadline_exceeded';
        job.stage=job.state;
      }
      job.phoneSavedAt=new Date(confirmedAt).toISOString();
      event(job,!overnightJob?'단일 문서를 갤럭시에 저장하고 해시 검증을 확인했습니다.':job.state==='download_ready'?'완료 기한 전에 갤럭시 저장과 해시 검증을 확인했습니다.':'갤럭시에 저장했지만 완료 기한 이후라 기한 내 완료로 표시하지 않습니다.');
      save(job);json(res,200,{ok:true,phoneSavedAt:job.phoneSavedAt,onTime:!overnightJob||job.state==='download_ready'});return true;
    }
    return false;
  }
  return {authenticatePhone,refresh,cleanExpiredTransfers,create,claim,result,handle,publicJob};
}
