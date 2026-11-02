import { readFile, open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AdminAuth } from './auth.mjs';

// Secrets are accepted from a file and written exclusively to a file, never argv/stdout.
const root = resolve(import.meta.dirname, 'test-data');
const auth = new AdminAuth({ dbPath: resolve(root, 'service.sqlite') });
let output;
const out = resolve(root, 'operator-result.json');
try {
  const action = process.argv[2];
  if (!['bootstrap','recover'].includes(action)) throw Error();
  output = await open(out, 'wx', 0o600);
  let result;
  if (action === 'bootstrap') result = auth.bootstrap();
  else if (action === 'recover') {
    const input = JSON.parse(await readFile(resolve(root, 'recovery-input.json'), 'utf8'));
    result = auth.recoverOffline(input.userId, input.code);
  } else throw Error();
  await output.writeFile(JSON.stringify(result)); await output.sync();
  auth.audit(action, true);
  console.log('완료: test-data/operator-result.json을 로컬에서 확인하세요.');
} catch {
  if (output) { await output.close(); output = null; await unlink(out); }
  console.error('작업 거부. 기존 출력 파일, 등록 상태 또는 복구 조건을 확인하세요.'); process.exitCode = 1;
} finally { if (output) await output.close(); auth.close(); }
