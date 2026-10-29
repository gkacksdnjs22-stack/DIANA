import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createControlServer } from '../lib/control.mjs';

const APK = '/downloads/DIANA-0.3.9.apk';
const APK_HASH = '3535ec96209c2af6c0d081b5c00ac5335e630b5b6e746f701d99d50001672c00';
const owner = 'landing-test-owner-' + 'a'.repeat(32);

async function fixture(t) {
  const server = createControlServer({ userToken: owner, agentToken: 'pc-' + 'b'.repeat(40), gatewayToken: 'gateway-' + 'c'.repeat(40) });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

test('public home assets and APK work without a token; page links have real targets', async t => {
  const { url } = await fixture(t);
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
  const html = await response.text();
  assert.match(html, /<title>DIANA/);
  assert.doesNotMatch(html, /<script|<form|id="token"/);
  const paths = [...new Set([...html.matchAll(/(?:href|src)="(\/[^"]*)"/g)].map(match => match[1]))];
  for (const path of paths) { const asset = await fetch(url + path); assert.equal(asset.status, 200, path); await asset.body?.cancel(); }
  for (const [, id] of html.matchAll(/href="#([^"]+)"/g)) assert(html.includes(`id="${id}"`), `missing anchor: ${id}`);
  const jobs = await fetch(url + '/api/jobs', { headers: { Authorization: `Bearer ${owner}` } });
  assert.equal(jobs.status, 200);
  assert.deepEqual((await jobs.json()).jobs, [], 'visits and downloads must not enqueue PC work');
});

test('download returns the exact signed APK with explicit filename and correct HEAD response', async t => {
  const { url } = await fixture(t);
  const response = await fetch(url + APK);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/vnd.android.package-archive');
  assert.equal(response.headers.get('content-disposition'), 'attachment; filename="DIANA-0.3.9.apk"');
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.length, 4226534);
  assert.equal(response.headers.get('content-length'), String(bytes.length));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), APK_HASH);
  const head = await fetch(url + APK, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(bytes.length));
  assert.equal((await head.arrayBuffer()).byteLength, 0);
});

test('existing web console and its original scripts remain available separately', async t => {
  const { url } = await fixture(t);
  const consolePage = await fetch(url + '/console');
  assert.equal(consolePage.status, 200);
  assert.equal(await consolePage.text(), await readFile(new URL('../public/console.html', import.meta.url), 'utf8'));
  for (const path of ['/app.js', '/style.css']) assert.equal((await fetch(url + path)).status, 200);
});

test('public downloads do not expose protected jobs, settings, or arbitrary local files', async t => {
  const { url } = await fixture(t);
  for (const path of ['/api/jobs', '/api/financial/tasks', '/api/phone/devices', '/api/agent/next']) {
    assert.equal((await fetch(url + path)).status, 401, path);
  }
  for (const path of ['/.env', '/downloads/worker.json', '/downloads/DIANA-PC.exe', '/diana-logo.png/extra']) {
    const response = await fetch(url + path);
    assert.equal(response.status, 404, path);
  }
  const health = await fetch(url + '/api/health');
  assert.deepEqual(await health.json(), { ok: true, persistence: 'sqlite-local' });
});

test('Windows ZIP streams exact verified bytes and HEAD metadata without a PC job', async t => {
  const { url } = await fixture(t);
  const releases = await (await fetch(url + '/downloads/releases.json')).json();
  const { path, sha256, bytes } = releases.windows;
  const head = await fetch(url + path, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-type'), 'application/zip');
  assert.equal(head.headers.get('content-disposition'), 'attachment; filename="'+path.split('/').at(-1)+'"');
  assert.equal(head.headers.get('content-length'), String(bytes));
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const download = await fetch(url + path);
  const digest = createHash('sha256'); let length = 0;
  for await (const chunk of download.body) { digest.update(chunk); length += chunk.length; }
  assert.equal(length, bytes); assert.equal(digest.digest('hex'), sha256);
  const abandoned = await fetch(url + path); await abandoned.body.cancel();
  assert.equal((await fetch(url + '/api/health')).status, 200);
});
