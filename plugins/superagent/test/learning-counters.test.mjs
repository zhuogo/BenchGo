import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLearningCounters } from '../src/learning-counters.mjs';
import { createAssistantReview } from '../src/review.mjs';
import { createAssistantReviewWorker } from '../src/review-worker.mjs';
import { DatabaseSync } from 'node:sqlite';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-learning-'));
  let review = createAssistantReview({ directory });
  let learning = createLearningCounters({ directory, review, ...options });
  t.after(async () => { learning.close(); review.close(); await rm(directory, { recursive: true, force: true }); });
  return {
    get learning() { return learning; }, get review() { return review; }, directory,
    restart() { learning.close(); review.close(); review = createAssistantReview({ directory }); learning = createLearningCounters({ directory, review, ...options }); },
  };
}

test('prompt counters survive restart, deduplicate source events and ignore background output', async t => {
  const f = await fixture(t, { promptThreshold: 2 });
  f.learning.recordPrompt({ scope: 'main', eventId: 'one', turnId: 't1' });
  f.restart();
  assert.equal(f.learning.recordPrompt({ scope: 'main', eventId: 'one' }).deduplicated, true);
  assert.equal(f.learning.recordPrompt({ scope: 'main', eventId: 'review-output', role: 'assistant' }).ignored, true);
  assert.equal(f.review.list().length, 0);
  f.learning.recordPrompt({ scope: 'main', eventId: 'two', turnId: 't2' });
  const [item] = f.review.list();
  assert.equal(item.kind, 'learning');
  assert.equal(item.payload.material, 'closed-tickets-v1');
  assert.deepEqual(item.payload.counter, { kind: 'prompt', count: 2 });
  assert.equal(item.payload.eventIds, undefined);
  assert.equal(item.payload.turnIds, undefined);
  assert.equal(f.learning.snapshot().completed, 0);
  f.review.claim({ workerId: 'w' });
  f.review.complete(item.id, { workerId: 'w', result: { memory: 1, skills: 1 } });
  assert.equal(f.learning.snapshot().completed, 1);
  f.restart();
  f.learning.recordPrompt({ scope: 'main', eventId: 'two' });
  assert.equal(f.review.list().length, 1);
  f.learning.recordPrompt({ scope: 'main', eventId: 'three' });
  f.learning.recordPrompt({ scope: 'main', eventId: 'four' });
  assert.equal(f.review.list().length, 2);
});

test('tool counter is per turn and all explicit entries share one pipeline', async t => {
  const f = await fixture(t, { toolThreshold: 2 });
  for (const turnId of ['turn-a', 'turn-b']) {
    for (let i = 0; i < 4; i++) f.learning.recordToolIteration({ scope: 's', turnId, eventId: `${turnId}:${i}` });
  }
  assert.equal(f.review.list().length, 2);
  const first = f.learning.request({ scope: 's', eventId: 'learn', entry: 'command' });
  const second = f.learning.request({ scope: 's', eventId: 'learn', entry: 'natural-language' });
  assert.equal(first.triggerId, second.triggerId);
  assert.equal(f.review.list().length, 3);
  assert.ok(f.review.list().every(row => row.kind === 'learning'));
  assert.throws(() => f.learning.recordToolIteration({ scope: 's', eventId: 'missing-turn' }), /turnId/);
});

test('outbox recovery after completed enqueue acknowledgement loss cannot duplicate a review', async t => {
  const f = await fixture(t, { promptThreshold: 1 });
  f.learning.close();
  let crashed = false;
  const wrappedReview = { get: f.review.get, enqueue(input) {
    const item = f.review.enqueue(input);
    if (!crashed) {
      crashed = true;
      f.review.claim({ workerId: 'w' });
      f.review.complete(item.id, { workerId: 'w', result: { saved: true } });
      throw new Error('simulated process crash before acknowledgement');
    }
    return item;
  } };
  const learning = createLearningCounters({ directory: f.directory, review: wrappedReview, promptThreshold: 1 });
  try {
    assert.throws(() => learning.recordPrompt({ scope: 's', eventId: 'one' }), /simulated/);
    learning.flush();
    assert.equal(f.review.list().length, 1);
    assert.equal(learning.snapshot().completed, 1);
  } finally { learning.close(); }
});

test('failed learning reviews are bounded and do not advance successful ranges', async t => {
  const f = await fixture(t, { promptThreshold: 1 });
  f.learning.recordPrompt({ scope: 's', eventId: 'one' });
  const worker = createAssistantReviewWorker({ review: f.review, maxAttempts: 2, process: async () => { throw new Error('offline'); } });
  try {
    await worker.runOnce();
    await worker.runOnce();
    assert.equal((await worker.runOnce()).claimed, 0);
    const state = f.learning.snapshot();
    assert.equal(state.completed, 0);
    assert.equal(state.triggers[0].status, 'failed');
    f.restart();
    f.learning.recordPrompt({ scope: 's', eventId: 'one' });
    assert.equal(f.review.list().length, 1);
  } finally { await worker.stop(); }
});
