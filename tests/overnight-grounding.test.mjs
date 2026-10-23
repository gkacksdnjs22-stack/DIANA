import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { scanDocuments } from '../agent/documents.mjs';
import { runOvernight } from '../agent/overnight.mjs';

const SOURCE = '매출액 1,100만원';
const FILENAME = '자료-001.txt';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function report() {
  return {
    title: '매출 검토 보고서',
    summary: '원문에 기록된 매출액은 1,100만원입니다.',
    sections: ['원문 요약', '수치 확인', '검토 범위'].map(heading => ({
      heading, text: '원문은 매출액 1,100만원을 명시합니다.', evidence: [SOURCE],
    })),
    slides: Array.from({ length: 6 }, () => ({
      title: '매출액 확인', body: ['원문에 명시된 매출액은 1,100만원입니다.'], evidence: [SOURCE],
    })),
    limitations: ['제공된 원문 외의 자료는 검토하지 않았습니다.'],
  };
}

function unsupportedComparison() {
  const value = report();
  value.sections[1].text = '매출액은 1,100만원입니다. 소스에 110만원 언급 없음.';
  return value;
}

async function fixture(t, outputs) {
  const parent = path.resolve(import.meta.dirname, '../.local/test-tmp');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'overnight-grounding-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), parent);
    await rm(directory, { recursive: true, force: true });
  });
  const documentRoot = path.join(directory, 'documents');
  await mkdir(documentRoot);
  await writeFile(path.join(documentRoot, FILENAME), SOURCE);
  const { documents: [source] } = await scanDocuments({ documentRoot });
  const deviceId = 'grounding-test-pc';
  const job = {
    id: randomUUID(), deviceId, action: 'overnight', kind: 'overnight',
    sourceId: source.id, source,
    instruction: '원문 매출액을 검토하고 보고서와 발표자료를 작성해줘.',
    criteria: ['원문에 없는 숫자를 사용하지 않고 정확한 근거를 인용한다.'],
    slideCount: 6, delivery: 'download',
    startAt: new Date(Date.now() - 60_000).toISOString(),
    deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
  const calls = [], requests = [], exported = [];
  const options = {
    documentRoot, deviceId, stateDir: path.join(directory, 'state'),
    env: { AI_MODE: 'groq', GROQ_OPENAI_KEY: 'mock-grounding-key', GROQ_MODEL: 'mock-grounding-model' },
    apiRequest: async (url, request) => { requests.push({ url, ...request }); return { ok: true }; },
    fetchImpl: async (url, request) => {
      assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
      const body = JSON.parse(request.body);
      const key = body.response_format.json_schema.name;
      calls.push({ key, instructions: body.messages[0].content, data: JSON.parse(body.messages[1].content) });
      assert.ok(Object.hasOwn(outputs, key), `Unexpected AI stage: ${key}`);
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(outputs[key]) } }] }), {
        headers: { 'Content-Type': 'application/json' },
      });
    },
    exportArtifacts: async ({ report: value, outputDir }) => {
      exported.push(value);
      await mkdir(outputDir, { recursive: true });
      const files = [
        ['보고서.md', 'text/markdown'],
        ['보고서.hwpx', 'application/vnd.hancom.hwpx'],
        ['보고서.pdf', 'application/pdf'],
        ['발표자료.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
        ['발표자료.pdf', 'application/pdf'],
      ];
      const artifacts = [];
      for (const [filename, mime] of files) {
        const bytes = Buffer.from(`Fake ${filename} export for grounding tests only.`);
        const absolutePath = path.join(outputDir, filename);
        await writeFile(absolutePath, bytes);
        artifacts.push({ id: sha256(bytes), filename, mime, bytes: bytes.length, sha256: sha256(bytes), absolutePath });
      }
      return { artifacts };
    },
  };
  return { run: () => runOvernight(job, options), calls, requests, exported };
}

function assertBlocked(f, result) {
  assert.deepEqual(result, { status: 'needs_attention', rounds: 3 });
  assert.equal(f.exported.length, 0, 'Unverified reports must never reach export.');
  assert.equal(f.requests.some(request => request.url.includes('/artifacts')), false);
  assert.equal(f.requests.at(-1).body.status, 'needs_attention');
}

test('unsupported comparison surviving the first revision is repaired before the final AI review and export', async t => {
  const corrected = report();
  const f = await fixture(t, { draft: unsupportedComparison(), revise_1: unsupportedComparison(), revise_2: corrected, review_3: { issues: [] } });
  const result = await f.run();
  assert.deepEqual(result, { status: 'download_ready', rounds: 3 });
  assert.deepEqual(f.calls.map(call => call.key), ['draft', 'revise_1', 'revise_2', 'review_3']);
  for (const key of ['revise_1', 'revise_2']) {
    const findings = f.calls.find(call => call.key === key).data.reviewFindings;
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, 'major');
    assert.match(findings[0].finding, /Unsupported numeric claim.*110/);
    assert.equal(findings[0].evidence, '');
  }
  assert.deepEqual(f.calls.at(-1).data.draft, corrected);
  assert.deepEqual(f.exported, [corrected]);
  const manifest = f.requests.find(request => request.url.endsWith('/artifacts')).body.artifacts;
  assert.equal(manifest.length, 5);
  assert.equal(manifest.some(artifact => Object.hasOwn(artifact, 'absolutePath')), false);
  const uploads = f.requests.filter(request => request.binaryBody);
  assert.equal(uploads.length, 5);
  for (const upload of uploads) {
    const artifact = manifest.find(item => upload.url.endsWith('/' + item.id));
    assert.ok(artifact);
    assert.equal(upload.binaryBody.length, artifact.bytes);
    assert.equal(sha256(upload.binaryBody), artifact.sha256);
  }
  assert.equal(f.requests.at(-1).body.status, 'download_ready');
});

test('unsupported comparisons remaining after every review round block export without a model review', async t => {
  const f = await fixture(t, { draft: unsupportedComparison(), revise_1: unsupportedComparison(), revise_2: unsupportedComparison() });
  assertBlocked(f, await f.run());
  assert.deepEqual(f.calls.map(call => call.key), ['draft', 'revise_1', 'revise_2']);
});

for (const field of ['title', 'summary', 'limitations']) {
  test(`an unsupported number confined to ${field} enters revision and cannot be delivered`, async t => {
    const invalid = report();
    if (field === 'limitations') invalid.limitations = ['소스에 110만원 언급 없음.'];
    else invalid[field] = '소스에 110만원 언급 없음.';
    const f = await fixture(t, { draft: invalid, revise_1: invalid, revise_2: invalid });
    assertBlocked(f, await f.run());
    assert.deepEqual(f.calls.map(call => call.key), ['draft', 'revise_1', 'revise_2']);
    assert.match(f.calls[1].data.reviewFindings[0].finding, /Unsupported numeric claim.*110/);
  });
}

test('digits in an exact frozen source filename are metadata and do not block delivery', async t => {
  const valid = report();
  valid.title = `${FILENAME} 검토 보고서`;
  valid.summary = `${FILENAME}의 매출액은 1,100만원입니다.`;
  valid.sections[0].heading = `${FILENAME} 요약`;
  valid.sections[0].text = `${FILENAME}은 매출액 1,100만원을 명시합니다.`;
  valid.slides[0].title = `${FILENAME} 원문 확인`;
  valid.slides[0].body = [`${FILENAME}의 매출액은 1,100만원입니다.`];
  valid.limitations = [`${FILENAME} 외의 자료는 검토하지 않았습니다.`];
  const f = await fixture(t, { draft: valid, review_1: { issues: [] } });
  assert.deepEqual(await f.run(), { status: 'download_ready', rounds: 1 });
  assert.deepEqual(f.calls.map(call => call.key), ['draft', 'review_1']);
  assert.deepEqual(f.exported, [valid]);
});
