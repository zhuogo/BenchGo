import test from 'node:test';
import assert from 'node:assert/strict';
import { archivedActivityTicket, createActivityStore } from '../client/activity-data.mjs';
import { transientRefreshError } from '../client/refresh-error.mjs';
const flush = () => new Promise(resolve => setImmediate(resolve));
function setup(api) {
  const document = new EventTarget(); document.hidden = false;
  const timers = new Map(); let sink, starts = 0, restarts = 0, disposed = 0;
  const store = createActivityStore(api, { document, setTimeout(fn, ms) { timers.set(fn, ms); return fn; }, clearTimeout(fn) { timers.delete(fn); },
    connect(value) { sink = value; return { start() { starts++; }, restart() { restarts++; }, dispose() { disposed++; } }; } });
  const stop = store.subscribe(() => {});
  return { store, stop, document, timers, get sink() { return sink; }, get starts() { return starts; }, get restarts() { return restarts; }, get disposed() { return disposed; },
    run(ms) { const entry = [...timers].find(([, delay]) => delay === ms); if (entry) { timers.delete(entry[0]); entry[0](); } } };
}
const row = (id, title = id) => ({ id, title, status: 'running', instructionRevision: 1 });
test('official baseline supplies tickets directly; healthy streams never schedule full pulls', async () => {
  const calls = [], h = setup(async (name, args) => { calls.push([name, args]); return name === 'goalList' ? { goals: [] } : { tickets: [row(args.ticketId, '更新')] }; });
  h.sink.replace({ cursor: 3, tickets: [row('a'), row('b')] }); await flush();
  assert.deepEqual(calls.map(([name]) => name), ['goalList']); assert.equal(h.timers.size, 0);
  const before = h.store.getSnapshot().rows, stable = before[1];
  h.sink.update({ cursor: 5, entries: [{ seq: 4, ticketId: 'a', kind: 'tool/call' }, { seq: 5, ticketId: 'a', kind: 'tool/result' }] });
  h.run(80); await flush();
  assert.equal(calls.filter(([name]) => name === 'tickets').length, 1);
  assert.deepEqual(calls.at(-1)[1], { ticketId: 'a' });
  assert.strictEqual(h.store.getSnapshot().rows[1], stable); assert.equal(h.store.getSnapshot().loading, false);
  h.sink.update({ cursor: 5, entries: [{ seq: 4, ticketId: 'a', kind: 'tool/call' }, { seq: 5, ticketId: 'a', kind: 'tool/result' }] });
  assert.equal(h.timers.size, 0); h.stop(); assert.equal(h.disposed, 1);
});
test('archive and restore presentation events refresh only the touched ticket without changing execution facts', async () => {
  const base = { ...row('a'), status: 'waiting', executionControl: { stopped: true }, instructionRevision: 2, resultVersion: 3,
    results: [{ instructionRevision: 2, version: 3, summary: '保留的执行结果' }], taskMeta: { version: 4 } };
  let current = base;
  const calls = [], h = setup(async (name, args) => {
    calls.push([name, args]);
    return name === 'goalList' ? { goals: [] } : { tickets: [current] };
  });
  try {
    h.sink.replace({ cursor: 0, tickets: [base, row('b')] }); await flush();
    const stable = h.store.getSnapshot().rows.find(value => value.id === 'b');
    assert.equal(archivedActivityTicket(h.store.getSnapshot().rows[0]), false);
    for (const [seq, metadata, archived] of [
      [1, { archived: true, cleanup: { id: 'cleanup-1', version: 5 }, taskMeta: { version: 5, archived: true, cleanupReceiptId: 'cleanup-1' } }, true],
      [2, { archived: false, cleanup: null, taskMeta: { version: 6, archived: false } }, false],
    ]) {
      current = { ...base, ...metadata };
      h.sink.update({ cursor: seq, entries: [{ seq, ticketId: 'a', kind: 'presentation' }] }); h.run(80); await flush();
      const projected = h.store.getSnapshot().rows.find(value => value.id === 'a');
      assert.equal(archivedActivityTicket(projected), archived);
      assert.deepEqual(projected.cleanup, current.cleanup);
      assert.deepEqual(projected.taskMeta, current.taskMeta);
      assert.equal(projected.status, 'waiting');
      assert.equal(projected.instructionRevision, base.instructionRevision);
      assert.equal(projected.resultVersion, base.resultVersion);
      assert.deepEqual(projected.results, base.results);
      assert.strictEqual(h.store.getSnapshot().rows.find(value => value.id === 'b'), stable);
      assert.equal(h.store.getSnapshot().error, '');
      assert.equal(h.timers.size, 0);
    }
    assert.deepEqual(calls, [['goalList', {}], ['tickets', { ticketId: 'a' }], ['tickets', { ticketId: 'a' }]]);
  } finally { h.stop(); }
});
test('gaps trigger one replacement snapshot and generations reject old ticket responses', async () => {
  const pending = [], h = setup((name, args) => name === 'goalList' ? Promise.resolve({ goals: [] }) : new Promise(resolve => pending.push({ args, resolve })));
  h.sink.replace({ cursor: 0, tickets: [row('a')] }); await flush();
  h.sink.update({ cursor: 1, entries: [{ seq: 1, ticketId: 'a', kind: 'execution' }] }); h.run(80);
  h.sink.update({ cursor: 3, entries: [{ seq: 3, ticketId: 'a', kind: 'execution' }] });
  assert.equal(h.restarts, 1); assert.equal(h.store.getSnapshot().connection, 'reconnecting');
  h.sink.replace({ cursor: 3, tickets: [row('a', '服务重启后的事实')] }); await flush();
  pending[0].resolve({ tickets: [row('a', '旧响应')] }); await flush();
  assert.equal(h.store.getSnapshot().rows[0].title, '服务重启后的事实'); h.stop();
});
test('a newer event invalidates in-flight reads before its coalescing window ends', async () => {
  const pending = [], h = setup((name, args) => name === 'goalList' ? Promise.resolve({ goals: [] }) : new Promise(resolve => pending.push({ args, resolve })));
  h.sink.replace({ cursor: 0, tickets: [row('a')] }); await flush();
  h.sink.update({ cursor: 1, entries: [{ seq: 1, ticketId: 'a', kind: 'execution' }] }); h.run(80);
  h.sink.update({ cursor: 2, entries: [{ seq: 2, ticketId: 'a', kind: 'execution' }] });
  pending[0].resolve({ tickets: [row('a', '旧')] }); await flush();
  assert.equal(h.store.getSnapshot().rows[0].title, 'a');
  h.run(80); pending[1].resolve({ tickets: [row('a', '新')] }); await flush();
  assert.equal(h.store.getSnapshot().rows[0].title, '新'); h.stop();
});
test('disconnect retains facts, fallback backs off, visibility and resubscribe recover', async () => {
  const calls = [], h = setup(async name => { calls.push(name); throw new Error('offline'); });
  h.sink.replace({ cursor: 0, tickets: [row('a')] }); await flush();
  h.sink.carrierFailed(new Error('断线')); assert.equal(h.store.getSnapshot().rows[0].id, 'a');
  h.run(10000); await flush(); assert([...h.timers.values()].includes(20000));
  h.document.hidden = true; h.document.dispatchEvent(new Event('visibilitychange')); assert.equal(h.timers.size, 0);
  h.document.hidden = false; h.document.dispatchEvent(new Event('visibilitychange')); assert.equal(h.restarts, 1);
  h.sink.replace({ cursor: 0, tickets: [row('b')] }); await flush(); assert.equal(h.store.getSnapshot().rows[0].id, 'b');
  h.stop(); const stop = h.store.subscribe(() => {}); assert.equal(h.starts, 2); stop();
});

test('disposed subscriptions cannot publish late baselines into a reopened view', async () => {
  const h = setup(async () => ({ goals: [] })), old = h.sink;
  old.replace({ cursor: 1, tickets: [row('old')] }); await flush(); h.stop();
  const stop = h.store.subscribe(() => {});
  h.sink.replace({ cursor: 0, bootId: 'restarted', tickets: [row('new')] }); await flush();
  old.replace({ cursor: 9, tickets: [row('late')] }); await flush();
  assert.equal(h.store.getSnapshot().rows[0].id, 'new'); stop();
});

test('background carrier and ticket retries retain snapshots silently; manual and domain failures remain visible', async () => {
  let failure, title = '原记录';
  const h = setup(async (name, args) => {
    if (name === 'goalList') return { goals: [] };
    if (failure) throw failure;
    return { tickets: [row(args.ticketId, title)] };
  });
  h.sink.replace({ cursor: 0, tickets: [row('a', title), row('b')] }); await flush();
  const previous = h.store.getSnapshot().rows;
  h.sink.carrierFailed(new Error('载体断线'));
  assert.strictEqual(h.store.getSnapshot().rows, previous);
  assert.equal(h.store.getSnapshot().error, '');
  assert.equal(h.store.getSnapshot().lastFailure.message, '载体断线');
  h.sink.replace({ cursor: 0, tickets: [row('a', title), row('b')] }); await flush();
  failure = new TypeError('Failed to fetch');
  h.sink.update({ cursor: 1, entries: [{ seq: 1, ticketId: 'a', kind: 'execution' }] }); h.run(80); await flush();
  assert.equal(h.store.getSnapshot().error, '');
  assert.equal(h.store.getSnapshot().rows[0].title, title);
  assert.equal(h.store.getSnapshot().lastFailure.source, 'ticket:a');
  assert([...h.timers.values()].some(delay => delay >= 10000 && delay <= 60000));
  await h.store.refreshTickets(['a']);
  assert.equal(h.store.getSnapshot().error, 'Failed to fetch');
  failure = new Error('工单版本冲突');
  h.sink.update({ cursor: 2, entries: [{ seq: 2, ticketId: 'a', kind: 'execution' }] }); h.run(10000); await flush();
  await h.store.refreshTickets(['a'], false);
  assert.equal(h.store.getSnapshot().error, '工单版本冲突');
  failure = null; title = '恢复后的记录'; await h.store.refreshTickets(['b']);
  assert.equal(h.store.getSnapshot().error, '工单版本冲突', 'unrelated success cannot hide a domain error');
  await h.store.refreshTickets(['a']);
  assert.equal(h.store.getSnapshot().error, '');
  assert.equal(h.store.getSnapshot().rows[0].title, title); h.stop();
});

test('first snapshot and terminal stream failures expose the actual error', async () => {
  const h = setup(async () => ({ goals: [] }));
  h.sink.carrierFailed(new Error('首次连接失败'));
  assert.equal(h.store.getSnapshot().rows, null);
  assert.equal(h.store.getSnapshot().error, '首次连接失败');
  h.sink.replace({ cursor: 0, tickets: [] }); await flush();
  h.sink.failed(new Error('执行事实协议不兼容'));
  assert.equal(h.store.getSnapshot().error, '执行事实协议不兼容'); h.stop();
});

test('silent refresh only recognizes transport failures and never domain, authentication or malformed-response errors', () => {
  for (const status of [408, 425, 429, 502, 503, 504]) assert(transientRefreshError(Object.assign(new Error('temporary'), { code: 'HTTP_ERROR', status })));
  for (const status of [400, 401, 403, 404, 409, 422, 500]) assert.equal(transientRefreshError(Object.assign(new Error('domain'), { code: 'HTTP_ERROR', status })), false);
  assert.equal(transientRefreshError(Object.assign(new Error('bad response'), { code: 'INVALID_JSON_RESPONSE' })), false);
  assert.equal(transientRefreshError(new Error('offline')), false);
});

test('a ticket baseline cannot disguise the first failed goal read; bounded retry recovers that resource', async () => {
  let fail = true;
  const h = setup(async () => { if (fail) throw new TypeError('Failed to fetch'); return { goals: [] }; });
  h.sink.replace({ cursor: 0, tickets: [] }); await flush();
  assert.equal(h.store.getSnapshot().error, 'Failed to fetch');
  fail = false; h.run(10000); await flush();
  assert.equal(h.store.getSnapshot().error, ''); h.stop();
});
