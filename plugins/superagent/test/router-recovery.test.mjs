import test from 'node:test';
import assert from 'node:assert/strict';
import { routerRecoveryEvidence, inspectRouterRecovery, createRouterWatchdog } from '../src/router-recovery.mjs';

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
