import test from 'node:test';
import assert from 'node:assert/strict';
import { archivedActivityTask, createActivityStore } from '../client/activity-data.mjs';
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
test('official baseline supplies tasks directly; healthy streams never schedule full pulls', async () => {
  const calls = [], h = setup(async (name, args) => { calls.push([name, args]); return name === 'goalList' ? { goals: [] } : { tasks: [row(args.taskId, '更新')] }; });
  h.sink.replace({ cursor: 3, tasks: [row('a'), row('b')] }); await flush();
  assert.deepEqual(calls.map(([name]) => name), ['goalList']); assert.equal(h.timers.size, 0);
  const before = h.store.getSnapshot().rows, stable = before[1];
  h.sink.update({ cursor: 5, entries: [{ seq: 4, taskId: 'a', kind: 'tool/call' }, { seq: 5, taskId: 'a', kind: 'tool/result' }] });
  h.run(80); await flush();
  assert.equal(calls.filter(([name]) => name === 'tasks').length, 1);
  assert.deepEqual(calls.at(-1)[1], { taskId: 'a' });
  assert.strictEqual(h.store.getSnapshot().rows[1], stable); assert.equal(h.store.getSnapshot().loading, false);
  h.sink.update({ cursor: 5, entries: [{ seq: 4, taskId: 'a', kind: 'tool/call' }, { seq: 5, taskId: 'a', kind: 'tool/result' }] });
  assert.equal(h.timers.size, 0); h.stop(); assert.equal(h.disposed, 1);
});
test('archive and restore presentation events refresh only the touched task without changing execution facts', async () => {
  const base = { ...row('a'), status: 'waiting', executionControl: { stopped: true }, instructionRevision: 2, resultVersion: 3,
    results: [{ instructionRevision: 2, version: 3, summary: '保留的执行结果' }], taskMeta: { version: 4 } };
  let current = base;
  const calls = [], h = setup(async (name, args) => {
    calls.push([name, args]);
    return name === 'goalList' ? { goals: [] } : { tasks: [current] };
  });
  try {
    h.sink.replace({ cursor: 0, tasks: [base, row('b')] }); await flush();
    const stable = h.store.getSnapshot().rows.find(value => value.id === 'b');
    assert.equal(archivedActivityTask(h.store.getSnapshot().rows[0]), false);
    for (const [seq, metadata, archived] of [
      [1, { archived: true, cleanup: { id: 'cleanup-1', version: 5 }, taskMeta: { version: 5, archived: true, cleanupReceiptId: 'cleanup-1' } }, true],
      [2, { archived: false, cleanup: null, taskMeta: { version: 6, archived: false } }, false],
    ]) {
      current = { ...base, ...metadata };
      h.sink.update({ cursor: seq, entries: [{ seq, taskId: 'a', kind: 'presentation' }] }); h.run(80); await flush();
      const projected = h.store.getSnapshot().rows.find(value => value.id === 'a');
      assert.equal(archivedActivityTask(projected), archived);
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
    assert.deepEqual(calls, [['goalList', {}], ['tasks', { taskId: 'a' }], ['tasks', { taskId: 'a' }]]);
  } finally { h.stop(); }
});
test('gaps trigger one replacement snapshot and generations reject old task responses', async () => {
  const pending = [], h = setup((name, args) => name === 'goalList' ? Promise.resolve({ goals: [] }) : new Promise(resolve => pending.push({ args, resolve })));
  h.sink.replace({ cursor: 0, tasks: [row('a')] }); await flush();
  h.sink.update({ cursor: 1, entries: [{ seq: 1, taskId: 'a', kind: 'execution' }] }); h.run(80);
  h.sink.update({ cursor: 3, entries: [{ seq: 3, taskId: 'a', kind: 'execution' }] });
  assert.equal(h.restarts, 1); assert.equal(h.store.getSnapshot().connection, 'reconnecting');
  h.sink.replace({ cursor: 3, tasks: [row('a', '服务重启后的事实')] }); await flush();
  pending[0].resolve({ tasks: [row('a', '旧响应')] }); await flush();
  assert.equal(h.store.getSnapshot().rows[0].title, '服务重启后的事实'); h.stop();
});
test('a newer event invalidates in-flight reads before its coalescing window ends', async () => {
  const pending = [], h = setup((name, args) => name === 'goalList' ? Promise.resolve({ goals: [] }) : new Promise(resolve => pending.push({ args, resolve })));
  h.sink.replace({ cursor: 0, tasks: [row('a')] }); await flush();
  h.sink.update({ cursor: 1, entries: [{ seq: 1, taskId: 'a', kind: 'execution' }] }); h.run(80);
  h.sink.update({ cursor: 2, entries: [{ seq: 2, taskId: 'a', kind: 'execution' }] });
  pending[0].resolve({ tasks: [row('a', '旧')] }); await flush();
  assert.equal(h.store.getSnapshot().rows[0].title, 'a');
  h.run(80); pending[1].resolve({ tasks: [row('a', '新')] }); await flush();
  assert.equal(h.store.getSnapshot().rows[0].title, '新'); h.stop();
});
test('disconnect retains facts, fallback backs off, visibility and resubscribe recover', async () => {
  const calls = [], h = setup(async name => { calls.push(name); throw new Error('offline'); });
  h.sink.replace({ cursor: 0, tasks: [row('a')] }); await flush();
  h.sink.carrierFailed(new Error('断线')); assert.equal(h.store.getSnapshot().rows[0].id, 'a');
  h.run(10000); await flush(); assert([...h.timers.values()].includes(20000));
  h.document.hidden = true; h.document.dispatchEvent(new Event('visibilitychange')); assert.equal(h.timers.size, 0);
  h.document.hidden = false; h.document.dispatchEvent(new Event('visibilitychange')); assert.equal(h.restarts, 1);
  h.sink.replace({ cursor: 0, tasks: [row('b')] }); await flush(); assert.equal(h.store.getSnapshot().rows[0].id, 'b');
  h.stop(); const stop = h.store.subscribe(() => {}); assert.equal(h.starts, 2); stop();
});

test('disposed subscriptions cannot publish late baselines into a reopened view', async () => {
  const h = setup(async () => ({ goals: [] })), old = h.sink;
  old.replace({ cursor: 1, tasks: [row('old')] }); await flush(); h.stop();
  const stop = h.store.subscribe(() => {});
  h.sink.replace({ cursor: 0, bootId: 'restarted', tasks: [row('new')] }); await flush();
  old.replace({ cursor: 9, tasks: [row('late')] }); await flush();
  assert.equal(h.store.getSnapshot().rows[0].id, 'new'); stop();
});

test('replacing the plugin transport retains task facts and fences the retired context callbacks', async () => {
  const h = setup(async () => ({ goals: [] })), retired = h.sink;
  retired.replace({ cursor: 3, tasks: [row('saved')] }); await flush();
  const previous = h.store.getSnapshot().rows;
  let replacement, starts = 0, disposed = 0;
  h.store.setEnvironment({ connect(sink) {
    replacement = sink;
    return { start() { starts++; }, restart() {}, dispose() { disposed++; } };
  } });
  assert.equal(starts, 1);
  assert.equal(h.disposed, 1);
  assert.strictEqual(h.store.getSnapshot().rows, previous);
  retired.failed(new Error('cannot create effect on inactive context'));
  retired.replace({ cursor: 9, tasks: [row('retired')] });
  assert.equal(h.store.getSnapshot().error, '');
  assert.strictEqual(h.store.getSnapshot().rows, previous);
  replacement.replace({ cursor: 0, tasks: [row('replacement')] }); await flush();
  assert.equal(h.store.getSnapshot().rows[0].id, 'replacement');
  assert.equal(h.store.getSnapshot().connection, 'live');
  assert.equal(h.timers.size, 0);
  h.stop(); assert.equal(disposed, 1);
});

test('background carrier and task retries retain snapshots silently; manual and domain failures remain visible', async () => {
  let failure, title = '原记录';
  const h = setup(async (name, args) => {
    if (name === 'goalList') return { goals: [] };
    if (failure) throw failure;
    return { tasks: [row(args.taskId, title)] };
  });
  h.sink.replace({ cursor: 0, tasks: [row('a', title), row('b')] }); await flush();
  const previous = h.store.getSnapshot().rows;
  h.sink.carrierFailed(new Error('载体断线'));
  assert.strictEqual(h.store.getSnapshot().rows, previous);
  assert.equal(h.store.getSnapshot().error, '');
  assert.equal(h.store.getSnapshot().lastFailure.message, '载体断线');
  h.sink.replace({ cursor: 0, tasks: [row('a', title), row('b')] }); await flush();
  failure = new TypeError('Failed to fetch');
  h.sink.update({ cursor: 1, entries: [{ seq: 1, taskId: 'a', kind: 'execution' }] }); h.run(80); await flush();
  assert.equal(h.store.getSnapshot().error, '');
  assert.equal(h.store.getSnapshot().rows[0].title, title);
  assert.equal(h.store.getSnapshot().lastFailure.source, 'task:a');
  assert([...h.timers.values()].some(delay => delay >= 10000 && delay <= 60000));
  await h.store.refreshTasks(['a']);
  assert.equal(h.store.getSnapshot().error, 'Failed to fetch');
  failure = new Error('任务版本冲突');
  h.sink.update({ cursor: 2, entries: [{ seq: 2, taskId: 'a', kind: 'execution' }] }); h.run(10000); await flush();
  await h.store.refreshTasks(['a'], false);
  assert.equal(h.store.getSnapshot().error, '任务版本冲突');
  failure = null; title = '恢复后的记录'; await h.store.refreshTasks(['b']);
  assert.equal(h.store.getSnapshot().error, '任务版本冲突', 'unrelated success cannot hide a domain error');
  await h.store.refreshTasks(['a']);
  assert.equal(h.store.getSnapshot().error, '');
  assert.equal(h.store.getSnapshot().rows[0].title, title); h.stop();
});

test('first snapshot and terminal stream failures expose the actual error', async () => {
  const h = setup(async () => ({ goals: [] }));
  h.sink.carrierFailed(new Error('首次连接失败'));
  assert.equal(h.store.getSnapshot().rows, null);
  assert.equal(h.store.getSnapshot().error, '首次连接失败');
  h.sink.replace({ cursor: 0, tasks: [] }); await flush();
  h.sink.failed(new Error('执行事实协议不兼容'));
  assert.equal(h.store.getSnapshot().error, '执行事实协议不兼容'); h.stop();
});

test('silent refresh only recognizes transport failures and never domain, authentication or malformed-response errors', () => {
  for (const status of [408, 425, 429, 502, 503, 504]) assert(transientRefreshError(Object.assign(new Error('temporary'), { code: 'HTTP_ERROR', status })));
  for (const status of [400, 401, 403, 404, 409, 422, 500]) assert.equal(transientRefreshError(Object.assign(new Error('domain'), { code: 'HTTP_ERROR', status })), false);
  assert.equal(transientRefreshError(Object.assign(new Error('bad response'), { code: 'INVALID_JSON_RESPONSE' })), false);
  assert.equal(transientRefreshError(new Error('offline')), false);
});

test('a task baseline cannot disguise the first failed goal read; bounded retry recovers that resource', async () => {
  let fail = true;
  const h = setup(async () => { if (fail) throw new TypeError('Failed to fetch'); return { goals: [] }; });
  h.sink.replace({ cursor: 0, tasks: [] }); await flush();
  assert.equal(h.store.getSnapshot().error, 'Failed to fetch');
  fail = false; h.run(10000); await flush();
  assert.equal(h.store.getSnapshot().error, ''); h.stop();
});

test('manual board refresh awaits one replacement snapshot instead of reading every cached task', async () => {
  const calls = [], h = setup(async (name, args) => { calls.push([name, args]); return { goals: [] }; });
  const tasks = Array.from({ length: 1000 }, (_, index) => ({ ...row(`task-${index}`), archived: index >= 10 }));
  h.sink.replace({ cursor: 0, tasks }); await flush();
  const before = h.store.getSnapshot().rows;
  let taskCommits = 0, observed = before, completed = false;
  const stop = h.store.subscribe(() => { const next = h.store.getSnapshot().rows; if (observed !== next) { taskCommits++; observed = next; } });
  const pending = h.store.refresh(); pending.then(() => { completed = true; });
  assert.strictEqual(h.store.refresh(), pending, 'repeated clicks share the same replacement');
  assert.equal(h.restarts, 1); await flush();
  assert.equal(completed, false); assert.strictEqual(h.store.getSnapshot().rows, before);
  h.sink.replace({ cursor: 1, tasks: tasks.map((value, index) => index ? value : { ...value, title: '新快照' }) });
  await pending;
  assert.equal(completed, true); assert.equal(taskCommits, 1);
  assert.equal(h.store.getSnapshot().rows.length, 1000, 'archived facts are retained');
  assert.equal(h.store.getSnapshot().rows[0].title, '新快照');
  assert.strictEqual(h.store.getSnapshot().rows[999], before[999]);
  assert.equal(calls.filter(([name]) => name === 'tasks').length, 0);
  assert.equal(h.timers.size, 0); stop(); h.stop();
});

test('manual snapshot waits settle on failure, timeout, visibility pause and subscription disposal', async t => {
  for (const reason of ['carrier', 'source', 'timeout', 'hidden', 'unsubscribe', 'environment']) await t.test(reason, async () => {
    const h = setup(async () => ({ goals: [] }));
    h.sink.replace({ cursor: 0, tasks: [row('saved')] }); await flush();
    const previous = h.store.getSnapshot().rows;
    let completed = false;
    const pending = h.store.refresh().then(() => { completed = true; });
    if (reason === 'carrier') h.sink.carrierFailed(new TypeError('Failed to fetch'));
    if (reason === 'source') h.sink.failed(new Error('事实流不可用'));
    if (reason === 'timeout') h.run(45000);
    if (reason === 'hidden') { h.document.hidden = true; h.document.dispatchEvent(new Event('visibilitychange')); }
    if (reason === 'unsubscribe') h.stop();
    if (reason === 'environment') h.store.setEnvironment({ connect() { return { start() {}, dispose() {} }; } });
    await flush(); assert.equal(completed, true, `${reason} cannot leave the button busy`); await pending;
    assert.strictEqual(h.store.getSnapshot().rows, previous);
    if (['carrier', 'source', 'timeout'].includes(reason)) assert.notEqual(h.store.getSnapshot().error, '');
    else assert.equal(h.store.getSnapshot().error, '');
    if (!['unsubscribe', 'environment'].includes(reason)) {
      h.sink.replace({ cursor: 0, tasks: [row('saved')] }); await flush();
      assert.equal(h.store.getSnapshot().error, '', 'a successful snapshot clears refresh failures');
    }
    h.stop(); assert.equal(h.timers.size, 0);
  });
});

test('refresh during the opening connection waits for its existing snapshot and invalidates prior task reads', async () => {
  const reads = [], h = setup((name, args, signal) => name === 'goalList' ? Promise.resolve({ goals: [] }) : new Promise(resolve => reads.push({ args, signal, resolve })));
  let completed = false;
  const opening = h.store.refresh().then(() => { completed = true; });
  await flush(); assert.equal(completed, false); assert.equal(h.starts, 1); assert.equal(h.restarts, 0);
  h.sink.replace({ cursor: 0, tasks: [row('a')] }); await opening;
  const incremental = h.store.refreshTasks(['a']);
  const refreshing = h.store.refresh();
  assert.equal(reads[0].signal.aborted, true);
  reads[0].resolve({ tasks: [row('a', '已过期')] }); await incremental;
  assert.equal(h.store.getSnapshot().rows[0].title, 'a');
  h.sink.replace({ cursor: 1, tasks: [row('a', '完整快照')] }); await refreshing;
  assert.equal(h.store.getSnapshot().rows[0].title, '完整快照'); h.stop();
});

test('overlapping task batches share four read slots and publish only once per batch', async () => {
  let active = 0, peak = 0;
  const pending = [], h = setup((name, args) => {
    if (name === 'goalList') return Promise.resolve({ goals: [] });
    peak = Math.max(peak, ++active);
    return new Promise(resolve => pending.push({ id: args.taskId, finish() { active--; resolve({ tasks: [row(args.taskId, `新-${args.taskId}`)] }); } }));
  });
  const tasks = Array.from({ length: 12 }, (_, index) => row(`task-${index}`));
  h.sink.replace({ cursor: 0, tasks }); await flush();
  let commits = 0, previous = h.store.getSnapshot().rows;
  const stop = h.store.subscribe(() => { const current = h.store.getSnapshot().rows; if (current !== previous) { commits++; previous = current; } });
  const first = h.store.refreshTasks(tasks.slice(0, 8).map(row => row.id));
  const second = h.store.refreshTasks(tasks.slice(8).map(row => row.id));
  assert.equal(pending.length, 4); assert.equal(commits, 0);
  for (let index = 0; index < tasks.length; index++) { assert(pending[index]); pending[index].finish(); await flush(); }
  await Promise.all([first, second]);
  assert.equal(peak, 4); assert.equal(pending.length, tasks.length); assert.equal(commits, 2);
  assert(h.store.getSnapshot().rows.every(value => value.title === `新-${value.id}`));
  stop(); h.stop();
});

test('a replacement cancels queued increments, and even an empty rejection retains the prior task', async () => {
  let rejectReads = false;
  const pending = [], h = setup((name, args, signal) => {
    if (name === 'goalList') return Promise.resolve({ goals: [] });
    if (rejectReads) return Promise.reject(null);
    return new Promise(resolve => pending.push({ args, signal, resolve }));
  });
  const tasks = Array.from({ length: 10 }, (_, index) => row(`t-${index}`));
  h.sink.replace({ cursor: 0, tasks }); await flush();
  const batch = h.store.refreshTasks(tasks.map(row => row.id)); assert.equal(pending.length, 4);
  h.sink.replace({ cursor: 1, tasks: [row('t-0', '替换')] }); await batch;
  assert(pending.every(value => value.signal.aborted));
  pending.forEach(value => value.resolve({ tasks: [row(value.args.taskId, '旧响应')] })); await flush();
  assert.equal(pending.length, 4, 'cancelled queue never starts its remaining six reads');
  rejectReads = true; await h.store.refreshTasks(['t-0']);
  assert.equal(h.store.getSnapshot().rows[0].title, '替换'); assert.equal(h.store.getSnapshot().error, '任务读取失败');
  h.stop();
});
