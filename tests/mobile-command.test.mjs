import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createControlServer } from '../lib/control.mjs';
import { runOnce } from '../agent/run.mjs';

const tokens = { userToken: 'u'.repeat(40), agentToken: 'a'.repeat(40), gatewayToken: 'g'.repeat(40) };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const parent = resolve(import.meta.dirname, '../.local');
  await mkdir(parent, { recursive: true });
  const dir = await mkdtemp(join(parent, 'test-mobile-command-'));
  const documents = join(dir, 'documents');
  await mkdir(documents);
  const server = createControlServer({ ...tokens, transferDir: join(dir, 'relay') });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolveClose => server.close(resolveClose));
    assert(dir.startsWith(parent + sep));
    await rm(dir, { recursive: true, force: true });
  });
  async function request(route, { method = 'GET', token = tokens.userToken, body } = {}) {
    const response = await fetch(base + route, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, data: await response.json() };
  }
  const code = (await request('/api/phone/pair-code', { method: 'POST' })).data.code;
  const pair = await request('/api/phone/pair', { method: 'POST', token: '', body: { code, deviceName: 'Command test phone' } });
  assert.equal(pair.status, 201);
  return {
    base, dir, documents, request,
    phone: (route, options = {}) => request(route, { ...options, token: pair.data.phoneToken }),
    phoneToken: pair.data.phoneToken,
    env: { API_BASE_URL: base, AGENT_TOKEN: tokens.agentToken, DEVICE_ID: 'home-pc', DOCUMENT_ROOT: documents, AI_MODE: 'lexical', MAIL_MODE: 'dry-run', MAIL_FROM: 'demo@example.com' },
  };
}

for (const edited of [false, true]) {
  test(`paired phone can request a PC file${edited ? ' with an edit' : ''}, select its candidate and download the verified result`, async t => {
    const f = await fixture(t);
    const source = Buffer.from('DIANA command fixture\n분기 성과: 매출 10, 개선 목표: 처리 시간 단축\n');
    const filename = 'quarterly-report.txt';
    await writeFile(join(f.documents, filename), source);
    const body = {
      requestId: randomUUID(), query: 'quarterly-report', delivery: 'download', autoSend: false,
      editInstruction: edited ? '개선 목표를 첫 줄에 정리해 주세요.' : '',
    };
    const created = await f.phone('/api/jobs', { method: 'POST', body });
    assert.equal(created.status, 201);
    assert.equal(created.data.job.state, 'waiting_pc');
    const replay = await f.phone('/api/jobs', { method: 'POST', body });
    assert.equal(replay.status, 200);
    assert.equal(replay.data.duplicate, true);
    assert.equal((await f.phone('/api/jobs', { method: 'POST', body: { ...body, query: 'different file' } })).status, 409);
    assert.equal((await f.phone('/api/agent/next')).status, 401);

    const stateDir = join(f.dir, 'pc-agent');
    await runOnce({ env: f.env, stateDir });
    let job = (await f.phone('/api/jobs')).data.jobs.find(value => value.id === body.requestId);
    assert.equal(job.state, 'needs_selection', 'one search hit still requires the phone to choose it');
    assert.equal(job.candidates.length, 1);
    const candidate = job.candidates[0];
    assert.equal(candidate.filename, filename);
    assert.equal(candidate.sha256, digest(source));
    assert.equal(JSON.stringify(candidate).includes(f.documents), false, 'the phone must not receive a PC filesystem path');
    const choose = candidateId => f.phone(`/api/jobs/${job.id}/selection`, { method: 'POST', body: { candidateId, approve: true } });
    assert.equal((await choose(randomUUID())).status, 400);
    assert.equal((await choose(candidate.id)).status, 200);
    assert.equal((await choose(candidate.id)).status, 409, 'the native client must reconcile an ambiguous selection response');

    const expected = edited ? Buffer.from('개선 목표: 처리 시간 단축\n분기 성과: 매출 10\n') : source;
    let editCalls = 0;
    const result = await runOnce({
      env: f.env, stateDir,
      mailSender: () => { throw new Error('A mobile download must not send email'); },
      artifactPreparer: async request => {
        editCalls++;
        assert.equal(request.instruction, body.editInstruction);
        assert.equal(request.sourcePath, join(f.documents, filename));
        const outputDir = join(stateDir, 'edited-output');
        await mkdir(outputDir, { recursive: true });
        const attachmentName = 'quarterly-report_수정본.txt';
        const attachmentPath = join(outputDir, attachmentName);
        await writeFile(attachmentPath, expected);
        return { attachmentPath, attachmentName, sha256: digest(expected), edited: true };
      },
    });
    assert.equal(result.status, 'download_ready');
    assert.equal(editCalls, edited ? 1 : 0);
    const jobs = (await f.phone('/api/jobs')).data.jobs;
    assert.equal(jobs.length, 1, 'retry must not enqueue a second PC operation');
    job = jobs[0];
    assert.equal(job.selectedId, candidate.id);
    assert.equal(job.artifact.sha256, digest(expected));
    const download = await fetch(`${f.base}/api/jobs/${job.id}/file`, { headers: { Authorization: `Bearer ${f.phoneToken}` } });
    assert.equal(download.status, 200);
    const received = Buffer.from(await download.arrayBuffer());
    assert.deepEqual(received, expected);
    assert.equal(received.length, job.artifact.bytes);
    assert.deepEqual(await readFile(join(f.documents, filename)), source, 'editing must preserve the PC source');
  });
}
