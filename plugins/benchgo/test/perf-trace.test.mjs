import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import { createPerfTrace, perfTrace } from '../../shared/client/perf-trace.mjs';

const KEY = 'benchgo.perf.trace';
function fakeScope({ types = ['long-animation-frame', 'longtask', 'event'], storage = new Map(), brokenStorage = false } = {}) {
  let now = 0, timerId = 0, clockReads = 0;
  const observers = [], timers = new Map(), handlers = new Map();
  class PerformanceObserver {
    static supportedEntryTypes = types;
    constructor(callback) { this.callback = callback; this.connected = false; observers.push(this); }
    observe(options) { this.options = options; this.connected = true; }
    disconnect() { this.connected = false; }
    emit(...entries) { this.callback({ getEntries: () => entries }); }
  }
  const denied = () => { throw new Error('storage denied'); };
  return {
    observers, timers, handlers, storage, PerformanceObserver,
    clockReads: () => clockReads,
    advance(ms) { now += ms; },
    flush() { for (const [id, run] of [...timers]) { timers.delete(id); run(); } },
    observer: type => observers.find(observer => observer.connected && observer.options.type === type),
    performance: { now: () => { clockReads++; return now; }, timeOrigin: 1_700_000_000_000 },
    document: { visibilityState: 'visible', addEventListener: (type, handler) => handlers.set(type, handler), removeEventListener: (type, handler) => { if (handlers.get(type) === handler) handlers.delete(type); } },
    localStorage: brokenStorage ? { getItem: denied, setItem: denied, removeItem: denied } : { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) },
    setTimeout: run => { timers.set(++timerId, run); return timerId; }, clearTimeout: id => timers.delete(id),
    navigator: { userAgent: 'test-agent' }, innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1.5,
  };
}
const timed = (scope, trace, label, ms) => { const done = trace.time(label); scope.advance(ms); done(); };

test('disabled tracing is a shared no-op that reads no clock and records nothing', () => {
  const scope = fakeScope(), trace = createPerfTrace(scope);
  const done = trace.time('commander:state');
  assert.equal(done, trace.time('commander:create'));
  assert.equal(done, perfTrace.time('assistant:send'), 'the singleton starts disabled and shares the same no-op');
  done();
  assert.equal(scope.clockReads(), 0);
  assert.equal(scope.observers.length, 0); assert.equal(scope.handlers.size, 0); assert.equal(scope.timers.size, 0);
  const snapshot = trace.getSnapshot();
  assert.equal(snapshot.enabled, false); assert.equal(snapshot.startedAt, null);
  assert.deepEqual(snapshot.summary, { frames: { type: 'long-animation-frame', count: 0, maxDuration: 0 }, interactions: { count: 0, maxDuration: 0 }, labels: {}, entries: 0, dropped: 0 });
  assert.deepEqual(trace.export().entries, []);
});

test('enabled timing summarizes every call, details only slow ones and throttles notifications', () => {
  const scope = fakeScope(), trace = createPerfTrace(scope);
  let notified = 0;
  const unsubscribe = trace.subscribe(() => { notified++; });
  trace.setEnabled(true);
  assert.equal(notified, 1);
  const before = trace.getSnapshot();
  assert.equal(before.enabled, true); assert.equal(typeof before.startedAt, 'string');
  timed(scope, trace, 'commander:state', 49.9);
  timed(scope, trace, 'commander:state', 50);
  timed(scope, trace, 'commander:create', 120.26);
  assert.equal(trace.getSnapshot(), before, 'the snapshot keeps its identity between notifications');
  assert.equal(notified, 1); assert.equal(scope.timers.size, 1, 'many records share one pending notification');
  scope.flush();
  assert.equal(notified, 2);
  const { summary } = trace.getSnapshot();
  assert.deepEqual(summary.labels, { 'commander:state': { count: 2, totalDuration: 99.9, maxDuration: 50 }, 'commander:create': { count: 1, totalDuration: 120.3, maxDuration: 120.3 } });
  assert.deepEqual(trace.export().entries, [{ kind: 'time', t: 49.9, label: 'commander:state', duration: 50 }, { kind: 'time', t: 99.9, label: 'commander:create', duration: 120.3 }]);
  assert.equal(trace.getSnapshot(), trace.getSnapshot());
  trace.clear();
  assert.equal(notified, 3); assert.deepEqual(trace.getSnapshot().summary.labels, {}); assert.deepEqual(trace.export().entries, []);
  unsubscribe(); timed(scope, trace, 'commander:state', 60); scope.flush();
  assert.equal(notified, 3);
});

test('details are a ring capped at 2000 entries while the summary keeps counting', () => {
  const scope = fakeScope(), trace = createPerfTrace(scope);
  trace.setEnabled(true);
  for (let index = 0; index < 2100; index++) timed(scope, trace, `call:${index}`, 60);
  const record = trace.export();
  assert.equal(record.entries.length, 2000);
  assert.equal(record.entries[0].label, 'call:100'); assert.equal(record.entries.at(-1).label, 'call:2099');
  assert.equal(record.summary.entries, 2000); assert.equal(record.summary.dropped, 100);
  assert.equal(Object.keys(record.summary.labels).length, 2100);
});

test('the switch persists across reloads and tolerates unavailable storage', () => {
  const scope = fakeScope(), trace = createPerfTrace(scope);
  trace.setEnabled(true);
  assert.equal(scope.storage.get(KEY), '1');
  const reloaded = fakeScope({ storage: scope.storage }), next = createPerfTrace(reloaded);
  assert.equal(next.getSnapshot().enabled, true);
  assert.equal(reloaded.observers.filter(observer => observer.connected).length, 2);
  next.setEnabled(false);
  assert.equal(scope.storage.has(KEY), false);
  assert.equal(createPerfTrace(fakeScope({ storage: scope.storage })).getSnapshot().enabled, false);
  for (const broken of [fakeScope({ brokenStorage: true }), { ...fakeScope(), localStorage: undefined }]) {
    const local = createPerfTrace(broken);
    assert.equal(local.getSnapshot().enabled, false);
    assert.doesNotThrow(() => local.setEnabled(true));
    assert.equal(local.getSnapshot().enabled, true);
    assert.doesNotThrow(() => local.setEnabled(false));
  }
});

test('observers follow real support, fall back to longtask and disconnect when stopped', () => {
  const scope = fakeScope(), trace = createPerfTrace(scope);
  trace.setEnabled(true);
  assert.deepEqual(scope.observers.map(observer => observer.options), [{ type: 'long-animation-frame' }, { type: 'event', durationThreshold: 100 }]);
  assert.equal(typeof scope.handlers.get('visibilitychange'), 'function');
  assert.deepEqual(trace.getSnapshot().supported, { 'long-animation-frame': true, longtask: true, event: true, visibilitychange: true });
  trace.setEnabled(false);
  assert(scope.observers.every(observer => !observer.connected)); assert.equal(scope.handlers.size, 0);
  assert.equal(trace.time('late'), trace.time('later'));

  const legacy = fakeScope({ types: ['longtask'] }), fallback = createPerfTrace(legacy);
  fallback.setEnabled(true);
  assert.deepEqual(legacy.observers.map(observer => observer.options.type), ['longtask']);
  legacy.observer('longtask').emit({ entryType: 'longtask', startTime: 10, duration: 180 });
  assert.deepEqual(fallback.export().entries, [{ kind: 'longtask', t: 10, duration: 180 }]);
  assert.deepEqual(fallback.getSnapshot().supported, { 'long-animation-frame': false, longtask: true, event: false, visibilitychange: true });
  assert.equal(fallback.export().summary.frames.type, 'longtask');

  const bare = { ...fakeScope({ types: [] }), document: undefined }, minimal = createPerfTrace(bare);
  minimal.setEnabled(true);
  assert.equal(bare.observers.length, 0);
  assert.deepEqual(minimal.getSnapshot().supported, { 'long-animation-frame': false, longtask: false, event: false, visibilitychange: false });
  timed(bare, minimal, 'commander:state', 70);
  assert.equal(minimal.export().summary.labels['commander:state'].count, 1);

  const refusing = fakeScope();
  refusing.PerformanceObserver.prototype.observe = function observe(options) { if (options.type !== 'longtask') throw new Error('unsupported'); this.options = options; this.connected = true; };
  const guarded = createPerfTrace(refusing);
  guarded.setEnabled(true);
  assert.deepEqual(guarded.getSnapshot().supported, { 'long-animation-frame': false, longtask: true, event: false, visibilitychange: true });
  assert.equal(refusing.observer('longtask').connected, true);
});

test('the export is serializable and carries sources without queries, text or input', () => {
  const scope = fakeScope(), trace = createPerfTrace(scope);
  trace.setEnabled(true);
  const script = (duration, extra) => ({ duration, invoker: 'TimerHandler:setTimeout', invokerType: 'user-callback', forcedStyleAndLayoutDuration: duration / 10, sourceFunctionName: 'tick', sourceURL: 'https://app.local/assets/client.js?token=secret#secret', ...extra });
  scope.observer('long-animation-frame').emit({ entryType: 'long-animation-frame', startTime: 100.04, duration: 2400.06, blockingDuration: 2350, renderStart: 2000.04, styleAndLayoutStart: 2300.04, scripts: [
    script(5, { sourceFunctionName: 'dropped' }), script(900, { invoker: 'https://app.local/chunk.js?v=secret' }),
    script(700, { invoker: 'IMG#hero[src=https://cdn.local/a.png?sig=secret].onload', sourceURL: 'data:text/javascript;base64,c2VjcmV0' }), script(300, { sourceURL: '' }),
  ] });
  const target = { tagName: 'BUTTON', textContent: 'private message', value: 'typed secret', getAttribute: name => ({ class: 'send primary extra', 'aria-label': '发'.repeat(60) })[name] ?? null };
  const events = scope.observer('event');
  events.emit({ name: 'pointerdown', startTime: 200, processingStart: 230.5, duration: 300, interactionId: 7, target }, { name: 'click', startTime: 205, processingStart: 500, duration: 2900, interactionId: 7, target });
  events.emit({ name: 'keydown', startTime: 900, processingStart: 901, duration: 120, interactionId: 8, target: null }, { name: 'pointerover', startTime: 950, processingStart: 951, duration: 3100, interactionId: 0, target });
  scope.advance(1500); scope.document.visibilityState = 'hidden'; scope.handlers.get('visibilitychange')();
  const record = trace.export(), json = JSON.stringify(record);
  assert.deepEqual(JSON.parse(json), record);
  for (const leaked of ['secret', '?', 'private message', 'typed', 'c2VjcmV0', 'cdn.local']) assert.equal(json.includes(leaked), false, leaked);
  assert.equal(record.version, 1); assert.equal(record.timeOrigin, 1_700_000_000_000); assert.equal(record.userAgent, 'test-agent');
  assert.deepEqual(record.viewport, { width: 1280, height: 720 }); assert.equal(record.devicePixelRatio, 1.5);
  assert(record.page === null || Object.values(record.page).every(value => value === null || Number.isFinite(value)), 'page scale carries counts only');
  assert.equal(new Date(record.startedAt).toISOString(), record.startedAt); assert.equal(new Date(record.exportedAt).toISOString(), record.exportedAt);
  assert.deepEqual(record.summary.frames, { type: 'long-animation-frame', count: 1, maxDuration: 2400.1 });
  assert.deepEqual(record.summary.interactions, { count: 2, maxDuration: 2900 }, 'events of one interaction count once; hover stays in the details');
  const [frame, pointer, click, key, hover, visibility] = record.entries;
  assert.equal(hover.name, 'pointerover'); assert.equal(hover.interactionId, 0);
  assert.deepEqual(frame, { kind: 'long-animation-frame', t: 100, duration: 2400.1, blockingDuration: 2350,
    scriptDuration: 1900, renderDuration: 300, layoutDuration: 200.1, scriptCount: 4, scripts: [
    { invoker: 'chunk.js', invokerType: 'user-callback', sourceFunctionName: 'tick', sourceFile: 'client.js', duration: 900, forcedLayoutDuration: 90 },
    { invoker: 'IMG#hero.onload', invokerType: 'user-callback', sourceFunctionName: 'tick', sourceFile: 'data:', duration: 700, forcedLayoutDuration: 70 },
    { invoker: 'TimerHandler:setTimeout', invokerType: 'user-callback', sourceFunctionName: 'tick', sourceFile: '', duration: 300, forcedLayoutDuration: 30 },
  ] });
  // A host that withholds the phase marks attributes the whole frame to the first phase.
  scope.observer('long-animation-frame').emit({ entryType: 'long-animation-frame', startTime: 3000, duration: 80 });
  const bare = trace.export().entries.at(-1);
  assert.deepEqual([bare.scriptDuration, bare.renderDuration, bare.layoutDuration, bare.scriptCount, bare.scripts], [80, 0, 0, 0, []]);
  assert.deepEqual(pointer, { kind: 'event', t: 200, name: 'pointerdown', duration: 300, inputDelay: 30.5, interactionId: 7, target: `button.send.primary[${'发'.repeat(40)}]` });
  assert.equal(click.inputDelay, 295); assert.equal(key.target, '');
  assert.deepEqual(visibility, { kind: 'visibility', t: 1500, state: 'hidden' });
});

const require = createRequire(new URL('../../../deepseek-harness/packages/client/ui-sidebar/package.json', import.meta.url));
const React = require('react');
const { createRoot } = createRequire(new URL('../../../deepseek-harness/packages/client/ui-renderer/package.json', import.meta.url))('react-dom/client');
const { JSDOM } = createRequire(new URL('../../../deepseek-harness/package.json', import.meta.url))('jsdom');
const component = { exports: {} };
runInNewContext(transformSync(readFileSync(new URL('../client/diagnostics-settings.jsx', import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs' }).code, { module: component, exports: component.exports, require: id => id === 'react' ? React
  : id.endsWith('ui/index.jsx') ? { Button: ({ variant, size, ...props }) => React.createElement('button', { type: 'button', ...props }) }
  : id.endsWith('perf-trace.mjs') ? { perfTrace }
  : id.endsWith('.css') ? '' : { Switch: ({ label, checked, onChange }) => React.createElement('button', { type: 'button', role: 'switch', 'aria-label': label, 'aria-checked': checked, onClick: () => onChange(!checked) }), writeClipboard: async () => false } });

async function withSettings(props, run) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>'), previous = new Map();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const root = createRoot(dom.window.document.getElementById('root')), page = dom.window.document;
  const button = name => [...page.querySelectorAll('button')].find(node => node.textContent === name || node.getAttribute('aria-label') === name);
  try {
    React.act(() => root.render(React.createElement(component.exports.DiagnosticsSettings, props)));
    await run({ page, button, text: () => page.body.textContent, act: React.act, click: name => React.act(async () => { button(name).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); }) });
  } finally {
    React.act(() => root.unmount()); dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  }
}

test('settings guide from the idle state through recording, data, export and clearing', async () => {
  const scope = fakeScope(), trace = createPerfTrace(scope), saved = [];
  await withSettings({ trace, save: (name, text) => saved.push({ name, text }), copy: async () => false }, async ({ page, button, text, act, click }) => {
    assert.equal(page.querySelector('section').getAttribute('aria-label'), '性能诊断');
    assert.match(text(), /只记录耗时与来源，不记录对话内容/); assert.match(text(), /记录仅保存在内存，刷新窗口会清空；开关状态会保留/);
    assert.match(text(), /尚未开始记录/); assert.equal(button('开启性能记录').getAttribute('aria-checked'), 'false');
    assert.equal(button('导出记录'), undefined); assert.equal(page.querySelector('[role=alert]'), null); assert.doesNotMatch(text(), /无法观察/);
    await click('开始记录');
    assert.equal(button('开启性能记录').getAttribute('aria-checked'), 'true'); assert.equal(scope.storage.get(KEY), '1');
    assert.match(text(), /正在记录，暂未发现卡顿/); assert.equal(button('开始记录'), undefined); assert.equal(button('导出记录'), undefined);

    [30, 2400, 800, 90, 400, 1200].forEach((ms, index) => timed(scope, trace, `commander:action${index}`, ms));
    timed(scope, trace, 'commander:action0', 10);
    scope.observer('long-animation-frame').emit({ entryType: 'long-animation-frame', startTime: 1, duration: 2350, blockingDuration: 2300, scripts: [] }, { entryType: 'long-animation-frame', startTime: 9, duration: 80, scripts: [] });
    scope.observer('event').emit({ name: 'click', startTime: 1, processingStart: 2, duration: 640, interactionId: 3, target: null });
    assert.match(text(), /暂未发现卡顿/, 'records wait for the throttled notification');
    act(() => scope.flush());
    const stats = [...page.querySelectorAll('dl > div')].map(node => [...node.children].map(child => child.textContent));
    assert.deepEqual(stats, [['长帧', '2 次', '最长 2.4 秒'], ['慢交互', '1 次', '最慢 640 毫秒']]);
    const rows = [...page.querySelectorAll('tbody tr')].map(row => [...row.children].map(cell => cell.textContent));
    assert.deepEqual(rows, [['commander:action1', '1', '2.4 秒'], ['commander:action5', '1', '1.2 秒'], ['commander:action2', '1', '800 毫秒'], ['commander:action4', '1', '400 毫秒'], ['commander:action3', '1', '90 毫秒']]);

    await click('导出记录');
    assert.equal(saved.length, 1); assert.match(saved[0].name, /^benchgo-perf-\d{4}(-\d\d){5}\.json$/);
    assert.equal(JSON.parse(saved[0].text).version, 1); assert.equal(JSON.parse(saved[0].text).entries.length, 8);
    assert.match(text(), new RegExp(`已导出 ${saved[0].name}`));

    await click('开启性能记录');
    assert.equal(scope.storage.has(KEY), false); assert.match(text(), /已停止记录，现有记录仍可导出/); assert.notEqual(button('导出记录'), undefined);
    await click('清空记录');
    assert.match(text(), /记录已清空/); assert.match(text(), /尚未开始记录/); assert.equal(trace.export().entries.length, 0);
  });
});

test('settings report export fallbacks, failures and unavailable observers truthfully', async () => {
  const scope = fakeScope({ types: ['longtask'] }), trace = createPerfTrace(scope), copied = [];
  trace.setEnabled(true); timed(scope, trace, 'commander:state', 80); scope.flush();
  let clipboard = true;
  const props = { trace, save: () => { throw new Error('download blocked'); }, copy: async text => { copied.push(text); return clipboard; } };
  await withSettings(props, async ({ page, text, click }) => {
    assert.match(page.querySelector('.cmd-diagnostics-warning').textContent, /无法观察：长帧（已改用长任务，不含脚本来源）、慢交互。/);
    assert.deepEqual([...page.querySelectorAll('dl > div')].map(node => [...node.children].map(child => child.textContent)), [['长任务', '0 次', '未出现'], ['慢交互', '不可用', '未出现']]);
    await click('导出记录');
    assert.equal(JSON.parse(copied[0]).summary.labels['commander:state'].count, 1);
    assert.match(text(), /无法下载文件，已将记录复制到剪贴板/); assert.equal(page.querySelector('[role=alert]'), null);
    clipboard = false; await click('导出记录');
    assert.match(page.querySelector('[role=alert]').textContent, /导出失败：下载与剪贴板均不可用（download blocked）。请重试。/);
    assert.doesNotMatch(text(), /已将记录复制/);
  });
  const bare = { ...fakeScope({ types: [] }), document: undefined };
  await withSettings({ trace: createPerfTrace(bare) }, async ({ page }) => {
    assert.match(page.querySelector('.cmd-diagnostics-warning').textContent, /无法观察：长帧与长任务、慢交互、窗口切换。/);
  });
});
