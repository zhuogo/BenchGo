import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { connectDeviceSwitch, defaultWorkbench, defaultWorkbenchDevice, deviceSwitchFrameMessage, deviceSwitchItems, deviceSwitchState, saveDefaultWorkbench } from '../client/device-switch.mjs';
import { readJsonResponse } from '../../base/client/http-response.mjs';
import { deviceIcon, deviceKind, deviceStatus, workbenchUrl } from '../client/device-state.mjs';
import { observeHostTheme, sendWorkbenchTheme, themedWorkbenchUrl } from '../client/device-theme.mjs';

const require = createRequire(new URL('../package.json', import.meta.url));
const source = await readFile(new URL('../client/device-switch.jsx', import.meta.url), 'utf8');
const code = require('esbuild').transformSync(source, { loader: 'jsx', format: 'cjs' }).code;
const nodes = value => value && typeof value === 'object' ? [value, ...(value.children || []).flatMap(nodes)] : [];
const textOf = value => typeof value === 'object' ? (value?.children || []).map(textOf).join('') : String(value ?? '');
function frameAddress(frame) {
  const url = new URL(frame.props.src);
  url.hash = '';
  return url.href;
}

test('sidebar switch stays hidden for one device and labels the real active workbench', () => {
  assert.equal(deviceSwitchState({ devices: [] }).multiple, false);
  assert.equal(deviceSwitchItems([{ id: 'local', name: '  本机  ', kind: 'local' }, { id: '', name: '空' }, { kind: 'computer', name: '缺编号' }]).length, 1);
  const several = deviceSwitchState({ devices: [{ id: 'local', name: '本机', kind: 'local', status: 'online' }, { id: 'cloud', name: 'dsh.draftgo.cn', kind: 'computer', status: 'online' }], activeId: null, open: true });
  assert.equal(several.multiple, true);
  assert.equal(several.active.name, '本机');
  assert.equal(several.open, true);
  assert.equal(deviceSwitchState({ devices: several.items, activeId: 'cloud', busy: 'cloud', open: true }).open, false);
});

function fixture(responses, storage = new Map()) {
  let cursor = 0, dirty = true, tree;
  const slots = [], effects = [], requests = [];
  const listeners = new Map(), windowListeners = new Map(), timers = new Map(), intervals = new Map();
  const document = {
    documentElement: { attributes: new Set(['data-windows-titlebar']), hasAttribute(name) { return this.attributes.has(name); }, toggleAttribute(name, force) { force ? this.attributes.add(name) : this.attributes.delete(name); }, removeAttribute(name) { this.attributes.delete(name); } },
    body: {}, baseURI: 'http://127.0.0.1:8000/',
    addEventListener(type, fn) { listeners.set(type, fn); }, removeEventListener(type) { listeners.delete(type); },
    dispatchEvent(event) { listeners.get(event.type)?.(event); return true; },
  };
  const react = {
    createElement(type, props, ...children) {
      if (type === 'Menu') children = [props.anchor, ...(props.open ? [...props.items, ...(props.footer ?? [])].filter(item => !item.type).map(item => ({ type: 'button', props: { role: 'menuitem', onClick: () => props.onSelect(item.id) }, children: [item.label] })).concat(children) : [])];
      return { type, props: props || {}, children: children.flat(Infinity).filter(item => item !== false && item != null) };
    },
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], value => { const next = typeof value === 'function' ? value(slots[i]) : value; if (!Object.is(next, slots[i])) { slots[i] = next; dirty = true; } }]; },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useEffect(fn, deps) { const i = cursor++, old = slots[i]; if (!old || !deps || deps.some((value, j) => !Object.is(value, old.deps[j]))) { slots[i] = { deps, cleanup: old?.cleanup }; effects.push(() => { slots[i].cleanup?.(); slots[i].cleanup = fn(); }); } },
  };
  const host = { document, location: new URL(document.baseURI), localStorage: {
    getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key),
  }, innerWidth: 1280, addEventListener(type, fn) { windowListeners.set(type, fn); }, removeEventListener(type) { windowListeners.delete(type); } };
  const module = { exports: {} };
  runInNewContext(code, { module, exports: module.exports, globalThis: host, window: host, location: host.location, URL, URLSearchParams, document, AbortSignal,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    setTimeout(fn) { const id = {}; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
    setInterval(fn) { const id = {}; intervals.set(id, fn); return id; }, clearInterval(id) { intervals.delete(id); },
    fetch: async (url, input) => { requests.push({ url: String(url), body: input.body }); const next = await responses.shift(); if (next instanceof Response) return next; return Response.json(next); },
    require: id => id === 'react' ? react : id === 'react-dom' ? { createPortal: child => child } : id.includes('ui-primitives') ? { Menu: 'Menu' } : id.includes('http-response') ? { readJsonResponse } : id.includes('device-switch.mjs') ? { deviceSwitchState, connectDeviceSwitch: args => connectDeviceSwitch({ ...args, host }), defaultWorkbench, defaultWorkbenchDevice, deviceSwitchFrameMessage, saveDefaultWorkbench } : id.includes('device-theme') ? { observeHostTheme: fn => observeHostTheme(fn, host), sendWorkbenchTheme, themedWorkbenchUrl: url => themedWorkbenchUrl(url, host) } : { deviceIcon, deviceKind, deviceStatus, workbenchUrl },
  });
  const render = () => { dirty = false; cursor = 0; tree = module.exports.DeviceSwitch(); for (const effect of effects.splice(0)) effect(); };
  return { host, requests, document, listeners, windowListeners, timers, expire() { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); }, poll() { for (const fn of intervals.values()) fn(); }, get tree() { return tree; }, nodes: () => nodes(tree), async settle() { for (let i = 0; i < 8; i++) { if (dirty) render(); await new Promise(resolve => setImmediate(resolve)); } }, unmount() { for (const slot of slots) slot?.cleanup?.(); } };
}

test('unresponsive workbench times out and retry obtains a fresh entry instead of replaying a ticket', async () => {
  const devices = [{ id: 'local', name: '本机', kind: 'local' }, { id: 'cloud', name: '服务器', kind: 'computer' }];
  const view = fixture([{ devices }, { url: 'http://127.0.0.1:9101/enter?ticket=one' }, { devices }, { devices }, { url: 'http://127.0.0.1:9101/enter?ticket=two' }, { devices }]);
  await view.settle();
  view.listeners.get('benchgo:device-select')({ detail: { deviceId: 'cloud' } }); await view.settle();
  assert.equal(frameAddress(view.nodes().find(node => node.type === 'iframe')), 'http://127.0.0.1:9101/enter?ticket=one');
  view.expire(); await view.settle();
  const trigger = () => view.nodes().find(node => node.props.className === 'dsh-device-switch-trigger');
  assert.equal(trigger().props['data-connection-error'], '');
  assert.equal(trigger().props['aria-expanded'], false);
  assert.equal(view.nodes().find(node => node.props.className === 'dsh-device-switch-stage').props.hidden, true);
  trigger().props.onClick(); await view.settle();
  assert(view.nodes().some(node => node.props.role === 'alert' && textOf(node).includes('设备工作台未响应')));
  await view.nodes().find(node => node.props.role === 'menuitem' && textOf(node).includes('服务器')).props.onClick(); await view.settle();
  assert.equal(frameAddress(view.nodes().find(node => node.type === 'iframe')), 'http://127.0.0.1:9101/enter?ticket=two');
  assert.equal(view.requests.filter(item => JSON.parse(item.body).action === 'select').length, 2);
  assert.equal(defaultWorkbench(view.host), null);
  const child = { postMessage() {} }, frame = view.nodes().find(node => node.type === 'iframe');
  frame.props.ref({ contentWindow: child }); frame.props.onLoad({ currentTarget: { contentWindow: child } }); await view.settle();
  view.windowListeners.get('message')({ source: child, origin: 'http://127.0.0.1:9101', data: { type: 'benchgo:device-switch:ready' } }); await view.settle();
  assert.equal(trigger().props['data-connection-error'], undefined);
  assert.equal(defaultWorkbench(view.host), 'cloud');
  assert.equal(view.nodes().filter(node => node.props.className === 'dsh-device-switch-loading').length, 0);
  assert.equal(view.timers.size, 0);
  view.listeners.get('benchgo:device-select')({ detail: { deviceId: 'local' } }); await view.settle();
  assert.equal(defaultWorkbench(view.host), null);
  assert.equal(view.nodes().find(node => node.props.className === 'dsh-device-switch-stage').props.hidden, true);
  view.unmount(); assert.equal(view.timers.size, 0);
});

test('device center selection refreshes a newly paired target before opening its workspace', async () => {
  const devices = [{ id: 'local', name: '本机', kind: 'local' }, { id: 'new', name: '新设备', kind: 'computer' }];
  const view = fixture([{ devices: devices.slice(0, 1) }, { devices }, { url: 'http://127.0.0.1:9102/enter?ticket=new' }, { devices }]);
  await view.settle();
  view.listeners.get('benchgo:device-select')({ detail: { deviceId: 'new' } }); await view.settle();
  assert.equal(frameAddress(view.nodes().find(node => node.type === 'iframe')), 'http://127.0.0.1:9102/enter?ticket=new');
  view.nodes().find(node => node.type === 'iframe').props.onError(); await view.settle();
  const trigger = view.nodes().find(node => node.props.className === 'dsh-device-switch-trigger');
  assert.equal(trigger.props['data-connection-error'], '');
  trigger.props.onClick(); await view.settle();
  assert(view.nodes().some(node => node.props.role === 'alert' && textOf(node).includes('加载失败')));
  view.unmount();
});

test('a Windows workbench selection forwards a structured SSH authentication failure to the device center', async () => {
  const devices = [{ id: 'ssh-server', name: '香港', kind: 'ssh', sshManaged: true }];
  const response = Response.json({ error: '请重新认证 SSH', code: 'SSH_AUTH_REQUIRED' }, { status: 401 });
  const view = fixture([{ devices }, response]); await view.settle();
  const requests = [];
  view.document.addEventListener('benchgo:device-ssh-auth', event => requests.push(event.detail.deviceId));
  view.listeners.get('benchgo:device-select')({ detail: { deviceId: 'ssh-server' } }); await view.settle();
  assert.deepEqual(requests, ['ssh-server']);
  assert.equal(view.nodes().some(node => node.type === 'iframe'), false);
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
  assert.equal(frameAddress(frame), 'http://127.0.0.1:9101/s/work/');
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

test('startup retries the last workbench and remembers an explicit return to local', async () => {
  const local = { id: 'local', name: '本机', kind: 'local', status: 'online' };
  const remote = { id: 'cloud', name: '服务器', kind: 'computer', status: 'online' };
  const devices = [local, remote];
  const storage = new Map();
  const original = fixture([], storage);
  assert.equal(saveDefaultWorkbench(remote, original.host), true);
  const unavailable = Response.json({ error: '服务器离线' }, { status: 503 });
  const restored = fixture([{ devices }, unavailable, { devices }, { url: 'http://127.0.0.1:9101/enter?ticket=retry' }, { devices }], storage);
  await restored.settle();
  assert.equal(restored.requests.filter(item => JSON.parse(item.body).action === 'select').length, 1);
  const trigger = restored.nodes().find(node => node.props.className === 'dsh-device-switch-trigger');
  assert.equal(trigger.props['aria-label'], '当前工作台：本机，设备切换失败');
  assert.equal(trigger.props['aria-expanded'], false);
  trigger.props.onClick(); await restored.settle();
  assert(restored.nodes().some(node => node.props.role === 'alert' && textOf(node).includes('服务器离线')));
  assert.equal(defaultWorkbench(restored.host), remote.id);
  restored.nodes().find(node => node.props.role === 'menuitem' && textOf(node).includes('服务器')).props.onClick();
  await restored.settle();
  assert.equal(frameAddress(restored.nodes().find(node => node.type === 'iframe')), 'http://127.0.0.1:9101/enter?ticket=retry');
  restored.nodes().find(node => node.type === 'button' && textOf(node) === '返回本机').props.onClick();
  await restored.settle();
  assert.equal(defaultWorkbench(restored.host), null);
  restored.unmount();
});

test('a saved default is cleared when the successful directory no longer lists it', async () => {
  const local = { id: 'local', name: '本机', kind: 'local', status: 'online' };
  const storage = new Map();
  const view = fixture([Response.json({ error: '目录暂不可用' }, { status: 503 }), { devices: [local] }], storage);
  saveDefaultWorkbench({ id: 'cloud', kind: 'computer' }, view.host);
  await view.settle();
  assert.equal(defaultWorkbench(view.host), 'cloud');
  view.listeners.get('benchgo:devices-changed')();
  await view.settle();
  assert.equal(defaultWorkbench(view.host), null);
  assert.equal(view.tree, null);
});

test('a default workbench follows the same host when its connection becomes a group member', async () => {
  const local = { id: 'local', name: '本机', kind: 'local' };
  const paired = { id: 'saved-connection', hostId: 'sha256:server', name: '服务器', kind: 'computer' };
  const member = { ...paired, id: paired.hostId };
  const devices = [local, member];
  const view = fixture([{ devices }, { url: 'http://127.0.0.1:9101/enter?ticket=group' }, { devices }]);
  saveDefaultWorkbench(paired, view.host);
  await view.settle();
  assert.equal(defaultWorkbench(view.host), member.id);
  const selection = view.requests.map(request => JSON.parse(request.body)).find(request => request.action === 'select');
  assert.equal(selection?.deviceId, member.id);
  view.unmount();
});

test('removing a member discards its retained workbench and joining again requires a new entry', async () => {
  const local = { id: 'local', name: '本机', kind: 'local' };
  const remote = { id: 'cloud', name: '服务器', kind: 'computer' };
  const devices = [local, remote];
  const groupDirectory = { devices, groupEnabled: true };
  const view = fixture([
    groupDirectory, { url: 'http://127.0.0.1:9101/enter?ticket=first' }, groupDirectory,
    { devices: [local], groupEnabled: true }, groupDirectory, { url: 'http://127.0.0.1:9101/enter?ticket=second' }, groupDirectory,
  ]);
  await view.settle();
  const select = () => view.listeners.get('benchgo:device-select')({ detail: { deviceId: remote.id } });
  select();
  await view.settle();
  assert.match(frameAddress(view.nodes().find(node => node.type === 'iframe')), /ticket=first$/);
  view.document.visibilityState = 'hidden';
  const initialRequests = view.requests.length;
  view.poll();
  await view.settle();
  assert.equal(view.requests.length, initialRequests);
  view.document.visibilityState = 'visible';
  view.poll();
  await view.settle();
  assert.equal(view.tree, null);
  view.poll();
  await view.settle();
  assert.equal(view.nodes().some(node => node.type === 'iframe'), false);
  select();
  await view.settle();
  assert.match(frameAddress(view.nodes().find(node => node.type === 'iframe')), /ticket=second$/);
  view.unmount();
  const requestsAfterUnmount = view.requests.length;
  view.poll();
  assert.equal(view.requests.length, requestsAfterUnmount);
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

const groupDevices = [
  { id: 'local', name: '本机', kind: 'local', hostId: 'host-a', groupMember: true },
  { id: 'cloud', name: '主服务器', kind: 'computer', hostId: 'host-b', groupMember: true },
  { id: 'ssh-c', name: '项目服务器', kind: 'ssh', hostId: 'host-c', groupMember: true },
];
const groupDirectory = { devices: groupDevices, groupEnabled: true };
const cloudOrigin = 'http://127.0.0.1:9101';
const sshOrigin = 'http://127.0.0.1:9102';
const resourceClick = (hostId, requestId = '1'.repeat(32)) => ({ type: 'benchgo:device-switch:resource', hostId, requestId, resource: { kind: 'projects', resourceId: 'project' } });

function connectFrame(view, origin) {
  const frame = () => view.nodes().find(node => node.type === 'iframe' && new URL(node.props.src).origin === origin);
  const messages = [];
  const child = { postMessage(data) { messages.push(data); } };
  frame().props.ref({ contentWindow: child });
  const receive = (data, from = origin, source = child) => view.windowListeners.get('message')({ source, origin: from, data });
  receive({ type: 'benchgo:device-switch:ready' });
  receive({ type: 'benchgo:resource:ready' });
  return { frame, receive, messages };
}

test('a group workbench waits for the target resource and restores the source on failure', async () => {
  const view = fixture([groupDirectory, { url: cloudOrigin + '/entry' }, groupDirectory, { url: sshOrigin + '/entry' }, groupDirectory]);
  await view.settle();
  view.listeners.get('benchgo:device-select')({ detail: { deviceId: 'cloud' } });
  await view.settle();
  const source = connectFrame(view, cloudOrigin);
  await view.settle();
  const open = resourceClick('host-c');
  source.receive(open, sshOrigin);
  source.receive(open, cloudOrigin, {});
  assert.equal(view.requests.filter(row => JSON.parse(row.body).action === 'select').length, 1);

  source.receive(open);
  await view.settle();
  assert.equal(JSON.parse(view.requests.find(row => row.body.includes('ssh-c')).body).deviceId, 'ssh-c');
  const target = connectFrame(view, sshOrigin);
  await view.settle();
  assert.equal(source.frame().props.hidden, true);
  assert.equal(target.frame().props.hidden, false);
  const sent = target.messages.find(data => data.type === 'benchgo:resource:open');
  assert.equal(sent?.requestId, open.requestId);
  assert.equal(sent.resource.resourceId, 'project');
  const results = () => source.messages.filter(data => data.type === 'benchgo:device-switch:resource-result');
  assert.equal(results().length, 0);

  const localRequests = [];
  view.document.addEventListener('benchgo:device-resource', event => localRequests.push(event.detail));
  const local = resourceClick('host-a', '2'.repeat(32));
  source.receive(local);
  await view.settle();
  assert.equal(localRequests.length, 0, 'a hidden workbench cannot send another resource selection');
  const error = { type: 'benchgo:resource:opened', requestId: open.requestId, error: '项目不可用' };
  target.receive(error, cloudOrigin);
  assert.equal(results().length, 0);
  target.receive(error);
  await view.settle();
  assert.equal(source.frame().props.hidden, false);
  assert.equal(target.frame().props.hidden, true);
  assert.equal(results().at(-1)?.error, '项目不可用');

  source.receive(local);
  await view.settle();
  assert.equal(localRequests[0]?.requestId, local.requestId);
  assert.equal(results().length, 1);
  view.windowListeners.get('benchgo:device-resource-opened')({ detail: { requestId: local.requestId } });
  assert.equal(results().at(-1)?.requestId, local.requestId);
  assert.equal(results().at(-1)?.error, undefined);
  view.unmount();
  assert.equal(view.timers.size, 0);
});

test('a resource ticket is discarded if its source leaves the group while opening', async () => {
  let completeSelection;
  const pending = new Promise(resolve => { completeSelection = resolve; });
  const pruned = { devices: groupDevices.filter(device => device.id !== 'cloud'), groupEnabled: true };
  const view = fixture([groupDirectory, { url: cloudOrigin + '/entry' }, groupDirectory, pending, pruned]);
  await view.settle();
  view.listeners.get('benchgo:device-select')({ detail: { deviceId: 'cloud' } });
  await view.settle();
  const source = connectFrame(view, cloudOrigin);
  await view.settle();
  source.receive(resourceClick('host-c'));
  await view.settle();
  view.poll();
  await view.settle();
  assert.equal(source.frame(), undefined);
  completeSelection({ url: sshOrigin + '/entry' });
  await view.settle();
  assert.equal(view.nodes().some(node => node.type === 'iframe'), false);
  view.unmount();
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
  const frame = view.nodes().find(node => node.type === 'iframe'); frame.props.ref({ contentWindow: child }); frame.props.onLoad({ currentTarget: { contentWindow: child } }); await view.settle();
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
