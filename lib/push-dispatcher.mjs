import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
const HASH = /^[a-f0-9]{64}$/;
const KEY = 'phonePushOutboxV1';
const SAFE_CODES = new Set(['FIREBASE_AUTH','FIREBASE_TRANSPORT','FIREBASE_RESPONSE','FIREBASE_SEND','FIREBASE_TOKEN']);

/** Only complete, unexpired relay files can cause a generic ready notification. */
export function readyPushKeys(jobs, now) {
  const keys = [];
  for (const job of jobs) {
    if (job.kind === 'upload') continue;
    const overnight = job.kind === 'overnight';
    if (!(overnight ? ['awaiting_phone','download_ready','deadline_exceeded'] : ['download_ready','dry_run','submitted','send_unknown']).includes(job.state)) continue;
    if (!overnight && !['download','both'].includes(job.request?.delivery)) continue;
    const created = Date.parse(overnight ? job.completedAt : job.artifact?.createdAt);
    if (!Number.isFinite(created) || now - created >= 24 * 3600_000 || job.artifactsExpired || job.artifact?.expired) continue;
    const files = overnight ? job.artifacts : [job.artifact];
    if (!Array.isArray(files) || !files.length || files.some(file => !HASH.test(file?.sha256 || '') || !Number.isSafeInteger(file.bytes) || file.bytes < 1)) continue;
    keys.push(hash(JSON.stringify([job.id, files.map(file => file.sha256)])));
  }
  return [...new Set(keys)];
}

/** Persistent per-registration receipts. A push only starts an idempotent file sync. */
export function createPushDispatcher({ db, allJobs, sender, now = Date.now, pollMs = 15_000 }) {
  let running = null, closed = false;
  const read = () => {
    const row = db.prepare('SELECT value FROM settings WHERE key=?').get(KEY);
    return row ? JSON.parse(row.value) : { version:1, phones:{} };
  };
  const write = value => db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(KEY, JSON.stringify(value));
  const phones = () => db.prepare('SELECT id,fcm_token FROM phone_devices WHERE revoked_at IS NULL AND fcm_token IS NOT NULL').all();
  async function work() {
    if (!sender || closed) return;
    await db.recover?.();
    if (closed) return;
    const keys = readyPushKeys(allJobs(), now()), keep = new Set(keys);
    const ledger = read(), devices = phones(), liveIds = new Set(devices.map(phone => phone.id));
    for (const id of Object.keys(ledger.phones)) if (!liveIds.has(id)) delete ledger.phones[id];
    // Server state and file publication must be durable before notifying a device.
    await db.flush?.();
    for (const phone of devices) {
      if (closed) return;
      if (typeof phone.fcm_token !== 'string' || !phone.fcm_token || phone.fcm_token.length > 4096) continue;
      const registration = hash(phone.fcm_token);
      const previous = ledger.phones[phone.id];
      const entry = previous?.registration === registration ? previous : { registration, notified:[], attempts:0, nextAt:0 };
      entry.notified = entry.notified.filter(key => keep.has(key));
      ledger.phones[phone.id] = entry;
      const pending = keys.filter(key => !entry.notified.includes(key));
      if (!pending.length || entry.nextAt > now()) continue;
      const current = db.prepare('SELECT fcm_token,revoked_at FROM phone_devices WHERE id=?').get(phone.id);
      if (!current || current.revoked_at || current.fcm_token !== phone.fcm_token) continue;
      try {
        const result = await sender.send(phone.fcm_token);
        if (!result?.accepted) throw Object.assign(new Error('Push was not accepted.'), { code:'FIREBASE_SEND' });
        if (closed) return;
        entry.notified = [...new Set([...entry.notified, ...pending])];
        entry.attempts = 0; entry.nextAt = 0; delete entry.errorCode;
      } catch (error) {
        if (closed) return;
        if (error.unregistered === true) {
          // Do not clear a fresh registration that arrived while this send was pending.
          db.prepare('UPDATE phone_devices SET fcm_token=NULL WHERE fcm_token=? AND id=?').run(phone.fcm_token, phone.id);
          delete ledger.phones[phone.id];
        } else {
          entry.attempts = Math.min((entry.attempts || 0) + 1, 7);
          entry.nextAt = now() + Math.min(5 * 60_000, 5000 * 2 ** (entry.attempts - 1));
          entry.errorCode = SAFE_CODES.has(error.code) ? error.code : 'FIREBASE_SEND';
        }
      }
      write(ledger);
      await db.flush?.();
    }
  }
  function drain() {
    if (running) return running;
    running = work().finally(() => { running = null; });
    return running;
  }
  const kick = () => { if (!closed && sender) void drain().catch(() => {}); };
  const timer = sender && pollMs > 0 ? setInterval(kick, pollMs) : null;
  timer?.unref();
  return { drain, kick,
    status() { return { configured:Boolean(sender), registeredPhones:phones().length }; },
    close() { closed = true; if (timer) clearInterval(timer); },
  };
}
