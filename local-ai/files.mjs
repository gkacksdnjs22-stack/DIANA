import path from 'node:path';
import os from 'node:os';
import { constants } from 'node:fs';
import { lstat, realpath, opendir, open, mkdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { localError } from './provider.mjs';

export const inside = (root, target) => {
  const rel = path.relative(root, target);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
};
const denied = /(?:^\.|credentials?|secrets?|api[-_ ]?keys?|private[-_ ]?keys?|service[-_ ]?accounts?|firebase|google-services|인증키|비밀키)/i;
const systemNames = /^(?:windows|program files(?: \(x86\))?|programdata|appdata|node_modules|system volume information|\$recycle\.bin)$/i;
// JSON uses the same bounded UTF-8 reader and sensitive-content/path checks.
// It is inert text: parsing or executing embedded instructions is not allowed.
const TEXT_EXTENSIONS = Object.freeze(['.txt', '.md', '.json']);
export function allowedPart(part) { return !!part && !denied.test(part) && !systemNames.test(part) && !/[:\x00-\x1f]/.test(part); }

async function checkedDirectory(directory) {
  const absolute = path.resolve(directory);
  if (absolute.startsWith('\\\\')) throw localError('local_network_path_denied');
  const root = path.parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    // .local is the explicit internal output/fixture container. All other
    // ancestors obey the same sensitive-name rule as ordinary scan entries.
    if (systemNames.test(part) || (part !== '.local' && denied.test(part))) throw localError('local_system_path_denied');
    current = path.join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw localError('local_link_denied');
  }
  const resolved = await realpath(absolute);
  if (!(await lstat(resolved)).isDirectory() || resolved === root || resolved === os.homedir()) throw localError('local_root_invalid');
  return resolved;
}

export async function createFilePolicy(readRoots, outputRoot) {
  if (!Array.isArray(readRoots) || readRoots.length < 1 || readRoots.length > 8) throw localError('local_roots_invalid');
  const roots = [];
  for (const folder of readRoots) {
    const root = await checkedDirectory(folder);
    if (!allowedPart(path.basename(root))) throw localError('local_root_denied');
    roots.push(root);
  }
  // Check existing ancestors before creating the output directory (junction escape).
  const output = path.resolve(outputRoot);
  let ancestor = output;
  while (true) {
    try { await checkedDirectory(ancestor); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; ancestor = path.dirname(ancestor); }
  }
  if (roots.some(root => inside(root, output) || inside(output, root))) throw localError('local_folders_overlap');
  await mkdir(output, { recursive: true, mode: 0o700 });
  return { roots, output: await checkedDirectory(output) };
}

async function readDocument(root, relativePath) {
  if (typeof relativePath !== 'string' || path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).some(part => !allowedPart(part)) ||
      !TEXT_EXTENSIONS.includes(path.extname(relativePath).toLowerCase())) throw localError('local_path_denied');
  const requested = path.resolve(root, relativePath);
  if (!inside(root, requested)) throw localError('local_path_denied');
  await checkedDirectory(path.dirname(requested));
  if ((await lstat(requested)).isSymbolicLink()) throw localError('local_link_denied');
  const resolved = await realpath(requested);
  if (!inside(root, resolved)) throw localError('local_path_denied');
  const handle = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > 256 * 1024) throw localError('local_file_denied');
    const bytes = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = await handle.read(bytes, count, bytes.length - count, count);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    const after = await handle.stat();
    if (count !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) throw localError('local_file_changed');
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count)); }
    catch { throw localError('local_encoding_invalid'); }
    // Defense in depth; this is not a complete secret detector.
    if (/-----BEGIN .*PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{30,})|["']?(?:api[_-]?key|private_key|client_secret|password)["']?\s*[:=]\s*\S+/i.test(text)) throw localError('local_sensitive_content');
    const hash = createHash('sha256').update(bytes.subarray(0, count)).digest('hex');
    return { relativePath, text, hash, bytes: count };
  } finally { await handle.close(); }
}

export async function readSelected(policy, selection) {
  if (!selection || !Number.isInteger(selection.rootIndex) || !policy.roots[selection.rootIndex]) throw localError('local_selection_invalid');
  const doc = await readDocument(policy.roots[selection.rootIndex], selection.relativePath);
  if (selection.hash && doc.hash !== selection.hash) throw localError('local_file_changed');
  return { ...doc, rootIndex: selection.rootIndex };
}

export async function searchFiles(policy, query = '') {
  if (typeof query !== 'string' || query.length > 1500) throw localError('local_query_invalid');
  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])];
  const matches = []; let visited = 0; let skipped = 0; let limited = false;
  async function walk(rootIndex, relative = '', depth = 0) {
    if (depth > 8 || visited >= 2000) { limited = true; return; }
    let dir;
    try {
      await checkedDirectory(path.join(policy.roots[rootIndex], relative));
      dir = await opendir(path.join(policy.roots[rootIndex], relative));
    } catch { skipped++; return; }
    for await (const entry of dir) {
      if (++visited > 2000) { limited = true; break; }
      if (!allowedPart(entry.name) || entry.isSymbolicLink()) { skipped++; continue; }
      const rel = path.join(relative, entry.name);
      if (entry.isDirectory()) await walk(rootIndex, rel, depth + 1);
      else if (entry.isFile() && TEXT_EXTENSIONS.includes(path.extname(rel).toLowerCase())) {
        try {
          const doc = await readSelected(policy, { rootIndex, relativePath: rel });
          const haystack = `${rel}\n${doc.text}`.toLowerCase();
          const score = terms.filter(term => haystack.includes(term)).length;
          if (!terms.length || score) matches.push({ rootIndex, relativePath: rel, hash: doc.hash, bytes: doc.bytes, score });
        } catch { skipped++; }
      }
    }
  }
  for (let i = 0; i < policy.roots.length; i++) {
    await checkedDirectory(policy.roots[i]);
    await walk(i);
  }
  return { files: matches.sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath)).slice(0, 100),
    skipped, limited: limited || matches.length > 100 };
}

export async function saveResult(policy, text, extension = 'md') {
  if (!['md', 'txt'].includes(extension) || typeof text !== 'string' || !text.trim() || text.length > 64_000) throw localError('local_output_invalid');
  if (await checkedDirectory(policy.output) !== policy.output) throw localError('local_output_changed');
  const filename = `DIANA-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.${extension}`;
  const destination = path.join(policy.output, filename);
  const handle = await open(destination, 'wx', 0o600);
  try { await handle.writeFile(text, 'utf8'); } finally { await handle.close(); }
  return destination;
}
