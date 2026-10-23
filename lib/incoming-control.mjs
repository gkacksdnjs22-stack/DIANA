import { createHash } from 'node:crypto';
import { isUploadId, validateUploadMetadata } from './upload-contract.mjs';

const TTL = 24 * 3600_000;
const PENDING = new Set(['waiting_pc', 'receiving_pc']);
const TERMINAL = new Set(['dry_run', 'submitted', 'send_unknown', 'failed', 'download_ready', 'needs_attention', 'deadline_exceeded', 'pc_saved']);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

/** Authenticated phone/owner relay. Files are inert bytes; no remote paths exist. */
export function createIncomingControl({ all, save, event, requireJob, authorize, json, bodyOf, binaryOf, assert, deviceId, transfers, clock, db, withJobWriteLock }) {
  const stamp = () => new Date(clock()).toISOString();
  const fileName = id => `incoming-${id}.bin`;
  const expired = job => job.transferExpired || clock() - Date.parse(job.createdAt) >= TTL;
  const metadata = data => {
    try { return validateUploadMetadata(data); }
    catch (error) { assert(false, 400, error.message); }
  };
  const sameMetadata = (left, right) => left.filename === right.filename && left.sha256 === right.sha256 && left.bytes === right.bytes;
  const requireUpload = id => {
    assert(isUploadId(id), 400, '전송 ID 형식을 확인하세요.');
    const job = requireJob(id);
    assert(job.kind === 'upload', 409, '휴대폰에서 PC로 보내는 작업이 아닙니다.');
    return job;
  };
  // Serializing only relay writes also makes the shared pending-job quota exact.
  let writing = Promise.resolve();
  const withWriteLock = withJobWriteLock || (async action => {
    const previous = writing;
    let release;
    writing = new Promise(resolve => { release = resolve; });
    await previous;
    try { return await action(); } finally { release(); }
  });
  function refresh() {
    for (const job of all()) {
      if (job.kind !== 'upload' || !PENDING.has(job.state) || !expired(job)) continue;
      job.state = 'failed'; job.error = 'PC 수신 대기 기간(24시간)이 지났습니다. 파일을 다시 보내세요.';
      event(job, job.error); save(job);
    }
  }
  let cleaning = null;
  function cleanExpiredTransfers() {
    if (cleaning) return cleaning;
    cleaning = (async () => {
      refresh();
      for (const { id } of all()) {
        let job = requireJob(id);
        if (job.kind !== 'upload' || job.transferExpired || !expired(job)) continue;
        try { await transfers.remove(fileName(id)); } catch { continue; }
        // Preserve a concurrent receipt/failure acknowledgement while merging cleanup.
        job = requireJob(id);
        if (job.kind !== 'upload' || job.transferExpired || !expired(job)) continue;
        job.transferExpired = true; save(job);
        await db.flush?.();
      }
    })().finally(() => { cleaning = null; });
    return cleaning;
  }
  async function handle(req, res, path) {
    let match = path.match(/^\/api\/uploads\/([^/]+)$/);
    if (match && req.method === 'POST') {
      authorize(req, 'user');
      const id = match[1];
      assert(isUploadId(id), 400, '전송 ID 형식을 확인하세요.');
      let filename;
      try { filename = decodeURIComponent(req.headers['x-file-name'] || ''); }
      catch { assert(false, 400, '파일명을 확인하세요.'); }
      // Fail malformed metadata before buffering the payload.
      metadata({ filename, sha256:req.headers['x-file-sha256'], bytes:1 });
      const bytes = await binaryOf(req);
      const request = metadata({ filename, sha256:req.headers['x-file-sha256'], bytes:bytes.length });
      assert(hash(bytes) === request.sha256, 409, '전송 파일의 해시가 일치하지 않습니다.');
      await withWriteLock(async () => {
        const previous = all().find(job => job.id === id);
        if (previous) {
          assert(previous.kind === 'upload' && sameMetadata(previous.request, request), 409, '같은 전송 ID로 다른 파일을 보낼 수 없습니다.');
          json(res, 200, { job:previous, duplicate:true }); return;
        }
        refresh();
        assert(all().filter(job => !TERMINAL.has(job.state)).length < 20, 429, '대기 작업이 많습니다. 기존 작업을 먼저 확인하세요.');
        await transfers.put(fileName(id), bytes);
        const job = save({ id, deviceId, kind:'upload', request, state:'waiting_pc', wakeStatus:'pending', createdAt:stamp(),
          events:[{ at:stamp(), text:'휴대폰 파일을 받았습니다. PC 저장을 기다립니다.' }] });
        json(res, 201, { job });
      });
      return true;
    }
    if (path === '/api/agent/uploads/next' && req.method === 'GET') {
      authorize(req, 'agent'); refresh();
      const job = all().reverse().find(item => item.kind === 'upload' && PENDING.has(item.state) && !expired(item));
      if (!job) { json(res, 200, { upload:null }); return true; }
      if (job.state === 'waiting_pc') {
        job.state = 'receiving_pc'; event(job, 'PC에서 휴대폰 파일 저장을 시작했습니다.'); save(job);
      }
      json(res, 200, { upload:{ id:job.id, deviceId:job.deviceId, ...job.request } }); return true;
    }
    match = path.match(/^\/api\/agent\/uploads\/([^/]+)\/(file|received|failed)$/);
    if (!match) return false;
    const action = match[2];
    if ((action === 'file' && req.method !== 'GET') || (action !== 'file' && req.method !== 'POST')) return false;
    authorize(req, 'agent'); refresh();
    let job = requireUpload(match[1]);
    if (action === 'file') {
      assert(!expired(job), 410, '파일 보관 기간(24시간)이 지났습니다. 휴대폰에서 다시 보내세요.');
      assert(job.state === 'receiving_pc', 409, 'PC에서 수신 중인 작업이 아닙니다.');
      const bytes = await transfers.read(fileName(job.id));
      assert(bytes, 404, '중계 파일을 찾을 수 없습니다. 휴대폰에서 다시 보내세요.');
      assert(bytes.length === job.request.bytes && hash(bytes) === job.request.sha256, 409, '저장된 파일 무결성 확인에 실패했습니다.');
      job = requireUpload(job.id);
      assert(!expired(job), 410, '파일 보관 기간(24시간)이 지났습니다. 휴대폰에서 다시 보내세요.');
      res.writeHead(200, { 'Content-Type':'application/octet-stream', 'Content-Length':bytes.length, 'Cache-Control':'no-store',
        'Content-Disposition':`attachment; filename="incoming"; filename*=UTF-8''${encodeURIComponent(job.request.filename)}` });
      res.end(bytes); return true;
    }
    const data = await bodyOf(req);
    // Reload after the body await so parallel receipts cannot overwrite each other.
    job = requireUpload(job.id);
    if (action === 'received') {
      const received = metadata(data);
      assert(sameMetadata(received, job.request), 409, '원본 파일명·크기·해시와 저장 확인이 일치하지 않습니다.');
      if (job.state === 'pc_saved') { json(res, 200, { job, duplicate:true }); return true; }
      assert(!expired(job), 410, '파일 수신 대기 기간(24시간)이 지났습니다. 다시 보내세요.');
      assert(job.state === 'receiving_pc', 409, 'PC에서 수신 중인 작업이 아닙니다.');
      job.state = 'pc_saved'; job.pcSavedAt = stamp();
      event(job, 'PC에 파일을 저장하고 크기와 해시 검증을 확인했습니다.'); save(job);
      json(res, 200, { job }); return true;
    }
    assert(job.state === 'receiving_pc', 409, 'PC에서 수신 중인 작업이 아닙니다.');
    // The PC sends one bounded public label, never a local path or raw exception.
    assert(typeof data.error === 'string' && data.error.length > 0 && data.error.length <= 200 && !/[\x00-\x1f\x7f-\x9f]/.test(data.error), 400, '파일 저장 오류 안내를 확인하세요.');
    job.state = 'failed'; job.error = 'PC에 파일을 안전하게 저장하지 못했습니다. PC 수신 설정과 저장 공간을 확인한 뒤 다시 보내세요.';
    event(job, 'PC 파일 저장을 마치지 못했습니다. 상세 안내를 확인하세요.'); save(job);
    json(res, 200, { job }); return true;
  }
  return { refresh, cleanExpiredTransfers, handle };
}
