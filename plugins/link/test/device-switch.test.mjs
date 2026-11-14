import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { connectDeviceSwitch, deviceSwitchFrameMessage, deviceSwitchItems, deviceSwitchState } from '../client/device-switch.mjs';
import { readJsonResponse } from '../../benchgo/client/http-response.mjs';
import { deviceIcon, deviceKind, deviceStatus, workbenchUrl } from '../client/device-state.mjs';

const require = createRequire(new URL('../package.json', import.meta.url));
const source = await readFile(new URL('../client/device-switch.jsx', import.meta.url), 'utf8');
const code = require('esbuild').transformSync(source, { loader: 'jsx', format: 'cjs' }).code;
const nodes = value => value && typeof value === 'object' ? [value, ...(value.children || []).flatMap(nodes)] : [];
const textOf = value => typeof value === 'object' ? (value?.children || []).map(textOf).join('') : String(value ?? '');

test('sidebar switch stays hidden for one device and labels the real active workbench', () => {
  assert.equal(deviceSwitchState({ devices: [] }).multiple, false);
  assert.equal(deviceSwitchItems([{ id: 'local', name: '  本机  ', kind: 'local' }, { id: '', name: '空' }, { kind: 'computer', name: '缺编号' }]).length, 1);
  const several = deviceSwitchState({ devices: [{ id: 'local', name: '本机', kind: 'local', status: 'online' }, { id: 'cloud', name: 'dsh.draftgo.cn', kind: 'computer', status: 'online' }], activeId: null, open: true });
  assert.equal(several.multiple, true);
  assert.equal(several.active.name, '本机');
  assert.equal(several.open, true);
  assert.equal(deviceSwitchState({ devices: several.items, activeId: 'cloud', busy: 'cloud', open: true }).open, false);
});

function fixture(responses) {
  let cursor = 0, dirty = true, tree;
  const slots = [], effects = [], requests = [];
  const listeners = new Map(), windowListeners = new Map(), timers = new Map();
  const document = {
    documentElement: { attributes: new Set(['data-windows-titlebar']), hasAttribute(name) { return this.attributes.has(name); }, toggleAttribute(name, force) { force ? this.attributes.add(name) : this.attributes.delete(name); }, removeAttribute(name) { this.attributes.delete(name); } },
    body: {}, baseURI: 'http://127.0.0.1:8000/',
    addEventListener(type, fn) { listeners.set(type, fn); }, removeEventListener(type) { listeners.delete(type); },
    dispatchEvent(event) { listeners.get(event.type)?.(event); return true; },
  };
  const react = {
    createElement(type, props, ...children) {
      if (type === 'Menu') children = [props.anchor, ...(props.open ? props.items.filter(item => !item.type).map(item => ({ type: 'button', props: { role: 'menuitem', onClick: () => props.onSelect(item.id) }, children: [item.label] })).concat(children) : [])];
      return { type, props: props || {}, children: children.flat(Infinity).filter(item => item !== false && item != null) };
    },
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], value => { const next = typeof value === 'function' ? value(slots[i]) : value; if (!Object.is(next, slots[i])) { slots[i] = next; dirty = true; } }]; },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useEffect(fn, deps) { const i = cursor++, old = slots[i]; if (!old || !deps || deps.some((value, j) => !Object.is(value, old.deps[j]))) { slots[i] = { deps, cleanup: old?.cleanup }; effects.push(() => { slots[i].cleanup?.(); slots[i].cleanup = fn(); }); } },
  };
  const host = { document, location: new URL(document.baseURI), innerWidth: 1280, addEventListener(type, fn) { windowListeners.set(type, fn); }, removeEventListener(type) { windowListeners.delete(type); } };
  const module = { exports: {} };
  runInNewContext(code, { module, exports: module.exports, globalThis: host, window: host, location: host.location, URL, document, AbortSignal,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    setTimeout(fn) { const id = {}; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
    fetch: async (url, input) => { requests.push({ url: String(url), body: input.body }); const next = responses.shift(); if (next instanceof Response) return next; return Response.json(next); },
    require: id => id === 'react' ? react : id === 'react-dom' ? { createPortal: child => child } : id.includes('ui-primitives') ? { Menu: 'Menu' } : id.includes('http-response') ? { readJsonResponse } : id.includes('device-switch.mjs') ? { deviceSwitchState, connectDeviceSwitch: args => connectDeviceSwitch({ ...args, host }), deviceSwitchFrameMessage } : { deviceIcon, deviceKind, deviceStatus, workbenchUrl },
  });
  const render = () => { dirty = false; cursor = 0; tree = module.exports.DeviceSwitch(); for (const effect of effects.splice(0)) effect(); };
  return { host, requests, document, listeners, windowListeners, timers, expire() { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); }, get tree() { return tree; }, nodes: () => nodes(tree), async settle() { for (let i = 0; i < 8; i++) { if (dirty) render(); await new Promise(resolve => setImmediate(resolve)); } }, unmount() { for (const slot of slots) slot?.cleanup?.(); } };
}

test('unresponsive workbench times out and retry obtains a fresh entry instead of replaying a ticket', async () => {
  const devices = [{ id: 'local', name: '本机', kind: 'local' }, { id: 'cloud', name: '服务器', kind: 'computer' }];
  const view = fixture([{ devices }, { url: 'http://127.0.0.1:9101/enter?ticket=one' }, { devices }, { url: 'http://127.0.0.1:9101/enter?ticket=two' }, { devices }]);
  await view.settle();
  view.listeners.get('benchgo:device-select')({ detail: { deviceId: 'cloud' } }); await view.settle();
  assert.equal(view.nodes().find(node => node.type === 'iframe').props.src, 'http://127.0.0.1:9101/enter?ticket=one');
  view.expire(); await view.settle();
  assert(view.nodes().some(node => node.props.role === 'alert' && textOf(node).includes('设备工作台未响应')));
  await view.nodes().find(node => node.type === 'button' && textOf(node) === '重试').props.onClick(); await view.settle();
  assert.equal(view.nodes().find(node => node.type === 'iframe').props.src, 'http://127.0.0.1:9101/enter?ticket=two');
  assert.equal(view.requests.filter(item => JSON.parse(item.body).action === 'select').length, 2);
  const child = { postMessage() {} }, frame = view.nodes().find(node => node.type === 'iframe');
  frame.props.ref({ contentWindow: child }); frame.props.onLoad(); await view.settle();
  view.windowListeners.get('message')({ source: child, origin: 'http://127.0.0.1:9101', data: { type: 'benchgo:device-switch:ready' } }); await view.settle();
  assert.equal(view.nodes().filter(node => node.props.className === 'dsh-device-switch-loading').length, 0);
  assert.equal(view.timers.size, 0);
  view.listeners.get('benchgo:device-select')({ detail: { deviceId: 'local' } }); await view.settle();
  assert.equal(view.nodes().find(node => node.props.className === 'dsh-device-switch-stage').props.hidden, true);
  view.unmount(); assert.equal(view.timers.size, 0);
});

test('device center selection refreshes a newly paired target before opening its workspace', async () => {
  const devices = [{ id: 'local', name: '本机', kind: 'local' }, { id: 'new', name: '新设备', kind: 'computer' }];
  const view = fixture([{ devices: devices.slice(0, 1) }, { devices }, { url: 'http://127.0.0.1:9102/enter?ticket=new' }, { devices }]);
  await view.settle();
  view.listeners.get('benchgo:device-select')({ detail: { deviceId: 'new' } }); await view.settle();
  assert.equal(view.nodes().find(node => node.type === 'iframe').props.src, 'http://127.0.0.1:9102/enter?ticket=new');
  view.nodes().find(node => node.type === 'iframe').props.onError(); await view.settle();
  assert(view.nodes().some(node => node.props.role === 'alert' && textOf(node).includes('加载失败')));
  view.unmount();
});

test('Windows sidebar lists saved devices and preserves local and remote pages', async () => {
  const view = fixture([
    { devices: [{ id: 'local', name: '本机', kind: 'local', status: 'online' }, { id: 'cloud', name: 'dsh.draftgo.cn', kind: 'computer', status: 'online' }] },
    { devices: [{ id: 'local', name: '本机', kind: 'local', status: 'online' }, { id: 'cloud', name: 'dsh.draftgo.cn', kind: 'computer', status: 'online' }] },
    { device: { id: 'cloud', kind: 'computer' }, url: 'http://127.0.0.1:9101/s/work/' },
    { devices: [{ id: 'local', name: '本机', kind: 'local', status: 'online' }, { id: 'cloud', name: 'dsh.draftgo.cn', kind: 'computer', status: 'online' }] },
  ]);
  await view.settle();
  const trigger = view.nodes().find(node => node.props.className === 'dsh-device-switch-trigger');
  assert.equal(trigger.props['aria-label'], '当前工作台：本机');
  trigger.props.onClick(); await view.settle();
  const cloud = view.nodes().find(node => node.props.role === 'menuitem' && textOf(node).includes('dsh.draftgo.cn'));
  await cloud.props.onClick(); await view.settle();
  assert.equal(view.requests[2].url, 'http://127.0.0.1:8000/api/commander-devices');
  assert.equal(JSON.parse(view.requests.find(item => item.body?.includes('"select"')).body).deviceId, 'cloud');
  const frame = view.nodes().find(node => node.type === 'iframe');
  assert.equal(frame.props.src, 'http://127.0.0.1:9101/s/work/');
  assert.equal(frame.props.hidden, false);
  assert.equal(view.nodes().find(node => node.props.className === 'dsh-device-switch-stage').props.hidden, false);
  view.nodes().find(node => node.props['aria-label'] === '当前工作台：dsh.draftgo.cn').props.onClick(); await view.settle();
  await view.nodes().find(node => node.props.role === 'menuitem' && textOf(node).includes('本机')).props.onClick(); await view.settle();
  assert.equal(view.nodes().find(node => node.type === 'iframe').props.hidden, true);
  assert.equal(view.nodes().find(node => node.props.className === 'dsh-device-switch-stage').props.hidden, true);
  assert.equal(view.requests.filter(item => item.body?.includes('"select"')).length, 1);
  view.unmount();
  assert.equal(view.listeners.size, 0);
});

test('owner switch stays absent outside Windows and when no other device is saved', async () => {
  const absent = fixture([]); absent.document.documentElement.removeAttribute('data-windows-titlebar'); await absent.settle();
  assert.equal(absent.tree, null); assert.equal(absent.requests.length, 0);
  const single = fixture([{ devices: [{ id: 'local', name: '本机', kind: 'local', status: 'online' }] }]); await single.settle();
  assert.equal(single.tree, null);
});

test('device center changes reveal a newly paired device without remounting', async () => {
  const view = fixture([{ devices: [] }, { devices: [{ id: 'remote', name: '工作电脑', kind: 'computer' }] }]);
  await view.settle(); assert.equal(view.tree, null);
  view.listeners.get('benchgo:devices-changed')(); await view.settle();
  assert(view.nodes().some(node => node.props['aria-label'] === '当前工作台：本机'));
  view.unmount();
});

test('embedded selector locks its parent origin and only sends opaque device ids', () => {
  const listeners = new Map(), sent = [], changes = [], parent = { postMessage: (data, origin) => sent.push({ data, origin }) };
  const host = { parent, addEventListener: (type, handler) => listeners.set(type, handler), removeEventListener: type => listeners.delete(type) };
  const bridge = connectDeviceSwitch({ host, onChange: value => changes.push(value) });
  assert.equal(sent[0].data.type, 'benchgo:device-switch:ready');
  const init = { type: 'benchgo:device-switch:init', devices: [{ id: 'opaque:/remote', name: '工作电脑', kind: 'computer' }], activeId: 'opaque:/remote' };
  const emit = (source, origin, data = init) => listeners.get('message')({ source, origin, data });
  emit({}, 'https://owner.test'); emit(parent, 'null'); assert.equal(changes.length, 0);
  emit(parent, 'https://owner.test'); emit(parent, 'https://fake.test');
  assert.equal(changes.length, 1); assert.equal(changes[0].activeId, 'opaque:/remote');
  bridge.select('opaque:/remote'); assert.deepEqual(sent.at(-1), { data: { type: 'benchgo:device-switch:select', deviceId: 'opaque:/remote' }, origin: 'https://owner.test' });
  emit(parent, 'https://owner.test', { type: 'benchgo:device-switch:probe' }); assert.equal(sent.at(-1).data.type, 'benchgo:device-switch:ready');
  bridge.dispose(); assert.equal(listeners.size, 0);
});

test('owner accepts device selections only from mounted frames at their exact origin', () => {
  const child = {}, frames = [{ id: 'remote', window: child, url: 'https://workbench.test/s/one/' }];
  const data = { type: 'benchgo:device-switch:select', deviceId: 'local' };
  assert.equal(deviceSwitchFrameMessage({ source: {}, origin: 'https://workbench.test', data }, frames), null);
  assert.equal(deviceSwitchFrameMessage({ source: child, origin: 'https://fake.test', data }, frames), null);
  assert.equal(deviceSwitchFrameMessage({ source: child, origin: 'https://workbench.test', data }, frames).deviceId, 'local');
});

test('desktop sidebar control requires the initialized parent and keeps ordinary embedded controls local', () => {
  const listeners = new Map(), sent = [], parent = { postMessage: (data, origin) => sent.push({ data, origin }) };
  const host = { parent, addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: type => listeners.delete(type) };
  let toggles = 0;
  const bridge = connectDeviceSwitch({ host, onSidebarToggle: () => toggles++ });
  const emit = (data, source = parent, origin = 'https://owner.test') => listeners.get('message')({ source, origin, data });
  emit({ type: 'benchgo:sidebar:toggle' }); assert.equal(toggles, 0);
  const init = { type: 'benchgo:device-switch:init', devices: [], desktopSidebar: false };
  emit(init); emit({ type: 'benchgo:sidebar:toggle' }); bridge.sidebarState(true);
  assert.equal(toggles, 0); assert.equal(sent.length, 1);
  emit({ ...init, desktopSidebar: true });
  emit({ type: 'benchgo:sidebar:toggle' }, {}); emit({ type: 'benchgo:sidebar:toggle' }, parent, 'https://evil.test');
  assert.equal(toggles, 0);
  emit({ type: 'benchgo:sidebar:toggle' }); assert.equal(toggles, 1);
  bridge.sidebarState(true);
  assert.deepEqual(sent.at(-1), { data: { type: 'benchgo:sidebar:state', collapsed: true }, origin: 'https://owner.test' });
  bridge.dispose(); assert.equal(listeners.size, 0);
});

test('caption toggle forwards to the active ready remote without changing the local sidebar', async () => {
  const devices = [{ id: 'local', name: '本机', kind: 'local' }, { id: 'remote', name: '服务器', kind: 'computer' }];
  const view = fixture([{ devices }, { url: 'http://127.0.0.1:9101/enter?ticket=one' }, { devices }]); await view.settle();
  let prevented = 0;
  view.listeners.get('benchgo:sidebar-toggle')({ preventDefault() { prevented++; } });
  assert.equal(prevented, 0);
  view.listeners.get('benchgo:device-select')({ detail: { deviceId: 'remote' } }); await view.settle();
  const sent = [], child = { postMessage(data, origin) { sent.push({ data, origin }); } };
  const frame = view.nodes().find(node => node.type === 'iframe'); frame.props.ref({ contentWindow: child }); frame.props.onLoad(); await view.settle();
  view.windowListeners.get('message')({ source: child, origin: 'http://127.0.0.1:9101', data: { type: 'benchgo:device-switch:ready' } }); await view.settle();
  assert.equal(sent.find(item => item.data.type === 'benchgo:device-switch:init').data.desktopSidebar, true);
  view.listeners.get('benchgo:sidebar-toggle')({ preventDefault() { prevented++; } });
  assert.equal(prevented, 1); assert.equal(sent.at(-1).data.type, 'benchgo:sidebar:toggle');
  const states = []; view.document.addEventListener('benchgo:desktop-sidebar-state', event => states.push(event.detail.collapsed));
  const state = { type: 'benchgo:sidebar:state', collapsed: true };
  view.windowListeners.get('message')({ source: {}, origin: 'http://127.0.0.1:9101', data: state });
  view.windowListeners.get('message')({ source: child, origin: 'https://evil.test', data: state }); assert.deepEqual(states, []);
  view.windowListeners.get('message')({ source: child, origin: 'http://127.0.0.1:9101', data: state }); assert.deepEqual(states, [true]);
  view.listeners.get('benchgo:device-select')({ detail: { deviceId: 'local' } }); await view.settle();
  assert.equal(states.at(-1), null);
  view.listeners.get('benchgo:sidebar-toggle')({ preventDefault() { prevented++; } }); assert.equal(prevented, 1);
  view.unmount();
});
