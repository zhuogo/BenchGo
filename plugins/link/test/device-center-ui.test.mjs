import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { deviceIcon, deviceKind, deviceStatus, jobFinished, sshInput, workbenchUrl } from '../client/device-state.mjs';
import { workbenchNavigationMessage } from '../client/device-navigation.mjs';
import { deviceSwitchFrameMessage } from '../client/device-switch.mjs';

const require = createRequire(new URL('../../benchgo/package.json', import.meta.url));
const source = await readFile(new URL('../client/device-center.jsx', import.meta.url), 'utf8');
const code = require('esbuild').transformSync(source + '\nexport { AddComputer, AddServer, AddDevice, ManageDevice, RelayWizard, RelayPool };', { loader: 'jsx', format: 'cjs' }).code;
const nodes = value => value && typeof value === 'object' ? [value, ...(value.children || []).flatMap(nodes)] : [];
const textOf = value => typeof value === 'object' ? (value?.children || []).map(textOf).join('') : String(value ?? '');

function fixture(component, props = {}) {
  let cursor = 0, dirty = true, tree, pairStatus = 'pending';
  const slots = [], effects = [], timers = new Map(), calls = [], listeners = new Map();
  const devices = [{ id: 'local', name: '本机', kind: 'local', status: 'online' }, { id: 'desk', name: '开发电脑', kind: 'computer', status: 'unknown' }, { id: 'server', name: '云端', kind: 'ssh', status: 'offline' }];
  const runtime = { isNative: () => false, bootstrap: () => null, clientName: () => '这台电脑', async call(action, args) {
    calls.push({ action, args });
    if (action === 'list') return { devices, capabilities: { ssh: true, hostAdmin: true } };
    if (action === 'select') { if (args.deviceId === 'server') throw new Error('SSH 隧道未连接'); return { device: devices.find(item => item.id === args.deviceId), url: args.deviceId === 'local' ? null : 'http://127.0.0.1:17771/s/one/' }; }
    if (action === 'pair') return { requestId: 'pair-id' };
    if (action === 'pairStatus') return { status: pairStatus, ...(pairStatus === 'approved' ? { device: devices[1] } : {}) };
    if (action === 'sshProbe') return { fingerprint: 'SHA256:valid' };
    if (action === 'sshConnect') return { jobId: 'job-id' };
    if (action === 'job') return { id: 'job-id', state: 'completed', steps: [{ label: '安装', state: 'completed' }], device: devices[2] };
    if (action === 'reconnect') return { jobId: 'job-id' };
    return {};
  }, async hostCall(action, args) { return this.call(action, args); }, ...props.runtime };
  const react = {
    createElement(type, props, ...children) { return { type, props: props || {}, children: children.flat(Infinity).filter(value => value !== false && value != null) }; },
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], value => { const next = typeof value === 'function' ? value(slots[index]) : value; if (!Object.is(next, slots[index])) { slots[index] = next; dirty = true; } }]; },
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; },
    useCallback(fn, deps) { const index = cursor++, old = slots[index]; if (!old || deps.some((value, i) => !Object.is(value, old.deps[i]))) slots[index] = { fn, deps }; return slots[index].fn; },
    useEffect(fn, deps) { const index = cursor++, old = slots[index]; if (!old || !deps || deps.some((value, i) => !Object.is(value, old.deps[i]))) { slots[index] = { deps, cleanup: old?.cleanup }; effects.push(() => { slots[index].cleanup?.(); slots[index].cleanup = fn(); }); } },
  };
  const window = { addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); }, removeEventListener(name, fn) { listeners.get(name)?.delete(fn); } };
  const parent = props.embedded ? { postMessage(data, origin) { this.messages.push({ data, origin }); }, messages: [] } : window;
  const module = { exports: {} };
  runInNewContext(code, { module, exports: module.exports, URL, URLSearchParams, window, parent, location: { origin: 'http://127.0.0.1:17770', search: props.embedded ? '?parentOrigin=http://127.0.0.1:17770' + (props.reuseWorkbench ? '&reuseWorkbench=1' : '') : '' }, document: { activeElement: null, createElement: () => ({ remove() {} }), head: { append() {} } }, setTimeout(fn) { const id = Math.random(); timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id), require: id => id === 'react' ? react : id.includes('device-navigation') ? { workbenchNavigationMessage } : id.includes('device-switch') ? { deviceSwitchFrameMessage } : id.includes('device-state') ? { deviceIcon, deviceKind, deviceStatus, jobFinished, sshInput, workbenchUrl, jobFailed: job => ['failed', 'error'].includes(job?.state) } : id.includes('app.jsx') ? { useLinkStyle() {}, LinkSettings() {} } : {} });
  const frameWindows = new Map();
  const render = () => { dirty = false; cursor = 0; tree = module.exports[component]({ ...props, runtime }); for (const node of nodes(tree)) if (node.type === 'iframe' && node.props.ref) { if (!frameWindows.has(node.props.src)) frameWindows.set(node.props.src, { messages: [], postMessage(data, origin) { this.messages.push({ data, origin }); } }); node.props.ref({ contentWindow: frameWindows.get(node.props.src) }); } for (const effect of effects.splice(0)) effect(); return tree; };
  const settle = async () => { for (let i = 0; i < 10; i++) { if (dirty) render(); await new Promise(resolve => setImmediate(resolve)); } return tree; };
  return { calls, runtime, parent, settle, frameWindows, emit(event) { for (const fn of [...(listeners.get('message') || [])]) fn(event); }, nodes: () => nodes(tree), get tree() { return tree; }, async click(text) { const button = nodes(tree).find(node => typeof node.type === 'function' && textOf(node) === text); assert(button, text); await button.props.onClick(); return settle(); }, async tick() { const ready = [...timers.values()]; timers.clear(); for (const fn of ready) await fn(); return settle(); }, status(value) { pairStatus = value; } };
}

test('device state remains unknown before probing and SSH credentials are preserved', () => {
  assert.equal(deviceIcon({ kind: 'local' }), 'computer');
  assert.equal(deviceIcon({ kind: 'ssh' }), 'server');
  assert.equal(deviceIcon({ deviceType: 'mobile' }), 'mobile');
  assert.equal(deviceIcon({ name: '我的手机' }), 'devices');
  for (const device of [undefined, {}, { status: 'unknown' }, { status: 'mystery' }]) assert.equal(deviceStatus(device), '');
  for (const [status, label] of Object.entries({ online: '可连接', connected: '已连接', offline: '离线', connecting: '连接中', failed: '连接失败', disconnected: '未连接' })) assert.equal(deviceStatus({ status }), label); assert.equal(deviceKind({ kind: 'ssh' }), '服务器');
  const value = sshInput({ host: ' example.com ', username: ' user ', name: ' a ', port: '22', auth: 'password', password: ' actual secret ', source: 'mirror' });
  assert.equal(value.password, ' actual secret '); assert.equal(value.port, 22); assert.equal(value.host, 'example.com');
  assert.throws(() => sshInput({ host: 'x', username: 'u', port: 0 }), /端口/);
  assert.throws(() => workbenchUrl('http://example.com', 'http://localhost'), /地址无效/);
  assert.equal(workbenchUrl('http://127.0.0.1:321/s/id/', 'http://localhost'), 'http://127.0.0.1:321/s/id/');
});

test('pairing waits for approval and opens exactly the approved device', async () => {
  const added = [], view = fixture('AddComputer', { onAdded: value => added.push(value) }); await view.settle();
  view.nodes().find(node => node.type === 'textarea').props.onChange({ target: { value: 'dshlink://pair?url=https://desk&code=one' } }); await view.settle();
  await view.nodes().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await view.settle();
  assert(textOf(view.tree).includes('请在目标设备上允许连接')); assert.equal(added.length, 0);
  view.status('approved'); await view.tick();
  assert.equal(added[0].id, 'desk'); assert.equal(view.calls.filter(item => item.action === 'pair').length, 1);
});

test('server authentication starts after fingerprint confirmation', async () => {
  const view = fixture('AddServer', { onAdded() {} }); await view.settle();
  const fields = view.nodes().filter(node => node.type === 'input');
  fields[1].props.onChange({ target: { value: 'server.example.com' } }); fields[3].props.onChange({ target: { value: 'ubuntu' } }); await view.settle();
  view.nodes().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await view.settle();
  assert(textOf(view.tree).includes('确认服务器身份')); assert.equal(view.calls.some(item => item.action === 'sshConnect'), false);
  view.nodes().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await view.settle();
  assert.equal(view.calls.find(item => item.action === 'sshConnect').args.fingerprint, 'SHA256:valid');
  await view.tick(); assert(textOf(view.tree).includes('打开工作台'));
});

test('opening another device leaves the device list immediately', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const view = fixture('DeviceCenter', { runtime: { async call(action, args) {
    if (action === 'list') return { devices: [{ id: 'desk', name: '开发电脑', kind: 'computer', status: 'unknown' }], capabilities: { ssh: true, hostAdmin: true } };
    if (action === 'select') { await pending; return { device: { id: 'desk', kind: 'computer', name: '开发电脑' }, url: 'http://127.0.0.1:17771/s/one/' }; }
    return {};
  } } });
  await view.settle();
  const opening = view.nodes().find(node => node.props.className === 'dc-device-open').props.onClick();
  await view.settle();
  assert.equal(view.nodes().find(node => node.props.className === 'dc-surface').props.hidden, true);
  assert(view.nodes().some(node => node.props.className === 'dc-workbench-loading'));
  release();
  await opening; await view.settle();
  assert.equal(view.nodes().find(node => node.type === 'iframe').props.hidden, false);
  assert(view.nodes().some(node => node.props.className === 'dc-workbench-loading'));
  view.nodes().find(node => node.type === 'iframe').props.onLoad(); await view.settle();
  assert.equal(view.nodes().some(node => node.props.className === 'dc-workbench-loading'), false);
});

test('desktop embedded device selection reuses the owner workbench without another select or iframe', async () => {
  const view = fixture('DeviceCenter', { embedded: true, reuseWorkbench: true }); await view.settle();
  for (const name of ['开发电脑', '本机']) {
    await view.nodes().find(node => node.props.className === 'dc-device-open' && textOf(node).includes(name)).props.onClick(); await view.settle();
    const message = view.parent.messages.at(-1);
    assert.equal(message.data.type, 'dsh-devices:select');
    assert.equal(message.data.deviceId, name === '本机' ? 'local' : 'desk');
    assert.equal(message.origin, 'http://127.0.0.1:17770');
  }
  assert.equal(view.calls.some(call => call.action === 'select'), false);
  assert.equal(view.nodes().some(node => node.type === 'iframe'), false);
});

test('local device name and remote remarks can be edited and saved independently', async () => {
  for (const kind of ['local', 'computer']) {
    let saved;
    const view = fixture('ManageDevice', { device: { id: kind === 'local' ? 'local' : 'desk', kind, name: '旧名称', status: 'online' }, onChanged() {}, runtime: { async call(action, input) { saved = { action, ...input }; return { device: { name: input.name } }; } } });
    await view.settle();
    assert.equal(view.nodes().some(node => node.type === 'input'), false);
    await view.nodes().find(node => node.props['aria-label'] === '编辑' + (kind === 'local' ? '本机名称' : '备注名称')).props.onClick(); await view.settle();
    const input = view.nodes().find(node => node.type === 'input');
    assert.equal(input.props.disabled, false);
    input.props.onChange({ target: { value: '新的名称' } }); await view.settle();
    view.nodes().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await view.settle();
    assert.equal(saved.action, 'rename'); assert.equal(saved.name, '新的名称');
    assert.equal(saved.deviceId, kind === 'local' ? 'local' : 'desk');
    assert.equal(view.nodes().some(node => node.type === 'input'), false);
    assert.match(textOf(view.tree), /新的名称/);
  }
});

test('device details keep compact actions and require confirmation before removing a connection', async () => {
  let closed = 0, removed;
  const view = fixture('ManageDevice', {
    device: { id: 'desk', kind: 'computer', name: '开发电脑' },
    onChanged() {}, onRemoved(id) { removed = id; }, onCloseWorkbench() { closed++; },
  });
  await view.settle();
  const actions = view.nodes().find(node => node.props.className === 'dc-management dc-actions');
  assert.equal(textOf(actions), '关闭工作台移除连接');
  assert.equal(view.nodes().some(node => node.type === 'h3'), false);
  assert.doesNotMatch(textOf(view.tree), /关闭页面会清除|主机任务继续运行|移除保存连接|不撤销授权|卸载或停止服务器/);
  await view.click('关闭工作台'); assert.equal(closed, 1);
  await view.click('移除连接');
  assert.equal(view.calls.length, 0); assert.match(textOf(view.tree), /取消确认移除/);
  await view.click('取消'); assert.equal(view.calls.length, 0);
  await view.click('移除连接'); await view.click('确认移除');
  assert.equal(view.calls.length, 1);
  assert.equal(view.calls[0].action, 'remove'); assert.equal(view.calls[0].args.deviceId, 'desk');
  assert.equal(removed, 'desk');
  const local = fixture('ManageDevice', { device: { id: 'local', kind: 'local', name: '本机' } });
  await local.settle();
  assert.equal(local.nodes().some(node => node.props.className === 'dc-management dc-actions'), false);
});

test('inline name edits cancel, preserve failures and prevent duplicate saves', async () => {
  let fail = true, release, count = 0;
  const view = fixture('ManageDevice', { device: { id: 'desk', kind: 'computer', name: '旧名称' }, onChanged() {}, runtime: { async call() { count++; if (fail) throw Error('保存失败'); await new Promise(resolve => { release = resolve; }); return { device: { name: '新备注' } }; } } });
  await view.settle();
  const open = async () => { view.nodes().find(node => node.props['aria-label'] === '编辑备注名称').props.onClick(); await view.settle(); };
  const input = () => view.nodes().find(node => node.type === 'input');
  const form = () => view.nodes().find(node => node.props.className === 'dc-name-form');
  await open(); input().props.onChange({ target: { value: '未保存' } }); await view.settle();
  view.nodes().find(node => node.props['aria-label'] === '取消修改名称').props.onClick(); await view.settle();
  await open(); assert.equal(input().props.value, '旧名称');
  form().props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} }); await view.settle();
  assert.equal(input(), undefined); assert.equal(count, 0);
  await open(); input().props.onChange({ target: { value: '新备注' } }); await view.settle();
  let prevented = false;
  form().props.onKeyDown({ key: 'Enter', nativeEvent: { isComposing: true }, preventDefault() { prevented = true; }, stopPropagation() {} });
  assert.equal(prevented, true); assert.equal(count, 0);
  form().props.onSubmit({ preventDefault() {} }); await view.settle();
  assert.equal(input().props.value, '新备注'); assert(view.nodes().some(node => node.props.error === '保存失败'));
  fail = false; const submit = form().props.onSubmit;
  submit({ preventDefault() {} }); submit({ preventDefault() {} }); await view.settle();
  assert.equal(count, 2); assert.equal(input().props.disabled, true);
  release(); await view.settle(); assert.equal(input(), undefined);
});

test('switching preserves existing iframe when another connection fails', async () => {
  const view = fixture('DeviceCenter'); await view.settle();
  const open = view.nodes().find(node => node.props.className === 'dc-device-open' && textOf(node).includes('开发电脑'));
  await open.props.onClick(); await view.settle();
  const frame = view.nodes().find(node => node.type === 'iframe'); assert.equal(frame.props.src, 'http://127.0.0.1:17771/s/one/');
  const failed = view.nodes().find(node => node.props.className === 'dc-device-open' && textOf(node).includes('云端'));
  await failed.props.onClick(); await view.settle();
  assert(view.nodes().some(node => node.props.error === 'SSH 隧道未连接')); assert.equal(view.nodes().find(node => node.type === 'iframe').props.src, frame.props.src); assert.equal(view.nodes().find(node => node.type === 'iframe').props.hidden, false);
});

test('mobile centre keeps fallback until valid navigation is ready and retains frame on return', async () => {
  const view = fixture('DeviceCenter'); await view.settle();
  await view.nodes().find(node => node.props.className === 'dc-device-open' && textOf(node).includes('开发电脑')).props.onClick(); await view.settle();
  const frame = view.nodes().find(node => node.type === 'iframe'), child = view.frameWindows.get(frame.props.src);
  const topbar = () => view.nodes().find(node => node.type === 'header');
  assert.equal(topbar().props.className, 'dc-topbar');
  view.emit({ source: child, origin: 'https://evil.test', data: { type: 'dsh-devices:ready' } }); await view.settle();
  assert.equal(topbar().props.className, 'dc-topbar');
  view.emit({ source: child, origin: 'http://127.0.0.1:17771', data: { type: 'dsh-devices:ready' } }); await view.settle();
  assert.match(topbar().props.className, /integrated/); assert.equal(child.messages.at(-1).data.name, '开发电脑');
  view.emit({ source: child, origin: 'http://127.0.0.1:17771', data: { type: 'dsh-devices:show' } }); await view.settle();
  assert.equal(topbar().props.className, 'dc-topbar');
  assert.equal(view.nodes().find(node => node.props.className === 'dc-surface').props.hidden, false);
  assert.equal(view.nodes().find(node => node.type === 'iframe').props.src, frame.props.src);
  await view.nodes().find(node => node.props.className === 'dc-device-open' && textOf(node).includes('开发电脑')).props.onClick(); await view.settle();
  view.emit({ source: child, origin: 'http://127.0.0.1:17771', data: { type: 'dsh-devices:unready' } }); await view.settle();
  assert.equal(topbar().props.className, 'dc-topbar');
});

test('device center initializes only its mounted exact-origin switch and preserves directory navigation', async () => {
  const records = [{ id: 'local', name: '本机', kind: 'local', status: 'online', token: 'secret' }, { id: 'desk', name: '开发电脑', kind: 'computer', status: 'online', deviceType: 'desktop', routes: [{ token: 'route-secret' }] }];
  const view = fixture('DeviceCenter', { runtime: { async call(action) {
    if (action === 'list') return { devices: [...records], capabilities: {} };
    if (action === 'select') return { device: records[1], url: 'http://127.0.0.1:17771/s/one/' };
  } } });
  await view.settle();
  await view.nodes().find(node => node.props.className === 'dc-device-open' && textOf(node).includes('开发电脑')).props.onClick(); await view.settle();
  const frame = view.nodes().find(node => node.type === 'iframe'), child = view.frameWindows.get(frame.props.src);
  const emit = (source, origin, data) => view.emit({ source, origin, data });
  const topbar = () => view.nodes().find(node => node.type === 'header');
  emit({}, 'http://127.0.0.1:17771', { type: 'benchgo:device-switch:ready' });
  emit(child, 'https://evil.test', { type: 'benchgo:device-switch:ready' }); await view.settle();
  assert.equal(child.messages.length, 0); assert.equal(topbar().props.className, 'dc-topbar');
  emit(child, 'http://127.0.0.1:17771', { type: 'benchgo:device-switch:ready' }); await view.settle();
  assert.match(topbar().props.className, /dc-topbar-switch/);
  const init = child.messages.find(message => message.data.type === 'benchgo:device-switch:init');
  assert.equal(init.origin, 'http://127.0.0.1:17771'); assert.equal(init.data.activeId, 'desk');
  assert.equal(JSON.stringify(init.data.devices), JSON.stringify([{ id: 'local', name: '本机', kind: 'local', status: 'online' }, { id: 'desk', name: '开发电脑', kind: 'computer', status: 'online', deviceType: 'desktop' }]));
  assert.equal(child.messages.at(-1).data.type, 'dsh-devices:init'); assert.equal(child.messages.at(-1).data.name, '开发电脑');
  emit(child, 'http://127.0.0.1:17771', { type: 'dsh-devices:show' }); await view.settle();
  assert.equal(view.nodes().find(node => node.props.className === 'dc-surface').props.hidden, false);
  assert.equal(topbar().props.className, 'dc-topbar');
  records[1] = { ...records[1], name: '新名称', status: 'offline' };
  await view.nodes().find(node => node.props['aria-label'] === '刷新设备').props.onClick(); await view.settle();
  const refreshed = child.messages.filter(message => message.data.type === 'benchgo:device-switch:init').at(-1);
  assert.equal(refreshed.data.devices[1].name, '新名称'); assert.equal(refreshed.data.devices[1].status, 'offline');
  frame.props.onLoad(); await view.settle();
  assert(child.messages.some(message => message.data.type === 'benchgo:device-switch:probe'));
  assert.equal(topbar().props.className, 'dc-topbar');
});

test('embedded device selection syncs failure and permits only the active ready frame to return local', async () => {
  const view = fixture('DeviceCenter', { embedded: true }); await view.settle();
  await view.nodes().find(node => node.props.className === 'dc-device-open' && textOf(node).includes('开发电脑')).props.onClick(); await view.settle();
  const frame = view.nodes().find(node => node.type === 'iframe'), child = view.frameWindows.get(frame.props.src);
  const emit = (data, origin = 'http://127.0.0.1:17771', source = child) => view.emit({ source, origin, data });
  const local = { type: 'benchgo:device-switch:select', deviceId: 'local' };
  const selects = () => view.calls.filter(call => call.action === 'select');
  emit(local); await view.settle(); assert.equal(selects().length, 1, 'not ready');
  emit({ type: 'benchgo:device-switch:ready' }); await view.settle();
  emit(local, 'https://evil.test'); emit(local, 'http://127.0.0.1:17771', {});
  emit({ ...local, deviceId: 'missing' }); await view.settle(); assert.equal(selects().length, 1);
  emit({ type: 'benchgo:device-switch:select', deviceId: 'server' }); await view.settle();
  assert.equal(selects().at(-1).args.deviceId, 'server');
  const failed = child.messages.filter(message => message.data.type === 'benchgo:device-switch:init').at(-1);
  assert.equal(failed.data.error, 'SSH 隧道未连接'); assert.equal(failed.data.busy, '');
  assert.equal(view.nodes().find(node => node.type === 'iframe').props.hidden, false);
  assert.equal(view.nodes().find(node => node.type === 'header').props.className, 'dc-topbar');
  emit(local); await view.settle();
  assert.equal(selects().at(-1).args.deviceId, 'local');
  assert.equal(view.parent.messages.at(-1).data.type, 'dsh-devices:return-local');
  assert.equal(view.parent.messages.at(-1).origin, 'http://127.0.0.1:17770');
  assert.equal(view.nodes().find(node => node.props.className === 'dc-surface').props.hidden, false);
  const count = selects().length;
  emit(local); await view.settle(); assert.equal(selects().length, count, 'inactive frame');
});

test('server reconnect remains an explicit job until completion', async () => {
  const view = fixture('ManageDevice', { device: { id: 'server', name: '云端', kind: 'ssh' }, onChanged() {}, onRemoved() {} }); await view.settle();
  await view.click('重新连接隧道');
  const form = view.nodes().find(node => node.type === 'form' && nodes(node).some(child => child.type?.name === 'Credentials')); await form.props.onSubmit({ preventDefault() {} }); await view.settle();
  assert(view.nodes().some(node => node.props.job?.id === 'job-id'));
  await view.tick(); assert(view.nodes().some(node => node.props.job?.state === 'completed'));
});


test('device center exposes one add flow and owner pairing through existing settings', async () => {
  const view = fixture('DeviceCenter'); await view.settle();
  assert.doesNotMatch(textOf(view.tree), /添加电脑|添加服务器|连接手机|App 地址/);
  await view.click('添加设备');
  assert(view.nodes().some(node => typeof node.type === 'function' && node.type.name === 'AddDevice'));
  const add = fixture('AddDevice', { onAdded() {}, sshAvailable: true }); await add.settle();
  assert.match(textOf(add.tree), /连接已有设备/); assert.match(textOf(add.tree), /安装到服务器/);
  await add.click('安装到服务器');
  assert(add.nodes().some(node => typeof node.type === 'function' && node.type.name === 'AddServer'));
});

test('connection stays above compact device and relay tabs with retained management state', async () => {
  const view = fixture('DeviceCenter'); await view.settle();
  const panel = id => view.nodes().find(node => node.props.id === 'dc-panel-' + id);
  const directory = view.nodes().find(node => node.props.className === 'dc-device-directory');
  assert.match(textOf(directory), /本机/); assert.match(textOf(directory), /开发电脑/);
  assert.equal(textOf(directory).indexOf('本机') < textOf(directory).indexOf('开发电脑'), true);
  const remoteCopy = view.nodes().find(node => node.props.className === 'dc-device-copy' && textOf(node).includes('开发电脑'));
  assert.equal(textOf(nodes(remoteCopy).find(node => node.type === 'small')), '电脑');
  assert.doesNotMatch(textOf(directory), /未检测/);
  assert.equal(panel('devices').props.hidden, false);
  assert.equal(panel('connection').props.hidden, undefined);
  assert.equal(panel('relay').props.hidden, true);
  const tabs = () => view.nodes().filter(node => node.props.role === 'tab');
  assert.equal(tabs().map(textOf).join('|'), '设备|中继池');
  assert.equal(tabs()[0].props['aria-selected'], true);
  assert(view.nodes().indexOf(panel('connection')) < view.nodes().indexOf(panel('devices')));
  const hostSettings = nodes(panel('connection')).find(node => typeof node.type === 'function' && node.type.name === 'LinkSettings');
  assert(hostSettings); assert.equal(hostSettings.props.embedded, true);
  const target = {};
  view.nodes().find(node => node.props.className === 'dc-connection-details link-settings').props.ref(target); await view.settle();
  assert.equal(view.nodes().find(node => node.type?.name === 'LinkSettings').props.detailsTarget, target);
  assert.equal(view.nodes().find(node => node.type?.name === 'RelayPool').props.active, false);
  await tabs()[1].props.onClick(); await view.settle();
  assert.equal(panel('devices').props.hidden, true);
  assert.equal(panel('relay').props.hidden, false);
  assert.equal(view.nodes().find(node => node.type?.name === 'RelayPool').props.active, true);
  assert.equal(view.nodes().find(node => node.type?.name === 'LinkSettings').props.detailsTarget, target);
  await tabs()[0].props.onClick(); await view.settle();
  assert.equal(panel('devices').props.hidden, false);
  assert.match(textOf(panel('devices')), /开发电脑/);
});

test('directory tabs support arrow and Home keys without remounting panels', async () => {
  const view = fixture('DeviceCenter'); await view.settle();
  const tabNodes = view.nodes().filter(node => node.props.role === 'tab');
  let focused, prevented = 0;
  const elements = tabNodes.map(node => ({ dataset: { tab: node.props['data-tab'] }, focus() { focused = this.dataset.tab; } }));
  elements.forEach(element => { element.parentElement = { querySelectorAll: () => elements }; });
  tabNodes[0].props.onKeyDown({ key: 'ArrowRight', currentTarget: elements[0], preventDefault() { prevented++; } }); await view.settle();
  assert.equal(focused, 'relay');
  assert.equal(view.nodes().find(node => node.props.id === 'dc-panel-relay').props.hidden, false);
  tabNodes[1].props.onKeyDown({ key: 'Home', currentTarget: elements[1], preventDefault() { prevented++; } }); await view.settle();
  assert.equal(focused, 'devices'); assert.equal(prevented, 2);
  assert.equal(view.nodes().find(node => node.props.id === 'dc-panel-devices').props.hidden, false);
});

test('saving a new relay selects its pool and refreshes the visible list', async () => {
  const view = fixture('DeviceCenter', { runtime: { async call() { return { devices: [], capabilities: { hostAdmin: true, relayDeploy: true } }; } } }); await view.settle();
  const pool = () => view.nodes().find(node => node.type?.name === 'RelayPool');
  const revision = pool().props.refreshToken;
  pool().props.onAdd(); await view.settle();
  const wizard = view.nodes().find(node => node.type?.name === 'RelayWizard');
  assert.equal(wizard.props.initialTab, 'connect');
  await wizard.props.onChanged(); await view.settle();
  assert.equal(pool().props.active, true);
  assert.equal(pool().props.refreshToken, revision + 1);
  assert.equal(view.nodes().find(node => node.props.id === 'dc-panel-relay').props.hidden, false);
  assert.equal(view.nodes().some(node => node.type?.name === 'RelayWizard'), false);
});

test('returning to device centre retains workbench and relay changes refresh every consumer', async () => {
  const view = fixture('DeviceCenter'); await view.settle();
  await view.nodes().find(node => node.props.className === 'dc-device-open' && textOf(node).includes('开发电脑')).props.onClick(); await view.settle();
  const frame = view.nodes().find(node => node.type === 'iframe');
  await view.nodes().find(node => node.props['aria-label'] === '返回设备中心').props.onClick(); await view.settle();
  assert.equal(view.nodes().find(node => node.props.className === 'dc-surface').props.hidden, false);
  assert.equal(view.nodes().find(node => node.type === 'iframe').props.src, frame.props.src);
  const pool = () => view.nodes().find(node => typeof node.type === 'function' && node.type.name === 'RelayPool');
  const before = pool().props.refreshToken;
  pool().props.onChanged(); await view.settle();
  assert.equal(pool().props.refreshToken, before + 1);
  assert.equal(view.nodes().find(node => typeof node.type === 'function' && node.type.name === 'LinkSettings').props.refreshToken, before + 1);
  await view.nodes().find(node => typeof node.type === 'function' && node.props['aria-label'] === '返回开发电脑工作台').props.onClick(); await view.settle();
  assert.equal(view.nodes().find(node => node.props.className === 'dc-surface').props.hidden, true);
  assert.equal(view.nodes().find(node => node.type === 'iframe').props.src, frame.props.src);
});

test('embedded device list can return without using the window close control', async () => {
  const view = fixture('DeviceCenter', { embedded: true }); await view.settle();
  const back = view.nodes().find(node => node.props.className?.includes('dc-back'));
  assert.equal(back.props['aria-label'], '返回工作台');
  assert.equal(textOf(back), '');
  const main = view.nodes().find(node => node.props.className === 'dc-topbar-main');
  assert.equal(main.children[0], back);
  assert.equal(main.children[1].props.className, 'dc-center-home');
  assert.equal(main.children[1].type, 'span');
  await back.props.onClick(); await view.settle();
  assert.equal(view.parent.messages.at(-1).data.type, 'dsh-devices:return-local');
  assert.equal(view.parent.messages.at(-1).origin, 'http://127.0.0.1:17770');
  const standalone = fixture('DeviceCenter'); await standalone.settle();
  assert.equal(standalone.nodes().some(node => node.props.className?.includes('dc-back')), false);
});

test('clients without hosting retain their remote device list', async () => {
  const view = fixture('DeviceCenter', { runtime: { async call() { return { devices: [{ id: 'desk', name: '开发电脑', kind: 'computer', status: 'unknown' }], capabilities: { hostAdmin: false, ssh: false } }; } } });
  await view.settle();
  assert.notEqual(view.nodes().find(node => node.props.className === 'dc-device-directory').props.hidden, true);
  assert.match(textOf(view.nodes().find(node => node.props.className === 'dc-device-directory')), /开发电脑/);
  assert.equal(view.nodes().some(node => typeof node.type === 'function' && node.type.name === 'LinkSettings'), false);
});

test('a phone local device opens its name settings instead of selecting a workbench', async () => {
  const view = fixture('DeviceCenter', { runtime: { isNative: () => true } }); await view.settle();
  const add = view.nodes().find(node => typeof node.type === 'function' && textOf(node) === '添加设备');
  assert.equal(add.props.icon, undefined);
  await view.nodes().find(node => node.props.className === 'dc-device-open' && textOf(node).includes('本机')).props.onClick(); await view.settle();
  assert.equal(view.calls.some(call => call.action === 'select'), false);
  assert(view.nodes().some(node => typeof node.type === 'function' && node.type.name === 'ManageDevice' && node.props.device.id === 'local'));
});


test('relay wizard deploys in one step without requiring email or fingerprint confirmation', async () => {
  const calls = [];
  let connected = false;
  const view = fixture('RelayWizard', { onChanged() {}, runtime: { async call(action, args) {
    calls.push({ action, args });
    if (action === 'relayProbe') return { fingerprint: 'SHA256:relay' };
    if (action === 'relayDeploy') return { jobId: 'relay-job' };
    if (action === 'job') return { id: 'relay-job', state: 'completed', steps: [], relay: { url: 'https://8.8.8.8:24680' } };
    if (action === 'hostStatus') return { relay: { connected }, pending: [{ id: 'phone', name: '手机' }] };
    if (action === 'hostConfirm') return { relay: { connected }, pending: [] };
    if (action === 'hostPairing') return { uri: 'dshlink://pair?code=once' };
    return {};
  } } });
  await view.settle();
  await view.click('部署');
  const input = placeholder => view.nodes().find(node => node.type === 'input' && node.props.placeholder === placeholder);
  assert.equal(input('例如 root 或 ubuntu').props.value, 'root');
  input('公网 IP 或域名').props.onChange({ target: { value: '8.8.8.8' } });
  await view.settle();
  const submit = async () => { view.nodes().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await view.settle(); };
  await submit();
  const deployment = calls.find(item => item.action === 'relayDeploy');
  assert.equal(calls[0].action, 'relayProbe'); assert.equal(deployment.args.fingerprint, 'SHA256:relay');
  assert.equal(deployment.args.email, ''); assert.equal(deployment.args.relayPort, 24680); assert.equal(deployment.args.challengeMode, 'standalone');
  assert.doesNotMatch(textOf(view.tree), /确认服务器身份|已有中继服务/);
  await view.tick();
  const pairButton = () => view.nodes().find(node => typeof node.type === 'function' && textOf(node) === '生成中继连接信息');
  assert.equal(pairButton().props.disabled, true);
  connected = true; await view.tick();
  assert.equal(pairButton().props.disabled, false);
  await view.click('生成中继连接信息');
  assert.equal(calls.find(item => item.action === 'hostPairing').args.mode, 'relay');
  const pairingDialog = () => view.nodes().find(node => node.props.pairing?.uri?.includes('code=once'));
  assert(pairingDialog());
  assert.equal(pairingDialog().props.pending[0].id, 'phone');
  await pairingDialog().props.onConfirm('phone', 'confirm'); await view.settle();
  assert.equal(calls.find(item => item.action === 'hostConfirm').args.id, 'phone');
  assert.equal(pairingDialog().props.pending.length, 0);
});

test('relay deployment exposes webroot and returns to editable fields after failure', async () => {
  const calls = [];
  const view = fixture('RelayWizard', { onChanged() {}, runtime: { async call(action, args) {
    calls.push({ action, args });
    if (action === 'relayProbe') return { fingerprint: 'SHA256:relay' };
    if (action === 'relayDeploy') return { jobId: 'failed-relay' };
    if (action === 'job') return { id: 'failed-relay', state: 'error', error: 'SSH 认证失败，请检查用户名或密码', steps: [{ name: '连接 SSH', state: 'error' }] };
    return {};
  } } });
  await view.settle();
  await view.click('部署');
  view.nodes().find(node => node.type === 'input' && node.props.placeholder === '公网 IP 或域名').props.onChange({ target: { value: 'relay.example.com' } });
  view.nodes().find(node => node.props.className === 'dc-advanced-toggle').props.onClick(); await view.settle();
  view.nodes().find(node => node.props.value === 'standalone').props.onChange({ target: { value: 'webroot' } }); await view.settle();
  assert(view.nodes().some(node => node.type === 'input' && node.props.placeholder === '/var/www/acme' && node.props.required));
  view.nodes().find(node => node.props.value === 'webroot').props.onChange({ target: { value: 'standalone' } }); await view.settle();
  view.nodes().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await view.settle(); await view.tick();
  assert(view.nodes().some(node => node.props.job?.error === 'SSH 认证失败，请检查用户名或密码')); assert.match(textOf(view.tree), /返回修改/);
  assert.equal(view.nodes().some(node => node.type === 'form'), false);
  await view.click('返回修改');
  assert(view.nodes().some(node => node.type === 'form'));
  assert.equal(calls.at(-1).action, 'relayJobDismiss');
});


test('relay deployment entry is unavailable when client capability is absent', async () => {
  const view = fixture('DeviceCenter'); await view.settle();
  const panel = view.nodes().find(node => node.props.id === 'dc-panel-relay');
  const pool = nodes(panel).find(node => typeof node.type === 'function' && node.type.name === 'RelayPool');
  assert.equal(pool.props.onAdd, undefined);
});

test('adding a relay defaults to connect, tests without saving and appends existing nodes', async () => {
  const calls = []; let changed = 0;
  const view = fixture('RelayWizard', { onChanged() { changed++; }, runtime: { async hostCall(action, input) {
    calls.push({ action, input });
    if (action === 'relayTest') return { ok: false, message: '中继拒绝认证' };
    if (action === 'hostStatus') return { relay: { nodes: [{ id: 'first', url: 'https://first.test', enabled: true }] } };
    return { relay: {} };
  } } });
  await view.settle();
  assert(view.nodes().some(node => node.props.name === 'url'));
  assert.equal(view.nodes().some(node => node.props.placeholder === '公网 IP 或域名'), false);
  view.nodes().find(node => node.props.name === 'url').props.onChange({ target: { value: 'https://second.test' } });
  view.nodes().find(node => node.props.name === 'token').props.onChange({ target: { value: 'new-secret' } }); await view.settle();
  await view.click('测试连接');
  assert.equal(calls.length, 1); assert.equal(calls[0].action, 'relayTest'); assert.equal(changed, 0);
  assert(view.nodes().some(node => node.props.result?.message === '中继拒绝认证'));
  await view.nodes().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await view.settle();
  const saved = calls.find(item => item.action === 'relayPoolConfigure').input.nodes;
  assert.equal(saved.length, 2); assert.equal(saved[0].id, 'first'); assert.equal(saved[1].token, 'new-secret');
  assert.equal(changed, 1);
});

test('relay list polls channel status, preserves edited secrets and leaves failed edits open', async () => {
  const calls = []; let connected = false, failSave = true;
  const status = () => ({ relay: { nodes: [{ id: 'one', url: 'https://relay.test', enabled: true, connected }] } });
  const view = fixture('RelayPool', { runtime: { async hostCall(action, input) {
    calls.push({ action, input });
    if (action === 'hostRelayPoolConfigure' && failSave) throw Error('保存失败');
    if (action === 'relayTest') return { ok: true, message: '认证通过', latencyMs: 25 };
    return status();
  } } }); await view.settle();
  assert.match(textOf(view.tree), /正在连接/);
  connected = true; await view.tick(); assert.match(textOf(view.tree), /通道已连接/);
  await view.click('编辑');
  const token = () => view.nodes().find(node => node.props.placeholder === '留空以保留当前密钥');
  await view.nodes().filter(node => typeof node.type === 'function' && textOf(node) === '测试连接').at(-1).props.onClick(); await view.settle();
  const tested = calls.find(item => item.action === 'relayTest'); assert.equal(tested.input.id, 'one'); assert.equal(tested.input.token, '');
  token().props.onChange({ target: { value: 'replacement-secret' } }); await view.settle();
  await view.nodes().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await view.settle();
  assert(token()); assert(view.nodes().some(node => node.props.error === '保存失败'));
  await view.tick(); assert(view.nodes().some(node => node.props.error === '保存失败'));
  assert.equal(calls.find(item => item.action === 'hostRelayPoolConfigure').input.nodes[0].token, 'replacement-secret');
  failSave = false;
  await view.nodes().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await view.settle();
  assert.equal(token(), undefined);
});

test('relay deployment progress survives closing its wizard and refreshes the list on completion', async () => {
  const view = fixture('DeviceCenter', { runtime: { async call(action) {
    if (action === 'list') return { devices: [], capabilities: { hostAdmin: true, relayDeploy: true }, relayJob: { id: 'background-job', state: 'running' } };
    if (action === 'job') return { id: 'background-job', state: 'completed' };
    return {};
  } } }); await view.settle();
  const pool = () => view.nodes().find(node => typeof node.type === 'function' && node.type.name === 'RelayPool');
  const before = pool().props.refreshToken;
  await view.tick();
  assert.equal(pool().props.refreshToken, before + 1);
  assert.match(textOf(view.tree), /中继部署完成/);
});

test('relay removal requires disabling and supports deleting the final node', async () => {
  let current = [{ id: 'only', url: 'https://relay.test', enabled: true }];
  const view = fixture('RelayPool', { onAdd() {}, runtime: { async hostCall(action, input) {
    if (action === 'hostRelayPoolConfigure') current = input.nodes;
    return { relay: { nodes: current } };
  } } });
  await view.settle();
  const remove = () => view.nodes().find(node => node.props['aria-label'] === '删除中继 only');
  assert.equal(remove().props.disabled, true);
  assert.equal(view.nodes().find(node => textOf(node) === '添加中继' && typeof node.type === 'function').props.icon, undefined);
  await view.click('停用');
  assert.equal(remove().props.disabled, false);
  await remove().props.onClick(); await view.settle();
  assert.deepEqual(current, []);
  assert.match(textOf(view.tree), /尚未添加中继/);
});
