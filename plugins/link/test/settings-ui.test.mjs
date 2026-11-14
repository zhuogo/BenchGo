import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { connectionDefaults, pairingConnection } from '../client/connection-mode.mjs';

const require = createRequire(new URL('../../benchgo/package.json', import.meta.url));
const { transformSync } = require('esbuild');
const source = await readFile(new URL('../client/app.jsx', import.meta.url), 'utf8');
const css = await readFile(new URL('../client/style.css', import.meta.url), 'utf8');
const code = transformSync(source, { loader: 'jsx', format: 'cjs' }).code;
const catalog = JSON.parse(await readFile(new URL('../../benchgo/client/assets/iconsax/catalog.json', import.meta.url), 'utf8'));
const nodes = tree => tree && typeof tree === 'object' ? [tree, ...(tree.children || []).flatMap(nodes)] : [];
const textOf = node => (node?.children || []).map(value => typeof value === 'object' ? textOf(value) : String(value)).join('');
function fixture({ origin = 'https://dsh.draftgo.cn', clipboard = async () => {}, respond } = {}) {
  const location = new URL(origin), slots = [], effects = [], effectDeps = [], calls = [], timers = new Map();
  let cursor = 0, effectCursor = 0;
  const createElement = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(value => value !== false && value != null) });
  const react = { createElement, useState(initial) { const id = cursor++; if (!(id in slots)) slots[id] = typeof initial === 'function' ? initial() : initial; return [slots[id], value => { slots[id] = typeof value === 'function' ? value(slots[id]) : value; }]; }, useRef(initial) { const id = cursor++; return slots[id] ??= { current: initial }; }, useEffect(fn, deps) { effects[effectCursor] = fn; effectDeps[effectCursor] = deps; effectCursor++; }, useId: () => 'pair-title' + cursor++ };
  const status = { enabled: true, publicUrl: '', host: '0.0.0.0', port: 48721, addresses: ['https://192.168.1.4:48721'], devices: [], pending: [] };
  const module = { exports: {} }, portalTarget = {}, portals = [];
  const listeners = new Map();
  const document = { body: portalTarget, getElementById: () => ({}), activeElement: null, addEventListener(name, callback) { listeners.set(name, callback); }, removeEventListener(name) { listeners.delete(name); } };
  runInNewContext(code, { module, exports: module.exports, URL, location, document, navigator: { clipboard: { writeText: clipboard } }, AbortController, setTimeout: (callback, delay) => { const id = timers.size + 1; timers.set(id, { callback, delay }); return id; }, clearTimeout: id => timers.delete(id), require: id => id.includes('device-state') ? { deviceIcon: () => 'devices' } : id === 'react' ? react : id === 'react-dom' ? { createPortal: (node, target) => { portals.push({ node, target }); return target === portalTarget ? node : { type: 'Portal', props: { target }, children: [] }; } } : id.includes('connection-mode') ? { connectionDefaults, pairingConnection } : id.includes('api.mjs') ? { managementCall: async (action, input) => { calls.push({ action, input }); if (respond) return respond(action, input, status); if (action === 'configure') Object.assign(status, input); return action === 'pairing' ? { mode: input.mode, code: 'FULL.CODE', uri: 'dshlink://pair?code=FULL.CODE' } : { ...status }; } } : id.includes('iconsax') ? { UIIcon: 'Icon' } : id.includes('ui/collapsible') ? { Disclosure: 'Disclosure' } : id.includes('ui/button') ? { Button: 'button' } : id.includes('shared/client/select') ? { Select: 'Select' } : id.includes('qr.jsx') ? { PairQr: 'QR' } : { default: '' } });
  const render = (component = module.exports.LinkSettings, props = { ctx: {} }) => { cursor = 0; effectCursor = 0; return component(props); };
  const find = (tree, label) => nodes(tree).find(node => textOf(node) === label && (node.type === 'button' || typeof node.type === 'function'));
  return { exports: module.exports, render, find, slots, effects, effectDeps, calls, status, document, listeners, timers, portals };
}

test('HTTPS cloud hosts default to browser pairing; private LAN hosts need no public URL', () => {
  assert.deepEqual(connectionDefaults(new URL('https://dsh.draftgo.cn')), { mode: 'public', publicUrl: 'https://dsh.draftgo.cn' });
  assert.equal(connectionDefaults(new URL('https://111.170.18.12:48721')).mode, 'public');
  for (const host of ['localhost', 'work.localhost', 'work.local', '127.0.0.1', '10.1.2.3', '172.19.0.1', '192.168.8.8', '169.254.1.1', '[::1]', '[fd00::1]', '[fe80::1]']) assert.deepEqual(connectionDefaults(new URL('https://' + host)), { mode: 'lan', publicUrl: '' }, host);
  assert.equal(connectionDefaults(new URL('http://dsh.draftgo.cn')).mode, 'lan');
});

test('automatic pairing prefers configured HTTPS, then current HTTPS origin, connected relay and LAN', () => {
  const defaults = { publicUrl: 'https://current.example.com' };
  assert.deepEqual(pairingConnection({ publicUrl: 'https://saved.example.com/', relay: { connected: true } }, defaults), { mode: 'public', publicUrl: 'https://saved.example.com' });
  assert.deepEqual(pairingConnection({ relay: { connected: true } }, defaults), { mode: 'public', publicUrl: defaults.publicUrl });
  assert.deepEqual(pairingConnection({ relay: { connected: true } }), { mode: 'relay', publicUrl: '' });
  assert.deepEqual(pairingConnection({ relay: { configured: true, connected: false } }), { mode: 'lan', publicUrl: '' });
  for (const publicUrl of ['http://desk.example.com', 'https://user:secret@desk.example.com', 'https://desk.example.com/path', 'https://desk.example.com/?token=secret', 'https://desk.example.com/#fragment', 'invalid']) {
    assert.equal(pairingConnection({ publicUrl, relay: { connected: true } }).mode, 'relay', publicUrl);
  }
});

test('configured public pairing wins over a connected relay without changing settings', async () => {
  const view = fixture({ origin: 'http://localhost:3000' });
  view.status.publicUrl = 'https://saved.example.com'; view.status.relay = { configured: true, connected: true };
  view.render(); view.effects[1](); await new Promise(resolve => setImmediate(resolve));
  await view.find(view.render(), '生成连接信息').props.onClick();
  assert.equal(view.calls.at(-1).input.mode, 'public');
  assert.equal(view.calls.some(call => call.action === 'configure'), false);
});

test('cloud connect reuses the HTTPS origin without overwriting advanced drafts', async () => {
  const view = fixture();
  view.render(); view.effects[1](); await new Promise(resolve => setImmediate(resolve));
  let tree = view.render();
  const hostInput = nodes(tree).find(node => node.type === 'input' && node.props.placeholder === '0.0.0.0');
  hostInput.props.onChange({ target: { value: '127.0.0.9' } });
  await view.find(tree, '生成连接信息').props.onClick();
  assert.deepEqual(JSON.parse(JSON.stringify(view.calls.filter(call => call.action !== 'status'))), [{ action: 'configure', input: { enabled: true, publicUrl: 'https://dsh.draftgo.cn' } }, { action: 'pairing', input: { mode: 'public' } }]);
  tree = view.render();
  assert.equal(nodes(tree).find(node => node.type === 'input' && node.props.placeholder === '0.0.0.0').props.value, '127.0.0.9');
  assert.equal(nodes(tree).some(node => node.props['aria-label'] === '连接方式'), false);
});

test('local connect pairs using LAN without configuring a public endpoint', async () => {
  const view = fixture({ origin: 'http://localhost:3000' });
  view.render(); view.effects[1](); await new Promise(resolve => setImmediate(resolve));
  await view.find(view.render(), '生成连接信息').props.onClick();
  assert.equal(view.calls.some(call => call.action === 'configure'), false);
  assert.equal(view.calls.at(-1).action, 'pairing');
  assert.equal(view.calls.at(-1).input.mode, 'lan');
});

test('compact pairing portal copies only the canonical URI and reports clipboard failure', async () => {
  const copied = [], pairing = { mode: 'public', code: 'VERY.LONG.FULL.CODE', uri: 'benchgo://pair?code=VERY.LONG.FULL.CODE', webUrl: 'https://desk.example.com/link/#code=VERY.LONG.FULL.CODE' };
  const view = fixture({ clipboard: async value => copied.push(value) });
  const props = { pairing, pending: [], onClose() {}, onConfirm() {}, busy: '' };
  const tree = view.render(view.exports.PairingDialog, props);
  assert(nodes(tree).some(node => node.props.role === 'dialog' && node.props['aria-modal'] === 'true'));
  await view.find(tree, '复制连接信息').props.onClick();
  assert.deepEqual(copied, [pairing.uri]);
  assert.equal(nodes(tree).filter(node => node.type === view.exports.Button).length, 1);
  assert.equal(nodes(tree).some(node => node.type === 'code'), false);
  assert.equal(nodes(tree).find(node => node.type === 'QR').props.value, pairing.webUrl);
  assert.doesNotMatch(textOf(tree), /完整配对码|短码|添加设备|再回到这里|扫码打开/);
  assert(nodes(view.render(view.exports.PairingDialog, props)).some(node => node.props.role === 'status' && textOf(node) === '连接信息已复制'));
  const failed = fixture({ clipboard: async () => { throw Error('denied'); } });
  await failed.find(failed.render(failed.exports.PairingDialog, props), '复制连接信息').props.onClick();
  assert(nodes(failed.render(failed.exports.PairingDialog, props)).some(node => node.props.role === 'status' && textOf(node).includes('复制失败')));
});

test('Link controls use real Iconsax assets and one bounded linear icon layer', () => {
  for (const match of source.matchAll(/(?:icon|name)="([A-Za-z]+)"/g)) assert(catalog[match[1]], 'missing Iconsax key: ' + match[1]);
  assert.match(css, /\.link-dialog-backdrop\) \.cmd-ui-bold\s*\{\s*display: none !important/);
  assert.match(css, /\.link-pair-dialog \.link-pair-title \{[^}]*display: flex[^}]*font-size: 18px/s);
  assert.match(css, /body\[data-ds-dark-theme\] :is\(\.link-settings, \.link-dialog-backdrop\)/);
  for (const key of ['scan', 'refresh', 'copy', 'close']) for (const variant of ['linear', 'bold']) {
    assert(catalog[key][variant].includes('viewBox="0 0 24 24"'));
    assert(catalog[key][variant].includes('currentColor'));
  }
});

test('pairing modal owns Escape and Tab focus, restoring its invoking control', () => {
  const view = fixture(); let closed = 0, focused = '';
  view.document.activeElement = { isConnected: true, focus() { focused = 'previous'; } };
  const tree = view.render(view.exports.PairingDialog, { pairing: { mode: 'lan', code: 'CODE', uri: 'dshlink://pair' }, pending: [], onClose() { closed++; }, busy: '' });
  const first = { focus() { focused = 'first'; }, closest() { return null; } }, last = { focus() { focused = 'last'; }, closest() { return null; } };
  const dialog = { querySelector() { return first; }, querySelectorAll() { return [first, last]; }, contains(element) { return element === first || element === last; } };
  nodes(tree).find(node => node.props.role === 'dialog').props.ref.current = dialog;
  const cleanup = view.effects[0](); assert.equal(focused, 'first');
  const event = key => ({ key, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } });
  view.document.activeElement = last; const tab = event('Tab'); view.listeners.get('keydown')(tab);
  assert.equal(focused, 'first'); assert.equal(tab.defaultPrevented, true); assert.equal(tab.stopped, true);
  view.document.activeElement = first; const back = { ...event('Tab'), shiftKey: true }; view.listeners.get('keydown')(back); assert.equal(focused, 'last');
  const escape = event('Escape'); view.listeners.get('keydown')(escape); assert.equal(closed, 1); assert.equal(escape.stopped, true);
  cleanup(); assert.equal(focused, 'previous'); assert.equal(view.listeners.size, 0);
});

test('connection requests overlay the QR dialog and keep keyboard focus in the approval layer', () => {
  const view = fixture(); let closed = 0, focused = '';
  const props = { pairing: { mode: 'lan', code: 'CODE', uri: 'dshlink://pair' }, pending: [{ id: 'phone', name: '我的手机' }], onClose() { closed++; }, onConfirm() {}, busy: '', error: '暂时无法授权，请重试' };
  let tree = view.render(view.exports.PairingDialog, props);
  const first = { isConnected: true, focus() { focused = 'first'; }, closest() { return null; } }, last = { focus() { focused = 'last'; }, closest() { return null; } };
  const qrFocus = { isConnected: true, focus() { focused = 'qr'; } };
  const qrDialog = nodes(tree).find(node => node.props.role === 'dialog');
  qrDialog.props.ref.current = { querySelector: () => qrFocus };
  const approval = nodes(tree).find(node => node.props.role === 'alertdialog');
  assert(approval);
  approval.props.ref.current = { querySelector: () => first, querySelectorAll: () => [first, last], contains: element => element === first || element === last };
  assert.equal(qrDialog.props['aria-modal'], undefined);
  assert.equal(nodes(tree).find(node => node.props.className === 'link-dialog-backdrop').props.inert, '');
  assert.equal(nodes(tree).some(node => node.type === view.exports.ErrorText && textOf(node) === props.error), true);
  view.effects[0](); view.document.activeElement = qrFocus; const cleanupApproval = view.effects[1](); assert.equal(focused, 'first');
  const event = key => ({ key, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } });
  view.document.activeElement = last; const tab = event('Tab'); view.listeners.get('keydown')(tab);
  assert.equal(tab.defaultPrevented, true); assert.equal(focused, 'first');
  view.listeners.get('keydown')(event('Escape')); assert.equal(closed, 0);
  tree = view.render(view.exports.PairingDialog, props);
  assert.equal(nodes(tree).some(node => node.props.role === 'alertdialog'), false);
  cleanupApproval(); assert.equal(focused, 'qr');
  view.find(tree, '查看连接请求（1）').props.onClick();
  tree = view.render(view.exports.PairingDialog, props);
  assert(nodes(tree).some(node => node.props.role === 'alertdialog'));
  const changed = view.render(view.exports.PairingDialog, { ...props, pending: [{ id: 'other', name: '另一台设备' }] });
  assert(nodes(changed).some(node => node.props.role === 'alertdialog'));
  assert.match(css, /\.link-approval-backdrop \{ z-index: 2110/);
});

test('approval uses existing confirm and reject actions and prevents closing while busy', () => {
  const view = fixture(), calls = []; let closed = 0;
  const props = { pairing: { mode: 'lan', code: 'CODE', uri: 'dshlink://pair' }, pending: [{ id: 'phone', name: '我的手机' }], onClose() { closed++; }, onConfirm: (id, action) => calls.push({ id, action }), busy: '' };
  const tree = view.render(view.exports.PairingDialog, props);
  view.find(tree, '允许').props.onClick(); view.find(tree, '拒绝').props.onClick();
  assert.deepEqual(calls, [{ id: 'phone', action: 'confirm' }, { id: 'phone', action: 'reject' }]);
  view.effects[0]();
  const busyTree = view.render(view.exports.PairingDialog, { ...props, busy: 'confirm' });
  assert.equal(view.find(busyTree, '正在允许…').props.disabled, true);
  assert.equal(view.find(busyTree, '拒绝').props.disabled, true);
  const close = nodes(busyTree).find(node => node.props['aria-label'] === '暂时关闭连接请求');
  assert.equal(close.props.disabled, true); close.props.onClick();
  view.listeners.get('keydown')({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(closed, 0);
  assert(nodes(view.render(view.exports.PairingDialog, props)).some(node => node.props.role === 'alertdialog'));
});

test('new pending requests open approval automatically without inheriting dismissed request IDs', () => {
  const view = fixture();
  const props = { pairing: { mode: 'lan', code: 'CODE', uri: 'dshlink://pair' }, pending: [], onClose() {}, onConfirm() {}, busy: '' };
  assert.equal(nodes(view.render(view.exports.PairingDialog, props)).some(node => node.props.role === 'alertdialog'), false);
  const requested = { ...props, pending: [{ id: 'phone,tablet', name: '我的手机' }] };
  let tree = view.render(view.exports.PairingDialog, requested);
  assert(nodes(tree).some(node => node.props.role === 'alertdialog'));
  nodes(tree).find(node => node.props['aria-label'] === '暂时关闭连接请求').props.onClick();
  tree = view.render(view.exports.PairingDialog, requested);
  assert.equal(nodes(tree).some(node => node.props.role === 'alertdialog'), false);
  tree = view.render(view.exports.PairingDialog, { ...props, pending: [{ id: 'phone' }, { id: 'tablet' }] });
  assert(nodes(tree).some(node => node.props.role === 'alertdialog'));
});

test('failed approval retains QR, pending request and error after busy ends and status refreshes', async () => {
  let failConfirmation;
  const view = fixture({ origin: 'http://localhost:3000', respond: async (action, input, status) => {
    if (action === 'pairing') return { mode: input.mode, code: 'CODE', uri: 'dshlink://pair' };
    if (action === 'confirm') return new Promise((_resolve, reject) => { failConfirmation = reject; });
    return { ...status };
  } });
  view.status.pending = [{ id: 'phone', name: '我的手机' }];
  view.render(); const stopIdle = view.effects[1](); await new Promise(resolve => setImmediate(resolve));
  await view.find(view.render(), '生成连接信息').props.onClick();
  const pairNode = () => nodes(view.render()).find(node => node.type === view.exports.PairingDialog);
  const active = pairNode(), confirming = active.props.onConfirm('phone', 'confirm');
  assert.equal(pairNode().props.busy, 'confirm');
  failConfirmation(Error('设备授权失败')); await confirming;
  let pair = pairNode();
  assert.equal(pair.props.pairing.code, 'CODE'); assert.equal(pair.props.pending[0].id, 'phone');
  assert.equal(pair.props.busy, ''); assert.equal(pair.props.error, '设备授权失败');
  stopIdle(); const stopPairing = view.effects[1](); await new Promise(resolve => setImmediate(resolve));
  pair = pairNode(); assert.equal(pair.props.error, '设备授权失败'); assert.equal(pair.props.pending[0].id, 'phone');
  stopPairing();
});

test('pairing refreshes status quickly while settings retain the normal idle polling interval', async () => {
  const view = fixture({ origin: 'http://localhost:3000' });
  view.render(); const stopIdle = view.effects[1](); await new Promise(resolve => setImmediate(resolve));
  assert.equal([...view.timers.values()][0].delay, 10_000);
  await view.find(view.render(), '生成连接信息').props.onClick(); stopIdle();
  view.render(); const stopPairing = view.effects[1](); await new Promise(resolve => setImmediate(resolve));
  assert.equal([...view.timers.values()][0].delay, 1_500);
  assert.deepEqual(Array.from(view.effectDeps[1]), [0, true]);
  stopPairing();
  const callsBefore = view.calls.length;
  view.render(view.exports.LinkSettings, { refreshToken: 42 });
  assert.deepEqual(Array.from(view.effectDeps[1]), [42, true]);
  const stopRefresh = view.effects[1](); await new Promise(resolve => setImmediate(resolve));
  assert.equal(view.calls.length, callsBefore + 1); assert.equal(view.calls.at(-1).action, 'status');
  stopRefresh();
});

test('host failure ends loading, disables dependent actions, stops polling and recovers on retry', async () => {
  let fail = true;
  const view = fixture({ respond: async (_action, _input, status) => { if (fail) throw Object.assign(Error('服务待就绪，请稍后重试'), { detail: 'HTTP 404 · /api/commander-link' }); return { ...status }; } });
  let tree = view.render();
  assert(nodes(tree).some(node => node.props.label === '正在读取连接状态…'));
  assert.equal(nodes(tree).some(node => textOf(node) === '生成连接信息'), false);
  const stop = view.effects[1](); await new Promise(resolve => setImmediate(resolve)); tree = view.render();
  assert.doesNotMatch(textOf(tree), /正在连接|读取中|三步|CONNECT YOUR|LINK HOST/);
  assert.match(textOf(tree), /dsh\.draftgo\.cn/);
  assert.equal(view.find(tree, '生成连接信息').props.disabled, true);
  assert.equal(nodes(tree).some(node => node.props.id === 'link-enabled'), false);
  assert.equal(view.timers.size, 0);
  assert(nodes(tree).some(node => node.type === 'Disclosure' && node.props.className === 'link-error-detail'));
  fail = false; await view.find(tree, '重试').props.onClick(); tree = view.render();
  assert.equal(view.find(tree, '生成连接信息').props.disabled, false);
  assert.equal(view.timers.size, 1);
  assert.equal([...view.timers.values()][0].delay, 10_000);
  stop(); assert.equal(view.timers.size, 0);
});


test('embedded settings use owner device transport and keep advanced options collapsed', async () => {
  const view = fixture(); const calls = [];
  const props = { embedded: true, management: async (action, input) => { calls.push({ action, input }); return { enabled: true, devices: [], pending: [] }; } };
  view.render(view.exports.LinkSettings, props); view.effects[1](); await new Promise(resolve => setImmediate(resolve));
  const tree = view.render(view.exports.LinkSettings, props);
  await view.find(tree, '生成连接信息').props.onClick();
  assert.equal(calls.at(-1).action, 'pairing');
  const advanced = nodes(tree).find(node => node.type === 'Disclosure' && node.props.className === 'link-advanced');
  assert(advanced); assert.equal(advanced.props.open, undefined);
  assert.equal(nodes(advanced).some(node => node.props['aria-label'] === '连接方式'), false);
  assert.equal(nodes(tree).some(node => node.props['aria-label'] === '连接方式'), false);
  assert.equal(nodes(tree).some(node => node.props.className === 'link-pair-row'), false);
  assert(view.find(tree, '生成连接信息'));
  assert(nodes(advanced).some(node => node.type === 'input' && node.props.placeholder === '0.0.0.0'));
  assert.doesNotMatch(textOf(tree), /连接手机|App 地址/);
});

test('authorized device remarks save through owner management and retain edits on failure', async () => {
  let fail = true;
  const view = fixture({ respond: async (action, input, status) => {
    if (action === 'rename-device') {
      if (fail) throw Error('保存失败');
      status.devices = status.devices.map(device => device.id === input.id ? { ...device, name: input.name } : device);
    }
    return { ...status };
  } });
  view.status.devices = [{ id: 'phone', name: '手机原名' }];
  view.render(); const cleanup = view.effects[1](); await new Promise(resolve => setImmediate(resolve));
  const initial = view.render(), edit = nodes(initial).find(node => node.props['aria-label'] === '编辑设备备注');
  assert.equal(edit.props.title, undefined);
  assert(nodes(initial).some(node => node.props.label === '编辑备注' && nodes(node).includes(edit)));
  assert.equal(textOf(edit), ''); edit.props.onClick();
  let tree = view.render();
  const form = () => nodes(tree).find(node => node.props.className === 'link-device-rename');
  assert.equal(nodes(tree).find(node => node.props.className === 'link-authorized-device-info').children[0], form());
  for (const [label, hint] of [['取消修改设备备注', '取消修改'], ['保存设备备注', '保存备注']]) {
    const action = nodes(form()).find(node => node.props['aria-label'] === label);
    assert.equal(action.props.title, undefined);
    assert(nodes(form()).some(node => node.props.label === hint && nodes(node).includes(action)));
  }
  nodes(form()).find(node => node.type === 'input').props.onChange({ target: { value: '随身手机' } });
  tree = view.render(); await form().props.onSubmit({ preventDefault() {} }); tree = view.render();
  assert(form()); assert.match(textOf(tree), /保存失败/);
  assert.equal(nodes(form()).find(node => node.type === 'input').props.value, '随身手机');
  fail = false; await form().props.onSubmit({ preventDefault() {} }); tree = view.render();
  assert.equal(form(), undefined); assert.match(textOf(tree), /随身手机/);
  assert.deepEqual(JSON.parse(JSON.stringify(view.calls.at(-1))), { action: 'rename-device', input: { id: 'phone', name: '随身手机' } });
  cleanup();
});

test('inline authorized remarks cancel, respect composition and submit once with Enter', async () => {
  let resolveRename;
  const view = fixture({ respond: async (action, input, status) => {
    if (action === 'rename-device') {
      await new Promise(resolve => { resolveRename = resolve; });
      status.devices = [{ id: input.id, name: input.name }];
    }
    return { ...status };
  } });
  view.status.devices = [{ id: 'phone', name: '手机原名' }];
  view.render(); const cleanup = view.effects[1](); await new Promise(resolve => setImmediate(resolve));
  const find = label => nodes(view.render()).find(node => node.props['aria-label'] === label);
  const event = (key, extra = {}) => ({ key, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...extra });
  find('编辑设备备注').props.onClick();
  find('设备备注名称').props.onChange({ target: { value: '未保存名称' } });
  const escape = event('Escape'); find('设备备注名称').props.onKeyDown(escape);
  assert.equal(escape.prevented, true); assert.equal(escape.stopped, true);
  assert.equal(find('设备备注名称'), undefined); assert.match(textOf(view.render()), /手机原名/);
  find('编辑设备备注').props.onClick(); find('取消修改设备备注').props.onClick(); assert.equal(find('设备备注名称'), undefined);
  find('编辑设备备注').props.onClick();
  find('设备备注名称').props.onChange({ target: { value: '  随身手机  ' } });
  let input = find('设备备注名称'); input.props.onCompositionStart();
  const composing = event('Enter'); input.props.onKeyDown(composing);
  assert.equal(composing.prevented, true); assert.equal(view.calls.some(call => call.action === 'rename-device'), false);
  input.props.onCompositionEnd();
  input.props.onKeyDown(event('Enter', { nativeEvent: { isComposing: true } }));
  input.props.onKeyDown(event('Enter', { keyCode: 229 }));
  assert.equal(view.calls.some(call => call.action === 'rename-device'), false);
  const saving = input.props.onKeyDown(event('Enter'));
  await input.props.onKeyDown(event('Enter'));
  assert.equal(view.calls.filter(call => call.action === 'rename-device').length, 1);
  assert.equal(find('取消修改设备备注').props.disabled, true);
  find('取消修改设备备注').props.onClick(); assert(find('设备备注名称'));
  resolveRename(); await saving;
  assert.equal(find('设备备注名称'), undefined); assert.match(textOf(view.render()), /随身手机/);
  assert.equal(view.calls.at(-1).input.name, '随身手机');
  cleanup();
});

test('embedded connection controls portal management into the supplied device area', async () => {
  const view = fixture({ origin: 'http://localhost:3000' }), detailsTarget = {};
  const props = { embedded: true, detailsTarget };
  view.render(view.exports.LinkSettings, props); view.effects[1](); await new Promise(resolve => setImmediate(resolve));
  let tree = view.render(view.exports.LinkSettings, props);
  assert(view.find(tree, '生成连接信息'));
  assert.equal(nodes(tree).some(node => node.props.id === 'link-enabled'), false);
  assert.doesNotMatch(textOf(tree), /已启用|未启用/);
  assert.equal(nodes(tree).some(node => node.type === 'Disclosure' || node.props.className === 'link-device-list'), false);
  assert.doesNotMatch(textOf(tree), /允许其他设备连接|高级设置|已授权访问/);
  const detailPortal = view.portals.at(-1);
  assert.equal(detailPortal.target, detailsTarget);
  assert(nodes(detailPortal.node).some(node => node.props.className === 'link-advanced'));
  assert(nodes(detailPortal.node).some(node => node.props.className === 'link-device-list'));
  assert.equal(nodes(detailPortal.node).some(node => node.props.className === 'link-settings'), false);
  await view.find(tree, '生成连接信息').props.onClick();
  tree = view.render(view.exports.LinkSettings, props);
  assert(nodes(tree).some(node => node.type === view.exports.PairingDialog));
  assert.equal(view.calls.at(-1).input.mode, 'lan');
});


test('relay pairing is automatic and falls back to LAN when the relay disconnects', async () => {
  const view = fixture({ origin: 'http://localhost:3000' });
  view.status.relay = { configured: true, connected: true };
  view.render(); view.effects[1](); await new Promise(resolve => setImmediate(resolve));
  await view.find(view.render(), '生成连接信息').props.onClick();
  assert.equal(view.calls.at(-1).input.mode, 'relay');
  assert.equal(view.calls.some(call => call.action === 'configure'), false);
  view.status.relay.connected = false;
  await view.effects[1](); await new Promise(resolve => setImmediate(resolve));
  await view.find(view.render(), '生成连接信息').props.onClick();
  assert.equal(view.calls.at(-1).input.mode, 'lan');
});

test('pairing grants are opt-in and checked choices are sent explicitly', async()=>{
 const view=fixture({origin:'http://localhost:3000'});view.render();const stop=view.effects[1]();await new Promise(setImmediate);
 await view.find(view.render(),'生成连接信息').props.onClick();assert.deepEqual(JSON.parse(JSON.stringify(view.calls.at(-1))),{action:'pairing',input:{mode:'lan'}});
 const pair=nodes(view.render()).find(node=>node.type===view.exports.PairingDialog);pair.props.onClose();
 let tree=view.render();const grant=label=>nodes(tree).find(node=>node.type==='label'&&textOf(node)===label).children.find(node=>node.type==='input');
 grant('允许委派和跟进本机任务').props.onChange({target:{checked:true}});tree=view.render();grant('允许查询连接及申请修改中继').props.onChange({target:{checked:true}});
 await view.find(view.render(),'生成连接信息').props.onClick();assert.deepEqual(JSON.parse(JSON.stringify(view.calls.at(-1).input)),{mode:'lan',collaboration:true,management:true});stop();
});
test('failed single-field grant keeps authoritative capabilities and other fields unchanged',async()=>{
 let fail=true;const view=fixture({respond:async(action,input,status)=>{if(action==='grant-device'){if(fail)throw Error('授权保存失败');status.devices[0].capabilities=['management','collaboration'];}return {...status};}});
 view.status.devices=[{id:'legacy',name:'旧设备',capabilities:['management']}];view.render();const stop=view.effects[1]();await new Promise(setImmediate);
 const box=label=>nodes(view.render()).find(node=>node.type==='input'&&node.props['aria-label']===label);
 await box('旧设备：任务协作').props.onChange({target:{checked:true}});assert.equal(box('旧设备：任务协作').props.checked,false);assert.equal(box('旧设备：连接与中继管理').props.checked,true);assert.match(textOf(view.render()),/授权保存失败/);assert.deepEqual(JSON.parse(JSON.stringify(view.calls.at(-1))),{action:'grant-device',input:{id:'legacy',collaboration:true}});
 fail=false;await box('旧设备：任务协作').props.onChange({target:{checked:true}});assert.equal(box('旧设备：任务协作').props.checked,true);assert.equal(box('旧设备：连接与中继管理').props.checked,true);stop();
});
test('specific relay approval refreshes status after operation receipt without replacing device catalog',async()=>{
 const view=fixture({respond:async(action,input,status)=>{if(action==='management-decide'){status.pendingManagement=[];return {id:input.operationId,state:'applied'};}return {...status};}});
 view.status.devices=[{id:'phone',name:'保留设备',capabilities:['management']}];view.status.relay={nodes:[{id:'relay',url:'https://relay.example.com'}]};view.status.pendingManagement=[{id:'operation',deviceName:'远端电脑',ops:[{path:['nodes',0,'priority'],value:7},{path:['nodes',0,'enabled'],value:false}]}];view.render();const stop=view.effects[1]();await new Promise(setImmediate);
 const tree=view.render();assert.match(textOf(tree),/https:\/\/relay.example.com：优先级改为 7/);assert.match(textOf(tree),/https:\/\/relay.example.com：停用/);
 await view.find(tree,'应用这次修改').props.onClick();assert.deepEqual(JSON.parse(JSON.stringify(view.calls.slice(-2))),[{action:'management-decide',input:{operationId:'operation',allow:true}},{action:'status',input:{}}]);assert.match(textOf(view.render()),/保留设备/);assert.match(textOf(view.render()),/修改已保存并应用/);assert.doesNotMatch(textOf(view.render()),/远端电脑 请求修改/);stop();
});
for(const [state,message] of [['failed','修改未完成：中继不可用'],['expired','请求已过期']])test('management '+state+' result stays explicit while device catalog survives',async()=>{
 const view=fixture({respond:async(action,input,status)=>action==='management-decide'?{id:input.operationId,state,error:{message:'中继不可用'}}:{...status}});view.status.devices=[{id:'desk',name:'已有设备'}];view.status.pendingManagement=[{id:'operation',ops:[]}];view.render();const stop=view.effects[1]();await new Promise(setImmediate);await view.find(view.render(),'应用这次修改').props.onClick();assert(textOf(view.render()).includes(message));assert.match(textOf(view.render()),/已有设备/);stop();
});
