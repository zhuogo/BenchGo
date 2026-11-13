import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantReview } from '../src/review.mjs';
import { createAssistantReviewWorker } from '../src/review-worker.mjs';

test('review worker processes candidates and persists a rejected result', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-review-worker-'));
  const review = createAssistantReview({ directory, budget: 4 });
  t.after(async () => { review.close(); await rm(directory, { recursive: true, force: true }); });
  const accepted = review.enqueue({ kind: 'memory', payload: { content: 'a' } });
  const rejected = review.enqueue({ kind: 'skill', payload: { name: 'unsafe' } });
  const worker = createAssistantReviewWorker({ review, batchSize: 2, intervalMs: 1000, process: async item => item.kind === 'skill' ? { status: 'rejected', reason: 'unsupported' } : { candidate: true } });
  const result = await worker.runOnce();
  assert.equal(result.claimed, 2);
  assert.equal(review.list({ status: 'completed' })[0].id, accepted.id);
  assert.equal(review.list({ status: 'rejected' })[0].id, rejected.id);
  await worker.stop();
});

test('review worker retries bounded failures and then marks failed', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-review-worker-'));
  const review = createAssistantReview({ directory, budget: 5 });
  t.after(async () => { review.close(); await rm(directory, { recursive: true, force: true }); });
  const item = review.enqueue({ kind: 'memory', payload: { content: 'retry' } });
  const worker = createAssistantReviewWorker({ review, maxAttempts: 2, process: async () => { throw new Error('bad'); } });
  assert.equal((await worker.runOnce()).retried, 1);
  assert.equal(review.list({ status: 'pending' })[0].id, item.id);
  assert.equal((await worker.runOnce()).failed, 1);
  assert.equal(review.list({ status: 'failed' })[0].id, item.id);
  await worker.stop();
});

test('worker yields promptly to real user activity without advancing sources or bypassing daily quota', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-review-worker-'));
  const review = createAssistantReview({ directory, budget: 1 });
  t.after(async () => { review.close(); await rm(directory, { recursive: true, force: true }); });
  const item = review.enqueue({ kind: 'learning', payload: { task: 'memory-upkeep' } });
  let started, resolveStarted;
  started = new Promise(resolve => { resolveStarted = resolve; });
  let committed = false;
  const worker = createAssistantReviewWorker({ review, process: async (_item, { signal }) => {
    resolveStarted();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    signal.throwIfAborted();
    committed = true;
  } });
  const running = worker.runOnce();
  await started;
  assert.equal(worker.status().state, 'running');
  assert.ok(worker.status().deadlineAt);
  worker.interrupt('user-activity');
  const result = await running;
  assert.equal(result.yielded, 1);
  assert.equal(result.failed, 0);
  assert.equal(committed, false);
  assert.equal(review.get(item.id).status, 'pending');
  assert.equal(review.get(item.id).attempts, 0);
  assert.equal(review.budget().used, 1);
  assert.equal(review.claim({ workerId: 'another' }).items.length, 0);
  assert.equal(worker.status().state, 'yielded');
  await worker.stop();
  assert.equal(worker.status().state, 'disabled');
});

test('tick schedules before claim, lets unstarted background work wait, and serializes independent workers', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-review-worker-'));
  const review = createAssistantReview({ directory, budget: 3 });
  t.after(async () => { review.close(); await rm(directory, { recursive: true, force: true }); });
  let ready = false, scheduled = 0, processCount = 0, unblock;
  const blocker = new Promise(resolve => { unblock = resolve; });
  const worker = createAssistantReviewWorker({ review,
    beforeRun() { scheduled++; review.enqueue({ kind: 'learning', payload: { unique: 'first' } }); },
    shouldRun: () => ready,
    process: async () => { processCount++; await blocker; return { ok: true }; } });
  assert.equal((await worker.runOnce()).claimed, 0);
  assert.equal(scheduled, 1);
  assert.equal(review.budget().used, 0);
  ready = true;
  const second = createAssistantReviewWorker({ review, process: async () => { assert.fail('another worker cannot overlap a live lease'); } });
  const first = worker.runOnce();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(processCount, 1);
  review.enqueue({ kind: 'learning', payload: { unique: 'second' } });
  assert.equal((await second.runOnce()).claimed, 0);
  unblock();
  assert.equal((await first).completed, 1);
  assert.equal(worker.status().running, false);
  assert.ok(worker.status().lastCheckAt);
  await worker.stop(); await second.stop();
});

test('uncooperative processor is bounded by cancellation and cannot commit a completed queue result', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-review-worker-'));
  const review = createAssistantReview({ directory, budget: 1 });
  t.after(async () => { review.close(); await rm(directory, { recursive: true, force: true }); });
  const item = review.enqueue({ kind: 'learning', payload: {} });
  const worker = createAssistantReviewWorker({ review, process: () => new Promise(() => {}) });
  const running = worker.runOnce();
  await new Promise(resolve => setImmediate(resolve));
  worker.interrupt();
  assert.equal((await running).yielded, 1);
  assert.equal(review.get(item.id).status, 'pending');
  assert.equal(review.budget().used, 1);
  await worker.stop();
});

test('claim-time activity releases an unstarted job without spending quota', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-review-worker-'));
  const review = createAssistantReview({ directory, budget: 1 });
  t.after(async () => { review.close(); await rm(directory, { recursive: true, force: true }); });
  const item = review.enqueue({ kind: 'learning', payload: {} });
  let checks = 0;
  const worker = createAssistantReviewWorker({ review, shouldRun: () => ++checks === 1, process: () => assert.fail('job must not start') });
  const result = await worker.runOnce();
  assert.equal(result.yielded, 1);
  assert.equal(review.get(item.id).status, 'pending');
  assert.equal(review.get(item.id).attempts, 0);
  assert.equal(review.budget().used, 0);
  worker.start();
  assert.equal(worker.status().schedulerActive, true);
  assert.ok(worker.status().nextCheckAt);
  await worker.stop();
  assert.equal(worker.status().nextCheckAt, null);
});

test('deterministic no-model terminal jobs refund quota so later real inference is not starved', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-review-worker-'));
  const review = createAssistantReview({ directory, budget: 1 });
  t.after(async () => { review.close(); await rm(directory, { recursive: true, force: true }); });
  const worker = createAssistantReviewWorker({ review, process: async item => item.payload.model
    ? { modelUsed: true, value: 'real inference' }
    : { status: item.payload.disabled ? 'rejected' : 'completed', reason: item.payload.reason, modelUsed: false } });
  for (const payload of [{ reason: 'empty' }, { reason: 'unchanged' }, { disabled: true }]) {
    const item = review.enqueue({ kind: 'maintenance', payload });
    assert.equal((await worker.runOnce()).completed, 1);
    assert.equal(review.budget().used, 0);
    assert.equal(review.complete(item.id, { workerId: worker.workerId, result: { modelUsed: false }, refundBudget: true }).idempotent, true);
    assert.equal(review.budget().used, 0);
  }
  review.enqueue({ kind: 'learning', payload: { model: true } });
  assert.equal((await worker.runOnce()).completed, 1);
  assert.equal(review.budget().used, 1);
  review.enqueue({ kind: 'learning', payload: { model: true, next: true } });
  assert.equal((await worker.runOnce()).claimed, 0);
  await worker.stop();
});

test('a pending result cannot use no-model metadata to refund its daily attempt', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-review-worker-'));
  const review = createAssistantReview({ directory, budget: 1 });
  t.after(async () => { review.close(); await rm(directory, { recursive: true, force: true }); });
  const item = review.enqueue({ kind: 'maintenance', payload: {} });
  const worker = createAssistantReviewWorker({ review, process: async () => ({ status: 'pending', modelUsed: false }) });
  await worker.runOnce();
  assert.equal(review.get(item.id).status, 'pending');
  assert.equal(review.budget().used, 1);
  assert.equal((await worker.runOnce()).claimed, 0);
  await worker.stop();
});
