import nodemailer from 'nodemailer';
import { createHash, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_DATA_DIR = fileURLToPath(new URL('../.local/', import.meta.url));
const DEFAULT_MAX_BYTES = 15 * 1024 * 1024;
const HARD_MAX_BYTES = 20 * 1024 * 1024;
const VALIDATED_CONFIGS = new WeakSet();
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const PROVIDERS = Object.freeze({
  gmail: { host: 'smtp.gmail.com', port: 465, secure: true },
  outlook: { host: 'smtp-mail.outlook.com', port: 587, secure: false },
  microsoft365: { host: 'smtp.office365.com', port: 587, secure: false },
  naver: { host: 'smtp.naver.com', port: 465, secure: true },
});
const MIME_TYPES = Object.freeze({
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.hwpx': 'application/vnd.hancom.hwpx',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown',
  '.csv': 'text/csv', '.tsv': 'text/tab-separated-values', '.json': 'application/json',
  '.py': 'text/x-python', '.js': 'text/javascript', '.mjs': 'text/javascript', '.cjs': 'text/javascript',
  '.ts': 'text/typescript', '.tsx': 'text/typescript', '.jsx': 'text/javascript',
  '.java': 'text/x-java-source', '.kt': 'text/plain', '.go': 'text/plain', '.rs': 'text/plain',
  '.c': 'text/x-c', '.h': 'text/x-c', '.cpp': 'text/x-c++src', '.cc': 'text/x-c++src', '.cs': 'text/plain',
  '.php': 'text/x-php', '.rb': 'text/x-ruby', '.swift': 'text/plain', '.sh': 'text/x-shellscript',
  '.ps1': 'text/plain', '.bat': 'text/plain', '.cmd': 'text/plain', '.sql': 'text/plain',
  '.yaml': 'text/yaml', '.yml': 'text/yaml', '.toml': 'text/plain', '.xml': 'application/xml',
  '.html': 'text/html', '.css': 'text/css', '.gradle': 'text/plain', '.kts': 'text/plain', '.properties': 'text/plain',
});

class MailInputError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const invalid = (code, message) => { throw new MailInputError(code, message); };
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const validatedConfig = (value) => { VALIDATED_CONFIGS.add(value); return Object.freeze(value); };

function header(value, field, maxLength = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength || CONTROL.test(value)) {
    invalid('INVALID_HEADER', `${field} 값을 확인하세요. 줄바꿈과 제어문자는 사용할 수 없습니다.`);
  }
  return value.trim();
}

function email(value, field = '이메일 주소') {
  const address = header(value, field, 254);
  const parts = address.split('@');
  if (parts.length !== 2 || parts[0].length > 64 ||
      !/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/.test(parts[0])) {
    invalid('INVALID_ADDRESS', `${field}에는 이름이나 구분자 없이 한 개의 이메일 주소를 입력하세요.`);
  }
  const labels = parts[1].split('.');
  if (labels.length < 2 || labels.some(label => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))) {
    invalid('INVALID_ADDRESS', `${field}의 도메인을 확인하세요.`);
  }
  return `${parts[0]}@${parts[1].toLowerCase()}`;
}

function secret(value, field) {
  if (typeof value !== 'string' || !value || value.length > 32768 || CONTROL.test(value)) {
    invalid('MAIL_CONFIG', `${field} 설정이 필요하거나 올바르지 않습니다.`);
  }
  return value;
}

function integer(value, fallback, field, min, max) {
  const number = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    invalid('MAIL_CONFIG', `${field} 설정 범위를 확인하세요.`);
  }
  return number;
}

/** Server-side only. This object contains credentials; never return it from an API. */
export function readMailConfig(env = process.env) {
  const mode = env.MAIL_MODE || 'dry-run';
  if (!['dry-run', 'smtp'].includes(mode)) invalid('MAIL_CONFIG', 'MAIL_MODE는 dry-run 또는 smtp여야 합니다.');
  const provider = (env.MAIL_PROVIDER || 'custom').toLowerCase();
  if (provider !== 'custom' && !PROVIDERS[provider]) invalid('MAIL_CONFIG', 'MAIL_PROVIDER 설정을 확인하세요.');
  const from = email(env.MAIL_FROM || (mode === 'smtp' ? env.SMTP_USER : 'assistant@example.invalid'), '보내는 주소');
  const fromName = header(env.MAIL_FROM_NAME || 'AI 원격비서', '보내는 이름', 100);
  const maxAttachmentBytes = integer(env.MAIL_MAX_ATTACHMENT_BYTES, DEFAULT_MAX_BYTES,
    'MAIL_MAX_ATTACHMENT_BYTES', 1, HARD_MAX_BYTES);
  const base = { mode, provider, from, fromName, maxAttachmentBytes };
  if (mode === 'dry-run') return validatedConfig({ ...base, smtp: null });

  let endpoint;
  if (provider === 'custom') {
    const host = header(env.SMTP_HOST, 'SMTP_HOST', 253);
    if (!isIP(host) && !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host)) {
      invalid('MAIL_CONFIG', 'SMTP_HOST에는 URL이나 포트 없이 서버 이름만 입력하세요.');
    }
    const port = integer(env.SMTP_PORT, 587, 'SMTP_PORT', 1, 65535);
    if (env.SMTP_SECURE !== undefined && !['true', 'false', ''].includes(env.SMTP_SECURE)) {
      invalid('MAIL_CONFIG', 'SMTP_SECURE는 true 또는 false여야 합니다.');
    }
    const secure = env.SMTP_SECURE ? env.SMTP_SECURE === 'true' : port === 465;
    if (port === 465 && !secure) invalid('MAIL_CONFIG', '465 포트에는 SMTP_SECURE=true가 필요합니다.');
    endpoint = { host, port, secure };
  } else {
    endpoint = PROVIDERS[provider];
    if ((env.SMTP_HOST && env.SMTP_HOST !== endpoint.host) ||
        (env.SMTP_PORT && Number(env.SMTP_PORT) !== endpoint.port) ||
        (env.SMTP_SECURE && env.SMTP_SECURE !== String(endpoint.secure))) {
      invalid('MAIL_CONFIG', '기본 제공업체의 SMTP 서버 설정을 변경하려면 MAIL_PROVIDER=custom을 사용하세요.');
    }
  }
  const user = email(env.SMTP_USER, 'SMTP_USER');
  const authType = env.MAIL_AUTH || (['outlook', 'microsoft365'].includes(provider) || env.SMTP_ACCESS_TOKEN || env.SMTP_REFRESH_TOKEN
    ? 'oauth2' : 'password');
  if (!['oauth2', 'password'].includes(authType)) invalid('MAIL_CONFIG', 'MAIL_AUTH는 oauth2 또는 password여야 합니다.');
  if (['outlook', 'microsoft365'].includes(provider) && authType !== 'oauth2') {
    invalid('MAIL_CONFIG', 'Outlook/Microsoft 365 어댑터는 OAuth2 토큰을 사용합니다.');
  }
  if (provider === 'naver' && authType !== 'password') invalid('MAIL_CONFIG', '네이버 어댑터에는 애플리케이션 비밀번호를 사용하세요.');
  let auth;
  if (authType === 'password') {
    auth = { user, pass: secret(env.SMTP_PASSWORD, 'SMTP_PASSWORD') };
  } else {
    auth = { type: 'OAuth2', user };
    if (env.SMTP_ACCESS_TOKEN) auth.accessToken = secret(env.SMTP_ACCESS_TOKEN, 'SMTP_ACCESS_TOKEN');
    if (provider === 'gmail' && env.SMTP_REFRESH_TOKEN) {
      auth.refreshToken = secret(env.SMTP_REFRESH_TOKEN, 'SMTP_REFRESH_TOKEN');
      auth.clientId = secret(env.SMTP_CLIENT_ID, 'SMTP_CLIENT_ID');
      auth.clientSecret = secret(env.SMTP_CLIENT_SECRET, 'SMTP_CLIENT_SECRET');
    }
    if (!auth.accessToken && !auth.refreshToken) invalid('MAIL_CONFIG', '유효한 SMTP_ACCESS_TOKEN 설정이 필요합니다.');
    if (env.SMTP_TOKEN_EXPIRES) {
      auth.expires = integer(env.SMTP_TOKEN_EXPIRES, undefined, 'SMTP_TOKEN_EXPIRES', 1, Number.MAX_SAFE_INTEGER);
      if (auth.expires <= Date.now() && !auth.refreshToken) invalid('MAIL_CONFIG', 'SMTP_ACCESS_TOKEN이 만료되었습니다. 토큰을 갱신하세요.');
    }
  }
  return validatedConfig({ ...base, smtp: Object.freeze({ ...endpoint, auth: Object.freeze(auth) }) });
}

/** Safe for a settings API: deliberately excludes SMTP auth and all secrets. */
export function getMailReadiness(env = process.env) {
  try {
    const config = readMailConfig(env);
    return { mode: config.mode, provider: config.provider, configured: config.mode === 'smtp',
      from: config.from, maxAttachmentBytes: config.maxAttachmentBytes };
  } catch (error) {
    return { mode: ['smtp', 'dry-run'].includes(env.MAIL_MODE) ? env.MAIL_MODE : 'dry-run',
      configured: false, error: error instanceof MailInputError ? error.message : '메일 설정을 확인하세요.' };
  }
}

function smtpOptions(config) {
  const smtp = config.smtp;
  return {
    host: smtp.host, port: smtp.port, secure: smtp.secure,
    requireTLS: !smtp.secure, ignoreTLS: false,
    auth: { ...smtp.auth },
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2', ...(isIP(smtp.host) ? {} : { servername: smtp.host }) },
    pool: false, logger: false, debug: false,
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000,
    disableFileAccess: true, disableUrlAccess: true,
  };
}

async function readAttachment(attachmentPath, name, maxBytes, attachmentRoot) {
  if (typeof attachmentPath !== 'string' || !path.isAbsolute(attachmentPath) || CONTROL.test(attachmentPath)) {
    invalid('INVALID_ATTACHMENT', '첨부파일의 절대 경로가 필요합니다.');
  }
  const ext = path.extname(name).toLowerCase();
  if (!MIME_TYPES[ext] || ext !== path.extname(attachmentPath).toLowerCase()) {
    invalid('INVALID_ATTACHMENT', '지원하는 문서 확장자와 실제 파일 확장자가 일치해야 합니다.');
  }
  const stat = await lstat(attachmentPath);
  if (!stat.isFile() || stat.isSymbolicLink()) invalid('INVALID_ATTACHMENT', '일반 문서 파일만 첨부할 수 있습니다.');
  if (attachmentRoot) {
    const [root, actual] = await Promise.all([realpath(attachmentRoot), realpath(attachmentPath)]);
    const relative = path.relative(root, actual);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      invalid('INVALID_ATTACHMENT', '허용된 문서 폴더 밖의 파일은 첨부할 수 없습니다.');
    }
  }
  const handle = await open(attachmentPath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maxBytes) invalid('ATTACHMENT_TOO_LARGE', '첨부파일이 크기 제한을 초과했습니다.');
    const buffer = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > maxBytes) invalid('ATTACHMENT_TOO_LARGE', '첨부파일이 크기 제한을 초과했습니다.');
    const after = await handle.stat();
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      invalid('ATTACHMENT_CHANGED', '첨부파일이 변경되었습니다. 문서를 다시 확인하세요.');
    }
    return buffer.subarray(0, size);
  } finally { await handle.close(); }
}

async function durableWrite(filePath, data) {
  // Append-only files: wx atomically wins ownership. Readers treat an incomplete file as unknown.
  // No replacement rename is needed, which also works on restricted Windows filesystems.
  const handle = await open(filePath, 'wx', 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally { await handle.close(); }
}

function unknown(messageId) {
  return { status: 'send_unknown', messageId,
    error: '메일 제출 여부를 확정할 수 없습니다. 중복 발송 방지를 위해 자동 재전송하지 않습니다.' };
}

async function existingResult(ledgerPath, resultPath, fingerprint, messageId, outboxPath) {
  let record;
  try { record = JSON.parse(await readFile(ledgerPath, 'utf8')); }
  catch { return { ...unknown(messageId), duplicate: true }; }
  if (record.fingerprint && record.fingerprint !== fingerprint) {
    return { status: 'failed', errorCode: 'JOB_ID_CONFLICT',
      error: '같은 작업 ID에 다른 메일 내용이 지정되었습니다. 새 작업으로 생성하세요.', duplicate: true };
  }
  if (record.version !== 1 || record.fingerprint !== fingerprint || record.messageId !== messageId) {
    return { ...unknown(messageId), duplicate: true };
  }
  if (record.status === 'sending') {
    try {
      const receipt = JSON.parse(await readFile(resultPath, 'utf8'));
      if (receipt.fingerprint !== fingerprint || receipt.messageId !== messageId) return { ...unknown(messageId), duplicate: true };
      record = receipt;
    } catch { return { ...unknown(messageId), duplicate: true }; }
  }
  if (record.status === 'submitted') return { status: 'submitted', messageId, duplicate: true };
  if (record.status === 'dry_run') return { status: 'dry_run', messageId, outboxPath, duplicate: true };
  if (record.status === 'failed') return { status: 'failed', error: '이 작업의 이전 메일 제출이 실패했습니다. 작업 기록을 확인하세요.', duplicate: true };
  return { ...unknown(messageId), duplicate: true };
}

/**
 * One recipient, one verified attachment, one durable claim per jobId.
 * `submitted` means the SMTP server accepted submission, not inbox delivery.
 * No automatic retry is performed after SMTP starts, including on timeouts.
 */
export async function sendDocumentMail(request = {}, options = {}) {
  let config, recipient, subject, name, content, attachmentSha256, text;
  try {
    config = options.config || readMailConfig(options.env || process.env);
    if (!VALIDATED_CONFIGS.has(config)) {
      invalid('MAIL_CONFIG', 'readMailConfig에서 생성한 메일 설정을 사용하세요.');
    }
    if (typeof request.jobId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(request.jobId)) {
      invalid('INVALID_JOB_ID', '안정적인 작업 ID가 필요합니다.');
    }
    recipient = email(request.recipient, '받는 주소');
    subject = header(request.subject, '메일 제목');
    name = header(request.attachmentName || path.basename(request.attachmentPath || ''), '첨부파일 이름', 180);
    if (/[\\/]/.test(name) || name === '.' || name === '..') invalid('INVALID_ATTACHMENT', '첨부파일 이름에는 경로를 사용할 수 없습니다.');
    text = request.text ?? '요청하신 문서를 첨부합니다.\nAI 원격비서';
    if (typeof text !== 'string' || text.length > 10000 || text.includes('\0')) invalid('INVALID_BODY', '메일 본문을 확인하세요.');
    content = await readAttachment(request.attachmentPath, name, config.maxAttachmentBytes, options.attachmentRoot);
    attachmentSha256 = sha256(content);
    if (request.expectedSha256 !== undefined &&
        (typeof request.expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(request.expectedSha256) ||
         !timingSafeEqual(Buffer.from(attachmentSha256, 'hex'), Buffer.from(request.expectedSha256, 'hex')))) {
      invalid('ATTACHMENT_HASH_MISMATCH', '승인한 문서와 첨부파일이 다릅니다. 문서를 다시 확인하세요.');
    }
  } catch (error) {
    return { status: 'failed', errorCode: error instanceof MailInputError ? error.code : 'ATTACHMENT_UNAVAILABLE',
      error: error instanceof MailInputError ? error.message : '첨부파일을 안전하게 읽을 수 없습니다.' };
  }

  const dataDir = path.resolve(options.dataDir || DEFAULT_DATA_DIR);
  const ledgerDir = path.join(dataDir, 'mail-ledger');
  const outboxDir = path.join(dataDir, 'outbox');
  const key = sha256(request.jobId);
  const fingerprint = sha256(JSON.stringify([config.mode, config.provider, config.from, config.fromName,
    config.smtp?.host, config.smtp?.auth?.user, recipient, subject, name, attachmentSha256, text]));
  const messageId = `<${sha256(`${key}:${fingerprint}`)}@${config.from.split('@')[1]}>`;
  const ledgerPath = path.join(ledgerDir, `${key}.json`);
  const resultPath = path.join(ledgerDir, `${key}.result.json`);
  const outboxPath = path.join(outboxDir, `${key}.eml`);
  const record = { version: 1, fingerprint, status: 'sending', messageId, createdAt: new Date().toISOString() };
  try {
    await mkdir(ledgerDir, { recursive: true, mode: 0o700 });
    await durableWrite(ledgerPath, JSON.stringify(record));
  } catch (error) {
    if (error.code === 'EEXIST') return existingResult(ledgerPath, resultPath, fingerprint, messageId, outboxPath);
    return { status: 'failed', error: '발송 기록을 안전하게 저장할 수 없어 메일을 제출하지 않았습니다.' };
  }

  const message = {
    from: { name: config.fromName, address: config.from }, to: recipient,
    envelope: { from: config.from, to: [recipient] }, subject, text, messageId,
    attachments: [{ filename: name, content, contentType: MIME_TYPES[path.extname(name).toLowerCase()], contentDisposition: 'attachment' }],
    disableFileAccess: true, disableUrlAccess: true,
  };
  let result, transport, smtpStarted = false;
  try {
    if (config.mode === 'dry-run') {
      // Always use Nodemailer's local composer here; an SMTP mock cannot turn this into a network send.
      transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'windows' });
      const composed = await transport.sendMail(message);
      if (!Buffer.isBuffer(composed.message)) throw new Error('COMPOSE_FAILED');
      await mkdir(outboxDir, { recursive: true, mode: 0o700 });
      await durableWrite(outboxPath, composed.message);
      result = { status: 'dry_run', messageId, outboxPath };
    } else {
      transport = (options.createTransport || nodemailer.createTransport)(smtpOptions(config));
      smtpStarted = true;
      const info = await transport.sendMail(message);
      const accepted = Array.isArray(info?.accepted) && info.accepted.some(item =>
        String(typeof item === 'string' ? item : item?.address).toLowerCase() === recipient.toLowerCase());
      const rejected = Array.isArray(info?.rejected) && info.rejected.some(item =>
        String(typeof item === 'string' ? item : item?.address).toLowerCase() === recipient.toLowerCase());
      result = accepted && !rejected ? { status: 'submitted', messageId }
        : rejected && !accepted ? { status: 'failed', messageId, error: '메일 서버가 받는 주소에 대한 제출을 거부했습니다.' }
        : unknown(messageId);
    }
  } catch {
    // SMTP errors can contain credentials or a server response with personal data. Never expose them.
    result = smtpStarted ? unknown(messageId)
      : { status: 'failed', messageId, error: '메일을 준비하지 못해 제출하지 않았습니다.' };
  } finally {
    if (typeof transport?.close === 'function') {
      try { await transport.close(); } catch { /* Submission result takes precedence over close errors. */ }
    }
  }
  try {
    await durableWrite(resultPath, JSON.stringify({ ...record,
      status: result.status === 'send_unknown' ? 'unknown' : result.status, updatedAt: new Date().toISOString() }));
  } catch {
    // The original durable claim stays in place if final persistence fails; subsequent calls cannot resend.
    return { ...unknown(messageId), error: '메일 처리 결과를 기록하지 못했습니다. 중복 방지를 위해 자동 재전송하지 않습니다.' };
  }
  return result;
}
