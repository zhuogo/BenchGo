import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
const { transformSync } = createRequire(new URL('../../benchgo/package.json', import.meta.url))('esbuild');
const code = transformSync(readFileSync(new URL('../client/connections.jsx', import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs' }).code;
const walk = node => node && typeof node === 'object' ? [node, ...(node.children || []).flatMap(walk)] : [];
test('channel brand color is driven by saved availability, including fallback icons', () => {
  const source = transformSync(readFileSync(new URL('../../shared/client/channel-brand-icon.jsx', import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs' }).code;
  const module = { exports: {} };
  runInNewContext(source, { module, exports: module.exports, require: path => path.endsWith('confirmation.jsx') ? { useConfirmation: () => [async () => confirm, null] } : path.endsWith('/ui/button.jsx') ? { Button: 'button' } : path.endsWith('/ui/collapsible.jsx') ? { Disclosure: 'Disclosure' } : path === 'react' ? { createElement: (type, props, ...children) => ({ type, props, children }) } : path.endsWith('catalog.json') ? { feishu: 'feishu.svg' } : { UIIcon: 'Icon' } });
  const render = module.exports.ChannelBrandIcon;
  assert.equal(render({ channel: 'feishu', available: false, selected: true }).props.style.filter, 'grayscale(1)');
  assert.equal(render({ channel: 'feishu', available: true, selected: false }).props.style.filter, undefined);
  assert.equal(render({ channel: 'api', available: false, selected: true }).children[0].props.selected, false);
});
function harness({ configureError = false, credentialError = false, confirm = true, action, catalogError = false } = {}) {
  const config = { enabled: true, tokenRef: 'safe-ref', ownerIds: ['Owner:X'], untouched: 'keep' };
  const fields = [{ key: 'tokenRef', label: 'Token', required: true }, { key: 'ownerIds', label: '主人 ID', type: 'array' }];
  const state = [[{ id: 'telegram', label: 'Telegram', fields }, { id: 'discord', label: 'Discord', fields }], 'telegram', { channel: 'telegram', config, revision: 7 }, { ...config, ownerIds: 'Owner:X' }, { enabled: true, connection: { state: 'connected' } }, false, '', ''];
  let cursor = 0, refCursor = 0; const refs = [], effects = [], timers = new Set();
  const react = { createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(value => value !== false && value != null) }), useEffect(effect) { effects.push(effect); }, useRef: () => ({ current: 0 }), useState(initial) { const index = cursor++; if (!(index in state)) state[index] = initial; return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value; }]; } };
  const module = { exports: {} }, calls = [], visibilityListeners = new Set();
  const document = { visibilityState: 'visible', addEventListener: (_type, callback) => visibilityListeners.add(callback), removeEventListener: (_type, callback) => visibilityListeners.delete(callback) };
  react.useRef = initial => { const index = refCursor++; return refs[index] ||= { current: initial }; };
  runInNewContext(code, { module, exports: module.exports, document, AbortController, AbortSignal, window: { confirm: () => confirm }, setTimeout: callback => { timers.add(callback); return callback; }, clearTimeout: callback => timers.delete(callback), require: path => path.endsWith('confirmation.jsx') ? { useConfirmation: () => [async () => confirm, null] } : path.endsWith('/ui/button.jsx') ? { Button: 'button' } : path.endsWith('/ui/collapsible.jsx') ? { Disclosure: 'Disclosure' } : path === 'react' ? react : path === 'qrcode' ? { toDataURL: async content => 'data:image/png;base64,' + content } : { SegmentedControl: 'Tabs', ChannelBrandIcon: 'Brand', CustomSelect: 'CustomSelect' } });
  const api = async (op, input) => {
    calls.push({ op, input });
    if (op === 'connectionAction') {
      if (action) return action(input);
      if (input.operation === 'startLogin') return { loginId: 'login-1', qrContent: 'qr-test', status: 'wait' };
      if (input.operation === 'pollLogin') return { status: 'confirmed', config: { accountId: 'Account:X', tokenRef: 'encrypted-ref', baseUrl: 'https://ilinkai.weixin.qq.com' } };
      return {};
    }
    if (op === 'connectionCredential') { if (credentialError) throw new Error('credential failed'); return { ref: 'channel-secret:opaque-id' }; }
    if (op === 'connectionConfigure') { if (configureError) throw new Error('revision conflict'); return { channel: 'telegram', config: { ...config, ...input.patch }, revision: 8 }; }
    if (op === 'connections') return { channel: input.channel, config, revision: 7 };
    if (op === 'connectionCatalog') { if (catalogError) throw new Error('状态服务暂不可用'); return { channels: state[0].map(item => ({ ...item, status: { enabled: true, authentication: 'verified', connection: { state: 'connected' } } })) }; }
    return {};
  };
  return { state, calls, effects, timers, render: (props = {}) => { effects.length = 0; cursor = 0; refCursor = 0; return walk(module.exports.Connections({ api, ...props })); } };
}
test('status polling preserves drafts and ignores results after cleanup', async () => {
  const h = harness();
  h.state[3].ownerIds = 'Unsaved:Owner';
  h.render();
  const cleanup = h.effects.at(-1)();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.timers.size, 1);
  const callback = [...h.timers][0]; h.timers.delete(callback);
  await callback();
  assert.equal(h.calls.at(-1).op, 'connectionCatalog');
  assert.equal(h.state[3].ownerIds, 'Unsaved:Owner');
  const pending = [...h.timers][0]; h.timers.delete(pending);
  const lastStatus = h.state[4];
  const running = pending(); cleanup(); await running;
  assert.equal(h.state[4], lastStatus);
  assert.equal(h.timers.size, 0);
});

test('hidden connection view does not poll and a failed status refresh dims saved availability without replacing drafts', async () => {
  const hidden = harness();
  hidden.render({ active: false }); hidden.effects.at(-1)();
  assert.equal(hidden.calls.length, 0); assert.equal(hidden.timers.size, 0);
  const h = harness({ catalogError: true });
  h.state[4].authentication = 'verified';
  h.state[3].ownerIds = 'Unsaved:Owner';
  h.state[18] = { telegram: { at: Date.now(), stale: false } };
  h.render(); const cleanup = h.effects.at(-1)();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.state[3].ownerIds, 'Unsaved:Owner');
  assert.equal(h.state[4].authentication, 'verified');
  assert.equal(h.render().find(node => node.type === 'Tabs').props.options[0].icon.props.available, false);
  assert.equal(h.state[18].telegram.stale, true);
  cleanup();
});

test('channel saves only changed fields with opaque IDs and channel revision', async () => {
  const h = harness();
  h.render().find(node => node.type === 'textarea').props.onChange({ target: { value: 'Owner:Case/X\nOwner:Y' } });
  await h.render().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0])), { op: 'connectionConfigure', input: { channel: 'telegram', patch: { ownerIds: ['Owner:Case/X', 'Owner:Y'] }, revision: 7 } });
  assert.equal(h.state[2].config.untouched, 'keep');
  assert.equal(h.state[2].config.tokenRef, 'safe-ref');
});

function feishuHarness(options) {
  const h = harness(options);
  const config = { enabled: false, appId: 'App:Exact', appSecretRef: 'safe-ref', accessMode: 'platform', ownerOpenIds: ['Owner:Legacy'], chatIds: ['Legacy:Chat'], groups: [{ chatId: 'Chat:Selected', name: '无敌大队', mode: 'mentions' }], directMessages: true, otherGroups: 'disabled' };
  const fields = Object.keys(config).map(key => ({ key, label: key, type: ['ownerOpenIds', 'chatIds'].includes(key) ? 'list' : 'text' }));
  h.state[0] = [{ id: 'feishu', label: '飞书', fields }]; h.state[1] = 'feishu';
  h.state[2] = { channel: 'feishu', config, revision: 4 };
  h.state[3] = { ...config, ownerOpenIds: 'Owner:Legacy', chatIds: 'Legacy:Chat' };
  return h;
}

test('Feishu group mode saves structured rows without dropping other configuration', async () => {
  const h = feishuHarness();
  h.render().find(node => node.type === 'CustomSelect' && node.props.id === 'ba-group-Chat:Selected').props.onChange('all');
  await h.render().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  const patch = h.calls.find(call => call.op === 'connectionConfigure').input.patch;
  assert.deepEqual(JSON.parse(JSON.stringify(patch)), { groups: [{ chatId: 'Chat:Selected', name: '无敌大队', mode: 'all' }] });
});

test('Feishu can verify saved credentials while disabled and platform access hides member IDs', () => {
  const h = feishuHarness();
  const nodes = h.render();
  assert.equal(nodes.find(node => node.type === 'button' && node.children.includes('验证连接')).props.disabled, false);
  assert.equal(nodes.some(node => node.type === 'textarea' && node.props.id === 'ba-channel-ownerOpenIds'), false);
  nodes.find(node => node.type === 'CustomSelect' && node.props.id === 'ba-channel-accessMode').props.onChange('owners');
  assert.equal(h.render().find(node => node.type === 'textarea' && node.props.id === 'ba-channel-ownerOpenIds').props.value, 'Owner:Legacy');
});

test('Feishu group pagination deduplicates rows and preserves selected groups', async () => {
  const h = feishuHarness({ action: input => input.pageToken ? { chats: [{ chatId: 'Chat:New', name: '新群' }, { chatId: 'Chat:Last', name: '末页群' }] } : { chats: [{ chatId: 'Chat:New', name: '新群' }], nextPageToken: 'Opaque/Page:X' } });
  await h.render().find(node => node.type === 'button' && node.children.includes('刷新群列表')).props.onClick();
  await h.render().find(node => node.type === 'button' && node.children.includes('加载更多群')).props.onClick();
  assert.equal(h.calls.at(-1).input.pageToken, 'Opaque/Page:X');
  const rows = h.render().filter(node => node.type === 'CustomSelect' && node.props.id?.startsWith('ba-group-'));
  assert.equal(rows.length, 3);
  assert.equal(rows.find(row => row.props.id === 'ba-group-Chat:Selected').props.value, 'mentions');
  assert.equal(h.state[3].groups.length, 1);
});

test('legacy Feishu scope changes only through explicit migration and direct messages stay separate', () => {
  const h = feishuHarness(); h.state[2].config.groups = null; h.state[3].groups = null;
  const nodes = h.render();
  assert.equal(h.state[3].groups, null);
  nodes.find(node => node.type === 'button' && node.children.includes('改为按群配置')).props.onClick();
  assert.deepEqual(JSON.parse(JSON.stringify(h.state[3].groups)), [{ chatId: 'Legacy:Chat', mode: 'mentions' }]);
  h.render().find(node => node.type === 'CustomSelect' && node.props.id === 'ba-channel-directMessages').props.onChange('off');
  assert.equal(h.state[3].directMessages, false);
  assert.equal(h.state[3].groups[0].mode, 'mentions');
});
test('channel switch protects unsaved input and verification is disabled while dirty', () => {
  const h = harness({ confirm: false });
  h.render().find(node => node.type === 'textarea').props.onChange({ target: { value: 'Changed' } });
  const nodes = h.render();
  nodes.find(node => node.type === 'Tabs').props.onChange('discord');
  assert.equal(h.state[1], 'telegram');
  assert.equal(h.calls.length, 0);
  assert.equal(nodes.find(node => node.type === 'button' && node.children.includes('验证连接')).props.disabled, true);
});
test('revision conflict retains unsaved edits and does not replace base revision', async () => {
  const h = harness({ configureError: true });
  h.render().find(node => node.type === 'textarea').props.onChange({ target: { value: 'Changed' } });
  await h.render().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.equal(h.state[2].revision, 7);
  assert.equal(h.state[3].ownerIds, 'Changed');
  assert.equal(h.state[6], 'revision conflict');
});
test('save retry uses the current form validation and keeps the unsaved draft', async () => {
  const h = harness({ configureError: true });
  h.render().find(node => node.type === 'textarea').props.onChange({ target: { value: 'Owner:Unsaved' } });
  let submitted = 0;
  const form = h.render().find(node => node.type === 'form');
  form.props.ref.current = { requestSubmit() { submitted++; } };
  await form.props.onSubmit({ preventDefault() {} });
  const calls = h.calls.length;
  h.render().find(node => node.type === 'button' && node.children.includes('重试')).props.onClick();
  assert.equal(submitted, 1);
  assert.equal(h.calls.length, calls);
  assert.equal(h.state[3].ownerIds, 'Owner:Unsaved');
  assert.equal(h.state[2].revision, 7);
});
test('channel brand color follows verified availability rather than selection or enabled configuration', () => {
  const h = harness();
  h.state[4].authentication = 'verified';
  const options = h.render().find(node => node.type === 'Tabs').props.options;
  assert.equal(options[0].icon.props.available, true);
  assert.equal(options[1].icon.props.available, false);
  h.state[4] = { enabled: true, connection: { state: 'failed' } };
  assert.equal(h.render().find(node => node.type === 'Tabs').props.options[0].icon.props.available, false);
  h.state[0][1].status = { enabled: true, connection: { state: 'connecting' } };
  assert.equal(h.render().find(node => node.type === 'Tabs').props.options[1].icon.props.available, false);
  h.state[0][1].status = { enabled: true, authentication: 'verified', connection: { state: 'connected' } };
  assert.equal(h.render().find(node => node.type === 'Tabs').props.options[1].icon.props.available, true);
  h.state[4] = { enabled: false };
  const selected = h.render().find(node => node.type === 'Tabs').props.options[0].icon.props;
  assert.equal(selected.available, false);

});

test('authenticated Feishu transport lights the brand before REST or message verification', () => {
  const h = feishuHarness();
  h.state[4] = { enabled: true, authentication: 'unverified', events: 'unverified', sending: 'unverified', connection: { state: 'connected', authenticated: true } };
  const nodes = h.render();
  assert.equal(nodes.find(node => node.type === 'Tabs').props.options[0].icon.props.available, true);
  assert.equal(nodes.find(node => node.props.className === 'ba-channel-status').props['data-tone'], 'success');
  const checks = nodes.filter(node => node.props.className === 'ba-connection-check');
  assert.deepEqual(checks.map(node => node.props['data-tone']), ['success', 'neutral', 'neutral']);
  h.state[4].connection = { state: 'reconnecting', authenticated: false };
  assert.equal(h.render().find(node => node.type === 'Tabs').props.options[0].icon.props.available, false);
});

test('custom channel choices preserve opaque values and required validation before saving', async () => {
  const h = harness();
  h.state[0][0].fields.push({ key: 'mode', label: 'Mode', required: true, options: ['Opaque:Mode/X', { value: 'Opaque:Mode/Y', label: 'Y' }] });
  await h.render().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.equal(h.calls.length, 0);
  assert.match(h.state[6], /Mode/);
  h.render().find(node => node.type === 'CustomSelect' && node.props.id === 'ba-channel-mode').props.onChange('Opaque:Mode/Y');
  await h.render().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.equal(h.calls[0].input.patch.mode, 'Opaque:Mode/Y');
  h.state[5] = true;
  assert.equal(h.render().find(node => node.type === 'CustomSelect').props.disabled, true);
});
test('credential entry clears plaintext and stores only returned reference in configuration', async () => {
  const h = harness();
  h.render().find(node => node.type === 'input' && node.props.type === 'password').props.onChange({ target: { value: 'secret-value' } });
  await h.render().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.equal(h.state[8].tokenRef, '');
  assert.equal(h.state[3].tokenRef, 'channel-secret:opaque-id');
  assert.equal(h.calls[0].op, 'connectionCredential');
  assert.equal(h.calls[1].op, 'connectionConfigure');
  assert.equal(h.calls[1].input.patch.tokenRef, 'channel-secret:opaque-id');
  assert.equal(JSON.stringify(h.calls[1]).includes('secret-value'), false);
});
test('cancel and channel switch clear credential plaintext', async () => {
  const h = harness();
  const enter = () => h.render().find(node => node.type === 'input' && node.props.type === 'password').props.onChange({ target: { value: 'secret-value' } });
  enter();
  h.render().find(node => node.type === 'button' && node.children.includes('取消输入')).props.onClick();
  assert.equal(h.state[8].tokenRef, '');
  enter();
  await h.render().find(node => node.type === 'Tabs').props.onChange('discord');
  assert.equal(Object.keys(h.state[8]).length, 0);
});
test('QR login renders locally and merges only returned credential references into draft', async () => {
  const h = harness();
  h.state[0][0].capabilities = { qrLogin: true };
  await h.render().find(node => node.type === 'button' && node.children.includes('扫码连接')).props.onClick();
  assert.equal(h.render().find(node => node.type === 'img').props.src, 'data:image/png;base64,qr-test');
  await h.render().find(node => node.type === 'button' && node.children.includes('检查扫码状态')).props.onClick();
  assert.equal(h.state[3].accountId, 'Account:X');
  assert.equal(h.state[3].tokenRef, 'encrypted-ref');
  assert.equal(h.state[3].untouched, 'keep');
  assert.equal(h.state[9], null);
});
test('cancel QR login invokes cancellation and clears displayed QR', async () => {
  const h = harness(); h.state[0][0].capabilities = { qrLogin: true };
  await h.render().find(node => node.type === 'button' && node.children.includes('扫码连接')).props.onClick();
  h.render().find(node => node.type === 'button' && node.children.includes('取消扫码')).props.onClick();
  assert.equal(h.calls.at(-1).input.operation, 'cancelLogin');
  assert.equal(h.calls.at(-1).input.loginId, 'login-1');
  assert.equal(h.state[9], null);
});


test('credentials expose a single input and keep existing configuration when blank', async () => {
  const h = harness();
  const inputs = h.render().filter(node => node.type === 'input' && node.props.id === 'ba-channel-tokenRef');
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].props.type, 'password');
  assert.equal(inputs[0].props.required, false);
  assert.equal(inputs[0].props.value, '');
  await h.render().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.equal(h.calls.some(call => call.op === 'connectionCredential'), false);
  assert.equal(h.calls[0].input.patch.tokenRef, undefined);
});

test('credential failure retains input and prevents configuration save', async () => {
  const h = harness({ credentialError: true });
  h.render().find(node => node.type === 'input' && node.props.type === 'password').props.onChange({ target: { value: 'secret-value' } });
  await h.render().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.equal(h.state[8].tokenRef, 'secret-value');
  assert.equal(h.state[3].tokenRef, 'safe-ref');
  assert.equal(h.state[6], 'credential failed');
  assert.equal(h.calls.length, 1);
});

test('configuration failure retries the saved reference without storing the secret again', async () => {
  const h = harness({ configureError: true });
  h.render().find(node => node.type === 'input' && node.props.type === 'password').props.onChange({ target: { value: 'secret-value' } });
  const submit = () => h.render().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  await submit();
  assert.equal(h.state[8].tokenRef, '');
  assert.equal(h.state[3].tokenRef, 'channel-secret:opaque-id');
  await submit();
  assert.equal(h.calls.filter(call => call.op === 'connectionCredential').length, 1);
  assert.equal(h.calls.at(-1).input.patch.tokenRef, 'channel-secret:opaque-id');
});

test('clearing removes the reference explicitly and requires a replacement when enabled', () => {
  const h = harness();
  h.render().find(node => node.type === 'button' && node.children.includes('清除')).props.onClick();
  assert.equal(h.state[3].tokenRef, '');
  assert.equal(h.state[8].tokenRef, '');
  assert.equal(h.render().find(node => node.type === 'input' && node.props.type === 'password').props.required, true);
});
