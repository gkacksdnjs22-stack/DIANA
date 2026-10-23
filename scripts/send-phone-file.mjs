import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { isUploadId, MAX_UPLOAD_BYTES, validateUploadMetadata } from '../lib/upload-contract.mjs';

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

/** Explicit owner-selected files only. A replay keeps the same delivery UUID. */
export async function sendPhoneFile(filename, { env = process.env, fetchImpl = fetch,
  stateDir = path.join(PROJECT_ROOT, '.local', 'phone-deliveries'), now = Date.now } = {}) {
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
  const signature = hash(`${apiBase}\0${hash(env.USER_TOKEN.trim())}\0${metadata.filename}\0${metadata.sha256}`);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const ledger = path.join(stateDir, signature + '.json');
  let saved;
  try { saved = JSON.parse(await readFile(ledger, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('전송 대기 기록을 읽지 못했습니다.'); }
  if (saved && (!isUploadId(saved.id) || !Number.isFinite(Date.parse(saved.createdAt)))) throw new Error('전송 대기 기록을 확인하세요.');
  if (!saved || now() - Date.parse(saved.createdAt) >= 24 * 3600_000) {
    saved = { id: randomUUID(), createdAt: new Date(now()).toISOString() };
    const temporary = path.join(stateDir, randomUUID() + '.tmp');
    await writeFile(temporary, JSON.stringify(saved), { mode: 0o600, flag: 'wx' });
    await rename(temporary, ledger);
  }
  const response = await fetchImpl(apiBase + '/api/deliveries/' + saved.id, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(45_000),
    headers: { Authorization: `Bearer ${env.USER_TOKEN.trim()}`, 'Content-Type': 'application/octet-stream',
      'X-File-Name': encodeURIComponent(metadata.filename), 'X-File-SHA256': metadata.sha256 }, body: bytes,
  });
  if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error(`DIANA 파일 전송을 접수하지 못했습니다. (HTTP ${response.status})`); }
  const result = await response.json();
  const job = result.job;
  if (job?.id !== saved.id || job.kind !== 'delivery' || job.state !== 'download_ready' ||
      job.artifact?.filename !== metadata.filename || job.artifact.sha256 !== metadata.sha256 || job.artifact.bytes !== metadata.bytes) {
    throw new Error('DIANA 전송 접수 응답을 확인하지 못했습니다. 같은 명령으로 다시 시도하세요.');
  }
  return { id: job.id, filename: metadata.filename, bytes: metadata.bytes, sha256: metadata.sha256,
    state: job.state, ...(job.phoneSavedAt ? { phoneSavedAt: job.phoneSavedAt } : {}), duplicate: result.duplicate === true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) {
    console.error('사용법: node --env-file=.env scripts/send-phone-file.mjs "전송할 파일 경로"'); process.exitCode = 1;
  } else {
    sendPhoneFile(process.argv[2]).then(result => {
      console.log(JSON.stringify(result));
      console.log(result.phoneSavedAt ? '갤럭시 저장 확인을 받았습니다.' : 'DIANA에 전송을 접수했습니다. 갤럭시 앱에서 ‘지금 결과 확인’을 누르세요.');
    }).catch(() => { console.error('파일 전송을 확인하지 못했습니다. 파일 경로·크기·서버 배포 상태·연결 설정을 확인한 뒤 같은 명령으로 재시도하세요.'); process.exitCode = 1; });
  }
}
