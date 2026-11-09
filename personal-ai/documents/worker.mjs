import { parentPort, workerData } from 'node:worker_threads';
import { createRequire, syncBuiltinESMExports } from 'node:module';

// Defense in depth for the trusted parser dependency. This is not an OS sandbox.
// No source filename, credentials, arbitrary command, or caller options reach Kordoc.
const require = createRequire(import.meta.url);
const deny = () => { throw new Error('document_capability_denied'); };
for (const [name, keys] of Object.entries({
  'node:child_process': ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'],
  'node:http': ['request', 'get', 'createServer'], 'node:https': ['request', 'get', 'createServer'],
  'node:http2': ['connect', 'createServer', 'createSecureServer'],
  'node:net': ['connect', 'createConnection', 'createServer'], 'node:tls': ['connect', 'createServer'],
  'node:dgram': ['createSocket'],
})) {
  const module = require(name);
  for (const key of keys) module[key] = deny;
}
require('node:net').Socket.prototype.connect = deny;
globalThis.fetch = deny;
globalThis.WebSocket = class { constructor() { deny(); } };
syncBuiltinESMExports();
process.env.KORDOC_OFFLINE = '1';

try {
  const { parse, VERSION } = await import('kordoc');
  const result = await parse(Buffer.from(workerData.bytes), {
    plain: true, images: false, ocr: false, formulaOcr: false, tableFormat: 'gfm',
  });
  if (result?.success !== true || typeof result.markdown !== 'string') throw new Error('document_parse_failed');
  if (!result.markdown.trim()) throw new Error('document_empty_text');
  if (result.markdown.length > workerData.maxChars) throw new Error('document_output_limit');
  if (/-----BEGIN .*PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{30,})|["']?(?:api[_-]?key|private_key|client_secret|password)["']?\s*[:=]\s*\S+/i.test(result.markdown)) throw new Error('document_sensitive_content');
  parentPort.postMessage({ status: 'ok', markdown: result.markdown, fileType: String(result.fileType).slice(0, 20), version: VERSION,
    // Codes only: warnings can otherwise echo document content.
    warnings: [...new Set((result.warnings || []).map(item => item.code).filter(code => typeof code === 'string' && /^[A-Z_]{1,80}$/.test(code)))].slice(0, 32),
  });
} catch (error) {
  const allowed = ['document_empty_text', 'document_output_limit', 'document_sensitive_content', 'document_parse_failed'];
  parentPort.postMessage({ status: 'error', code: allowed.includes(error?.message) ? error.message : 'document_parse_failed' });
}
