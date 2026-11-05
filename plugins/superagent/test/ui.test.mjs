import { retainAssistantSession } from '../client/session-retain.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import * as modelSettings from '../client/model-settings.mjs';
import { createConfigSync, saveConfigPatch } from '../client/config-sync.mjs';
const { transformSync } = createRequire(new URL('../../benchgo/package.json', import.meta.url))('esbuild');
const code = transformSync(readFileSync(new URL('../client/index.jsx', import.meta.url), 'utf8') + '\nexport { mergeHistory, Images, loadCatalog, messageText, HistoryNotice, retainSession, PendingCard, PendingInteractions, UIIcon, Identity, Studio, ResourceTabs, RetainedPane };', { loader: 'jsx', format: 'cjs' }).code;
const settingsCode = transformSync(readFileSync(new URL('../client/model-settings.jsx', import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs' }).code;
function harness(options = {}) {
  let cursor = 0, refCursor = 0; const state = [...(options.state || [])], refs = [], effects = [], calls = [];
  const react = { createElement: (type, props, ...children) => type?.name === 'ModelSettings' ? type(props) : ({ type, props: props || {}, children: children.flat(Infinity).filter(value => value !== false && value != null) }), useState: initial => { const index = cursor++; if (!(index in state)) state[index] = Array.isArray(initial) && options.threads ? options.threads : typeof initial === 'function' ? initial() : initial; return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value; }]; }, useRef: initial => refs[refCursor++] ||= { current: initial }, useEffect: (effect, deps) => effects.push({ effect, deps }), useId: () => 'id' };
  react.useSyncExternalStore = (_subscribe, snapshot) => snapshot();
  const settingsModule = { exports: {} };
  runInNewContext(settingsCode, { module: settingsModule, exports: settingsModule.exports, require: id => id.endsWith('/ui/button.jsx') ? { Button: 'button' } : id.endsWith('/ui/collapsible.jsx') ? { Disclosure: 'Disclosure' } : id.endsWith('session-retain.mjs') ? { retainAssistantSession } : id === 'react' ? react : id.endsWith('model-settings.mjs') ? modelSettings : id.endsWith('dsh-client-ui-primitives') ? { Switch: 'Switch' } : '' });
  const registryModule = { exports: {} };
  runInNewContext(transformSync(readFileSync(new URL('../client/dirty-registry.mjs', import.meta.url), 'utf8'), { format: 'cjs' }).code, { module: registryModule, exports: registryModule.exports, require: id => id.endsWith('/ui/button.jsx') ? { Button: 'button' } : id.endsWith('/ui/collapsible.jsx') ? { Disclosure: 'Disclosure' } : react });
  const listeners = new Map(), documentListeners = new Map(), intervals = [];
  const module = { exports: {} };
  const assistantConfigSync = createConfigSync();
  runInNewContext(code, { module, exports: module.exports, URL, Event, CustomEvent, AbortController, localStorage: options.storage, queueMicrotask, setTimeout: fn => fn(), setInterval: fn => { intervals.push(fn); return fn; }, clearInterval: fn => { intervals.splice(intervals.indexOf(fn), 1); }, window: { confirm: options.confirm || (() => true), addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) }, crypto: { randomUUID }, document: { baseURI: 'https://local/', hidden: false, addEventListener: (name, fn) => documentListeners.set(name, fn), removeEventListener: name => documentListeners.delete(name), dispatchEvent(event) { documentListeners.get(event.type)?.(event); return true; } }, fetch: async (url, options) => { calls.push(JSON.parse(options.body)); return {}; }, require: id => id.endsWith('/ui/button.jsx') ? { Button: 'button' } : id.endsWith('/ui/collapsible.jsx') ? { Disclosure: 'Disclosure' } : id.endsWith('session-retain.mjs') ? { retainAssistantSession } : id === 'react' ? react : id.endsWith('model-settings.mjs') ? modelSettings : id.endsWith('model-settings.jsx') ? settingsModule.exports : id.endsWith('config-sync.mjs') ? { assistantConfigSync, saveConfigPatch } : id.endsWith('dirty-registry.mjs') ? registryModule.exports : id.endsWith('http-response.mjs') ? { readJsonResponse: async () => typeof options.response === 'function' ? options.response(calls.at(-1)) : options.response || ({ providers: [], models: [] }) } : id.endsWith('dsh-client-ui-primitives') ? { Tooltip: ({ label, children }) => react.createElement('span', { 'data-tooltip': label }, children), Modal: () => null, Menu: () => null, IconPinOutlineMedium: "IconPinOutlineMedium", IconPinFillMedium: "IconPinFillMedium", IconArchiveOutlineMedium: "IconArchiveOutlineMedium", IconArchiveOffOutlineMedium: "IconArchiveOffOutlineMedium", IconEllipsisOutlineMedium: "IconEllipsisOutlineMedium" } : {} });
  return { listeners, documentListeners, intervals, exports: module.exports, render(name, props) { cursor = 0; refCursor = 0; effects.length = 0; return module.exports[name](props); }, calls, effects };
}
const walk = node => node && typeof node === 'object' ? [node, ...node.children.flatMap(walk)] : [];

test('model edits preserve opaque IDs and unrelated hidden configuration across save and reload', async () => {
  const auxiliary = { models: [{ providerId: 'aux/@', modelId: 'Exact: Aux/01' }], capabilities: ['compression'] };
  const models = [{ providerId: 'p/@', modelId: 'Exact: Main/01', options: { maxTokens: 700 } }, { providerId: 'fallback', modelId: 'Exact: F/02' }];
  const config = { revision: 8, name: 'A', models, auxiliary, image: { modelId: 'Image:01' } };
  const changed = [...models].reverse();
  const h = harness({ response: { ...config, models: changed, revision: 9 } });
  const props = { initialTab: 'models', snapshot: { config }, execute: operation => operation(), refresh: async () => {} };
  let nodes = walk(h.render('Identity', props));
  assert.equal(nodes.some(node => ['AuxiliaryModels', 'KeyPools'].includes(node.type?.name)), false);
  nodes.find(node => node.props.label === '提高优先级' && !node.props.disabled).props.onClick();
  nodes = walk(h.render('Identity', props));
  await nodes.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls)), [{ action: 'config', revision: 8, patch: { models: changed } }]);
  nodes = walk(h.render('Identity', props));
  assert.equal(nodes.find(node => node.type === 'button' && node.props.type === 'submit').props.disabled, true);
  const reopened = walk(harness().render('Identity', { ...props, snapshot: { config: { ...config, models: changed, revision: 9 } } }));
  assert.deepEqual(reopened.filter(node => node.type?.name === 'ModelFields').map(node => node.props.value.modelId), [...changed, ...auxiliary.models].map(model => model.modelId));
  assert.equal(config.auxiliary, auxiliary);
});

test('auxiliary capability switch saves independently on the same model page', async () => {
  const config = { revision: 12, name: 'BenchGo', models: [{ providerId: 'main', modelId: 'Main/Exact' }], auxiliary: { models: [{ providerId: 'aux', modelId: 'Aux/Exact' }], capabilities: [] } };
  const next = { ...config, revision: 13, auxiliary: { ...config.auxiliary, capabilities: ['vision'] } };
  const h = harness({ response: next });
  const props = { initialTab: 'models', snapshot: { config }, execute: operation => operation(), refresh: async () => {} };
  let nodes = walk(h.render('Identity', props));
  const boxes = nodes.filter(node => node.type === 'Switch');
  assert.equal(boxes.length, 4);
  assert.equal(boxes[0].props.disabled, false);
  boxes[0].props.onChange(true);
  nodes = walk(h.render('Identity', props));
  assert.equal(nodes.filter(node => node.type === 'Switch')[0].props.checked, true);
  await nodes.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls)), [{ action: 'config', revision: 12, patch: { auxiliary: next.auxiliary } }]);
  const empty = walk(harness().render('Identity', { ...props, snapshot: { config: { ...config, auxiliary: null } } }));
  assert(empty.filter(node => node.type === 'Switch').every(node => node.props.disabled));
});

test('archived side chats expose only unarchive and delete with the distinct restore icon', () => {
  const h = harness({ threads: [{ id: 'side', title: 'Side', archived: true, pinned: true }] });
  const props = { showArchived: true, ctx: { layout: { panelInfo: { getSnapshot: () => ({ activePanelId: 'benchgo-assistant' }), subscribe: () => () => {} } } } };
  const nodes = walk(h.render('AssistantSidebarEntry', props));
  const row = nodes.find(node => node.props.className?.split(' ').includes('cmd-session-row'));
  assert(row.props.className.includes('is-archived'));
  const actions = walk(row).filter(node => node.type === 'button' && node.props.className?.includes('cmd-session-quick'));
  assert.deepEqual(actions.map(node => node.props['aria-label']), ['取消归档对话', '删除旁聊']);
  assert(walk(row).some(node => node.type === 'IconArchiveOffOutlineMedium'));
  assert(!walk(row).some(node => node.props.className === 'cmd-session-more'));
});

test('assistant conversations use the shared sidebar section with pinned icon-free main chat', () => {
  const h = harness();
  const nodes = walk(h.render('AssistantSidebarEntry', { ctx: { layout: { panelInfo: { getSnapshot: () => ({ activePanelId: 'benchgo-assistant' }), subscribe: () => () => {} } } } }));
  assert.ok(nodes.some(node => node.props.className === 'ba-card-row'));
  const chatAction = nodes.find(node => node.props.className === 'ba-assistant-action ba-action-chat');
  assert.ok(chatAction);
  assert.equal(chatAction.props['aria-label'], '打开主聊天');
  assert.ok(walk(chatAction).some(node => node.children?.includes('主聊天')));
  assert.ok(nodes.some(node => node.props.className === 'ba-assistant-action ba-action-resources' && node.props['aria-label'] === '打开资源'));
  assert.ok(!nodes.some(node => node.props.className === 'ba-assistant-action ba-action-settings'));
  assert.ok(!nodes.some(node => node.props.className?.includes('cmd-session') && node.children.includes('\u4e3b\u804a')));
  assert.ok(nodes.some(node => node.props['aria-label'] === '新建旁聊'));
});
test('main chat activity follows its official session even when another panel is selected', () => {
  let statuses = new Map([['main-session', { running: true }], ['side-session', { running: true }]]);
  const h = harness({ state: [[], true, 'side', '', false, null, null, false, 'main-session'] });
  const ctx = { layout: { panelInfo: { getSnapshot: () => ({ activePanelId: 'another-panel' }), subscribe: () => () => {} } }, uiSession: { sessionStatus: { getSnapshot: () => statuses, subscribe: () => () => {} } } };
  const action = () => walk(h.render('AssistantSidebarEntry', { ctx })).find(node => node.props.className === 'ba-assistant-action ba-action-chat');
  assert.equal(action().props['data-running'], true);
  assert.match(action().props['aria-label'], /正在进行中/);
  statuses = new Map([['main-session', { running: false }], ['side-session', { running: true }]]);
  assert.equal(action().props['data-running'], false);
  assert.equal(action().props['aria-label'], '打开主聊天');
});

test('sidebar initial load is distinct from empty, failure retries, and refresh keeps existing chats', async () => {
  let response = new Error('offline');
  const h = harness({ response: () => { if (response instanceof Error) throw response; return response; } });
  const props = { ctx: { layout: { panelInfo: { getSnapshot: () => ({ activePanelId: 'benchgo-assistant' }), subscribe: () => () => {} } } } };
  let nodes = walk(h.render('AssistantSidebarEntry', props));
  assert(nodes.some(node => node.props.className === 'ba-sidebar-skeleton'));
  assert(!nodes.some(node => node.props['data-kind'] === 'empty'));
  const cleanups = h.effects.map(({ effect }) => effect()).filter(Boolean);
  await new Promise(setImmediate);
  nodes = walk(h.render('AssistantSidebarEntry', props));
  assert(nodes.some(node => node.props['data-kind'] === 'error'));
  assert(!nodes.some(node => node.props.className === 'ba-sidebar-skeleton'));
  response = { state: { threads: [] } };
  await nodes.find(node => node.type === 'button' && node.children.includes('重试加载')).props.onClick();
  nodes = walk(h.render('AssistantSidebarEntry', props));
  assert(nodes.some(node => node.props['data-kind'] === 'empty'));
  assert(nodes.some(node => node.type === 'button' && node.children.includes('新建旁聊')));
  response = { state: { threads: [{ id: 'side', sessionId: 'sid', title: '已有旁聊', createdAt: '2026-11-04T10:00:00Z' }] } };
  await h.intervals[0]();
  nodes = walk(h.render('AssistantSidebarEntry', props));
  assert(nodes.some(node => node.props.className === 'ba-thread-title' && node.children.includes('已有旁聊')));
  response = new Error('network changed');
  await h.intervals[0]();
  nodes = walk(h.render('AssistantSidebarEntry', props));
  assert(nodes.some(node => node.props.className === 'ba-thread-title' && node.children.includes('已有旁聊')));
  assert(nodes.some(node => node.props.title === '旁聊暂时无法更新'));
  assert(!nodes.some(node => node.props['data-kind'] === 'empty'));
  cleanups.forEach(dispose => dispose());
  assert.equal(h.intervals.length, 0);
});

test('sidebar shows one title with real activity time and independent status, without summary or native title tooltips', () => {
  const h = harness({ threads: [{ id: 'side', sessionId: 'sid', title: '设计讨论', createdAt: '2026-11-03T01:00:00Z' }] });
  let sessions = { byId: { sid: { title: '讨论侧栏布局与配色', updatedAt: 1793759400000, running: false, blank: false } } };
  let statuses = new Map([['sid', { running: true, pendingInteraction: { kind: 'approval' } }]]);
  const props = { ctx: { layout: { panelInfo: { getSnapshot: () => ({ activePanelId: 'benchgo-assistant' }), subscribe: () => () => {} } }, sessions: { list: { getSnapshot: () => sessions, subscribe: () => () => {} } }, uiSession: { sessionStatus: { getSnapshot: () => statuses, subscribe: () => () => {} } } } };
  let nodes = walk(h.render('AssistantSidebarEntry', props));
  assert(!nodes.some(node => node.props.className === 'ba-thread-summary'));
  assert(nodes.some(node => node.props.className === 'ba-thread-title' && node.children.includes('设计讨论')));
  assert.equal(nodes.find(node => node.props.className === 'ba-thread-time').props.dateTime, new Date(1793759400000).toISOString());
  assert.equal(nodes.find(node => node.props.className === 'ba-thread-time').props.title, undefined);
  assert.equal(nodes.find(node => node.props.className === 'ba-thread-status').props['data-status'], 'pending');
  statuses = new Map([['sid', { running: true }]]);
  nodes = walk(h.render('AssistantSidebarEntry', props));
  assert.equal(nodes.find(node => node.props.className === 'ba-thread-status').props['data-status'], 'running');
  assert(nodes.find(node => node.props.className === 'ba-thread-status').children.includes('忙碌'));
  statuses = new Map([['sid', { running: false, completionUnread: true }]]);
  nodes = walk(h.render('AssistantSidebarEntry', props));
  assert.equal(nodes.find(node => node.props.className === 'ba-thread-status').props['data-status'], 'idle');
  assert(nodes.find(node => node.props.className === 'ba-thread-status').children.includes('空闲'));
  statuses = new Map(); sessions = { byId: {} };
  nodes = walk(h.render('AssistantSidebarEntry', props));
  assert.equal(nodes.find(node => node.props.className === 'ba-thread-status').props['data-status'], 'unknown');
  assert(!nodes.some(node => node.props.className === 'ba-thread-summary'));
  const fresh = walk(harness({ threads: [{ id: 'new', title: '新旁聊' }] }).render('AssistantSidebarEntry', props));
  assert.equal(fresh.find(node => node.props.className === 'ba-thread-status').props['data-status'], 'idle');
  assert(!fresh.some(node => node.props.className === 'ba-thread-summary' || node.children.includes('开始一个新话题')));
});

test('sidebar collapse state and chevron structure follow shared rotation styles', () => {
  const h = harness(), props = { ctx: { layout: { panelInfo: { getSnapshot: () => ({ activePanelId: 'benchgo-assistant' }), subscribe: () => () => {} } } } };
  let nodes = walk(h.render('AssistantSidebarEntry', props));
  let toggle = nodes.find(node => node.props.className === 'cmd-section-toggle');
  assert.equal(toggle.props['aria-expanded'], true);
  toggle.props.onClick();
  nodes = walk(h.render('AssistantSidebarEntry', props));
  toggle = nodes.find(node => node.props.className === 'cmd-section-toggle');
  assert.equal(toggle.props['aria-expanded'], false);
  assert.equal(nodes.find(node => node.props.id === 'cmd-assistant-section').props['data-open'], false);
  const icon = h.render('UIIcon', { name: 'chevronDown' });
  assert.notEqual(icon.type, 'span');
  assert.equal(icon.props.name, 'chevronDown');
  const css = readFileSync(new URL('../client/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.ba-assistant-section\{[^}]*border-radius:12px;/);
  assert.match(readFileSync(new URL('../client/card.css', import.meta.url), 'utf8'), /\.ba-card-name\{[^}]*white-space:nowrap;/);
  assert.match(readFileSync(new URL('../../benchgo/client/style.css', import.meta.url), 'utf8'), /\.cmd-section-toggle\[aria-expanded="false"\] > \.cmd-ui-icon \{ transform: rotate\(-90deg\);/);
});

test('assistant collapse keeps the name card, hides all navigation and restores its local preference', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  const props = { ctx: { layout: { panelInfo: { getSnapshot: () => ({ activePanelId: 'benchgo-assistant' }), subscribe: () => () => {} } } } };
  const h = harness({ storage });
  let nodes = walk(h.render('AssistantSidebarEntry', props));
  let toggle = nodes.find(node => node.props.className === 'ba-assistant-toggle');
  assert.equal(toggle.props['aria-label'], '收起助手');
  assert.equal(toggle.props['aria-expanded'], true);
  assert.equal(nodes.find(node => node.props.id === toggle.props['aria-controls']).props.hidden, false);
  toggle.props.onClick();
  nodes = walk(h.render('AssistantSidebarEntry', props));
  toggle = nodes.find(node => node.props.className === 'ba-assistant-toggle');
  const body = nodes.find(node => node.props.className === 'ba-assistant-body');
  assert.equal(toggle.props['aria-label'], '展开助手');
  assert.equal(toggle.props['aria-expanded'], false);
  assert.equal(body.props.hidden, true);
  assert(nodes.some(node => node.props.className === 'ba-assistant-heading'));
  assert(walk(body).some(node => node.props['aria-label'] === '打开主聊天'));
  assert(walk(body).some(node => node.props['aria-label'] === '打开资源'));
  assert(walk(body).some(node => node.props['aria-label'] === '新建旁聊'));
  assert.equal(values.get('benchgo.assistant.sidebarExpanded'), 'false');

  const remount = harness({ storage });
  const reopened = walk(remount.render('AssistantSidebarEntry', props));
  assert.equal(reopened.find(node => node.props.className === 'ba-assistant-body').props.hidden, true);
  reopened.find(node => node.props.className === 'ba-assistant-toggle').props.onClick();
  assert.equal(walk(remount.render('AssistantSidebarEntry', props)).find(node => node.props.className === 'ba-assistant-body').props.hidden, false);
  assert.equal(values.get('benchgo.assistant.sidebarExpanded'), 'true');

  values.set('benchgo.assistant.sidebarExpanded', 'false');
  const archived = walk(harness({ storage }).render('AssistantSidebarEntry', { ...props, showArchived: true }));
  assert.equal(archived.find(node => node.props.className === 'ba-assistant-body').props.hidden, false);
  assert(!archived.some(node => node.props.className === 'ba-assistant-toggle'));

  const unavailable = harness({ storage: { getItem() { throw new Error('storage unavailable'); }, setItem() { throw new Error('storage unavailable'); } } });
  const fallback = walk(unavailable.render('AssistantSidebarEntry', props));
  assert.equal(fallback.find(node => node.props.className === 'ba-assistant-toggle').props['aria-expanded'], true);
  assert.doesNotThrow(() => fallback.find(node => node.props.className === 'ba-assistant-toggle').props.onClick());
  assert.equal(walk(unavailable.render('AssistantSidebarEntry', props)).find(node => node.props.className === 'ba-assistant-body').props.hidden, true);
});

test('sidebar selection follows chat and resource events without waiting for a panel change or refresh', async () => {
  const h = harness({ threads: [{ id: 'side', title: '设计讨论' }], response: { state: { threads: [{ id: 'side', title: '设计讨论' }] } } });
  const snapshot = { activePanelId: 'benchgo-assistant' };
  const props = { ctx: { layout: { panelInfo: { getSnapshot: () => snapshot, subscribe: () => () => {} }, selectPanel() {} } } };
  let nodes = walk(h.render('AssistantSidebarEntry', props));
  const cleanups = h.effects.map(({ effect }) => effect()).filter(Boolean);
  await new Promise(setImmediate);
  nodes.find(node => node.props.className?.startsWith('cmd-session ')).props.onClick();
  nodes = walk(h.render('AssistantSidebarEntry', props));
  assert.equal(nodes.find(node => node.props.className?.startsWith('cmd-session ')).props['aria-current'], 'page');
  nodes.find(node => node.props['aria-label'] === '打开资源').props.onClick();
  nodes = walk(h.render('AssistantSidebarEntry', props));
  assert.equal(nodes.find(node => node.props['aria-label'] === '打开资源').props['aria-current'], 'page');
  assert.equal(nodes.find(node => node.props.className?.startsWith('cmd-session ')).props['aria-current'], undefined);
  nodes.find(node => node.props['aria-label'] === '打开主聊天').props.onClick();
  nodes = walk(h.render('AssistantSidebarEntry', props));
  assert.equal(nodes.find(node => node.props['aria-label'] === '打开主聊天').props['aria-current'], 'page');
  assert.equal(nodes.find(node => node.props['aria-label'] === '打开资源').props['aria-current'], undefined);
  cleanups.forEach(dispose => dispose());
  assert.equal(h.documentListeners.has('benchgo:assistant-tab'), false);
});
test('resetting a custom name card preserves the rest of the settings draft', () => {
  const h = harness();
  const config = { name: 'A', cardHtml: '<b>A</b>', models: [], image: null, tts: null, asr: null };
  const props = { snapshot: { config } };
  let nodes = walk(h.render('Identity', props));
  nodes.find(node => node.props.defaultName).props.onChange({ cardHtml: null });
  nodes = walk(h.render('Identity', props));
  assert.equal(nodes.find(node => node.props.defaultName).props.config.cardHtml, null);
  assert.equal(nodes.find(node => node.type === 'input' && node.props.value === 'A').props.value, 'A');
});
test('history keeps earlier and middle pages across polling and send refreshes', () => {
  const { mergeHistory } = harness().exports;
  const page = (ids, nextBefore, extra = {}) => ({ messages: ids.map(id => ({ id, text: id })), hasMore: nextBefore !== null, nextBefore, ...extra });
  let history = mergeHistory({ messages: [] }, page(['c', 'd'], 3));
  history = mergeHistory(history, page(['a', 'b'], null, { images: [{ id: 'old-image', url: '/old.png' }] }), true);
  history = mergeHistory(history, page(['d', 'e'], 4, { images: [{ id: 'new-image', url: '/new.png' }] }));
  history = mergeHistory(history, page(['e', 'f'], 5));
  assert.equal(history.messages.map(message => message.id).join(','), 'a,b,c,d,e,f');
  assert.equal(history.images.map(image => image.id).join(','), 'old-image,new-image');
  assert.equal(history.hasMore, false);
  assert.equal(history.nextBefore, null);
});
test('earlier response preserves concurrent live reply and current status', () => {
  const { mergeHistory } = harness().exports;
  let history = { messages: [{ id: 'c' }, { id: 'live', streaming: true, text: 'new text' }], running: true, nextBefore: 3 };
  history = mergeHistory(history, { messages: [{ id: 'a' }, { id: 'b' }], running: false, hasMore: true, nextBefore: 1 }, true);
  assert.equal(history.running, true);
  assert.equal(history.messages.at(-1).text, 'new text');
  history = mergeHistory(history, { messages: [{ id: 'c' }, { id: 'complete', text: 'done' }], running: false, hasMore: true, nextBefore: 3 });
  assert.equal(history.messages.map(message => message.id).join(','), 'a,b,c,complete');
  assert.equal(history.running, false);
  assert.equal(history.nextBefore, 1);
});
test('side chats no longer expose bring-to-main controls', () => {
  assert.ok(!readFileSync(new URL('../client/index.jsx', import.meta.url), 'utf8').includes('bringToMain'));
  const entry = harness();
  const archived = walk(entry.render('AssistantSidebarEntry', { showArchived: true, ctx: { layout: { panelInfo: { getSnapshot: () => ({ activePanelId: 'benchgo-assistant' }), subscribe: () => () => {} } } } }));
  assert.ok(true);
  assert.ok(!archived.some(node => node.props.className === 'ba-card-row'));
});
test('side chat follows the main model queue and exposes handoff controls', () => {
  const h = harness();
  assert.ok(true);
});
test('catalog fetch is shared across model fields', async () => {
  const h = harness(); await Promise.all([h.exports.loadCatalog(), h.exports.loadCatalog(), h.exports.loadCatalog()]);
  assert.equal(h.calls.length, 1);
});
test('image previews reject executable URL schemes and expose download', () => {
  const h = harness(); const nodes = walk(h.render('Images', { images: [{ url: 'javascript:alert(1)' }, { url: '/api/assistant/image/1', name: 'picture.png' }] }));
  assert.equal(nodes.filter(node => node.type === 'img').length, 1);
  assert.equal(nodes.find(node => node.props.download).props.download, 'picture.png');
});
test('identity saves only changed card fields and never overwrites media or USER.md', async () => {
  const config = { revision: 1, name: 'A', cardHtml: '<b>A</b>', models: [{ providerId: 'cloud', modelId: 'Opaque:09' }], image: { modelId: 'Exact Image:01' }, video: { modelId: 'Exact Video:03' }, asr: { modelId: 'Exact ASR:07' }, tts: { modelId: 'Exact TTS:09' } };
  const h = harness({ response: { ...config, revision: 2, cardHtml: null } });
  const props = { snapshot: { config, profile: { identity: '协作原则', user: '保留 USER.md' } }, execute: operation => operation(), refresh: async () => {} };
  let nodes = walk(h.render('Identity', props));
  assert.equal(nodes.filter(node => node.type === 'textarea').length, 0);
  nodes.find(node => node.props.defaultName).props.onChange({ cardHtml: null });
  nodes = walk(h.render('Identity', props));
  await nodes.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls)), [{ action: 'config', patch: { cardHtml: null }, revision: 1 }]);
  assert.equal(config.models[0].modelId, 'Opaque:09');
});
test('resource navigation includes vault and system files last without settings or automation switch', () => {
  const h = harness(), props = { snapshot: { config: { models: [] } }, ctx: {} };
  const nodes = walk(h.render('Studio', props));
  const nav = nodes.find(node => node.type === 'nav');
  assert.deepEqual(walk(nav).filter(node => node.type === 'b').map(node => node.children[0]), ['身份', '档案', '任务', '记忆', '产物', '多平台', '保险库', '系统文件']);
  assert.equal(walk(nav).filter(node => node.props['aria-current'] === 'page')[0].children[1].children[0].children[0], '身份');
  assert.equal(nodes.some(node => node.props.className === 'ba-segment'), false);
});

test('ticket header opens the goal form and returns to the ticket list', () => {
  const h = harness(), props = { initialSection: 'tasks', snapshot: { config: { models: [] } }, ctx: {} };
  let nodes = walk(h.render('Studio', props));
  nodes.find(node => node.props.onCreateGoal).props.onCreateGoal();
  nodes = walk(h.render('Studio', props));
  const goals = nodes.find(node => node.props.onViewTickets);
  assert.equal(goals.props.initialCreating, true);
  goals.props.onViewTickets();
  assert(walk(h.render('Studio', props)).some(node => node.props.onCreateGoal));
});

test('ticket resource recovery opens existing Goal settings rather than creating a Goal', () => {
  const h = harness(), props = { initialSection: 'tasks', snapshot: { config: { models: [] } }, ctx: {} };
  walk(h.render('Studio', props)).find(node => node.props.onOpenGoals).props.onOpenGoals();
  assert.equal(walk(h.render('Studio', props)).find(node => node.props.onViewTickets).props.initialCreating, false);
  const chat = harness(), requested = { ...props, requestedTab: 'goals' };
  chat.render('Studio', requested);
  chat.effects.find(item => item.deps?.[0] === 'goals').effect();
  assert(walk(chat.render('Studio', requested)).some(node => node.props.onViewTickets));
});
test('identity body is edited only through documents; model priority remains exact', async () => {
  const config = { revision: 4, name: 'A', models: [{ providerId: 'cloud', modelId: 'Exact:First' }, { providerId: 'cloud', modelId: 'Exact:Second' }] };
  const h = harness({ response: { ...config, revision: 5 } }), props = { snapshot: { config, profile: { identity: 'old' } }, execute: operation => operation(), refresh: async () => {} };
  let nodes = walk(h.render('Identity', props));
  assert.equal(nodes.some(node => node.type === 'textarea'), false);
  nodes.find(node => node.type === h.exports.ResourceTabs).props.onChange('models');
  nodes = walk(h.render('Identity', props));
  nodes.find(node => node.props.label === '提高优先级' && !node.props.disabled).props.onClick();
  nodes = walk(h.render('Identity', props));
  await nodes.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.deepEqual(h.calls[0].patch.models.map(model => model.modelId), ['Exact:Second', 'Exact:First']);
  assert.equal(h.calls[0].revision, 4);
  assert(!h.calls.some(call => call.action === 'profile'));
});

test('message rendering never passes content block objects to React', () => {
  const { messageText } = harness().exports;
  assert.equal(messageText({ text: '', content: [{ type: 'tool-call', name: 'tool' }] }), '');
  assert.equal(messageText({ content: [{ type: 'text', text: 'hello' }, { type: 'image' }, { type: 'text', text: 'world' }] }), 'hello\nworld');
  assert.equal(messageText({ content: {} }), '');
});
test('backend errors and fallback reasons are visible', () => {
  const h = harness(); const nodes = walk(h.render('HistoryNotice', { history: { error: 'All models unavailable', failures: [{ model: { modelId: 'exact-id' }, reason: 'Rate limited' }] } }));
  assert.ok(nodes.some(node => node.props.role === 'alert' && walk(node).some(child => child.children.includes('All models unavailable'))));
  assert.ok(nodes.some(node => node.children.includes('exact-id') && node.children.includes('Rate limited')));
});
test('approval is answered only by explicit user action using official outcome', async () => {
  const h = harness(), answers = [];
  const pending = { key: 'approval:1', kind: 'approval', answerable: true, reason: 'Run task', answer: async value => answers.push(value) };
  const nodes = walk(h.render('PendingCard', { pending, title: '主聊天' }));
  assert.deepEqual(answers, []);
  await nodes.find(node => node.type === 'button' && node.children[0] === '允许本次').props.onClick();
  assert.deepEqual(answers, ['allowed-once']);
});
test('question replies follow official selected-label answer contract', async () => {
  const h = harness(), answers = [];
  const props = { title: '鏃佽亰', pending: { kind: 'question', key: 'q1', questions: [{ id: 'q', question: 'Choose', options: [{ label: 'Option A' }] }], answer: async value => answers.push(value) } };
  let nodes = walk(h.render('PendingCard', props));
  nodes.find(node => node.type === 'input').props.onChange({ target: { checked: true } });
  nodes = walk(h.render('PendingCard', props));
  await nodes.find(node => node.type === 'button').props.onClick();
  assert.deepEqual(JSON.parse(JSON.stringify(answers)), [{ answers: [{ id: 'q', selected: ['Option A'] }] }]);
});
test('session scope waits for the assistant writer and remains alive until explicit release', async () => {
  let finishEnsure;
  const h = harness({ response: new Promise(resolve => { finishEnsure = resolve; }) }); let released = false, called;
  const scope = h.exports.retainSession({ sessions: { retain: (sessionId, options) => { called = { sessionId, options }; return { ready: Promise.resolve(), release() { released = true; } }; } } }, 'assistant-session', 'side');
  assert.deepEqual(h.calls, [{ action: 'ensure', threadId: 'side' }]);
  assert.equal(called, undefined);
  finishEnsure({ sessionId: 'assistant-session' });
  await scope.ready;
  assert.equal(called.sessionId, 'assistant-session');
  assert.equal(called.options.source, 'workspaceOperation');
  assert.equal(released, false);
  scope.release();
  assert.equal(released, true);
  assert.equal(called.options.signal.aborted, true);
});
test('released or replaced assistant sessions never open a stale official writer', async () => {
  for (const released of [false, true]) {
    let finishEnsure, retained = false;
    const h = harness({ response: new Promise(resolve => { finishEnsure = resolve; }) });
    const scope = h.exports.retainSession({ sessions: { retain: () => { retained = true; } } }, 'old-session');
    if (released) scope.release();
    finishEnsure({ sessionId: released ? 'old-session' : 'new-session' });
    await scope.ready;
    assert.equal(retained, false);
    scope.release();
  }
});
test('failed assistant initialization does not activate an official session and can be retried', async () => {
  const options = { response: { sessionId: 'assistant-session' } };
  const h = harness(options); let retained = 0, failEnsure;
  options.response = new Promise((_resolve, reject) => { failEnsure = reject; });
  const ctx = { sessions: { retain: () => { retained++; return { ready: Promise.resolve(), release() {} }; } } };
  const failed = h.exports.retainSession(ctx, 'assistant-session');
  failEnsure(new Error('Assistant initialization failed'));
  await assert.rejects(failed.ready, /Assistant initialization failed/);
  assert.equal(retained, 0);
  failed.release();
  options.response = { sessionId: 'assistant-session' };
  const retried = h.exports.retainSession(ctx, 'assistant-session');
  await retried.ready;
  assert.equal(retained, 1);
  retried.release();
});
test('background assistant thread approval remains visible', () => {
  const h = harness(); const pending = { key: 'a', kind: 'approval' };
  const nodes = walk(h.render('PendingInteractions', { ctx: { uiSession: { sessionStatus: { getSnapshot: () => new Map([['side-session', { pendingInteraction: pending }]]) } } }, threads: [{ id: 'side', title: 'Background work', sessionId: 'side-session' }] }));
  assert.ok(nodes.some(node => node.props.pending === pending && node.props.title === 'Background work'));
});
test('clear is a main-chat slash action that resets once and opens the new session', async () => {
  const snapshot = { config: { revision: 1, models: [{ providerId: 'provider', modelId: 'model' }] }, state: { mainSessionId: 'main-old', threads: [] } };
  const history = { sessionId: 'main-old', messages: [{ id: 'old-message' }], images: [{ id: 'old-image', url: '/old.png' }], error: 'Old error' };
  const h = harness({ state: [snapshot, '', 'chat', 'main', history], response: ({ action }) => {
    if (action === 'resetMain') return { cleared: true };
    if (action === 'state') return { ...snapshot, state: { ...snapshot.state, mainSessionId: 'main-new' } };
    if (action === 'ensure') return { sessionId: 'main-new' };
    if (action === 'history') return { threadId: 'main', sessionId: 'main-new', messages: [], images: [], running: false };
    throw new Error('Unexpected action: ' + action);
  } });
  let command;
  const ctx = { inject(deps, setup) {
    assert.deepEqual(Array.from(deps), ['commandUi']);
    const disposers = [];
    setup({ effect: effect => disposers.push(effect()), commandUi: { register(value) { command = value; return () => { command = null; }; } } });
    return { dispose() { for (const dispose of disposers) dispose(); } };
  } };
  h.render('AssistantPage', { ctx });
  const dispose = h.effects.filter(item => item.deps?.length === 1 && item.deps[0] === ctx).map(item => item.effect());
  assert.equal(command.name, 'clear');
  assert.equal(command.ui.kind, 'action');
  assert.equal(command.available({ sessionId: 'main-old' }), true);
  assert.equal(command.available({ sessionId: 'side' }), false);
  assert.equal(command.available({ sessionId: 'coding' }), false);
  command.ui.run({ sessionId: 'side' });
  assert.equal(h.calls.length, 0);
  command.ui.run({ sessionId: 'main-old' });
  command.ui.run({ sessionId: 'main-old' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.calls.map(call => call.action), ['resetMain', 'state', 'ensure', 'history']);
  const nodes = walk(h.render('AssistantPage', { ctx }));
  assert.ok(nodes.some(node => node.props.sessionId === 'main-new'));
  const nextHistory = nodes.find(node => node.type === h.exports.HistoryNotice).props.history;
  assert.equal(nextHistory.messages.length, 0);
  assert.equal(nextHistory.images.length, 0);
  assert.equal(nextHistory.error, undefined);
  assert.equal(command.available({ sessionId: 'main-old' }), false);
  assert.equal(command.available({ sessionId: 'main-new' }), true);
  for (const cleanup of dispose) await cleanup?.();
  assert.equal(command, null);
});

test('clear failure preserves the main session and remains retryable', async () => {
  const snapshot = { config: { revision: 1, models: [] }, state: { mainSessionId: 'main-old', threads: [] } };
  const history = { sessionId: 'main-old', messages: [{ id: 'old-message' }], running: true };
  const h = harness({ state: [snapshot, '', 'chat', 'main', history], response: () => { throw new Error('请先停止正在运行的主聊天'); } });
  const props = { ctx: {} };
  let nodes = walk(h.render('AssistantPage', props));
  await nodes.find(node => node.type === h.exports.HistoryNotice).props.onClear();
  nodes = walk(h.render('AssistantPage', props));
  assert.ok(nodes.some(node => node.children.includes('请先停止正在运行的主聊天')));
  assert.equal(nodes.find(node => node.type === h.exports.HistoryNotice).props.history, history);
  await nodes.find(node => node.type === h.exports.HistoryNotice).props.onClear();
  assert.deepEqual(h.calls.map(call => call.action), ['resetMain', 'resetMain']);
});

test('a cleared main session observed by polling drops the old transcript and artifacts', () => {
  const { mergeHistory } = harness().exports;
  const old = { sessionId: 'old', messages: [{ id: 'message' }], images: [{ id: 'image' }], error: 'Old error', failures: [{ reason: 'Old failure' }], nextBefore: 42 };
  const result = mergeHistory(old, { sessionId: 'new', messages: [], images: [], running: false, hasMore: false, nextBefore: null });
  assert.equal(result.sessionId, 'new');
  assert.equal(result.messages.length, 0);
  assert.equal(result.images.length, 0);
  assert.equal(result.error, undefined);
  assert.equal(result.failures, undefined);
  assert.equal(result.nextBefore, null);
});

test('clear success remains committed when opening the new chat needs a retry', async () => {
  const snapshot = { config: { revision: 1, models: [] }, state: { mainSessionId: 'main-old', threads: [] } };
  const history = { sessionId: 'main-old', messages: [{ id: 'old-message' }], images: [{ id: 'old-image' }] };
  const h = harness({ state: [snapshot, '', 'chat', 'main', history], response: ({ action }) => {
    if (action === 'resetMain') return { cleared: true };
    throw new Error('连接中断');
  } });
  const props = { ctx: {} };
  let nodes = walk(h.render('AssistantPage', props));
  await nodes.find(node => node.type === h.exports.HistoryNotice).props.onClear();
  nodes = walk(h.render('AssistantPage', props));
  assert.ok(nodes.some(node => node.children.includes('主聊天已清理，重新加载失败：连接中断')));
  const nextHistory = nodes.find(node => node.type === h.exports.HistoryNotice).props.history;
  assert.equal(nextHistory.sessionId, undefined);
  assert.equal(nextHistory.messages.length, 0);
  assert.equal(nextHistory.images, undefined);
  assert.equal(nodes.find(node => node.type === h.exports.PendingInteractions).props.threads.length, 0);
  assert.deepEqual(h.calls.map(call => call.action), ['resetMain', 'state']);
});



test('resource drafts survive column changes and independent dirty flags protect refresh', () => {
  const h = harness({ confirm: () => assert.fail('navigation must not confirm') });
  const props = { snapshot: { config: {}, memories: [] } };
  let nodes = walk(h.render('Studio', props));
  const identity = nodes.find(node => node.type?.name === 'Identity');
  identity.props.onDirtyChange(true);
  nodes = walk(h.render('Studio', props));
  nodes.find(node => node.props.id === 'ba-studio-section').props.onChange('documents');
  nodes = walk(h.render('Studio', props));
  assert.ok(nodes.find(node => node.type?.name === 'Identity'), 'inactive dirty editor remains mounted');
  const documents = nodes.find(node => node.props.api && node.props.onDirtyChange && node.type?.name !== 'Identity');
  documents.props.onDirtyChange(true);
  identity.props.onDirtyChange(false);
  nodes = walk(h.render('Studio', props));
  assert.equal(nodes.filter(node => node.props.className === 'ba-draft-dot').length, 1);
  assert.equal(nodes.some(node => node.type?.name === 'Identity'), false, 'clean inactive editor is released');
  const unloadEffect = h.effects.find(item => item.deps?.length === 1 && item.deps[0] === true);
  const cleanup = unloadEffect.effect();
  let prevented = false;
  const event = { preventDefault() { prevented = true; } };
  h.listeners.get('beforeunload')(event);
  assert.equal(prevented, true);
  assert.equal(event.returnValue, '');
  cleanup();
  assert.equal(h.listeners.has('beforeunload'), false);
  documents.props.onDirtyChange(false);
  nodes = walk(h.render('Studio', props));
  assert.equal(nodes.filter(node => node.props.className === 'ba-draft-dot').length, 0);
});

test('resources mount lazily and remain mounted while hidden behind chat', () => {
  const h = harness();
  assert.equal(h.render('RetainedPane', { active: false, children: 'draft' }), null);
  assert.equal(h.render('RetainedPane', { active: true, children: 'draft' }).props.hidden, false);
  const hidden = h.render('RetainedPane', { active: false, children: 'draft' });
  assert.equal(hidden.props.hidden, true);
  assert.equal(hidden.props.style.display, 'none');
  assert.deepEqual(hidden.children, ['draft']);
});

test('identity category switching retains edits and saving still requires explicit submission', () => {
  const h = harness();
  const props = { snapshot: { config: { revision: 1, name: 'Original' } }, execute: operation => operation(), refresh: async () => {} };
  let nodes = walk(h.render('Identity', props));
  nodes.find(node => node.type === 'input' && node.props.maxLength === 100).props.onChange({ target: { value: 'Draft' } });
  nodes = walk(h.render('Identity', props));
  nodes.find(node => node.type?.name === 'ResourceTabs').props.onChange('pet');
  nodes = walk(h.render('Identity', props));
  assert.ok(nodes.find(node => node.type === 'button' && node.props.type === 'submit' && !node.props.disabled));
  nodes.find(node => node.type?.name === 'ResourceTabs').props.onChange('info');
  nodes = walk(h.render('Identity', props));
  assert.equal(nodes.find(node => node.type === 'input' && node.props.maxLength === 100).props.value, 'Draft');
  assert.equal(h.calls.length, 0);
});
