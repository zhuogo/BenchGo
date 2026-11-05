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
