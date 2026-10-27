import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { strictJSON, fail } from './strict-json.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const bootstrap = "import runpy,sys;sys.path.insert(0,sys.argv[1]);runpy.run_module('financial_core.interface',run_name='__main__')";

export async function verifiedPython(executable) {
  if (typeof executable !== 'string' || !path.isAbsolute(executable) || executable.startsWith('\\\\') || !/^python(?:3(?:\.\d+)?)?(?:\.exe)?$/iu.test(path.basename(executable))) fail('PYTHON_PATH_INVALID');
  const resolved = await realpath(executable); const stat = await lstat(executable);
  if (resolved !== path.resolve(executable) || !stat.isFile() || stat.isSymbolicLink()) fail('PYTHON_PATH_INVALID');
  const { stdout } = await promisify(execFile)(resolved, ['-I', '-B', '-c', 'import sys;print(sys.executable);print(sys.version_info.major)'], {
    shell: false, windowsHide: true, timeout: 10_000, maxBuffer: 4096, env: {},
  });
  const lines = stdout.trim().split(/\r?\n/u);
  if (path.resolve(lines[0]) !== resolved || lines[1] !== '3') fail('PYTHON_PATH_INVALID');
  return resolved;
}

export async function callCore(executable, payload) {
  const raw = JSON.stringify(payload);
  if (Buffer.byteLength(raw) > 2_000_000) fail('INPUT_LIMIT');
  // Fixed executable + fixed arguments. Document strings travel on stdin only.
  return new Promise((resolve, reject) => {
    const child = execFile(executable, ['-I', '-B', '-X', 'utf8', '-c', bootstrap, project], {
      shell: false, windowsHide: true, timeout: 15_000, maxBuffer: 12_000_000, env: {}, encoding: 'utf8',
    }, (error, stdout) => {
      if (error) return reject(Object.assign(new Error('CORE_EXECUTION_FAILED'), { code: 'CORE_EXECUTION_FAILED' }));
      try { resolve(strictJSON(stdout)); } catch { reject(Object.assign(new Error('CORE_RESPONSE_INVALID'), { code: 'CORE_RESPONSE_INVALID' })); }
    });
    child.stdin.on('error', () => {}); child.stdin.end(raw);
  });
}
