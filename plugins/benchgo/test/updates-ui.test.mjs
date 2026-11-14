import { readJsonResponse } from '../client/http-response.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';

const React = createRequire(new URL('../../../deepseek-harness/packages/client/ui-sidebar/package.json', import.meta.url))('react');
const { createRoot } = createRequire(new URL('../../../deepseek-harness/packages/client/ui-renderer/package.json', import.meta.url))('react-dom/client');
const { JSDOM } = createRequire(new URL('../../../deepseek-harness/package.json', import.meta.url))('jsdom');
const compiled = transformSync(readFileSync(new URL('../client/updates.jsx', import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs' }).code;
const initial = () => ({ config: { source: 'mirror', mirrorUrl: 'https://mirror.example/' }, current: { plugin: '0.1.1', app: '0.1.1' }, release: null, phase: 'idle', canInstall: false, managed: true, restartRequired: false, busy: false });
const update = () => ({ ...initial(), release: { version: '0.1.2', plugin: { version: '0.1.2', available: true, compatible: true } }, canInstall: true });

async function mount(respond = () => initial(), props = {}, timers = {}) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://desktop.example/link/', pretendToBeVisual: true }), previous = new Map(), calls = [];
  let now = 0, serial = 0;
  const scheduled = new Map();
  const setTimeout = (callback, delay = 0) => { const id = ++serial; scheduled.set(id, { callback, at: now + delay }); return id; };
  const clearTimeout = id => scheduled.delete(id);
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const module = { exports: {} }, primitives = {
    Modal: ({ open, children }) => open ? React.createElement('div', { role: 'dialog' }, children) : null,
    Tooltip: ({ children }) => children, LinkIconMedium: () => React.createElement('svg', { 'data-github': true }),
  };
  const InformationContext = React.createContext(null);
  const information = {
    Root: ({ open, onOpenChange, children }) => {
      const [uncontrolled, setOpen] = React.useState(false);
      return React.createElement(InformationContext.Provider, { value: { open: open ?? uncontrolled, onOpenChange: next => { setOpen(next); onOpenChange?.(next); } } }, children);
    },
    Trigger: ({ children }) => { const context = React.useContext(InformationContext); return React.cloneElement(children, { 'aria-expanded': context.open, onClick: () => context.onOpenChange(!context.open) }); },
    Content: ({ children, onOpenAutoFocus, onCloseAutoFocus, onEscapeKeyDown, onInteractOutside, ...props }) => React.useContext(InformationContext).open ? React.createElement('div', { role: 'dialog', ...props }, children) : null,
    Title: ({ children, ...props }) => React.createElement('h4', props, children),
    Description: ({ children, ...props }) => React.createElement('p', props, children),
    Close: ({ children, asChild }) => { const context = React.useContext(InformationContext); return asChild ? React.cloneElement(children, { onClick: () => context.onOpenChange(false) }) : React.createElement('button', { onClick: () => context.onOpenChange(false) }, children); },
  };
  // The shared picker renders a portal listbox; a native select keeps these assertions on the update contract.
  const Select = ({ children, onChange, value, ...props }) => React.createElement('select', { ...props, value: value ?? '', onChange: event => onChange?.({ target: { value: event.target.value } }) }, children);
  const local = timers.dshDesktop && !timers.remote;
  runInNewContext(compiled, { module, exports: module.exports, window: dom.window, document: dom.window.document, location: local ? { protocol: 'dsh-app:', hostname: 'app' } : dom.window.location, URL, AbortController, AbortSignal, setInterval, clearInterval, setTimeout, clearTimeout, ...timers,
    fetch: async (url, options) => { const body = JSON.parse(options.body); calls.push(body); assert.equal(String(url), 'https://desktop.example/link/api/commander/updates'); assert.equal(options.credentials, 'same-origin'); const result = await respond(body); return new Response(JSON.stringify(result), { status: result?.httpError || 200, headers: { 'content-type': 'application/json' } }); },
    require: id => id === './http-response.mjs' ? { readJsonResponse } : id === 'react' ? React : id === '@radix-ui/react-dialog' ? information : id.includes('ui-primitives') ? primitives : id.endsWith('/ui/tooltip.jsx') ? { Tooltip: ({ children }) => children } : id.endsWith('/ui/loading.jsx') ? { Loading: ({ label }) => React.createElement('div', { role: 'status' }, label) } : id.includes('shared/client/select.jsx') ? { Select } : id.includes('link/client/brand.jsx') ? { brandIcon: 'data:image/svg+xml,<svg/>' } : id.endsWith('.css') ? '' : { UIIcon: () => null },
  });
  const root = createRoot(dom.window.document.getElementById('root'));
  const flush = callback => React.act(async () => { callback?.(); await new Promise(resolve => setImmediate(resolve)); });
  const button = label => [...dom.window.document.querySelectorAll('button')].find(node => node.textContent === label || node.getAttribute('aria-label') === label);
  const advance = ms => flush(() => {
    now += ms;
    for (const [id, job] of [...scheduled]) if (job.at <= now && scheduled.delete(id)) job.callback();
  });
  const pointer = (label, type, properties = {}) => flush(() => {
    const target = typeof label === 'string' ? button(label) : label;
    assert(target, `Missing pointer target: ${label}`);
    const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
    for (const [key, value] of Object.entries({ pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, ...properties })) Object.defineProperty(event, key, { value });
    target.dispatchEvent(event);
  });
  await flush(() => root.render(React.createElement(module.exports.UpdateLauncher, props)));
  return { calls, document: dom.window.document, window: dom.window, flush, button, pointer, advance,
    click: label => flush(() => { const node = button(label); assert(node, `Missing button: ${label}`); node.click(); }),
    async hold(label = '长按 2 秒更新') { const target = button(label); await pointer(target, 'pointerdown'); await advance(2000); await pointer(target, 'pointerup'); },
    async dispose() { await flush(() => root.unmount()); dom.window.close(); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } },
  };
}

test('host checks once in background, badges the visible launcher and refreshes each opening', async () => {
  const view = await mount(() => update());
  try {
    assert.deepEqual(view.calls.map(call => call.action), ['status', 'check']);
    assert(view.button('更新，有更新'));
    assert.equal(view.document.querySelector('[role="dialog"]'), null);
    await view.click('更新，有更新');
    assert.equal(view.calls.at(-1).action, 'status');
    assert.doesNotMatch(view.document.querySelector('[role="dialog"]').textContent, /当前连接主机|此处更新连接主机|系统自动检查所需组件/);
    assert.equal(view.document.querySelector('.cmd-update-details'), null, 'version information is only mounted after clicking the information icon');
    await view.click('版本详情');
    assert.match(view.document.querySelector('.cmd-update-details').textContent, /desktop.example/);
    await view.click('关闭更新');
    await view.flush(() => view.document.dispatchEvent(new view.window.Event('commander:updates')));
    assert.equal(view.calls.at(-1).action, 'status');
    assert.equal(view.calls.filter(call => call.action === 'check').length, 1);
  } finally { await view.dispose(); }
});

test('plugin install gives truthful staged restart feedback without claiming automatic restart', async () => {
  let state = update();
  const view = await mount(({ action }) => { if (action === 'install') state = { ...state, phase: 'ready', restartRequired: true }; return state; });
  try {
    await view.click('更新，有更新');
    await view.hold();
    assert.equal(view.calls.at(-1).action, 'install');
    assert.match(view.document.querySelector('[role="dialog"]').textContent, /重启主机应用后生效/);
    assert.equal(view.button('长按 2 秒更新'), undefined);
    assert(view.button('更新，待重启'));
  } finally { await view.dispose(); }
});

test('a current server plugin with an unknown application version has no update badge', async () => {
  const state = { ...initial(), installation: 'server', managed: false, current: { plugin: '0.1.8', engine: '0.2.1-alpha.3' },
    release: { plugin: { version: '0.1.8', available: false }, app: { version: '0.1.6', available: true } } };
  const view = await mount(() => state);
  try {
    assert(view.button('更新'));
    assert.equal(view.document.querySelector('.cmd-update-icon i'), null);
    await view.click('更新');
    assert.match(view.document.querySelector('[role="dialog"]').textContent, /已是最新版本/);
    assert.equal(view.button('长按 2 秒更新'), undefined);
  } finally { await view.dispose(); }
});

test('an unknown host application version reports a check limitation instead of current status', async () => {
  const state = { ...initial(), current: { plugin: '0.1.2' },
    release: { plugin: { version: '0.1.2', available: false, compatible: true } },
    decision: { action: 'blocked', available: false, enabled: false, reason: '无法识别当前应用版本' } };
  const view = await mount(() => state);
  try {
    await view.click('更新');
    const dialog = view.document.querySelector('[role="dialog"]').textContent;
    assert.match(dialog, /暂无法确认更新状态/); assert.match(dialog, /无法识别当前应用版本/);
    assert.doesNotMatch(dialog, /已是最新版本/); assert(view.button('检查更新'));
  } finally { await view.dispose(); }
});

test('a verified application update is identified as application-only and remains visible from mobile', async () => {
  const state = { ...initial(), release: { plugin: { version: '0.1.1', available: false }, app: { version: '0.1.2', available: true } } };
  const view = await mount(() => state);
  try {
    assert(view.button('更新，有更新'));
    assert(view.document.querySelector('.cmd-update-icon i'));
    await view.click('更新，有更新');
    assert.match(view.document.querySelector('[role="dialog"]').textContent, /请在当前连接主机上打开 BenchGo/);
    await view.click('版本详情');
    assert.match(view.document.querySelector('.cmd-update-details').textContent, /主机应用v0.1.1 → v0.1.2/);
    assert.equal(view.button('长按 2 秒更新').disabled, true);
  } finally { await view.dispose(); }
});

test('unknown desktop version retains manual application checks without an update badge', async () => {
  const state = { ...initial(), current: { plugin: '0.1.8' }, release: { plugin: { version: '0.1.8', available: false }, app: { version: '0.1.6', available: true } } };
  const view = await mount(() => state, {}, { dshDesktop: { updates: { open() {} } } });
  try {
    assert(view.button('更新'));
    assert.equal(view.document.querySelector('.cmd-update-icon i'), null);
    await view.click('更新');
    await view.click('版本详情');
    assert.match(view.document.querySelector('.cmd-update-details').textContent, /主机应用版本未知/);
    assert(view.button('检查更新'));
    assert(view.button('检查安装器更新'));
  } finally { await view.dispose(); }
});

test('missing release, unknown plugin and failed checks never claim the plugin is current', async () => {
  for (const [state, message] of [
    [initial(), /尚未检查更新/],
    [{ ...initial(), current: {}, release: { plugin: { version: '0.1.2', available: true } } }, /暂无法识别插件版本/],
    [{ ...initial(), phase: 'error', error: '网络故障', release: { plugin: { version: '0.1.1', available: false } } }, /暂时无法检查更新/],
  ]) {
    const view = await mount(() => state);
    try {
      assert(view.button('更新'));
      await view.click('更新');
      const dialog = view.document.querySelector('[role="dialog"]');
      assert.match(dialog.textContent, message);
      assert.doesNotMatch(dialog.textContent, /已是最新版本/);
      assert.equal(view.document.querySelector('.cmd-update-icon i'), null);
    } finally { await view.dispose(); }
  }
});

test('busy host disables installing; incompatible and unmanaged hosts explain required application update', async () => {
  for (const [patch, message] of [[{ busy: true }, /有任务正在运行/], [{ managed: false }, /当前安装方式不支持独立更新/], [{ release: { plugin: { version: '0.1.2', available: true, compatible: false, reason: '需要引擎 2.0' } } }, /需要引擎 2.0/]]) {
    const view = await mount(() => ({ ...update(), ...patch }));
    try {
      await view.click('更新，有更新');
      if (patch.busy) { assert(view.button('长按 2 秒更新').disabled); await view.hold(); }
      else { assert.equal(view.button('长按 2 秒更新'), undefined); assert(view.button('检查更新')); }
      assert(!view.calls.some(call => call.action === 'install'));
      assert.match(view.document.querySelector('[role="dialog"]').textContent, message);
    }
    finally { await view.dispose(); }
  }
});

test('source selection persists on host and rechecks; invalid custom mirrors never reach backend', async () => {
  let state = initial();
  const view = await mount(body => { if (body.action === 'configure') state = { ...state, config: { source: body.source, mirrorUrl: body.mirrorUrl } }; return state; });
  try {
    await view.click('更新');
    const select = view.document.querySelector('select');
    assert.equal(select.value, 'mirror');
    await view.flush(() => { select.value = 'github'; select.dispatchEvent(new view.window.Event('change', { bubbles: true })); });
    assert.equal(view.calls.at(-2).action, 'configure');
    assert.equal(view.calls.at(-2).source, 'github');
    assert.equal(view.calls.at(-1).action, 'check');
    await view.flush(() => { select.value = 'custom'; select.dispatchEvent(new view.window.Event('change', { bubbles: true })); });
    const input = view.document.querySelector('input'), native = Object.getOwnPropertyDescriptor(view.window.HTMLInputElement.prototype, 'value').set;
    await view.flush(() => { native.call(input, 'http://unsafe.example/'); input.dispatchEvent(new view.window.Event('input', { bubbles: true })); });
    const before = view.calls.length;
    await view.flush(() => view.document.querySelector('form').dispatchEvent(new view.window.Event('submit', { bubbles: true, cancelable: true })));
    assert.equal(view.calls.length, before);
    assert.match(view.document.querySelector('[role="alert"]').textContent, /HTTPS/);
    await view.flush(() => { native.call(input, 'https://custom.example/'); input.dispatchEvent(new view.window.Event('input', { bubbles: true })); });
    await view.click('保存');
    assert.equal(view.calls.at(-2).source, 'custom');
    assert.equal(view.calls.at(-2).mirrorUrl, 'https://custom.example/');
  } finally { await view.dispose(); }
});

test('backend errors can retry and application packages are delegated only to the native updater', async () => {
  let failed = true;
  const desktop = { dshDesktop: { updates: { open() {} } } };
  const view = await mount(() => failed ? { httpError: 403, error: '仅主机可执行更新' } : { ...initial(), release: { app: { version: '0.1.2', available: true, url: 'https://github.com/example/repo/releases/latest' } } }, {}, desktop);
  try {
    await view.click('更新');
    assert.match(view.document.querySelector('[role="alert"]').textContent, /仅主机可执行更新/);
    await view.flush(() => { failed = false; }); await view.click('重试');
    assert.equal(view.document.querySelector('[role="alert"]'), null);
    assert.equal(view.document.querySelector('a'), null, 'product documents cannot supply package URLs to native installation');
    assert(view.button('长按 2 秒更新'));
  } finally { await view.dispose(); }
  const unsafe = await mount(() => ({ ...initial(), release: { app: { version: '0.1.2', available: true, url: 'javascript:alert(1)' } } }), {}, desktop);
  try { await unsafe.click('更新，有更新'); assert.equal(unsafe.document.querySelector('a'), null); }
  finally { await unsafe.dispose(); }
});

test('only an active operation polls status, then stops when installation is ready', async () => {
  let state = { ...update(), phase: 'downloading' }, tick, cleared = 0;
  const view = await mount(() => state, {}, { setInterval: (callback, delay) => { assert.equal(delay, 2000); tick = callback; return 1; }, clearInterval: () => { cleared++; } });
  try {
    assert.deepEqual(view.calls.map(call => call.action), ['status']);
    assert.equal(typeof tick, 'function');
    state = { ...state, phase: 'ready', restartRequired: true };
    await view.flush(tick);
    assert.deepEqual(view.calls.map(call => call.action), ['status', 'status']);
    assert.equal(cleared, 1);
    assert(view.button('更新，待重启'));
  } finally { await view.dispose(); }
});

test('desktop app update opens the public bridge without a feed entry, prevents reentry and retries errors; mobile shows only its host version', async () => {
  let calls = 0, rejectOpen;
  const blocked = new Promise((_resolve, reject) => { rejectOpen = reject; });
  const updates = { open() { assert.equal(this, updates); calls++; return calls === 1 ? blocked : undefined; } };
  const view = await mount(initial, {}, { dshDesktop: { updates } });
  try {
    await view.click('更新');
    assert(view.button('检查更新'));
    await view.click('检查更新');
    assert.equal(calls, 1);
    assert(view.button('更新中…').disabled);
    await view.click('更新中…');
    assert.equal(calls, 1);
    await view.flush(() => rejectOpen(Error('桌面更新服务不可用')));
    assert.match(view.document.querySelector('[role="alert"]').textContent, /桌面更新服务不可用/);
    await view.click('重试');
    assert.equal(calls, 2);
    assert.equal(view.document.querySelector('[role="alert"]'), null);
    assert(view.button('检查更新'));
  } finally { await view.dispose(); }
  const mobile = await mount(() => ({ ...initial(), release: { app: { version: '0.1.2', available: true, url: 'https://github.com/example/repo/releases/latest' } } }));
  try { await mobile.click('更新，有更新'); await mobile.click('版本详情'); assert.equal(mobile.button('检查安装器更新'), undefined); assert.equal(mobile.document.querySelector('a'), null); assert.match(mobile.document.querySelector('.cmd-update-details').textContent, /主机应用v0.1.1/); }
  finally { await mobile.dispose(); }
  const older = await mount(() => ({ ...initial(), release: { app: { version: '0.1.0', available: false } } }), {}, { dshDesktop: { updates } });
  try { assert(older.button('更新')); await older.click('更新'); assert.doesNotMatch(older.document.querySelector('[role="dialog"]').textContent, /发现新版本/); assert(older.button('检查更新')); }
  finally { await older.dispose(); }
});

test('server deployment with an unpublished feed explains deployment ownership without a migration warning or failure alert', async () => {
  let state = { ...initial(), installation: 'server', managed: false, phase: 'unpublished', notice: '更新通道尚未就绪', error: 'HTTP 404' };
  const view = await mount(() => state);
  try {
    await view.click('更新');
    const dialog = view.document.querySelector('[role="dialog"]');
    assert.match(dialog.textContent, /此主机由服务器部署管理/);
    assert.doesNotMatch(dialog.textContent, /系统自动检查所需组件|镜像仅用于下载|手机应用在设备页检查/);
    assert.match(dialog.textContent, /更新通道尚未就绪/);
    assert.doesNotMatch(dialog.textContent, /请先安装新版应用|插件已是最新版本|HTTP 404/);
    assert.equal(view.document.querySelector('[role="alert"]'), null);
    assert.equal(view.button('重试'), undefined);
    assert.equal(view.button('检查更新').disabled, false);
    state = { ...update(), installation: 'server', managed: false, canInstall: false };
    await view.click('检查更新');
    assert.equal(view.calls.at(-1).action, 'check');
    assert.equal(view.button('长按 2 秒更新'), undefined);
    assert.equal(view.button('检查更新').disabled, false);
    await view.click('检查更新');
    assert.equal(view.calls.at(-1).action, 'check');
    assert(!view.calls.some(call => call.action === 'install'));
  } finally { await view.dispose(); }
});

test('legacy desktop keeps its migration guidance while a managed server can still install plugin updates', async () => {
  const legacy = await mount(() => ({ ...initial(), installation: 'desktop', managed: false }));
  try { await legacy.click('更新'); assert.match(legacy.document.querySelector('[role="dialog"]').textContent, /当前安装方式需要新版应用/); }
  finally { await legacy.dispose(); }
  const managed = await mount(() => ({ ...update(), installation: 'server', managed: true }));
  try { await managed.click('更新，有更新'); assert.equal(managed.button('长按 2 秒更新').disabled, false); assert.doesNotMatch(managed.document.querySelector('[role="dialog"]').textContent, /此主机由服务器部署管理/); }
  finally { await managed.dispose(); }
});


test('opening status refresh never disables installation or swallows a click; late status cannot overwrite installation', async () => {
  let refresh, statusCalls = 0;
  const view = await mount(({ action }) => {
    if (action === 'status' && ++statusCalls === 2) return new Promise(resolve => { refresh = resolve; });
    return action === 'install' ? { ...update(), phase: 'ready', restartRequired: true } : update();
  });
  try {
    await view.click('更新，有更新');
    assert.equal(view.button('长按 2 秒更新').disabled, false);
    await view.hold();
    assert.equal(view.calls.at(-1).action, 'install');
    assert.match(view.document.querySelector('[role="dialog"]').textContent, /重启主机应用后生效/);
    await view.flush(() => refresh(update()));
    assert(view.button('更新，待重启'));
    assert.equal(view.button('长按 2 秒更新'), undefined);
  } finally { await view.dispose(); }
});

test('failed plugin installation retries installation and shows an explicit block reason', async () => {
  let installations = 0;
  const view = await mount(({ action }) => action === 'install' && ++installations === 1 ? { httpError: 409, error: '下载期间有新任务开始，结束后再点更新' } : update());
  try {
    await view.click('更新，有更新');
    await view.hold();
    assert.match(view.document.querySelector('[role="alert"]').textContent, /有新任务开始/);
    await view.click('长按 2 秒重试');
    assert.equal(installations, 1, 'retry also requires a deliberate hold');
    await view.hold('长按 2 秒重试');
    assert.equal(view.calls.at(-1).action, 'install');
    assert.equal(installations, 2);
  } finally { await view.dispose(); }
});

test('host activity becoming idle enables installation without reopening or disabling for the status poll', async () => {
  let state = { ...update(), busy: true, canInstall: false }, tick, refresh, hold = false;
  const view = await mount(() => hold ? new Promise(resolve => { refresh = resolve; }) : state, {}, { setInterval: callback => { tick = callback; return 1; }, clearInterval() {} });
  try {
    await view.click('更新，有更新');
    assert(view.button('长按 2 秒更新').disabled);
    assert.match(view.document.querySelector('[role="dialog"]').textContent, /有任务正在运行/);
    assert.equal(typeof tick, 'function');
    state = update();
    await view.flush(tick);
    assert.equal(view.button('长按 2 秒更新').disabled, false);
    hold = true;
    await view.flush(tick);
    assert.equal(view.button('长按 2 秒更新').disabled, false);
    assert.equal(view.button('长按 2 秒更新').textContent, '长按 2 秒更新');
    await view.flush(() => refresh(state));
  } finally { await view.dispose(); }
});

test('transient unavailable install status explains the reason and keeps a visible recheck path', async () => {
  const view = await mount(() => ({ ...update(), canInstall: false }));
  try {
    await view.click('更新，有更新');
    assert(view.button('长按 2 秒更新').disabled);
    assert.match(view.document.querySelector('[role="dialog"]').textContent, /更新状态尚未就绪/);
    assert.equal(view.button('重新检查').disabled, false);
    await view.click('重新检查');
    assert.equal(view.calls.at(-1).action, 'check');
  } finally { await view.dispose(); }
});

test('asynchronous installation failure retries the failed operation from host state', async () => {
  const view = await mount(({ action }) => action === 'install' ? update() : { ...update(), phase: 'error', error: '下载校验失败', lastAction: 'install' });
  try {
    await view.click('更新，有更新');
    assert.match(view.document.querySelector('[role="alert"]').textContent, /下载校验失败/);
    await view.hold('长按 2 秒重试');
    assert.equal(view.calls.at(-1).action, 'install');
  } finally { await view.dispose(); }
});

test('failed status polling can recover an active download instead of trying a conflicting check', async () => {
  let state = { ...update(), phase: 'downloading' }, tick, failed = false;
  const view = await mount(() => failed ? { httpError: 503, error: '暂时无法连接' } : state, {}, { setInterval: callback => { tick = callback; return 1; }, clearInterval() {} });
  try {
    await view.click('更新，下载中');
    failed = true;
    await view.flush(tick);
    assert.match(view.document.querySelector('[role="alert"]').textContent, /暂时无法连接/);
    assert.equal(view.button('重试').disabled, false);
    failed = false; state = { ...state, phase: 'ready', restartRequired: true };
    await view.click('重试');
    assert.equal(view.calls.at(-1).action, 'status');
    assert.equal(view.document.querySelector('[role="alert"]'), null);
    assert(view.button('更新，待重启'));
  } finally { await view.dispose(); }
});

test('host decision selects an application upgrade without exposing a plugin choice', async () => {
  let nativeOpens = 0;
  const state = { ...update(), current: { ...initial().current, release: '0.2.0' },
    decision: { action: 'app', available: true, enabled: true, reason: '需要应用 v0.2.0' },
    release: { ...update().release, releaseVersion: '0.3.0', app: { version: '0.2.0', available: true } } };
  const view = await mount(() => state, {}, { dshDesktop: { updates: { open() { nativeOpens++; } } } });
  try {
    await view.click('更新，有更新');
    assert.match(view.document.querySelector('.cmd-update-card-heading').textContent, /v0.2.0 → v0.3.0/);
    assert.equal(view.document.querySelectorAll('.cmd-update-primary').length, 1);
    await view.hold();
    assert.equal(nativeOpens, 1);
    assert.equal(view.calls.some(call => call.action === 'install'), false);
  } finally { await view.dispose(); }
});

test('native status subscription survives a late initial status and cleans up on unmount', async () => {
  let receive, resolveStatus, disposed = 0, opens = 0;
  const native = { subscribe(listener) { receive = listener; return () => { disposed++; }; },
    status: () => new Promise(resolve => { resolveStatus = resolve; }), open() { opens++; } };
  const view = await mount(initial, {}, { dshDesktop: { updates: native } });
  try {
    await view.flush(() => receive({ phase: 'available', version: '0.2.0' }));
    await view.flush(() => resolveStatus({ phase: 'idle' }));
    assert(view.button('更新，有更新'), 'late initial native status cannot hide a newer event');
    await view.click('更新，有更新');
    assert.equal(view.button('长按 2 秒更新').disabled, false);
    await view.flush(() => receive({ phase: 'downloading', version: '0.2.0', percent: 25 }));
    assert(view.button('更新，下载中'));
    assert.equal(view.button('长按 2 秒更新').disabled, true);
    assert.equal(opens, 0);
  } finally { await view.dispose(); }
  assert.equal(disposed, 1);
});

test('a remote page cannot operate a desktop updater even if a bridge object is present', async () => {
  let nativeCalls = 0;
  const state = { ...initial(), release: { app: { version: '0.2.0', available: true } } };
  const view = await mount(() => state, {}, { remote: true, dshDesktop: { updates: { status() { nativeCalls++; }, open() { nativeCalls++; } } } });
  try {
    await view.click('更新，有更新');
    assert.equal(view.button('长按 2 秒更新').disabled, true);
    assert.equal(view.button('检查安装器更新'), undefined);
    assert.equal(nativeCalls, 0);
  } finally { await view.dispose(); }
});

test('a too-new engine blocker never becomes an app upgrade through unrelated native availability', async () => {
  const state = { ...update(), decision: { action: 'blocked', available: true, enabled: false, reason: '请等待兼容当前引擎的版本' } };
  const view = await mount(() => state, {}, { dshDesktop: { updates: { status: async () => ({ phase: 'available', version: '0.2.0' }), open() { assert.fail('must not try to resolve incompatible engine automatically'); } } } });
  try {
    await view.click('更新，有更新');
    assert.equal(view.button('长按 2 秒更新'), undefined);
    assert.match(view.document.querySelector('[role="dialog"]').textContent, /请等待兼容当前引擎的版本/);
  } finally { await view.dispose(); }
});

test('a click or a short hold never installs, while a completed hold submits only once', async () => {
  const view = await mount(() => update());
  try {
    await view.click('更新，有更新');
    await view.click('长按 2 秒更新');
    assert.equal(view.calls.filter(call => call.action === 'install').length, 0, 'click cannot bypass the confirmation hold');
    await view.pointer('长按 2 秒更新', 'pointerdown');
    await view.advance(1999);
    assert.equal(view.calls.filter(call => call.action === 'install').length, 0, 'the full two seconds are required');
    await view.pointer('长按 2 秒更新', 'pointerup');
    await view.advance(100);
    assert.equal(view.calls.filter(call => call.action === 'install').length, 0, 'release cancels the incomplete hold');
    await view.pointer('长按 2 秒更新', 'pointerdown');
    await view.pointer('长按 2 秒更新', 'pointerdown', { pointerId: 2, pointerType: 'touch', isPrimary: false });
    await view.advance(2000);
    await view.advance(4000);
    assert.equal(view.calls.filter(call => call.action === 'install').length, 1, 'holding longer or adding another pointer never repeats the installation');
  } finally { await view.dispose(); }
});

test('pointer cancellation, leaving, focus loss, hiding and closing abandon a pending hold', async () => {
  for (const cancellation of ['pointercancel', 'pointerout', 'blur', 'hidden', 'close']) {
    const view = await mount(() => update());
    try {
      await view.click('更新，有更新');
      await view.pointer('长按 2 秒更新', 'pointerdown');
      await view.advance(1000);
      if (cancellation === 'close') await view.click('关闭更新');
      else if (cancellation === 'blur') await view.flush(() => view.window.dispatchEvent(new view.window.Event('blur')));
      else if (cancellation === 'hidden') await view.flush(() => { Object.defineProperty(view.document, 'visibilityState', { configurable: true, value: 'hidden' }); view.document.dispatchEvent(new view.window.Event('visibilitychange')); });
      else await view.pointer('长按 2 秒更新', cancellation, { relatedTarget: view.document.body });
      await view.advance(2000);
      assert.equal(view.calls.filter(call => call.action === 'install').length, 0, `${cancellation} cancels installation`);
    } finally { await view.dispose(); }
  }
});

test('keyboard and primary touch follow the same two-second confirmation', async () => {
  for (const input of [' ', 'Enter', 'touch']) {
    const view = await mount(() => update());
    try {
      await view.click('更新，有更新');
      const button = view.button('长按 2 秒更新');
      if (input === 'touch') await view.pointer(button, 'pointerdown', { pointerType: 'touch' });
      else await view.flush(() => {
        button.focus();
        button.dispatchEvent(new view.window.KeyboardEvent('keydown', { key: input, bubbles: true, cancelable: true }));
        button.dispatchEvent(new view.window.KeyboardEvent('keydown', { key: input, repeat: true, bubbles: true, cancelable: true }));
      });
      await view.advance(1999);
      assert.equal(view.calls.filter(call => call.action === 'install').length, 0);
      await view.advance(1);
      assert.equal(view.calls.filter(call => call.action === 'install').length, 1, `${input} submits once at two seconds`);
      if (input === 'touch') await view.pointer(button, 'pointerup', { pointerType: 'touch' });
      else await view.flush(() => button.dispatchEvent(new view.window.KeyboardEvent('keyup', { key: input, bubbles: true, cancelable: true })));
      await view.advance(2000);
      assert.equal(view.calls.filter(call => call.action === 'install').length, 1);
    } finally { await view.dispose(); }
  }
});

test('losing keyboard focus or unmounting clears an incomplete hold', async () => {
  const view = await mount(() => update());
  try {
    await view.click('更新，有更新');
    const button = view.button('长按 2 秒更新');
    await view.flush(() => {
      button.focus();
      button.dispatchEvent(new view.window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
    });
    await view.advance(1000);
    await view.flush(() => view.button('关闭更新').focus());
    await view.advance(1500);
    assert.equal(view.calls.filter(call => call.action === 'install').length, 0);
    await view.pointer('长按 2 秒更新', 'pointerdown');
    await view.advance(1000);
  } finally { await view.dispose(); }
  await view.advance(2000);
  assert.equal(view.calls.filter(call => call.action === 'install').length, 0, 'unmount cancels its timer instead of installing later');
});

test('a host becoming busy during a hold cancels rather than queuing an installation', async () => {
  let state = update(), tick;
  const view = await mount(() => state, {}, { setInterval: callback => { tick = callback; return 1; }, clearInterval() {} });
  try {
    await view.click('更新，有更新');
    await view.pointer('长按 2 秒更新', 'pointerdown');
    await view.advance(1000);
    state = { ...state, busy: true, canInstall: false };
    await view.click('重新检查');
    assert(view.button('长按 2 秒更新').disabled);
    await view.advance(2000);
    assert.equal(view.calls.filter(call => call.action === 'install').length, 0);
    state = update();
    assert.equal(typeof tick, 'function');
    await view.flush(tick);
    assert.equal(view.button('长按 2 秒更新').disabled, false);
    await view.advance(2000);
    assert.equal(view.calls.filter(call => call.action === 'install').length, 0, 'enabling later requires a new deliberate hold');
  } finally { await view.dispose(); }
});

test('captured touch movement and lost capture cancel, while a long-press context menu does not interrupt confirmation', async () => {
  for (const event of ['pointermove', 'lostpointercapture', 'contextmenu']) {
    const view = await mount(() => update());
    try {
      await view.click('更新，有更新');
      const button = view.button('长按 2 秒更新');
      button.getBoundingClientRect = () => ({ left: 20, right: 220, top: 30, bottom: 74 });
      await view.pointer(button, 'pointerdown', { pointerType: 'touch', pointerId: 7, clientX: 100, clientY: 50 });
      await view.advance(1000);
      await view.pointer(button, event, { pointerType: 'touch', pointerId: 7, clientX: 221, clientY: 50 });
      await view.advance(1000);
      assert.equal(view.calls.filter(call => call.action === 'install').length, event === 'contextmenu' ? 1 : 0, `${event} has the correct long-press behavior`);
    } finally { await view.dispose(); }
  }
});

test('a failed refresh preserves known versions without advertising stale current status', async () => {
  const current = { ...initial(), release: { plugin: { version: '0.1.1', available: false, compatible: true } } };
  const view = await mount(({ action }) => action === 'check' ? { httpError: 503, error: '更新服务暂不可用' } : current);
  try {
    await view.click('更新');
    const heading = view.document.querySelector('.cmd-update-card-heading');
    assert.match(heading.textContent, /暂时无法检查更新/);
    assert.doesNotMatch(heading.textContent, /已是最新版本/);
    assert.match(view.document.querySelector('[role="alert"]').textContent, /更新服务暂不可用/);
    assert.doesNotMatch(view.document.querySelector('[role="alert"]').textContent, /api\/commander\/updates/);
    await view.click('版本详情');
    assert.match(view.document.querySelector('.cmd-update-details').textContent, /功能包v0.1.1/);
    assert(view.button('重试'));
  } finally { await view.dispose(); }
});

test('retired version rollback has no entry and an old host action can only recheck', async () => {
  const view = await mount(() => ({ ...initial(), canRollback: true, phase: 'error', lastAction: 'rollback', error: '旧版操作已停止' }));
  try {
    await view.click('更新');
    assert.equal(view.button('回退上版'), undefined);
    assert.equal(view.document.querySelector('.cmd-update-footer'), null);
    await view.click('重试');
    assert.equal(view.calls.at(-1).action, 'check');
    assert.equal(view.calls.some(call => call.action === 'rollback'), false);
  } finally { await view.dispose(); }
});
