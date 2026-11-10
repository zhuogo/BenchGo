import test from 'node:test';
import assert from 'node:assert/strict';
import { openExecutionSession } from '../client/execution-session-navigation.mjs';

test('running and completed Ticket entries open the same official Session without changing archival', async () => {
  const calls = [], ctx = { uiWorkspace: { unarchiveSession: async id => calls.push(['restore', id]), openSession: id => calls.push(['open', id]) } };
  await openExecutionSession(ctx, { available: true, sessionId: 'same', status: 'running' });
  await openExecutionSession(ctx, { available: true, sessionId: 'same', status: 'completed' });
  assert.deepEqual(calls, [['open', 'same'], ['open', 'same']]);
});

test('missing entries and failed navigation have actionable errors and never create another Session', async () => {
  await assert.rejects(openExecutionSession({}, { available: false }), /无法定位/);
  await assert.rejects(openExecutionSession({}, { available: true, sessionId: 'same' }), /入口不可用/);
  const ctx = { uiWorkspace: { openSession: () => { throw new Error('记录不存在'); } } };
  await assert.rejects(openExecutionSession(ctx, { available: true, sessionId: 'same' }), /无法打开执行会话：记录不存在/);
});
