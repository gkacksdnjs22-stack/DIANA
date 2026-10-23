import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { requestStructuredResponse } from '../agent/ai-provider.mjs';
import { runOvernight } from '../agent/overnight.mjs';
import { scanDocuments } from '../agent/documents.mjs';

const SECRET = 'mock-groq-private-key-do-not-print';
const SOURCE = '테스트 원문의 매출 자료입니다.';
const ENV = { AI_MODE: 'groq', GROQ_OPENAI_KEY: SECRET, GROQ_MODEL: 'test-model' };
const REQUEST = {
  env: ENV, name: 'retry_test', instructions: 'Use only the supplied source.',
  input: [{ role: 'user', content: SOURCE }],
  schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false },
};
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json', ...headers },
});
const completion = (value = { answer: 'ok' }, { finishReason = 'stop', refusal } = {}) => json({
  choices: [{ finish_reason: finishReason, message: { content: JSON.stringify(value), ...(refusal ? { refusal } : {}) } }],
});
const limited = headers => json({ error: { message: `Untrusted provider error ${SECRET} ${SOURCE}` } }, 429, headers);

function assertRateLimit(error) {
  assert.equal(error.code, 'ai_rate_limited');
  assert.equal(error.httpStatus, 429);
  assert.equal(String(error).includes(SECRET), false);
  assert.equal(String(error).includes(SOURCE), false);
  return true;
}

test('a rejected Groq 429 retries unchanged authorization and structured JSON after Retry-After', async () => {
  const attempts = [], waits = [];
  const result = await requestStructuredResponse({
    ...REQUEST,
    fetchImpl: async (url, options) => {
      attempts.push({ url, ...options });
      return attempts.length === 1
        ? limited({ 'retry-after': '2', 'x-ratelimit-reset-tokens': '20s' })
        : completion();
    },
    waitImpl: async (ms, { signal }) => { waits.push(ms); assert.ok(signal instanceof AbortSignal); },
  });
  assert.deepEqual(waits, [2000]);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].url, 'https://api.groq.com/openai/v1/chat/completions');
  for (const attempt of attempts) {
    assert.equal(attempt.method, 'POST');
    assert.equal(attempt.redirect, 'error');
    assert.equal(attempt.headers.Authorization, `Bearer ${SECRET}`);
    assert.equal(attempt.headers['Content-Type'], 'application/json');
    assert.equal(attempt.body, attempts[0].body);
    assert.equal(attempt.signal, attempts[0].signal, 'Retries must share the original total timeout.');
  }
  assert.equal(result.status, 'completed');
});

test('Retry-After HTTP dates take precedence over Groq reset durations', async t => {
  const now = Date.parse('2026-10-23T00:00:00Z');
  t.mock.method(Date, 'now', () => now);
  const waits = [];
  let attempts = 0;
  await requestStructuredResponse({
    ...REQUEST,
    fetchImpl: async () => ++attempts === 1
      ? limited({ 'retry-after': new Date(now + 4000).toUTCString(), 'x-ratelimit-reset-tokens': '30s' })
      : completion(),
    waitImpl: async ms => { waits.push(ms); },
  });
  assert.deepEqual(waits, [4000]);
  assert.equal(attempts, 2);
});

for (const [label, headers, expected] of [
  ['token duration', { 'x-ratelimit-reset-tokens': '1m2.5s' }, 62_500],
  ['request duration when requests are exhausted', {
    'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '2m3s', 'x-ratelimit-reset-tokens': '5s',
  }, 123_000],
  ['token duration when request capacity remains', {
    'x-ratelimit-remaining-requests': '1', 'x-ratelimit-reset-requests': '2m3s', 'x-ratelimit-reset-tokens': '1.25s',
  }, 1250],
]) {
  test(`Groq 429 honors ${label} without a Retry-After header`, async () => {
    let attempts = 0;
    const waits = [];
    await requestStructuredResponse({
      ...REQUEST, timeoutMs: 180_000,
      fetchImpl: async () => ++attempts === 1 ? limited(headers) : completion(),
      waitImpl: async ms => { waits.push(ms); },
    });
    assert.deepEqual(waits, [expected]);
    assert.equal(attempts, 2);
  });
}

test('invalid or absent rate-limit headers use bounded exponential fallback waits', async () => {
  let attempts = 0;
  const waits = [];
  await requestStructuredResponse({
    ...REQUEST,
    fetchImpl: async () => ++attempts < 3
      ? limited({ 'retry-after': 'invalid', 'x-ratelimit-reset-tokens': 'invalid' })
      : completion(),
    waitImpl: async ms => { waits.push(ms); },
  });
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [1000, 2000]);
});

test('default retry cap stops after three rejected attempts and returns a safe typed rate-limit error', async () => {
  let attempts = 0;
  const waits = [];
  await assert.rejects(requestStructuredResponse({
    ...REQUEST,
    fetchImpl: async () => { attempts++; return limited({ 'retry-after': '1' }); },
    waitImpl: async ms => { waits.push(ms); },
  }), assertRateLimit);
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [1000, 1000]);
});

test('a zero retry budget refuses to repeat even a known rejected 429', async () => {
  let attempts = 0, waits = 0;
  await assert.rejects(requestStructuredResponse({
    ...REQUEST, maxRateLimitRetries: 0,
    fetchImpl: async () => { attempts++; return limited({ 'retry-after': '1' }); },
    waitImpl: async () => { waits++; },
  }), assertRateLimit);
  assert.equal(attempts, 1);
  assert.equal(waits, 0);
});

test('a retry wait that exceeds the remaining total budget is skipped', async () => {
  let attempts = 0, waits = 0;
  await assert.rejects(requestStructuredResponse({
    ...REQUEST, timeoutMs: 100,
    fetchImpl: async () => { attempts++; return limited({ 'retry-after': '1' }); },
    waitImpl: async () => { waits++; },
  }), assertRateLimit);
  assert.equal(attempts, 1);
  assert.equal(waits, 0);
});

test('time spent on an earlier retry consumes the same total timeout budget', async t => {
  let now = Date.parse('2026-10-23T00:00:00Z');
  t.mock.method(Date, 'now', () => now);
  let attempts = 0;
  const waits = [];
  await assert.rejects(requestStructuredResponse({
    ...REQUEST, timeoutMs: 1000,
    fetchImpl: async () => { attempts++; return limited({ 'retry-after': '0.6' }); },
    waitImpl: async ms => { waits.push(ms); now += ms; },
  }), assertRateLimit);
  assert.equal(attempts, 2);
  assert.deepEqual(waits, [600]);
});

test('abort during a rate-limit wait prevents another fetch', async () => {
  const controller = new AbortController();
  let attempts = 0, waits = 0;
  await assert.rejects(requestStructuredResponse({
    ...REQUEST, signal: controller.signal,
    fetchImpl: async () => { attempts++; return limited({ 'retry-after': '1' }); },
    waitImpl: async (_ms, { signal }) => {
      waits++;
      controller.abort(new Error(`Private caller abort ${SECRET}`));
      assert.equal(signal.aborted, true);
    },
  }), error => {
    assert.match(error.message, /abort|timed out|interrupt/i);
    assert.equal(String(error).includes(SECRET), false);
    return true;
  });
  assert.equal(attempts, 1);
  assert.equal(waits, 1);
});

for (const status of [400, 401, 403, 500, 502, 503]) {
  test(`Groq HTTP ${status} is never automatically repeated`, async () => {
    let attempts = 0, waits = 0;
    await assert.rejects(requestStructuredResponse({
      ...REQUEST,
      fetchImpl: async () => { attempts++; return json({ error: SECRET }, status, { 'retry-after': '1' }); },
      waitImpl: async () => { waits++; },
    }), error => {
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert.equal(String(error).includes(SECRET), false);
      return true;
    });
    assert.equal(attempts, 1);
    assert.equal(waits, 0);
  });
}

test('OpenAI 429 is never repeated by the Groq-only retry policy', async () => {
  let attempts = 0, waits = 0;
  await assert.rejects(requestStructuredResponse({
    ...REQUEST, env: { AI_MODE: 'openai', OPENAI_API_KEY: SECRET, OPENAI_MODEL: 'test-openai' },
    fetchImpl: async () => { attempts++; return limited({ 'retry-after': '1' }); },
    waitImpl: async () => { waits++; },
  }), /HTTP 429/);
  assert.equal(attempts, 1);
  assert.equal(waits, 0);
});

test('an ambiguous network failure is sanitized and never repeated', async () => {
  let attempts = 0, waits = 0;
  await assert.rejects(requestStructuredResponse({
    ...REQUEST,
    fetchImpl: async () => { attempts++; throw new Error(`Network failure for ${SECRET} ${SOURCE}`); },
    waitImpl: async () => { waits++; },
  }), error => {
    assert.match(error.message, /connection|connect|network/i);
    assert.equal(String(error).includes(SECRET), false);
    assert.equal(String(error).includes(SOURCE), false);
    return true;
  });
  assert.equal(attempts, 1);
  assert.equal(waits, 0);
});

test('an aborted API attempt is never repeated', async () => {
  const controller = new AbortController();
  let attempts = 0, waits = 0;
  await assert.rejects(requestStructuredResponse({
    ...REQUEST, signal: controller.signal,
    fetchImpl: async (_url, { signal }) => { attempts++; controller.abort(); signal.throwIfAborted(); },
    waitImpl: async () => { waits++; },
  }), /abort|timed out/i);
  assert.equal(attempts, 1);
  assert.equal(waits, 0);
});

test('an API timeout is sanitized and never repeated', async () => {
  let attempts = 0, waits = 0;
  await assert.rejects(requestStructuredResponse({
    ...REQUEST, timeoutMs: 20,
    fetchImpl: async (_url, { signal }) => {
      attempts++;
      return new Promise((_resolve, reject) => {
        const guard = setTimeout(() => reject(new Error(`Unexpected hung request ${SECRET}`)), 1000);
        const abort = () => { clearTimeout(guard); reject(signal.reason); };
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      });
    },
    waitImpl: async () => { waits++; },
  }), error => {
    assert.match(error.message, /abort|timed out/i);
    assert.equal(String(error).includes(SECRET), false);
    return true;
  });
  assert.equal(attempts, 1);
  assert.equal(waits, 0);
});

for (const variant of ['refusal', 'incomplete']) {
  test(`a Groq ${variant} response is returned without another potentially billable request`, async () => {
    let attempts = 0, waits = 0;
    const result = await requestStructuredResponse({
      ...REQUEST,
      fetchImpl: async () => { attempts++; return completion({}, variant === 'refusal' ? { refusal: 'Cannot comply.' } : { finishReason: 'length' }); },
      waitImpl: async () => { waits++; },
    });
    assert.equal(result.status, variant === 'refusal' ? 'completed' : 'incomplete');
    if (variant === 'refusal') assert.equal(result.output[0].content[0].type, 'refusal');
    assert.equal(attempts, 1);
    assert.equal(waits, 0);
  });
}

function validReport() {
  return {
    title: '매출 자료 보고서', summary: SOURCE,
    sections: ['원문 요약', '검토 결과', '확인 범위'].map(heading => ({ heading, text: SOURCE, evidence: [SOURCE] })),
    slides: Array.from({ length: 6 }, () => ({ title: '원문 확인', body: [SOURCE], evidence: [SOURCE] })),
    limitations: ['제공된 원문만 검토했습니다.'],
  };
}

async function overnightFixture(t, { reviewResponse, exportError, uploadError } = {}) {
  const parent = path.resolve(import.meta.dirname, '../.local/test-tmp');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'ai-retry-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), parent);
    assert.match(path.basename(directory), /^ai-retry-/);
    await rm(directory, { recursive: true, force: true });
  });
  const documentRoot = path.join(directory, 'documents');
  await mkdir(documentRoot);
  await writeFile(path.join(documentRoot, 'source.txt'), SOURCE);
  const { documents: [source] } = await scanDocuments({ documentRoot });
  const job = {
    id: randomUUID(), deviceId: 'retry-test-pc', action: 'overnight', kind: 'overnight',
    sourceId: source.id, source, instruction: '원문 보고서 작성', criteria: ['원문 근거 검토'],
    slideCount: 6, delivery: 'download',
    startAt: new Date(Date.now() - 60_000).toISOString(), deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
  const stateDir = path.join(directory, 'state');
  const requests = [], calls = [];
  const options = {
    env: ENV, documentRoot, deviceId: job.deviceId, stateDir,
    fetchImpl: async (_url, request) => {
      const key = JSON.parse(request.body).response_format.json_schema.name;
      calls.push(key);
      if (key === 'draft') return completion(validReport());
      assert.equal(key, 'review_1');
      return reviewResponse ? reviewResponse() : completion({ issues: [] });
    },
    apiRequest: async (url, request) => {
      requests.push({ url, ...request });
      if (uploadError && request.binaryBody) throw new Error(uploadError);
      return { ok: true };
    },
    exportArtifacts: async ({ outputDir }) => {
      if (exportError) throw new Error(exportError);
      await mkdir(outputDir, { recursive: true });
      const artifacts = [];
      for (const filename of ['보고서.md', '보고서.hwpx', '보고서.pdf', '발표자료.pptx', '발표자료.pdf']) {
        const bytes = Buffer.from(`Fake ${filename} for retry workflow tests.`);
        const absolutePath = path.join(outputDir, filename);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        await writeFile(absolutePath, bytes);
        artifacts.push({ id: sha256, filename, sha256, bytes: bytes.length, mime: 'application/octet-stream', absolutePath });
      }
      return { artifacts };
    },
  };
  return { calls, requests, workDir: path.join(stateDir, 'overnight', job.id), run: () => runOvernight(job, options) };
}

function userFailure(f) {
  const last = f.requests.at(-1);
  assert.ok(last.url.endsWith('/result'));
  assert.equal(last.body.status, 'needs_attention');
  assert.equal(typeof last.body.error, 'string');
  assert.equal(last.body.error.includes(SECRET), false);
  assert.equal(last.body.error.includes(SOURCE), false);
  assert.doesNotMatch(last.body.error, /검토 기준이나 원문 근거 검증/);
  return last.body.error;
}

test('overnight API rate-limit failure records HTTP 429 metadata and explains the call limit to the user', async t => {
  const f = await overnightFixture(t, { reviewResponse: () => limited({ 'retry-after': '3600' }) });
  assert.equal((await f.run()).status, 'needs_attention');
  assert.deepEqual(f.calls, ['draft', 'review_1']);
  assert.match(userFailure(f), /호출 한도/);
  assert.match(userFailure(f), /Groq|AI|API/);
  const markerNames = (await readdir(f.workDir)).filter(name => name.endsWith('.failure.json'));
  assert.deepEqual(markerNames, ['review_1.failure.json']);
  const raw = await readFile(path.join(f.workDir, markerNames[0]), 'utf8');
  const marker = JSON.parse(raw);
  assert.deepEqual(Object.keys(marker).sort(), ['at', 'code', 'httpStatus', 'stage', 'version']);
  assert.equal(marker.version, 1);
  assert.equal(marker.stage, 'review_1');
  assert.equal(marker.code, 'ai_rate_limited');
  assert.equal(marker.httpStatus, 429);
  assert.ok(Number.isFinite(Date.parse(marker.at)));
  assert.equal(raw.includes(SECRET), false);
  assert.equal(raw.includes(SOURCE), false);
  await assert.rejects(readFile(path.join(f.workDir, 'review_1.json')), { code: 'ENOENT' });
});

test('overnight reports a sanitized API failure separately from source validation', async t => {
  const f = await overnightFixture(t, { reviewResponse: () => { throw new Error(`API connection ${SECRET} ${SOURCE}`); } });
  assert.equal((await f.run()).status, 'needs_attention');
  assert.deepEqual(f.calls, ['draft', 'review_1']);
  assert.match(userFailure(f), /AI|API|연결/);
  const raw = await readFile(path.join(f.workDir, 'review_1.failure.json'), 'utf8');
  const marker = JSON.parse(raw);
  assert.deepEqual(Object.keys(marker).sort(), ['at', 'code', 'stage', 'version']);
  assert.match(marker.code, /^ai_/);
  assert.equal(raw.includes(SECRET), false);
  assert.equal(raw.includes(SOURCE), false);
});

test('overnight identifies document export failure after successful AI review', async t => {
  const f = await overnightFixture(t, { exportError: `Renderer failure ${SECRET} ${SOURCE}` });
  assert.equal((await f.run()).status, 'needs_attention');
  assert.deepEqual(f.calls, ['draft', 'review_1']);
  assert.match(userFailure(f), /파일|보고서|발표자료/);
  assert.match(userFailure(f), /생성|변환|내보내|출력/);
  assert.equal(f.requests.some(request => request.binaryBody), false);
});

test('overnight identifies upload failure separately from AI review and file generation', async t => {
  const f = await overnightFixture(t, { uploadError: `Upload failure ${SECRET} ${SOURCE}` });
  assert.equal((await f.run()).status, 'needs_attention');
  assert.deepEqual(f.calls, ['draft', 'review_1']);
  assert.match(userFailure(f), /업로드|전송|서버/);
  assert.equal(f.requests.filter(request => request.binaryBody).length, 1);
});
