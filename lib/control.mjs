import {transferHash,transferSize,isEnvelope,inspectEnvelope} from './e2ee.mjs';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, mkdirSync, statSync, createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { dirname, resolve, basename } from 'node:path';
import { createOvernightControl } from './overnight-control.mjs';
import { createIncomingControl } from './incoming-control.mjs';
import { createDeliveryControl } from './delivery-control.mjs';
import { createLocalTransferStore } from './transfer-store.mjs';
import { createPushDispatcher } from './push-dispatcher.mjs';
import { createFinancialControl } from './financial-control.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FILE_ID = /^[a-f0-9]{64}$/;
const EMAIL = /^[^\s@<>\r\n,;]+@[^\s@<>\r\n,;]+\.[^\s@<>\r\n,;]+$/;
const EDITABLE_TEXT_EXTENSIONS = new Set(['.txt','.md','.py','.json','.js','.mjs','.cjs','.ts','.tsx','.jsx','.java','.kt','.go','.rs','.c','.h','.cpp','.cc','.cs','.php','.rb','.swift','.sh','.ps1','.bat','.cmd','.sql','.yaml','.yml','.toml','.xml','.html','.css','.gradle','.kts','.properties']);
const FINAL = new Set(['dry_run', 'submitted', 'send_unknown', 'failed', 'download_ready', 'needs_attention', 'deadline_exceeded', 'pc_saved']);
const PUBLIC_FILES = new Map([
  ['/', ['../public/index.html', 'text/html; charset=utf-8']],
  ['/console', ['../public/console.html', 'text/html; charset=utf-8']],
  ['/demo', ['../public/demo/index.html', 'text/html; charset=utf-8']],
  ['/demo/', ['../public/demo/index.html', 'text/html; charset=utf-8']],
  ['/demo/demo.mjs', ['../public/demo/demo.mjs', 'text/javascript; charset=utf-8']],
  ['/demo/scenario.mjs', ['../public/demo/scenario.mjs', 'text/javascript; charset=utf-8']],
  ['/demo/demo.css', ['../public/demo/demo.css', 'text/css; charset=utf-8']],
  ['/demo/pc.css', ['../financial-documents/review-ui/review.css', 'text/css; charset=utf-8']],
  ['/landing.css', ['../public/landing.css', 'text/css; charset=utf-8']],
  ['/diana-logo.png', ['../public/diana-logo.png', 'image/png']],
  ['/downloads/DIANA-0.3.9.apk', ['../public/downloads/DIANA-0.3.9.apk', 'application/vnd.android.package-archive', 'DIANA-0.3.9.apk']],
  ['/downloads/DIANA-PC-0.3.6-win-x64.zip', ['../public/downloads/DIANA-PC-0.3.6-win-x64.zip', 'application/zip', 'DIANA-PC-0.3.6-win-x64.zip']],
  ['/downloads/DIANA-Android-0.8.0-dev-paired2.apk', ['../public/downloads/DIANA-Android-0.8.0-dev-paired2.apk', 'application/vnd.android.package-archive', 'DIANA-Android-0.8.0-dev-paired2.apk']],
  ['/downloads/DIANA-PC-0.8.0-dev-paired2-win-x64.zip', ['../public/downloads/DIANA-PC-0.8.0-dev-paired2-win-x64.zip', 'application/zip', 'DIANA-PC-0.8.0-dev-paired2-win-x64.zip']],
  ['/downloads/DIANA-Android-0.8.0-dev-paired3.apk', ['../public/downloads/DIANA-Android-0.8.0-dev-paired3.apk', 'application/vnd.android.package-archive', 'DIANA-Android-0.8.0-dev-paired3.apk']],
  ['/downloads/DIANA-PC-0.8.0-dev-paired3-win-x64.zip', ['../public/downloads/DIANA-PC-0.8.0-dev-paired3-win-x64.zip', 'application/zip', 'DIANA-PC-0.8.0-dev-paired3-win-x64.zip']],
  ['/downloads/DIANA-Android-0.8.0-dev-paired4.apk', ['../public/downloads/DIANA-Android-0.8.0-dev-paired4.apk', 'application/vnd.android.package-archive', 'DIANA-Android-0.8.0-dev-paired4.apk']],
  ['/downloads/DIANA-PC-0.8.0-dev-paired4-win-x64.zip', ['../public/downloads/DIANA-PC-0.8.0-dev-paired4-win-x64.zip', 'application/zip', 'DIANA-PC-0.8.0-dev-paired4-win-x64.zip']],
  ['/downloads/DIANA-Android-0.8.0-dev-paired5.apk', ['../public/downloads/DIANA-Android-0.8.0-dev-paired5.apk', 'application/vnd.android.package-archive', 'DIANA-Android-0.8.0-dev-paired5.apk']],
  ['/downloads/DIANA-PC-0.8.0-dev-paired5-win-x64.zip', ['../public/downloads/DIANA-PC-0.8.0-dev-paired5-win-x64.zip', 'application/zip', 'DIANA-PC-0.8.0-dev-paired5-win-x64.zip']],
  ['/downloads/DIANA-Android-0.8.0-dev-paired6.apk', ['../public/downloads/DIANA-Android-0.8.0-dev-paired6.apk', 'application/vnd.android.package-archive', 'DIANA-Android-0.8.0-dev-paired6.apk']],
  ['/downloads/DIANA-PC-0.8.0-dev-paired6-win-x64.zip', ['../public/downloads/DIANA-PC-0.8.0-dev-paired6-win-x64.zip', 'application/zip', 'DIANA-PC-0.8.0-dev-paired6-win-x64.zip']],
  ['/downloads/DIANA-Android-0.8.0-dev-paired7.apk', ['../public/downloads/DIANA-Android-0.8.0-dev-paired7.apk', 'application/vnd.android.package-archive', 'DIANA-Android-0.8.0-dev-paired7.apk']],
  ['/downloads/DIANA-PC-0.8.0-dev-paired7-win-x64.zip', ['../public/downloads/DIANA-PC-0.8.0-dev-paired7-win-x64.zip', 'application/zip', 'DIANA-PC-0.8.0-dev-paired7-win-x64.zip']],
  ['/downloads/DIANA-Android-0.8.0-dev-paired8.apk', ['../public/downloads/DIANA-Android-0.8.0-dev-paired8.apk', 'application/vnd.android.package-archive', 'DIANA-Android-0.8.0-dev-paired8.apk']],
  ['/downloads/DIANA-PC-0.8.0-dev-paired8-win-x64.zip', ['../public/downloads/DIANA-PC-0.8.0-dev-paired8-win-x64.zip', 'application/zip', 'DIANA-PC-0.8.0-dev-paired8-win-x64.zip']],
  ['/downloads/DIANA-Android-0.8.0-dev-paired9.apk', ['../public/downloads/DIANA-Android-0.8.0-dev-paired9.apk', 'application/vnd.android.package-archive', 'DIANA-Android-0.8.0-dev-paired9.apk']],
  ['/downloads/DIANA-PC-0.8.0-dev-paired9-win-x64.zip', ['../public/downloads/DIANA-PC-0.8.0-dev-paired9-win-x64.zip', 'application/zip', 'DIANA-PC-0.8.0-dev-paired9-win-x64.zip']],
  ['/downloads/DIANA-Android-0.8.0-dev-paired10.apk', ['../public/downloads/DIANA-Android-0.8.0-dev-paired10.apk', 'application/vnd.android.package-archive', 'DIANA-Android-0.8.0-dev-paired10.apk']],
  ['/downloads/DIANA-PC-0.8.0-dev-paired10-win-x64.zip', ['../public/downloads/DIANA-PC-0.8.0-dev-paired10-win-x64.zip', 'application/zip', 'DIANA-PC-0.8.0-dev-paired10-win-x64.zip']],
  ['/downloads/DIANA-Android-0.8.0-dev-paired11.apk', ['../public/downloads/DIANA-Android-0.8.0-dev-paired11.apk', 'application/vnd.android.package-archive', 'DIANA-Android-0.8.0-dev-paired11.apk']],
  ['/downloads/DIANA-PC-0.8.0-dev-paired11-win-x64.zip', ['../public/downloads/DIANA-PC-0.8.0-dev-paired11-win-x64.zip', 'application/zip', 'DIANA-PC-0.8.0-dev-paired11-win-x64.zip']],
  ['/downloads/releases.json', ['../public/downloads/releases.json', 'application/json; charset=utf-8']],
  ['/app.js', ['../public/app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['../public/style.css', 'text/css; charset=utf-8']],
]);
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
function assert(condition, status, message) { if (!condition) throw new HttpError(status, message); }
function bounded(value, max, label) {
  assert(typeof value === 'string' && value.trim().length > 0 && value.length <= max, 400, `${label} 형식을 확인하세요.`);
  return value.trim();
}
function sameToken(actual, expected) {
  const hash = value => createHash('sha256').update(value).digest();
  return typeof actual === 'string' && timingSafeEqual(hash(actual), hash(expected));
}
async function bodyOf(req, maxBytes = 64 * 1024) {
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    assert(size <= maxBytes, 413, '요청이 너무 큽니다.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, '올바른 JSON 요청이 필요합니다.'); }
}
async function rawBinaryOf(req) {
  let bytes = 0; const chunks = [];
  for await (const chunk of req) { bytes += chunk.length; assert(bytes <= 15*1024*1024, 413, '파일은 10MB 이하여야 합니다.'); chunks.push(chunk); }
  assert(bytes > 0, 400, '비어 있는 파일입니다.'); return Buffer.concat(chunks);
}

/** Single-owner prototype. Deploy behind HTTPS; keep tokens distinct. */
export function createControlServer(options) {
  const binaryOf=async req=>{const bytes=await rawBinaryOf(req);
    if(!isEnvelope(bytes)){assert(options.allowLegacyPlaintextTransfers===true,409,'암호화된 파일 전송이 필요합니다. 앱을 업데이트하고 기기를 다시 연결하세요.');assert(bytes.length<=10*1024*1024,413,'파일은 10MB 이하여야 합니다.');return bytes;}
    const meta=inspectEnvelope(bytes).meta,match=req.url.match(/^\/api\/(?:agent\/jobs|uploads|deliveries)\/([^/?]+)/);
    assert(meta.bytes<=10*1024*1024,413,'파일은 10MB 이하여야 합니다.');
    assert(match&&meta.id===match[1]&&meta.direction===(req.url.startsWith('/api/uploads/')?'phone-pc':'pc-phone'),409,'암호화 전송 대상이 일치하지 않습니다.');
    if(req.headers['x-file-name'])assert(meta.filename===decodeURIComponent(req.headers['x-file-name']),409,'암호화 파일명이 일치하지 않습니다.');return bytes;
  };
  const { userToken, agentToken, gatewayToken, deviceId = 'home-pc', appOrigin = '', dbPath = ':memory:' } = options;
  const transferDir = resolve(options.transferDir || '.local/transfers');
  const transfers = options.transfers || createLocalTransferStore(transferDir);
  const tokens = [userToken, agentToken, gatewayToken];
  assert(tokens.every(t => typeof t === 'string' && t.length >= 32), 500, '서로 다른 32자 이상 토큰 3개가 필요합니다. npm run setup을 실행하세요.');
  assert(new Set(tokens).size === 3, 500, '사용자·PC·게이트웨이 토큰은 서로 달라야 합니다.');
  assert(/^[a-zA-Z0-9_-]{1,64}$/.test(deviceId), 500, 'DEVICE_ID를 확인하세요.');
  if (!options.db && dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = options.db || new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const clock = options.now || Date.now;
  const now = () => new Date(clock()).toISOString();
  const get = id => { const row = db.prepare('SELECT data FROM jobs WHERE id=?').get(id); return row ? JSON.parse(row.data) : null; };
  const all = () => db.prepare('SELECT data FROM jobs ORDER BY rowid DESC').all().map(row => JSON.parse(row.data));
  const save = job => {
    job.updatedAt = now();
    db.prepare('INSERT INTO jobs(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(job.id, JSON.stringify(job));
    return job;
  };
  const event = (job, text) => { job.events.push({ at: now(), text }); job.events = job.events.slice(-30); };
  const rates = new Map();
  function authorize(req, role) {
    const expected = { user: userToken, owner: userToken, agent: agentToken, gateway: gatewayToken }[role];
    const actual = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '';
    if (!sameToken(actual, expected)) {
      const phoneId = role === 'user' ? overnight.authenticatePhone(actual) : null;
      assert(phoneId, 401, '연결 토큰이 맞지 않습니다.'); req.phoneId = phoneId;
    }
    if (req.headers.origin) {
      const allowed = appOrigin || `http://127.0.0.1:${server.address()?.port}`;
      assert(req.headers.origin === allowed, 403, '허용되지 않은 요청 출처입니다.');
    }
    const key = `${role}:${req.socket.remoteAddress}`;
    const minute = Math.floor(clock() / 60_000);
    const rate = rates.get(key);
    if (!rate || rate.minute !== minute) rates.set(key, { minute, count: 1 });
    else { rate.count++; assert(rate.count <= 240, 429, '잠시 후 다시 요청하세요.'); }
    if (rates.size > 1000) for (const [k, v] of rates) if (v.minute !== minute) rates.delete(k);
  }
  function requireJob(id) {
    assert(UUID.test(id), 400, '작업 ID 형식을 확인하세요.');
    const job = get(id); assert(job, 404, '작업을 찾을 수 없습니다.'); return job;
  }
  function json(res, status, value) {
    // A successful response must not outrun its durable Postgres commit.
    void (async () => {
      try {
        await db.flush?.();
        pushNotifications.kick();
        if (res.destroyed) return;
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(value));
      } catch {
        if (res.destroyed || res.headersSent) return res.end();
        res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: '작업 기록을 영구 저장하지 못했습니다. 서버 상태를 확인하세요.' }));
      }
    })();
  }
  // All creation routes share one lock: a relay Storage await must not let a
  // different endpoint create the same job ID and overwrite its immutable data.
  let creatingJob = Promise.resolve();
  const withJobWriteLock = async action => {
    const previous = creatingJob;
    let release;
    creatingJob = new Promise(resolve => { release = resolve; });
    await previous;
    try { return await action(); } finally { release(); }
  };
  const suppliedFirebase = options.push?.publicConfig;
  const firebaseConfig = suppliedFirebase?.enabled === true
    ? {enabled:true, ...Object.fromEntries(['applicationId','apiKey','projectId','senderId'].map(key => [key,suppliedFirebase[key]]))}
    : {enabled:false};
  const overnight = createOvernightControl({ db, all, save, event, requireJob, authorize, json, bodyOf, binaryOf, assert, bounded, deviceId, transfers, clock, pairingSecret: userToken, firebaseConfig });
  const pushNotifications = createPushDispatcher({ db, allJobs:all, sender:options.push?.sender, now:clock, pollMs:options.pushPollMs ?? 15_000 });
  const incoming = createIncomingControl({ db, all, save, event, requireJob, authorize, json, bodyOf, binaryOf, assert, deviceId, transfers, clock, withJobWriteLock });
  const delivery = createDeliveryControl({ all, save, authorize, json, binaryOf, assert, deviceId, transfers, clock, withJobWriteLock });
  const financial = createFinancialControl({ db, authorize, json, deviceId, clock });
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const { pathname } = new URL(req.url, 'http://localhost');
      if ((req.method === 'GET' || req.method === 'HEAD') && PUBLIC_FILES.has(pathname)) {
        const [path, type, downloadName] = PUBLIC_FILES.get(pathname);
        const file = new URL(path, import.meta.url);
        const content = downloadName ? null : readFileSync(file);
        res.writeHead(200, { 'Content-Type': type, 'Content-Length': downloadName ? statSync(file).size : content.length, 'Cache-Control': 'no-store',
          ...(downloadName ? { 'Content-Disposition': `attachment; filename="${downloadName}"` } : {}) });
        if (req.method === 'HEAD') return res.end();
        if (downloadName) { try { await pipeline(createReadStream(file), res); } catch { res.destroy(); } return; }
        return res.end(content);
      }
      // A prior Postgres outage must be repaired before this request can read
      // or modify the in-memory view. The failed transaction is replayed first.
      await db.recover?.();
      if (await financial.handle(req, res, pathname)) return;
      if (pathname === '/api/health' && req.method === 'GET') return json(res, 200, { ok: true, persistence: options.db ? 'supabase' : 'sqlite-local' });
      if (pathname === '/api/phone/push-status' && req.method === 'GET') { authorize(req,'owner'); return json(res,200,pushNotifications.status()); }
      overnight.refresh();
      incoming.refresh();
      if (await incoming.handle(req, res, pathname)) return;
      if (await delivery.handle(req, res, pathname)) return;
      if (await overnight.handle(req, res, pathname)) return;
      if (pathname === '/api/jobs' && req.method === 'POST') {
        authorize(req, 'user');
        const data = await bodyOf(req);
        return await withJobWriteLock(async () => {
          assert(UUID.test(data.requestId || ''), 400, '재전송을 구분할 requestId(UUID)가 필요합니다.');
          if (data.kind === 'overnight') return overnight.create(req, res, data);
          assert(data.kind === undefined || data.kind === 'search', 400, '지원하지 않는 작업 종류입니다.');
          const query = bounded(data.query, 1000, '찾을 문서 설명');
          const delivery = data.delivery || 'email';
          assert(['email','download','both'].includes(delivery), 400, '전달 방식을 선택하세요.');
          const recipient = delivery === 'download' ? '' : bounded(data.recipient, 254, '받는 메일 주소');
          assert(delivery === 'download' || EMAIL.test(recipient), 400, '받는 메일 주소는 한 개의 올바른 주소여야 합니다.');
          const subject = data.subject ? bounded(data.subject, 160, '메일 제목') : '요청하신 문서';
          assert(!/[\r\n]/.test(subject), 400, '메일 제목에 줄바꿈을 넣을 수 없습니다.');
          assert(data.autoSend === undefined || typeof data.autoSend === 'boolean', 400, '자동 발송 설정을 확인하세요.');
          const editInstruction = data.editInstruction ? bounded(data.editInstruction, 2000, '수정 요청') : '';
          const request = { query, recipient, subject, autoSend: data.autoSend === true, delivery, editInstruction };
          const previous = get(data.requestId);
          if (previous) {
            assert(JSON.stringify(previous.request) === JSON.stringify(request), 409, '같은 요청 ID로 다른 작업을 만들 수 없습니다.');
            return json(res, 200, { job: previous, duplicate: true });
          }
          assert(all().filter(j => !FINAL.has(j.state)).length < 20, 429, '대기 작업이 많습니다. 기존 작업을 먼저 확인하세요.');
          const job = save({ id: data.requestId, deviceId, request, state: 'waiting_pc', candidates: [], selectedId: null, mode: null,
            wakeStatus: 'pending', events: [{ at: now(), text: '요청을 등록했습니다. PC 연결을 기다립니다.' }], createdAt: now() });
          return json(res, 201, { job });
        });
      }
      if (pathname === '/api/jobs' && req.method === 'GET') {
        authorize(req, 'user');
        const seen = db.prepare("SELECT value FROM settings WHERE key='agentLastSeenAt'").get()?.value || null;
        return json(res, 200, { jobs: all().slice(0, 50).map(overnight.publicJob), device: { id: deviceId, lastSeenAt: seen } });
      }
      let match = pathname.match(/^\/api\/jobs\/([^/]+)\/selection$/);
      if (match && req.method === 'POST') {
        authorize(req, 'user'); const job = requireJob(match[1]); const data = await bodyOf(req);
        assert(!['upload','delivery'].includes(job.kind), 409, '이 전송 작업에는 파일 선택을 적용할 수 없습니다.');
        assert(job.state === 'needs_selection', 409, '파일을 선택할 수 있는 상태가 아닙니다.');
        assert(data.approve === true, 400, '선택한 파일의 발송 요청이 필요합니다.');
        assert(job.candidates.some(c => c.id === data.candidateId), 400, '표시된 후보에서 파일을 선택하세요.');
        job.selectedId = data.candidateId; job.state = 'ready_to_send';
        event(job, '선택한 파일의 발송을 요청했습니다.'); return json(res, 200, { job: save(job) });
      }
      match = pathname.match(/^\/api\/jobs\/([^/]+)\/file$/);
      if (match && req.method === 'GET') {
        authorize(req, 'user'); const job = requireJob(match[1]);
        assert(job.kind !== 'upload', 409, '휴대폰 업로드 파일은 PC 수신 경로에서만 받을 수 있습니다.');
        assert(job.artifact, 404, '아직 휴대폰으로 받을 파일이 준비되지 않았습니다.');
        if (job.artifact.expired || clock() - Date.parse(job.artifact.createdAt) > 24 * 3600_000) {
          throw new HttpError(410, '다운로드 보관 기간(24시간)이 지났습니다. 새로 요청하세요.');
        }
        const file = await transfers.read(job.id + '.bin');
        assert(file, 404, '중계 파일을 찾을 수 없습니다. 새로 요청하세요.');
        assert(transferHash(file) === job.artifact.sha256, 409, '파일 무결성 확인에 실패했습니다.');
        res.writeHead(200, { 'Content-Type':'application/octet-stream', 'Content-Disposition':`attachment; filename="document"; filename*=UTF-8''${encodeURIComponent(job.artifact.filename)}`, 'Content-Length':file.length,'Cache-Control':'no-store' });
        return res.end(file);
      }
      if (pathname === '/api/agent/next' && req.method === 'GET') {
        authorize(req, 'agent');
        db.prepare("INSERT INTO settings(key,value) VALUES('agentLastSeenAt',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(now());
        const queue = all().reverse().filter(job => !['upload','delivery'].includes(job.kind));
        const overnightJob = overnight.claim(queue);
        if (overnightJob) return json(res, 200, { job: overnightJob });
        // Re-deliver an interrupted claim. The PC's persistent mail ledger
        // prevents a repeated send after a lost network response or restart.
        const job = queue.find(j => j.state === 'sending') || queue.find(j => j.state === 'searching')
          || queue.find(j => j.state === 'ready_to_send') || queue.find(j => j.state === 'waiting_pc');
        if (!job) return json(res, 200, { job: null });
        const action = ['ready_to_send', 'sending'].includes(job.state) ? 'send' : 'search';
        job.state = action === 'send' ? 'sending' : 'searching';
        event(job, action === 'send' ? 'PC에서 발송 처리를 시작했습니다.' : 'PC가 연결되어 문서 내용을 검색합니다.'); save(job);
        return json(res, 200, { job: { id: job.id, deviceId, action, ...job.request, candidateId: job.selectedId } });
      }
      match = pathname.match(/^\/api\/agent\/jobs\/([^/]+)\/(candidates|result|error)$/);
      if (match && req.method === 'POST') {
        authorize(req, 'agent'); const job = requireJob(match[1]); const data = await bodyOf(req);
        assert(!['upload','delivery'].includes(job.kind), 409, '직접 전송 작업에는 검색·수정 처리를 적용할 수 없습니다.');
        if (match[2] === 'candidates') {
          assert(['lexical', 'openai'].includes(data.mode), 400, '검색 모드를 확인하세요.');
          assert(Array.isArray(data.candidates) && data.candidates.length <= 10, 400, '문서 후보는 10개 이하여야 합니다.');
          const candidates = data.candidates.map(c => {
            assert(FILE_ID.test(c.id || ''), 400, '문서 ID 형식을 확인하세요.');
            assert(typeof c.score === 'number' && c.score >= 0 && c.score <= 1, 400, '문서 점수를 확인하세요.');
            assert(FILE_ID.test(c.sha256 || ''), 400, '문서 해시를 확인하세요.');
            return { id: c.id, sha256:c.sha256, filename: bounded(c.filename, 255, '파일명'), modifiedAt: String(c.modifiedAt || '').slice(0, 50),
              bytes: Number.isSafeInteger(c.bytes) && c.bytes >= 0 ? c.bytes : 0,
              excerpt: String(c.excerpt || '').slice(0, 1200), reason: String(c.reason || '').slice(0, 600), score: c.score };
          });
          assert(new Set(candidates.map(c => c.id)).size === candidates.length, 400, '문서 후보 ID가 중복되었습니다.');
          // A lost HTTP response may cause a safe replay of the same result.
          if (job.state !== 'searching') {
            assert(JSON.stringify(job.candidates) === JSON.stringify(candidates) && job.mode === data.mode, 409, '이미 다른 검색 결과를 처리했습니다.');
            return json(res, 200, { job, duplicate: true });
          }
          job.candidates = candidates; job.mode = data.mode;
          if (candidates.length === 0) { job.state = 'failed'; event(job, '조건에 맞는 문서를 찾지 못했습니다.'); }
          else if (job.request.autoSend && candidates.length === 1 && candidates[0].score >= 0.95 && data.mode === 'openai') {
            job.state = 'ready_to_send'; job.selectedId = candidates[0].id; event(job, '설정한 자동 발송 조건에 맞는 후보 1개를 찾았습니다.');
          } else { job.state = 'needs_selection'; event(job, `${candidates.length}개 후보를 찾았습니다. 보낼 파일을 선택하세요.`); }
          return json(res, 200, { job: save(job) });
        }
        if (match[2] === 'result') {
          if (job.kind === 'overnight') return overnight.result(res, job, data);
          assert(FINAL.has(data.status) && data.status !== 'pc_saved', 400, '전송 결과 상태를 확인하세요.');
          if (FINAL.has(job.state)) {
            assert(job.state === data.status, 409, '이미 다른 결과로 끝난 작업입니다.');
            return json(res, 200, { job, duplicate: true });
          }
          assert(job.state === 'sending', 409, '발송 중인 작업이 아닙니다.');
          job.state = data.status; job.messageId = String(data.messageId || '').slice(0, 300);
          job.error = data.error ? String(data.error).slice(0, 500) : null;
          if (data.status === 'download_ready') assert(job.artifact && job.request.delivery === 'download', 409, '다운로드 파일이 준비되지 않았습니다.');
          const label = { download_ready:'휴대폰에 저장할 파일이 준비되었습니다.', dry_run: '연습 메일(.eml)을 PC에 저장했습니다. 실제 발송은 하지 않았습니다.',
            submitted: '메일 서버가 발송 요청을 접수했습니다. 수신함 도착 확인은 별도입니다.',
            send_unknown: '메일 발송 결과가 불명확합니다. 중복을 피하기 위해 자동 재발송하지 않습니다.', failed: '작업에 실패했습니다.' }[data.status];
          event(job, label); return json(res, 200, { job: save(job) });
        }
        assert(['searching', 'sending', 'processing'].includes(job.state), 409, '실행 중인 작업이 아닙니다.');
        job.state = job.state === 'sending' ? 'send_unknown' : 'failed';
        job.error = String(data.error || 'PC 작업 오류').slice(0, 500);
        event(job, 'PC 작업이 중단되었습니다. 상세 상태를 확인하세요.'); return json(res, 200, { job: save(job) });
      }
      match = pathname.match(/^\/api\/agent\/jobs\/([^/]+)\/file$/);
      if (match && req.method === 'POST') {
        authorize(req, 'agent'); const job = requireJob(match[1]);
        assert(!['upload','delivery'].includes(job.kind), 409, '직접 전송 작업에는 검색·수정 처리를 적용할 수 없습니다.');
        assert(['sending','download_ready','dry_run','submitted','send_unknown'].includes(job.state), 409, '파일을 전달할 수 있는 상태가 아닙니다.');
        assert(['download','both'].includes(job.request.delivery), 409, '휴대폰 저장을 요청한 작업이 아닙니다.');
        const selected = job.candidates.find(c => c.id === job.selectedId);
        assert(selected && req.headers['x-source-file-id'] === selected.id, 409, '선택한 원본 파일이 아닙니다.');
        const hash = req.headers['x-file-sha256']; assert(FILE_ID.test(hash || ''), 400, '파일 해시가 필요합니다.');
        let name; try {name = decodeURIComponent(req.headers['x-file-name'] || '');} catch {throw new HttpError(400,'파일명을 확인하세요.');}
        assert(name && name.length <= 255 && basename(name) === name && !/[\\/\r\n\x00-\x1f]/.test(name),400,'파일명을 확인하세요.');
        if (!job.request.editInstruction) assert(hash === selected.sha256 && name === selected.filename,409,'선택한 파일과 전송 파일이 다릅니다.');
        else {
          const extension = name.slice(name.lastIndexOf('.')).toLowerCase();
          const sourceExtension = selected.filename.slice(selected.filename.lastIndexOf('.')).toLowerCase();
          assert(EDITABLE_TEXT_EXTENSIONS.has(extension) && extension === sourceExtension,400,'수정본은 지원하는 UTF-8 텍스트·코드 형식이어야 합니다.');
        }
        const file = await binaryOf(req);
        assert(transferHash(file) === hash,409,'전송 파일의 해시가 일치하지 않습니다.');
        if (job.artifact) {assert(job.artifact.sha256 === hash && job.artifact.filename === name,409,'이미 다른 결과 파일이 저장되었습니다.'); return json(res,200,{ok:true,duplicate:true});}
        const existing = await transfers.read(job.id + '.bin');
        if (existing) assert(transferHash(existing) === hash,409,'저장된 파일이 다릅니다.');
        else await transfers.put(job.id + '.bin', file);
        job.artifact={filename:name,sha256:hash,bytes:transferSize(file),createdAt:now()}; event(job,'휴대폰에서 받을 파일을 준비했습니다.'); save(job);
        return json(res,200,{ok:true});
      }
      if (pathname === '/api/gateway/wake' && req.method === 'GET') {
        authorize(req, 'gateway');
        const job = all().reverse().find(j => j.wakeStatus === 'pending' && (j.state === 'waiting_pc' || (j.kind === 'overnight' && j.state === 'scheduled' && Date.parse(j.request.startAt) <= clock())));
        return json(res, 200, { job: job ? { id: job.id, deviceId } : null });
      }
      match = pathname.match(/^\/api\/gateway\/wake\/([^/]+)$/);
      if (match && req.method === 'POST') {
        authorize(req, 'gateway'); const job = requireJob(match[1]); const data = await bodyOf(req);
        assert(['signaled', 'dry_run', 'failed'].includes(data.status), 400, '깨우기 상태를 확인하세요.');
        if (job.wakeStatus !== 'pending') return json(res, 200, { ok: true, duplicate: true });
        job.wakeStatus = data.status;
        event(job, { signaled: '깨우기 신호를 보냈습니다. PC 연결을 기다립니다.', dry_run: '연습 모드: 실제 깨우기 신호는 보내지 않았습니다.', failed: '깨우기 신호 전달에 실패했습니다.' }[data.status]);
        save(job); return json(res, 200, { ok: true });
      }
      throw new HttpError(404, '요청 경로를 찾을 수 없습니다.');
    } catch (error) {
      if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : '서버 처리 오류가 발생했습니다.' });
      else res.end();
    }
  });
  let cleaning = null;
  function cleanExpiredTransfers() {
    if (cleaning) return cleaning;
    cleaning = (async () => {
      await db.recover?.();
      overnight.refresh();
      await overnight.cleanExpiredTransfers();
      await incoming.cleanExpiredTransfers();
      for (const { id } of all()) {
        let job = get(id);
        if (!job.artifact || job.artifact.expired || clock()-Date.parse(job.artifact.createdAt)<=24*3600_000) continue;
        const artifact = job.artifact;
        try { await transfers.remove(id + '.bin'); }
        catch { continue; }
        job = get(id);
        if (!job?.artifact || job.artifact.sha256 !== artifact.sha256 || job.artifact.createdAt !== artifact.createdAt) continue;
        job.artifact.expired=true; save(job);
        await db.flush?.();
      }
      await db.flush?.();
    })().finally(() => { cleaning = null; });
    return cleaning;
  }
  void cleanExpiredTransfers().catch(() => {});
  const cleanup=setInterval(()=>{void cleanExpiredTransfers().catch(() => {/* Retry at next interval. */});},60_000);
  cleanup.unref();
  server.requestTimeout = 15_000; server.headersTimeout = 10_000;
  server.on('close', () => {clearInterval(cleanup);pushNotifications.close();db.close();});
  return server;
}
