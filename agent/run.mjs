import {fileCipher} from './file-cipher.mjs';
import {keyStore} from './secure-keys.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { scanDocuments, resolveDocumentRoot, validateAttachment, readVerifiedArtifact } from './documents.mjs';
import { searchDocuments } from './search.mjs';
import { runOvernight } from './overnight.mjs';
import { receiveIncomingOnce } from './incoming.mjs';
import {checkPhoneApproval} from './pair-approval.mjs';

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const JOB_ID = /^[A-Za-z0-9_-]{1,128}$/;
const CANDIDATE_ID = /^[a-f0-9]{64}$/;
const RESULT_STATUSES = new Set(['dry_run', 'submitted', 'send_unknown', 'failed']);

export function readAgentConfig(env = process.env) {
  let apiBase;
  try { apiBase = new URL(env.API_BASE_URL ?? ''); } catch { throw new Error('API_BASE_URL is required and must be a valid URL.'); }
  const loopback = apiBase.hostname === 'localhost' || apiBase.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(apiBase.hostname);
  if ((apiBase.protocol !== 'https:' && !(apiBase.protocol === 'http:' && loopback)) || apiBase.username || apiBase.password || apiBase.search || apiBase.hash) {
    throw new Error('API_BASE_URL must use HTTPS, or HTTP on a loopback address, without credentials, query, or fragment.');
  }
  if (!env.AGENT_TOKEN?.trim() || /[\r\n]/.test(env.AGENT_TOKEN)) throw new Error('AGENT_TOKEN is required.');
  if (!env.DEVICE_ID?.trim() || env.DEVICE_ID.length > 128) throw new Error('DEVICE_ID is required (up to 128 characters).');
  return {
    apiBase: apiBase.href.replace(/\/$/, ''), token: env.AGENT_TOKEN.trim(), deviceId: env.DEVICE_ID.trim(),
    documentRoot: path.resolve(PROJECT_ROOT, env.DOCUMENT_ROOT || './sample-documents'),
    pollMs: Math.max(1000, Math.min(60_000, Number(env.AGENT_POLL_MS) || 3000)),
  };
}

async function apiRequest(config, route, { fetchImpl, method = 'GET', body, binaryBody, headers = {}, signal }) {
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000);
  const response = await fetchImpl(`${config.apiBase}${route}`, {
    method, signal: requestSignal, redirect: 'error',
    headers: { Authorization: `Bearer ${config.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? (binaryBody === undefined ? {} : { body: binaryBody }) : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`Control server request failed (HTTP ${response.status}).`);
  if (response.status === 204) return null;
  return response.json();
}

function validateJob(job, config) {
  if (!job || !JOB_ID.test(job.id ?? '') || job.deviceId !== config.deviceId || !['search', 'send', 'overnight'].includes(job.action)) {
    throw new Error('Control server returned an invalid job or a job for another device.');
  }
  if (job.action === 'search' && (typeof job.query !== 'string' || !job.query.trim() || job.query.length > 2000)) {
    throw new Error('Control server returned an invalid search query.');
  }
  if (job.action === 'send') {
    const delivery = job.delivery ?? 'email';
    if (!['email', 'download', 'both'].includes(delivery) || !CANDIDATE_ID.test(job.candidateId ?? '') ||
        (delivery !== 'download' && (typeof job.recipient !== 'string' || !job.recipient.trim()))) {
      throw new Error('Control server returned an invalid send request.');
    }
    if (job.editInstruction != null && (typeof job.editInstruction !== 'string' || job.editInstruction.length > 2000)) {
      throw new Error('Control server returned an invalid document edit instruction.');
    }
  }
}

function jobFile(stateDir, jobId) {
  if (!JOB_ID.test(jobId)) throw new Error('Invalid job ID.');
  return path.join(stateDir, 'jobs', `${jobId}.json`);
}

async function saveSelection(stateDir, job, scan, result) {
  const byId = new Map(scan.documents.map(document => [document.id, document]));
  const candidates = {};
  for (const selected of result.candidates) {
    const document = byId.get(selected.id);
    if (!document) throw new Error('Search selected an unknown document.');
    candidates[selected.id] = {
      id: document.id, relativePath: document.relativePath, sha256: document.sha256, filename: document.filename,
    };
  }
  const filename = jobFile(stateDir, job.id);
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({ version: 1, jobId: job.id, documentRoot: scan.documentRoot, mode: result.mode, candidates }), { mode: 0o600, flag: 'wx' });
  await rename(temporary, filename);
}

async function prepareAttachment(stateDir, job, config, { includeBytes = false } = {}) {
  let saved;
  try { saved = JSON.parse(await readFile(jobFile(stateDir, job.id), 'utf8')); }
  catch { throw new Error('No saved search candidates for this job. Search and approve a document first.'); }
  const currentRoot = await resolveDocumentRoot(config.documentRoot);
  if (saved.version !== 1 || saved.jobId !== job.id || path.relative(currentRoot, saved.documentRoot) !== '') {
    throw new Error('Document folder changed. Search and approve a document again.');
  }
  const candidate = saved.candidates?.[job.candidateId];
  if (!candidate || candidate.id !== job.candidateId) throw new Error('The selected candidate was not offered for this job.');
  return validateAttachment(currentRoot, candidate, { includeBytes });
}

function publicError(error, env) {
  let message = error instanceof Error ? error.message : 'Agent request failed.';
  if (error?.syscall) message = `Local document or state access failed (${error.code || 'filesystem error'}).`;
  for (const secret of [env.AGENT_TOKEN, env.OPENAI_API_KEY, env.GROQ_API_KEY, env.GROQ_OPENAI_KEY, env.SMTP_PASSWORD, env.SMTP_ACCESS_TOKEN]) {
    if (secret) message = message.replaceAll(secret, '[redacted]');
  }
  return message.slice(0, 300);
}

export async function runOnce({ env = process.env, fetchImpl = fetch, mailSender, artifactPreparer, stateDir = path.join(PROJECT_ROOT, '.local'), signal, cipher } = {}) {
  const config = readAgentConfig(env);
  const request = (route, options = {}) => apiRequest(config, route, { fetchImpl, signal, ...options });
  cipher??=fileCipher({stateDir,request});
  const next = await request('/api/agent/next');
  if (next?.job == null) return { idle: true };
  const job = next.job;
  validateJob(job, config);

  if (job.action === 'overnight') {
    try {
      return { idle:false, jobId:job.id, action:'overnight', ...(await runOvernight(job, {
        documentRoot:config.documentRoot, deviceId:config.deviceId, apiRequest:request, fetchImpl, env, stateDir, signal, encryptFile:(bytes,meta)=>cipher.encrypt(bytes,meta),
      })) };
    } catch (error) {
      const status = Date.now() >= Date.parse(job.deadlineAt) ? 'deadline_exceeded' : 'needs_attention';
      const message = publicError(error, env);
      await request(`/api/agent/jobs/${job.id}/result`,{method:'POST',body:{status,error:message}});
      return {idle:false,jobId:job.id,action:'overnight',status,error:message};
    }
  }

  if (job.action === 'search') {
    try {
      const scan = await scanDocuments({ documentRoot: config.documentRoot });
      const result = await searchDocuments(job.query, scan.documents, { env, fetchImpl, signal });
      await saveSelection(stateDir, job, scan, result);
      // The deployed protocol's legacy "openai" value means AI search. Keep
      // the actual provider in local results while older servers accept Groq.
      await request(`/api/agent/jobs/${job.id}/candidates`, { method: 'POST', body: {
        mode: result.mode === 'groq' ? 'openai' : result.mode, candidates: result.candidates,
      } });
      return { idle: false, jobId: job.id, action: 'search', ...result };
    } catch (error) {
      const message = publicError(error, env);
      await request(`/api/agent/jobs/${job.id}/error`, { method: 'POST', body: { error: message } });
      return { idle: false, jobId: job.id, action: 'search', status: 'failed', error: message };
    }
  }

  let result;
  let mailStarted = false;
  try {
    const delivery = job.delivery ?? 'email';
    let { buffer, ...attachment } = await prepareAttachment(stateDir, job, config, { includeBytes: delivery !== 'email' });
    if (job.editInstruction?.trim()) {
      const preparer = artifactPreparer ?? (await import('./edit.mjs')).prepareEditedArtifact;
      const artifact = await preparer({
        jobId: job.id, instruction: job.editInstruction, sourcePath: attachment.attachmentPath,
        sourceSha256: attachment.expectedSha256, sourceName: attachment.attachmentName,
      }, { env, stateDir, fetchImpl });
      if (!artifact || typeof artifact.attachmentName !== 'string' || !artifact.attachmentName || artifact.attachmentName.length > 240 ||
          /[\x00-\x1f\x7f/\\]/.test(artifact.attachmentName)) throw new Error('Edited artifact has an invalid filename.');
      const verified = await readVerifiedArtifact(artifact.attachmentPath, artifact.sha256, { sourcePath: attachment.attachmentPath, stateDir });
      buffer = verified.buffer;
      attachment = { attachmentPath: verified.attachmentPath, attachmentName: artifact.attachmentName, expectedSha256: artifact.sha256 };
    }
    if (delivery !== 'email') {
      await request(`/api/agent/jobs/${job.id}/file`, {
        method: 'POST', binaryBody: await cipher.encrypt(buffer,{id:job.id,filename:attachment.attachmentName}),
        headers: {
          'Content-Type': 'application/octet-stream', 'X-File-SHA256': attachment.expectedSha256,
          'X-File-Name': encodeURIComponent(attachment.attachmentName), 'X-Source-File-Id': job.candidateId,
        },
      });
    }
    if (delivery === 'download') {
      result = { status: 'download_ready' };
    } else {
      const sender = mailSender ?? (await import('../lib/mail.mjs')).sendDocumentMail;
      mailStarted = true;
      result = await sender({ jobId: job.id, recipient: job.recipient, subject: job.subject || '요청하신 문서', ...attachment }, { env, dataDir: stateDir });
      if (!result || !RESULT_STATUSES.has(result.status)) throw new Error('Mailer returned an unknown delivery state.');
      result = {
        status: result.status,
        ...(typeof result.messageId === 'string' ? { messageId: result.messageId.slice(0, 300) } : {}),
        ...(result.error ? { error: publicError(new Error(String(result.error)), env) } : {}),
      };
    }
  } catch (error) {
    result = { status: mailStarted ? 'send_unknown' : 'failed', error: publicError(error, env) };
  }
  // A failed report is retried through the mailer's stable job-ID delivery ledger.
  await request(`/api/agent/jobs/${job.id}/result`, { method: 'POST', body: result });
  return { idle: false, jobId: job.id, action: 'send', ...result };
}

export async function runAgent({ env = process.env, fetchImpl = fetch, mailSender, artifactPreparer, stateDir, signal, once = false, logger = console, cipher } = {}) {
  const config = readAgentConfig(env);
  stateDir??=path.join(PROJECT_ROOT,'.local');
  const request=(route,options={})=>apiRequest(config,route,{fetchImpl,signal,...options});
  cipher??=fileCipher({stateDir,request});
  const keys=keyStore(path.join(stateDir,'e2ee'));
  const approvalStop=new AbortController(),approvalSignal=signal?AbortSignal.any([signal,approvalStop.signal]):approvalStop.signal;
  const approvals=once?Promise.resolve():(async()=>{while(!approvalSignal.aborted){try{await checkPhoneApproval({request:(route,options={})=>apiRequest(config,route,{fetchImpl,signal:approvalSignal,...options}),signal:approvalSignal,keys,logger});}catch{if(!approvalSignal.aborted)logger.error('휴대폰 연결 승인 상태를 다시 확인합니다.');}try{await delay(5000,undefined,{signal:approvalSignal});}catch{break;}}})();
  try {
  let failures = 0;
  let catalogAt = 0;
  let incomingAt = 0;
  do {
    try {
      if (Date.now() >= incomingAt) {
        try {
          const incoming = await receiveIncomingOnce({ config, fetchImpl, signal, decryptFile:(bytes,meta)=>cipher.decrypt(bytes,meta) });
          incomingAt = Date.now() + (incoming.unsupported ? 60_000 : config.pollMs);
          if (!incoming.idle) {
            logger.log(`Agent receive: ${incoming.status}`);
            if (incoming.status === 'pc_saved') catalogAt = 0;
            if (once) return incoming;
          }
        } catch (error) {
          if (signal?.aborted) return;
          incomingAt = Date.now() + Math.max(10_000, config.pollMs);
          logger.error('Agent receive: 휴대폰 파일 수신을 다시 확인합니다.');
        }
      }
      if (Date.now() >= catalogAt) {
        const catalog = await scanDocuments({documentRoot:config.documentRoot});
        await apiRequest(config,'/api/agent/catalog',{fetchImpl,signal,method:'POST',body:{documents:catalog.documents.map(document=>({
          id:document.id,filename:document.filename,sha256:document.sha256,bytes:document.bytes,modifiedAt:document.modifiedAt,
        }))}});
        catalogAt = Date.now() + 60_000;
      }
      const result = await runOnce({ env, fetchImpl, mailSender, artifactPreparer, stateDir, signal, cipher });
      failures = 0;
      if (!result.idle) logger.log(`Agent ${result.action}: ${result.status ?? `${result.candidates.length} candidates (${result.mode})`}`);
      if (once) return result;
    } catch (error) {
      if (signal?.aborted) return;
      failures += 1;
      logger.error(`Agent: ${publicError(error, env)}`);
      if (once) throw error;
    }
    const wait = Math.min(60_000, config.pollMs * (2 ** Math.min(failures, 5)));
    try { await delay(wait, undefined, { signal }); } catch (error) { if (signal?.aborted) return; throw error; }
  } while (!signal?.aborted);
  }finally{approvalStop.abort();await approvals;}
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  runAgent({ once: process.argv.includes('--once'), signal: controller.signal }).catch(error => {
    console.error(publicError(error, process.env));
    process.exitCode = 1;
  });
}
