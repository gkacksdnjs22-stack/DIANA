const SEVERITIES = new Set(['critical', 'major', 'minor']);

class TimeBudgetError extends Error {
  constructor(stage, finalDeadline) {
    super('The stage time budget expired.');
    this.stage = stage;
    this.finalDeadline = finalDeadline;
  }
}

function parseDeadline(value) {
  const milliseconds = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new TypeError('deadlineAt must be a valid date or timestamp.');
  return milliseconds;
}

function readIssues(value) {
  if (!value || !Array.isArray(value.issues) || value.issues.some(issue =>
    !issue || typeof issue !== 'object' || !SEVERITIES.has(issue.severity))) return null;
  return value.issues;
}

/**
 * Callback-only prototype: this module does not create files, call AI, or send mail.
 * maxRounds counts review passes, so three rounds permit at most two revisions.
 * Callbacks receive { instruction, source, artifact, round, issues, signal,
 * deadlineAt, workDeadlineAt }. Reviews return { issues: [{ severity, ... }] };
 * validate must return { passed: true }; deliver returns accepted or delivered.
 * A timed-out delivery callback may already have external side effects; its result
 * is reported as unknown. Delivery implementations must honor the abort signal.
 */
export async function runReviewWorkflow({ instruction, source, deadlineAt, maxRounds = 3, deliveryReserveMs = 60_000, completionDeadlineAt }, {
  draft, review, revise, validate, deliver, now = Date.now, onEvent,
}) {
  if (typeof instruction !== 'string' || !instruction.trim()) throw new TypeError('A nonempty workflow instruction is required.');
  if (!Number.isSafeInteger(maxRounds) || maxRounds < 1) throw new TypeError('maxRounds must be a positive integer.');
  if (!Number.isSafeInteger(deliveryReserveMs) || deliveryReserveMs < 0) throw new TypeError('deliveryReserveMs must be a nonnegative integer.');
  for (const [name, callback] of Object.entries({ draft, review, revise, validate, deliver, now })) {
    if (typeof callback !== 'function') throw new TypeError(`${name} must be a callback.`);
  }
  if (onEvent !== undefined && typeof onEvent !== 'function') throw new TypeError('onEvent must be a callback.');
  const deadline = parseDeadline(deadlineAt);
  const workDeadline = deadline - deliveryReserveMs;
  const completionDeadline = completionDeadlineAt === undefined ? deadline : Math.min(deadline, parseDeadline(completionDeadlineAt));
  let artifact;
  let issues = [];
  let rounds = 0;
  let stage = 'draft';
  let deliveryStarted = false;

  const clock = () => {
    const value = now();
    if (!Number.isFinite(value)) throw new TypeError('now() must return a finite timestamp.');
    return value;
  };

  // Events intentionally contain no document, source, instruction, model output,
  // issue message, recipient, or raw error text. Notification errors do not rerun work.
  const emit = (event) => {
    if (!onEvent) return;
    try { Promise.resolve(onEvent({ ...event })).catch(() => {}); } catch { /* Optional notification only. */ }
  };

  const finish = (status, reason, extra = {}) => {
    emit({ stage: status, round: rounds, ...(reason ? { reason } : {}) });
    return {
      status, stage, rounds, ...(reason ? { reason } : {}),
      ...(artifact === undefined ? {} : { artifact }),
      ...(issues.length ? { issues } : {}), ...extra,
    };
  };

  const expired = error => {
    const exceeded = clock() >= deadline || error?.finalDeadline === true;
    return finish(exceeded ? 'deadline_exceeded' : 'needs_attention', exceeded ? 'deadline_exceeded' : 'insufficient_time',
      deliveryStarted ? { deliveryStatus: 'unknown' } : {});
  };

  async function invoke(name, callback, limit, context = {}) {
    stage = name;
    const remaining = limit - clock();
    if (remaining <= 0) throw new TimeBudgetError(name, limit === deadline);
    const controller = new AbortController();
    emit({ stage: name, state: 'started', round: rounds });
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort(new Error('Workflow stage deadline reached.'));
        reject(new TimeBudgetError(name, limit === deadline));
      }, Math.min(Math.ceil(remaining), 2_147_483_647));
    });
    try {
      const value = await Promise.race([
        Promise.resolve().then(() => {
          // Recheck after notification/microtask scheduling as well: a slow event
          // handler must not cause a delivery callback to start after its cutoff.
          if (clock() >= limit) {
            controller.abort(new Error('Workflow stage deadline reached before starting.'));
            throw new TimeBudgetError(name, limit === deadline);
          }
          return callback({
            instruction, source, artifact, round: rounds, issues, ...context,
            deadlineAt: new Date(deadline).toISOString(), workDeadlineAt: new Date(workDeadline).toISOString(),
            signal: controller.signal,
          });
        }),
        timeout,
      ]);
      // A callback may ignore signal or a mock clock can jump while it runs.
      // Always recheck before accepting its result or starting another stage.
      if (clock() >= limit) {
        controller.abort(new Error('Workflow stage finished after its deadline.'));
        throw new TimeBudgetError(name, limit === deadline);
      }
      emit({ stage: name, state: 'finished', round: rounds });
      return value;
    } finally { clearTimeout(timer); }
  }

  try {
    artifact = await invoke('draft', draft, workDeadline);
    if (artifact === undefined || artifact === null) return finish('needs_attention', 'empty_draft');

    for (rounds = 1; rounds <= maxRounds; rounds++) {
      const reviewResult = await invoke('review', review, workDeadline);
      const findings = readIssues(reviewResult);
      if (findings === null) return finish('needs_attention', 'invalid_review');
      issues = findings;
      emit({
        stage: 'review', state: 'findings', round: rounds,
        findings: issues.map(issue => ({ severity: issue.severity })),
        counts: Object.fromEntries([...SEVERITIES].map(severity => [severity, issues.filter(issue => issue.severity === severity).length])),
      });
      if (issues.length === 0) {
        if (reviewResult.passed === false) return finish('needs_attention', 'review_not_passed');
        break;
      }
      // Minor findings also block automatic delivery in this initial policy.
      if (rounds === maxRounds) return finish('needs_attention', 'max_rounds_reached');
      artifact = await invoke('revise', revise, workDeadline);
      if (artifact === undefined || artifact === null) return finish('needs_attention', 'empty_revision');
    }

    const validation = await invoke('validate', validate, completionDeadline);
    if (!validation || validation.passed !== true) return finish('needs_attention', 'validation_failed');
    if (validation.issues !== undefined) {
      const validationIssues = readIssues(validation);
      if (validationIssues === null) return finish('needs_attention', 'invalid_validation');
      if (validationIssues.length) { issues = validationIssues; return finish('needs_attention', 'validation_findings_remain'); }
    }

    // A final real-time check happens inside invoke before deliver can be called.
    const delivery = await invoke('deliver', async context => {
      deliveryStarted = true;
      return deliver(context);
    }, completionDeadline);
    const status = typeof delivery === 'string' ? delivery : delivery?.status;
    if (!['accepted', 'delivered'].includes(status)) return finish('needs_attention', 'delivery_unconfirmed', { deliveryStatus: 'unknown' });
    return finish(status, undefined, { delivery });
  } catch (error) {
    if (error instanceof TimeBudgetError) return expired(error);
    return finish('needs_attention', `${stage}_failed`, deliveryStarted ? { deliveryStatus: 'unknown' } : {});
  }
}
