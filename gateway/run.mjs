import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { sendWake, validateAddress, validateMac, validatePort } from './wol.mjs';

const MIN_WAKE_INTERVAL_MS = 90_000;

export function validateApiBaseUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('API_BASE_URL must be an absolute URL.'); }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.startsWith('127.'));
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('API_BASE_URL requires HTTPS; HTTP is allowed only for loopback development.');
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('API_BASE_URL must be an origin without credentials, path, query, or fragment.');
  }
  return url.origin;
}

function integerSetting(value, fallback, name, minimum, maximum = 300_000) {
  if (value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return number;
}

export function loadGatewayConfig(env = process.env) {
  const token = env.GATEWAY_TOKEN;
  if (typeof token !== 'string' || !token.trim() || /\s/.test(token)) throw new Error('Set GATEWAY_TOKEN to the gateway-only bearer token.');
  const deviceId = env.DEVICE_ID;
  if (typeof deviceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(deviceId)) {
    throw new Error('Set DEVICE_ID to the paired device identifier (letters, numbers, underscores, hyphens).');
  }
  if (!env.PC_MAC) throw new Error('Set PC_MAC locally on the gateway, including in dry-run mode.');
  const dryRunValue = String(env.WAKE_DRY_RUN ?? 'true').toLowerCase();
  if (!['true', 'false'].includes(dryRunValue)) throw new Error('WAKE_DRY_RUN must be true or false.');
  return Object.freeze({
    apiBaseUrl: validateApiBaseUrl(env.API_BASE_URL), token, deviceId,
    mac: validateMac(env.PC_MAC),
    address: validateAddress(env.WOL_BROADCAST || '255.255.255.255'),
    port: validatePort(env.WOL_PORT || 9),
    dryRun: dryRunValue === 'true',
    minWakeIntervalMs: integerSetting(env.WOL_MIN_INTERVAL_MS, MIN_WAKE_INTERVAL_MS, 'WOL_MIN_INTERVAL_MS', MIN_WAKE_INTERVAL_MS, 86_400_000),
    pollIntervalMs: integerSetting(env.GATEWAY_POLL_INTERVAL_MS, 5000, 'GATEWAY_POLL_INTERVAL_MS', 1000, 60_000),
    requestTimeoutMs: integerSetting(env.GATEWAY_REQUEST_TIMEOUT_MS, 10_000, 'GATEWAY_REQUEST_TIMEOUT_MS', 1000, 60_000),
  });
}

export function createGatewayClient(config, { fetchImpl = fetch, wake = sendWake, now = Date.now } = {}) {
  let lastAttemptAt = -Infinity;
  let pendingResult = null;
  // Suppress repeated datagrams when reporting succeeds remotely but the response is lost.
  // This cache is process-local: the API must keep completed job IDs completed after a restart.
  const completed = new Map();

  async function request(path, options = {}, signal) {
    const timeoutSignal = AbortSignal.timeout(config.requestTimeoutMs);
    const response = await fetchImpl(`${config.apiBaseUrl}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${config.token}`,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
    });
    if (!response.ok) throw new Error(`Gateway API returned HTTP ${response.status}.`);
    return response;
  }

  async function report(signal) {
    const result = pendingResult;
    await request(`/api/gateway/wake/${encodeURIComponent(result.id)}`, {
      method: 'POST', body: JSON.stringify(result.payload),
    }, signal);
    pendingResult = null;
    return { status: result.payload.status, jobId: result.id };
  }

  return {
    async pollOnce(signal) {
      // Reporting failures retry only the acknowledgement, never the wake operation.
      if (pendingResult) return report(signal);
      const response = await request('/api/gateway/wake', {}, signal);
      const data = await response.json();
      if (data?.job === null) return { status: 'idle' };
      const job = data?.job;
      if (!job || typeof job.id !== 'string' || !job.id || job.id.length > 128 || /[\u0000-\u001f\u007f]/.test(job.id)) {
        throw new Error('Gateway API returned an invalid job ID.');
      }
      if (job.deviceId !== config.deviceId) throw new Error('Wake job belongs to a different device; nothing was sent.');
      if (completed.has(job.id)) {
        pendingResult = { id: job.id, payload: completed.get(job.id) };
        return report(signal);
      }
      const elapsed = now() - lastAttemptAt;
      if (elapsed < config.minWakeIntervalMs) {
        return { status: 'cooldown', retryAfterMs: config.minWakeIntervalMs - elapsed };
      }
      lastAttemptAt = now();
      let payload;
      try {
        if (!config.dryRun) {
          // No MAC, address, port, or arbitrary commands are read from the remote job.
          await wake({ mac: config.mac, address: config.address, port: config.port });
        }
        payload = { status: config.dryRun ? 'dry_run' : 'signaled' };
      } catch {
        payload = { status: 'failed', error: 'The locally configured wake packet could not be sent.' };
      }
      completed.set(job.id, payload);
      if (completed.size > 10_000) completed.delete(completed.keys().next().value);
      pendingResult = { id: job.id, payload };
      return report(signal);
    },
  };
}

export async function runGateway(config = loadGatewayConfig(), { signal, logger = console } = {}) {
  const client = createGatewayClient(config);
  let failures = 0;
  logger.log(`Wake gateway started: device=${config.deviceId}, mode=${config.dryRun ? 'DRY RUN (no UDP)' : 'UDP enabled'}.`);
  while (!signal?.aborted) {
    let waitMs = config.pollIntervalMs;
    try {
      const result = await client.pollOnce(signal);
      failures = 0;
      if (!['idle', 'cooldown'].includes(result.status)) logger.log(`Wake result: ${result.status}.`);
    } catch (error) {
      if (signal?.aborted) break;
      failures++;
      // Bounded exponential backoff, also applied to authentication and malformed jobs.
      waitMs = Math.min(60_000, config.pollIntervalMs * 2 ** Math.min(failures, 8));
      logger.error(`Gateway request failed: ${error.message} Retrying in ${Math.round(waitMs / 1000)}s.`);
    }
    try { await delay(waitMs, undefined, { signal }); }
    catch (error) { if (signal?.aborted) break; throw error; }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const shutdown = new AbortController();
  process.once('SIGINT', () => shutdown.abort());
  process.once('SIGTERM', () => shutdown.abort());
  Promise.resolve().then(() => runGateway(loadGatewayConfig(), { signal: shutdown.signal })).catch((error) => {
    console.error(`Wake gateway stopped: ${error.message}`);
    process.exitCode = 1;
  });
}
