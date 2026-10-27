import { strictJSON } from '../financial-documents/strict-json.mjs';
import { UUID, exact, validTask, publicTask, publicFinanceJob, FINANCE_STATES, FINANCE_CODES, FINANCE_FINAL } from './financial-contract.mjs';

/** Separate namespace in the existing durable settings store; never jobs/artifacts/catalog/push. */
export function createFinancialControl({ db, authorize, json, deviceId, clock }) {
  const prefix = 'finance:v1:';
  const read = key => { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(prefix + key); return r ? JSON.parse(r.value) : null; };
  const write = (key, value) => db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(prefix + key, JSON.stringify(value));
  const jobs = () => db.prepare('SELECT key,value FROM settings').all().filter(r => r.key.startsWith(prefix + 'job:')).map(r => JSON.parse(r.value));
  const stamp = () => new Date(clock()).toISOString();
  function check(ok, status = 400) { if (!ok) throw Object.assign(new Error('FINANCIAL_REQUEST_REJECTED'), { status }); }
  async function body(req) {
    let n = 0; const chunks = [];
    for await (const c of req) { n += c.length; check(n <= 12_000, 413); chunks.push(c); }
    try { return strictJSON(Buffer.concat(chunks).toString('utf8')); } catch { check(false); }
  }
  const update = (j, state, code) => { j.state = state; j.code = code; j.revision++; j.updatedAt = stamp(); write('job:' + j.id, j); return j; };
  function refresh() {
    const pc = read('pc');
    for (const j of jobs().filter(j => j.deviceId === deviceId)) {
      if (FINANCE_FINAL.has(j.state)) continue;
      if (clock() >= Date.parse(j.expiresAt)) update(j, j.state === 'LOCAL_SAVING' ? 'UNCERTAIN' : 'BLOCKED', j.state === 'LOCAL_SAVING' ? 'RECOVERY_REQUIRED' : 'REQUEST_EXPIRED');
      else if (j.state !== 'QUEUED' && (!pc || pc.workerId !== j.workerId || clock() - Date.parse(pc.seenAt) > 90_000))
        update(j, j.state === 'LOCAL_SAVING' ? 'UNCERTAIN' : 'BLOCKED', 'RECOVERY_REQUIRED');
    }
  }
  function owned(req, id, agent = false) {
    check(UUID.test(id)); const j = read('job:' + id); check(j && j.deviceId === deviceId, 404);
    if (!agent) check(j.owner === (req.phoneId || 'owner'), 404);
    return j;
  }
  async function handle(req, res, route) {
    const agent = route.startsWith('/api/agent/financial/');
    if (!agent && !route.startsWith('/api/financial/')) return false;
    try {
      authorize(req, agent ? 'agent' : 'user');
      check(!new URL(req.url, 'http://localhost').search);
      refresh();
      if (agent && route === '/api/agent/financial/register' && req.method === 'POST') {
        const b = await body(req); check(exact(b, ['workerId', 'tasks']) && UUID.test(b.workerId) && Array.isArray(b.tasks) && b.tasks.length <= 20 && b.tasks.every(validTask) && new Set(b.tasks.map(t => t.id)).size === b.tasks.length);
        const pc = read('pc');
        check(!pc || pc.deviceId === deviceId, 409);
        // A second live worker cannot replace the current console/approval owner.
        check(!pc || pc.workerId === b.workerId || clock() - Date.parse(pc.seenAt) > 90_000, 409);
        if (pc && pc.workerId !== b.workerId) for (const j of jobs()) if (j.deviceId === deviceId && !FINANCE_FINAL.has(j.state) && j.state !== 'QUEUED') update(j, j.state === 'LOCAL_SAVING' ? 'UNCERTAIN' : 'BLOCKED', 'RECOVERY_REQUIRED');
        const tasks = b.tasks.map(publicTask);
        for (const j of jobs()) if (j.deviceId === deviceId && !FINANCE_FINAL.has(j.state)) {
          const t = tasks.find(t => t.id === j.taskId);
          if (!t || !t.actions.includes(j.action) || !t.formats.includes(j.format)) update(j, j.state === 'LOCAL_SAVING' ? 'UNCERTAIN' : 'BLOCKED', 'POLICY_CHANGED');
        }
        write('pc', { workerId: b.workerId, deviceId, tasks, seenAt: stamp() });
        json(res, 200, { ok: true }); return true;
      }
      if (agent && route === '/api/agent/financial/next' && req.method === 'POST') {
        const b = await body(req); check(exact(b, ['workerId']) && UUID.test(b.workerId)); const pc = read('pc');
        check(pc && pc.workerId === b.workerId && pc.deviceId === deviceId, 409);
        pc.seenAt = stamp(); write('pc', pc);
        let j = jobs().find(j => j.deviceId === deviceId && !FINANCE_FINAL.has(j.state) && j.state !== 'QUEUED');
        if (!j) j = jobs().filter(j => j.deviceId === deviceId && j.state === 'QUEUED').sort((a,b) => a.createdAt.localeCompare(b.createdAt))[0];
        if (j?.state === 'QUEUED') { j.workerId = b.workerId; j.generation++; update(j, 'PROCESSING', 'PC_PROCESSING'); }
        json(res, 200, { job: j ? { ...publicFinanceJob(j), generation: j.generation, workerId: j.workerId } : null }); return true;
      }
      let m = route.match(/^\/api\/agent\/financial\/jobs\/([^/]+)\/status$/);
      const observe = route.match(/^\/api\/agent\/financial\/jobs\/([^/]+)\/observe$/);
      if (agent && observe && req.method === 'POST') {
        const b = await body(req); check(exact(b, ['workerId']) && UUID.test(b.workerId));
        const j = owned(req, observe[1], true); check(j.workerId === b.workerId, 409);
        json(res, 200, { job: publicFinanceJob(j) }); return true;
      }
      if (agent && m && req.method === 'POST') {
        const b = await body(req); check(exact(b, ['workerId', 'generation', 'revision', 'reportId', 'state', 'code', 'saved', 'reviewComplete']) && UUID.test(b.workerId) && UUID.test(b.reportId) && Number.isSafeInteger(b.generation) && Number.isSafeInteger(b.revision) && FINANCE_STATES.includes(b.state) && FINANCE_CODES.includes(b.code) && typeof b.saved === 'boolean' && typeof b.reviewComplete === 'boolean');
        const j = owned(req, m[1], true); const pc = read('pc');
        check(pc && pc.workerId === b.workerId && j.workerId === b.workerId && j.generation === b.generation, 409);
        if (j.lastReport && JSON.stringify(j.lastReport) === JSON.stringify(b)) { json(res, 200, { job: publicFinanceJob(j) }); return true; }
        check(j.revision === b.revision && !FINANCE_FINAL.has(j.state), 409);
        const transitions = { PROCESSING: ['PC_REVIEW_REQUIRED', 'WAITING_FOR_INFORMATION', 'REVIEW_COMPLETED', 'BLOCKED', 'FAILED'], PC_REVIEW_REQUIRED: ['LOCAL_SAVING', 'CANCELLED', 'BLOCKED', 'FAILED'], LOCAL_SAVING: ['LOCAL_SAVE_COMPLETED', 'UNCERTAIN'] };
        check(transitions[j.state]?.includes(b.state), 409);
        const codes = { PC_REVIEW_REQUIRED:['PC_CHECK_REQUIRED'], WAITING_FOR_INFORMATION:['PC_INFORMATION_REQUIRED'], REVIEW_COMPLETED:['PC_REVIEWED','NO_CHANGE_REQUIRED'], LOCAL_SAVING:['PC_SAVING'], LOCAL_SAVE_COMPLETED:['PC_SAVED'], CANCELLED:['USER_CANCELLED','PC_REJECTED'], BLOCKED:['LOCAL_CHECK_FAILED','POLICY_CHANGED'], FAILED:['LOCAL_OPERATION_FAILED'], UNCERTAIN:['RECOVERY_REQUIRED'] };
        check(codes[b.state]?.includes(b.code) && b.saved === (b.state === 'LOCAL_SAVE_COMPLETED') && (!b.reviewComplete || ['LOCAL_SAVE_COMPLETED','REVIEW_COMPLETED'].includes(b.state)));
        j.saved = b.saved; j.reviewComplete = b.reviewComplete; j.lastReport = b;
        update(j, b.state, b.code); json(res, 200, { job: publicFinanceJob(j) }); return true;
      }
      if (!agent && route === '/api/financial/tasks' && req.method === 'GET') {
        const stored = read('pc'), pc = stored?.deviceId === deviceId ? stored : null; json(res, 200, { supported: true, online: !!pc && clock() - Date.parse(pc.seenAt) <= 90_000, tasks: (pc?.tasks || []).map(publicTask), updatedAt: pc?.seenAt || null }); return true;
      }
      if (!agent && route === '/api/financial/jobs' && req.method === 'GET') {
        json(res, 200, { jobs: jobs().filter(j => j.owner === (req.phoneId || 'owner') && j.deviceId === deviceId).sort((a,b) => b.createdAt.localeCompare(a.createdAt)).slice(0,50).map(publicFinanceJob) }); return true;
      }
      if (!agent && route === '/api/financial/jobs' && req.method === 'POST') {
        const b = await body(req); check(exact(b, ['requestId', 'taskId', 'action', 'format']) && UUID.test(b.requestId) && UUID.test(b.taskId));
        const old = read('job:' + b.requestId), owner = req.phoneId || 'owner';
        if (old) {
          check(old.owner === owner && old.deviceId === deviceId && old.taskId === b.taskId && old.action === b.action && old.format === b.format, 409);
          json(res, 200, { job: publicFinanceJob(old) }); return true;
        }
        check(jobs().length < 500, 429);
        const pc = read('pc'), task = pc?.deviceId === deviceId ? pc.tasks.find(t => t.id === b.taskId) : null;
        check(task && task.actions.includes(b.action) && task.formats.includes(b.format));
        const j = { id: b.requestId, taskId: b.taskId, action: b.action, format: b.format, owner, deviceId, state: 'QUEUED', code: 'PC_QUEUED', saved:false, reviewComplete:false, generation:0, workerId:null, revision:1, createdAt:stamp(), updatedAt:stamp(), expiresAt:new Date(clock()+24*3600_000).toISOString() };
        write('job:' + j.id, j); json(res, 201, { job: publicFinanceJob(j) }); return true;
      }
      m = route.match(/^\/api\/financial\/jobs\/([^/]+)(\/cancel)?$/);
      if (!agent && m && (req.method === 'GET' && !m[2] || req.method === 'POST' && m[2])) {
        const j = owned(req, m[1]);
        if (m[2]) {
          const b = await body(req); check(exact(b, []));
          if (['QUEUED','PROCESSING','PC_REVIEW_REQUIRED'].includes(j.state)) update(j, 'CANCELLED', 'USER_CANCELLED');
        }
        json(res, 200, { job: publicFinanceJob(j) }); return true;
      }
      check(false, 404);
    } catch (e) {
      // Never echo JSON input, core errors or authentication exception text.
      json(res, [400,401,403,404,409,413,429].includes(e.status) ? e.status : 503, { code: 'FINANCIAL_REQUEST_REJECTED' });
      return true;
    }
  }
  return { handle };
}
