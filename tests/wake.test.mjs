import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { once } from 'node:events';
import { createMagicPacket, sendWake, validateMac, validateAddress, validatePort } from '../gateway/wol.mjs';
import { createGatewayClient, loadGatewayConfig, validateApiBaseUrl } from '../gateway/run.mjs';

const MAC = '02:12:34:56:78:9a';
const env = () => ({ API_BASE_URL: 'http://127.0.0.1:8787', GATEWAY_TOKEN: 'test-gateway-only-token', DEVICE_ID: 'home-pc', PC_MAC: MAC });
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('magic packet contains six FF octets followed by exactly sixteen MAC repetitions', () => {
  const packet = createMagicPacket(MAC);
  assert.equal(packet.length, 102);
  assert.deepEqual(packet.subarray(0, 6), Buffer.alloc(6, 0xff));
  for (let repeat = 0; repeat < 16; repeat++) {
    assert.deepEqual(packet.subarray(6 + 6 * repeat, 12 + 6 * repeat), Buffer.from('02123456789a', 'hex'));
  }
  assert.deepEqual(createMagicPacket('02-12-34-56-78-9A'), packet);
  assert.deepEqual(createMagicPacket('02123456789A'), packet);
  assert.equal(validateMac(' 02:12:34:56:78:9A '), MAC);
});

test('malformed, unspecified, broadcast, and multicast MACs are rejected', () => {
  for (const mac of [undefined, null, 1234, '', '02:12:34:56:78', '02:12:34:56:78:ZZ', '02-12:34:56:78:9a', '000000000000', 'ff:ff:ff:ff:ff:ff', '01:12:34:56:78:9a']) {
    assert.throws(() => createMagicPacket(mac), TypeError);
  }
});

test('wake targets accept IPv4 literals and bounded integer ports only', () => {
  assert.equal(validateAddress('255.255.255.255'), '255.255.255.255');
  assert.equal(validateAddress('192.168.1.255'), '192.168.1.255');
  assert.equal(validatePort('9'), 9);
  for (const address of ['localhost', 'example.com', '::1', '0.0.0.0', '224.0.0.1', '999.1.1.1', '127.0.0.1/path']) {
    assert.throws(() => validateAddress(address), TypeError);
  }
  for (const port of [0, -1, 65536, 1.5, '', '9.5', '9;command', undefined]) assert.throws(() => validatePort(port), TypeError);
});

test('UDP sends exactly one valid packet to loopback; no broadcast or external network is used', async (t) => {
  const receiver = dgram.createSocket('udp4');
  receiver.bind(0, '127.0.0.1');
  await once(receiver, 'listening');
  t.after(() => receiver.close());
  const received = once(receiver, 'message', { signal: AbortSignal.timeout(3000) });
  const result = await sendWake({ mac: MAC, address: '127.0.0.1', port: receiver.address().port });
  const [packet, remote] = await received;
  assert.deepEqual(packet, createMagicPacket(MAC));
  assert.equal(remote.address, '127.0.0.1');
  assert.equal(result.bytes, 102);
});

test('API origins allow HTTPS and loopback HTTP, reject remote HTTP and embedded credentials', () => {
  for (const url of ['https://api.example.com', 'http://127.0.0.1:8787', 'http://localhost:8787', 'http://[::1]:8787']) {
    assert.equal(validateApiBaseUrl(url), new URL(url).origin);
  }
  for (const url of ['http://api.example.com', 'http://192.168.1.5', 'ftp://localhost', 'https://user:password@example.com', 'https://example.com/api', 'https://example.com?token=x', 'https://example.com#fragment', undefined]) {
    assert.throws(() => validateApiBaseUrl(url));
  }
});

test('gateway defaults to dry run and never permits a wake interval below ninety seconds', () => {
  const config = loadGatewayConfig(env());
  assert.equal(config.dryRun, true);
  assert.equal(config.minWakeIntervalMs, 90_000);
  assert.equal(loadGatewayConfig({ ...env(), WAKE_DRY_RUN: 'false' }).dryRun, false);
  assert.throws(() => loadGatewayConfig({ ...env(), WOL_MIN_INTERVAL_MS: '89999' }));
  assert.throws(() => loadGatewayConfig({ ...env(), WAKE_DRY_RUN: '0' }));
  assert.throws(() => loadGatewayConfig({ ...env(), PC_MAC: '' }), /Set PC_MAC/);
});

test('dry run acknowledges a job without calling the UDP sender', async () => {
  const calls = [];
  let wakes = 0;
  const client = createGatewayClient(loadGatewayConfig(env()), {
    wake: async () => wakes++,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(options.method === 'POST' ? { ok: true } : { job: { id: 'wake-1', deviceId: 'home-pc' } });
    },
  });
  assert.deepEqual(await client.pollOnce(), { status: 'dry_run', jobId: 'wake-1' });
  assert.equal(wakes, 0);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-gateway-only-token');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[1].url, 'http://127.0.0.1:8787/api/gateway/wake/wake-1');
  assert.deepEqual(JSON.parse(calls[1].options.body), { status: 'dry_run' });
});

test('only locally configured wake targets are used and new jobs observe the ninety-second cooldown', async () => {
  let time = 0;
  let jobId = 'wake-1';
  const targets = [];
  const client = createGatewayClient(loadGatewayConfig({ ...env(), WAKE_DRY_RUN: 'false', WOL_BROADCAST: '192.168.1.255' }), {
    now: () => time,
    wake: async (target) => targets.push(target),
    fetchImpl: async (_url, options) => jsonResponse(options.method === 'POST' ? { ok: true } : {
      job: { id: jobId, deviceId: 'home-pc', mac: 'aa:bb:cc:dd:ee:ff', address: '203.0.113.1', port: 123 },
    }),
  });
  assert.equal((await client.pollOnce()).status, 'signaled');
  assert.deepEqual(targets, [{ mac: MAC, address: '192.168.1.255', port: 9 }]);
  jobId = 'wake-2';
  time = 89_999;
  assert.deepEqual(await client.pollOnce(), { status: 'cooldown', retryAfterMs: 1 });
  assert.equal(targets.length, 1);
  time = 90_000;
  assert.equal((await client.pollOnce()).status, 'signaled');
  assert.equal(targets.length, 2);
});

test('a failed result acknowledgement is retried without sending another wake packet', async () => {
  let wakes = 0;
  let gets = 0;
  let posts = 0;
  const client = createGatewayClient(loadGatewayConfig({ ...env(), WAKE_DRY_RUN: 'false' }), {
    wake: async () => wakes++,
    fetchImpl: async (_url, options) => {
      if (options.method === 'POST') {
        posts++;
        return jsonResponse({ ok: posts > 1 }, posts === 1 ? 503 : 200);
      }
      gets++;
      return jsonResponse({ job: { id: 'wake-1', deviceId: 'home-pc' } });
    },
  });
  await assert.rejects(client.pollOnce(), /HTTP 503/);
  assert.equal((await client.pollOnce()).status, 'signaled');
  // A repeated completed job is acknowledged again; the operation remains idempotent.
  assert.equal((await client.pollOnce()).status, 'signaled');
  assert.equal(wakes, 1);
  assert.equal(posts, 3);
  assert.equal(gets, 2);
});

test('wrong-device jobs are rejected before any wake or acknowledgement', async () => {
  let wakes = 0;
  let posts = 0;
  const client = createGatewayClient(loadGatewayConfig({ ...env(), WAKE_DRY_RUN: 'false' }), {
    wake: async () => wakes++,
    fetchImpl: async (_url, options) => {
      if (options.method === 'POST') posts++;
      return jsonResponse({ job: { id: 'wake-1', deviceId: 'someone-else' } });
    },
  });
  await assert.rejects(client.pollOnce(), /different device/);
  assert.equal(wakes, 0);
  assert.equal(posts, 0);
});

test('a local sender error is reported as failed and is not repeated for the same job', async () => {
  const reports = [];
  let wakes = 0;
  const client = createGatewayClient(loadGatewayConfig({ ...env(), WAKE_DRY_RUN: 'false' }), {
    wake: async () => { wakes++; throw new Error('local socket problem'); },
    fetchImpl: async (_url, options) => {
      if (options.method === 'POST') { reports.push(JSON.parse(options.body)); return jsonResponse({ ok: true }); }
      return jsonResponse({ job: { id: 'wake-1', deviceId: 'home-pc' } });
    },
  });
  assert.equal((await client.pollOnce()).status, 'failed');
  assert.equal((await client.pollOnce()).status, 'failed');
  assert.equal(wakes, 1);
  assert.deepEqual(reports[0], { status: 'failed', error: 'The locally configured wake packet could not be sent.' });
});
