import test from 'node:test';
import assert from 'node:assert/strict';
import { createActivityStore } from '../client/activity-data.mjs';
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
const row = (id, title = id) => ({ id, title, status: 'open', instructionRevision: 1 });
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
