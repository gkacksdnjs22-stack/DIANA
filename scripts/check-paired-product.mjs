import {newIdentity,acceptKey,seal,openEnvelope} from '../lib/e2ee.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { access, copyFile, mkdir, readdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRelay } from '../tests/helpers/paired-relay.mjs';
import { zipFiles } from '../tests/helpers/release-zip.mjs';

const [bundleArg, fixtureParent, previousBundle] = process.argv.slice(2);
if (!bundleArg || !fixtureParent) throw Error('Usage: node scripts/check-paired-product.mjs BUILT_DIANA_PC_FOLDER FIXTURE_PARENT [PREVIOUS_DIANA_PC_FOLDER]');
const bundle = path.resolve(bundleArg);
const { start } = await import(pathToFileURL(path.join(bundle, 'app/financial-desktop/paired-host.mjs')));
const startPrevious = previousBundle
  ? (await import(pathToFileURL(path.resolve(previousBundle,'app/financial-desktop/paired-host.mjs')))).start
  : null;
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
const pc = (body, status = 200) => call(host.origin, body, { token: ownerToken, owner: host.owner, status });
const phoneKeys=new Map();
async function encryptedCall(client,body,status=200){
 const id=randomUUID(),key=phoneKeys.get(client.device),data=seal(Buffer.from(JSON.stringify({at:Date.now(),body})),[key],{id,filename:'request.json',direction:'phone-pc'}).toString('base64');
 const response=await fetch(relay.origin+'/v1',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+client.token},body:JSON.stringify({op:'encrypted',id,data}),signal:AbortSignal.timeout(30000)});
 const wire=await response.json();if(response.status!==200){assert.equal(response.status,status,body.op+': '+wire.error);return wire;}
 const result=JSON.parse(openEnvelope(Buffer.from(wire.encrypted,'base64'),[key],{id,filename:'reply.json',direction:'pc-phone'}));assert.equal(result.status,status,body.op+': '+result.body.error);return result.body;
}
const mobile=(body,status=200)=>encryptedCall(phone,body,status);
async function connectPhone(code){
 const identity=newIdentity(),pair={op:'pair-code',code,requestId:randomUUID(),pairKey:randomBytes(32).toString('hex'),deviceName:'Synthetic phone',publicKey:identity.publicKey};
 const waiting=await call(relay.origin,pair,{status:202});assert.equal(waiting.token,undefined);
 const pending=(await pc({op:'pair-pending'})).pending.find(p=>p.requestId===pair.requestId);assert(pending);
 await call(host.origin,{op:'pair-approve',id:pending.id,approve:true},{token:ownerToken,status:403});
 await pc({op:'pair-approve',id:pending.id,approve:true});const result=await call(relay.origin,pair);
 phoneKeys.set(result.device,acceptKey(identity,result.e2ee,pair.requestId));return{result,pair};
}
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
  host = await (startPrevious??start)(config);
  const signup = await call(host.origin, { op: 'signup', email: 'paired-test@example.invalid',
    password: randomBytes(16).toString('hex') });
  ownerToken = (await call(host.origin, { op: 'register' },
    { token: signup.token, owner: host.owner })).token;
  if(startPrevious){await host.close();host=await start(config);}
  const { code } = await pc({ op: 'code' });
  assert.match(code, /^\d{6}$/);
  const connected=await connectPhone(code),pair=connected.pair;phone=connected.result;
  assert.deepEqual(await call(relay.origin, pair), phone);
  await call(relay.origin,{op:'state'},{token:phone.token,status:403});
  const replayId=randomUUID(),replayData=seal(Buffer.from(JSON.stringify({at:Date.now(),body:{op:'state'}})),[phoneKeys.get(phone.device)],{id:replayId,filename:'request.json',direction:'phone-pc'}).toString('base64');
  const replay={op:'encrypted',id:replayId,data:replayData};
  await call(relay.origin,replay,{token:phone.token});
  await call(relay.origin,replay,{token:phone.token,status:409});
  const staleId=randomUUID(),staleData=seal(Buffer.from(JSON.stringify({at:Date.now()-300000,body:{op:'state'}})),[phoneKeys.get(phone.device)],{id:staleId,filename:'request.json',direction:'phone-pc'}).toString('base64');
  await call(relay.origin,{op:'encrypted',id:staleId,data:staleData},{token:phone.token,status:409});
  await call(relay.origin, { ...pair, requestId: randomUUID() }, { status: 403 });
  await mobile({ op: 'settings' }, 403);
  const approvalEnabled = async device => (await pc({op:'settings'})).devices.find(d=>d.id===device).mobile_approval;
  assert.equal(await approvalEnabled(phone.device),1);

  for (let i = 1; i <= 4; i++) {
    await writeFile(path.join(known.downloads, i + '분기 관측.txt'),
      '분기 점검을 마쳤습니다.\n사용량: ' + i * 10 + '건\n');
  }
  const report = await send('다운로드에서 1~4분기 자료를 찾아 핵심 수치와 변화를 정리한 보고서를 작성해줘');
  await waitFor(report,'approval');
  const initialReport = (await mobile({op:'state'})).jobs.find(job=>job.id===report);
  assert.equal(initialReport.canApprove,true);
  assert(!(await mobile({op:'state'})).files.some(file=>file.id===report));
  const initialPreview = await mobile({op:'phone-preview',id:report});
  assert.match(initialPreview.preview,/40/);
  assert.match(initialPreview.preview,/4분기 관측/);
  await mobile({op:'phone-approve',id:report,nonce:initialPreview.nonce,confirm:true});
  const reportBytes = await receive(report);
  assert.equal(reportBytes.subarray(0, 5).toString(), '%PDF-');
  console.log('PC-approved pairing permits encrypted preview, explicit document approval, download and receipt');

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
  await allow(false);
  await mobile(preview,403);
  assert.deepEqual(await call(relay.origin,pair),phone);
  assert.equal(await approvalEnabled(phone.device),0);
  await host.close();
  host=await start(config);
  assert.equal(await approvalEnabled(phone.device),0);
  await mobile(preview,403);
  await mobile({ op: 'phone-approval-settings', device: phone.device, enabled: true }, 403);
  await allow(true);
  await host.close();
  host=await start(config);
  assert.equal(await approvalEnabled(phone.device),1);
  const phoneJob = (await mobile({ op: 'state' })).jobs.find(job => job.id === edit);
  assert.equal(phoneJob.canApprove, true);
  assert.equal(phoneJob.preview, undefined);
  assert.equal(phoneJob.nonce, undefined);

  const { code: secondCode } = await pc({ op: 'code' });
  const otherPhone = (await connectPhone(secondCode)).result;
  assert.equal(await approvalEnabled(otherPhone.device),1);
  const other = (body,status=200) => encryptedCall(otherPhone,body,status);
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
  const outputDir = await realpath((await pc({ op: 'settings' })).output);
  const relativeOutput = path.relative(await realpath(fixture), outputDir);
  assert(relativeOutput.startsWith(path.join('documents', 'DIANA', '결과') + path.sep));
  const pausedOutput = outputDir + '-paused';
  async function interruptSave(approval) {
    await rename(outputDir, pausedOutput);
    try {
      await mobile(approval, 400);
      await waitFor(approval.id, 'saving');
      assert(!(await pc({ op: 'state' })).files.some(file => file.id === approval.id));
    } finally {
      await rename(pausedOutput, outputDir);
    }
  }
  await interruptSave(save);
  const retryable = (await mobile({ op: 'state' })).jobs.find(job => job.id === edit);
  assert.equal(retryable.status, 'saving');
  assert.equal(retryable.canApprove, true);
  assert.equal(retryable.nonce, undefined);
  const retryPreview = await mobile(preview);
  assert.equal(retryPreview.status, 'saving');
  assert.equal(retryPreview.nonce, shown.nonce);
  assert.equal(retryPreview.preview, shown.preview);
  await other(save, 403);
  await mobile({ ...save, nonce: randomUUID() }, 409);
  await allow(false);
  await mobile(save, 403);
  await allow(true);
  await mobile(save);
  await mobile(save, 409);
  assert.match((await receive(edit)).toString(), /12분/);
  assert.equal(await readFile(sourcePath, 'utf8'), original);
  for (const mode of ['phone', 'pc']) {
    const id = await send(editText);
    await waitFor(id, 'approval');
    const shown = await mobile({ op: 'phone-preview', id });
    const approval = { op: 'phone-approve', id, nonce: shown.nonce, confirm: true };
    await interruptSave(approval);
    const revised = original + '\n현장 확인을 추가했습니다.';
    await writeFile(sourcePath, revised);
    if (mode === 'phone') await mobile(approval, 409);
    else await pc({ op: 'job', action: 'desk-retry', id });
    const stale = (await pc({ op: 'state' })).jobs.find(job => job.id === id);
    assert.equal(stale?.status, 'failed');
    assert.match(stale.error, /자료가 바뀌었거나/);
    assert(!(await pc({ op: 'state' })).files.some(file => file.id === id));
    assert(!(await readdir(outputDir)).some(name => name.includes(id.slice(0, 8))));
    await mobile({ op: 'phone-preview', id }, 409);
    await mobile({ op: 'job', action: 'desk-retry', id });
    await waitFor(id, 'approval');
    const fresh = await mobile({ op: 'phone-preview', id });
    assert.notEqual(fresh.nonce, shown.nonce);
    assert.match(fresh.preview, /현장 확인을 추가했습니다/);
    await mobile(approval, 409);
    await mobile({ ...approval, nonce: fresh.nonce });
    assert.match((await receive(id)).toString(), /현장 확인을 추가했습니다/);
    assert.equal(await readFile(sourcePath, 'utf8'), revised);
    await writeFile(sourcePath, original);
  }
  console.log('Phone and PC interrupted saves require a fresh preview if the source changes');
  const jobsDatabase = path.join(known.documents, 'DIANA', '앱 설정', 'paired-dev', 'profiles',
    path.basename(outputDir), 'local-state.workbench', 'jobs.sqlite');
  await access(jobsDatabase);
  for (const mode of ['phone', 'pc']) {
    const id = await send(editText);
    await waitFor(id, 'approval');
    const shown = await mobile({ op: 'phone-preview', id });
    const approval = { op: 'phone-approve', id, nonce: shown.nonce, confirm: true };
    const db = new DatabaseSync(jobsDatabase);
    try {
      db.exec("CREATE TRIGGER fail_test_record BEFORE INSERT ON files BEGIN SELECT RAISE(ABORT,'test record write failure'); END");
      try {
        await mobile(approval, 400);
        await waitFor(id, 'saving');
        assert(!(await pc({ op: 'state' })).files.some(file => file.id === id));
      } finally {
        db.exec('DROP TRIGGER fail_test_record');
      }
    } finally {
      db.close();
    }
    const names = (await readdir(outputDir)).filter(name => name.includes(id.slice(0, 8)));
    assert.equal(names.length, 1);
    const dest = path.join(outputDir, names[0]);
    const written = await readFile(dest);
    assert.match(written.toString(), /12분/);
    const revised = original + '\n저장 기록 실패 이후의 새 내용입니다.';
    if (mode === 'phone') {
      const altered = Buffer.from('승인한 파일과 다른 내용입니다.');
      await writeFile(dest, altered);
      await mobile(approval, 400);
      assert.deepEqual(await readFile(dest), altered);
      assert(!(await pc({ op: 'state' })).files.some(file => file.id === id));
      await writeFile(dest, written);
    }
    await writeFile(sourcePath, revised);
    const before = await stat(dest, {bigint: true});
    if (mode === 'phone') await mobile(approval);
    else await pc({ op: 'job', action: 'desk-retry', id });
    assert.deepEqual(await receive(id), written);
    const after = await stat(dest, {bigint: true});
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeNs, before.mtimeNs);
    assert.equal(await readFile(sourcePath, 'utf8'), revised);
    await writeFile(sourcePath, original);
  }
  console.log('Phone and PC recover the record for an already written file without rewriting it');
  const deepBranch = path.join(known.desktop, '다른 작업');
  await mkdir(path.join(deepBranch, ...Array.from({length:9}, (_, index) => '하위 ' + index)), {recursive:true});
  const resumePath = path.join(known.desktop, '이력서.pdf');
  await writeFile(resumePath, reportBytes);
  const originalFile = await send('바탕화면에 이력서파일 보내줘');
  await waitFor(originalFile, 'approval');
  const sendPreview = await mobile({ op: 'phone-preview', id: originalFile, page: 1 });
  assert.match(sendPreview.preview, /이력서\.pdf/);
  assert.equal(sendPreview.format, 'pdf');
  assert(!(await mobile({ op: 'state' })).files.some(file => file.id === originalFile));
  await mobile({ op: 'phone-approve', id: originalFile, nonce: sendPreview.nonce, confirm: true });
  assert.deepEqual(await receive(originalFile), reportBytes);
  assert.deepEqual(await readFile(resumePath), reportBytes);
  const unnamed = await send('바탕화면에 파일 보내줘');
  assert.match((await waitFor(unnamed, 'failed')).error, /보낼 파일 이름/);
  assert(!(await mobile({ op: 'state' })).files.some(file => file.id === unnamed));
  console.log('Named Desktop PDF is sent byte-for-byte only after approval');

  const coverLetter=Buffer.from('가상 자기소개서입니다.');
  await writeFile(path.join(known.desktop,'자기소개서.txt'),coverLetter);
  await writeFile(path.join(known.desktop,'자기소개서도.png'),'synthetic unsupported original');
  for(const [request,source,expected] of [
    ['바탕화면에서 이력서 다시 보내줘','이력서.pdf',reportBytes],
    ['자기소개서도 보내줘','자기소개서.txt',coverLetter],
  ]){
    const id=await send(request);
    await waitFor(id,'approval');
    assert.equal((await mobile({op:'state'})).jobs.find(job=>job.id===id).canApprove,true);
    const shown=await mobile({op:'phone-preview',id,...(source.endsWith('.pdf')?{page:1}:{})});
    assert.equal(shown.preview.split('\n')[0],'보낼 원본 파일 · '+source);
    assert(!(await mobile({op:'state'})).files.some(file=>file.id===id));
    await mobile({op:'phone-approve',id,nonce:shown.nonce,confirm:true});
    assert.deepEqual(await receive(id),expected);
  }
  console.log('A repeated delivery and a different document requested with 도 both support mobile approval');
  const asText = await send('바탕화면에 이력서를 TXT로 보내줘');
  await waitFor(asText, 'approval');
  const textPreview = await mobile({ op: 'phone-preview', id: asText });
  assert.equal(textPreview.format, 'txt');
  await mobile({ op: 'phone-approve', id: asText, nonce: textPreview.nonce, confirm: true });
  const textBytes = await receive(asText);
  assert.notEqual(textBytes.subarray(0, 5).toString(), '%PDF-');
  assert(textBytes.toString('utf8').trim());

  const forwardId = randomUUID();
  const forwarded = await mobile({ op: 'job', action: 'desk-start', id: forwardId, text: '결과를 전달해줘' });
  assert.match(forwarded.notice, /연결한 화면/);
  assert.deepEqual(Buffer.from((await mobile({ op: 'file', id: asText })).data, 'base64'), textBytes);
  const forwardedState = await mobile({ op: 'state' });
  assert(!forwardedState.files.some(file => file.id === forwardId));
  assert(!forwardedState.jobs.some(job => job.id === forwardId));
  console.log('Explicit TXT delivery and forwarding the latest result');
  const deepMissing = await send('바탕화면에 없는 파일 보내줘');
  assert.match((await waitFor(deepMissing, 'failed')).error, /깊이 한도/);
  const secondResume = path.join(known.desktop, '이력서.txt');
  await writeFile(secondResume, '가상 이력서입니다.');
  const ambiguousResume = await send('바탕화면에 이력서파일 보내줘');
  const choice = await waitFor(ambiguousResume, 'choose');
  assert.deepEqual(choice.choices.map(file => file.name).sort(), ['이력서.pdf', '이력서.txt']);
  const choiceRequest = {op:'phone-preview',id:ambiguousResume,step:'choose'};
  const choiceState = async ()=>(await mobile({op:'state'})).jobs.find(job=>job.id===ambiguousResume);
  assert.equal((await choiceState()).canChoose,true);
  assert.equal((await choiceState()).choices,undefined);
  await other(choiceRequest,403);
  await allow(false);
  assert.equal((await choiceState()).mobileApprovalNeeded,true);
  await mobile(choiceRequest,403);
  await allow(true);
  const offered = await mobile(choiceRequest);
  assert.equal(offered.single,true);
  assert.deepEqual(offered.choices.map(file=>file.name).sort(),['이력서.pdf','이력서.txt']);
  assert(offered.choices.every(file=>file.folder==='바탕화면'&&file.location===undefined&&file.stamp===undefined));
  const selectFile = {op:'phone-approve',id:ambiguousResume,step:'choose',confirm:true,nonce:offered.nonce,
    ids:[offered.choices.find(file=>file.name==='이력서.pdf').id]};
  await other(selectFile,403);
  await mobile({...selectFile,nonce:randomUUID()},409);
  await mobile({...selectFile,ids:[randomUUID()]},400);
  await mobile(selectFile);
  await waitFor(ambiguousResume,'approval');
  await mobile(selectFile,409);
  assert(!(await mobile({op:'state'})).files.some(file=>file.id===ambiguousResume));
  const selectedPreview = await mobile({op:'phone-preview',id:ambiguousResume,page:1});
  assert.match(selectedPreview.preview,/이력서\.pdf/);
  await mobile({op:'phone-approve',id:ambiguousResume,nonce:selectedPreview.nonce,confirm:true});
  assert.deepEqual(await receive(ambiguousResume),reportBytes);
  console.log('Requesting phone selects a file, previews and approves it separately, and receives the original');

  await rename(resumePath, path.join(known.desktop, '2026 이력서.pdf'));
  await rename(secondResume, path.join(known.desktop, '시나리오 메모.txt'));
  const partialResume = await send('이력서 파일 보내줘');
  await waitFor(partialResume, 'approval');
  const partialPreview = await mobile({ op: 'phone-preview', id: partialResume, page: 1 });
  assert.equal(partialPreview.preview.split('\n')[0], '보낼 원본 파일 · 2026 이력서.pdf');
  assert.match(partialPreview.preview, /검색 깊이 한도 안에서 찾은 파일/);
  assert(!(await mobile({ op: 'state' })).files.some(file => file.id === partialResume));
  await mobile({ op: 'phone-approve', id: partialResume, nonce: partialPreview.nonce, confirm: true });
  assert.deepEqual(await receive(partialResume), reportBytes);
  const latestResume = await send('최근 이력서 파일 보내줘');
  assert.match((await waitFor(latestResume, 'failed')).error, /깊이 한도/);
  console.log('A named partial match remains available after the depth cap, but latest searches still require full coverage');

  const personnel = path.join(known.desktop, '인사');
  const downloadArchive = path.join(known.downloads, '보관');
  await mkdir(personnel);
  await mkdir(downloadArchive);
  await writeFile(path.join(known.downloads, '인사자료.png'), Buffer.from('synthetic unsupported original'));
  await writeFile(path.join(downloadArchive, '인사자료.pdf'), reportBytes);
  await writeFile(path.join(known.downloads, '직원명부.png'), Buffer.from('synthetic unsupported original'));
  await writeFile(path.join(downloadArchive, '2026 직원명부.pdf'), reportBytes);
  await writeFile(path.join(known.desktop, '별도이력서.pdf'), reportBytes);
  await writeFile(path.join(personnel, '별도이력서파일.pdf'), reportBytes);
  await writeFile(path.join(personnel, '조직도.pdf'), reportBytes);
  for (const [request, expectedName] of [
    ['다운로드에 인사자료파일 보내줘', '인사자료.pdf'],
    ['다운로드에 직원명부 보내줘', '2026 직원명부.pdf'],
    ['별도이력서파일 보내줘', '별도이력서파일.pdf'],
    ['바탕화면에서 인사 폴더에서 조직도파일 보내줘', '조직도.pdf'],
  ]) {
    const id = await send(request);
    await waitFor(id, 'approval');
    const preview = await mobile({ op: 'phone-preview', id, page: 1 });
    assert.equal(preview.preview.split('\n')[0], '보낼 원본 파일 · ' + expectedName);
    assert(!(await mobile({ op: 'state' })).files.some(file => file.id === id));
    await mobile({ op: 'phone-approve', id, nonce: preview.nonce, confirm: true });
    assert.deepEqual(await receive(id), reportBytes);
  }
  const organizationChart=Buffer.from('가상 조직도 원본입니다.');
  await writeFile(path.join(known.downloads,'조직.txt'),'다른 조직 자료입니다.');
  await writeFile(path.join(downloadArchive,'2025 조직도.txt'),organizationChart);
  const chart=await send('다운로드에서 조직도 보내줘');
  await waitFor(chart,'approval');
  const chartPreview=await mobile({op:'phone-preview',id:chart});
  assert.match(chartPreview.preview,/보낼 원본 파일 · 2025 조직도\.txt/);
  await mobile({op:'phone-approve',id:chart,nonce:chartPreview.nonce,confirm:true});
  assert.deepEqual(await receive(chart),organizationChart);
  console.log('Transfer format, literal names and a named subfolder take precedence in file discovery');
  await pc({ op: 'directory', kind: 'exclude', path: deepBranch });

  execFileSync(config.python, ['-I', '-B', '-c', `
import io, random, sys
sys.path.insert(0, sys.argv[1])
from docx import Document
from PIL import Image
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
from pypdf import PdfWriter
from pypdf.annotations import FreeText
doc = Document()
doc.add_paragraph('Example document')
doc.sections[0].header.paragraphs[0].text = 'password: fixture-only-secret'
doc.core_properties.comments = 'password: fixture-only-secret'
doc.save(sys.argv[2])
pdf = canvas.Canvas(sys.argv[3])
pdf.setTitle('password: fixture-only-secret')
pdf.drawString(72, 720, 'Example document')
pdf.save()
portrait = canvas.Canvas(sys.argv[4])
portrait.drawString(72, 720, 'Sample resume - first page')
portrait.drawImage(ImageReader(Image.new('RGB', (180, 200), (62, 124, 165))), 72, 500)
portrait.showPage()
portrait.drawString(72, 720, 'Sample resume - second page')
photo = io.BytesIO()
Image.new('RGB', (150, 200), (171, 113, 42)).save(photo, format='JPEG')
photo.seek(0)
portrait.drawImage(ImageReader(photo), 72, 500)
portrait.save()
writer = PdfWriter()
writer.append(sys.argv[4])
writer.add_attachment('fixture.txt', b'fixture')
writer.write(sys.argv[5])
annotated = PdfWriter(clone_from=sys.argv[4])
annotated.add_annotation(0, FreeText(text='Visible review note', rect=(65, 300, 300, 355),
    font_size='18pt', font_color='102060', background_color='fff0b0'))
annotated.write(sys.argv[6])
for name,first in [(sys.argv[7],True),(sys.argv[8],False)]:
    wide = canvas.Canvas(name,pagesize=(14401,400) if first else (400,400))
    wide.drawString(72,300,'First page')
    if not first:
        wide.showPage()
        wide.setPageSize((14401,400))
        wide.drawString(72,300,'Oversize second page')
    wide.save()
dense = canvas.Canvas(sys.argv[9],pagesize=(600,600))
dense.drawString(60,550,'First page')
dense.showPage()
tile = ImageReader(Image.frombytes('RGB',(120,120),random.Random(45).randbytes(120*120*3)))
for x in range(0,600,40):
    for y in range(0,600,40):
        dense.drawImage(tile,x,y,40,40)
dense.save()
`, path.join(bundle, 'runtime/office'), path.join(known.desktop, '숨은 속성.docx'), path.join(known.desktop, '숨은 속성.pdf'),
  path.join(known.desktop, '사진 이력서.pdf'), path.join(known.desktop, '첨부 이력서.pdf'), path.join(known.desktop, '주석 이력서.pdf'),
  path.join(known.desktop, '첫 쪽 한도.pdf'), path.join(known.desktop, '둘째 쪽 한도.pdf'), path.join(known.desktop, '고밀도 미리보기.pdf')]);
  for (const [extension, expected] of [['docx', /원본 전송을 지원하지/], ['pdf', /인증 정보/]]) {
    const blocked = await send(`바탕화면에 "숨은 속성.${extension}" 파일 보내줘`);
    assert.match((await waitFor(blocked, 'failed')).error, expected);
    assert(!(await mobile({ op: 'state' })).files.some(file => file.id === blocked));
  }
  console.log('Office originals and PDF metadata credentials are blocked before approval');
  const withAttachment = await send('바탕화면에서 "첨부 이력서.pdf" 파일 보내줘');
  assert.match((await waitFor(withAttachment, 'failed')).error, /첨부.*원본으로 보낼 수 없습니다/);
  for (const name of ['첫 쪽 한도.pdf', '둘째 쪽 한도.pdf']) {
    const tooLarge = await send(`바탕화면에서 "${name}" 파일 보내줘`);
    const failed = await waitFor(tooLarge, 'failed');
    assert.match(failed.error, /PDF 페이지 크기가 미리보기 한도/);
    assert.equal(failed.nonce, null);
    assert(!(await mobile({op:'state'})).files.some(file => file.id === tooLarge));
    await mobile({op:'phone-preview',id:tooLarge,page:1},409);
  }

  const photoJob = await send('바탕화면에서 "사진 이력서.pdf" 파일 보내줘');
  await waitFor(photoJob, 'approval');
  const phonePage = page => ({op:'phone-preview',id:photoJob,page});
  await other(phonePage(1), 403);
  await mobile({op:'phone-preview',id:photoJob}, 409);
  await mobile(phonePage(3), 400);
  const photoFirst = await mobile(phonePage(1));
  const photoSecond = await mobile(phonePage(2));
  const localFirst = await pc(phonePage(1));
  assert.equal(photoFirst.pages, 2);
  assert.equal(photoFirst.page, 1);
  assert.equal(photoSecond.page, 2);
  assert.equal(photoFirst.nonce, photoSecond.nonce);
  assert.match(photoFirst.preview, /이미지 속 글자/);
  assert.deepEqual(localFirst, photoFirst);
  assert.deepEqual(Buffer.from(photoFirst.image,'base64').subarray(0,3), Buffer.from([255,216,255]));
  assert.notEqual(photoFirst.image, photoSecond.image);
  assert(!(await mobile({op:'state'})).files.some(file => file.id === photoJob));
  await mobile({op:'phone-approve',id:photoJob,nonce:photoFirst.nonce,confirm:true});
  assert.deepEqual(await receive(photoJob), await readFile(path.join(known.desktop,'사진 이력서.pdf')));
  const localPhotoJob = randomUUID();
  await pc({op:'job',action:'desk-start',id:localPhotoJob,text:'바탕화면에서 "사진 이력서.pdf" 파일 보내줘'});
  await waitFor(localPhotoJob, 'approval');
  await mobile({op:'phone-preview',id:localPhotoJob,page:1},403);
  const localPhoto = await pc({op:'phone-preview',id:localPhotoJob,page:2});
  assert.equal(localPhoto.image,photoSecond.image);
  await pc({op:'job',action:'desk-approve',id:localPhotoJob,nonce:localPhoto.nonce});
  assert.deepEqual(await receive(localPhotoJob),await readFile(path.join(known.desktop,'사진 이력서.pdf')));
  console.log('Two PDF pages are visible on both clients before approval; the original matches after delivery');
  const annotated = await send('바탕화면에서 "주석 이력서.pdf" 파일 보내줘');
  await waitFor(annotated,'approval');
  const annotationPreview = {op:'phone-preview',id:annotated,page:1};
  const annotatedPage = await mobile(annotationPreview);
  assert.notEqual(annotatedPage.image,photoFirst.image);
  assert.equal((await pc(annotationPreview)).image,annotatedPage.image);
  assert.equal((await mobile({...annotationPreview,page:2})).image,photoSecond.image);
  await mobile({op:'phone-approve',id:annotated,nonce:annotatedPage.nonce,confirm:true});
  assert.deepEqual(await receive(annotated),await readFile(path.join(known.desktop,'주석 이력서.pdf')));
  console.log('Visible annotations appear in both previews; oversize pages fail before approval');
  const denseJob = await send('바탕화면에서 "고밀도 미리보기.pdf" 파일 보내줘');
  await waitFor(denseJob,'approval');
  const densePage = {op:'phone-preview',id:denseJob,page:2};
  const denseFirst = await mobile({...densePage,page:1});
  const densePreview = await mobile(densePage);
  assert.equal(densePreview.page,2);
  assert.equal(densePreview.pages,2);
  assert.equal(densePreview.nonce,denseFirst.nonce);
  const denseJpeg = Buffer.from(densePreview.image,'base64');
  assert.deepEqual(denseJpeg.subarray(0,3),Buffer.from([255,216,255]));
  assert(denseJpeg.length<=1_500_000);
  assert.equal((await pc(densePage)).image,densePreview.image);
  assert(!(await mobile({op:'state'})).files.some(file => file.id === denseJob));
  await mobile({op:'phone-approve',id:denseJob,nonce:densePreview.nonce,confirm:true});
  assert.deepEqual(await receive(denseJob),await readFile(path.join(known.desktop,'고밀도 미리보기.pdf')));
  console.log('High-density second page is within the preview byte limit without changing the approved original');
  await pc({ op: 'revoke', device: otherPhone.device });
  assert.equal(await approvalEnabled(otherPhone.device),0);
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
  const mixedName = '혼합선택.txt';
  const mixedAttachment = Buffer.from('휴대폰 첨부 자료에 장치 317개가 있습니다.');
  await writeFile(path.join(known.desktop, mixedName), 'PC 검색 자료에 장치 419개가 있습니다.');
  await mobile({op:'job',action:'desk-upload',id:randomUUID(),name:mixedName,
    base64:mixedAttachment.toString('base64'),sha256:sha256(mixedAttachment)});
  const mixed = await send('혼합선택 TXT로 보내줘');
  const pcChoice = await waitFor(mixed, 'choose');
  const phoneChoice = await mobile({op:'phone-preview',id:mixed,step:'choose'});
  assert.equal(pcChoice.single,true);
  assert.equal(phoneChoice.single,true);
  assert.deepEqual(phoneChoice.choices.map(file=>file.folder).sort(), ['바탕화면','첨부 파일']);
  assert(pcChoice.choices.some(file=>file.location==='첨부 파일'));
  const selected = {op:'phone-approve',id:mixed,step:'choose',nonce:phoneChoice.nonce,confirm:true};
  const both = phoneChoice.choices.map(file=>file.id);
  await mobile({...selected,ids:both},400);
  await pc({op:'job',action:'desk-select',id:mixed,ids:both},400);
  const unchanged = await mobile({op:'phone-preview',id:mixed,step:'choose'});
  assert.deepEqual(unchanged,phoneChoice);
  await mobile({...selected,ids:[phoneChoice.choices.find(file=>file.folder==='첨부 파일').id]});
  await waitFor(mixed, 'approval');
  const mixedPreview = await mobile({op:'phone-preview',id:mixed});
  assert.match(mixedPreview.preview,/317개/);
  assert.doesNotMatch(mixedPreview.preview,/419개/);
  await mobile({op:'phone-approve',id:mixed,nonce:mixedPreview.nonce,confirm:true});
  assert.match((await receive(mixed)).toString('utf8'),/317개/);
  console.log('A conversion accepts one source and labels an attachment without an internal path');

  const summaryResume = '가상 이력서의 프로젝트는 27개입니다.';
  const supplement = '보충 메모에 기록된 발표는 63회입니다.';
  await writeFile(path.join(known.downloads,'이력서.pdf'),reportBytes);
  await writeFile(path.join(known.downloads,'이력서.txt'),summaryResume);
  await writeFile(path.join(known.downloads,'보충 메모.txt'),supplement);

  const resumeSummary = await send('다운로드에서 이력서를 요약해줘');
  assert.equal((await waitFor(resumeSummary,'choose')).single,true);
  const summaryOptions = {op:'phone-preview',id:resumeSummary,step:'choose'};
  const summaryChoice = await mobile(summaryOptions);
  assert.equal(summaryChoice.single,true);
  assert.deepEqual(summaryChoice.choices.map(file=>file.name).sort(),['이력서.pdf','이력서.txt']);
  const submitSummary = {op:'phone-approve',id:resumeSummary,step:'choose',nonce:summaryChoice.nonce,confirm:true};
  await mobile({...submitSummary,ids:summaryChoice.choices.map(file=>file.id)},400);
  assert.deepEqual(await mobile(summaryOptions),summaryChoice);
  const summarySource = summaryChoice.choices.find(file=>file.name==='이력서.txt');
  await mobile({...submitSummary,ids:[summarySource.id]});
  await waitFor(resumeSummary,'approval');
  const summaryPreview = await mobile({op:'phone-preview',id:resumeSummary});
  assert.match(summaryPreview.preview,/27개/);
  await mobile({op:'phone-approve',id:resumeSummary,nonce:summaryPreview.nonce,confirm:true});
  assert.equal((await receive(resumeSummary)).subarray(0,5).toString(),'%PDF-');

  for(const legacy of [false,true]){
    const twoSources = await send('다운로드에서 이력서와 보충 메모를 요약해서 TXT로 만들어줘');
    assert.equal((await waitFor(twoSources,'choose')).single,false);
    if(legacy){
      const db=new DatabaseSync(jobsDatabase);
      try {
        const {preview}=db.prepare('SELECT preview FROM jobs WHERE id=?').get(twoSources);
        const {items,groups}=JSON.parse(preview);
        assert.equal(groups.length,2);
        db.prepare('UPDATE jobs SET preview=? WHERE id=?').run(JSON.stringify(items),twoSources);
      } finally { db.close(); }
    }
    const twoOptions = {op:'phone-preview',id:twoSources,step:'choose'};
    const twoChoice = await mobile(twoOptions);
    assert.equal(twoChoice.single,false);
    const submitTwo = {op:'phone-approve',id:twoSources,step:'choose',nonce:twoChoice.nonce,confirm:true};
    const wrongIds=twoChoice.choices.filter(file=>file.name.startsWith('이력서')).map(file=>file.id);
    await mobile({...submitTwo,ids:wrongIds},400);
    await pc({op:'job',action:'desk-select',id:twoSources,ids:wrongIds},400);
    assert.deepEqual(await mobile(twoOptions),twoChoice);
    await mobile({...submitTwo,ids:twoChoice.choices.filter(file=>file.name.endsWith('.txt')).map(file=>file.id)});
    await waitFor(twoSources,'approval');
    const twoPreview = await mobile({op:'phone-preview',id:twoSources});
    assert.match(twoPreview.preview,/27개/);
    assert.match(twoPreview.preview,/63회/);
    await mobile({op:'phone-approve',id:twoSources,nonce:twoPreview.nonce,confirm:true});
    const twoBytes = (await receive(twoSources)).toString('utf8');
    assert.match(twoBytes,/27개/);
    assert.match(twoBytes,/63회/);
  }
  console.log('Current and legacy summaries reject wrong source combinations without losing their choices');

  const large=Buffer.alloc(8000000,65);
  await mobile({op:'job',action:'desk-upload',id:randomUUID(),name:'security-boundary.txt',base64:large.toString('base64'),sha256:sha256(large)});
  console.log('An 8,000,000-byte phone attachment crosses the encrypted relay without lowering the file limit');
  const localHost=await start({...config,state:path.join(fixture,'local-code-state'),relayOrigin:undefined});
  try{
   const credentials={email:'local-pair@example.invalid',password:randomBytes(16).toString('hex')};
   const signup=await call(localHost.origin,{op:'signup',...credentials});
   const localOwner=await call(localHost.origin,{op:'register'},{token:signup.token,owner:localHost.owner});
   await call(localHost.origin,{op:'code'},{token:localOwner.token,owner:localHost.owner,status:503});
   const login=await call(localHost.origin,{op:'login',...credentials});
   await call(localHost.origin,{op:'pair',code:'123456'},{token:login.token,status:403});
  }finally{await localHost.close();}
  console.log('Legacy direct pairing cannot bypass encrypted PC-approved enrollment');

} finally {
  await host?.close();
  await relay.close();
}
