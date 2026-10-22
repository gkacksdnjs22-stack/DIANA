import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
const template = await readFile(new URL('.env.example', root), 'utf8');
const body = template.replace(/^(USER_TOKEN|AGENT_TOKEN|GATEWAY_TOKEN)=$/gm,
  (_, key) => `${key}=${randomBytes(32).toString('hex')}`);
await mkdir(new URL('.local/', root), { recursive: true });
try {
  await writeFile(new URL('.env', root), body, { flag: 'wx', mode: 0o600 });
  console.log('로컬 .env를 만들었습니다. 토큰은 화면에 출력하지 않습니다.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('기존 .env를 유지합니다.');
}
console.log(`설정 파일: ${fileURLToPath(new URL('.env', root))}`);
console.log('npm start / npm run agent 를 별도 터미널에서 실행하세요.');
