import { readJsonResponse } from '../client/http-response.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import * as state from '../client/tool-settings-state.mjs';
import * as quickSettings from '../shared/tool-quick-settings.mjs';
import { createTabDragScroll } from '../client/tab-drag-scroll.mjs';

const primitives = fileURLToPath(new URL('../../../deepseek-harness/packages/client/ui-primitives/src/Menu.tsx', import.meta.url));
const primitiveRequire = createRequire(primitives);
const React = primitiveRequire('react');
const rendererRequire = createRequire(new URL('../../../deepseek-harness/packages/client/ui-renderer/package.json', import.meta.url));
const { JSDOM } = createRequire(new URL('../../../deepseek-harness/package.json', import.meta.url))('jsdom');
const source = readFileSync(new URL('../client/tool-settings.jsx', import.meta.url), 'utf8');

function mount(component, initialProps, options = {}) {
  const dom = new JSDOM('<!doctype html><div id="root"></div><button id="outside">outside</button>', { pretendToBeVisual: true, url: 'http://test/' });
  const globals = { window: dom.window, document: dom.window.document, Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map();
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const { createRoot } = rendererRequire('react-dom/client');
  const errors = [];
  dom.window.addEventListener('error', event => errors.push(event.error));
  const cache = new Map(), Stub = () => null;
  function upstream(path) {
    if (cache.has(path)) return cache.get(path).exports;
    const module = { exports: {} }; cache.set(path, module);
    const code = transformSync(readFileSync(path, 'utf8'), { loader: 'tsx', format: 'cjs', jsx: 'automatic' }).code;
    runInNewContext(code, { ...globals, module, exports: module.exports, queueMicrotask, setTimeout, clearTimeout, require(id) {
      if (id.endsWith('.css')) return { __esModule: true, default: new Proxy({}, { get: (_, key) => String(key) }) };
      if (id === './icons/index.tsx') return { IconCheckOutlineRegular: Stub };
      if (id === './ShortcutKeys.tsx') return { ShortcutKeys: Stub };
      return id.startsWith('.') ? upstream(resolve(dirname(path), id)) : primitiveRequire(id);
    } });
    return module.exports;
  }
  const module = { exports: {} };
  const code = transformSync(source + '\nexport { Select, ToolTabs };', { loader: 'jsx', format: 'cjs' }).code;
  runInNewContext(code, { ...globals, module, exports: module.exports, URL, AbortController, fetch: options.fetch || globalThis.fetch, setTimeout, clearTimeout, require(id) {
    if (id === './http-response.mjs') return { readJsonResponse };
    if (id === 'react') return React;
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return { ...upstream(primitives), Modal: ({ open, children, footer }) => open ? React.createElement('div', { role: 'dialog' }, children, footer) : null, Tooltip: ({ children }) => children };
    if (id === './tool-settings-state.mjs') return state;
    if (id === '../shared/tool-quick-settings.mjs') return quickSettings;
    if (id === './tab-drag-scroll.mjs') return { createTabDragScroll };
    if (id === './iconsax.jsx') return { UIIcon: Stub };
    if (id === './tool-brand-icon.jsx') return { ToolBrandIcon: Stub };
    if (id === './provider-brand-icon.jsx') return { ProviderBrandIcon: Stub };
    return {};
  } });
  const root = createRoot(dom.window.document.getElementById('root'));
  const render = props => React.act(() => root.render(React.createElement(module.exports[component], props)));
  render(initialProps);
  return {
    document: dom.window.document, render,
    async flush() { await React.act(async () => { await Promise.resolve(); await Promise.resolve(); }); },
    event(target, type, fields = {}) {
      const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, ...fields });
      for (const key of ['pointerId', 'pointerType']) if (key in fields) Object.defineProperty(event, key, { value: fields[key] });
      React.act(() => target.dispatchEvent(event));
      return event;
    },
    click(target) {
      this.event(target, 'pointerdown', { button: 0, buttons: 1 });
      this.event(target, 'pointerup', { button: 0 });
      this.event(target, 'click', { button: 0, detail: 1 });
    },
    close() {
      React.act(() => root.unmount()); dom.window.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
      assert.deepEqual(errors, [], 'interactions must not produce browser errors');
    },
  };
}

test('Agent window selector closes when the same trigger is clicked again', () => {
  const changes = [], props = { label: 'Agent 窗口', value: '', options: [{ value: '', label: '跟随工具默认' }, { value: 'tmux', label: 'tmux' }], onChange: value => changes.push(value) };
  const view = mount('Select', props);
  try {
    const trigger = view.document.querySelector('.cmd-tool-select');
    for (let count = 0; count < 3; count++) {
      view.click(trigger);
      assert.equal(trigger.getAttribute('aria-expanded'), 'true');
      assert(view.document.querySelector('[role=menu]'));
      view.click(trigger);
      assert.equal(trigger.getAttribute('aria-expanded'), 'false');
      assert.equal(view.document.querySelector('[role=menu]'), null);
    }
    view.click(trigger);
    view.click(view.document.getElementById('outside'));
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    view.click(trigger);
    view.click(view.document.querySelector('[role=menuitem][data-selected=true]'));
    assert.deepEqual(changes, ['']);
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    view.click(trigger);
    React.act(() => view.document.dispatchEvent(new view.document.defaultView.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    view.click(trigger);
    view.render({ ...props, disabled: true });
    assert.equal(view.document.querySelector('[role=menu]'), null);
    view.render(props);
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  } finally { view.close(); }
});

test('top tabs scroll on a left drag without changing tabs, while clicks still work', () => {
  const changes = [], view = mount('ToolTabs', { tools: [{ id: 'claude', name: 'Claude' }, { id: 'codex', name: 'Codex' }], selected: 'claude', onChange: id => changes.push(id) });
  try {
    const nav = view.document.querySelector('[role=tablist]'), button = nav.querySelector('[data-tool=codex]');
    Object.defineProperties(nav, { scrollWidth: { value: 800 }, clientWidth: { value: 200 } });
    const captures = []; button.setPointerCapture = id => captures.push(id);
    const pointer = { pointerType: 'mouse', pointerId: 1, button: 0, buttons: 1 };
    view.event(button, 'pointerdown', { ...pointer, clientX: 120 });
    view.event(button, 'pointermove', { ...pointer, clientX: 118 });
    assert.equal(nav.scrollLeft, 0);
    view.event(button, 'pointermove', { ...pointer, clientX: 60 });
    assert.equal(nav.scrollLeft, 60);
    assert.equal(nav.dataset.dragging, 'true');
    view.event(button, 'pointerup', { ...pointer, buttons: 0 });
    view.event(button, 'click', { detail: 1 });
    assert.equal(nav.dataset.dragging, undefined);
    assert.deepEqual(changes, []);
    assert.deepEqual(captures, [1]);
    view.event(button, 'pointerdown', { ...pointer, clientX: 60 });
    view.event(button, 'pointerup', { ...pointer, buttons: 0 });
    view.event(button, 'click', { detail: 1 });
    assert.deepEqual(changes, ['codex']);
    React.act(() => nav.dispatchEvent(new view.document.defaultView.KeyboardEvent('keydown', { key: 'End', bubbles: true })));
    assert.deepEqual(changes, ['codex', 'codex']);
    for (const pointerType of ['touch', 'pen']) {
      view.event(button, 'pointerdown', { ...pointer, pointerType, clientX: 100 });
      view.event(button, 'pointermove', { ...pointer, pointerType, clientX: 20 });
      assert.equal(nav.scrollLeft, 60);
    }
    view.event(button, 'pointerdown', { ...pointer, button: 2, clientX: 100 });
    view.event(button, 'pointermove', { ...pointer, buttons: 2, clientX: 20 });
    assert.equal(nav.scrollLeft, 60);
    view.event(button, 'pointerdown', { ...pointer, clientX: 100 });
    view.event(button, 'pointermove', { ...pointer, clientX: 70 });
    view.event(button, 'pointercancel', pointer);
    assert.equal(nav.dataset.dragging, undefined);
    view.event(button, 'pointerdown', { ...pointer, clientX: 100 });
    view.event(button, 'pointermove', { ...pointer, clientX: 80 });
    view.event(button, 'lostpointercapture', pointer);
    assert.equal(nav.dataset.dragging, undefined);
    view.event(button, 'click', { detail: 0 });
    assert.equal(changes.at(-1), 'codex');
  } finally { view.close(); }
});

for (const action of ['install', 'update', 'reinstall']) test('npm ' + action + ' uses detected system source and locks it while running', async () => {
  const calls = [], installed = action !== 'install';
  const catalog = { tools: [{ id: 'codex', name: 'Codex', installer: 'npm', installed, installations: installed ? [{ path: '/usr/bin/codex', realpath: '/usr/bin/codex', source: 'npm', version: '1.2.3' }] : [], source: installed ? 'npm' : 'none', canInstall: !installed, canUpdate: installed, canReinstall: installed, canUninstall: installed }], profiles: [], capabilities: [{ tool: 'codex', configSupported: false, chatSupported: true }] };
  const fetch = async (_url, options) => { const input = JSON.parse(options.body); calls.push(input); const body = input.action === 'catalog' ? catalog : input.action === 'providers' ? { providers: [] } : { job: { id: 'job', toolId: 'codex', action, status: 'running', message: '正在执行' } }; return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }); };
  const view = mount('ToolSettingsSection', {}, { fetch });
  try { await view.flush(); assert.equal(view.document.querySelectorAll('[role=radio]').length, 0); assert.match(view.document.body.textContent, /系统工具的登录与配置由原工具管理/); const buttons = () => [...view.document.querySelectorAll('button')]; const button = buttons().find(item => item.textContent === ({ install: '安装', update: '更新系统工具', reinstall: '重装' })[action]); assert.equal(button.disabled, false); view.click(button); if (action === 'reinstall') view.click(buttons().find(item => item.textContent === '确认')); await view.flush(); assert.deepEqual(calls.find(input => input.action === action), { action, tool: 'codex' }); assert.match(view.document.body.textContent, /正在执行/); } finally { view.close(); }
});

test('running installation has no download source selector', async () => {
  const fetch = async (_url, options) => { const { action } = JSON.parse(options.body); const body = action === 'providers' ? { providers: [] } : { tools: [{ id: 'codex', name: 'Codex', installer: 'npm', canInstall: true, job: { id: 'running', toolId: 'codex', status: 'running', message: '安装中' } }], profiles: [] }; return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }); };
  const view = mount('ToolSettingsSection', {}, { fetch }); try { await view.flush(); assert.equal(view.document.querySelectorAll('[role=radio]').length, 0); } finally { view.close(); }
});
