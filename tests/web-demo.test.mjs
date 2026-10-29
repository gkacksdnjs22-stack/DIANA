import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createControlServer } from '../lib/control.mjs';
import { before, after, initialState, transition, items, savedItems } from '../public/demo/scenario.mjs';

test('demo approval preserves the sample original and unresolved evidence gap', () => {
  const start = initialState();
  const saved = transition(start, 'approve', start.revision);
  assert.equal(start.body, before);
  assert.equal(saved.body, after);
  assert.equal(saved.phase, 'saved');
  const rechecked = transition(saved, 'recheck', saved.revision);
  assert.equal(rechecked.phase, 'rechecked');
  assert.equal(rechecked.reviewComplete, false);
  assert.equal(savedItems().filter(i => i.status === 'SATISFIED').length, 2);
  assert.equal(savedItems().find(i => i.id === 'LPAC').status, 'MISSING_NO_EVIDENCE');
  assert.equal(items.find(i => i.id === 'KEY_MAN').status, 'MISSING_WITH_EVIDENCE');
});

test('demo rejects recheck before saving and decisions after rejection', () => {
  const start = initialState();
  assert.throws(() => transition(start, 'recheck', start.revision), /DEMO_ACTION_UNAVAILABLE/);
  const rejected = transition(start, 'reject', start.revision);
  assert.equal(rejected.body, before);
  for (const action of ['approve', 'reject', 'recheck']) {
    assert.throws(() => transition(rejected, action, rejected.revision), /DEMO_ACTION_UNAVAILABLE/);
  }
});

test('reset invalidates a decision from an earlier walkthrough', () => {
  const start = initialState();
  const reset = transition(start, 'reset');
  assert.throws(() => transition(reset, 'approve', start.revision), /STALE_DEMO_ACTION/);
  const saved = transition(reset, 'approve', reset.revision);
  assert.throws(() => transition(saved, 'approve', reset.revision), /STALE_DEMO_ACTION/);
  assert.deepEqual(transition(saved, 'reset'), initialState(saved.revision + 1));
});

async function fixture(t) {
  const transferDir = await mkdtemp(join(tmpdir(), 'diana-public-demo-'));
  const owner = 'demo-user-' + 'a'.repeat(40);
  const server = createControlServer({ userToken: owner, agentToken: 'demo-pc-' + 'b'.repeat(40), gatewayToken: 'demo-gateway-' + 'c'.repeat(40), transferDir });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(transferDir, { recursive: true, force: true }); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}`, owner };
}

test('public demo serves all its resources without authentication and reuses PC styling', async t => {
  const { url } = await fixture(t);
  const response = await fetch(url + '/demo');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
  const html = await response.text();
  assert.match(html, /가상 자료/);
  assert.match(html, /실제 AI 분석이나 PC 파일 저장은 실행되지 않으며/);
  assert.equal(await (await fetch(url + '/demo/')).text(), html);
  const paths = [...new Set([...html.matchAll(/(?:href|src)="(\/[^"]*)"/g)].map(match => match[1].split('#')[0]))];
  paths.push('/demo/scenario.mjs');
  for (const path of paths) {
    const asset = await fetch(url + path);
    assert.equal(asset.status, 200, path);
    await asset.body?.cancel();
  }
  const css = await fetch(url + '/demo/pc.css');
  assert.equal(await css.text(), await readFile(new URL('../financial-documents/review-ui/review.css', import.meta.url), 'utf8'));
  for (const path of ['/demo', '/demo/demo.mjs', '/demo/scenario.mjs', '/demo/demo.css', '/demo/pc.css']) {
    const head = await fetch(url + path, { method: 'HEAD' });
    assert.equal(head.status, 200, path);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
  }
});

test('demo route does not expose the PC viewer APIs or local documents', async t => {
  const { url, owner } = await fixture(t);
  for (const path of ['/demo/review.js', '/demo/worker.json', '/demo/.env', '/demo/api/view', '/api/view', '/api/local-action', '/review.css']) {
    assert.equal((await fetch(url + path)).status, 404, path);
  }
  for (const path of ['/api/jobs', '/api/financial/tasks', '/api/agent/next']) {
    assert.equal((await fetch(url + path)).status, 401, path);
  }
  const jobs = await (await fetch(url + '/api/jobs', { headers: { Authorization: `Bearer ${owner}` } })).json();
  assert.deepEqual(jobs.jobs, []);
});
