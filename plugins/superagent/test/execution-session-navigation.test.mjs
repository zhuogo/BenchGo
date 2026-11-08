import test from 'node:test';
import assert from 'node:assert/strict';
import { openExecutionSession } from '../client/execution-session-navigation.mjs';

test('active and closed Ticket entries navigate to the same official Session, restoring only historical display', async () => {
  const calls = [], ctx = { uiWorkspace: { unarchiveSession: async id => calls.push(['restore', id]), openSession: id => calls.push(['open', id]) } };
  await openExecutionSession(ctx, { available: true, sessionId: 'same', closed: false });
  await openExecutionSession(ctx, { available: true, sessionId: 'same', closed: true });
  assert.deepEqual(calls, [['open', 'same'], ['restore', 'same'], ['open', 'same']]);
});

test('missing entries and failed restore/navigation have actionable errors and never create another Session', async () => {
  await assert.rejects(openExecutionSession({}, { available: false }), /无法定位/);
  await assert.rejects(openExecutionSession({}, { available: true, sessionId: 'same' }), /入口不可用/);
  const ctx = { uiWorkspace: { unarchiveSession: async () => { throw new Error('网络中断'); }, openSession: () => assert.fail('restore must finish first') } };
  await assert.rejects(openExecutionSession(ctx, { available: true, sessionId: 'same', closed: true }), /无法恢复执行记录：网络中断/);
  ctx.uiWorkspace.openSession = () => { throw new Error('记录不存在'); };
  await assert.rejects(openExecutionSession(ctx, { available: true, sessionId: 'same' }), /无法打开执行会话：记录不存在/);
});
