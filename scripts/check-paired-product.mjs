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
  const reportBytes = await receive(report);
  assert.equal(reportBytes.subarray(0, 5).toString(), '%PDF-');
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
  console.log('Transfer format, literal names and a named subfolder take precedence in file discovery');
  await pc({ op: 'directory', kind: 'exclude', path: deepBranch });

  execFileSync(config.python, ['-I', '-B', '-c', `
import io, sys
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
`, path.join(bundle, 'runtime/office'), path.join(known.desktop, '숨은 속성.docx'), path.join(known.desktop, '숨은 속성.pdf'),
  path.join(known.desktop, '사진 이력서.pdf'), path.join(known.desktop, '첨부 이력서.pdf'), path.join(known.desktop, '주석 이력서.pdf'),
  path.join(known.desktop, '첫 쪽 한도.pdf'), path.join(known.desktop, '둘째 쪽 한도.pdf')]);
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
