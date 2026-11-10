import test from 'node:test';
import assert from 'node:assert/strict';
import { openExecutionSession, registerExecutionSessionDiscovery } from '../client/execution-session-navigation.mjs';

test('running and completed Ticket entries navigate to the same Session without restoring archive', async () => {
  const calls = [], ctx = { sessions: { list: { getSnapshot: () => ({ ids: ['same'] }) }, refresh: async () => calls.push(['refresh']) }, uiWorkspace: { unarchiveSession: async id => calls.push(['restore', id]), openSession: id => calls.push(['open', id]) } };
  await openExecutionSession(ctx, { available: true, sessionId: 'same', closed: false });
  await openExecutionSession(ctx, { available: true, sessionId: 'same', closed: true });
  assert.deepEqual(calls, [['refresh'], ['open', 'same'], ['refresh'], ['open', 'same']]);
});

test('missing entries and failed restore/navigation have actionable errors and never create another Session', async () => {
  await assert.rejects(openExecutionSession({}, { available: false }), /无法定位/);
  await assert.rejects(openExecutionSession({}, { available: true, sessionId: 'same' }), /入口不可用/);
  const ctx = { sessions: { list: { getSnapshot: () => ({ ids: ['same'] }) }, refresh: async () => {} }, uiWorkspace: { unarchiveSession: async () => assert.fail('navigation must never restore archive'), openSession: () => {} } };
  ctx.uiWorkspace.openSession = () => { throw new Error('记录不存在'); };
  await assert.rejects(openExecutionSession(ctx, { available: true, sessionId: 'same' }), /无法打开执行会话：记录不存在/);
  ctx.sessions.refresh = async () => { throw new Error('目录读取失败'); };
  ctx.uiWorkspace.openSession = () => assert.fail('catalog failure must stop navigation');
  await assert.rejects(openExecutionSession(ctx, { available: true, sessionId: 'same' }), /无法打开执行会话：目录读取失败/);
});

function discovery(loadSessions) {
  let listener, cleanup, refreshes = 0;
  const ctx = { remote: { $on: (name, fn) => { assert.equal(name, 'api-session/removed'); listener = fn; } },
    sessions: { list: { getSnapshot: () => ({ ids: ['active', 'first', 'second'] }) }, refresh: async () => { refreshes++; } }, effect: setup => { cleanup = setup(); } };
  registerExecutionSessionDiscovery(ctx, loadSessions);
  return { remove: id => listener(id), dispose: () => cleanup(), refreshes: () => refreshes };
}

test('removed Workers refresh the official catalog once per merged batch; completed sessions also refresh, unrelated sessions do not', async () => {
  let loads = 0;
  const f = discovery(async () => { loads++; return [{ sessionId: 'active' }, { sessionId: 'closed', closed: true }]; });
  const first = f.remove('active');
  f.remove('active'); f.remove('unrelated');
  await first;
  assert.equal(loads, 1); assert.equal(f.refreshes(), 1);
  await f.remove('closed'); await f.remove('unrelated');
  assert.equal(f.refreshes(), 3);
  f.dispose(); await f.remove('active');
  assert.equal(loads, 3);
});

test('removals during an in-flight check merge into one trailing check and unload aborts it', async () => {
  let resolveFirst, loads = 0, signal;
  const f = discovery(async currentSignal => {
    signal = currentSignal;
    if (++loads === 1) await new Promise(resolve => { resolveFirst = resolve; });
    return [{ sessionId: 'first' }, { sessionId: 'second' }];
  });
  const first = f.remove('first'); await Promise.resolve();
  f.remove('second'); f.remove('second');
  resolveFirst(); await first;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(loads, 2); assert.equal(f.refreshes(), 2);
  f.dispose(); assert.equal(signal.aborted, true);
});

test('navigation makes at most one fresh pull when an earlier catalog response still lacks the identity', async () => {
  let refreshes = 0;
  const ctx = { sessions: { list: { getSnapshot: () => ({ ids: [] }) }, refresh: async () => { refreshes++; } },
    uiWorkspace: { openSession: () => { throw new Error('sessions.retain: unknown session missing'); } } };
  await assert.rejects(openExecutionSession(ctx, { available: true, sessionId: 'missing' }), /unknown session missing/);
  assert.equal(refreshes, 2, 'a definite miss never starts a polling loop');
});

test('unloading during a pending execution lookup prevents a late catalog refresh', async () => {
  let release;
  const f = discovery(async () => { await new Promise(resolve => { release = resolve; }); return [{ sessionId: 'active' }]; });
  const pending = f.remove('active'); await Promise.resolve();
  f.dispose(); release(); await pending;
  assert.equal(f.refreshes(), 0);
});
