import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantStore } from '../src/store.mjs';
import { readAssessmentPolicy } from '../src/assessment-policy.mjs';
import { createOrchestrationRuntime } from '../src/orchestration-runtime.mjs';
import { executionEvidence } from '../src/execution-evidence.mjs';
import { captureArtifactCheckpoint } from '../src/worker-artifact-checkpoint.mjs';
import { systemStateDelivery } from '../src/result-delivery.mjs';

async function settleUntil(predicate) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.ok(predicate(), 'background review must settle');
}

async function fixture(t, { review, waitKind = 'review_wait', budgetExhausted = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-review-retry-'));
  let store = await createAssistantStore({ dataDirectory: directory });
  const model = { providerId: 'provider', modelId: 'opaque/model' };
  await store.updateConfig({ models: [model] });
  const policy = await readAssessmentPolicy(store);
  const database = store.orchestration;
  database.createThread({ id: 'thread', source: { type: 'desktop', id: 'owner' } });
  const ticket = database.createTicket({ threadId: 'thread', target: 'Summarize verified news',
    acceptance: 'Return 8 dated headlines and sources', mandate: {
      source: { channel: 'desktop', sessionId: 'owner', messageId: 'request', threadId: 'main' },
      actorId: 'desktop-owner', admission: 'desktop-approved-delegation', policyVersion: policy.desktopVersion,
      controlledActions: 'require-current-policy-and-harness-approval',
    } });
  database.createAssignment(ticket.id, { model });
  const [assignment] = database.claimAssignments('original-worker', { validateMandate: () => true });
  const ownership = { owner: assignment.owner, fence: assignment.fence };
  const workspace = join(directory, 'original-work');
  await mkdir(workspace);
  const run = database.prepareRun(assignment.id, { ...ownership, sessionId: 'original-session', directory: workspace });
  database.updateRun(run.id, { ...ownership, state: 'submitted' });
  const terminal = budgetExhausted ? { kind: 'aborted', reason: { kind: 'hook', reason: 'benchgo-execution-budget-exhausted' } } : { kind: 'completed' };
  const events = [{ seq: 1, type: 'turn/start', data: {} },
    { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '8 dated headlines' }] } } },
    { seq: 3, type: 'turn/end', data: { reason: terminal } }];
  const result = { ...executionEvidence({ events }), runId: run.id, sessionId: run.sessionId,
    directory: workspace, evidenceRefs: [{ sessionId: run.sessionId, runId: run.id }], remainingExecutionMs: budgetExhausted ? 0 : 60000,
    ...(budgetExhausted ? { waitingPause: true, waitingExecutionBudget: { kind: 'execution-time', terminal,
      effectsVerified: true, deadlineAt: new Date().toISOString(), unknownCallIds: [] } } : {}),
    checkpoint: await captureArtifactCheckpoint(workspace) };
  database.updateRun(run.id, { ...ownership, state: 'verifying', evidence: result });
  if (budgetExhausted) database.pauseTicket(ticket.id, { reason: { kind: 'execution-budget' } });
  database.confirmExecutionStopped(assignment.id, ownership);
  let currentTime = Date.now(), reviews = 0, opens = 0, evidenceUnavailable = false;
  if (budgetExhausted) database.parkPause(assignment.id, { ...ownership, result });
  else database.commitResult(ticket.id, { assignment, status: 'waiting', uniqueKey: 'initial-review',
    result: { ...result, review: { verdict: 'wait', reason: 'Temporary wait', waitKind, retryable: true,
      ...(waitKind === 'continuation_wait' ? { instruction: 'Verify the sources and condense the retained draft.' } : {}),
      diagnostic: { code: 'NETWORK', at: new Date(currentTime).toISOString() } },
      delivery: systemStateDelivery({ state: waitKind === 'continuation_wait' ? 'continuation_wait' : 'review_wait' }) } });
  const ctx = { agents: { get: () => null }, sessionPersistence: { open: async (id, access) => {
    opens++;
    if (evidenceUnavailable) throw new Error('Official evidence is temporarily locked');
    return { id, access, read: async () => ({ events }), close: async () => {} };
  } } };
  const makeRuntime = () => createOrchestrationRuntime({ ctx, store, now: () => currentTime,
    execute: async () => assert.fail('saved evidence must not rerun the Worker'),
    review: async input => { reviews++; return review ? review(input, reviews, currentTime) : { verdict: 'passed', reason: 'Verified', delivery: { action: 'deliver', text: '8 verified headlines' } }; },
    deliverDesktop: async () => ({ status: 'accepted', messageId: `result-${reviews}` }),
  });
  let runtime = makeRuntime();
  t.after(async () => { await runtime.stop(); await store.close(); await rm(directory, { recursive: true, force: true }); });
  return { ticket, run, assignment,
    get runtime() { return runtime; },
    get database() { return store.orchestration; },
    counts: () => ({ reviews, opens }),
    clock: () => currentTime,
    setTime: value => { currentTime = value; },
    lockEvidence: () => { evidenceUnavailable = true; },
    revokeRules: async () => {
      const document = await store.documents.read('AGENTS.md');
      await store.documents.update('AGENTS.md', { expectedHash: document.hash, content: document.content + '\nUpdated execution authority.', source: { kind: 'test' } });
    },
    restart: async () => { await runtime.stop(); await store.close(); store = await createAssistantStore({ dataDirectory: directory }); runtime = makeRuntime(); },
  };
}

test('automatic review keeps retrying after two failures without rerunning the original work', async t => {
  const app = await fixture(t, { review: async (_input, count, now) => count <= 3
    ? { verdict: 'wait', waitKind: 'review_wait', retryable: true, reason: 'Provider unavailable',
      diagnostic: { code: 'NETWORK', at: new Date(now).toISOString() }, delivery: systemStateDelivery() }
    : { verdict: 'passed', reason: 'Source evidence verified', delivery: { action: 'deliver', text: '8 verified headlines' } } });
  for (let attempt = 0; attempt < 4; attempt++) {
    await app.runtime.tick();
    const pending = app.database.getTicket(app.ticket.id);
    assert.equal(pending.status, 'waiting');
    assert.ok(pending.reviewRetry.nextAttemptAt > app.clock());
    app.setTime(pending.reviewRetry.nextAttemptAt);
    await app.runtime.tick();
    await settleUntil(() => app.database.getTicket(app.ticket.id).resultVersion === attempt + 2);
    await new Promise(resolve => setImmediate(resolve));
    if (attempt < 3) assert.equal(app.database.results(app.ticket.id).at(-1).review.retryAttempts, attempt + 1);
  }
  assert.equal(app.counts().reviews, 4);
  assert.equal(app.database.getTicket(app.ticket.id).status, 'completed');
  assert.equal(app.database.assignments(app.ticket.id).length, 1);
  assert.equal(app.database.runs(app.assignment.id).length, 1);
  assert.equal(app.database.runs(app.assignment.id)[0].sessionId, app.run.sessionId);
});

test('retry deadline survives restart and unreadable evidence cannot create a tight retry loop', async t => {
  const app = await fixture(t);
  await app.runtime.tick();
  const scheduled = app.database.getTicket(app.ticket.id).reviewRetry;
  assert.equal(scheduled.nextAttemptAt, app.clock() + 30000);
  for (let index = 0; index < 5; index++) await app.runtime.tick();
  assert.deepEqual(app.database.getTicket(app.ticket.id).reviewRetry, scheduled);
  assert.deepEqual(app.counts(), { reviews: 0, opens: 0 });
  await app.restart();
  assert.deepEqual(app.database.getTicket(app.ticket.id).reviewRetry, scheduled);
  app.setTime(scheduled.nextAttemptAt - 1);
  await app.runtime.tick();
  assert.deepEqual(app.counts(), { reviews: 0, opens: 0 });
  app.lockEvidence();
  app.setTime(scheduled.nextAttemptAt);
  await app.runtime.tick();
  await settleUntil(() => app.counts().opens === 1);
  await new Promise(resolve => setImmediate(resolve));
  const deferred = app.database.getTicket(app.ticket.id).reviewRetry;
  assert.ok(deferred.nextAttemptAt > app.clock());
  assert.ok(deferred.attempts > scheduled.attempts);
  for (let index = 0; index < 8; index++) await app.runtime.tick();
  assert.deepEqual(app.counts(), { reviews: 0, opens: 1 });
  assert.equal(app.database.results(app.ticket.id).length, 1);
  assert.deepEqual(app.database.getTicket(app.ticket.id).reviewRetry, deferred);
});

for (const waitKind of ['blocked', 'continuation_wait']) test(`${waitKind} is not an automatic evidence review retry`, async t => {
  const app = await fixture(t, { waitKind });
  app.setTime(app.clock() + 86400000);
  for (let index = 0; index < 5; index++) await app.runtime.tick();
  assert.deepEqual(app.counts(), { reviews: 0, opens: 0 });
  assert.equal(app.database.getTicket(app.ticket.id).reviewRetry, null);
  assert.equal(app.database.getTicket(app.ticket.id).status, 'waiting');
  assert.equal(app.database.results(app.ticket.id).length, 1);
});

test('explicit continuation recovery queues the retained assignment and run after evidence validation', async t => {
  const app = await fixture(t, { waitKind: 'continuation_wait' });
  const resumed = await app.runtime.resumeReviewWork(app.ticket.id, 1);
  assert.equal(resumed.queued, true);
  assert.equal(resumed.assignment.id, app.assignment.id);
  assert.equal(resumed.assignment.reviewContinuation.runId, app.run.id);
  assert.equal(resumed.assignment.reviewContinuation.sourceSessionId, app.run.sessionId);
  assert.equal(app.database.getTicket(app.ticket.id).status, 'open');
  assert.equal(app.database.assignments(app.ticket.id).length, 1);
  assert.equal(app.database.runs(app.assignment.id).length, 1);
  assert.deepEqual(app.counts(), { reviews: 0, opens: 1 });
  await assert.rejects(app.runtime.resumeReviewWork(app.ticket.id, 1), /状态已变化/);
});

test('oversized explicit continuation budget is rejected before evidence access or any state change', async t => {
  const app = await fixture(t, { waitKind: 'continuation_wait' });
  const before = { ticket: app.database.getTicket(app.ticket.id),
    assignments: app.database.assignments(app.ticket.id), runs: app.database.runs(app.assignment.id),
    results: app.database.results(app.ticket.id) };
  await assert.rejects(app.runtime.resumeReviewWork(app.ticket.id, 1, { additionalExecutionMs: 600001 }), /0到10分钟/);
  assert.deepEqual({ ticket: app.database.getTicket(app.ticket.id),
    assignments: app.database.assignments(app.ticket.id), runs: app.database.runs(app.assignment.id),
    results: app.database.results(app.ticket.id) }, before);
  assert.deepEqual(app.counts(), { reviews: 0, opens: 0 });
  assert.equal(app.database.getTicket(app.ticket.id).status, 'waiting');
});

test('execution budget pause with no result resumes the original assignment, run and session after an explicit grant', async t => {
  const app = await fixture(t, { budgetExhausted: true });
  const pending = app.database.getTicket(app.ticket.id);
  assert.equal(pending.status, 'waiting');
  assert.equal(pending.resultVersion, 0);
  assert.equal(app.database.results(app.ticket.id).length, 0);
  assert.deepEqual(pending.continuationWait, { code: 'EXECUTION_BUDGET_EXHAUSTED', sourceResultVersion: 0,
    assignmentId: app.assignment.id, runId: app.run.id, sessionId: app.run.sessionId });
  const retained = app.database.runs(app.assignment.id)[0];
  assert.equal(retained.state, 'waiting');
  assert.equal(retained.evidence.remainingExecutionMs, 0);
  assert.equal(retained.evidence.waitingExecutionBudget.effectsVerified, true);

  const withoutGrant = await app.runtime.resumeReviewWork(app.ticket.id, 0);
  assert.equal(withoutGrant.queued, false);
  assert.equal(withoutGrant.code, 'EXECUTION_BUDGET_EXHAUSTED');
  await assert.rejects(app.runtime.resumeReviewWork(app.ticket.id, 0, { additionalExecutionMs: 600001 }), /0到10分钟/);
  await assert.rejects(app.runtime.resumeReviewWork(app.ticket.id, 1, { additionalExecutionMs: 600000 }), /状态已变化/);
  assert.deepEqual(app.database.runs(app.assignment.id)[0], retained);
  assert.equal(app.database.getAssignment(app.assignment.id).state, 'waiting');

  const resumed = await app.runtime.resumeReviewWork(app.ticket.id, 0, { additionalExecutionMs: 600000 });
  assert.equal(resumed.queued, true);
  assert.equal(resumed.assignment.id, app.assignment.id);
  assert.deepEqual(resumed.assignment.pauseContinuation, { runId: app.run.id, kind: 'execution-budget', additionalExecutionMs: 600000 });
  assert.equal(app.database.getTicket(app.ticket.id).status, 'open');
  assert.equal(app.database.getTicket(app.ticket.id).resultVersion, 0);
  assert.equal(app.database.results(app.ticket.id).length, 0);
  assert.equal(app.database.assignments(app.ticket.id).length, 1);
  assert.equal(app.database.runs(app.assignment.id).length, 1);
  assert.equal(app.counts().reviews, 0);
  const [claimed] = app.database.claimAssignments('resumed-worker', { validateMandate: () => true });
  assert.equal(claimed.id, app.assignment.id);
  assert.equal(claimed.fence, app.assignment.fence + 1);
  const [sameRun] = app.database.runs(claimed.id);
  assert.equal(sameRun.id, app.run.id);
  assert.equal(sameRun.sessionId, app.run.sessionId);
  assert.equal(sameRun.directory, app.run.directory);
  assert.equal(sameRun.state, 'prepared');
  assert.deepEqual(sameRun.evidence, retained.evidence);
});

test('revoked authority cannot resume a saved execution budget pause', async t => {
  const app = await fixture(t, { budgetExhausted: true });
  const retained = app.database.runs(app.assignment.id)[0];
  await app.revokeRules();
  const resumed = await app.runtime.resumeReviewWork(app.ticket.id, 0, { additionalExecutionMs: 600000 });
  assert.equal(resumed.queued, false);
  assert.equal(resumed.code, 'MANDATE_REVOKED');
  assert.equal(app.database.getTicket(app.ticket.id).status, 'waiting');
  assert.equal(app.database.getAssignment(app.assignment.id).state, 'waiting');
  assert.deepEqual(app.database.runs(app.assignment.id)[0], retained);
  assert.equal(app.database.results(app.ticket.id).length, 0);
  assert.equal(app.counts().reviews, 0);
});

test('same-version concurrent reviews share one request and conflicting versions are rejected', async t => {
  let finishReview, reportStarted;
  const started = new Promise(resolve => { reportStarted = resolve; });
  const decision = new Promise(resolve => { finishReview = resolve; });
  const app = await fixture(t, { review: async () => { reportStarted(); return decision; } });
  t.after(() => finishReview({ verdict: 'passed', reason: 'Verified', delivery: { action: 'deliver', text: 'Verified result' } }));
  const first = app.runtime.retryReview(app.ticket.id, { expectedResultVersion: 1 });
  const duplicate = app.runtime.retryReview(app.ticket.id, { expectedResultVersion: 1 });
  assert.equal(first, duplicate);
  await started;
  await assert.rejects(app.runtime.retryReview(app.ticket.id, { expectedResultVersion: 2 }), { code: 'REVIEW_IN_PROGRESS' });
  await app.runtime.tick();
  assert.deepEqual(app.counts(), { reviews: 1, opens: 1 });
  finishReview({ verdict: 'passed', reason: 'Verified', delivery: { action: 'deliver', text: 'Verified result' } });
  const [left, right] = await Promise.all([first, duplicate]);
  assert.equal(left, right);
  assert.equal(app.database.getTicket(app.ticket.id).status, 'completed');
  assert.equal(app.database.results(app.ticket.id).length, 2);
  assert.equal(app.counts().reviews, 1);
});
