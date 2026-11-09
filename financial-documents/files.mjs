import path from 'node:path';
import { constants } from 'node:fs';
import { open, lstat, realpath } from 'node:fs/promises';
import { inside, allowedPart } from '../local-ai/files.mjs';
import { checkedDirectory, digest } from '../personal-ai/documents/files.mjs';
import { fail, strictJSON } from './strict-json.mjs';
import {containsSecret} from './security/content.mjs';

const same = (a, b) => a.ino === b.ino && a.dev === b.dev && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const safeStat = stat => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n;

// Same handle/ancestor checks as readDocumentBytes; separate bounded text scope.
// Existing binary parser security and supported extensions remain untouched.
export async function boundedRead(filename, maximum = 262_144, expectedHash = null, internal = false) {
  filename = path.resolve(filename);
  if (!internal && !allowedPart(path.basename(filename))) fail('PATH_DENIED');
  const parent = path.dirname(filename);
  if (internal) {
    const stat = await lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(parent) !== parent) fail('PATH_DENIED');
    await checkedDirectory(path.dirname(parent));
  } else await checkedDirectory(parent);
  const beforePath = await lstat(filename, { bigint: true });
  if (!safeStat(beforePath) || beforePath.size < 1n || beforePath.size > BigInt(maximum) || await realpath(filename) !== filename) fail('FILE_DENIED');
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const before = await handle.stat({ bigint: true });
    if (!safeStat(before) || !same(beforePath, before)) fail('FILE_CHANGED');
    const bytes = Buffer.alloc(Number(before.size) + 1); let count = 0;
    while (count < bytes.length) {
      const read = await handle.read(bytes, count, bytes.length - count, count);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const afterPath = await lstat(filename, { bigint: true });
    if (!safeStat(after) || !safeStat(afterPath) || !same(before, after) || !same(after, afterPath) || count !== Number(before.size) || await realpath(filename) !== filename) fail('FILE_CHANGED');
    if (!internal) await checkedDirectory(parent);
    else {
      if ((await lstat(parent)).isSymbolicLink() || await realpath(parent) !== parent) fail('PATH_DENIED');
      await checkedDirectory(path.dirname(parent));
    }
    let content;
    try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, count)); }
    catch { fail('INVALID_UTF8'); }
    if (!Buffer.from(content, 'utf8').equals(bytes.subarray(0, count))) fail('INVALID_UTF8');
    const hash = digest(bytes.subarray(0, count));
    if (expectedHash && hash !== expectedHash) fail('CONTENT_CHANGED');
    return { content, hash };
  } finally { await handle.close(); }
}

export async function readSelectedText(policy, entry) {
  if (!Number.isInteger(entry.rootIndex) || !policy.roots[entry.rootIndex] || typeof entry.relativePath !== 'string' ||
      path.isAbsolute(entry.relativePath) || entry.relativePath.split(/[\\/]/u).some(p => !allowedPart(p) || p === '..') ||
      !['.md', '.txt', '.json'].includes(path.extname(entry.relativePath).toLowerCase())) fail('PATH_DENIED');
  const root = policy.roots[entry.rootIndex]; const filename = path.resolve(root, entry.relativePath);
  if (!inside(root, filename)) fail('PATH_DENIED');
  const result = await boundedRead(filename);
  if (containsSecret(result.content)) fail('SENSITIVE_CONTENT');
  if (path.extname(filename).toLowerCase() === '.json') strictJSON(result.content);
  return { id: entry.id, version: entry.version, classification: entry.classification,
    format: path.extname(filename).slice(1).toLowerCase(), ...result };
}

export async function verifyOpenedOutput(handle, filename, output) {
  await checkedDirectory(output);
  const opened = await handle.stat({ bigint: true }); const named = await lstat(filename, { bigint: true });
  if (!safeStat(opened) || !safeStat(named) || opened.ino !== named.ino || opened.dev !== named.dev || await realpath(filename) !== filename) fail('OUTPUT_CHANGED');
}
