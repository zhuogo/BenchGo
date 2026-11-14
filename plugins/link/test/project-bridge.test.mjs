import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectBridge } from '../client/project-bridge.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = async () => { await new Promise(resolve => setImmediate(resolve)); };
function fixture(request) {
  const listeners = new Set(), timers = new Map(), requests = [], entries = [], sent = [];
  let frame = { contentWindow: { postMessage: (data, origin) => sent.push({ data, origin }) } };
  const host = {
    addEventListener(type, listener) { assert.equal(type, 'message'); listeners.add(listener); },
    removeEventListener(type, listener) { assert.equal(type, 'message'); listeners.delete(listener); },
    setTimeout(callback, delay) { const timer = {}; timers.set(timer, { callback, delay }); return timer; },
    clearTimeout(timer) { timers.delete(timer); },
  };
  const bridge = createProjectBridge({ deviceId: 'server/opaque-id', origin: 'http://127.0.0.1:8000', window: host, getFrame: () => frame, onEntry: url => entries.push(url), request: async (...args) => { requests.push(args); return request ? request(...args) : { url: 'http://127.0.0.1:9000/enter?ticket=one' }; } });
  const receive = (data, overrides = {}) => listeners.forEach(listener => listener({ source: frame.contentWindow, origin: 'http://127.0.0.1:9000', data, ...overrides }));
  return { bridge, requests, entries, sent, timers, listeners, receive, replaceFrame: () => { frame = { contentWindow: { postMessage: (data, origin) => sent.push({ data, origin }) } }; }, ready: () => receive({ type: 'benchgo:resource:ready', projectActions: ['browse', 'project', 'clone'] }), reply: (call, value, error) => receive({ type: 'benchgo:project:result', requestId: call.requestId, value, error }), expire(delay) { for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.callback(); } } };
}

test('project bridge is lazy, reuses concurrent connection and preserves opaque request values', async () => {
  const view = fixture();
  try {
    assert.equal(view.requests.length, 0);
    const first = view.bridge.api('browse', { path: 'E:\\项目' }), second = view.bridge.api('project', { path: '/srv/原样' });
    await settle();
    assert.equal(view.requests.length, 1);
    assert.equal(view.requests[0][0], 'select');
    assert.deepEqual(view.requests[0][1], { deviceId: 'server/opaque-id' });
    const entry = new URL(view.entries[0]);
    assert.equal(entry.searchParams.get('ticket'), 'one');
    assert.equal(new URLSearchParams(entry.hash.slice(1)).get('resourceParentOrigin'), 'http://127.0.0.1:8000');
    assert.equal(view.sent.length, 1); assert.equal(view.sent[0].data.type, 'benchgo:resource:probe');
    view.ready(); await settle();
    const calls = view.sent.filter(item => item.data.type === 'benchgo:project:call').map(item => item.data);
    assert.equal(calls.length, 2); assert.notEqual(calls[0].requestId, calls[1].requestId);
    assert.deepEqual(calls.map(call => call.args.path), ['E:\\项目', '/srv/原样']);
    view.reply(calls[1], { project: { id: 'opaque/project' } }); view.reply(calls[0], { path: 'E:\\项目', entries: [] });
    assert.deepEqual(await first, { path: 'E:\\项目', entries: [] });
    assert.deepEqual(await second, { project: { id: 'opaque/project' } });
    assert.equal(view.timers.size, 0);
  } finally { view.bridge.dispose(); }
});

test('forged window, origin, unknown replies and unsupported operations never execute', async () => {
  const view = fixture();
  try {
    await assert.rejects(view.bridge.api('arbitrary-admin'), /不支持/); assert.equal(view.requests.length, 0);
    const operation = view.bridge.api('browse'); await settle();
    const ready = { type: 'benchgo:resource:ready', projectActions: ['browse', 'project', 'clone'] };
    view.receive(ready, { source: {} }); view.receive(ready, { origin: 'https://evil.test' }); await settle();
    assert.equal(view.sent.filter(item => item.data.type === 'benchgo:project:call').length, 0);
    view.ready(); await settle();
    const call = view.sent.at(-1).data;
    view.receive({ type: 'benchgo:project:result', requestId: call.requestId, value: 'forged' }, { source: {} });
    view.receive({ type: 'benchgo:project:result', requestId: call.requestId, value: 'forged' }, { origin: 'https://evil.test' });
    view.reply({ requestId: 'unknown' }, 'unknown');
    assert.equal(view.timers.size, 1);
    view.reply(call, 'actual'); assert.equal(await operation, 'actual');
  } finally { view.bridge.dispose(); }
});

test('missing target capability is explicit and a subsequent call can obtain a fresh connection', async () => {
  const view = fixture();
  try {
    const first = assert.rejects(view.bridge.api('browse'), /升级.*BenchGo/); await settle();
    view.receive({ type: 'benchgo:resource:ready' }); await first;
    assert.equal(view.entries.at(-1), ''); assert.equal(view.timers.size, 0);
    const second = view.bridge.api('browse'); await settle(); assert.equal(view.requests.length, 2);
    view.ready(); await settle(); view.reply(view.sent.at(-1).data, { entries: [] });
    assert.deepEqual(await second, { entries: [] });
  } finally { view.bridge.dispose(); }
});

test('selection failures, invalid entry URLs and connection timeouts remain retryable', async () => {
  let attempt = 0;
  const view = fixture(async () => {
    if (++attempt === 1) throw Error('设备离线');
    if (attempt === 2) return { url: 'http://unsafe.example/enter' };
    return { url: 'http://127.0.0.1:9000/enter?ticket=' + attempt };
  });
  try {
    await assert.rejects(view.bridge.api('browse'), /设备离线/);
    await assert.rejects(view.bridge.api('browse'), /工作台地址无效/);
    const timedOut = assert.rejects(view.bridge.api('browse'), /连接超时/); await settle();
    const signal = view.requests.at(-1)[2]; view.expire(15_000); await timedOut; assert.equal(signal.aborted, true);
    const recovered = view.bridge.api('browse'); await settle(); view.ready(); await settle();
    view.reply(view.sent.at(-1).data, { path: '/srv' }); assert.deepEqual(await recovered, { path: '/srv' });
    assert.equal(view.requests.length, 4);
  } finally { view.bridge.dispose(); }
});

test('directory requests time out while clone retains its bounded five-minute budget', async () => {
  const view = fixture();
  try {
    const directory = assert.rejects(view.bridge.api('browse'), /项目操作超时/), clone = view.bridge.api('clone', { url: 'https://github.com/owner/repo' });
    await settle(); view.ready(); await settle();
    const call = view.sent.find(item => item.data.action === 'clone').data;
    assert.deepEqual([...view.timers.values()].map(timer => timer.delay).sort((a, b) => a - b), [15_000, 315_000]);
    view.expire(15_000); await directory; assert.equal(view.timers.size, 1);
    view.reply(call, { project: { id: 'cloned' } }); assert.deepEqual(await clone, { project: { id: 'cloned' } });
    const failing = assert.rejects(view.bridge.api('project', { path: '/denied' }), /权限不足/); await settle();
    view.reply(view.sent.at(-1).data, undefined, { message: '权限不足' }); await failing;
    const cloneTimeout = assert.rejects(view.bridge.api('clone', { url: 'https://github.com/owner/slow' }), /克隆超时/); await settle();
    view.expire(315_000); await cloneTimeout; assert.equal(view.timers.size, 0);
  } finally { view.bridge.dispose(); }
});

test('disposing rejects pending work, removes listeners and prevents late entry writes', async () => {
  const select = deferred(), view = fixture(() => select.promise);
  const pending = assert.rejects(view.bridge.api('browse'), /已关闭/); await settle();
  const signal = view.requests[0][2];
  view.bridge.dispose(); view.bridge.dispose(); await pending;
  assert.equal(signal.aborted, true); assert.equal(view.listeners.size, 0); assert.equal(view.timers.size, 0);
  select.resolve({ url: 'http://127.0.0.1:9000/enter?ticket=late' }); await settle();
  assert.deepEqual(view.entries, []);
  await assert.rejects(view.bridge.api('browse'), /已关闭/);
  view.bridge.probe(); assert.equal(view.sent.length, 0);
  const active = fixture();
  const call = assert.rejects(active.bridge.api('browse'), /已关闭/); await settle(); active.ready(); await settle();
  active.bridge.dispose(); await call;
  assert.equal(active.listeners.size, 0); assert.equal(active.timers.size, 0);
});
