import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantStore } from '../src/store.mjs';
import { readAssessmentPolicy } from '../src/assessment-policy.mjs';
import { executionEvidence } from '../src/execution-evidence.mjs';
import { createReviewContinuation } from '../src/review-continuation.mjs';
import { createOrchestrationRuntime } from '../src/orchestration-runtime.mjs';
import { reviewTicketResult } from '../src/ticket-review.mjs';
import { ticketGoalRecord } from '../src/goal-ticket-record.mjs';
import { captureArtifactCheckpoint } from '../src/worker-artifact-checkpoint.mjs';

const passed = { verdict: 'passed', reason: 'verified', delivery: { action: 'deliver', text: '已核实原任务结果。' } };

async function fixture(t, review, { uncertain = false, reviewState = { verdict: 'wait', reason: 'review again' } } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-review-continuation-'));
  const workerDirectory = join(directory, 'worker');
  await mkdir(workerDirectory);
  const store = await createAssistantStore({ dataDirectory: directory });
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  const database = store.orchestration, readPolicy = () => readAssessmentPolicy(store), policy = await readPolicy();
  database.createThread({ id: 'thread', source: { type: 'desktop', id: 'owner' } });
  const ticket = database.createTicket({ threadId: 'thread', target: 'task', mandate: { source: { channel: 'desktop', sessionId: 'owner', messageId: 'source' }, admission: 'desktop-approved-delegation', actorId: 'desktop-owner', policyVersion: policy.desktopVersion, controlledActions: 'require-current-policy-and-harness-approval' } });
  database.createAssignment(ticket.id, { model: { providerId: 'exact', modelId: 'opaque' } });
  const [assignment] = database.claimAssignments('worker', { validateMandate: () => true });
  const ownership = { owner: assignment.owner, fence: assignment.fence };
  const run = database.prepareRun(assignment.id, { ...ownership, sessionId: 'execution', directory: workerDirectory });
  database.updateRun(run.id, { ...ownership, state: 'submitted' });
  const log = { events: [{ seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'saved answer' }] } } }, { seq: 2, type: 'turn/end', data: { reason: { kind: 'completed' } } }] };
  const result = { ...executionEvidence(log), runId: run.id, sessionId: 'execution', directory: workerDirectory,
    checkpoint: await captureArtifactCheckpoint(workerDirectory), remainingExecutionMs: 600000, evidenceRefs: ['transcript'] };
  database.updateRun(run.id, { ...ownership, state: 'verifying', evidence: result });
  database.confirmExecutionStopped(assignment.id, ownership);
  if (uncertain) database.renewAssignment(assignment.id, { ...ownership, validateMandate: () => false });
  else database.commitResult(ticket.id, { assignment, result: { ...result, review: reviewState }, status: 'waiting', uniqueKey: 'initial' });
  let closed = 0;
  const ctx = { agents: { get: () => undefined }, sessionPersistence: { open: async () => ({ id: 'execution', access: 'write', read: async () => log, close: async () => { closed++; } }) } };
  const retry = createReviewContinuation({ ctx, database, readPolicy, review, signal: new AbortController().signal });
  return { retry, database, ticket, log, ctx, store, closed: () => closed };
}

test('owner can recover an old uncertain execution by revalidating its original evidence only', async t => {
  const f = await fixture(t, undefined, { uncertain: true });
  const runtime = createOrchestrationRuntime({ ctx: f.ctx, store: f.store, execute: async () => assert.fail('must not execute'), review: async () => passed });
  t.after(() => runtime.stop());
  const recovered = await runtime.retryReview(f.ticket.id, { expectedResultVersion: 0 });
  assert.equal(recovered.queued, true);
  assert.ok(recovered.assignment.verificationOnly.runId);
  assert.equal(f.database.runs(recovered.assignment.id).length, 1);
  await assert.rejects(runtime.retryReview(f.ticket.id, { expectedResultVersion: 0 }), /不唯一/);
});

test('runtime automatically retries transient review without rerunning Worker', async t => {
  const f = await fixture(t, undefined, { reviewState: { verdict: 'wait', reason: 'temporary', retryable: true, diagnostic: { at: '2020-01-01T00:00:00Z', code: 'HTTP' } } });
  let reviews = 0;
  const runtime = createOrchestrationRuntime({ ctx: f.ctx, store: f.store, execute: async () => assert.fail('must not execute'),
    review: async () => { reviews++; return passed; } });
  t.after(() => runtime.stop());
  for (let i = 0; i < 20 && f.database.getTicket(f.ticket.id).status !== 'completed'; i++) { await runtime.tick(); await new Promise(resolve => setImmediate(resolve)); }
  assert.equal(f.database.getTicket(f.ticket.id).status, 'completed');
  assert.equal(reviews, 1);
  assert.equal(f.database.assignments(f.ticket.id).length, 1);
});

test('waiting review continues from locked evidence without starting another execution', async t => {
  const f = await fixture(t, async ({ model, result }) => { assert.equal(model.modelId, 'opaque'); assert.equal(result.summary, 'saved answer'); return passed; });
  const result = await f.retry(f.ticket.id, { expectedResultVersion: 1 });
  assert.equal(result.ticket.status, 'completed');
  assert.equal(result.result.version, 2);
  assert.equal(f.database.assignments(f.ticket.id).length, 1);
  assert.equal(f.database.runs(f.database.assignments(f.ticket.id)[0].id).length, 1);
  assert.equal(f.closed(), 1);
  await assert.rejects(f.retry(f.ticket.id, { expectedResultVersion: 1 }), /状态已变化/);
});

test('review transport failure persists a retryable wait and owner retry never reexecutes', async t => {
  let calls = 0;
  const f = await fixture(t, async () => {
    if (++calls <= 2) throw Object.assign(new Error('provider response with sensitive text'), { code: 'AUXILIARY_QUALITY' });
    return passed;
  });
  const waiting = await f.retry(f.ticket.id, { expectedResultVersion: 1 });
  assert.equal(waiting.ticket.status, 'waiting');
  assert.equal(waiting.result.review.retryable, true);
  assert.equal(waiting.result.review.diagnostic.code, 'AUXILIARY_QUALITY');
  assert.doesNotMatch(JSON.stringify(waiting.result.review), /sensitive/);
  const noticeCount = f.database.deliveries(f.ticket.id).length;
  const repeated = await f.retry(f.ticket.id, { expectedResultVersion: 2 });
  assert.equal(repeated.result.review.retryAttempts, 2);
  assert.equal(f.database.deliveries(f.ticket.id).length, noticeCount);
  const completed = await f.retry(f.ticket.id, { expectedResultVersion: 3 });
  assert.equal(completed.ticket.status, 'completed');
  assert.equal(calls, 3);
  assert.equal(f.database.assignments(f.ticket.id).length, 1);
  assert.equal(f.database.runs(f.database.assignments(f.ticket.id)[0].id).length, 1);
});

test('saved-evidence review resumes the original assignment and reports its bounded correction naturally', async t => {
  const f = await fixture(t, async () => ({ verdict: 'rework', reason: 'Source lookup required', instruction: 'Read the original source.', delivery: { action: 'deliver', text: '来源日期还需核实，我会在原任务中补查后更新摘要。' } }));
  const originalAssignment = f.database.assignments(f.ticket.id)[0];
  const beforeDeliveries = f.database.deliveries(f.ticket.id).length;
  const result = await f.retry(f.ticket.id, { expectedResultVersion: 1 });
  assert.equal(result.ticket.status, 'open');
  assert.equal(result.result.review.verdict, 'rework');
  assert.equal(f.database.assignments(f.ticket.id).length, 1);
  assert.equal(result.assignment.id, originalAssignment.id);
  assert.equal(f.database.runs(result.assignment.id).length, 1);
  assert.equal(f.database.deliveries(f.ticket.id).length, beforeDeliveries + 1);
  assert.equal(result.assignment.model.modelId, 'opaque');
  await assert.rejects(f.retry(f.ticket.id, { expectedResultVersion: 1 }), /状态已变化/);
});

test('unchanged verified evidence does not repeatedly spend tokens or publish a new waiting result', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return { verdict: 'wait', reason: 'needs a new check', delivery: { action: 'deliver', text: '现有证据仍需核对，原执行记录已保留。' } }; });
  const first = await f.retry(f.ticket.id, { expectedResultVersion: 1 });
  assert.equal(first.result.version, 2);
  const repeat = await f.retry(f.ticket.id, { expectedResultVersion: 2 });
  assert.equal(repeat.unchanged, true);
  assert.equal(repeat.result.version, 2);
  assert.equal(calls, 1);
  assert.equal(f.database.results(f.ticket.id).length, 2);
  f.log.events[0].data.message.content[0].text = 'forged';
  await assert.rejects(f.retry(f.ticket.id, { expectedResultVersion: 2 }), /does not match/);
  assert.equal(calls, 1);
});

for (const limit of [0, 1]) test(`review budget exhaustion preserves evidence and retries only review after adjustment (${limit})`, async t => {
  const f = await fixture(t, reviewTicketResult);
  f.database.ensureGoalBudget({ goalId: 'budget', budget: { requests: limit } });
  f.database.bindTicketGoal({ ticketId: f.ticket.id, goalId: 'budget' });
  let calls = 0, fail = true;
  f.ctx.llm = { stream: async function* () {
    calls++;
    yield { type: 'usage', usage: { totalTokens: 5 } };
    if (fail) { yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', status: 429 } } }; return; }
    yield { type: 'text-delta', text: JSON.stringify({ verdict: 'passed', reason: 'verified', delivery: { action: 'deliver', text: '已核验完成。' } }) };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } };
  const waiting = await f.retry(f.ticket.id, { expectedResultVersion: 1 });
  assert.equal(waiting.ticket.status, 'waiting');
  assert.equal(waiting.result.review.budgetWait.reason, 'requests');
  assert.equal(ticketGoalRecord(f.database, f.ticket.id).waitReason, 'budget');
  assert.equal(calls, limit);
  assert.equal(f.database.goalBudget('budget').usage.tokens, 5 * limit);
  f.database.updateGoalBudget({ goalId: 'budget', expectedVersion: 1, budget: { requests: limit + 1 } });
  fail = false;
  const completed = await f.retry(f.ticket.id, { expectedResultVersion: 2 });
  assert.equal(completed.ticket.status, 'completed');
  assert.equal(f.database.assignments(f.ticket.id).length, 1);
  assert.equal(f.database.runs(f.database.assignments(f.ticket.id)[0].id).length, 1);
  assert.equal(f.database.goalBudget('budget').usage.requests, limit + 1);
  assert.equal(f.database.goalBudget('budget').usage.tokens, 5 * (limit + 1));
});

test('changed transcript rejects continuation before review and preserves waiting', async t => {
  const f = await fixture(t, async () => assert.fail('must not review changed evidence'));
  f.log.events[0].data.message.content[0].text = 'modified';
  await assert.rejects(f.retry(f.ticket.id, { expectedResultVersion: 1 }), /does not match/);
  assert.equal(f.database.getTicket(f.ticket.id).status, 'waiting');
  assert.equal(f.database.results(f.ticket.id).length, 1);
  assert.equal(f.closed(), 1);
});

test('a true user blocker must be answered through its original Attention instead of manual re-review', async t => {
  const f = await fixture(t, async () => assert.fail('blocked question must not be re-reviewed'), { reviewState: {
    verdict: 'wait', waitKind: 'blocked', reason: 'City is missing', delivery: { action: 'ask', text: '请指定城市。' },
    userDecision: { kind: 'information', question: '请指定城市。' },
  } });
  await assert.rejects(f.retry(f.ticket.id, { expectedResultVersion: 1 }), { code: 'ATTENTION_PENDING' });
  assert.equal(f.database.results(f.ticket.id).length, 1);
});

test('cancellation while reviewing cannot be overwritten by late verdict', async t => {
  let f;
  f = await fixture(t, async () => { f.database.cancelTicket(f.ticket.id); return { verdict: 'passed', reason: 'late' }; });
  await assert.rejects(f.retry(f.ticket.id, { expectedResultVersion: 1 }), { code: 'REVIEW_CONFLICT' });
  assert.equal(f.database.getTicket(f.ticket.id).status, 'cancelled');
  assert.equal(f.database.results(f.ticket.id).length, 1);
});

test('runtime shutdown drains retry review and its evidence writer before returning', async t => {
  const f = await fixture(t, async () => assert.fail('unused fixture reviewer'));
  let entered, closing, releaseClose;
  const reviewEntered = new Promise(resolve => { entered = resolve; });
  const writerClosing = new Promise(resolve => { closing = resolve; });
  const closeAllowed = new Promise(resolve => { releaseClose = resolve; });
  const open = f.ctx.sessionPersistence.open;
  f.ctx.sessionPersistence.open = async () => {
    const writer = await open();
    return { ...writer, close: async () => { closing(); await closeAllowed; await writer.close(); } };
  };
  const runtime = createOrchestrationRuntime({ ctx: f.ctx, store: f.store, execute: async () => assert.fail('must not execute'),
    review: async ({ signal }) => {
      entered();
      await new Promise((resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  });
  t.after(async () => { releaseClose(); await runtime.stop(); });
  const retry = runtime.retryReview(f.ticket.id, { expectedResultVersion: 1 });
  const rejected = assert.rejects(retry, { name: 'AbortError' });
  await reviewEntered;
  let stopped = false;
  const stopping = runtime.stop().then(() => { stopped = true; });
  await writerClosing;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, false);
  await assert.rejects(runtime.retryReview(f.ticket.id, { expectedResultVersion: 1 }), { name: 'AbortError' });
  releaseClose();
  await Promise.all([stopping, rejected]);
  assert.equal(f.closed(), 1);
  assert.equal(f.database.results(f.ticket.id).length, 1);
  assert.equal(f.database.getTicket(f.ticket.id).status, 'waiting');
});


