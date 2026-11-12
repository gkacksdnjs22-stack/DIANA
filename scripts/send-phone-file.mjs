import {fileCipher} from '../agent/file-cipher.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { isUploadId, MAX_UPLOAD_BYTES, validateUploadMetadata } from '../lib/upload-contract.mjs';

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
// Stable UUIDv8 identifier only, not a key: concurrent retries of the same
// accepted transfer and recipient set converge on the same replacement.
function replacementId(id,recipientIds){
  const bytes=createHash('sha256').update(JSON.stringify(['DIANA delivery replacement v1',id,recipientIds])).digest().subarray(0,16);
  bytes[6]=(bytes[6]&15)|128;bytes[8]=(bytes[8]&63)|128;
  const hex=bytes.toString('hex');return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

/** Explicit owner-selected files only. Accepted incompatible recipients get a stable replacement ID. */
export async function sendPhoneFile(filename, { env = process.env, fetchImpl = fetch,
  stateDir = path.join(PROJECT_ROOT, '.local', 'phone-deliveries'), now = Date.now, cipher,appUpdate=false } = {}) {
  const base = new URL(env.API_BASE_URL || '');
  const loopback = base.hostname === 'localhost' || base.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(base.hostname);
  if ((base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback)) || base.username || base.password || base.search || base.hash || /[?#]/.test(env.API_BASE_URL)) {
    throw new Error('API_BASE_URL에는 HTTPS 서버 주소가 필요합니다.');
  }
  if (!env.USER_TOKEN?.trim() || /[\r\n]/.test(env.USER_TOKEN)) throw new Error('PC의 USER_TOKEN 설정이 필요합니다.');
  const apiBase = base.href.replace(/\/$/, '');
  const input = path.resolve(filename);
  const handle = await open(input, 'r');
  let bytes;
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > MAX_UPLOAD_BYTES) throw new Error('전송할 파일은 비어 있지 않은 10MB 이하 파일이어야 합니다.');
    const buffer = Buffer.alloc(before.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const chunk = await handle.read(buffer, size, buffer.length - size, size);
      if (!chunk.bytesRead) break;
      size += chunk.bytesRead;
    }
    const after = await handle.stat();
    if (size !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('파일이 변경됐습니다. 빌드가 끝난 뒤 다시 전송하세요.');
    bytes = buffer.subarray(0, size);
  } finally { await handle.close(); }
  const metadata = validateUploadMetadata({ filename: path.basename(input), sha256: hash(bytes), bytes: bytes.length });
  if(appUpdate&&!/\.apk$/i.test(metadata.filename))throw Error('공개 앱 업데이트 경로에는 APK만 사용할 수 있습니다.');
  const signature = hash(`${apiBase}\0${hash(env.USER_TOKEN.trim())}\0${metadata.filename}\0${metadata.sha256}${appUpdate?'\0public-app-update':''}`);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const ledger = path.join(stateDir, signature + '.json');
  let saved;
  try { saved = JSON.parse(await readFile(ledger, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('전송 대기 기록을 읽지 못했습니다.'); }
  if (saved && (!isUploadId(saved.id) || !Number.isFinite(Date.parse(saved.createdAt)))) throw new Error('전송 대기 기록을 확인하세요.');
  async function persist(next){
    const temporary = path.join(stateDir, randomUUID() + '.tmp');
    await writeFile(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
    await rename(temporary, ledger);
    saved=next;
  }
  if (!saved || now() - Date.parse(saved.createdAt) >= 24 * 3600_000) await persist({id:randomUUID(),createdAt:new Date(now()).toISOString()});
  const receipt=result=>{
    const job=result?.job;
    if (job?.id !== saved.id || job.kind !== 'delivery' || job.state !== 'download_ready' ||
        job.artifact?.filename !== metadata.filename || job.artifact.sha256 !== metadata.sha256 || job.artifact.bytes !== metadata.bytes ||
        (job.artifact.transferEncoding==='public-app-update')!==appUpdate || job.artifact.expired) {
      throw new Error('DIANA 전송 접수 응답을 확인하지 못했습니다. 같은 명령으로 다시 시도하세요.');
    }
    return { id:job.id,filename:metadata.filename,bytes:metadata.bytes,sha256:metadata.sha256,state:job.state,
      ...(job.phoneSavedAt?{phoneSavedAt:job.phoneSavedAt}:{}),duplicate:result.duplicate===true };
  };
  if(!appUpdate)cipher??=fileCipher({stateDir:env.AGENT_STATE_DIR||path.join(PROJECT_ROOT,'.local'),request:async()=>{const r=await fetchImpl(apiBase+'/api/phone/devices',{headers:{Authorization:'Bearer '+env.USER_TOKEN.trim()},redirect:'error',signal:AbortSignal.timeout(20000)});if(!r.ok)throw Error('휴대폰 연결을 확인하세요.');return r.json();}});
  const checkedReceipt=async result=>{
    const accepted=receipt(result);
    if(appUpdate)return accepted;
    const info=result.ciphertext;
    if(!/^[a-f0-9]{64}$/.test(info?.sha256||'')||!Array.isArray(info.recipientKeyIds)||info.recipientKeyIds.length<1||info.recipientKeyIds.length>32||
       info.recipientKeyIds.some(id=>! /^[a-f0-9]{64}$/.test(id))||new Set(info.recipientKeyIds).size!==info.recipientKeyIds.length)throw Error('저장된 암호문의 수신 기기를 확인하지 못했습니다.');
    const current=await cipher.recipientIds();
    if(!Array.isArray(current)||current.length<1||current.length>32||current.some(id=>! /^[a-f0-9]{64}$/.test(id))||new Set(current).size!==current.length)throw Error('현재 수신 기기를 확인하지 못했습니다.');
    current.sort();
    if(JSON.stringify([...info.recipientKeyIds].sort())===JSON.stringify(current))return accepted;
    // The existing ID is positively accepted for another key set. Keep it intact,
    // persist a stable replacement BEFORE upload, and reconcile it on the next loop.
    await persist({id:replacementId(saved.id,current),createdAt:new Date(now()).toISOString()});
    return null;
  };
  for(let attempt=0;attempt<3;attempt++){
    let body;
    if(appUpdate)body=JSON.stringify(metadata);
    else{
      // A timeout/404/invalid response is NOT proof of non-acceptance. Fail closed.
      // Both the job and actual Storage object must be reconciled by the server.
      const status=await fetchImpl(apiBase+'/api/deliveries/'+saved.id,{method:'GET',redirect:'error',signal:AbortSignal.timeout(20000),headers:{Authorization:'Bearer '+env.USER_TOKEN.trim()}});
      if(!status.ok){await status.body?.cancel().catch(()=>{});throw Error(`DIANA 전송 접수 여부를 확인하지 못했습니다. (HTTP ${status.status})`);}
      const existing=await status.json();
      if(!existing||!Object.hasOwn(existing,'job'))throw Error('DIANA 전송 접수 조회 응답을 확인하지 못했습니다.');
      if(existing.job!==null){const accepted=await checkedReceipt({...existing,duplicate:true});if(accepted)return accepted;continue;}
      if(existing.storageChecked!==true)throw Error('서버 저장소의 미접수 확인이 필요합니다. 서버 버전을 확인하세요.');
      body=await cipher.encrypt(bytes,{id:saved.id,filename:metadata.filename},{unaccepted:true});
    }
    const response = await fetchImpl(apiBase + (appUpdate?'/api/app-updates/':'/api/deliveries/') + saved.id, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(45_000),
      headers: { Authorization: `Bearer ${env.USER_TOKEN.trim()}`, 'Content-Type': appUpdate?'application/json':'application/octet-stream',
        'X-File-Name': encodeURIComponent(metadata.filename), 'X-File-SHA256': metadata.sha256 }, body,
    });
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error(`DIANA 파일 전송을 접수하지 못했습니다. (HTTP ${response.status})`); }
    const accepted=await checkedReceipt(await response.json());if(accepted)return accepted;
  }
  throw Error('전송 중 수신 기기가 변경됐습니다. 연결 상태를 확인한 뒤 같은 명령으로 다시 시도하세요.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2),appUpdate=args[0]==='--app-update';if(appUpdate)args.shift();
  if (args.length !== 1||args[0].startsWith('--')) {
    console.error('사용법: node --env-file=.env scripts/send-phone-file.mjs [--app-update] "전송할 파일 경로"'); process.exitCode = 1;
  } else {
    sendPhoneFile(args[0],{appUpdate}).then(result => {
      console.log(JSON.stringify(result));
      console.log(result.phoneSavedAt ? '갤럭시 저장 확인을 받았습니다.' : 'DIANA에 전송을 접수했습니다. 갤럭시 앱에서 ‘지금 결과 확인’을 누르세요.');
    }).catch(() => { console.error(appUpdate?'공개 배포 APK의 파일·SHA-256·서버 배포 목록을 확인하세요.':'파일 전송을 확인하지 못했습니다. 파일 경로·크기·서버 배포 상태·연결 설정을 확인하세요. 기존 앱 업데이트는 공개 배포 APK와 --app-update를 사용하세요.'); process.exitCode = 1; });
  }
}
