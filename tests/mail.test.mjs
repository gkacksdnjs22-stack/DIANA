import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getMailReadiness, readMailConfig, sendDocumentMail } from '../lib/mail.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const documentBytes = Buffer.from('%PDF-1.4\nmail-test-document\n%%EOF');
const smtpEnv = (extra = {}) => ({ MAIL_MODE: 'smtp', MAIL_PROVIDER: 'gmail',
  MAIL_AUTH: 'oauth2', SMTP_USER: 'sender@example.com', SMTP_ACCESS_TOKEN: 'token-do-not-leak', ...extra });

async function fixture(t) {
  const prefix = path.join(os.tmpdir(), 'mail-test-');
  const dir = await mkdtemp(prefix);
  t.after(async () => {
    assert.ok(path.resolve(dir).startsWith(path.resolve(prefix)), 'only remove this test temporary directory');
    await rm(dir, { recursive: true, force: true });
  });
  const attachmentPath = path.join(dir, 'report.pdf');
  await writeFile(attachmentPath, documentBytes);
  return { dir, dataDir: path.join(dir, 'data'), request: { jobId: 'job-example-1',
    recipient: 'recipient@example.com', subject: '검토한 보고서', attachmentPath,
    attachmentName: 'report.pdf', expectedSha256: hash(documentBytes) } };
}

test('dry-run defaults do not require SMTP secrets and readiness never exposes credentials', () => {
  const config = readMailConfig({});
  assert.equal(config.mode, 'dry-run');
  assert.equal(config.smtp, null);
  assert.equal(getMailReadiness({}).configured, false);
  const readiness = getMailReadiness(smtpEnv());
  assert.equal(readiness.configured, true);
  assert.equal(readiness.provider, 'gmail');
  assert.doesNotMatch(JSON.stringify(readiness), /token-do-not-leak|accessToken|password|clientSecret/);
});

test('provider configuration enforces OAuth for Outlook, app password for Naver, explicit custom host', () => {
  const outlook = readMailConfig(smtpEnv({ MAIL_PROVIDER: 'outlook' }));
  assert.deepEqual([outlook.smtp.host, outlook.smtp.port, outlook.smtp.secure], ['smtp-mail.outlook.com', 587, false]);
  const microsoft = readMailConfig(smtpEnv({ MAIL_PROVIDER: 'microsoft365' }));
  assert.equal(microsoft.smtp.host, 'smtp.office365.com');
  assert.throws(() => readMailConfig(smtpEnv({ MAIL_PROVIDER: 'outlook', MAIL_AUTH: 'password' })), /OAuth2/);
  const naver = readMailConfig({ MAIL_MODE: 'smtp', MAIL_PROVIDER: 'naver',
    SMTP_USER: 'sender@naver.com', SMTP_PASSWORD: 'app-password' });
  assert.deepEqual([naver.smtp.host, naver.smtp.port, naver.smtp.secure], ['smtp.naver.com', 465, true]);
  assert.throws(() => readMailConfig(smtpEnv({ MAIL_PROVIDER: 'custom' })), /SMTP_HOST/);
  assert.throws(() => readMailConfig(smtpEnv({ SMTP_HOST: 'attacker.example' })), /custom/);
  assert.throws(() => readMailConfig(smtpEnv({ SMTP_TOKEN_EXPIRES: '1000' })), /만료/);
  assert.throws(() => readMailConfig({ MAIL_MODE: 'live' }), /MAIL_MODE/);
});

test('Gmail supports an externally authorized refresh token without pretending an OAuth UI exists', () => {
  const config = readMailConfig({ MAIL_MODE: 'smtp', MAIL_PROVIDER: 'gmail', MAIL_AUTH: 'oauth2',
    SMTP_USER: 'sender@example.com', SMTP_REFRESH_TOKEN: 'refresh',
    SMTP_CLIENT_ID: 'client', SMTP_CLIENT_SECRET: 'secret' });
  assert.equal(config.smtp.auth.type, 'OAuth2');
  assert.equal(config.smtp.auth.refreshToken, 'refresh');
  assert.throws(() => readMailConfig({ MAIL_MODE: 'smtp', MAIL_PROVIDER: 'gmail', MAIL_AUTH: 'oauth2',
    SMTP_USER: 'sender@example.com', SMTP_REFRESH_TOKEN: 'refresh' }), /SMTP_CLIENT_ID/);
});

test('dry-run writes a complete MIME attachment locally and does not call any SMTP factory', async (t) => {
  const { dataDir, request } = await fixture(t);
  let calls = 0;
  const result = await sendDocumentMail(request, { env: {}, dataDir,
    createTransport: () => { calls++; throw new Error('must not send'); } });
  assert.equal(result.status, 'dry_run');
  assert.equal(calls, 0);
  const eml = await readFile(result.outboxPath, 'utf8');
  assert.match(eml, /To: recipient@example\.com/);
  assert.match(eml, /Content-Type: application\/pdf/);
  assert.match(eml, /Content-Disposition: attachment; filename=report\.pdf/);
  assert.ok(eml.includes(documentBytes.toString('base64')));
  const again = await sendDocumentMail(request, { env: {}, dataDir });
  assert.equal(again.status, 'dry_run');
  assert.equal(again.duplicate, true);
  assert.equal(again.messageId, result.messageId);
  assert.equal((await readdir(path.join(dataDir, 'outbox'))).length, 1);
  const ledger = JSON.parse(await readFile(path.join(dataDir, 'mail-ledger', `${hash(request.jobId)}.result.json`), 'utf8'));
  assert.equal(ledger.status, 'dry_run');
});

test('verified SMTP submission keeps TLS on, sends the approved bytes, and is durable across repeated calls', async (t) => {
  const { dataDir, request } = await fixture(t);
  let calls = 0, capturedOptions, capturedMessage, closes = 0;
  const createTransport = (config) => {
    capturedOptions = config;
    return { sendMail: async (message) => { calls++; capturedMessage = message;
      return { accepted: [request.recipient], rejected: [] }; }, close: () => { closes++; } };
  };
  const options = { env: smtpEnv({ MAIL_PROVIDER: 'microsoft365' }), dataDir, createTransport };
  const first = await sendDocumentMail(request, options);
  assert.equal(first.status, 'submitted');
  assert.equal(capturedOptions.tls.rejectUnauthorized, true);
  assert.equal(capturedOptions.tls.minVersion, 'TLSv1.2');
  assert.equal(capturedOptions.requireTLS, true);
  assert.equal(capturedOptions.ignoreTLS, false);
  assert.equal(capturedOptions.logger, false);
  assert.equal(capturedOptions.debug, false);
  assert.equal(capturedOptions.pool, false);
  assert.equal(capturedOptions.auth.type, 'OAuth2');
  assert.equal(capturedMessage.disableUrlAccess, true);
  assert.ok(capturedMessage.attachments[0].content.equals(documentBytes));
  const second = await sendDocumentMail(request, options);
  assert.equal(second.status, 'submitted');
  assert.equal(second.duplicate, true);
  assert.equal(calls, 1);
  assert.equal(closes, 1);
});

test('SMTP ambiguity is redacted, recorded as unknown, and never automatically retried', async (t) => {
  const { dataDir, request } = await fixture(t);
  let calls = 0;
  const options = { env: smtpEnv(), dataDir, createTransport: () => ({
    sendMail: async () => { calls++; throw new Error('timeout token-do-not-leak secret-password'); },
  }) };
  const first = await sendDocumentMail(request, options);
  assert.equal(first.status, 'send_unknown');
  assert.doesNotMatch(JSON.stringify(first), /token-do-not-leak|secret-password/);
  const again = await sendDocumentMail(request, options);
  assert.equal(again.status, 'send_unknown');
  assert.equal(again.duplicate, true);
  assert.equal(calls, 1);
  const ledger = await readFile(path.join(dataDir, 'mail-ledger', `${hash(request.jobId)}.result.json`), 'utf8');
  assert.equal(JSON.parse(ledger).status, 'unknown');
  assert.doesNotMatch(ledger, /token-do-not-leak|secret-password|recipient@example/);
});

test('an exclusive claim prevents a second SMTP call while the first one is in flight', async (t) => {
  const { dataDir, request } = await fixture(t);
  let entered, finish, calls = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const release = new Promise(resolve => { finish = resolve; });
  const options = { env: smtpEnv(), dataDir, createTransport: () => ({ sendMail: async () => {
    calls++; entered(); await release;
    return { accepted: [request.recipient], rejected: [] };
  } }) };
  const first = sendDocumentMail(request, options);
  await started;
  const competing = await sendDocumentMail(request, options);
  assert.equal(competing.status, 'send_unknown');
  assert.equal(competing.duplicate, true);
  finish();
  assert.equal((await first).status, 'submitted');
  assert.equal(calls, 1);
});

test('an existing empty or interrupted ledger is blocked rather than treated as permission to resend', async (t) => {
  const { dataDir, request } = await fixture(t);
  await mkdir(path.join(dataDir, 'mail-ledger'), { recursive: true });
  await writeFile(path.join(dataDir, 'mail-ledger', `${hash(request.jobId)}.json`), '');
  let calls = 0;
  const result = await sendDocumentMail(request, { env: smtpEnv(), dataDir,
    createTransport: () => { calls++; throw new Error('must not send'); } });
  assert.equal(result.status, 'send_unknown');
  assert.equal(calls, 0);
});

test('acceptance followed by a receipt persistence failure stays unknown and cannot trigger another send', async (t) => {
  const { dataDir, request } = await fixture(t);
  let calls = 0;
  const options = { env: smtpEnv(), dataDir, createTransport: () => ({ sendMail: async () => {
    calls++;
    // Simulate a final receipt write failure after the remote server already accepted the message.
    await mkdir(path.join(dataDir, 'mail-ledger', `${hash(request.jobId)}.result.json`));
    return { accepted: [request.recipient], rejected: [] };
  } }) };
  const first = await sendDocumentMail(request, options);
  assert.equal(first.status, 'send_unknown');
  assert.equal((await sendDocumentMail(request, options)).status, 'send_unknown');
  assert.equal(calls, 1);
});

test('reusing a job ID for another recipient or for real SMTP after dry-run is rejected', async (t) => {
  const { dataDir, request } = await fixture(t);
  assert.equal((await sendDocumentMail(request, { env: {}, dataDir })).status, 'dry_run');
  const different = await sendDocumentMail({ ...request, recipient: 'other@example.com' }, { env: {}, dataDir });
  assert.equal(different.status, 'failed');
  assert.equal(different.errorCode, 'JOB_ID_CONFLICT');
  let calls = 0;
  const real = await sendDocumentMail(request, { env: smtpEnv(), dataDir,
    createTransport: () => { calls++; throw new Error('must not send'); } });
  assert.equal(real.errorCode, 'JOB_ID_CONFLICT');
  assert.equal(calls, 0);
});

test('header injection, multiple recipients, and path-like attachment names are rejected before transport', async (t) => {
  const { dataDir, request } = await fixture(t);
  const attacks = [
    { recipient: 'victim@example.com\r\nBcc: other@example.com' },
    { recipient: 'victim@example.com,other@example.com' },
    { subject: 'Report\nBcc: other@example.com' },
    { attachmentName: '../report.pdf' },
  ];
  let calls = 0;
  for (const attack of attacks) {
    const result = await sendDocumentMail({ ...request, ...attack }, { env: smtpEnv(), dataDir,
      createTransport: () => { calls++; throw new Error('must not send'); } });
    assert.equal(result.status, 'failed');
  }
  assert.equal(calls, 0);
});

test('a changed approved file and an oversized attachment fail before any SMTP submission', async (t) => {
  const { dataDir, request } = await fixture(t);
  let calls = 0;
  const createTransport = () => { calls++; throw new Error('must not send'); };
  await writeFile(request.attachmentPath, Buffer.from('different-content'));
  const changed = await sendDocumentMail(request, { env: smtpEnv(), dataDir, createTransport });
  assert.equal(changed.status, 'failed');
  assert.equal(changed.errorCode, 'ATTACHMENT_HASH_MISMATCH');
  const oversized = await sendDocumentMail(request, {
    env: smtpEnv({ MAIL_MAX_ATTACHMENT_BYTES: '4' }), dataDir, createTransport });
  assert.equal(oversized.errorCode, 'ATTACHMENT_TOO_LARGE');
  assert.equal(calls, 0);
});

test('a document outside the caller-provided artifact root cannot be attached', async (t) => {
  const { dir, dataDir, request } = await fixture(t);
  const artifactRoot = path.join(dir, 'artifacts');
  await mkdir(artifactRoot);
  const result = await sendDocumentMail(request, { env: {}, dataDir, attachmentRoot: artifactRoot });
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'INVALID_ATTACHMENT');
});

test('SMTP rejection is distinct from submission; a missing acceptance never becomes submitted', async (t) => {
  const { dataDir, request } = await fixture(t);
  const rejected = await sendDocumentMail(request, { env: smtpEnv(), dataDir,
    createTransport: () => ({ sendMail: async () => ({ accepted: [], rejected: [request.recipient] }) }) });
  assert.equal(rejected.status, 'failed');
  const unclear = await sendDocumentMail({ ...request, jobId: 'another-job' }, { env: smtpEnv(), dataDir,
    createTransport: () => ({ sendMail: async () => ({ messageId: 'some-id' }) }) });
  assert.equal(unclear.status, 'send_unknown');
});
