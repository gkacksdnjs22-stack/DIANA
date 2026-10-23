import path from 'node:path';
import { constants } from 'node:fs';
import { lstat, link, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolveDocumentRoot, sha256 } from './documents.mjs';
import { isUploadId, MAX_UPLOAD_BYTES, validateUploadMetadata } from '../lib/upload-contract.mjs';

export const INCOMING_FOLDER = '휴대폰에서_받은파일';
const safeFailure = () => new Error('휴대폰 파일을 저장하지 못했습니다. PC의 수신 폴더와 파일 무결성을 확인하세요.');

async function boundedBody(response, maximum, signal) {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    await response.body?.cancel().catch(() => {});
    throw safeFailure();
  }
  const reader = response.body?.getReader();
  if (!reader) throw safeFailure();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maximum) { await reader.cancel(); throw safeFailure(); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

async function request(config, route, { fetchImpl, signal, body } = {}) {
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000);
  const response = await fetchImpl(config.apiBase + route, {
    method: body ? 'POST' : 'GET', redirect: 'error', signal: requestSignal,
    headers: { Authorization: `Bearer ${config.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { response, requestSignal };
}

async function jsonRequest(config, route, options) {
  const { response, requestSignal } = await request(config, route, options);
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`휴대폰 파일 전송 확인이 지연됐습니다. (HTTP ${response.status})`);
  }
  try { return JSON.parse((await boundedBody(response, 64 * 1024, requestSignal)).toString('utf8')); }
  catch { throw new Error('휴대폰 파일 전송 응답을 확인하지 못했습니다.'); }
}

async function ensureDirectory(directory) {
  await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || path.relative(directory, await realpath(directory)) !== '') throw safeFailure();
}

async function incomingTarget(documentRoot, id, filename) {
  const root = await resolveDocumentRoot(documentRoot);
  const inbox = path.join(root, INCOMING_FOLDER);
  await ensureDirectory(inbox);
  const directory = path.join(inbox, id);
  await ensureDirectory(directory);
  return { root, inbox, directory, filename: path.join(directory, filename) };
}

async function verifyDirectories(target) {
  for (const directory of [target.inbox, target.directory]) {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || path.relative(directory, await realpath(directory)) !== '') throw safeFailure();
  }
}

async function existingFile(target, metadata) {
  await verifyDirectories(target);
  let info;
  try { info = await lstat(target.filename); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.size !== metadata.bytes) throw safeFailure();
  const handle = await open(target.filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size !== metadata.bytes) throw safeFailure();
    // Read only the immutable manifest size, even if another local process grows the file.
    const bytes = Buffer.alloc(metadata.bytes + 1);
    let size = 0;
    while (size < bytes.length) {
      const chunk = await handle.read(bytes, size, bytes.length - size, size);
      if (!chunk.bytesRead) break;
      size += chunk.bytesRead;
    }
    const after = await handle.stat();
    if (size !== metadata.bytes || before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
        sha256(bytes.subarray(0, size)) !== metadata.sha256) throw safeFailure();
    await verifyDirectories(target);
    return true;
  } finally { await handle.close(); }
}

async function publishFile(target, metadata, buffer, signal) {
  await verifyDirectories(target);
  const temporary = path.join(target.directory, `.${randomUUID()}.part`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    try {
      await handle.writeFile(buffer);
      await handle.sync();
    } finally { await handle.close(); }
    signal?.throwIfAborted();
    await verifyDirectories(target);
    // An atomic hard link publishes the fully written bytes without replacing any file.
    try { await link(temporary, target.filename); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (!(await existingFile(target, metadata))) throw safeFailure();
  } finally { await unlink(temporary).catch(() => {}); }
}

/** Receive only authenticated file bytes into a fixed child of DOCUMENT_ROOT. */
export async function receiveIncomingOnce({ config, fetchImpl = fetch, signal } = {}) {
  const { response, requestSignal } = await request(config, '/api/agent/uploads/next', { fetchImpl, signal });
  // The PC can be upgraded before the server without interrupting existing jobs.
  if (response.status === 404) { await response.body?.cancel().catch(() => {}); return { idle: true, unsupported: true }; }
  if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error(`휴대폰 수신 목록을 확인하지 못했습니다. (HTTP ${response.status})`); }
  const next = JSON.parse((await boundedBody(response, 64 * 1024, requestSignal)).toString('utf8'));
  if (next.upload == null) return { idle: true };
  const upload = next.upload;
  if (!isUploadId(upload.id) || upload.deviceId !== config.deviceId) throw new Error('이 PC의 휴대폰 수신 요청이 아닙니다.');
  const metadata = validateUploadMetadata(upload);
  const prefix = `/api/agent/uploads/${upload.id}`;
  let target;
  try {
    target = await incomingTarget(config.documentRoot, upload.id, metadata.filename);
    if (!(await existingFile(target, metadata))) {
      // Download and connection failures remain pending; an ambiguous retry cannot duplicate a local file.
      let download;
      try { download = await request(config, prefix + '/file', { fetchImpl, signal }); }
      catch (error) { error.retryIncoming = true; throw error; }
      if (!download.response.ok) {
        await download.response.body?.cancel().catch(() => {});
        if (download.response.status === 404 || download.response.status === 409 || download.response.status === 410) throw safeFailure();
        const error = new Error('휴대폰 파일 다운로드가 지연됐습니다. 연결 후 다시 시도합니다.');
        error.retryIncoming = true;
        throw error;
      }
      let buffer;
      try { buffer = await boundedBody(download.response, MAX_UPLOAD_BYTES, download.requestSignal); }
      catch (error) { if (download.requestSignal.aborted || error.name === 'TypeError') error.retryIncoming = true; throw error; }
      if (buffer.length !== metadata.bytes || sha256(buffer) !== metadata.sha256) throw safeFailure();
      await publishFile(target, metadata, buffer, signal);
    }
  } catch (error) {
    if (signal?.aborted || error.retryIncoming || error.name === 'TypeError' || error.name === 'TimeoutError' || error.name === 'AbortError') throw error;
    const message = safeFailure().message;
    await jsonRequest(config, prefix + '/failed', { fetchImpl, signal, body: { error: message } });
    return { idle: false, action: 'receive', jobId: upload.id, status: 'failed', error: message };
  }
  signal?.throwIfAborted();
  if (!(await existingFile(target, metadata))) throw safeFailure();
  const receipt = await jsonRequest(config, prefix + '/received', { fetchImpl, signal, body: metadata });
  if (receipt.job?.id !== upload.id || receipt.job.kind !== 'upload' || receipt.job.state !== 'pc_saved' || !receipt.job.pcSavedAt) {
    throw new Error('PC 저장 확인 응답을 확인하지 못했습니다. 같은 파일을 다시 확인합니다.');
  }
  return { idle: false, action: 'receive', jobId: upload.id, status: 'pc_saved' };
}
