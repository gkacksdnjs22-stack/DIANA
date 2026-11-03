/** Internal worker; no public cleanup endpoint and no token/identifier logging. */
export async function startSessionCleanup(auth, {
  intervalMs = 60_000,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  onError = () => {},
  onCleanup = () => {},
} = {}) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000) throw Error('CLEANUP_INTERVAL_INVALID');
  let stopped = false, running;
  const sweep = () => {
    if (stopped) return Promise.resolve();
    if (running) return running;
    running = Promise.resolve().then(() => auth.cleanupExpired()).then(onCleanup).catch(() => {
      // Neither database error messages nor authentication data leave this worker.
      try { onError(); } catch {}
    }).finally(() => { running = undefined; });
    return running;
  };
  await sweep();
  const timer = setIntervalFn(() => void sweep(), intervalMs);
  timer.unref?.();
  return {async stop() { stopped = true; clearIntervalFn(timer); await running; }};
}
