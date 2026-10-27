import path from 'node:path';
import { constants } from 'node:fs';
import { lstat, realpath, open, opendir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { inside, allowedPart } from '../../local-ai/files.mjs';

export const DOCUMENT_EXTENSIONS = Object.freeze(['.hwp', '.hwpx', '.hwpml', '.pdf', '.docx', '.pptx', '.xls', '.xlsx']);
export const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
export const documentError = code => Object.assign(new Error(code), { code });
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');

/** Recheck every existing ancestor, including the configured root, on each use. */
export async function checkedDirectory(directory) {
  const absolute = path.resolve(directory);
  if (absolute.startsWith('\\\\')) throw documentError('document_path_denied');
  const root = path.parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    if (part !== '.local' && !allowedPart(part)) throw documentError('document_path_denied');
    current = path.join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw documentError('document_link_denied');
  }
  if (await realpath(absolute) !== absolute) throw documentError('document_path_changed');
  return absolute;
}

export function validateDocumentQuery(query) {
  if (typeof query !== 'string' || !query.trim() || query.length > 200 || /[\\/:\x00-\x1f]|\.\./u.test(query) || !allowedPart(query)) {
    throw documentError('document_query_invalid');
  }
  return query.trim();
}

const sameFile = (left, right) => left.ino === right.ino && left.dev === right.dev &&
  left.size === right.size && left.mtimeNs === right.mtimeNs;

async function recheckOpenedPath(filename, expected) {
  await checkedDirectory(path.dirname(filename));
  const current = await lstat(filename, { bigint: true });
  if (current.isSymbolicLink() || !current.isFile() || current.nlink !== 1n || !sameFile(current, expected) || await realpath(filename) !== filename) {
    throw documentError('document_file_changed');
  }
}

/** Bytes, not an arbitrary filename, cross the parser boundary. */
export async function readDocumentBytes(policy, selection) {
  if (!selection || !Number.isInteger(selection.rootIndex) || !policy.roots[selection.rootIndex] ||
      typeof selection.relativePath !== 'string' || path.isAbsolute(selection.relativePath) ||
      selection.relativePath.split(/[\\/]/u).some(part => !allowedPart(part)) ||
      !DOCUMENT_EXTENSIONS.includes(path.extname(selection.relativePath).toLowerCase())) throw documentError('document_selection_invalid');
  const root = policy.roots[selection.rootIndex];
  const filename = path.resolve(root, selection.relativePath);
  if (!inside(root, filename)) throw documentError('document_path_denied');
  await checkedDirectory(path.dirname(filename));
  const linkStat = await lstat(filename, { bigint: true });
  if (linkStat.isSymbolicLink()) throw documentError('document_link_denied');
  const resolved = await realpath(filename);
  if (!inside(root, resolved) || resolved !== filename) throw documentError('document_path_denied');
  const handle = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(MAX_DOCUMENT_BYTES)) throw documentError('document_file_denied');
    // Windows does not expose O_NOFOLLOW. Verify the opened handle still names
    // the file inspected before open(), and recheck ancestors before any read.
    if (linkStat.nlink !== 1n || !sameFile(linkStat, before)) throw documentError('document_file_changed');
    await recheckOpenedPath(filename, before);
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = await handle.read(bytes, count, bytes.length - count, count);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (BigInt(count) !== before.size || !sameFile(before, after) || after.nlink !== 1n) throw documentError('document_file_changed');
    await recheckOpenedPath(filename, after);
    const result = bytes.subarray(0, count);
    const hash = digest(result);
    if (selection.hash && selection.hash !== hash) throw documentError('document_file_changed');
    return { bytes: result, hash, relativePath: selection.relativePath, rootIndex: selection.rootIndex };
  } finally { await handle.close(); }
}

/** Filename search never parses document bodies or follows references inside them. */
export async function searchDocuments(policy, query) {
  const normalized = validateDocumentQuery(query).normalize('NFKC').toLowerCase();
  const terms = normalized.match(/[\p{L}\p{N}]+/gu) || [];
  if (!terms.length) throw documentError('document_query_invalid');
  const files = []; let visited = 0; let skipped = 0; let limited = false;
  async function walk(rootIndex, relative = '', depth = 0) {
    if (depth > 8 || visited >= 2000 || files.length >= 100) { limited = true; return; }
    let directory;
    try { directory = await opendir(await checkedDirectory(path.join(policy.roots[rootIndex], relative))); }
    catch { skipped++; return; }
    for await (const entry of directory) {
      if (++visited > 2000 || files.length >= 100) { limited = true; break; }
      if (!allowedPart(entry.name) || entry.isSymbolicLink()) { skipped++; continue; }
      const relativePath = path.join(relative, entry.name);
      if (entry.isDirectory()) await walk(rootIndex, relativePath, depth + 1);
      else if (entry.isFile() && DOCUMENT_EXTENSIONS.includes(path.extname(entry.name).toLowerCase()) &&
          terms.every(term => entry.name.normalize('NFKC').toLowerCase().includes(term))) {
        try {
          const document = await readDocumentBytes(policy, { rootIndex, relativePath });
          files.push({ rootIndex, relativePath, hash: document.hash, bytes: document.bytes.length,
            candidateId: digest(`${rootIndex}\0${relativePath}\0${document.hash}`) });
        } catch { skipped++; }
      }
    }
  }
  for (let index = 0; index < policy.roots.length; index++) await walk(index);
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return { files, skipped, limited };
}
