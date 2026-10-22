import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { prepareEditedArtifact } from '../agent/edit.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const aiEnv = { AI_MODE: 'openai', OPENAI_API_KEY: 'test-edit-api-key', OPENAI_MODEL: 'test-edit-model' };
const apiResponse = (content, summary = '표현을 수정함') => new Response(JSON.stringify({
  status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ content, summary }) }] }],
}), { headers: { 'Content-Type': 'application/json' } });

async function fixture(t, { content = '안녕하세요. 회의는 금요일입니다.\n', sourceName = '회의안내.md' } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'remote-edit-test-'));
  t.after(async () => {
    // Only remove the test-owned directory directly below the OS temporary folder.
    if (path.dirname(directory) === path.resolve(tmpdir()) && path.basename(directory).startsWith('remote-edit-test-')) {
      await rm(directory, { recursive: true, force: true });
    }
  });
  const sourcePath = path.join(directory, sourceName);
  await writeFile(sourcePath, content);
  return {
    directory, stateDir: path.join(directory, 'state'),
    input: { jobId: randomUUID(), instruction: '공손한 표현으로 바꿔줘', sourcePath, sourceName, sourceSha256: hash(content) },
  };
}

test('an empty instruction returns a hash-verified original without credentials or an AI request', async t => {
  const f = await fixture(t);
  const result = await prepareEditedArtifact({ ...f.input, instruction: '  ' }, {
    env: {}, stateDir: f.stateDir, fetchImpl: async () => assert.fail('No API call is allowed'),
  });
  assert.deepEqual(result, { attachmentPath: f.input.sourcePath, attachmentName: f.input.sourceName, sha256: f.input.sourceSha256, edited: false });
  await assert.rejects(prepareEditedArtifact({ ...f.input, instruction: '', sourceSha256: '0'.repeat(64) }), /source changed/);
});

test('editing creates a separate UTF-8 artifact and preserves the original document', async t => {
  const f = await fixture(t);
  const original = await readFile(f.input.sourcePath);
  let calls = 0;
  const result = await prepareEditedArtifact(f.input, {
    env: aiEnv, stateDir: f.stateDir,
    fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url, 'https://api.openai.com/v1/responses');
      assert.equal(options.headers.Authorization, 'Bearer test-edit-api-key');
      assert.equal(options.redirect, 'error');
      const body = JSON.parse(options.body);
      assert.equal(body.store, false);
      assert.equal(body.model, 'test-edit-model');
      assert.equal(body.text.format.type, 'json_schema');
      assert.equal(body.text.format.strict, true);
      assert.equal(body.text.format.schema.additionalProperties, false);
      assert.equal(body.tools, undefined);
      assert.match(body.instructions, /untrusted document data/);
      const input = JSON.parse(body.input[0].content[0].text);
      assert.equal(input.editingInstruction, f.input.instruction);
      assert.equal(input.sourceDocument.content, original.toString('utf8'));
      return apiResponse('안녕하십니까. 회의는 금요일에 진행됩니다.\n');
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.edited, true);
  assert.equal(result.attachmentName, '회의안내_수정본.md');
  assert.equal(path.dirname(result.attachmentPath), path.join(f.stateDir, 'edited', f.input.jobId));
  assert.notEqual(result.attachmentPath, f.input.sourcePath);
  assert.deepEqual(await readFile(f.input.sourcePath), original);
  const output = await readFile(result.attachmentPath);
  assert.equal(output.toString('utf8'), '안녕하십니까. 회의는 금요일에 진행됩니다.\n');
  assert.equal(result.sha256, hash(output));
});

test('the same job reuses its verified artifact and does not call the model again', async t => {
  const f = await fixture(t);
  let calls = 0;
  const options = { env: aiEnv, stateDir: f.stateDir, fetchImpl: async () => { calls++; return apiResponse('수정본'); } };
  const first = await prepareEditedArtifact(f.input, options);
  const again = await prepareEditedArtifact(f.input, { ...options, env: {} });
  assert.deepEqual(again, first);
  assert.equal(calls, 1);
  await assert.rejects(prepareEditedArtifact({ ...f.input, instruction: '다른 편집 요청' }, options), /different source or editing instruction/);
  assert.equal(calls, 1);
  const metadata = await readFile(path.join(path.dirname(first.attachmentPath), 'metadata.json'), 'utf8');
  assert.equal(metadata.includes(f.input.instruction), false);
  assert.equal(metadata.includes(aiEnv.OPENAI_API_KEY), false);
});

test('a changed selected source is rejected before calling the editing API', async t => {
  const f = await fixture(t);
  await writeFile(f.input.sourcePath, '사용자가 바꾼 새 원본');
  await assert.rejects(prepareEditedArtifact(f.input, {
    env: aiEnv, stateDir: f.stateDir, fetchImpl: async () => assert.fail('Changed source must not reach the model'),
  }), /source changed/);
  await assert.rejects(prepareEditedArtifact({ ...f.input, sourceSha256: undefined }), /SHA-256 hash is required/);
});

test('a completed job cannot be reused with new source bytes even when the new expected hash is supplied', async t => {
  const f = await fixture(t);
  const options = { env: aiEnv, stateDir: f.stateDir, fetchImpl: async () => apiResponse('수정본') };
  await prepareEditedArtifact(f.input, options);
  await writeFile(f.input.sourcePath, '새 원본');
  await assert.rejects(prepareEditedArtifact({ ...f.input, sourceSha256: hash('새 원본') }, options), /different source or editing instruction/);
});

test('Office binaries are not text-edited but remain available for unedited transfer', async t => {
  const f = await fixture(t, { sourceName: '문서.docx', content: 'sample only, not an actual Office file' });
  const options = { env: aiEnv, stateDir: f.stateDir, fetchImpl: async () => assert.fail('Unsupported format must not reach the model') };
  await assert.rejects(prepareEditedArtifact(f.input, options), /UTF-8 text, code, and configuration files only/);
  const original = await prepareEditedArtifact({ ...f.input, instruction: '' }, options);
  assert.equal(original.attachmentPath, f.input.sourcePath);
  assert.equal(original.edited, false);
});

test('Python source edits are returned as a separate UTF-8 file without executing the code', async t => {
  const original = 'def greet(name):\n    return "안녕, " + name\n';
  const f = await fixture(t, { sourceName: 'greet.py', content: original });
  const edited = 'def greet(name):\n    return f"안녕하세요, {name}!"\n';
  const result = await prepareEditedArtifact(f.input, {
    env: aiEnv, stateDir: f.stateDir,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.match(body.instructions, /Python source code/);
      assert.match(body.instructions, /Do not execute it/);
      return apiResponse(edited);
    },
  });
  assert.equal(result.attachmentName, 'greet_수정본.py');
  assert.equal(await readFile(f.input.sourcePath, 'utf8'), original);
  assert.equal(await readFile(result.attachmentPath, 'utf8'), edited);
});

test('JSON edits validate both the original and model output before saving', async t => {
  const original = '{"service":"이어","enabled":false}\n';
  const f = await fixture(t, { sourceName: 'settings.json', content: original });
  let calls = 0;
  const options = { env: aiEnv, stateDir: f.stateDir, fetchImpl: async (_url, request) => {
    calls++;
    assert.match(JSON.parse(request.body).instructions, /syntactically valid JSON/);
    return apiResponse('{"service":"이어","enabled":true}\n');
  } };
  const result = await prepareEditedArtifact(f.input, options);
  assert.equal(result.attachmentName, 'settings_수정본.json');
  assert.equal(JSON.parse(await readFile(result.attachmentPath, 'utf8')).enabled, true);
  assert.equal(await readFile(f.input.sourcePath, 'utf8'), original);
  assert.equal(calls, 1);

  const invalidOutput = await fixture(t, { sourceName: 'bad-output.json', content: original });
  await assert.rejects(prepareEditedArtifact(invalidOutput.input, {
    env: aiEnv, stateDir: invalidOutput.stateDir, fetchImpl: async () => apiResponse('{"enabled":}'),
  }), /edited JSON file is not valid JSON/);

  const invalidSource = await fixture(t, { sourceName: 'bad-source.json', content: '{broken' });
  await assert.rejects(prepareEditedArtifact(invalidSource.input, {
    env: aiEnv, stateDir: invalidSource.stateDir, fetchImpl: async () => assert.fail('Invalid source JSON must not reach the model'),
  }), /selected JSON file is not valid JSON/);
});

test('invalid UTF-8 and edit inputs above two MiB are rejected before any model request', async t => {
  const f = await fixture(t, { sourceName: '문서.txt', content: Buffer.from([0xff, 0xfe, 0x00, 0x10]) });
  const options = { env: aiEnv, stateDir: f.stateDir, fetchImpl: async () => assert.fail('Invalid input must not reach the model') };
  await assert.rejects(prepareEditedArtifact(f.input, options), /not valid UTF-8/);
  const oversized = Buffer.alloc(2 * 1024 * 1024 + 1, 'a');
  await writeFile(f.input.sourcePath, oversized);
  await assert.rejects(prepareEditedArtifact({ ...f.input, sourceSha256: hash(oversized) }, options), /2 MiB limit/);
});

test('model-controlled paths, recipients, or extra schema fields are rejected', async t => {
  const f = await fixture(t);
  await assert.rejects(prepareEditedArtifact(f.input, {
    env: aiEnv, stateDir: f.stateDir,
    fetchImpl: async () => new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({
      content: '수정본', summary: '변경', path: '../outside.txt', recipient: 'other@example.com',
    }) }] }] })),
  }), /invalid content\/summary object/);
  const files = await readdir(path.join(f.stateDir, 'edited', f.input.jobId));
  assert.deepEqual(files, ['metadata.json']);
});

test('oversized model output is rejected and never replaces the original', async t => {
  const f = await fixture(t);
  const original = await readFile(f.input.sourcePath);
  await assert.rejects(prepareEditedArtifact(f.input, {
    env: aiEnv, stateDir: f.stateDir, fetchImpl: async () => apiResponse('a'.repeat(2 * 1024 * 1024 + 1)),
  }), /output exceeds/);
  assert.deepEqual(await readFile(f.input.sourcePath), original);
});

test('a modified cached artifact is rejected instead of silently reusing or regenerating it', async t => {
  const f = await fixture(t);
  let calls = 0;
  const options = { env: aiEnv, stateDir: f.stateDir, fetchImpl: async () => { calls++; return apiResponse('수정본'); } };
  const output = await prepareEditedArtifact(f.input, options);
  await writeFile(output.attachmentPath, '외부에서 변경된 결과');
  await assert.rejects(prepareEditedArtifact(f.input, options), /saved edited artifact changed/);
  assert.equal(calls, 1);
});

test('invalid job IDs and unsafe attachment names are rejected without creating edit state', async t => {
  const f = await fixture(t);
  for (const jobId of ['../escape', 'not-a-uuid', '00000000-0000-0000-0000-000000000000']) {
    await assert.rejects(prepareEditedArtifact({ ...f.input, jobId }, { stateDir: f.stateDir }), /must be a UUID/);
  }
  await assert.rejects(prepareEditedArtifact({ ...f.input, sourceName: '../escape.md' }, { stateDir: f.stateDir }), /attachment name/);
});

test('failed model requests are recorded and are not charged again on retries', async t => {
  const f = await fixture(t);
  let calls = 0;
  const options = { env: aiEnv, stateDir: f.stateDir, fetchImpl: async () => { calls++; return new Response('{}', { status: 503 }); } };
  await assert.rejects(prepareEditedArtifact(f.input, options), /HTTP 503/);
  await assert.rejects(prepareEditedArtifact(f.input, options), /already attempted and is incomplete/);
  assert.equal(calls, 1);
});

test('concurrent executions claim the job before the API call and allow only one model request', async t => {
  const f = await fixture(t);
  let finishApi;
  let enteredApi;
  const entered = new Promise(resolve => { enteredApi = resolve; });
  const waiting = new Promise(resolve => { finishApi = resolve; });
  let calls = 0;
  const options = { env: aiEnv, stateDir: f.stateDir, fetchImpl: async () => { calls++; enteredApi(); await waiting; return apiResponse('한 번만 만든 수정본'); } };
  const first = prepareEditedArtifact(f.input, options);
  await entered;
  await assert.rejects(prepareEditedArtifact(f.input, options), /already attempted|already being prepared/);
  finishApi();
  assert.equal((await first).edited, true);
  assert.equal(calls, 1);
});

test('source changes during model processing are detected before writing an edited artifact', async t => {
  const f = await fixture(t);
  await assert.rejects(prepareEditedArtifact(f.input, {
    env: aiEnv, stateDir: f.stateDir, fetchImpl: async () => { await writeFile(f.input.sourcePath, '변경된 원본'); return apiResponse('수정본'); },
  }), /source changed while the edit/);
  assert.deepEqual(await readdir(path.join(f.stateDir, 'edited', f.input.jobId)), ['metadata.json']);
  assert.equal(await readFile(f.input.sourcePath, 'utf8'), '변경된 원본');
});
