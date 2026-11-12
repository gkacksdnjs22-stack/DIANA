import {transferHash,transferSize} from './e2ee.mjs';
import { createHash } from 'node:crypto';
import { isUploadId, validateUploadMetadata } from './upload-contract.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

/** Owner-selected inert bytes for the existing Galaxy download/receipt protocol. */
export function createDeliveryControl({ all, save, authorize, json, binaryOf, assert, deviceId, transfers, clock, withJobWriteLock }) {
  const stamp = () => new Date(clock()).toISOString();
  const metadata = data => {
    try { return validateUploadMetadata(data); }
    catch (error) { assert(false, 400, error.message); }
  };
  const sameFile = (left, right) => left?.filename === right.filename && left?.sha256 === right.sha256 && left?.bytes === right.bytes;
  async function handle(req, res, path) {
    const match = path.match(/^\/api\/deliveries\/([^/]+)$/);
    if (!match || req.method !== 'POST') return false;
    // Paired phones may receive these files, but cannot authorize new deliveries.
    authorize(req, 'owner');
    const id = match[1];
    assert(isUploadId(id), 400, '전송 ID 형식을 확인하세요.');
    let filename;
    try { filename = decodeURIComponent(req.headers['x-file-name'] || ''); }
    catch { assert(false, 400, '파일명을 확인하세요.'); }
    metadata({ filename, sha256:req.headers['x-file-sha256'], bytes:1 });
    const bytes = await binaryOf(req);
    const file = metadata({ filename, sha256:req.headers['x-file-sha256'], bytes:transferSize(bytes) });
    assert(transferHash(bytes) === file.sha256, 409, '전송 파일의 해시가 일치하지 않습니다.');
    await withJobWriteLock(async () => {
      const previous = all().find(job => job.id === id);
      if (previous) {
        assert(previous.kind === 'delivery' && sameFile(previous.artifact, file), 409, '같은 전송 ID로 다른 파일이나 작업을 만들 수 없습니다.');
        json(res, 200, { job:previous, duplicate:true }); return;
      }
      await transfers.put(id + '.bin', bytes);
      const mime = /\.apk$/i.test(filename) ? 'application/vnd.android.package-archive' : 'application/octet-stream';
      const job = save({ id, deviceId, kind:'delivery',
        request:{ query:'휴대폰으로 보내기 · ' + filename, delivery:'download', subject:filename },
        state:'download_ready', wakeStatus:'skipped',
        artifact:{ ...file, mime, createdAt:stamp() },
        // Existing Galaxy clients prefer this manifest and preserve its MIME;
        // artifact keeps their single-file download and acknowledgement route.
        artifacts:[{ id:file.sha256, ...file, mime }],
        createdAt:stamp(), events:[{ at:stamp(), text:'휴대폰에 저장할 파일을 준비했습니다. 갤럭시 저장 확인을 기다립니다.' }] });
      json(res, 201, { job });
    });
    return true;
  }
  return { handle };
}
