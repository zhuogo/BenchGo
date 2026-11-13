import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLearningCounters, maintenanceTasks } from '../src/learning-counters.mjs';
import { createAssistantReview } from '../src/review.mjs';
import { createAssistantReviewWorker } from '../src/review-worker.mjs';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-learning-'));
  let clock = 1000, review = createAssistantReview({ directory }), learning;
  const open = () => createLearningCounters({ directory, review, quietMs: 100, periodMs: 1000, now: () => clock, ...options });
  learning = open();
  t.after(async () => { learning.close(); review.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, get learning() { return learning; }, get review() { return review; }, advance(ms) { clock += ms; },
    restart() { learning.close(); review.close(); review = createAssistantReview({ directory }); learning = open(); } };
}
const finish = review => { const c = review.claim({ workerId: 'test' }); if (c.items[0]) review.complete(c.items[0].id, { workerId: 'test', result: {} }); };

test('real activity is reference-only, restart-safe, deduplicated; volume and machine output never trigger', async t => {
  const f = await fixture(t, { promptThreshold: 1, toolThreshold: 1 });
  let notices = 0;
  f.learning.onActivity(() => notices++);
  for (let index = 0; index < 12; index++) {
    f.learning.recordPrompt({ scope: 'main', eventId: `u${index}`, source: { sessionId: 'main', messageId: `u${index}`, text: 'do not copy me' } });
  }
  assert.equal(f.review.list().length, 0);
  assert.equal(notices, 12);
  assert.equal(f.learning.recordPrompt({ scope: 'main', eventId: 'auto', origin: 'maintenance' }).ignored, true);
  assert.equal(f.learning.recordPrompt({ scope: 'main', eventId: 'bot', role: 'assistant' }).ignored, true);
  assert.equal(f.learning.recordPrompt({ scope: 'main', eventId: 'machine', source: { kind: 'machine' } }).ignored, true);
  const db = new DatabaseSync(join(f.directory, 'assistant.db'));
  assert.ok(db.prepare('SELECT source FROM assistant_maintenance_activity').all().every(row => !row.source.includes('do not copy me')));
  db.close();
  f.restart();
  assert.equal(f.learning.recordPrompt({ scope: 'main', eventId: 'u0' }).deduplicated, true);
  assert.equal(f.learning.snapshot().events[0].count, 12);
  assert.equal(f.learning.isQuiet(), false);
  f.advance(100);
  const scheduled = f.learning.scheduleDue();
  assert.deepEqual(scheduled.scheduled.map(row => row.task), maintenanceTasks);
  assert.equal(f.review.list()[0].payload.trigger, 'quiet');
  assert.equal(f.learning.scheduleDue().scheduled.length, 0);
});

test('explicit entries share one durable pipeline even after enqueue acknowledgement loss', async t => {
  const f = await fixture(t);
  f.learning.close();
  let crashed = false;
  const wrapped = { get: f.review.get, enqueue(input) {
    const item = f.review.enqueue(input);
    if (!crashed) { crashed = true; finish(f.review); throw new Error('simulated acknowledgement loss'); }
    return item;
  } };
  const learning = createLearningCounters({ directory: f.directory, review: wrapped });
  try {
    assert.throws(() => learning.request({ scope: 's', eventId: 'learn', entry: 'command' }), /simulated/);
    const result = learning.request({ scope: 's', eventId: 'learn', entry: 'natural-language' });
    assert.equal(result.reviews[0].status, 'completed');
    assert.equal(f.review.list().length, 1);
    assert.equal(learning.snapshot().completed, 1);
  } finally { learning.close(); }
});

test('one periodic schedule covers five responsibilities and survives restart without duplicate jobs', async t => {
  const f = await fixture(t);
  f.advance(1000);
  assert.deepEqual(f.learning.scheduleDue().scheduled.map(row => row.task), maintenanceTasks);
  f.restart();
  assert.equal(f.learning.scheduleDue().scheduled.length, 0);
  assert.equal(f.review.list().length, 5);
  assert.equal(f.review.list().filter(row => row.kind === 'learning').length, 1);
  assert.equal(f.review.list().filter(row => row.kind === 'maintenance').length, 4);
});

test('quiet and periodic work consume the same bounded reference batch, while tasks retain independent watermarks', async t => {
  const f = await fixture(t);
  for (const eventId of ['a', 'b', 'c']) f.learning.recordActivity({ scope: 's', eventId, source: { threadId: 'thread' } });
  const readSources = async ({ references, limit, maxChars }) => {
    assert.equal(limit, 2); assert.equal(maxChars, 2000);
    return references.map(ref => ({ id: ref.messageId, kind: 'user', text: `official ${ref.messageId}`, source: ref }));
  };
  const first = await f.learning.takeSources({ limit: 2, maxChars: 2000, readSources });
  assert.equal(first.items.length, 2); assert.equal(first.hasMore, true);
  f.restart();
  const retry = await f.learning.takeSources({ limit: 2, maxChars: 2000, readSources, batchKey: 'periodic-job' });
  assert.equal(retry.batchId, first.batchId);
  assert.deepEqual(retry.references.map(row => row.messageId), ['a', 'b']);
  assert.equal(f.learning.completeSources(first.batchId).nextSeq, 2);
  assert.equal(f.learning.completeSources(first.batchId).idempotent, true);
  const next = await f.learning.takeSources({ limit: 2, maxChars: 2000, readSources });
  assert.deepEqual(next.references.map(row => row.messageId), ['c']);
  f.learning.completeSources(next.batchId);
  const empty = await f.learning.takeSources({ limit: 2, maxChars: 2000, readSources });
  assert.equal(empty.items.length, 0);
  const other = await f.learning.takeSources({ task: 'relationships', limit: 2, maxChars: 2000, readSources });
  assert.deepEqual(other.references.map(row => row.messageId), ['a', 'b']);
});

test('cancellation and oversized material never advance a source watermark', async t => {
  const f = await fixture(t);
  f.learning.recordActivity({ scope: 's', eventId: 'a' });
  const controller = new AbortController();
  await assert.rejects(f.learning.takeSources({ signal: controller.signal, readSources: async () => { controller.abort(); return []; } }), { name: 'AbortError' });
  assert.equal(f.learning.status().cursors['memory-upkeep'], 0);
  await assert.rejects(f.learning.takeSources({ maxChars: 1000, readSources: async () => [{ text: 'x'.repeat(2000) }] }), /预算/);
  assert.equal(f.learning.status().cursors['memory-upkeep'], 0);
  const next = await f.learning.takeSources({ readSources: async ({ references }) => references.map(ref => ({ id: ref.messageId, text: 'official' })) });
  assert.equal(next.references[0].messageId, 'a');
});

test('material fingerprints are durable per task and reject unbounded metadata', async t => {
  const f = await fixture(t);
  const fingerprint = 'a'.repeat(64);
  assert.equal(f.learning.getTaskFingerprint('dreaming'), null);
  f.learning.setTaskFingerprint('dreaming', fingerprint);
  f.restart();
  assert.equal(f.learning.getTaskFingerprint('dreaming'), fingerprint);
  assert.equal(f.learning.getTaskFingerprint('relationships'), null);
  assert.throws(() => f.learning.setTaskFingerprint('dreaming', 'raw source text'), /指纹/);
  assert.throws(() => f.learning.getTaskFingerprint('unknown'), /task/);
});

test('bounded readers consume only the covered reference prefix and preserve unseen tail across restart', async t => {
  const f = await fixture(t);
  for (const eventId of ['a', 'b', 'c']) f.learning.recordActivity({ scope: 's', eventId });
  const first = await f.learning.takeSources({ readSources: async ({ references }) => ({ items: [{ id: references[0].messageId, text: 'official' }], consumedReferences: 1 }) });
  assert.equal(first.hasMore, true);
  assert.deepEqual(first.references.map(row => row.messageId), ['a']);
  f.restart();
  const retry = await f.learning.takeSources({ readSources: async ({ references }) => references.map(row => ({ id: row.messageId, text: 'official' })) });
  assert.equal(first.batchId, retry.batchId);
  assert.deepEqual(retry.references.map(row => row.messageId), ['a']);
  assert.equal(f.learning.completeSources(first.batchId).nextSeq, 1);
  const second = await f.learning.takeSources({ readSources: async ({ references }) => references.map(row => ({ id: row.messageId, text: 'official' })) });
  assert.deepEqual(second.references.map(row => row.messageId), ['b', 'c']);
  await assert.rejects(f.learning.takeSources({ readSources: async () => ({ items: [], consumedReferences: 0 }) }), /尚未就绪/);
  assert.equal(f.learning.status().cursors['memory-upkeep'], 1);
});

test('every responsibility continues bounded cursor debt on the next shared tick without waiting a new period', async t => {
  const f = await fixture(t);
  for (const eventId of ['a', 'b', 'c']) f.learning.recordActivity({ scope: 's', eventId });
  f.advance(100);
  const seen = new Map(maintenanceTasks.map(task => [task, []]));
  const worker = createAssistantReviewWorker({ review: f.review, beforeRun: () => f.learning.scheduleDue(), process: async item => {
    const task = item.payload.task;
    const batch = await f.learning.takeSources({ task, limit: 1, batchKey: item.id,
      readSources: async ({ references }) => references.map(ref => ({ id: ref.messageId, text: 'official' })) });
    seen.get(task).push(...batch.references.map(ref => ref.messageId));
    f.learning.completeSources(batch.batchId);
    return { modelUsed: false, hasMore: batch.hasMore };
  } });
  for (let tick = 0; tick < 15; tick++) assert.equal((await worker.runOnce()).completed, 1);
  assert.equal((await worker.runOnce()).claimed, 0);
  assert.deepEqual(f.learning.status().cursors, Object.fromEntries(maintenanceTasks.map(task => [task, 3])));
  for (const references of seen.values()) assert.deepEqual(references, ['a', 'b', 'c']);
  assert.equal(f.review.budget().used, 0);
  await worker.stop();
});
