import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, writeFile, readFile, readdir, rm, cp, link, symlink } from 'node:fs/promises';
import { FinancialDocuments } from '../financial-documents/adapter.mjs';
import { digest } from '../personal-ai/documents/files.mjs';
import { strictJSON } from '../financial-documents/strict-json.mjs';

const python = process.env.DIANA_TEST_PYTHON || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python', process.platform === 'win32' ? 'python.exe' : 'bin/python');
const workspace = path.resolve('.local');
const selection = (action = 'patch', format = 'md', item_ids = ['KEY_MAN']) => ({ action, format, item_ids,
  target_doc: 'REVIEW_A', source_ids: ['DD_A'], guideline_id: 'PE-02' });

async function setup(t, { variant = 'fund-a', ttl = 300_000 } = {}) {
  await mkdir(workspace, { recursive: true });
  const root = await mkdtemp(path.join(workspace, 'financial-test-'));
  const input = path.join(root, 'input'); const output = path.join(root, 'output');
  await cp(path.resolve('financial-documents/fixtures', variant), input, { recursive: true });
  await mkdir(output);
  const configPath = path.join(root, 'config.json');
  const ids = variant === 'fund-a' ? [['REVIEW_A', 'review.md'], ['DD_A', 'due-diligence.txt'], ['PE-02', 'guideline.json']] :
    [['EVIDENCE_Z', 'evidence.md'], ['CHECK_Z', 'guideline.json'], ['REVIEW_Z', 'review.txt']];
  const config = { schema_version: 1, principal: 'test-analyst', role: 'analyst', readRoots: [input], outputRoot: output,
    python, approval_ttl_ms: ttl, write_roles: ['analyst'], documents: ids.map(([id, relativePath]) => ({
      id, relativePath, version: variant === 'rearranged' && id === 'CHECK_Z' ? 'rev2' : '1', rootIndex: 0,
      classification: 'synthetic', read_roles: ['analyst'] })) };
  const updateConfig = () => writeFile(configPath, JSON.stringify(config));
  await updateConfig();
  t.after(async () => {
    assert.equal(path.dirname(root), workspace); assert.match(path.basename(root), /^financial-test-/u);
    await rm(root, { recursive: true, force: true });
  });
  return { root, input, output, config, configPath, updateConfig, adapter: await FinancialDocuments.create({ configPath }) };
}

async function approve(adapter, plan) {
  assert.equal(plan.status, 'AWAITING_APPROVAL', JSON.stringify(plan));
  const approved = await adapter.approve(plan.plan_id, plan.plan_hash);
  assert.equal(approved.reason, 'APPROVAL_ISSUED', JSON.stringify(approved));
  return approved;
}
const outputs = async folder => (await readdir(folder)).filter(name => /\.(?:md|txt|json)$/u.test(name));

for(const format of ['md','txt','json'])test('saved '+format+' is reviewed as the actual saved body and restored without approvals',async t=>{
  const f=await setup(t),input=selection('patch',format),plan=await f.adapter.prepare(input),approved=await approve(f.adapter,plan),result=await f.adapter.execute(approved.token);
  const bytes=await readFile(result.outputFile),review=await f.adapter.reviewSaved(result.request_id);
  assert.deepEqual(review.items.map(i=>i.status),['SATISFIED','SATISFIED','MISSING_NO_EVIDENCE']);assert.equal(review.reviewComplete,false);assert.deepEqual(review.unresolved.map(i=>i.item_id),['LPAC']);
  assert.deepEqual(await readFile(result.outputFile),bytes);assert.equal((await outputs(f.output)).length,1);
  const restarted=await FinancialDocuments.create({configPath:f.configPath}),loaded=await restarted.loadSavedResults([input]);assert.equal(loaded.length,1);assert.equal(loaded[0].requestId,result.request_id);
  assert.deepEqual((await restarted.reviewSaved(result.request_id)).items.map(i=>i.status),review.items.map(i=>i.status));assert.equal((await restarted.approve(plan.plan_id,plan.plan_hash)).reason,'UNKNOWN_OR_CHANGED_PLAN');
});
test('saved recheck leaves another pending plan and its explicit approval intact',async t=>{
  const f=await setup(t),plan=await f.adapter.prepare(selection()),approved=await approve(f.adapter,plan),saved=await f.adapter.execute(approved.token);
  const next=await f.adapter.prepare(selection('convert','txt',[]));await f.adapter.reviewSaved(saved.request_id);const second=await approve(f.adapter,next);assert.equal((await f.adapter.execute(second.token)).status,'COMPLETED');assert.equal((await outputs(f.output)).length,2);
});
test('saved review refuses tampered files, unregistered receipts and changed policy without overwriting',async t=>{
  const f=await setup(t),input=selection(),plan=await f.adapter.prepare(input),approved=await approve(f.adapter,plan),saved=await f.adapter.execute(approved.token);
  await assert.rejects(f.adapter.reviewSaved(randomUUID()),{code:'NO_SAVED_RESULT'});
  const changed=Buffer.from('EXTERNAL_MODIFICATION');await writeFile(saved.outputFile,changed);await assert.rejects(f.adapter.reviewSaved(saved.request_id),{code:'CONTENT_CHANGED'});
  const restarted=await FinancialDocuments.create({configPath:f.configPath});assert.deepEqual(await restarted.loadSavedResults([input]),[]);assert.deepEqual(await readFile(saved.outputFile),changed);
  f.config.documents[0].read_roles=[];await f.updateConfig();await assert.rejects(f.adapter.reviewSaved(saved.request_id));assert.deepEqual(await readFile(saved.outputFile),changed);
});

test('real synthetic review preserves satisfied item and explicitly patches only evidence-backed omission', async t => {
  const f = await setup(t);
  const original = await readFile(path.join(f.input, 'review.md'));
  const review = await f.adapter.prepare(selection('checklist_review', 'md', []));
  assert.equal(review.status, 'ACTION_REQUIRED'); assert.equal(review.inference_mode, 'explicit');
  assert.deepEqual(review.items.map(i => i.status), ['SATISFIED', 'MISSING_WITH_EVIDENCE', 'MISSING_NO_EVIDENCE']);
  assert.equal(review.saved, false); assert.equal(review.review_complete, false);
  const plan = await f.adapter.prepare(selection());
  assert.equal(plan.plan_hash, digest(plan.canonical_payload));
  assert.equal(plan.changes[0].source.display, '[DD_A#p003]');
  assert.equal(plan.changes[0].source.quote, '핵심 운용역 이탈 조항은 지정 운용역 이탈 시 신규 투자를 중단하고 출자자 협의를 진행한다고 명시한다.');
  assert.equal((await outputs(f.output)).length, 0);
  assert.equal((await f.adapter.execute({ confirmed: true })).status, 'ABORTED');
  const token = await approve(f.adapter, plan);
  assert.equal((await outputs(f.output)).length, 0);
  const result = await f.adapter.execute(token.token);
  assert.equal(result.status, 'COMPLETED', JSON.stringify(result));
  assert.equal(result.saved, true); assert.equal(result.review_complete, false); assert.equal(result.all_items_addressed, false);
  const content = await readFile(result.outputFile, 'utf8');
  assert.ok(content.startsWith(original.toString('utf8')));
  assert.ok(content.includes(plan.changes[0].source.quote));
  assert.equal(content, plan.output_content);
  assert.ok(content.includes('## 추가 확인 필요 항목'));
  assert.ok(content.includes('LP 자문위원회 참여권 (LPAC)'));
  assert.ok(content.includes('추가 자료 확보 또는 운용사 확인 필요'));
  assert.doesNotMatch(content, /LPAC 참여권이 없다|LP 자문위원회 참여권이 없다/u);
  assert.equal(digest(content), result.output_hash);
  assert.deepEqual(await readFile(path.join(f.input, 'review.md')), original);
  assert.equal((await f.adapter.execute(token.token)).reason, 'UNKNOWN_OR_USED_APPROVAL');
  const ledger = path.join(f.output, '.financial-ledger');
  for (const name of await readdir(ledger)) {
    const record = await readFile(path.join(ledger, name), 'utf8');
    assert.doesNotMatch(record, /운용역|환노출|review\.md|C:\\\\|due-diligence/u);
  }
});

test('TXT MD JSON are serialized and read back as actual formats', async t => {
  const f = await setup(t);
  for (const format of ['txt', 'md', 'json']) {
    const plan = await f.adapter.prepare(selection('patch', format));
    const token = await approve(f.adapter, plan);
    const result = await f.adapter.execute(token.token);
    assert.equal(result.status, 'COMPLETED', JSON.stringify(result));
    const raw = await readFile(result.outputFile, 'utf8');
    if (format === 'json') assert.deepEqual(JSON.parse(raw), JSON.parse(JSON.stringify(plan.common_document)));
    else {
      assert.ok(raw.includes('DIANA-COMMON-V2'));
      assert.ok(raw.includes('추가 확인 필요 항목'));
      assert.ok(raw.includes('LP 자문위원회 참여권 (LPAC)'));
    }
    assert.equal(raw, plan.output_content);
    assert.ok(result.outputFile.endsWith(`.${format}`));
  }
  assert.equal((await outputs(f.output)).length, 3);
});

test('document IDs labels item order and paragraph locations are not fixture-specific', async t => {
  const f = await setup(t, { variant: 'rearranged' });
  const args = { action: 'patch', target_doc: 'REVIEW_Z', source_ids: ['EVIDENCE_Z'], guideline_id: 'CHECK_Z', item_ids: ['PERSON_Z'], format: 'md' };
  const plan = await f.adapter.prepare(args);
  assert.deepEqual(plan.items.map(i => i.status), ['MISSING_NO_EVIDENCE', 'MISSING_WITH_EVIDENCE', 'SATISFIED']);
  assert.equal(plan.changes[0].source.display, '[EVIDENCE_Z#p002]');
  assert.ok(plan.output_content.includes('평의회 참여 (COUNCIL_Z)'));
  assert.equal(plan.output_content.includes('(LPAC)'), false);
  assert.equal((await f.adapter.execute((await approve(f.adapter, plan)).token)).status, 'COMPLETED');
});

test('absent or conflicting evidence pauses and never asserts missing rights', async t => {
  const f = await setup(t);
  const missing = await f.adapter.prepare(selection('patch', 'md', ['LPAC']));
  assert.equal(missing.status, 'ACTION_REQUIRED');
  await writeFile(path.join(f.input, 'due-diligence.txt'), '출자자에게 LPAC 참여권이 있다.\n\nLPAC 참여권이 없다.');
  const result = await f.adapter.prepare(selection('checklist_review', 'md', []));
  assert.equal(result.items[2].status, 'NEEDS_CONFIRMATION');
  assert.equal(result.status, 'ACTION_REQUIRED');
  assert.equal((await outputs(f.output)).length, 0);
});

test('unknown JSON conditions, duplicate keys, NaN, invalid UTF-8 and unsupported formats fail closed', async t => {
  for (const content of ['{"id":"PE-02","id":"OTHER"}', '{"x":NaN}', '{"x":Infinity}', '{bad']) {
    const f = await setup(t); await writeFile(path.join(f.input, 'guideline.json'), content);
    assert.notEqual((await f.adapter.prepare(selection())).status, 'AWAITING_APPROVAL');
    assert.equal((await outputs(f.output)).length, 0);
  }
  const f = await setup(t);
  const guidePath = path.join(f.input, 'guideline.json');
  const guide = JSON.parse(await readFile(guidePath, 'utf8')); guide.rules[0].condition = 'regex';
  await writeFile(guidePath, JSON.stringify(guide));
  assert.equal((await f.adapter.prepare(selection())).reason, 'UNSUPPORTED_CONDITION');
  await writeFile(path.join(f.input, 'review.md'), Buffer.from([0xc3, 0x28]));
  assert.equal((await f.adapter.prepare(selection())).reason, 'INVALID_UTF8');
  assert.equal((await f.adapter.prepare({ ...selection(), format: 'docx' })).status, 'CLARIFICATION_REQUIRED');
  for (const raw of ['{"a":1,"a":2}', '[NaN]', '[Infinity]', '[1e999]', '{"a":{"x":1,"x":2}}']) assert.throws(() => strictJSON(raw));
});

test('target evidence and guideline changes invalidate approval before approval and before saving', async t => {
  for (const filename of ['review.md', 'due-diligence.txt', 'guideline.json']) {
    for (const stage of ['approve', 'execute']) {
      const f = await setup(t); const plan = await f.adapter.prepare(selection());
      const approval = stage === 'execute' ? await approve(f.adapter, plan) : null;
      const source = path.join(f.input, filename);
      await writeFile(source, (await readFile(source, 'utf8')) + '\n');
      const result = stage === 'execute' ? await f.adapter.execute(approval.token) : await f.adapter.approve(plan.plan_id, plan.plan_hash);
      assert.equal(result.status, 'ABORTED', JSON.stringify(result));
      assert.equal(result.reason, 'CONTENT_CHANGED');
      assert.equal((await outputs(f.output)).length, 0);
    }
  }
});

test('approval rejects changed hashes forged tokens cancellation expiration and superseding plans', async t => {
  const f = await setup(t);
  let plan = await f.adapter.prepare(selection());
  assert.notEqual((await f.adapter.approve(plan.plan_id, '0'.repeat(64))).reason, 'APPROVAL_ISSUED');
  plan = await f.adapter.prepare(selection());
  const token = await approve(f.adapter, plan);
  assert.equal((await f.adapter.execute(randomUUID())).status, 'ABORTED');
  assert.equal(f.adapter.cancelPending().status, 'CANCELLED');
  assert.equal((await f.adapter.execute(token.token)).status, 'ABORTED');
  const next = await f.adapter.prepare(selection()); const oldToken = await approve(f.adapter, next);
  await f.adapter.prepare(selection('convert', 'txt', []));
  assert.equal((await f.adapter.execute(oldToken.token)).status, 'ABORTED');
  assert.equal((await outputs(f.output)).length, 0);
  const expired = await setup(t, { ttl: 1 });
  const expPlan = await expired.adapter.prepare(selection());
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await expired.adapter.approve(expPlan.plan_id, expPlan.plan_hash)).reason, 'APPROVAL_EXPIRED');
  const expAfter = await setup(t); const approvedPlan = await expAfter.adapter.prepare(selection());
  const approvedToken = await approve(expAfter.adapter, approvedPlan);
  const originalNow = Date.now;
  try {
    const future = originalNow() + 400_000; Date.now = () => future;
    const result = await expAfter.adapter.execute(approvedToken.token);
    assert.equal(result.status, 'ABORTED'); assert.equal(result.reason, 'APPROVAL_EXPIRED');
  } finally { Date.now = originalNow; }
  const conflict = await setup(t); const requestId = randomUUID();
  const oldPlan = await conflict.adapter.prepare(selection(), { requestId });
  const oldApproval = await approve(conflict.adapter, oldPlan);
  assert.equal((await conflict.adapter.prepare(selection('convert', 'txt', []), { requestId })).reason, 'REQUEST_CONFLICT');
  assert.equal((await conflict.adapter.execute(oldApproval.token)).reason, 'UNKNOWN_OR_USED_APPROVAL');
});

test('mutating a returned preview cannot alter the executable approval', async t => {
  const f = await setup(t); const plan = await f.adapter.prepare(selection());
  const expected = plan.output_content; const hash = plan.plan_hash; const id = plan.plan_id;
  plan.output_content = 'tampered'; plan.approval_payload.output_content = 'tampered';
  plan.changes[0].source.quote = 'invented'; plan.canonical_payload = '{}';
  const approved = await f.adapter.approve(id, hash);
  const result = await f.adapter.execute(approved.token);
  assert.equal(result.status, 'COMPLETED');
  assert.equal(await readFile(result.outputFile, 'utf8'), expected);
});

test('permission denied documents have no candidates or bodies and request fields cannot grant access', async t => {
  const f = await setup(t);
  f.config.documents.find(d => d.id === 'DD_A').read_roles = ['supervisor']; await f.updateConfig();
  const adapter = await FinancialDocuments.create({ configPath: f.configPath });
  assert.deepEqual((await adapter.candidates()).map(d => d.id), ['REVIEW_A', 'PE-02']);
  const denied = await adapter.prepare(selection());
  assert.equal(denied.status, 'BLOCKED'); assert.equal(denied.reason, 'ACCESS_DENIED');
  assert.doesNotMatch(JSON.stringify(denied), /운용역|이탈|due-diligence/u);
  assert.equal((await adapter.prepare({ ...selection(), role: 'supervisor', confirmed: true })).status, 'CLARIFICATION_REQUIRED');
  assert.equal((await adapter.prepare(selection('export'))).status, 'BLOCKED');
  assert.equal((await outputs(f.output)).length, 0);
});

test('revoking permissions or editing trusted policy requires a new session and approval', async t => {
  for (const change of [c => c.write_roles = [], c => c.documents[1].read_roles = [], c => c.approval_ttl_ms = 200_000]) {
    const f = await setup(t); const plan = await f.adapter.prepare(selection()); const token = await approve(f.adapter, plan);
    change(f.config); await f.updateConfig();
    const result = await f.adapter.execute(token.token);
    assert.ok(['BLOCKED', 'ABORTED'].includes(result.status), JSON.stringify(result));
    assert.equal((await outputs(f.output)).length, 0);
  }
});

test('request id and simultaneous multi-instance execution cannot duplicate writes', async t => {
  const f = await setup(t); const requestId = randomUUID();
  const second = await FinancialDocuments.create({ configPath: f.configPath });
  const [one, two] = await Promise.all([f.adapter.prepare(selection(), { requestId }), second.prepare(selection(), { requestId })]);
  assert.equal(one.plan_hash, two.plan_hash);
  const [a, b] = await Promise.all([approve(f.adapter, one), approve(second, two)]);
  const results = await Promise.all([f.adapter.execute(a.token), second.execute(b.token), f.adapter.execute(a.token)]);
  assert.equal(results.filter(r => r.status === 'COMPLETED').length, 1, JSON.stringify(results));
  assert.equal((await outputs(f.output)).length, 1);
  const third = await FinancialDocuments.create({ configPath: f.configPath });
  const duplicate = await third.prepare(selection(), { requestId });
  assert.equal(duplicate.reason, 'ALREADY_CLAIMED');
  assert.equal((await third.prepare(selection('convert', 'txt', []), { requestId })).reason, 'REQUEST_CONFLICT');
});

test('same-instance concurrent prepares and cancellation during core work cannot publish stale plans', async t => {
  const f = await setup(t); const requestId = randomUUID();
  const results = await Promise.all([f.adapter.prepare(selection(), { requestId }), f.adapter.prepare(selection(), { requestId })]);
  assert.equal(results.filter(r => r.status === 'AWAITING_APPROVAL').length, 1);
  const pending = f.adapter.prepare(selection()); f.adapter.cancelPending();
  assert.equal((await pending).status, 'CANCELLED');
});

test('path escapes hardlinks junctions wrong extensions and oversized files are rejected', async t => {
  for (const bad of ['../outside.md', 'C:\\Windows\\outside.md', '\\\\server\\share\\doc.md', 'review.docx']) {
    const f = await setup(t); f.config.documents[0].relativePath = bad; await f.updateConfig();
    const adapter = await FinancialDocuments.create({ configPath: f.configPath });
    assert.equal((await adapter.prepare(selection())).reason, 'PATH_DENIED');
  }
  const f = await setup(t); await link(path.join(f.input, 'review.md'), path.join(f.root, 'hardlink.md'));
  assert.equal((await f.adapter.prepare(selection())).reason, 'FILE_DENIED');
  const j = await setup(t); const outside = path.join(j.root, 'outside'); await mkdir(outside);
  await writeFile(path.join(outside, 'review.md'), 'external text');
  await symlink(outside, path.join(j.input, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  j.config.documents[0].relativePath = 'linked/review.md'; await j.updateConfig();
  const junctionAdapter = await FinancialDocuments.create({ configPath: j.configPath });
  assert.notEqual((await junctionAdapter.prepare(selection())).status, 'AWAITING_APPROVAL');
  const large = await setup(t); await writeFile(path.join(large.input, 'review.md'), Buffer.alloc(262_145, 65));
  assert.equal((await large.adapter.prepare(selection())).reason, 'FILE_DENIED');
});

test('occupied output and incomplete claims never produce false success or overwrite', async t => {
  const f = await setup(t); const plan = await f.adapter.prepare(selection());
  const target = path.join(f.output, `DIANA-finance-${plan.plan_hash}.md`);
  await writeFile(target, 'existing result');
  const result = await f.adapter.execute((await approve(f.adapter, plan)).token);
  assert.equal(result.status, 'UNCERTAIN'); assert.equal(result.saved, false);
  assert.equal(await readFile(target, 'utf8'), 'existing result');
  const restart = await FinancialDocuments.create({ configPath: f.configPath });
  assert.equal((await restart.prepare(selection(), { requestId: plan.request_id })).status, 'UNCERTAIN');
});

test('importing new adapter and CLI does not start processes or network requests', async () => {
  const script = String.raw`
    import { mock } from 'node:test';
    const denied = () => { throw new Error('import_side_effect'); };
    for (const [name, methods] of [['node:child_process',['execFile','spawn','exec']], ['node:http',['request','get']], ['node:https',['request','get']]]) {
      const actual = await import(name);
      const namedExports = Object.fromEntries(Object.entries(actual).filter(([k]) => k !== 'default'));
      for (const method of methods) namedExports[method] = denied;
      mock.module(name, { namedExports });
    }
    globalThis.fetch = denied;
    await import('./financial-documents/adapter.mjs');
    await import('./financial-documents/cli.mjs');
  `;
  await promisify(execFile)(process.execPath, ['--no-warnings', '--experimental-test-module-mocks', '--input-type=module', '-e', script], { timeout: 10_000 });
});

test('storage cancellation partial writes readback and receipt failures never claim unverified completion', async t => {
  const script = String.raw`
    import assert from 'node:assert/strict';
    import path from 'node:path';
    import { mock } from 'node:test';
    const fs = await import('node:fs/promises');
    const [mode, configPath, output] = process.argv.slice(1);
    let adapter, armed = false, opened = false, bodyWrites = 0;
    const namedExports = Object.fromEntries(Object.entries(fs).filter(([key]) => key !== 'default'));
    mock.module('node:fs/promises', { namedExports: { ...namedExports, open: async (filename, flags, ...rest) => {
      const isOutput = String(filename).startsWith(output + path.sep) && String(filename).endsWith('.md');
      if (armed && opened && isOutput && typeof flags === 'number' && mode === 'readback-failure') throw new Error('readback failure');
      const handle = await fs.open(filename, flags, ...rest);
      if (armed && isOutput && flags === 'wx') {
        opened = true;
        if (mode === 'after-open') adapter.cancelPending();
        if (mode === 'permission-after-open') {
          const config = JSON.parse(await fs.readFile(configPath, 'utf8')); config.write_roles = [];
          await fs.writeFile(configPath, JSON.stringify(config));
        }
        return {
          stat: (...args) => handle.stat(...args), sync: () => handle.sync(), close: () => handle.close(),
          writeFile: async content => {
            bodyWrites++;
            if (mode === 'write-failure') { await handle.writeFile(content.slice(0, 10)); throw new Error('partial write'); }
            await handle.writeFile(content);
            if (mode === 'after-write') adapter.cancelPending();
          },
        };
      }
      if (armed && String(filename).includes('request-') && flags === 'wx' && ['record-failure', 'record-short'].includes(mode)) {
        return {
          stat: (...args) => handle.stat(...args),
          writeFile: (...args) => handle.writeFile(...args), sync: () => handle.sync(), close: () => handle.close(),
          truncate: (...args) => handle.truncate(...args), write: async (buffer, offset, length, position) => {
            if (mode === 'record-failure') throw new Error('receipt failure');
            return handle.write(buffer, offset, Math.min(10, length), position);
          },
        };
      }
      return handle;
    } } });
    for (const name of ['node:http', 'node:https', 'node:net', 'node:tls']) {
      const module = await import(name);
      const exports = Object.fromEntries(Object.entries(module).filter(([key]) => key !== 'default'));
      for (const key of ['request', 'get', 'connect', 'createConnection', 'createServer']) if (exports[key]) exports[key] = () => { throw new Error('network call'); };
      mock.module(name, { namedExports: exports });
    }
    globalThis.fetch = () => { throw new Error('fetch call'); };
    const { FinancialDocuments } = await import('./financial-documents/adapter.mjs');
    adapter = await FinancialDocuments.create({ configPath });
    const operation = { action: 'patch', target_doc: 'REVIEW_A', source_ids: ['DD_A'], guideline_id: 'PE-02', item_ids: ['KEY_MAN'], format: 'md' };
    const plan = await adapter.prepare(operation);
    const approval = await adapter.approve(plan.plan_id, plan.plan_hash);
    armed = true;
    const result = await adapter.execute(approval.token);
    assert.equal(result.status, ['after-write', 'record-short'].includes(mode) ? 'COMPLETED' : 'UNCERTAIN', JSON.stringify(result));
    assert.equal(bodyWrites, ['after-open', 'permission-after-open'].includes(mode) ? 0 : 1);
    assert.equal(result.saved, ['after-write', 'record-short'].includes(mode));
    if (mode === 'record-failure') {
      assert.equal(result.storage_verified, true);
      armed = false;
      const restart = await FinancialDocuments.create({ configPath });
      const duplicate = await restart.prepare(operation, { requestId: plan.request_id });
      assert.equal(duplicate.status, 'UNCERTAIN', JSON.stringify(duplicate));
    }
    assert.equal((await adapter.execute(approval.token)).reason, 'UNKNOWN_OR_USED_APPROVAL');
    console.log(JSON.stringify({ mode, status: result.status, bodyWrites }));
  `;
  for (const mode of ['after-open', 'permission-after-open', 'write-failure', 'readback-failure', 'record-failure', 'record-short', 'after-write']) {
    const f = await setup(t);
    await promisify(execFile)(process.execPath, ['--no-warnings', '--experimental-test-module-mocks', '--input-type=module', '-e', script, mode, f.configPath, f.output], { timeout: 20_000 });
  }
});

test('denied sources are neither opened nor sent to Python', async t => {
  const f = await setup(t); f.config.documents[1].read_roles = []; await f.updateConfig();
  const script = String.raw`
    import assert from 'node:assert/strict';
    import { mock } from 'node:test';
    const fs = await import('node:fs/promises'); const cp = await import('node:child_process');
    let bodyReads = 0, coreCalls = 0;
    const fsExports = Object.fromEntries(Object.entries(fs).filter(([key]) => key !== 'default'));
    const cpExports = Object.fromEntries(Object.entries(cp).filter(([key]) => key !== 'default'));
    mock.module('node:fs/promises', { namedExports: { ...fsExports, open: (...args) => {
      if (String(args[0]).endsWith('due-diligence.txt')) bodyReads++;
      return fs.open(...args);
    } } });
    const tracedExecFile = (...args) => {
      if (args[1].some(arg => String(arg).includes('runpy'))) coreCalls++;
      return cp.execFile(...args);
    };
    const { promisify } = await import('node:util');
    tracedExecFile[promisify.custom] = cp.execFile[promisify.custom];
    mock.module('node:child_process', { namedExports: { ...cpExports, execFile: tracedExecFile } });
    const { FinancialDocuments } = await import('./financial-documents/adapter.mjs');
    const adapter = await FinancialDocuments.create({ configPath: process.argv[1] });
    assert.equal((await adapter.prepare({ action: 'patch', target_doc: 'REVIEW_A', source_ids: ['DD_A'], guideline_id: 'PE-02', item_ids: ['KEY_MAN'], format: 'md' })).status, 'BLOCKED');
    assert.equal(bodyReads, 0); assert.equal(coreCalls, 0);
  `;
  await promisify(execFile)(process.execPath, ['--no-warnings', '--experimental-test-module-mocks', '--input-type=module', '-e', script, f.configPath], { timeout: 10_000 });
});

test('text reader rejects an opened handle different from the inspected file before consuming bytes', async t => {
  const f = await setup(t);
  const script = String.raw`
    import assert from 'node:assert/strict';
    import { mock } from 'node:test';
    const fs = await import('node:fs/promises');
    const filename = process.argv[1]; const inspected = await fs.lstat(filename, { bigint: true });
    let reads = 0, closes = 0;
    const namedExports = Object.fromEntries(Object.entries(fs).filter(([key]) => key !== 'default'));
    mock.module('node:fs/promises', { namedExports: { ...namedExports, open: async () => ({
      stat: async () => ({ ...inspected, ino: inspected.ino + 1n, isFile: () => true, isSymbolicLink: () => false }),
      read: async () => { reads++; throw new Error('unexpected read'); }, close: async () => { closes++; },
    }) } });
    const { boundedRead } = await import('./financial-documents/files.mjs');
    await assert.rejects(boundedRead(filename), { code: 'FILE_CHANGED' });
    assert.equal(reads, 0); assert.equal(closes, 1);
  `;
  await promisify(execFile)(process.execPath, ['--no-warnings', '--experimental-test-module-mocks', '--input-type=module', '-e', script, path.join(f.input, 'review.md')], { timeout: 10_000 });
});

test('actual CLI requires the displayed plan hash then saves and exits', async t => {
  const f = await setup(t);
  const child = spawn(process.execPath, ['financial-documents/cli.mjs', '--config', f.configPath, '--action', 'patch',
    '--target', 'REVIEW_A', '--sources', 'DD_A', '--guideline', 'PE-02', '--items', 'KEY_MAN', '--format', 'md'],
  { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', errors = '', stage = 0;
  const timer = setTimeout(() => child.kill(), 15_000);
  child.stderr.on('data', chunk => { errors += chunk; });
  child.stdout.on('data', chunk => {
    output += chunk;
    if (stage === 0 && output.includes('finance> ')) {
      const hash = /\/approve ([a-f0-9]{64})/u.exec(output)?.[1];
      if (!hash) return;
      stage = 1; child.stdin.write(`/approve ${hash}\n`);
    }
    if (stage === 1 && output.includes('SAVED_AND_REREAD')) { stage = 2; child.stdin.write('/exit\n'); }
  });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  clearTimeout(timer);
  assert.equal(code, 0, errors); assert.equal(stage, 2, output);
  assert.equal((await outputs(f.output)).length, 1);
  assert.match(output, /inference_mode/u); assert.match(output, /MISSING_NO_EVIDENCE/u);
  assert.match(output, /추가 확인 필요 항목/u);
});

test('saved MD JSON TXT MD roundtrip preserves business content and excludes notices from all evidence', async t => {
  const f = await setup(t);
  let adapter = f.adapter; let target = 'REVIEW_A'; let expectedCommon;
  const originalHash = digest(await readFile(path.join(f.input, 'review.md')));
  const retainedFiles = [];
  for (const [index, format] of ['md', 'json', 'txt', 'md'].entries()) {
    const op = { ...selection(index === 0 ? 'patch' : 'convert', format, index === 0 ? ['KEY_MAN'] : []), target_doc: target };
    const plan = await adapter.prepare(op);
    assert.equal(plan.items.find(i => i.item_id === 'LPAC').status, 'MISSING_NO_EVIDENCE');
    assert.equal(plan.items.find(i => i.item_id === 'LPAC').evidence.length, 0);
    assert.equal(plan.approval_payload.output_hash, digest(plan.output_content));
    if (index === 0) expectedCommon = plan.common_document;
    else assert.deepEqual(plan.common_document, expectedCommon);
    assert.equal(plan.common_document.body.includes('DIANA 시스템 상태 표시'), false);
    const result = await adapter.execute((await approve(adapter, plan)).token);
    assert.equal(result.status, 'COMPLETED'); assert.equal(result.storage_verified, true);
    assert.equal(result.saved, true); assert.equal(result.review_complete, false);
    const raw = await readFile(result.outputFile, 'utf8');
    assert.equal(raw, plan.output_content); retainedFiles.push([result.outputFile, digest(raw)]);
    if (format === 'json') assert.equal(JSON.parse(raw).body, expectedCommon.body);
    else assert.equal(raw.split('추가 확인 필요 항목').length - 1, 1);
    target = `ROUND_${index}`; const filename = `round-${index}.${format}`;
    await cp(result.outputFile, path.join(f.input, filename));
    f.config.documents.push({ id: target, relativePath: filename, version: '2', rootIndex: 0, classification: 'synthetic', read_roles: ['analyst'] });
    await f.updateConfig(); adapter = await FinancialDocuments.create({ configPath: f.configPath });
    // Reuse that serialized document as an evidence source: the LPAC notice
    // still must not become a candidate, or even change the status to uncertain.
    const review = await adapter.prepare({ ...selection('checklist_review', 'md', []), source_ids: [target] });
    assert.equal(review.items.find(i => i.item_id === 'LPAC').status, 'MISSING_NO_EVIDENCE');
    assert.equal(review.items.find(i => i.item_id === 'LPAC').candidates.length, 0);
  }
  for (const [file, hash] of retainedFiles) assert.equal(digest(await readFile(file)), hash);
  assert.equal(digest(await readFile(path.join(f.input, 'review.md'))), originalHash);
});

test('all unresolved states get human notices and a fully satisfied checklist gets no list', async t => {
  const f = await setup(t);
  await writeFile(path.join(f.input, 'review.md'), '통화별 환노출과 헤지 계획은 정하지 않았다.');
  for (const format of ['md', 'txt']) {
    const plan = await f.adapter.prepare(selection('convert', format, []));
    assert.deepEqual(plan.unresolved.map(i => i.status), ['NEEDS_CONFIRMATION', 'MISSING_WITH_EVIDENCE', 'MISSING_NO_EVIDENCE']);
    for (const item of plan.unresolved) assert.ok(plan.output_content.includes(`(${item.item_id})`));
    for (const phrase of ['근거는 확인했지만 아직 보완하지 않은 항목', '제공 자료에서 근거를 확인하지 못함', '부정·상충·지원 범위 밖 표현 등으로 추가 확인 필요']) assert.ok(plan.output_content.includes(phrase));
    const result = await f.adapter.execute((await approve(f.adapter, plan)).token);
    assert.equal(await readFile(result.outputFile, 'utf8'), plan.output_content);
  }
  const guide = JSON.parse(await readFile(path.join(f.input, 'guideline.json'), 'utf8'));
  await writeFile(path.join(f.input, 'review.md'), guide.rules.map(r => r.positive_statements[0] + '.').join('\n\n'));
  const satisfied = await f.adapter.prepare(selection('convert', 'md', []));
  assert.deepEqual(satisfied.unresolved, []); assert.equal(satisfied.review_complete, true);
  assert.equal(satisfied.output_content.includes('추가 확인 필요 항목'), false);
});

test('legacy v1 output upgrades only through new approval and preserves its original bytes', async t => {
  const f = await setup(t); const sourcePlan = await f.adapter.prepare(selection());
  const legacy = { ...sourcePlan.common_document, schema_version: 1,
    unresolved: sourcePlan.unresolved.map(({ label, ...item }) => item) };
  const { body, ...metadata } = legacy;
  const oldBytes = `${body}\n\n<!-- DIANA-COMMON-V1 ${JSON.stringify(metadata)} -->\n`;
  const legacyPath = path.join(f.input, 'legacy.md'); await writeFile(legacyPath, oldBytes);
  f.config.documents.push({ id: 'LEGACY', relativePath: 'legacy.md', version: '1', rootIndex: 0, classification: 'synthetic', read_roles: ['analyst'] });
  await f.updateConfig(); const adapter = await FinancialDocuments.create({ configPath: f.configPath });
  const plan = await adapter.prepare({ ...selection('convert', 'txt', []), target_doc: 'LEGACY' });
  assert.equal(plan.common_document.schema_version, 2);
  assert.equal(plan.common_document.body, legacy.body);
  assert.deepEqual(plan.common_document.sources, legacy.sources);
  assert.equal(plan.unresolved[0].label, 'LP 자문위원회 참여권');
  assert.notEqual(digest(oldBytes), plan.approval_payload.output_hash);
  assert.equal((await outputs(f.output)).length, 0);
  const result = await adapter.execute((await approve(adapter, plan)).token);
  assert.equal(result.status, 'COMPLETED');
  assert.equal(await readFile(legacyPath, 'utf8'), oldBytes);
  assert.equal(await readFile(result.outputFile, 'utf8'), plan.output_content);
});

test('tampered notice or metadata fails explicitly and cannot be approved', async t => {
  const f = await setup(t); const plan = await f.adapter.prepare(selection());
  const variants = [plan.output_content.replace('제공 자료에서 근거를 확인하지 못함', '모든 검토 완료'),
    plan.output_content.replace('"unresolved":[{', '"unresolved":[],"other":[{'),
    plan.output_content.split('\n\n<!-- DIANA-COMMON-V2 ')[0],
    plan.output_content.replace('USD', 'CAD'),
    plan.output_content.replace('DIANA-COMMON-V2 ', 'DIANA-COMMON-V3 ')];
  for (const [index, raw] of variants.entries()) {
    const id = `TAMPERED_${index}`; const filename = `tampered-${index}.md`;
    await writeFile(path.join(f.input, filename), raw);
    f.config.documents.push({ id, relativePath: filename, version: '1', rootIndex: 0, classification: 'synthetic', read_roles: ['analyst'] });
    await f.updateConfig(); const adapter = await FinancialDocuments.create({ configPath: f.configPath });
    const result = await adapter.prepare({ ...selection('convert', 'txt', []), target_doc: id });
    assert.ok(['ACTION_REQUIRED', 'CLARIFICATION_REQUIRED'].includes(result.status), JSON.stringify(result));
    assert.equal(result.saved, false); assert.equal(Object.hasOwn(result, 'output_content'), false);
    assert.notEqual((await adapter.approve(plan.plan_id, plan.plan_hash)).reason, 'APPROVAL_ISSUED');
    assert.equal((await outputs(f.output)).length, 0);
  }
});

test('corrected file repatch is no change and current review overrides historical unresolved', async t => {
  const f = await setup(t); const first = await f.adapter.prepare(selection());
  const saved = await f.adapter.execute((await approve(f.adapter, first)).token);
  assert.equal(saved.status, 'COMPLETED');
  const oldHash = digest(await readFile(saved.outputFile));
  await cp(saved.outputFile, path.join(f.input, 'corrected.md'));
  f.config.documents.push({ id: 'CORRECTED', relativePath: 'corrected.md', version: '2', rootIndex: 0, classification: 'synthetic', read_roles: ['analyst'] });
  await f.updateConfig(); let adapter = await FinancialDocuments.create({ configPath: f.configPath });
  const initialCount = (await outputs(f.output)).length;
  const plan = await adapter.prepare({ ...selection(), target_doc: 'CORRECTED' });
  assert.equal(plan.status, 'READY'); assert.equal(plan.reason, 'ALREADY_SATISFIED'); assert.equal(plan.no_change, true);
  assert.equal(plan.saved, false); assert.equal(plan.review_complete, false);
  assert.deepEqual(plan.changes, []); assert.deepEqual(plan.common_document, first.common_document);
  assert.equal((await adapter.approve(plan.plan_id, plan.plan_hash)).status, 'ABORTED');
  assert.equal((await outputs(f.output)).length, initialCount);
  const guide = JSON.parse(await readFile(path.join(f.input, 'guideline.json'), 'utf8'));
  const stale = structuredClone(first.common_document);
  stale.body += '\n\n' + guide.rules.find(r => r.id === 'LPAC').positive_statements[0] + '.';
  await writeFile(path.join(f.input, 'stale.json'), JSON.stringify(stale));
  f.config.documents.push({ id: 'STALE', relativePath: 'stale.json', version: '2', rootIndex: 0, classification: 'synthetic', read_roles: ['analyst'] });
  await f.updateConfig(); adapter = await FinancialDocuments.create({ configPath: f.configPath });
  const fresh = await adapter.prepare({ ...selection('convert', 'md', []), target_doc: 'STALE' });
  assert.equal(fresh.review_complete, true); assert.deepEqual(fresh.unresolved, []);
  assert.equal(fresh.output_content.includes('추가 확인 필요 항목'), false);
  const result = await adapter.execute((await approve(adapter, fresh)).token);
  assert.equal(result.status, 'COMPLETED'); assert.equal(await readFile(result.outputFile, 'utf8'), fresh.output_content);
  assert.equal(digest(await readFile(saved.outputFile)), oldHash);
  // Removing status prose still cannot grant permission or create an approval.
  await writeFile(path.join(f.input, 'denied.md'), first.common_document.body);
  f.config.documents.push({ id: 'DENIED_WITHOUT_NOTICE', relativePath: 'denied.md', version: '1', rootIndex: 0, classification: 'synthetic', read_roles: [] });
  await f.updateConfig(); adapter = await FinancialDocuments.create({ configPath: f.configPath });
  const denied = await adapter.prepare({ ...selection('convert', 'md', []), target_doc: 'DENIED_WITHOUT_NOTICE' });
  assert.equal(denied.status, 'BLOCKED'); assert.equal(denied.reason, 'ACCESS_DENIED');
});
