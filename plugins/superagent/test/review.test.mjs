import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantReview } from '../src/review.mjs';

test('review queue is durable, deduplicated, budgeted and lease protected', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-review-'));
  const review = createAssistantReview({ directory, budget: 1 });
  t.after(async () => { review.close(); await rm(directory, { recursive: true, force: true }); });
  const first = review.enqueue({ kind: 'memory', payload: { content: 'keep concise' }, source: { sessionId: 's1' } });
  const duplicate = review.enqueue({ kind: 'memory', payload: { content: 'keep concise' }, source: { sessionId: 's1' } });
  assert.equal(duplicate.id, first.id);
  assert.deepEqual(duplicate.payload, first.payload);
  assert.deepEqual(duplicate.source, first.source);
  const claim = review.claim({ workerId: 'worker-a', leaseMs: 5000 });
  assert.equal(claim.items.length, 1);
  assert.equal(review.claim({ workerId: 'worker-b' }).items.length, 0);
  assert.throws(() => review.complete(first.id, { workerId: 'worker-b', result: { candidate: true } }), /租约/);
  assert.equal(review.complete(first.id, { workerId: 'worker-a', result: { candidate: true } }).status, 'completed');
  assert.equal(review.budget().used, 1);
  const blocked = review.enqueue({ kind: 'memory', payload: { content: 'second' } });
  assert.equal(review.claim({ workerId: 'worker-c' }).items.length, 0);
  assert.equal(review.list({ status: 'completed' })[0].result.candidate, true);
  assert.equal(blocked.status, 'pending');
});

test('expired review lease is recovered on restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-review-'));
  const first = createAssistantReview({ directory, budget: 4 });
  const item = first.enqueue({ kind: 'skill', payload: { name: 'x' } });
  first.claim({ workerId: 'worker-a', leaseMs: 1000 });
  first.close();
  await new Promise(resolve => setTimeout(resolve, 1100));
  const second = createAssistantReview({ directory, budget: 4 });
  t.after(async () => { second.close(); await rm(directory, { recursive: true, force: true }); });
  assert.equal(second.list({ status: 'pending' })[0].id, item.id);
  assert.equal(second.claim({ workerId: 'worker-b' }).items[0].id, item.id);
});

