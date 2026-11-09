import { Worker } from 'node:worker_threads';
import { documentError, MAX_DOCUMENT_BYTES } from './files.mjs';

export const MAX_MARKDOWN_CHARS = 60_000;

/** Reject large ZIP expansions before the library can decompress them. ZIP64 is out of scope. */
function checkArchive(bytes) {
  if (bytes.readUInt32LE(0) !== 0x04034b50) return;
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) { end = offset; break; }
  }
  if (end < 0) throw documentError('document_archive_invalid');
  const entries = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16); let expanded = 0;
  if (entries === 0xffff || entries > 1500 || offset === 0xffffffff || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) throw documentError('document_archive_limit');
  for (let index = 0; index < entries; index++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) throw documentError('document_archive_invalid');
    const compressed = bytes.readUInt32LE(offset + 20); const size = bytes.readUInt32LE(offset + 24);
    expanded += size;
    if (size === 0xffffffff || compressed === 0xffffffff || expanded > 32 * 1024 * 1024 || size > 8 * 1024 * 1024 || (bytes.readUInt16LE(offset + 8) & 1)) throw documentError('document_archive_limit');
    offset += 46 + bytes.readUInt16LE(offset + 28) + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
  if (offset > end) throw documentError('document_archive_invalid');
}

export async function parseLocalDocument(bytes, { timeoutMs = 15_000 } = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 4 || bytes.length > MAX_DOCUMENT_BYTES ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw documentError('document_parser_input_invalid');
  checkArchive(bytes);
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(new URL('./worker.mjs', import.meta.url), {
      workerData: { bytes, maxChars: MAX_MARKDOWN_CHARS }, execArgv: [],
      env: { KORDOC_OFFLINE: '1' }, stdout: true, stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
    });
    // Parser diagnostics may contain source text. Discard them, never forward to logs.
    worker.stdout.resume(); worker.stderr.resume();
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); void worker.terminate();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(documentError('document_parser_timeout')), timeoutMs);
    worker.once('error', () => finish(documentError('document_parser_failed')));
    worker.once('exit', () => { if (!settled) finish(documentError('document_parser_failed')); });
    worker.once('message', result => {
      if (!result || result.status !== 'ok') return finish(documentError(['document_empty_text', 'document_output_limit', 'document_sensitive_content', 'document_parse_failed'].includes(result?.code) ? result.code : 'document_parser_failed'));
      if (typeof result.markdown !== 'string' || !result.markdown.trim() || result.markdown.length > MAX_MARKDOWN_CHARS ||
          typeof result.fileType !== 'string' || !/^[a-z0-9_-]{1,20}$/i.test(result.fileType) ||
          typeof result.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?$/i.test(result.version) ||
          !Array.isArray(result.warnings) || result.warnings.length > 32 || result.warnings.some(code => typeof code !== 'string' || !/^[A-Z_]{1,80}$/.test(code))) return finish(documentError('document_parser_invalid_response'));
      finish(null, { markdown: result.markdown, fileType: result.fileType, version: result.version, warnings: result.warnings, parser: 'kordoc', offline: true, ocr: false });
    });
  });
}
