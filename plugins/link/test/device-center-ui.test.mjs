import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { deviceIcon, deviceKind, deviceStatus, jobFinished, sshCredentials, sshInput, workbenchUrl } from '../client/device-state.mjs';
import { workbenchNavigationMessage } from '../client/device-navigation.mjs';
import { deviceSwitchFrameMessage } from '../client/device-switch.mjs';

const require = createRequire(new URL('../../base/package.json', import.meta.url));
const source = await readFile(new URL('../client/device-center.jsx', import.meta.url), 'utf8');
const code = require('esbuild').transformSync(source + '\nexport { AddComputer, AddServer, AddDevice, ServerInstall, ManageDevice, ReconnectServer, ServerPairing, RelayWizard, RelayPool };', { loader: 'jsx', format: 'cjs' }).code;
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
  const parentOrigin = props.embedded ? 'http://127.0.0.1:17770' : '';
  runInNewContext(code, { module, exports: module.exports, URL, URLSearchParams, crypto: globalThis.crypto, window, parent, __DSH_DEVICE_PARENT_ORIGIN__: parentOrigin, location: { origin: 'http://127.0.0.1:17770', search: '', hash: props.reuseWorkbench ? '#reuseWorkbench=1' : '' }, document: { activeElement: null, createElement: () => ({ remove() {} }), head: { append() {} } }, setTimeout(fn) { const id = Math.random(); timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id), require: id => id === 'react' ? react : id.includes('device-navigation') ? { workbenchNavigationMessage } : id.includes('device-switch') ? { deviceSwitchFrameMessage } : id.includes('device-theme') ? { observeHostTheme() {}, sendWorkbenchTheme() {}, themedWorkbenchUrl: url => url } : id.includes('device-state') ? { deviceIcon, deviceKind, deviceStatus, jobFinished, sshCredentials, sshInput, workbenchUrl, jobFailed: job => ['failed', 'error'].includes(job?.state) } : id.includes('collapsible.jsx') ? { Disclosure() {} } : id.includes('server-terminal.jsx') ? { ServerTerminal() {} } : id.includes('app.jsx') ? { useLinkStyle() {}, LinkSettings() {}, PairingDialog() {} } : {} });
  const frameWindows = new Map();
  const render = () => { dirty = false; cursor = 0; tree = module.exports[component]({ ...props, runtime }); for (const node of nodes(tree)) if (node.type === 'iframe' && node.props.ref) { if (!frameWindows.has(node.props.src)) frameWindows.set(node.props.src, { messages: [], postMessage(data, origin) { this.messages.push({ data, origin }); } }); node.props.ref({ contentWindow: frameWindows.get(node.props.src) }); } for (const effect of effects.splice(0)) effect(); return tree; };
  const settle = async () => { for (let i = 0; i < 10; i++) { if (dirty) render(); await new Promise(resolve => setImmediate(resolve)); } return tree; };
  return { calls, runtime, parent, settle, frameWindows, emit(event, name = 'message') { for (const fn of [...(listeners.get(name) || [])]) fn(event); }, nodes: () => nodes(tree), get tree() { return tree; }, async click(text) { const button = nodes(tree).find(node => typeof node.type === 'function' && textOf(node) === text); assert(button, text); await button.props.onClick(); return settle(); }, async tick() { const ready = [...timers.values()]; timers.clear(); for (const fn of ready) await fn(); return settle(); }, status(value) { pairStatus = value; } };
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
  assert(view.nodes().some(node => node.props.label === '请在目标设备上允许连接')); assert.equal(added.length, 0);
  view.status('approved'); await view.tick();
  assert.equal(added[0].id, 'desk'); assert.equal(view.calls.filter(item => item.action === 'pair').length, 1);
});

test('Android redelivery keeps the original pairing request through approval', async () => {
  const added = [];
  let scan = null;
  const view = fixture('AddComputer', { onAdded: value => added.push(value), runtime: {
    isNative: () => true, bootstrap: () => scan, contextUri: identity => identity.uri,
  } });
  await view.settle();
  scan = { code: 'once', uri: 'benchgo://pair?url=https%3A%2F%2Fdesk&code=once' };
  view.emit({}, 'link:bootstrap');
  view.emit({}, 'link:bootstrap');
  await view.settle();
  await view.tick();
  view.emit({}, 'link:bootstrap');
  view.status('approved');
  await view.tick();
  assert.equal(view.calls.filter(item => item.action === 'pair').length, 1);
  assert.equal(added[0]?.id, 'desk');
});

test('server authentication starts after fingerprint confirmation', async () => {
  const view = fixture('AddServer', { onAdded() {} }); await view.settle();
  const fields = view.nodes().filter(node => node.type === 'input');
  fields[1].props.onChange({ target: { value: 'server.example.com' } }); fields[3].props.onChange({ target: { value: 'ubuntu' } }); await view.settle();
  view.nodes().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await view.settle();
  assert(textOf(view.tree).includes('服务器准备就绪'));
  assert.equal(view.nodes().find(node => node.type === 'details').props.open, undefined);
  assert.deepEqual(Object.keys(view.calls.find(item => item.action === 'sshProbe').args).sort(), ['host', 'port', 'username']);
  assert.equal(view.calls.some(item => item.action === 'sshConnect'), false);
  view.nodes().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await view.settle();
  assert.equal(view.calls.find(item => item.action === 'sshConnect').args.fingerprint, 'SHA256:valid');
  await view.tick(); assert(textOf(view.tree).includes('打开工作台'));
});

test('server resource prefetch preserves the form and returns to installation without opening a device', async () => {
  const added = [], calls = [];
  const view = fixture('AddServer', { onAdded: device => added.push(device), runtime: { async call(action, input) {
    calls.push({ action, input });
    if (action === 'serverPrefetch') return { jobId: 'prefetch' };
    if (action === 'job') return { id: 'prefetch', kind: 'server-prefetch', state: 'done', resources: { cached: true, version: '0.1.4', origin: 'cache' }, steps: [{ name: '验证资源', state: 'done' }] };
    throw new Error('unexpected ' + action);
  } } });
  await view.settle();
  view.nodes().filter(node => node.type === 'input')[0].props.onChange({ target: { value: '保留的服务器名称' } }); await view.settle();
  await view.click('准备部署资源');
  assert.equal(calls[0].action, 'serverPrefetch');
  assert.equal(calls[0].input.source, 'mirror');
  await view.tick();
  assert.match(textOf(view.tree), /部署资源已就绪/);
  assert.doesNotMatch(textOf(view.tree), /打开工作台/);
  await view.click('继续安装');
  assert.equal(added.length, 0);
  assert.equal(view.nodes().filter(node => node.type === 'input')[0].props.value, '保留的服务器名称');
});

test('resource cancellation waits for the final job state and remains a neutral finished state', async () => {
  let cancelled = false, cancellations = 0;
  const view = fixture('AddServer', { onAdded() { assert.fail('prefetch must not open a device'); }, runtime: { async call(action) {
    if (action === 'serverPrefetch') return { jobId: 'prefetch' };
    if (action === 'jobCancel') { cancellations++; cancelled = true; return { ok: true }; }
    if (action === 'job') return { id: 'prefetch', kind: 'server-prefetch', state: cancelled ? 'cancelled' : 'running', cancellable: !cancelled, error: cancelled ? '部署资源获取已取消，可重新尝试' : undefined, steps: [] };
    throw new Error('unexpected ' + action);
  } } });
  await view.settle(); await view.click('准备部署资源');
  await view.click('取消');
  assert.equal(cancellations, 1);
  assert.equal(jobFinished({ state: 'cancelled' }), true);
  await view.tick();
  assert.match(textOf(view.tree), /返回/);
  assert.doesNotMatch(textOf(view.tree), /打开工作台|刷新进度/);
  await view.click('返回');
  assert.match(textOf(view.tree), /检查/);
});

test('failed resource preparation retries with the selected source and never connects SSH', async () => {
  let attempts = 0;
  const calls = [];
  const view = fixture('AddServer', { onAdded() {}, runtime: { async call(action, input) {
    calls.push({ action, input });
    if (action === 'serverPrefetch') return { jobId: 'prefetch-' + (++attempts) };
    if (action === 'job') return { id: input.jobId, kind: 'server-prefetch', state: 'error', error: '资源校验失败，请重试', steps: [] };
    throw new Error('unexpected ' + action);
  } } });
  await view.settle(); await view.click('准备部署资源'); await view.tick();
  assert.match(textOf(view.tree), /重试/);
  await view.click('重试');
  assert.equal(attempts, 2);
  assert.equal(calls.some(call => call.action.startsWith('ssh')), false);
});

test('server upload and install stages do not offer resource cancellation', async () => {
  const view = fixture('AddServer', { onAdded() {}, runtime: { async call(action) {
    if (action === 'sshProbe') return { fingerprint: 'SHA256:valid' };
    if (action === 'sshConnect') return { jobId: 'server-install' };
    if (action === 'job') return { id: 'server-install', kind: 'server', state: 'running', cancellable: false, steps: [{ name: '安装启动', state: 'running' }] };
    throw new Error('unexpected ' + action);
  } } });
  await view.settle();
  const fields = view.nodes().filter(node => node.type === 'input');
  fields[1].props.onChange({ target: { value: 'server.example.com' } }); fields[3].props.onChange({ target: { value: 'ubuntu' } }); await view.settle();
  const submit = () => view.nodes().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  submit(); await view.settle(); submit(); await view.settle(); await view.tick();
  assert.doesNotMatch(textOf(view.tree), /取消/);
});

test('server management cancellation waits for the backend and never opens a cancelled update', async () => {
  let cancelled = false, changes = 0;
  const calls = [];
  const view = fixture('ManageDevice', { device: { id: 'server', kind: 'ssh', name: '云端', status: 'online' }, onChanged() { changes++; }, onOpenWorkbench() { throw new Error('cancelled update must not open'); }, runtime: { async call(action, input) {
    calls.push({ action, input });
    if (action === 'serverAction') return { jobId: 'update-resources' };
    if (action === 'jobCancel') return { ok: true };
    if (action === 'job') return { id: 'update-resources', kind: 'server', state: cancelled ? 'cancelled' : 'running', cancellable: !cancelled, steps: [] };
    throw new Error('unexpected ' + action);
  } } });
  await view.settle(); await view.click('更新插件'); await view.click('确认更新'); await view.tick();
  await view.click('取消准备');
  assert.equal(calls.at(-1).action, 'jobCancel');
  assert.equal(calls.at(-1).input.jobId, 'update-resources');
  assert.equal(changes, 0);
  assert.equal(view.nodes().find(node => node.props.job)?.props.job.state, 'running');
  cancelled = true; await view.tick();
  assert.equal(view.nodes().find(node => node.props.job)?.props.job.state, 'cancelled');
  assert.equal(changes, 0);
  assert.doesNotMatch(textOf(view.tree), /重新打开工作台/);
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

test('desktop device center only opens SSH authentication for the saved device from its owner', async () => {
  const device = { id: 'ssh-server', name: '香港', kind: 'ssh', sshManaged: true };
  const view = fixture('DeviceCenter', { embedded: true, reuseWorkbench: true, runtime: { async call() { return { devices: [device], capabilities: { serverManagement: true } }; } } }); await view.settle();
  const { origin } = view.parent.messages.find(message => message.data.type === 'dsh-devices:actions-ready');
  const data = { type: 'dsh-devices:reconnect', deviceId: device.id };
  view.emit({ source: {}, origin, data });
  view.emit({ source: view.parent, origin: 'https://evil.test', data });
  await view.settle();
  assert.equal(view.nodes().some(node => node.props.title === '重新认证 SSH'), false);
  view.emit({ source: view.parent, origin, data }); await view.settle();
  assert(view.nodes().some(node => node.props.title === '重新认证 SSH'));
  view.emit({ source: view.parent, origin, data: { type: 'dsh-devices:closed' } }); await view.settle();
  assert.equal(view.nodes().some(node => node.props.title === '重新认证 SSH'), false);
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

test('group device edits save the shared name to the member identity', async () => {
  let saved;
  const view = fixture('ManageDevice', {
    device: { id: 'registered-server', kind: 'computer', name: '旧名称' },
    membership: { id: 'member-id' }, canRemoveMember: true, onChanged() {},
    runtime: { async call(action, input) { saved = { action, ...input }; return { device: { name: input.name } }; } },
  });
  await view.settle();
  await view.nodes().find(node => node.props['aria-label'] === '编辑设备名称').props.onClick();
  await view.settle();
  view.nodes().find(node => node.props['aria-label'] === '设备名称').props.onChange({ target: { value: '开发服务器' } });
  await view.settle();
  view.nodes().find(node => node.props.className === 'dc-name-form').props.onSubmit({ preventDefault() {} });
  await view.settle();
  assert.deepEqual(saved, { action: 'groupRename', deviceId: 'member-id', name: '开发服务器' });
  assert.match(textOf(view.tree), /开发服务器/);
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

test('the group directory closes an open workbench when its member is removed elsewhere', async () => {
  const local = { id: 'local', name: 'B', kind: 'local' };
  const remote = { id: 'peer-c', name: 'C', kind: 'computer' };
  let devices = [local, remote];
  const group = { id: 'group', enabled: true, manageable: true, members: [{ id: remote.id }] };
  const view = fixture('DeviceCenter', { runtime: { async call(action) {
    if (action === 'list') return { devices, group, capabilities: {} };
    if (action === 'select') return { device: remote, url: 'http://127.0.0.1:17771/s/c/' };
  } } });
  await view.settle();
  await view.nodes().find(node => node.props.className === 'dc-device-open' && textOf(node).includes('C')).props.onClick();
  await view.settle();
  assert(view.nodes().some(node => node.type === 'iframe'));

  devices = [local];
  await view.tick();
  assert.equal(view.nodes().some(node => node.type === 'iframe'), false);
  assert.equal(view.nodes().find(node => node.props.className === 'dc-surface').props.hidden, false);
  assert.equal(view.nodes().some(node => node.props['aria-label'] === 'C设置'), false);
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
  const view = fixture('ReconnectServer', { device: { id: 'server', name: '云端', kind: 'ssh' }, onConnected() {} }); await view.settle();
  const form = view.nodes().find(node => node.type === 'form'); await form.props.onSubmit({ preventDefault() {} }); await view.settle();
  assert(view.nodes().some(node => node.props.job?.id === 'job-id'));
  await view.tick(); assert(view.nodes().some(node => node.props.job?.state === 'completed'));
});


test('device center exposes one add flow and owner pairing through existing settings', async () => {
  const view = fixture('DeviceCenter'); await view.settle();
  assert.doesNotMatch(textOf(view.tree), /添加电脑|添加服务器|连接手机|App 地址/);
  await view.click('添加设备');
  assert(view.nodes().some(node => typeof node.type === 'function' && node.type.name === 'AddDevice'));
  const add = fixture('AddDevice', { onAdded() {}, sshAvailable: true }); await add.settle();
  const segments = add.nodes().find(node => node.props.label === '添加方式');
  assert.deepEqual(Array.from(segments.props.options, option => option.label), ['连接已有设备', '添加服务器']);
  segments.props.onChange('server'); await add.settle();
  assert.equal(add.nodes().find(node => node.props.id === 'dc-add-server-panel').props.hidden, false);
  assert(add.nodes().some(node => typeof node.type === 'function' && node.type.name === 'ServerInstall'));
});

test('server installation shows SSH first and places the manual script in a disclosure', async () => {
  const view = fixture('ServerInstall', { onAdded() {}, sshAvailable: false }); await view.settle();
  const manual = view.nodes().find(node => node.props.title === '手动安装');
  assert.equal(manual.props.defaultOpen, true);
  const download = view.nodes().find(node => node.props.download === 'install-server.sh');
  assert.equal(download.props.href, 'https://benchgo.cn/api/x/install/linux.sh');
  assert.equal(textOf(view.nodes().find(node => node.type === 'code')), `installer=$(curl -fsSL '${download.props.href}') && bash -c "$installer"`);
  assert.equal(view.nodes().some(node => typeof node.type === 'function' && node.type.name === 'AddServer'), false);
  assert.doesNotMatch(textOf(view.tree), /通过 SSH|不会|无需|密码与私钥/);
  const desktop = fixture('ServerInstall', { onAdded() {}, sshAvailable: true }); await desktop.settle();
  const ssh = desktop.nodes().find(node => typeof node.type === 'function' && node.type.name === 'AddServer');
  assert(ssh);
  assert.doesNotMatch(textOf(desktop.tree), /连接服务器/);
  assert.equal(desktop.nodes().find(node => node.props.title === '手动安装').props.defaultOpen, false);
});

test('job polling recovers automatically from a transient progress failure', async () => {
  let polls = 0;
  const view = fixture('AddServer', { onAdded() {}, runtime: { async call(action) {
    if (action === 'serverPrefetch') return { jobId: 'prefetch' };
    if (action === 'job') { if (++polls === 1) throw new Error('连接中断'); return { id: 'prefetch', kind: 'server-prefetch', state: 'failed', error: '部署资源缺失', steps: [] }; }
  } } });
  await view.settle(); await view.click('准备部署资源'); await view.tick();
  assert(view.nodes().some(node => node.props.error === '连接中断'));
  await view.tick();
  assert.equal(polls, 2);
  assert.match(textOf(view.tree), /重试/);
  assert.doesNotMatch(textOf(view.tree), /关闭此面板后|正在重试/);
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
  assert.equal(wizard.props.canDeploy, true);
  await wizard.props.onChanged(); await view.settle();
  assert.equal(pool().props.active, true);
  assert.equal(pool().props.refreshToken, revision + 1);
  assert.equal(view.nodes().find(node => node.props.id === 'dc-panel-relay').props.hidden, false);
  assert.equal(view.nodes().some(node => node.type?.name === 'RelayWizard'), false);
});

test('device directory omits the current workbench marker and keeps the existing frame reachable', async () => {
  const view = fixture('DeviceCenter'); await view.settle();
  const remote = () => view.nodes().find(node => node.props.className === 'dc-device-open' && textOf(node).includes('开发电脑'));
  const initialLabel = textOf(remote());
  await remote().props.onClick(); await view.settle();
  const frame = view.nodes().find(node => node.type === 'iframe');
  await view.nodes().find(node => node.props['aria-label'] === '返回设备中心').props.onClick(); await view.settle();
  assert.equal(view.nodes().find(node => node.props.className === 'dc-surface').props.hidden, false);
  assert.equal(view.nodes().find(node => node.type === 'iframe').props.src, frame.props.src);
  assert.equal(textOf(remote()), initialLabel);
  assert.match(textOf(view.tree), /本机工作台/);
  assert.doesNotMatch(textOf(view.tree), /当前打开的工作台/);
  assert.equal(view.nodes().some(node => node.props.className?.includes('dc-selected') || node.props.className === 'dc-topbar-workbench'), false);
  assert(view.nodes().some(node => node.props['aria-label'] === '开发电脑设置'));
  const pool = () => view.nodes().find(node => typeof node.type === 'function' && node.type.name === 'RelayPool');
  const before = pool().props.refreshToken;
  pool().props.onChanged(); await view.settle();
  assert.equal(pool().props.refreshToken, before + 1);
  assert.equal(view.nodes().find(node => typeof node.type === 'function' && node.type.name === 'LinkSettings').props.refreshToken, before + 1);
  await remote().props.onClick(); await view.settle();
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

test('opening device addition leaves membership unchanged and group members keep separate settings', async () => {
  const local = { id: 'local', name: '桌面', kind: 'local' };
  const member = { id: 'member', name: '服务器', kind: 'computer' };
  let group = { enabled: false, manageable: false, members: [] };
  const view = fixture('DeviceCenter', { runtime: { async call(action) {
    assert.notEqual(action, 'groupEnable');
    return { group, devices: group.enabled ? [local, member] : [local], capabilities: { hostAdmin: true } };
  } } });
  await view.settle();
  await view.click('添加设备');
  assert(view.nodes().some(node => node.type?.name === 'AddDevice'));
  await view.nodes().find(node => node.props.title === '添加设备').props.onClose();
  await view.settle();
  assert.equal(group.enabled, false);
  group = { enabled: true, manageable: true, members: [{ id: 'local-member', local: true }, { id: 'member', local: false }] };
  await view.nodes().find(node => node.props['aria-label'] === '刷新设备').props.onClick();
  await view.settle();
  await view.nodes().find(node => node.props['aria-label'] === '服务器设置').props.onClick();
  await view.settle();
  const settings = view.nodes().find(node => node.type?.name === 'ManageDevice');
  assert.equal(settings.props.membership.id, 'member');
  assert.equal(settings.props.canRemoveMember, true);
});

test('removing a group member uses its member identity and the group operation', async () => {
  let removed;
  const view = fixture('ManageDevice', {
    device: { id: 'directory-id', kind: 'computer', name: '服务器' },
    membership: { id: 'member-id' },
    canRemoveMember: true,
    onRemoved: id => { removed = id; },
  });
  await view.settle();
  await view.click('移出设备组');
  await view.click('确认移除');
  assert.equal(view.calls.at(-1).action, 'groupRemove');
  assert.equal(view.calls.at(-1).args.deviceId, 'member-id');
  assert.equal(removed, 'directory-id');
});

test('leaving a group from local settings requires confirmation', async () => {
  let removed;
  const view = fixture('ManageDevice', {
    device: { id: 'local', kind: 'local', name: '本机' },
    membership: { id: 'member-id', local: true },
    canRemoveMember: true,
    onRemoved: id => { removed = id; },
  });
  await view.settle();
  await view.click('退出设备组');
  assert.equal(view.calls.length, 0);
  await view.click('确认退出');
  assert.equal(view.calls.at(-1).action, 'groupLeave');
  assert.equal(view.calls.at(-1).args, undefined);
  assert.equal(removed, 'local');
});

test('a phone local device opens its name settings instead of selecting a workbench', async () => {
  const view = fixture('DeviceCenter', { runtime: { isNative: () => true } }); await view.settle();
  const add = view.nodes().find(node => typeof node.type === 'function' && textOf(node) === '添加设备');
  assert.equal(add.props.icon, 'plus');
  await view.nodes().find(node => node.props.className === 'dc-device-open' && textOf(node).includes('本机')).props.onClick(); await view.settle();
  assert.equal(view.calls.some(call => call.action === 'select'), false);
  assert(view.nodes().some(node => typeof node.type === 'function' && node.type.name === 'ManageDevice' && node.props.device.id === 'local'));
});


test('relay wizard verifies the SSH fingerprint and deploys without an email address', async () => {
  const calls = [];
  let connected = false;
  const status = pending => ({ relay: { fingerprint: 'rev', connected: true, nodes: [
    { id: 'other', url: 'https://elsewhere.test', connected: true, enabled: true },
    { id: 'deployed', url: 'https://8.8.8.8:24680', connected, enabled: true },
  ] }, pending });
  const view = fixture('RelayWizard', { onChanged() {}, runtime: { async call(action, args) {
    calls.push({ action, args });
    if (action === 'relayProbe') return { fingerprint: 'SHA256:relay' };
    if (action === 'relayDeploy') return { jobId: 'relay-job' };
    if (action === 'job') return { id: 'relay-job', state: 'completed', steps: [], relay: { url: 'https://8.8.8.8:24680' } };
    if (action === 'hostStatus') return status([{ id: 'phone', name: '手机' }]);
    if (action === 'hostConfirm') return status([]);
    if (action === 'hostRelayPoolConfigure') return status([]);
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
  assert.deepEqual(calls.map(item => item.action), ['relayProbe']);
  assert.match(textOf(view.tree), /请核对服务器的 SSH 指纹/);
  await submit();
  const deployment = calls.find(item => item.action === 'relayDeploy');
  assert.equal(calls[0].action, 'relayProbe'); assert.equal(deployment.args.fingerprint, 'SHA256:relay');
  assert.equal(deployment.args.email, ''); assert.equal(deployment.args.relayPort, 24680); assert.equal(deployment.args.challengeMode, 'standalone');
  assert.doesNotMatch(textOf(view.tree), /确认服务器身份|已有中继服务/);
  await view.tick();
  const pairButton = () => view.nodes().find(node => typeof node.type === 'function' && textOf(node) === '生成连接信息');
  assert.equal(pairButton().props.disabled, true);
  assert.match(textOf(view.tree), /跨网访问待验证/);
  connected = true; await view.tick();
  assert.equal(pairButton().props.disabled, false);
  await view.click('生成连接信息');
  assert.equal(calls.find(item => item.action === 'hostPairing').args.mode, 'relay');
  assert.equal(calls.find(item => item.action === 'hostPairing').args.relayId, 'deployed');
  const pairingDialog = () => view.nodes().find(node => node.props.pairing?.uri?.includes('code=once'));
  assert(pairingDialog());
  assert.equal(pairingDialog().props.pending[0].id, 'phone');
  await pairingDialog().props.onConfirm('phone', 'confirm'); await view.settle();
  assert.equal(calls.find(item => item.action === 'hostConfirm').args.id, 'phone');
  assert.equal(pairingDialog().props.pending.length, 0);
  await view.click('停用'); await view.click('确认停用');
  const toggle = calls.find(item => item.action === 'hostRelayPoolConfigure').args;
  assert.equal(toggle.operation, 'update'); assert.equal(toggle.id, 'deployed'); assert.equal(toggle.enabled, false);
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
  view.nodes().find(node => node.props.className === 'dc-relay-advanced').props.onOpenChange(true); await view.settle();
  assert(view.nodes().some(node => node.type === 'input' && node.props.placeholder === '/www/wwwroot/relay.example.com'));
  view.nodes().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await view.settle();
  view.nodes().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await view.settle(); await view.tick();
  assert.equal(calls.find(item => item.action === 'relayDeploy').args.challengeMode, 'webroot');
  assert(view.nodes().some(node => node.props.job?.error === 'SSH 认证失败，请检查用户名或密码')); assert.match(textOf(view.tree), /返回/);
  assert.equal(view.nodes().some(node => node.type === 'form'), false);
  await view.click('返回');
  assert(view.nodes().some(node => node.type === 'form'));
  assert.equal(calls.at(-1).action, 'relayJobDismiss');
});


test('adding an existing relay remains available without SSH deployment', async () => {
  const view = fixture('DeviceCenter'); await view.settle();
  const panel = view.nodes().find(node => node.props.id === 'dc-panel-relay');
  const pool = nodes(panel).find(node => typeof node.type === 'function' && node.type.name === 'RelayPool');
  pool.props.onAdd(); await view.settle();
  assert.equal(view.nodes().find(node => typeof node.type === 'function' && node.type.name === 'RelayWizard').props.canDeploy, false);
});

test('adding an existing relay tests without saving and appends to existing nodes', async () => {
  const calls = []; let changed = 0;
  const view = fixture('RelayWizard', { onChanged() { changed++; }, runtime: { async hostCall(action, input) {
    calls.push({ action, input });
    if (action === 'relayTest') return { ok: false, message: '中继拒绝认证' };
    if (action === 'hostStatus') return { relay: { fingerprint: 'rev', nodes: [{ id: 'first', url: 'https://first.test', enabled: true }] } };
    return { relay: {} };
  } } });
  await view.settle();
  await view.click('连接');
  assert(view.nodes().some(node => node.props.name === 'url'));
  assert.equal(view.nodes().some(node => node.props.placeholder === '公网 IP 或域名'), false);
  view.nodes().find(node => node.props.name === 'url').props.onChange({ target: { value: 'https://second.test' } });
  view.nodes().find(node => node.props.name === 'token').props.onChange({ target: { value: 'new-secret' } }); await view.settle();
  await view.click('测试');
  assert.equal(calls.length, 1); assert.equal(calls[0].action, 'relayTest'); assert.equal(changed, 0);
  assert(view.nodes().some(node => node.props.result?.message === '中继拒绝认证'));
  await view.nodes().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await view.settle();
  const saved = calls.find(item => item.action === 'hostRelayPoolConfigure').input;
  assert.equal(saved.operation, 'add'); assert.equal(saved.expected.fingerprint, 'rev'); assert.equal(saved.token, 'new-secret');
  assert.equal(saved.nodes, undefined);
  assert.equal(changed, 1);
});

test('relay list polls channel status, preserves edited secrets and leaves failed edits open', async () => {
  const calls = []; let connected = false, failSave = true;
  const status = () => ({ relay: { fingerprint: 'rev', preferredId: 'one', nodes: [{ id: 'one', url: 'https://relay.test', enabled: true, connected }] } });
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
  const tested = calls.find(item => item.action === 'relayTest'); assert.equal(tested.input.id, 'one'); assert.equal(tested.input.token, undefined);
  token().props.onChange({ target: { value: 'replacement-secret' } }); await view.settle();
  await view.nodes().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await view.settle();
  assert(token()); assert(view.nodes().some(node => node.props.error === '保存失败'));
  await view.tick(); assert(view.nodes().some(node => node.props.error === '保存失败'));
  const update = calls.find(item => item.action === 'hostRelayPoolConfigure').input;
  assert.equal(update.operation, 'update'); assert.equal(update.token, 'replacement-secret'); assert.equal(update.expected.fingerprint, 'rev');
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
    if (action === 'hostRelayPoolConfigure') current = input.operation === 'remove' ? [] : current.map(node => ({ ...node, enabled: input.enabled }));
    return { relay: { fingerprint: 'rev', nodes: current } };
  } } });
  await view.settle();
  const remove = () => view.nodes().find(node => node.props['aria-label'] === '删除中继 relay.test');
  assert.equal(remove().props.disabled, true);
  assert.equal(view.nodes().find(node => textOf(node) === '添加中继' && typeof node.type === 'function').props.icon, undefined);
  await view.click('停用');
  assert.equal(remove().props.disabled, false);
  await remove().props.onClick(); await view.settle();
  assert.deepEqual(current, []);
  assert.match(textOf(view.tree), /尚未添加中继/);
});
