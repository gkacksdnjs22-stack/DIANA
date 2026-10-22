import path from 'node:path';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const MAX_DOCUMENTS = 100;
export const MAX_TEXT_CHARS = 12_000;
export const EDITABLE_TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.py', '.json', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.java', '.kt', '.go', '.rs', '.c', '.h', '.cpp', '.cc', '.cs', '.php', '.rb', '.swift',
  '.sh', '.ps1', '.bat', '.cmd', '.sql', '.yaml', '.yml', '.toml', '.xml', '.html', '.css',
  '.gradle', '.kts', '.properties',
]);
const KORDOC_EXTENSIONS = new Set(['.hwp', '.hwpx', '.hwpml', '.xls', '.xlsx', '.pptx']);
const EXTENSIONS = new Set([...EDITABLE_TEXT_EXTENSIONS, '.pdf', '.docx', ...KORDOC_EXTENSIONS]);

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function documentId(relativePath, contentHash) {
  return sha256(`${relativePath.split(path.sep).join('/')}\0${contentHash}`);
}

export function isWithinRoot(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export async function resolveDocumentRoot(documentRoot) {
  if (!documentRoot || typeof documentRoot !== 'string') throw new Error('DOCUMENT_ROOT is required.');
  const root = await realpath(path.resolve(documentRoot));
  if (!(await stat(root)).isDirectory()) throw new Error('DOCUMENT_ROOT must be a directory.');
  return root;
}

export async function resolveSafeDocument(documentRoot, relativePath) {
  const root = await resolveDocumentRoot(documentRoot);
  if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath)) {
    throw new Error('A relative document path is required.');
  }
  const requested = path.resolve(root, relativePath);
  if (!isWithinRoot(root, requested)) throw new Error('Document path leaves DOCUMENT_ROOT.');
  const resolved = await realpath(requested);
  if (!isWithinRoot(root, resolved)) throw new Error('Document link leaves DOCUMENT_ROOT.');
  if (!EXTENSIONS.has(path.extname(requested).toLowerCase())) throw new Error('Unsupported document type.');
  if (!(await stat(resolved)).isFile()) throw new Error('Document is not a regular file.');
  return { root, absolutePath: resolved, relativePath: path.relative(root, requested) };
}

async function readBoundedFile(absolutePath, maxBytes = MAX_DOCUMENT_BYTES) {
  // O_NOFOLLOW also protects the final component on platforms that support it.
  const handle = await open(absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maxBytes) throw new Error('Document exceeds the 10 MB limit.');
    const buffer = Buffer.alloc(Math.min(before.size + 1, maxBytes + 1));
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (!result.bytesRead) break;
      bytesRead += result.bytesRead;
    }
    const after = await handle.stat();
    if (after.size > maxBytes || bytesRead > maxBytes) throw new Error('Document exceeds the 10 MB limit.');
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytesRead !== after.size) {
      throw new Error('Document changed while it was being read.');
    }
    return { buffer: buffer.subarray(0, bytesRead), stats: after };
  } finally {
    await handle.close();
  }
}

async function extractText(buffer, extension) {
  let text;
  if (EDITABLE_TEXT_EXTENSIONS.has(extension)) {
    text = buffer.toString('utf8');
  } else if (KORDOC_EXTENSIONS.has(extension)) {
    const { parse } = await import('kordoc');
    const result = await parse(buffer, { plain: true, images: false, ocr: false });
    if (!result?.success) throw new Error(result?.error || 'Kordoc could not extract text.');
    text = result.markdown;
  } else if (extension === '.docx') {
    const mammoth = await import('mammoth');
    const parser = mammoth.default ?? mammoth;
    text = (await parser.extractRawText({ buffer })).value;
  } else if (extension === '.pdf') {
    const pdf = await import('pdf-parse');
    if (pdf.PDFParse) {
      const parser = new pdf.PDFParse({ data: buffer });
      try { text = (await parser.getText()).text; } finally { await parser.destroy(); }
    } else {
      text = (await pdf.default(buffer)).text;
    }
  }
  return String(text ?? '').replace(/\u0000/g, '').slice(0, MAX_TEXT_CHARS);
}

/** Local-only index. Never send this object to the control server. */
export async function scanDocuments({ documentRoot, maxFiles = MAX_DOCUMENTS } = {}) {
  const root = await resolveDocumentRoot(documentRoot);
  const documents = [];
  const skipped = [];
  const visitedDirectories = new Set();
  let examined = 0;
  const limit = Math.max(1, Math.min(MAX_DOCUMENTS, Math.floor(Number(maxFiles) || MAX_DOCUMENTS)));

  async function visit(directory) {
    const resolvedDirectory = await realpath(directory);
    if (!isWithinRoot(root, resolvedDirectory)) throw new Error('Directory link leaves DOCUMENT_ROOT.');
    if (visitedDirectories.has(resolvedDirectory)) return;
    visitedDirectories.add(resolvedDirectory);
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (examined >= limit) return;
      const localPath = path.join(directory, entry.name);
      const relativePath = path.relative(root, localPath);
      try {
        const resolved = await realpath(localPath);
        if (!isWithinRoot(root, resolved)) throw new Error('Document link leaves DOCUMENT_ROOT.');
        const info = await lstat(localPath);
        const followed = info.isSymbolicLink() ? await stat(resolved) : info;
        if (followed.isDirectory()) { await visit(localPath); continue; }
        if (!followed.isFile() || !EXTENSIONS.has(path.extname(localPath).toLowerCase())) continue;
        examined += 1;
        const safe = await resolveSafeDocument(root, relativePath);
        const { buffer, stats } = await readBoundedFile(safe.absolutePath);
        const contentHash = sha256(buffer);
        const text = await extractText(buffer, path.extname(localPath).toLowerCase());
        if (!text.trim()) { skipped.push({ filename: entry.name, reason: 'No extractable text.' }); continue; }
        documents.push({
          id: documentId(relativePath, contentHash), filename: entry.name,
          relativePath, absolutePath: safe.absolutePath, sha256: contentHash,
          modifiedAt: stats.mtime.toISOString(), bytes: stats.size, text,
        });
      } catch (error) {
        skipped.push({ filename: entry.name, reason: error.message });
      }
    }
  }
  await visit(root);
  return { documentRoot: root, documents, skipped };
}

/** Revalidate a persisted candidate immediately before handing it to the mailer. */
export async function validateAttachment(documentRoot, candidate, { includeBytes = false } = {}) {
  if (!candidate || !/^[a-f0-9]{64}$/.test(candidate.sha256 ?? '')) throw new Error('Invalid saved candidate.');
  const safe = await resolveSafeDocument(documentRoot, candidate.relativePath);
  const { buffer } = await readBoundedFile(safe.absolutePath);
  const hash = sha256(buffer);
  if (hash !== candidate.sha256 || documentId(safe.relativePath, hash) !== candidate.id) {
    throw new Error('Document changed after selection. Search and approve it again.');
  }
  return { attachmentPath: safe.absolutePath, attachmentName: path.basename(safe.relativePath), expectedSha256: hash, ...(includeBytes ? { buffer } : {}) };
}

/** An edited artifact must stay in local state; its final bytes must match its receipt. */
export async function readVerifiedArtifact(artifactPath, expectedSha256, { sourcePath, stateDir }) {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256 ?? '')) throw new Error('Edited artifact has an invalid content hash.');
  const [resolved, source, state] = await Promise.all([realpath(artifactPath), realpath(sourcePath), realpath(stateDir)]);
  if (path.relative(resolved, source) !== '' && !isWithinRoot(state, resolved)) throw new Error('Edited artifact leaves the local state directory.');
  const { buffer } = await readBoundedFile(resolved);
  if (sha256(buffer) !== expectedSha256) throw new Error('Edited artifact changed before delivery.');
  return { attachmentPath: resolved, buffer };
}
