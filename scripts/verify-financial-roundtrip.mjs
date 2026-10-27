// Test-only local harness. Approvals here are simulated test-user approvals.
// No production CLI/config/old output/old receipt is modified.
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cp, mkdir, mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { FinancialDocuments } from '../financial-documents/adapter.mjs';
import { boundedRead } from '../financial-documents/files.mjs';
import { verifiedPython } from '../financial-documents/python.mjs';
import { digest } from '../personal-ai/documents/files.mjs';
import { strictJSON } from '../financial-documents/strict-json.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const bridge = "import sys;sys.path.insert(0,sys.argv[1]);from financial_core.schemas import loads,canonical;from financial_core.deterministic_tools import deserialize,serialize;p=loads(sys.stdin.buffer.read(2000001).decode('utf-8'));r=deserialize(p['content'],p['format']) if p['mode']=='decode' else serialize(p['common'],p['format']);sys.stdout.buffer.write(canonical(r).encode('utf-8'))";

async function commonTransport(python, payload) {
  return new Promise((resolve, reject) => {
    const child = execFile(python, ['-I', '-B', '-X', 'utf8', '-c', bridge, project], {
      shell: false, windowsHide: true, env: {}, timeout: 10_000, maxBuffer: 4_000_000,
    }, (error, stdout) => {
      if (error) return reject(new Error('COMMON_INSPECTION_FAILED'));
      // Match the adapter's detached JSON objects; text/whitespace stay exact.
      try { resolve(structuredClone(strictJSON(stdout))); } catch { reject(new Error('COMMON_INSPECTION_FAILED')); }
    });
    child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(payload));
  });
}

export async function verifyRoundtrip({ python, reference, expectedHash }) {
  const executable = await verifiedPython(python);
  assert.match(expectedHash, /^[a-f0-9]{64}$/u);
  const base = path.join(project, '.local', 'financial-roundtrip'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'run-'));
  const reportPath = path.join(root, 'report.json');
  const report = { schema_version: 1, approval_mode: 'test-harness-simulated-user',
    reference: { path: path.resolve(reference), expected_hash: expectedHash }, steps: [], probes: {}, findings: [] };
  try {
  let original;
  try { original = await boundedRead(reference); }
  catch (error) {
    report.status = error.code === 'ENOENT' ? 'REFERENCE_MISSING' : 'REFERENCE_UNREADABLE';
    report.reference_checked = false; await writeFile(reportPath, JSON.stringify(report, null, 2), { flag: 'wx' });
    return { reportPath, report };
  }
  report.reference.actual_hash = original.hash;
  if (original.hash !== expectedHash) {
    report.status = 'REFERENCE_HASH_MISMATCH'; report.reference_checked = false;
    await writeFile(reportPath, JSON.stringify(report, null, 2), { flag: 'wx' }); return { reportPath, report };
  }
  const input = path.join(root, 'input'); const output = path.join(root, 'output');
  await mkdir(input); await mkdir(output);
  await cp(reference, path.join(input, 'corrected.md'), { errorOnExist: true, force: false });
  assert.equal(digest(await readFile(path.join(input, 'corrected.md'))), expectedHash);
  const baseline = await commonTransport(executable, { mode: 'decode', content: original.content, format: 'md' });
  const fixtureRoot = path.join(project, 'financial-documents', 'fixtures', 'fund-a');
  for (const filename of ['due-diligence.txt', 'guideline.json']) await cp(path.join(fixtureRoot, filename), path.join(input, filename));
  const guide = JSON.parse(await readFile(path.join(input, 'guideline.json'), 'utf8'));
  const ddHash = digest(await readFile(path.join(input, 'due-diligence.txt')));
  const copiedHashes = { 'corrected.md': expectedHash, 'due-diligence.txt': ddHash,
    'guideline.json': digest(await readFile(path.join(input, 'guideline.json'))) };
  for (const source of baseline.sources) {
    assert.equal(source.doc_id, 'DD_A'); assert.equal(source.hash, ddHash); assert.equal(source.version, '1');
  }
  const configPath = path.join(root, 'config.json');
  const entry = (id, relativePath, version = '1') => ({ id, relativePath, version, rootIndex: 0,
    classification: baseline.classification, read_roles: ['analyst'] });
  const config = { schema_version: 1, principal: 'roundtrip-test-user', role: 'analyst',
    readRoots: [input], outputRoot: output, python: executable, write_roles: ['analyst'], approval_ttl_ms: 300_000,
    documents: [entry('CORRECTED_REVIEW', 'corrected.md'), entry('DD_A', 'due-diligence.txt'), entry('PE-02', 'guideline.json')] };
  const update = () => writeFile(configPath, JSON.stringify(config, null, 2)); await update();
  const create = () => FinancialDocuments.create({ configPath });
  const operation = (target_doc, action = 'checklist_review', format = 'md', item_ids = []) => ({
    action, target_doc, source_ids: ['DD_A'], guideline_id: 'PE-02', format, item_ids });
  const compact = r => ({ status: r.status, reason: r.reason, review_complete: r.review_complete,
    items: r.items?.map(i => ({ item_id: i.item_id, status: i.status })), unresolved: r.unresolved, changes: r.changes?.length });
  function assertReview(result, target) {
    assert.deepEqual(result.items.map(i => i.status), ['SATISFIED', 'SATISFIED', 'MISSING_NO_EVIDENCE']);
    assert.equal(result.review_complete, false);
    const key = result.items.find(i => i.item_id === 'KEY_MAN');
    assert.ok(key.review_references.some(r => r.doc_id === target && r.quote === baseline.sources[0].quote));
    const lp = result.items.find(i => i.item_id === 'LPAC');
    assert.equal(lp.review_references.length, 0); assert.equal(lp.candidates.length, 0);
  }
  let adapter = await create();
  const reviewed = await adapter.prepare(operation('CORRECTED_REVIEW')); assertReview(reviewed, 'CORRECTED_REVIEW');
  report.reference_review = compact(reviewed);
  const repatch = await adapter.prepare(operation('CORRECTED_REVIEW', 'patch', 'md', ['KEY_MAN']));
  report.repatch = compact(repatch);
  if (repatch.reason !== 'ALREADY_SATISFIED' || repatch.status !== 'READY' || repatch.changes?.length !== 0) {
    report.findings.push({ category: 'patch-result', code: 'SATISFIED_ITEM_HAS_NO_EXPLICIT_NO_CHANGE_RESULT', actual_reason: repatch.reason });
  }
  assert.notEqual((await adapter.approve(repatch.plan_id, repatch.plan_hash)).reason, 'APPROVAL_ISSUED');
  assert.equal((await readdir(output)).filter(f => /\.(md|txt|json)$/u.test(f)).length, 0);
  const stepTargets = new Map();
  const routes = [
    ['01-md-to-txt', 'CORRECTED_REVIEW', 'txt'], ['02-md-to-json', 'CORRECTED_REVIEW', 'json'],
    ['03-md-to-md', 'CORRECTED_REVIEW', 'md'], ['04-json-to-md', '02-md-to-json', 'md'],
    ['05-txt-to-json', '01-md-to-txt', 'json'], ['06-txt-json-to-md', '05-txt-to-json', 'md'],
  ];
  const retained = [];
  for (const [name, from, format] of routes) {
    const target = stepTargets.get(from) || from;
    adapter = await create(); const beforeCount = (await readdir(output)).length;
    const plan = await adapter.prepare(operation(target, 'convert', format));
    assert.equal(plan.status, 'AWAITING_APPROVAL');
    assert.deepEqual(plan.common_document, baseline);
    assert.equal(plan.plan_hash, digest(plan.canonical_payload));
    assert.equal(JSON.parse(plan.canonical_payload).output_content, plan.output_content);
    assert.equal(plan.approval_payload.output_hash, digest(plan.output_content));
    assert.equal((await readdir(output)).length, beforeCount);
    assert.equal((await adapter.execute({ confirmed: true })).reason, 'UNKNOWN_OR_USED_APPROVAL');
    const approved = await adapter.approve(plan.plan_id, plan.plan_hash);
    assert.equal((await readdir(output)).length, beforeCount);
    const saved = await adapter.execute(approved.token);
    assert.equal(saved.status, 'COMPLETED'); assert.equal(saved.storage_verified, true);
    const actual = await boundedRead(saved.outputFile); assert.equal(actual.content, plan.output_content);
    assert.equal(actual.hash, saved.output_hash);
    const decoded = await commonTransport(executable, { mode: 'decode', content: actual.content, format });
    assert.deepEqual(decoded, baseline); // exact strings/quotes/newlines; no normalization
    assert.equal(new Set(decoded.sources.map(s => JSON.stringify(s))).size, decoded.sources.length);
    assert.equal(decoded.body.split('## 보완 KEY_MAN').length - 1, 1);
    if (format !== 'json') {
      assert.equal(actual.content.split('DIANA-COMMON-V2 ').length - 1, 1);
      assert.equal(actual.content.split(format === 'md' ? '<!-- DIANA-STATUS-V1 -->' : '[DIANA-STATUS-V1]').length - 1, 1);
    }
    retained.push([saved.outputFile, actual.hash]);
    const id = `ROUND_${report.steps.length + 1}`; const filename = `${name}.${format}`;
    await cp(saved.outputFile, path.join(input, filename)); assert.equal(digest(await readFile(path.join(input, filename))), actual.hash);
    config.documents.push(entry(id, filename, '2')); await update(); stepTargets.set(name, id);
    const again = await (await create()).prepare(operation(id)); assertReview(again, id);
    report.steps.push({ route: name, source_doc: target, target_doc: id, output_file: saved.outputFile,
      output_hash: actual.hash, parsed_common_equal: true, preview_bytes_equal: true, storage_verified: true,
      notice_count: format === 'json' ? 0 : 1, key_man_appendix_count: 1, source_count: decoded.sources.length, review: compact(again) });
  }
  // Separate synthetic probes; never alter the user's business document.
  async function probe(name, common, action = 'checklist_review', items = []) {
    const filename = `${name}.json`; await writeFile(path.join(input, filename), JSON.stringify(common), { flag: 'wx' });
    const id = name.toUpperCase().replaceAll('-', '_'); config.documents.push(entry(id, filename)); await update();
    return (await create()).prepare(operation(id, action, 'md', items));
  }
  const completedBody = structuredClone(baseline);
  completedBody.body += '\n\n' + guide.rules.find(r => r.id === 'LPAC').positive_statements[0] + '.';
  const stale = await probe('stale-unresolved', completedBody);
  report.probes.stale_unresolved = { fixture: 'synthetic-business-addition-with-old-metadata', ...compact(stale) };
  assert.equal(stale.items.find(i => i.item_id === 'LPAC').status, 'SATISFIED');
  if (stale.unresolved.length !== 0) report.findings.push({ category: 'metadata-roundtrip', code: 'STALE_UNRESOLVED_SURVIVES_CURRENT_SATISFIED_VERDICT' });
  const missingBody = structuredClone(baseline);
  missingBody.body = missingBody.body.replace(baseline.sources[0].quote, '');
  const metaOnly = await probe('metadata-only-key', missingBody, 'patch', ['KEY_MAN']);
  report.probes.metadata_only_key = { fixture: 'synthetic-business-removal-retaining-citation-metadata', ...compact(metaOnly), source_count: metaOnly.common_document.sources.length };
  assert.equal(metaOnly.items.find(i => i.item_id === 'KEY_MAN').status, 'MISSING_WITH_EVIDENCE');
  if (new Set(metaOnly.common_document.sources.map(s => JSON.stringify(s))).size !== metaOnly.common_document.sources.length) {
    report.findings.push({ category: 'source-duplication', code: 'SAME_SOURCE_OBJECT_ADDED_AGAIN' });
  }
  const noOldAnswers = structuredClone(baseline); noOldAnswers.unresolved = [];
  const fresh = await probe('empty-old-unresolved', noOldAnswers);
  assert.equal(fresh.items.find(i => i.item_id === 'LPAC').status, 'MISSING_NO_EVIDENCE');
  assert.equal(fresh.unresolved.find(i => i.item_id === 'LPAC').status, 'MISSING_NO_EVIDENCE');
  report.probes.empty_old_unresolved = compact(fresh);
  const legacy = { ...baseline, schema_version: 1, unresolved: baseline.unresolved.map(({ label, ...i }) => i) };
  const legacyRaw = await commonTransport(executable, { mode: 'encode', common: legacy, format: 'md' });
  await writeFile(path.join(input, 'legacy-v1.md'), legacyRaw, { flag: 'wx' });
  config.documents.push(entry('LEGACY_V1', 'legacy-v1.md')); await update(); adapter = await create();
  const upgrade = await adapter.prepare(operation('LEGACY_V1', 'convert', 'md'));
  assert.deepEqual(upgrade.common_document, baseline);
  const upgraded = await adapter.execute((await adapter.approve(upgrade.plan_id, upgrade.plan_hash)).token);
  assert.equal(upgraded.status, 'COMPLETED');
  assert.equal(await readFile(path.join(input, 'legacy-v1.md'), 'utf8'), legacyRaw);
  const rereadLegacy = await boundedRead(upgraded.outputFile);
  assert.deepEqual(await commonTransport(executable, { mode: 'decode', content: rereadLegacy.content, format: 'md' }), baseline);
  await cp(upgraded.outputFile, path.join(input, 'legacy-upgraded.md'));
  config.documents.push(entry('LEGACY_UPGRADED', 'legacy-upgraded.md', '2')); await update();
  const legacyReview = await (await create()).prepare(operation('LEGACY_UPGRADED'));
  assertReview(legacyReview, 'LEGACY_UPGRADED');
  report.v1_compatibility = { input_version: 1, output_version: 2, output_file: upgraded.outputFile, output_hash: rereadLegacy.hash, source_unchanged: true };
  for (const [file, hash] of retained) assert.equal(digest(await readFile(file)), hash);
  for (const [file, hash] of Object.entries(copiedHashes)) {
    assert.equal(digest(await readFile(path.join(input, file))), hash);
    if (file !== 'corrected.md') assert.equal(digest(await readFile(path.join(fixtureRoot, file))), hash);
  }
  assert.equal((await boundedRead(reference)).hash, expectedHash);
  report.reference_checked = true; report.reference_unchanged = true;
  report.original_fixture_unchanged = true; report.config_path = configPath;
  report.status = report.findings.length ? 'FINDINGS_RECORDED' : 'VERIFIED';
  await writeFile(reportPath, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
  return { reportPath, report };
  } catch (error) {
    report.status = 'VERIFICATION_FAILED';
    report.failure = { code: error.code || 'HARNESS_OR_ASSERTION_FAILED', completed_steps: report.steps.length };
    await writeFile(reportPath, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
    return { reportPath, report };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2); const opts = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--python', '--reference', '--expected-sha256'].includes(args[i]) || !args[i + 1] || opts[args[i]]) throw new Error('INVALID_ARGUMENTS');
    opts[args[i]] = args[i + 1];
  }
  verifyRoundtrip({ python: opts['--python'], reference: opts['--reference'], expectedHash: opts['--expected-sha256'] })
    .then(({ reportPath, report }) => {
      console.log(JSON.stringify({ status: report.status, reportPath, findings: report.findings, steps: report.steps.map(s => ({ route: s.route, output_file: s.output_file })) }, null, 2));
      if (report.status !== 'VERIFIED') process.exitCode = 1;
    }).catch(() => { console.error('ROUNDTRIP_VERIFICATION_FAILED'); process.exitCode = 1; });
}
