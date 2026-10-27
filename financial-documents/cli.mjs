import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { mkdir, writeFile } from 'node:fs/promises';
import { FinancialDocuments } from './adapter.mjs';
import { verifiedPython } from './python.mjs';
import { fail } from './strict-json.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
function options(args) {
  const result = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!/^--[a-z-]+$/u.test(args[i]) || !args[i + 1] || args[i + 1].startsWith('--') || Object.hasOwn(result, args[i].slice(2))) fail('INVALID_ARGUMENTS');
    result[args[i].slice(2)] = args[i + 1];
  }
  return result;
}

export async function initDemo(python) {
  const executable = await verifiedPython(python);
  const outputRoot = path.join(project, '.local', 'financial-demo-output');
  const configRoot = path.join(project, '.local', 'financial-demo-settings');
  // Setup writes settings only. Source fixtures are immutable repository files.
  await mkdir(configRoot, { recursive: true, mode: 0o700 });
  const configPath = path.join(configRoot, 'config.json');
  const documents = [
    ['REVIEW_A', 'review.md'], ['DD_A', 'due-diligence.txt'], ['PE-02', 'guideline.json'],
  ].map(([id, relativePath]) => ({ id, relativePath, rootIndex: 0, version: '1', classification: 'synthetic', read_roles: ['analyst'] }));
  await writeFile(configPath, JSON.stringify({ schema_version: 1, principal: 'local-demo-user', role: 'analyst',
    readRoots: [path.join(project, 'financial-documents', 'fixtures', 'fund-a')], outputRoot,
    python: executable, write_roles: ['analyst'], documents, approval_ttl_ms: 300_000 }, null, 2), { flag: 'wx', mode: 0o600 });
  return configPath;
}

export async function main(args = process.argv.slice(2)) {
  const opts = options(args);
  if (Object.keys(opts).some(k => !['config', 'action', 'target', 'sources', 'guideline', 'items', 'format', 'init-demo'].includes(k))) fail('INVALID_ARGUMENTS');
  if (opts['init-demo']) {
    stdout.write(`설정 생성: ${await initDemo(opts['init-demo'])}\n`);
    return;
  }
  if (!opts.config) fail('MISSING_CONFIG');
  const adapter = await FinancialDocuments.create({ configPath: opts.config });
  const io = createInterface({ input: stdin, output: stdout });
  let last;
  const run = async values => {
    const selection = { action: values.action, target_doc: values.target, source_ids: (values.sources || '').split(',').filter(Boolean),
      guideline_id: values.guideline, item_ids: (values.items || '').split(',').filter(Boolean), format: values.format };
    last = await adapter.prepare(selection);
    const preview = last.plan_hash ? Object.fromEntries(['status', 'reason', 'inference_mode', 'plan_id', 'plan_hash',
      'items', 'changes', 'expected_body', 'output_content', 'unified_diff', 'retained_items', 'unresolved',
      'saved', 'review_complete', 'all_items_addressed'].map(key => [key, last[key]])) : last;
    stdout.write(JSON.stringify(preview, null, 2) + '\n');
    if (last.status === 'AWAITING_APPROVAL') stdout.write(`수정안·출처·Diff를 검토한 뒤 /approve ${last.plan_hash}\n`);
  };
  try {
    stdout.write('DIANA 가상 실사 MVP · inference_mode=explicit · 외부 API 미연결\n');
    stdout.write(JSON.stringify(await adapter.candidates()) + '\n');
    if (opts.action) await run(opts);
    stdout.write('/review, /patch, /convert 뒤 --target ID --sources ID,ID --guideline ID --items ID --format md|txt|json\n/cancel · /exit\n');
    while (true) {
      let line;
      try { line = (await io.question('finance> ')).trim(); } catch { break; }
      if (line === '/exit') break;
      if (line === '/cancel') { stdout.write(JSON.stringify(await adapter.cancel()) + '\n'); last = null; continue; }
      if (line.startsWith('/approve ')) {
        const hash = line.slice(9).trim();
        if (!last || last.status !== 'AWAITING_APPROVAL' || last.plan_hash !== hash) { stdout.write('승인할 현재 계획 해시가 일치하지 않습니다.\n'); continue; }
        const approved = await adapter.approve(last.plan_id, hash);
        stdout.write(JSON.stringify(approved.token ? await adapter.execute(approved.token) : approved, null, 2) + '\n');
        last = null; continue;
      }
      const [command, ...rest] = line.split(/\s+/u);
      const action = { '/review': 'checklist_review', '/patch': 'patch', '/convert': 'convert', '/export': 'export' }[command];
      if (!action) { stdout.write('지원하는 명시적 작업을 선택하세요.\n'); continue; }
      try {
        const values = options(rest);
        if (Object.keys(values).some(k => !['target', 'sources', 'guideline', 'items', 'format'].includes(k))) fail('INVALID_ARGUMENTS');
        await run({ ...values, action });
      } catch (error) { stdout.write(`${/^[A-Z_]+$/u.test(error.code || '') ? error.code : 'INVALID_ARGUMENTS'}\n`); }
    }
  } finally { adapter.cancelPending(); io.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(/^[A-Z_]+$/u.test(error.code || '') ? error.code : 'CLI_FAILED'); process.exitCode = 1; });
}
