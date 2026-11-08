import test from 'node:test';
import assert from 'node:assert/strict';
import { activityTask, groupHomeActivity, createActivityStore, liveActivityStates, activeActivityStates } from '../client/activity-data.mjs';

test('paused and stopping tasks do not count as active activity', () => {
  assert.equal(liveActivityStates('claimed'), true);
  for (const status of ['paused', 'pausing', 'cancelling', 'completed', 'cancelled']) assert.equal(liveActivityStates(status), false);
  for (const status of ['waiting', 'blocked', 'uncertain', 'failed']) assert.equal(activeActivityStates(status), false);
  const grouped = groupHomeActivity([
    { key: 'paused', status: 'paused', time: '2026-11-04T12:00:00Z' },
    { key: 'stopping', status: 'cancelling', time: '2026-11-04T11:00:00Z' },
    { key: 'running', status: 'claimed', time: '2026-11-04T10:00:00Z' },
  ]);
  assert.deepEqual(grouped.active.map(row => row.key), ['running']);
});

test('home uses current instruction results and separates blocked work from completed work', () => {
  const row = activityTask({ id: 'one', status: 'open', target: 'Current task', instructionRevision: 2,
    assignments: [{ instructionRevision: 1, state: 'failed' }, { instructionRevision: 2, state: 'claimed' }],
    results: [{ instructionRevision: 1, summary: 'Old delivery', version: 1 }, { instructionRevision: 2, summary: 'Current result', version: 2 }],
    deliveries: [{ state: 'sent', payload: { result: { instructionRevision: 1, version: 1 } } }],
  }, 'ticket');
  assert.equal(row.status, 'claimed');
  assert.equal(row.detail, 'Current result');
  assert.equal(row.phase, '结果已保存');
  const grouped = groupHomeActivity([row, { key: 'blocked', status: 'blocked' }, { key: 'done', status: 'completed' }, { key: 'paused', status: 'paused' }]);
  assert.deepEqual(grouped.attention.map(row => row.key), ['blocked']);
  assert.deepEqual(grouped.active.map(row => row.key), ['ticket:one']);
  assert.deepEqual(grouped.completed.map(row => row.key), ['done']);
});

test('saved results, recovery and real Worker questions have distinct states', () => {
  const base = { id: 't', status: 'waiting', instructionRevision: 2, resultVersion: 3,
    results: [{ instructionRevision: 2, version: 3, outcome: 'completed', summary: 'original result' }] };
  const pending = activityTask(base, 'ticket');
  assert.equal(pending.status, 'delivery_pending');
  assert.equal(activeActivityStates(pending.status), false);
  assert.equal(groupHomeActivity([pending]).attention.length, 1);
  const question = activityTask({ ...base, attentions: [{ id: 'a', origin: 'worker', state: 'waiting', instructionRevision: 2 }] }, 'ticket');
  assert.equal(question.status, 'awaiting_user');
  assert.equal(activeActivityStates(question.status), false);
  assert.equal(activityTask({ ...base, attentions: [{ id: 'retired', origin: 'review', state: 'waiting', instructionRevision: 2 }] }, 'ticket').status, 'delivery_pending');
  const recovery = activityTask({ ...base, continuationWait: { code: 'EXECUTION_EFFECTS_UNKNOWN', sourceResultVersion: 3 } }, 'ticket');
  assert.equal(recovery.status, 'continuation_wait');
  assert.equal(activeActivityStates(recovery.status), false);
});

function environment() {
  const document = new EventTarget(); document.hidden = false;
  const timers = new Set();
  return { document, timers, setTimeout(fn) { timers.add(fn); return fn; }, clearTimeout(fn) { timers.delete(fn); } };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('home and drawer share requests; background pages pause and last unsubscribe cleans up', async () => {
  const env = environment(), calls = [];
  const store = createActivityStore(async (action, args, signal) => { calls.push({ action, signal }); return action === 'tickets' ? { tickets: [{ id: 't', status: 'open' }] } : { goals: [] }; }, env);
  const stopHome = store.subscribe(() => {}), stopDrawer = store.subscribe(() => {});
  await flush();
  assert.deepEqual(calls.map(call => call.action), ['tickets', 'goalList']);
  assert.equal(store.getSnapshot().rows.length, 1);
  assert.equal(env.timers.size, 1);
  env.document.hidden = true; env.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(env.timers.size, 0);
  await store.refresh(); assert.equal(calls.length, 2);
  env.document.hidden = false; env.document.dispatchEvent(new Event('visibilitychange')); await flush();
  assert.equal(calls.length, 4);
  stopHome(); assert.equal(env.timers.size, 1);
  stopDrawer(); assert.equal(env.timers.size, 0);
  env.document.dispatchEvent(new Event('visibilitychange')); assert.equal(calls.length, 4);
});

test('a failed refresh keeps real prior data and exposes error, never a fake empty state', async () => {
  const env = environment(); let fail = false;
  const store = createActivityStore(async action => { if (fail) throw new Error('offline'); return action === 'tickets' ? { tickets: [{ id: 't', status: 'completed' }] } : { goals: [] }; }, env);
  const stop = store.subscribe(() => {}); await flush(); fail = true;
  await store.refresh();
  assert.equal(store.getSnapshot().rows[0].key, 'ticket:t');
  assert.equal(store.getSnapshot().error, 'offline');
  assert.equal(store.getSnapshot().loading, false); stop();
});

test('late responses after unmount cannot overwrite a new subscription', async () => {
  const env = environment(), pending = [];
  const store = createActivityStore((action, args, signal) => new Promise(resolve => pending.push({ action, signal, resolve })), env);
  const stopOld = store.subscribe(() => {}); stopOld();
  assert(pending.every(call => call.signal.aborted));
  const stopNew = store.subscribe(() => {});
  pending.slice(2).forEach(call => call.resolve(call.action === 'tickets' ? { tickets: [{ id: 'new' }] } : { goals: [] })); await flush();
  pending.slice(0, 2).forEach(call => call.resolve(call.action === 'tickets' ? { tickets: [{ id: 'old' }] } : { goals: [] })); await flush();
  assert.equal(store.getSnapshot().rows[0].id, 'new'); stopNew();
});
