import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRelay } from '../tests/helpers/paired-relay.mjs';
import { zipFiles } from '../tests/helpers/release-zip.mjs';

const [bundleArg, fixtureParent] = process.argv.slice(2);
if (!bundleArg || !fixtureParent) throw Error('Usage: node scripts/check-paired-product.mjs BUILT_DIANA_PC_FOLDER FIXTURE_PARENT');
const bundle = path.resolve(bundleArg);
const { start } = await import(pathToFileURL(path.join(bundle, 'app/financial-desktop/paired-host.mjs')));
const fixture = path.resolve(fixtureParent, 'paired-product-' + randomUUID());
const known = Object.fromEntries(['desktop', 'documents', 'downloads'].map(key => [key, path.join(fixture, key)]));
for (const dir of Object.values(known)) await mkdir(dir, { recursive: true });
const relay = await createRelay({ pollMs: 1000, requestMs: 12000 });
const config = { state: path.join(fixture, 'state'), known, port: 0,
  python: path.join(bundle, 'runtime/python/python.exe'), relayOrigin: relay.origin };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
let host;
let ownerToken;
let phone;

async function call(origin, body, { token = '', owner, status = 200 } = {}) {
  const response = await fetch(origin + '/v1', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token,
      ...(owner ? { 'x-local-owner': owner } : {}) },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });
  const result = await response.json();
  assert.equal(response.status, status, body.op + '/' + (body.action || '') + ': ' + (result.error || ''));
  return result;
}
const pc = body => call(host.origin, body, { token: ownerToken, owner: host.owner });
const mobile = (body, status = 200) => call(relay.origin, body, { token: phone.token, status });
const send = async (text, id = randomUUID()) => {
  await mobile({ op: 'job', action: 'desk-start', text, id });
  return id;
};
async function waitFor(id, status) {
  for (let i = 0; i < 120; i++) {
    const job = (await pc({ op: 'state' })).jobs.find(job => job.id === id);
    if (job?.status === status) return job;
    assert.notEqual(job?.status, 'failed', job?.error);
    await sleep(150);
  }
  throw Error('Timed out waiting for ' + status);
}
async function approve(id, inspect = () => {}) {
  const job = await waitFor(id, 'approval');
  inspect(job.preview);
  const remote = await mobile({ op: 'state' });
  const remoteJob = remote.jobs.find(job => job.id === id);
  assert.equal(remoteJob.status, 'approval');
  assert.equal(remoteJob.preview, undefined);
  assert.equal(remoteJob.nonce, undefined);
  assert.equal(remote.legacy, undefined);
  assert(!remote.files.some(file => file.id === id));
  await mobile({ op: 'job', action: 'desk-approve', id, nonce: job.nonce }, 403);
  await pc({ op: 'job', action: 'desk-approve', id, nonce: job.nonce });
  await pc({ op: 'job', action: 'desk-approve', id, nonce: job.nonce });
}
async function receive(id) {
  const local = (await pc({ op: 'state' })).files.filter(file => file.id === id);
  assert.equal(local.length, 1);
  const result = await mobile({ op: 'file', id });
  const bytes = Buffer.from(result.data, 'base64');
  assert.equal(bytes.length, local[0].bytes);
  assert.equal(sha256(bytes), local[0].sha256);
  assert.deepEqual(bytes, await readFile(local[0].location));
  assert.equal((await mobile({ op: 'state' })).files.find(file => file.id === id).location, undefined);
  const copy = path.join(fixture, 'received-' + result.name);
  await writeFile(copy, bytes, { flag: 'wx' });
  await mobile({ op: 'receipt', id, bytes: bytes.length, hash: 'wrong' }, 400);
  await mobile({ op: 'receipt', id, bytes: bytes.length, hash: sha256(await readFile(copy)) });
  assert((await mobile({ op: 'state' })).files.find(file => file.id === id).received);
  return bytes;
}

try {
  host = await start(config);
  const signup = await call(host.origin, { op: 'signup', email: 'paired-test@example.invalid',
    password: randomBytes(16).toString('hex') });
  ownerToken = (await call(host.origin, { op: 'register' },
    { token: signup.token, owner: host.owner })).token;
  const { code } = await pc({ op: 'code' });
  assert.match(code, /^\d{6}$/);
  const pair = { op: 'pair-code', code, requestId: randomUUID(), pairKey: randomBytes(32).toString('hex') };
  phone = await call(relay.origin, pair);
  assert.deepEqual(await call(relay.origin, pair), phone);
  await call(relay.origin, { ...pair, requestId: randomUUID() }, { status: 403 });
  await mobile({ op: 'settings' }, 403);

  for (let i = 1; i <= 4; i++) {
    await writeFile(path.join(known.downloads, i + '분기 관측.txt'),
      '분기 점검을 마쳤습니다.\n사용량: ' + i * 10 + '건\n');
  }
  const report = await send('다운로드에서 1~4분기 자료를 찾아 핵심 수치와 변화를 정리한 보고서를 작성해줘');
  await approve(report, preview => { assert.match(preview, /40/); assert.match(preview, /4분기 관측/); });
  assert.equal((await receive(report)).subarray(0, 5).toString(), '%PDF-');
  console.log('Six-digit pairing and report: discovery, preview, owner approval, download and receipt');

  const sourcePath = path.join(known.desktop, '현장 기록.txt');
  const original = '현장 기록입니다. 점검 시간은 18분입니다.';
  await writeFile(sourcePath, original);
  const summary = await send('바탕화면에서 "현장 기록.txt"를 요약해서 TXT로 만들어줘');
  await approve(summary, text => assert.match(text, /18분/));
  assert.match((await receive(summary)).toString(), /18분/);
  const slides = await send('바탕화면에서 "현장 기록.txt"를 읽고 발표자료로 만들어줘');
  await approve(slides);
  assert.equal((await receive(slides)).subarray(0, 5).toString(), '%PDF-');
  const editText = '바탕화면에서 "현장 기록.txt"의 "18분"을 "12분"으로 바꿔줘';
  const edit = await send(editText);
  await waitFor(edit, 'approval');
  const preview = { op: 'phone-preview', id: edit };
  const allow = enabled => pc({ op: 'phone-approval-settings', device: phone.device, enabled });
  await mobile(preview, 403);
  await mobile({ op: 'phone-approval-settings', device: phone.device, enabled: true }, 403);
  await allow(true);
  const phoneJob = (await mobile({ op: 'state' })).jobs.find(job => job.id === edit);
  assert.equal(phoneJob.canApprove, true);
  assert.equal(phoneJob.preview, undefined);
  assert.equal(phoneJob.nonce, undefined);

  const { code: secondCode } = await pc({ op: 'code' });
  const otherPhone = await call(relay.origin, { ...pair, code: secondCode, requestId: randomUUID(), pairKey: randomBytes(32).toString('hex') });
  await pc({ op: 'phone-approval-settings', device: otherPhone.device, enabled: true });
  const other = (body, status) => call(relay.origin, body, { token: otherPhone.token, status });
  await other(preview, 403);
  await other({ op: 'job', action: 'desk-start', id: edit, text: editText }, 400);
  const shown = await mobile(preview);
  assert.match(shown.preview, /12분/);
  assert.equal(shown.format, 'md');
  const save = { op: 'phone-approve', id: edit, nonce: shown.nonce, confirm: true };
  await other(save, 403);
  await mobile({ ...save, confirm: false }, 409);
  await mobile({ ...save, nonce: randomUUID() }, 409);
  await allow(false);
  await mobile(save, 403);
  await allow(true);
  assert(!(await pc({ op: 'state' })).files.some(file => file.id === edit));
  await mobile(save);
  await mobile(save, 409);
  assert.match((await receive(edit)).toString(), /12분/);
  assert.equal(await readFile(sourcePath, 'utf8'), original);
  await pc({ op: 'revoke', device: otherPhone.device });
  await other(preview, 403);
  const pcOnly = randomUUID();
  await pc({ op: 'job', action: 'desk-start', id: pcOnly, text: editText });
  await waitFor(pcOnly, 'approval');
  await mobile({ op: 'phone-preview', id: pcOnly }, 403);
  await approve(pcOnly);
  await receive(pcOnly);
  const convert = await send('바탕화면에서 "현장 기록.txt"를 DOCX로 변환해줘');
  await approve(convert, text => assert.match(text, /18분/));
  assert.equal((await receive(convert)).subarray(0, 2).toString(), 'PK');
  const create = await send('새 문서를 DOCX로 작성해줘. 내용: 정기 점검은 목요일입니다.');
  await approve(create, text => assert.match(text, /목요일/));
  await receive(create);
  console.log('Summary, presentation, edit, conversion and new document');

  const missingPath = path.join(known.desktop, '누락 기록.txt');
  const retry = await send('바탕화면에서 "누락 기록.txt"를 요약해서 TXT로 만들어줘');
  assert.match((await waitFor(retry, 'failed')).error, /누락 기록/);
  await assert.rejects(access(missingPath));
  await writeFile(missingPath, '추가 점검에서 스위치 3개를 교체했습니다.');
  await mobile({ op: 'job', action: 'desk-retry', id: retry });
  await approve(retry);
  await receive(retry);
  assert(!(await mobile({ op: 'state' })).jobs.some(job => job.id === retry));
  const changed = await send('바탕화면에서 "현장 기록.txt"를 요약해서 TXT로 만들어줘');
  await waitFor(changed, 'approval');
  const pending = await mobile({ op: 'phone-preview', id: changed });
  await writeFile(sourcePath, '승인 전에 바뀐 원문');
  await mobile({ op: 'phone-approve', id: changed, nonce: pending.nonce, confirm: true }, 409);
  await waitFor(changed, 'failed');
  assert(!(await pc({ op: 'state' })).files.some(file => file.id === changed));
  console.log('Missing source retry and stale approval protection');

  const reviewSources = path.join(bundle, 'app/financial-documents/fixtures/fund-a');
  for (const name of ['review.md', 'guideline.json', 'due-diligence.txt']) {
    await copyFile(path.join(reviewSources, name), path.join(known.downloads, name));
  }
  const approveReview = async kind => {
    const pending = (await pc({ op: 'state' })).legacy.pending;
    assert.equal(pending?.kind, kind);
    await pc({ op: 'job', action: 'approve', planId: pending.id, revision: pending.revision, confirmed: true });
  };
  await send('이 문서 검토해줘.');
  const materials = await pc({ op: 'review-options' });
  await pc({ op: 'review-connect',
    guide: materials.guides.find(item => item.name === 'guideline.json').id,
    target: materials.docs.find(item => item.name === 'review.md').id,
    sources: [materials.docs.find(item => item.name === 'due-diligence.txt').id],
  });
  await approveReview('review');
  const beforePatch = new Set((await pc({ op: 'state' })).files.map(file => file.id));
  await send('근거 있는 누락만 보완안 만들어줘.');
  await approveReview('patch');
  const patched = (await pc({ op: 'state' })).files.find(file => file.format === 'md' && !beforePatch.has(file.id));
  assert(patched);
  assert.match((await receive(patched.id)).toString(), /핵심/);
  assert.deepEqual(await readFile(path.join(known.downloads, 'review.md')),
    await readFile(path.join(reviewSources, 'review.md')));
  console.log('Checklist review and evidence-backed patch, with original preserved');

  const attached = Buffer.from('현장 점검에서 장치 217개가 정상 작동했습니다.');
  await mobile({ op: 'job', action: 'desk-upload', id: randomUUID(), name: '첨부 점검 자료.txt',
    base64: attached.toString('base64'), sha256: sha256(attached) });
  for (const request of [
    '첨부한 자료를 보고서로 만들어줘',
    '첨부한 자료로 보고서 작성해줘',
    '첨부한 자료를 보고서 PDF로 만들어줘',
  ]) {
    const attachedReport = await send(request);
    await approve(attachedReport, preview => {
      assert.match(preview, /자료 범위/);
      assert.match(preview, /첨부 점검 자료\.txt/);
      assert.match(preview, /217개/);
    });
    assert.equal((await receive(attachedReport)).subarray(0, 5).toString(), '%PDF-');
  }

  const pptx = await send('바탕화면에서 "현장 기록.txt"를 PPTX로 변환해줘');
  await approve(pptx);
  const pptxParts = zipFiles(await receive(pptx));
  const pptxFile = (await pc({ op: 'state' })).files.find(file => file.id === pptx);
  assert.equal(pptxFile.format, 'pptx');
  assert.match(pptxFile.name, /\.pptx$/);
  assert(pptxParts.has('ppt/presentation.xml'));
  assert(pptxParts.has('ppt/slides/slide1.xml'));
  console.log('Attached report and explicit PPTX conversion');
} finally {
  await host?.close();
  await relay.close();
}
