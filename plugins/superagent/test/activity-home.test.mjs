import test from 'node:test';
import assert from 'node:assert/strict';
import { activityTask, groupHomeActivity, createActivityStore, liveActivityStates, activeActivityStates, archivedActivityTicket, boardTicketRows } from '../client/activity-data.mjs';

test('chat board counts only distinct visible running and waiting tickets', () => {
  const ticket = (id, status, extra = {}) => ({ id, kind: 'ticket', status, ...extra });
  const rows = [ticket('running', 'running'), ticket('waiting', 'waiting'), ticket('done', 'completed'),
    ticket('archived', 'waiting', { archived: true }), ticket('cleaned', 'waiting', { cleanup: { id: 'receipt' } }),
    ticket('hidden', 'running', { taskMeta: { archived: true } }), ticket('deleted', 'waiting', { taskMeta: { deleted: true } }),
    { id: 'goal', kind: 'goal', status: 'active' }, ticket('waiting', 'waiting')];
  assert.deepEqual(boardTicketRows(rows).map(row => row.id), ['running', 'waiting']);
  rows[0].status = 'completed'; rows[1].status = 'completed'; rows.at(-1).status = 'completed';
  assert.equal(boardTicketRows(rows).length, 0);
});

test('paused and stopping tasks do not count as active activity', () => {
  assert.equal(liveActivityStates('running'), true);
  for (const status of ['paused', 'pausing', 'cancelling', 'completed', 'cancelled']) assert.equal(liveActivityStates(status), false);
  for (const status of ['waiting', 'blocked', 'uncertain', 'failed']) assert.equal(activeActivityStates(status), false);
  const grouped = groupHomeActivity([
    { key: 'paused', status: 'paused', time: '2026-11-04T12:00:00Z' },
    { key: 'stopping', status: 'cancelling', time: '2026-11-04T11:00:00Z' },
    { key: 'running', status: 'running', time: '2026-11-04T10:00:00Z' },
  ]);
  assert.deepEqual(grouped.active.map(row => row.key), ['running']);
});

test('home uses current instruction results and separates blocked work from completed work', () => {
  const row = activityTask({ id: 'one', status: 'running', target: 'Current task', instructionRevision: 2,
    assignments: [{ instructionRevision: 1, state: 'failed' }, { instructionRevision: 2, state: 'claimed' }],
    results: [{ instructionRevision: 1, summary: 'Old delivery', version: 1 }, { instructionRevision: 2, summary: 'Current result', version: 2 }],
    deliveries: [{ state: 'sent', payload: { result: { instructionRevision: 1, version: 1 } } }],
  }, 'ticket');
  assert.equal(row.status, 'running');
  assert.equal(row.detail, 'Current result');
  assert.equal(row.phase, '结果已保存');
  const grouped = groupHomeActivity([row, { key: 'blocked', status: 'blocked' }, { key: 'done', status: 'completed' }, { key: 'paused', status: 'paused' }]);
  assert.deepEqual(grouped.attention.map(row => row.key), ['blocked']);
  assert.deepEqual(grouped.active.map(row => row.key), ['ticket:one']);
  assert.deepEqual(grouped.completed.map(row => row.key), ['done']);
});

test('archived tickets leave current activity while the home keeps a small completed review', () => {
  const failed = activityTask({ id: 'failed', status: 'waiting', archived: true }, 'ticket');
  const done = activityTask({ id: 'done', status: 'completed' }, 'ticket');
  const waiting = activityTask({ id: 'waiting', status: 'waiting' }, 'ticket');
  const stopped = activityTask({ id: 'stopped', status: 'waiting', executionControl: { stopped: true } }, 'ticket');
  assert.equal(archivedActivityTicket(failed), true);
  assert.equal(archivedActivityTicket(done), false);
  assert.equal(archivedActivityTicket(waiting), false);
  assert.equal(archivedActivityTicket(stopped), false);
  assert.equal(archivedActivityTicket({ kind: 'goal', status: 'completed' }), false);
  const grouped = groupHomeActivity([failed, done, waiting, stopped]);
  assert.deepEqual(grouped.attention.map(row => row.id), ['waiting', 'stopped']);
  assert.deepEqual(grouped.completed.map(row => row.id), ['done']);
});

test('cleanup metadata passes through activity projection and restoring display preserves terminal facts', () => {
  const base = { id: 'stopped', status: 'waiting', executionControl: { stopped: true }, instructionRevision: 2, resultVersion: 3,
    results: [{ instructionRevision: 2, version: 3, summary: '保留的执行结果' }] };
  for (const metadata of [
    { archived: true },
    { cleanup: { id: 'cleanup-1', archivedAt: '2026-11-10T02:00:00Z', version: 5 } },
    { taskMeta: { version: 5, archived: true, cleanupReceiptId: 'cleanup-1' } },
  ]) {
    const source = { ...base, ...metadata }, projected = activityTask(source, 'ticket');
    assert.equal(archivedActivityTicket(projected), true);
    assert.equal(projected.status, 'waiting');
    assert.equal(projected.domainStatus, 'waiting');
    assert.equal(projected.instructionRevision, 2);
    assert.equal(projected.resultVersion, 3);
    assert.strictEqual(projected.results, source.results);
    for (const key of Object.keys(metadata)) assert.strictEqual(projected[key], source[key]);
    assert.equal(archivedActivityTicket(activityTask(source, 'goal')), false);
  }
  const restored = activityTask({ ...base, archived: false, cleanup: null, taskMeta: { version: 6, archived: false } }, 'ticket');
  assert.equal(archivedActivityTicket(restored), false);
  assert.equal(restored.status, 'waiting');
  assert.equal(restored.instructionRevision, 2);
  assert.strictEqual(restored.results, base.results);
  const completed = activityTask({ ...restored, status: 'completed', domainStatus: 'completed' }, 'ticket');
  assert.equal(archivedActivityTicket(completed), false);
  assert.equal(activeActivityStates(completed.status), false);
});

test('saved results, recovery and real Worker questions retain the waiting state', () => {
  const base = { id: 't', status: 'waiting', instructionRevision: 2, resultVersion: 3,
    results: [{ instructionRevision: 2, version: 3, outcome: 'completed', summary: 'original result' }] };
  const pending = activityTask(base, 'ticket');
  assert.equal(pending.status, 'waiting');
  assert.equal(activeActivityStates(pending.status), false);
  assert.equal(groupHomeActivity([pending]).attention.length, 1);
  const question = activityTask({ ...base, attentions: [{ id: 'a', origin: 'worker', state: 'waiting', instructionRevision: 2 }] }, 'ticket');
  assert.equal(question.status, 'waiting');
  assert.equal(activeActivityStates(question.status), false);
  assert.equal(activityTask({ ...base, attentions: [{ id: 'retired', origin: 'review', state: 'waiting', instructionRevision: 2 }] }, 'ticket').status, 'waiting');
  const recovery = activityTask({ ...base, continuationWait: { code: 'EXECUTION_EFFECTS_UNKNOWN', sourceResultVersion: 3 } }, 'ticket');
  assert.equal(recovery.status, 'waiting');
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
  const store = createActivityStore(async (action, args, signal) => { calls.push({ action, args, signal }); return action === 'tickets' ? { tickets: args.archived ? [{ id: 'done', status: 'completed' }] : [{ id: 't', status: 'running' }] } : { goals: [] }; }, env);
  const stopHome = store.subscribe(() => {}), stopDrawer = store.subscribe(() => {});
  await flush();
  assert.deepEqual(calls.map(call => call.action), ['tickets', 'tickets', 'goalList']);
  assert.deepEqual(calls[0].args, { archived: false });
  assert.deepEqual(calls[1].args, { archived: true });
  assert.equal(store.getSnapshot().rows.length, 2);
  assert.equal(env.timers.size, 1);
  env.document.hidden = true; env.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(env.timers.size, 0);
  await store.refresh(); assert.equal(calls.length, 3);
  env.document.hidden = false; env.document.dispatchEvent(new Event('visibilitychange')); await flush();
  assert.equal(calls.length, 6);
  stopHome(); assert.equal(env.timers.size, 1);
  stopDrawer(); assert.equal(env.timers.size, 0);
  env.document.dispatchEvent(new Event('visibilitychange')); assert.equal(calls.length, 6);
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
  pending.slice(3).forEach(call => call.resolve(call.action === 'tickets' ? { tickets: [{ id: 'new' }] } : { goals: [] })); await flush();
  pending.slice(0, 3).forEach(call => call.resolve(call.action === 'tickets' ? { tickets: [{ id: 'old' }] } : { goals: [] })); await flush();
  assert.equal(store.getSnapshot().rows[0].id, 'new'); stopNew();
});
