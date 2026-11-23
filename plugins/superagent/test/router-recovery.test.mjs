import test from 'node:test';
import assert from 'node:assert/strict';
import { routerRecoveryEvidence, routerRecoveryRequests, inspectRouterRecovery, createRouterWatchdog } from '../src/router-recovery.mjs';

test('Router only continues interrupted work, never completed or explicitly cancelled turns', () => {
  const start = { seq: 0, type: 'turn/start', data: { turn: 1 } };
  for (const reason of [{ kind: 'completed' }, { kind: 'aborted', reason: { kind: 'user' } }, { kind: 'error' }, { kind: 'blocked' }]) {
    assert.equal(routerRecoveryEvidence([start, { seq: 1, type: 'turn/end', data: { reason } }]).needsContinuation, false);
  }
  assert.equal(routerRecoveryEvidence([start]).needsContinuation, true);
  assert.equal(routerRecoveryEvidence([start, { seq: 1, type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'disposed' } } } }]).needsContinuation, true);
});

test('unknown tool effects survive synthetic repair receipts', () => {
  const events = [{ seq: 0, type: 'tool/call', data: { callId: 'send' } }];
  assert.equal(routerRecoveryEvidence(events).unknownEffects.length, 1);
  events.push({ seq: 1, type: 'tool/result', data: { message: { toolCallId: 'send' }, error: { code: 'TOOL_OUTCOME_UNKNOWN' } } });
  assert.equal(routerRecoveryEvidence(events).unknownEffects.length, 1);
  events.push({ seq: 2, type: 'tool/result', data: { message: { source: { callId: 'send' } } } });
  assert.equal(routerRecoveryEvidence(events).unknownEffects.length, 0);
});

test('Router recovery preserves the interrupted request across successive recoveries and respects cancellation', () => {
  const start = turn => ({ type: 'turn/start', data: { turn } });
  const end = (turn, reason) => ({ type: 'turn/end', data: { turn, reason } });
  const recovery = (id, requestId) => ({ type: 'user/message', data: { id, source: { kind: 'benchgo-router-recovery', requestId } } });
  const events = [start(1), { type: 'user/message', data: { id: 'original', source: { kind: 'user' } } },
    end(1, { kind: 'interrupted' }), start(2), recovery('legacy-notice'),
    end(2, { kind: 'aborted', reason: { kind: 'disposed' } }), start(3), recovery('next-notice', 'original')];
  assert.deepEqual([...routerRecoveryRequests(events).requests], [['legacy-notice', 'original'], ['next-notice', 'original']]);
  events.push(end(3, { kind: 'aborted', reason: { kind: 'user' } }), start(4), recovery('after-cancel', 'original'));
  assert.equal(routerRecoveryRequests(events).requests.has('after-cancel'), false);
  const unrelated = [...events.slice(0, 4), recovery('unrelated', 'other')];
  assert.equal(routerRecoveryRequests(unrelated).requests.has('unrelated'), false);
  const fresh = [...events.slice(0, 4), { type: 'user/message', data: { id: 'fresh', source: { kind: 'user' } } },
    recovery('late-notice', 'original')];
  assert.equal(routerRecoveryRequests(fresh).interruptedRequestId, 'fresh');
  assert.equal(routerRecoveryRequests(fresh).requests.has('late-notice'), false);
});

test('live Router including async waits is untouched; absent Router requires exclusive writer proof', async () => {
  let opened = 0, closed = 0, live = { status: 'running' }, locked = false;
  const ctx = { agents: { get: () => live }, sessionPersistence: { open: async (id, access) => {
    opened++;
    if (locked) throw new Error('writer owned');
    return { id, access, read: async () => ({ events: [] }), close: async () => { closed++; } };
  } } };
  assert.equal((await inspectRouterRecovery({ ctx, sessionId: 'main' })).status, 'live');
  assert.equal(opened, 0);
  live = undefined; locked = true;
  await assert.rejects(inspectRouterRecovery({ ctx, sessionId: 'main' }), /writer owned/);
  locked = false;
  assert.equal((await inspectRouterRecovery({ ctx, sessionId: 'main' })).status, 'inactive');
  assert.equal(closed, 1);
});

test('watchdog serializes polls and drains an in-flight recovery on stop', async () => {
  let finish, calls = 0;
  const watchdog = createRouterWatchdog({ engine: { recoverMain: () => { calls++; return new Promise(resolve => { finish = resolve; }); } } });
  const first = watchdog.tick();
  assert.equal(watchdog.tick(), first);
  await Promise.resolve();
  assert.equal(calls, 1);
  let stopped = false;
  const stopping = watchdog.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  finish({ status: 'recovered' });
  await stopping;
  assert.equal((await watchdog.tick()).status, 'stopped');
});
