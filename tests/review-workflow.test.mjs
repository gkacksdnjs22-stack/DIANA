import test from 'node:test';
import assert from 'node:assert/strict';
import { runReviewWorkflow } from '../lib/review-workflow.mjs';

const baseTime = Date.parse('2026-10-22T00:00:00Z');
const settings = overrides => ({ instruction: '출근 전에 보고서를 완성해 보내줘', source: 'PRIVATE SOURCE', deadlineAt: baseTime + 120_000, ...overrides });

function harness(overrides = {}) {
  const calls = [];
  const events = [];
  let current = baseTime;
  const callbacks = {
    now: () => current,
    onEvent: event => events.push(event),
    draft: async context => { calls.push('draft'); assert.ok(context.signal instanceof AbortSignal); return { content: 'PRIVATE DRAFT' }; },
    review: async () => { calls.push('review'); return { issues: [] }; },
    revise: async () => { calls.push('revise'); return { content: 'PRIVATE REVISION' }; },
    validate: async () => { calls.push('validate'); return { passed: true }; },
    deliver: async () => { calls.push('deliver'); return { status: 'accepted', receiptId: 'test-receipt' }; },
    ...overrides,
  };
  return { calls, events, callbacks, setTime: value => { current = value; } };
}

test('successful validation permits delivery and preserves accepted versus delivered states', async () => {
  const h = harness();
  const result = await runReviewWorkflow(settings(), h.callbacks);
  assert.equal(result.status, 'accepted');
  assert.equal(result.rounds, 1);
  assert.deepEqual(h.calls, ['draft', 'review', 'validate', 'deliver']);
  assert.equal(result.delivery.receiptId, 'test-receipt');
  const delivered = await runReviewWorkflow(settings(), harness({ deliver: async () => 'delivered' }).callbacks);
  assert.equal(delivered.status, 'delivered');
});

test('review findings trigger revision and a fresh review before validation and delivery', async () => {
  let reviews = 0;
  const h = harness({
    review: async ({ artifact, round, signal }) => {
      h.calls.push('review');
      assert.ok(signal instanceof AbortSignal);
      assert.equal(round, ++reviews);
      if (reviews === 1) return { issues: [{ severity: 'major', message: 'PRIVATE ISSUE TEXT' }] };
      assert.equal(artifact.content, 'PRIVATE REVISION');
      return { issues: [] };
    },
    revise: async ({ issues }) => {
      h.calls.push('revise');
      assert.equal(issues[0].severity, 'major');
      return { content: 'PRIVATE REVISION' };
    },
  });
  const result = await runReviewWorkflow(settings(), h.callbacks);
  assert.equal(result.status, 'accepted');
  assert.equal(result.rounds, 2);
  assert.deepEqual(h.calls, ['draft', 'review', 'revise', 'review', 'validate', 'deliver']);
  const serializedEvents = JSON.stringify(h.events);
  assert.equal(serializedEvents.includes('PRIVATE'), false);
  assert.equal(serializedEvents.includes(settings().instruction), false);
  const findings = h.events.find(event => event.state === 'findings');
  assert.deepEqual(findings.findings, [{ severity: 'major' }]);
  assert.deepEqual(findings.counts, { critical: 0, major: 1, minor: 0 });
});

for (const severity of ['critical', 'major', 'minor']) {
  test(`remaining ${severity} findings block validation and delivery at the round limit`, async () => {
    let reviews = 0;
    let revisions = 0;
    const h = harness({
      review: async () => { reviews++; return { passed: true, issues: [{ severity }] }; },
      revise: async () => { revisions++; return { content: 'revision' }; },
      validate: async () => assert.fail('Unresolved findings must block validation'),
      deliver: async () => assert.fail('Unresolved findings must block delivery'),
    });
    const result = await runReviewWorkflow(settings({ maxRounds: 3 }), h.callbacks);
    assert.equal(result.status, 'needs_attention');
    assert.equal(result.reason, 'max_rounds_reached');
    assert.equal(result.rounds, 3);
    assert.equal(reviews, 3);
    assert.equal(revisions, 2);
  });
}

test('validate must explicitly pass before delivery can run', async () => {
  for (const validation of [undefined, { passed: false }, { passed: 'true' }, { passed: true, issues: [{ severity: 'minor' }] }]) {
    const h = harness({ validate: async () => validation, deliver: async () => assert.fail('Failed validation cannot deliver') });
    const result = await runReviewWorkflow(settings(), h.callbacks);
    assert.equal(result.status, 'needs_attention');
    assert.match(result.reason, /^validation_/);
  }
});

test('the reserved final minute is unavailable to drafting and reviewing', async () => {
  const h = harness();
  h.setTime(baseTime + 60_000);
  const result = await runReviewWorkflow(settings(), h.callbacks);
  assert.equal(result.status, 'needs_attention');
  assert.equal(result.reason, 'insufficient_time');
  assert.deepEqual(h.calls, []);
});

test('already expired deadlines prevent even drafting', async () => {
  const h = harness();
  h.setTime(baseTime + 120_000);
  const result = await runReviewWorkflow(settings(), h.callbacks);
  assert.equal(result.status, 'deadline_exceeded');
  assert.deepEqual(h.calls, []);
});

test('a late review result is rejected even if the callback ignored its abort signal', async () => {
  let observedSignal;
  const h = harness({
    review: async ({ signal }) => { observedSignal = signal; h.setTime(baseTime + 60_000); return { issues: [] }; },
    validate: async () => assert.fail('Late review cannot reach validation'),
    deliver: async () => assert.fail('Late review cannot deliver'),
  });
  const result = await runReviewWorkflow(settings(), h.callbacks);
  assert.equal(result.status, 'needs_attention');
  assert.equal(result.reason, 'insufficient_time');
  assert.equal(observedSignal.aborted, true);
});

test('validation may use the reserved window but cannot finish at or after the delivery deadline', async () => {
  const h = harness({
    review: async () => { h.setTime(baseTime + 59_999); return { issues: [] }; },
    validate: async () => { h.setTime(baseTime + 120_000); return { passed: true }; },
    deliver: async () => assert.fail('Validation at the deadline cannot deliver'),
  });
  const result = await runReviewWorkflow(settings(), h.callbacks);
  assert.equal(result.status, 'deadline_exceeded');
  assert.equal(result.stage, 'validate');
});

test('review before cutoff and validation inside reserve can still complete delivery before deadline', async () => {
  const h = harness({
    review: async () => { h.setTime(baseTime + 59_999); return { issues: [] }; },
    validate: async () => { h.setTime(baseTime + 119_000); return { passed: true }; },
    deliver: async () => { h.setTime(baseTime + 119_999); return { status: 'delivered' }; },
  });
  const result = await runReviewWorkflow(settings(), h.callbacks);
  assert.equal(result.status, 'delivered');
});

test('a clock crossing the deadline between validation and delivery blocks the delivery callback', async () => {
  let time = baseTime;
  let validationFinished = false;
  let checksAfterValidation = 0;
  const h = harness({
    now: () => {
      if (validationFinished && ++checksAfterValidation >= 2) return baseTime + 120_000;
      return time;
    },
    validate: async () => { time = baseTime + 119_999; validationFinished = true; return { passed: true }; },
    deliver: async () => assert.fail('Deadline recheck must prevent delivery'),
  });
  const result = await runReviewWorkflow(settings(), h.callbacks);
  assert.equal(result.status, 'deadline_exceeded');
  assert.equal(result.stage, 'deliver');
});

test('real timeout aborts a callback and its eventual resolution cannot trigger delivery', async () => {
  let resolveDraft;
  let signal;
  let deliveries = 0;
  const start = Date.now();
  const h = harness({
    now: Date.now,
    draft: context => { signal = context.signal; return new Promise(resolve => { resolveDraft = resolve; }); },
    deliver: async () => { deliveries++; return { status: 'accepted' }; },
  });
  const result = await runReviewWorkflow(settings({ deadlineAt: start + 40, deliveryReserveMs: 0 }), h.callbacks);
  assert.equal(result.status, 'deadline_exceeded');
  assert.equal(signal.aborted, true);
  resolveDraft({ content: 'late draft' });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(deliveries, 0);
});

test('a slow stage notification cannot start delivery after the deadline', async () => {
  let deliveries = 0;
  const h = harness({
    onEvent: event => { if (event.stage === 'deliver' && event.state === 'started') h.setTime(baseTime + 120_000); },
    deliver: async () => { deliveries++; return { status: 'delivered' }; },
  });
  const result = await runReviewWorkflow(settings(), h.callbacks);
  assert.equal(result.status, 'deadline_exceeded');
  assert.equal(deliveries, 0);
});

test('a delivery completing late is never reported as delivered and its external outcome remains unknown', async () => {
  const h = harness({ deliver: async () => { h.setTime(baseTime + 120_001); return { status: 'delivered' }; } });
  const result = await runReviewWorkflow(settings(), h.callbacks);
  assert.equal(result.status, 'deadline_exceeded');
  assert.equal(result.deliveryStatus, 'unknown');
});

test('malformed reviews, failed callbacks, and unconfirmed delivery never claim completion', async () => {
  const invalid = await runReviewWorkflow(settings(), harness({ review: async () => ({ issues: [{ severity: 'unknown' }] }) }).callbacks);
  assert.equal(invalid.reason, 'invalid_review');
  const failed = await runReviewWorkflow(settings(), harness({ revise: async () => { throw new Error('PRIVATE ERROR'); }, review: async () => ({ issues: [{ severity: 'major' }] }) }).callbacks);
  assert.equal(failed.reason, 'revise_failed');
  assert.equal(JSON.stringify(failed).includes('PRIVATE ERROR'), false);
  const unconfirmed = await runReviewWorkflow(settings(), harness({ deliver: async () => ({ status: 'queued' }) }).callbacks);
  assert.equal(unconfirmed.status, 'needs_attention');
  assert.equal(unconfirmed.reason, 'delivery_unconfirmed');
});

test('invalid timing and missing callbacks are rejected before any work', async () => {
  const h = harness();
  await assert.rejects(runReviewWorkflow(settings({ maxRounds: 0 }), h.callbacks), /maxRounds/);
  await assert.rejects(runReviewWorkflow(settings({ deadlineAt: 'not a date' }), h.callbacks), /deadlineAt/);
  await assert.rejects(runReviewWorkflow(settings({ deliveryReserveMs: -1 }), h.callbacks), /deliveryReserveMs/);
  await assert.rejects(runReviewWorkflow(settings(), { ...h.callbacks, validate: undefined }), /validate must be a callback/);
  assert.deepEqual(h.calls, []);
});
