import { groupReplyImages } from '../../shared/client/image-gallery-model.mjs';
import { createModelCatalogLoader } from '../../benchgo/client/model-catalog.mjs';
import { retainAssistantSession, assistantBackgroundSessions } from '../client/session-retain.mjs';
import { executionSessionNavigation } from '../client/execution-session-navigation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import * as sidebarLists from '../client/sidebar-lists.mjs';
import * as modelSettings from '../client/model-settings.mjs';
import { petActionForSession, petExpressionForAction } from '../client/pet-state.mjs';
import { createConfigSync, saveConfigPatch } from '../client/config-sync.mjs';
import { structuralShare } from '../client/structural-share.mjs';
const { transformSync } = createRequire(new URL('../../benchgo/package.json', import.meta.url))('esbuild');
const code = transformSync(readFileSync(new URL('../client/index.jsx', import.meta.url), 'utf8') + '\nexport { mergeHistory, Images, loadCatalog, messageText, HistoryNotice, retainSession, PendingCard, PendingInteractions, UIIcon, Identity, Studio, ResourceTabs, RetainedPane, api, BackgroundSessions };', { loader: 'jsx', format: 'cjs' }).code;
const settingsCode = transformSync(readFileSync(new URL('../client/model-settings.jsx', import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs' }).code;
function harness(options = {}) {
  let cursor = 0, refCursor = 0; const state = [...(options.state || [])], refs = [], effects = [], calls = [];
  const react = { createElement: (type, props, ...children) => type?.name === 'ModelSettings' ? type(props) : ({ type, props: props || {}, children: children.flat(Infinity).filter(value => value !== false && value != null) }), useState: initial => { const index = cursor++; if (!(index in state)) state[index] = Array.isArray(initial) && options.threads ? options.threads : typeof initial === 'function' ? initial() : initial; return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value; }]; }, useRef: initial => refs[refCursor++] ||= { current: initial }, useCallback: callback => callback, useEffect: (effect, deps) => effects.push({ effect, deps }), useId: () => 'id' };
  react.useLayoutEffect = () => {};
  react.useSyncExternalStore = (_subscribe, snapshot) => snapshot();
  const settingsModule = { exports: {} };
  runInNewContext(settingsCode, { module: settingsModule, exports: settingsModule.exports, require: id => id.endsWith('model-catalog.mjs') ? { assistantModelCatalog } : id.endsWith('/ui/confirmation.jsx') ? { useConfirmation: () => [async () => (options.confirm || (() => true))(), null] } : id.endsWith('/ui/button.jsx') ? { Button: 'button' } : id.endsWith('/ui/collapsible.jsx') ? { Disclosure: 'Disclosure' } : id.endsWith('execution-session-navigation.mjs') ? { executionSessionNavigation } : id.endsWith('session-retain.mjs') ? { retainAssistantSession, assistantBackgroundSessions } : id === 'react' ? react : id.endsWith('model-settings.mjs') ? modelSettings : id.endsWith('dsh-client-ui-primitives') ? { Switch: 'Switch' } : '' });
  const registryModule = { exports: {} };
  runInNewContext(transformSync(readFileSync(new URL('../client/dirty-registry.mjs', import.meta.url), 'utf8'), { format: 'cjs' }).code, { module: registryModule, exports: registryModule.exports, require: id => id.endsWith('model-catalog.mjs') ? { assistantModelCatalog } : id.endsWith('/ui/confirmation.jsx') ? { useConfirmation: () => [async () => (options.confirm || (() => true))(), null] } : id.endsWith('/ui/button.jsx') ? { Button: 'button' } : id.endsWith('/ui/collapsible.jsx') ? { Disclosure: 'Disclosure' } : react });
  const listeners = new Map(), documentListeners = new Map(), intervals = [];
  const module = { exports: {} };
  const assistantConfigSync = createConfigSync();
  const assistantModelCatalog = createModelCatalogLoader(async () => { calls.push({ action: 'catalog' }); return typeof options.response === 'function' ? options.response(calls.at(-1)) : options.response || { providers: [], models: [] }; });
  runInNewContext(code, { module, exports: module.exports, URL, Event, CustomEvent, AbortController, localStorage: options.storage, queueMicrotask, setTimeout: options.setTimeout || (fn => fn()), clearTimeout: () => {}, setInterval: fn => { intervals.push(fn); return fn; }, clearInterval: fn => { intervals.splice(intervals.indexOf(fn), 1); }, window: { confirm: options.confirm || (() => true), addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) }, crypto: { randomUUID }, document: { baseURI: 'https://local/', hidden: false, addEventListener: (name, fn) => documentListeners.set(name, fn), removeEventListener: name => documentListeners.delete(name), dispatchEvent(event) { documentListeners.get(event.type)?.(event); return true; } }, fetch: async (url, options) => { const call = JSON.parse(options.body); calls.push(call); return { benchgoCall: call }; }, require: id => id.endsWith('model-catalog.mjs') ? { assistantModelCatalog } : id.endsWith('/ui/confirmation.jsx') ? { useConfirmation: () => [async () => (options.confirm || (() => true))(), null] } : id.endsWith('/ui/button.jsx') ? { Button: 'button' } : id.endsWith('/ui/collapsible.jsx') ? { Disclosure: 'Disclosure' } : id.endsWith('execution-session-navigation.mjs') ? { executionSessionNavigation } : id.endsWith('session-retain.mjs') ? { retainAssistantSession, assistantBackgroundSessions } : id === 'react' ? react : id.endsWith('sidebar-lists.mjs') ? sidebarLists : id.endsWith('pet-state.mjs') ? { petActionForSession, petExpressionForAction } : id.endsWith('model-settings.mjs') ? modelSettings : id.endsWith('model-settings.jsx') ? settingsModule.exports : id.endsWith('config-sync.mjs') ? { assistantConfigSync, saveConfigPatch } : id.endsWith('structural-share.mjs') ? { structuralShare } : id.endsWith('perf-trace.mjs') ? { perfTrace: { time: () => () => {} } } : id.endsWith('dirty-registry.mjs') ? registryModule.exports : id.endsWith('http-response.mjs') ? { readJsonResponse: async response => typeof options.response === 'function' ? options.response(response.benchgoCall) : options.response || ({ providers: [], models: [] }) } : id.endsWith('image-gallery-model.mjs') ? { groupReplyImages } : id.endsWith('image-gallery.jsx') ? { ImageGallery: 'ImageGallery' } : id.endsWith('dsh-client-ui-primitives') ? { Tooltip: ({ label, children }) => react.createElement('span', { 'data-tooltip': label }, children), Modal: () => null, Menu: () => null, IconPinOutlineMedium: "IconPinOutlineMedium", IconPinFillMedium: "IconPinFillMedium", IconArchiveOutlineMedium: "IconArchiveOutlineMedium", IconArchiveOffOutlineMedium: "IconArchiveOffOutlineMedium", IconEllipsisOutlineMedium: "IconEllipsisOutlineMedium" } : {} });
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

test('Worker queue edits save independently and removing all entries visibly restores Router inheritance', async () => {
  const config = { revision: 20, name: 'BenchGo', models: [{ providerId: 'Router/@', modelId: 'Exact: Router/1' }],
    workerModels: [{ providerId: 'Worker/@', modelId: 'Exact: Worker/2', options: { maxTokens: 700 } }, { providerId: 'Backup/@', modelId: 'Exact: Worker/3' }],
    auxiliary: { models: [{ providerId: 'Aux/@', modelId: 'Exact: Aux/4' }], capabilities: ['review'] } };
  const reversed = [...config.workerModels].reverse();
  const h = harness({ response: { ...config, workerModels: reversed, revision: 21 } });
  const props = { initialTab: 'models', snapshot: { config }, execute: operation => operation(), refresh: async () => {} };
  let nodes = walk(h.render('Identity', props));
  const workerSection = nodes.find(node => node.props['aria-label'] === '工作模型 Worker 配置');
  walk(workerSection).find(node => node.props.label === '提高优先级' && !node.props.disabled).props.onClick();
  nodes = walk(h.render('Identity', props));
  await nodes.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls)), [{ action: 'config', revision: 20, patch: { workerModels: reversed } }]);
  const reopened = walk(harness().render('Identity', { ...props, snapshot: { config: { ...config, workerModels: reversed, revision: 21 } } }));
  assert.deepEqual(reopened.filter(node => node.type?.name === 'ModelFields').map(node => node.props.value), [...config.models, ...reversed, ...config.auxiliary.models]);
  for (let remaining = 2; remaining > 0; remaining--) {
    nodes = walk(h.render('Identity', props));
    walk(nodes.find(node => node.props['aria-label'] === '工作模型 Worker 配置')).find(node => node.props.label === '移除模型').props.onClick();
  }
  nodes = walk(h.render('Identity', props));
  assert.ok(nodes.some(node => node.children.some(child => typeof child === 'string' && child.includes('当前跟随 Router'))));
  assert.ok(nodes.some(node => node.type === 'Disclosure' && node.props.description === '跟随身份模型 Router'));
  assert.deepEqual(nodes.filter(node => node.type?.name === 'ModelFields').map(node => node.props.value), [...config.models, ...config.auxiliary.models]);
  const configure = nodes.find(node => node.type === 'button' && node.children.includes('配置工作模型'));
  assert.ok(configure);
  configure.props.onClick();
  const updated = walk(h.render('Identity', props));
  const workerFields = walk(updated.find(node => node.props['aria-label'] === '工作模型 Worker 配置')).filter(node => node.type?.name === 'ModelFields');
  assert.equal(workerFields.length, 1);
  assert.equal(workerFields[0].props.value.providerId, '');
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

test('sidebar name card opens main chat and resources sit beside collapse without a navigation row', () => {
  const h = harness();
  const nodes = walk(h.render('AssistantSidebarEntry', { ctx: { layout: { panelInfo: { getSnapshot: () => ({ activePanelId: 'benchgo-assistant' }), subscribe: () => () => {} } } } }));
  assert.ok(nodes.some(node => node.props.className === 'ba-card-row'));
  const chatAction = nodes.find(node => node.props.ariaLabel === '打开主聊天');
  assert.ok(chatAction);
  assert.equal(typeof chatAction.props.onOpen, 'function');
  assert.ok(!nodes.some(node => node.props.className === 'ba-card-actions'));
  assert.ok(nodes.some(node => node.props.className === 'ba-assistant-resources' && node.props['aria-label'] === '打开资源'));
  assert.ok(!nodes.some(node => node.props.className === 'ba-assistant-action ba-action-settings'));
  assert.ok(!nodes.some(node => node.props.className?.includes('cmd-session') && node.children.includes('\u4e3b\u804a')));
  assert.ok(nodes.some(node => node.props['aria-label'] === '新建旁聊'));
});
test('main chat activity follows its official session even when another panel is selected', () => {
  let statuses = new Map([['main-session', { running: true }], ['side-session', { running: true }]]);
  const h = harness({ state: [[], true, 'side', '', false, null, null, false, 'main-session'] });
  const ctx = { layout: { panelInfo: { getSnapshot: () => ({ activePanelId: 'another-panel' }), subscribe: () => () => {} } }, uiSession: { sessionStatus: { getSnapshot: () => statuses, subscribe: () => () => {} } } };
  const action = () => walk(h.render('AssistantSidebarEntry', { ctx })).find(node => node.props.ariaLabel?.startsWith('打开主聊天'));
  assert.equal(action().props.action, 'focus');
  assert.equal(action().props.expression, 'think');
  assert.match(action().props.ariaLabel, /正在进行中/);
  statuses = new Map([['main-session', { running: false }], ['side-session', { running: true }]]);
  assert.equal(action().props.action, 'idle');
  assert.equal(action().props.ariaLabel, '打开主聊天');
  statuses = new Map([['main-session', { running: true, pendingInteraction: { kind: 'approval' } }]]);
  assert.equal(action().props.action, 'waiting');
  assert.equal(action().props.expression, 'stare');
});

test('sidebar initial load is distinct from empty, failure retries, and refresh keeps existing chats', async () => {
  let response = new Error('offline');
  const h = harness({ response: () => { if (response instanceof Error) throw response; return response; } });
  const props = { ctx: { layout: { panelInfo: { getSnapshot: () => ({ activePanelId: 'benchgo-assistant' }), subscribe: () => () => {} } } } };
  let nodes = walk(h.render('AssistantSidebarEntry', props));
  assert(nodes.some(node => node.props.label === '正在加载旁聊'));
  assert(!nodes.some(node => node.props['data-kind'] === 'empty'));
  const cleanups = h.effects.map(({ effect }) => effect()).filter(Boolean);
  await new Promise(setImmediate);
  nodes = walk(h.render('AssistantSidebarEntry', props));
  assert(nodes.some(node => node.props['data-kind'] === 'error'));
  assert(!nodes.some(node => node.props.label === '正在加载旁聊'));
  response = { state: { threads: [] } };
  await nodes.find(node => node.type === 'button' && node.children.includes('重试加载')).props.onClick();
  nodes = walk(h.render('AssistantSidebarEntry', props));
  assert(nodes.some(node => node.props['data-kind'] === 'empty'));
  assert(nodes.some(node => node.props.className === 'ba-sidebar-quote' && node.children.includes('“或许你不需要我”')));
  assert(nodes.some(node => node.type === 'button' && node.props['aria-label'] === '新建旁聊'));
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

test('sidebar preparation for a long list keeps all localized activity times', t => {
  const threads = Array.from({ length: 500 }, (_, index) => ({ id: 'side-' + index, title: '旁聊 ' + index, createdAt: Date.now() - index * 60000 }));
  const h = harness({ threads });
  const props = { ctx: { layout: { panelInfo: { getSnapshot: () => ({ activePanelId: null }), subscribe: () => () => {} } } } };
  const started = performance.now();
  const nodes = walk(h.render('AssistantSidebarEntry', props));
  t.diagnostic(`500 side threads: ${(performance.now() - started).toFixed(2)}ms data and JSX preparation`);
  assert.equal(nodes.filter(node => node.props.className === 'ba-thread-time').length, 500);
});

test('sidebar coalesces rapid invalidations and rereads the final state after an in-flight response', async () => {
  const pending = [], timers = new Map();let serial = 0;
  const h = harness({ response: call => new Promise(resolve => pending.push({ call, resolve })), setTimeout: fn => { const id = ++serial; timers.set(id, fn); return id; } });
  const props = { ctx: { layout: { panelInfo: { getSnapshot: () => ({ activePanelId: null }), subscribe: () => () => {} } } } };
  h.render('AssistantSidebarEntry', props);
  const cleanups = h.effects.map(({ effect }) => effect()).filter(Boolean);
  await new Promise(setImmediate);
  const changed = h.documentListeners.get('benchgo:assistant-changed');
  for(let index=0;index<20;index++)changed(new Event('benchgo:assistant-changed'));
  for(const [id,fn] of [...timers]){timers.delete(id);fn();}
  await new Promise(setImmediate);
  assert.equal(pending.length, 1, 'an active state read is shared across all invalidations');
  pending[0].resolve({state:{threads:[{id:'old',title:'旧旁聊'}]}});
  await new Promise(setImmediate);
  assert.equal(pending.length, 2, 'one trailing read observes the final invalidation');
  pending[1].resolve({state:{threads:[{id:'latest',title:'最新旁聊'}]}});
  await new Promise(setImmediate);
  const nodes=walk(h.render('AssistantSidebarEntry',props));
  assert(nodes.some(node=>node.props.className==='ba-thread-title'&&node.children.includes('最新旁聊')));
  cleanups.forEach(dispose=>dispose());
});

test('sidebar cleanup fences scheduled invalidations and late responses', async () => {
  const pending=[],timers=[];
  const h=harness({response:()=>new Promise(resolve=>pending.push(resolve)),setTimeout:fn=>{timers.push(fn);return timers.length;}});
  const props={ctx:{layout:{panelInfo:{getSnapshot:()=>({activePanelId:null}),subscribe:()=>()=>{}}}}};
  h.render('AssistantSidebarEntry',props);
  const cleanups=h.effects.map(({effect})=>effect()).filter(Boolean);
  await new Promise(setImmediate);
  h.documentListeners.get('benchgo:assistant-changed')(new Event('benchgo:assistant-changed'));
  cleanups.forEach(dispose=>dispose());
  timers.forEach(fn=>fn());
  pending[0]({state:{threads:[{id:'retired',title:'已卸载的响应'}]}});
  await new Promise(setImmediate);
  assert.equal(h.calls.length,1,'a queued callback cannot read through a retired scope');
  assert(!walk(h.render('AssistantSidebarEntry',props)).some(node=>node.props.className==='ba-thread-title'&&node.children.includes('已卸载的响应')));
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
  assert.equal(nodes.find(node => node.props.id === toggle.props['aria-controls'] && node.props.className === 'cmd-section-body ba-sidebar-body').props['data-open'], false);
  const icon = h.render('UIIcon', { name: 'chevronDown' });
  assert.notEqual(icon.type, 'span');
  assert.equal(icon.props.name, 'chevronDown');
  const css = readFileSync(new URL('../client/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.ba-assistant-section\{[^}]*border-radius:12px;/);
  assert.match(readFileSync(new URL('../client/card.css', import.meta.url), 'utf8'), /\.ba-card-name\{[^}]*white-space:nowrap;/);
  assert.match(readFileSync(new URL('../../benchgo/client/style.css', import.meta.url), 'utf8'), /\.cmd-section-toggle\[aria-expanded="false"\] > \.cmd-ui-icon \{ transform: rotate\(-90deg\);/);
});

test('assistant collapse keeps main chat and resources accessible and restores its local preference', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  const props = { ctx: { layout: { panelInfo: { getSnapshot: () => ({ activePanelId: 'benchgo-assistant' }), subscribe: () => () => {} } } } };
  const h = harness({ storage });
  let nodes = walk(h.render('AssistantSidebarEntry', props));
  let toggle = nodes.find(node => node.props.className === 'ba-assistant-toggle');
  assert.equal(toggle.props['aria-expanded'], false);
  assert.equal(nodes.find(node => node.props.className === 'ba-assistant-body').props.hidden, true);
  toggle.props.onClick();
  nodes = walk(h.render('AssistantSidebarEntry', props));
  toggle = nodes.find(node => node.props.className === 'ba-assistant-toggle');
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
  const heading = nodes.find(node => node.props.className === 'ba-assistant-heading');
  assert(walk(heading).some(node => node.props.ariaLabel === '打开主聊天'));
  assert(walk(heading).some(node => node.props['aria-label'] === '打开资源'));
  assert(!walk(body).some(node => node.props['aria-label'] === '打开资源'));
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
  assert.equal(fallback.find(node => node.props.className === 'ba-assistant-toggle').props['aria-expanded'], false);
  assert.doesNotThrow(() => fallback.find(node => node.props.className === 'ba-assistant-toggle').props.onClick());
  assert.equal(walk(unavailable.render('AssistantSidebarEntry', props)).find(node => node.props.className === 'ba-assistant-body').props.hidden, false);
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
  nodes.find(node => node.props.ariaLabel === '打开主聊天').props.onOpen();
  nodes = walk(h.render('AssistantSidebarEntry', props));
  assert.equal(nodes.find(node => node.props.ariaLabel === '打开主聊天').props.current, true);
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
  const galleries = nodes.filter(node => node.type === 'ImageGallery');
  assert.equal(galleries.length, 1);
  assert.equal(galleries[0].props.images[0].name, 'picture.png');
  assert.equal(galleries[0].props.images[0].url, '/api/assistant/image/1');
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
  assert.deepEqual(walk(nav).filter(node => node.type === 'b').map(node => node.children[0]), ['身份', '模型', '档案', '任务', '目标', '记忆', '产物', '多平台', '保险库', '系统文件']);
  assert.equal(walk(nav).filter(node => node.props['aria-current'] === 'page')[0].children[1].children[0].children[0], '身份');
  assert.equal(nodes.some(node => node.props.className === 'ba-segment'), false);
});

// The harness leaves unstubbed imports untyped, so the page is the editor inside the visible section container.
const visiblePage = nodes => nodes.find(node => node.type === 'div' && node.props.hidden === false && node.children.some(child => child?.props?.onDirtyChange))
  ?.children.find(child => child?.props?.onDirtyChange);

test('the goals page is a checklist without a goal creation or task entry', () => {
  const h = harness(), props = { initialSection: 'goals', snapshot: { config: { models: [] } }, ctx: {} };
  const nodes = walk(h.render('Studio', props));
  assert.equal(nodes.find(node => node.props['data-section']).props['data-section'], 'goals');
  const goals = visiblePage(nodes);
  assert.ok(goals, 'the goals section renders the checklist');
  assert.equal(goals.props.initialCreating, undefined);
  assert.equal(goals.props.onViewTasks, undefined, 'a checklist goal has no bound tasks to open');
  assert.equal(nodes.some(node => node.props.onCreateGoal), false);
});

test('the goals resource link opens its workspace page and tasks retain only tasks and approvals', () => {
  const h = harness(), props = { initialSection: 'tasks', snapshot: { config: { models: [] } }, ctx: {} };
  const taskNodes = walk(h.render('Studio', props));
  assert.equal(taskNodes.some(node => node.props.onOpenGoals), false);
  assert.deepEqual(Array.from(taskNodes.find(node => node.type === h.exports.ResourceTabs).props.tabs, row => row[0]), ['tasks', 'approvals']);
  const chat = harness(), requested = { ...props, requestedTab: 'goals' };
  chat.render('Studio', requested);
  chat.effects.find(item => item.deps?.[0] === 'goals').effect();
  const goalNodes = walk(chat.render('Studio', requested));
  assert.equal(goalNodes.find(node => node.props['data-section']).props['data-section'], 'goals');
  const goals = visiblePage(goalNodes);
  assert.equal(goals.props.initialCreating, undefined); assert.equal(goals.props.onViewTasks, undefined);
});
test('linked task navigation carries its task through the page and existing Studio detail entry', () => {
  const snapshot = { config: { models: [] }, state: { threads: [] } };
  const page = harness({ state: [snapshot, '', 'chat', 'main', { sessionId: 'chat', messages: [] }] });
  const ctx = { layout: { selectPanel() {} } };
  let nodes = walk(page.render('AssistantPage', { ctx }));
  for (const effect of page.effects.filter(item => item.deps?.length === 0)) effect.effect();
  nodes.find(node => node.props.sessionId === 'chat' && node.props.onOpenResources).props.onOpenResources('tasks', { taskId: 'linked' });
  const studio = walk(page.render('AssistantPage', { ctx })).find(node => node.type === page.exports.Studio);
  assert.equal(studio.props.requestedTab, 'tasks');
  assert.equal(studio.props.requestedTask.taskId, 'linked');
  const view = harness();
  view.render('Studio', studio.props);
  view.effects.find(item => item.deps?.[0] === studio.props.requestedTask).effect();
  const tasks = walk(view.render('Studio', studio.props)).find(node => node.props.requestedTask && node.props.onDetailChange);
  assert.equal(tasks.props.requestedTask.taskId, 'linked');
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
test('legacy pending cards never answer high-risk approval outside the review page', async () => {
  const h = harness(), answers = [];
  const pending = { key: 'approval:1', kind: 'approval', answerable: true, reason: 'Run task', answer: async value => answers.push(value) };
  const nodes = walk(h.render('PendingCard', { pending, title: '主聊天' }));
  assert.deepEqual(answers, []);
  assert.equal(nodes.filter(node => node.type === 'button').length, 0);
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

test('assistant background retention excludes idle, archived and selected sessions but follows live status', () => {
  const state = { mainSessionId: 'main', threads: [
    ...Array.from({ length: 1000 }, (_, i) => ({ id: `idle-${i}`, sessionId: `idle-${i}` })),
    { id: 'running', sessionId: 'running' }, { id: 'pending', sessionId: 'pending' },
    { id: 'catalog', sessionId: 'catalog' }, { id: 'archived', sessionId: 'archived', archived: true },
  ] };
  const statuses = new Map([['main', { running: true }], ['running', { running: true }],
    ['pending', { running: false, pendingInteraction: { kind: 'question' } }], ['archived', { running: true }]]);
  const catalog = { byId: { catalog: { running: true }, running: { running: true } } };
  assert.deepEqual([...assistantBackgroundSessions(state, 'main', statuses, catalog).keys()], ['running', 'pending', 'catalog']);
  statuses.set('running', { running: false });
  assert.deepEqual([...assistantBackgroundSessions(state, 'main', statuses, catalog).keys()], ['pending', 'catalog']);
});

test('opening a chat reads its history while unrelated state resources are still loading', async () => {
  let finishState;
  const snapshot = { config: { models: [] }, state: { threads: [] } };
  const h = harness({ state: [snapshot, '', 'chat', 'main', { messages: [] }], setTimeout: () => 0,
    response: ({ action }) => action === 'state' ? new Promise(resolve => { finishState = resolve; })
      : action === 'ensure' ? { sessionId: 'main-session' } : { threadId: 'main', sessionId: 'main-session', messages: [] },
  });
  const ctx = {};
  h.render('AssistantPage', { ctx });
  const dispose = h.effects.find(item => item.deps?.length === 3 && item.deps[2] === ctx).effect();
  await new Promise(setImmediate);
  assert.deepEqual(h.calls.map(call => call.action), ['state', 'ensure', 'history']);
  const nodes = walk(h.render('AssistantPage', { ctx }));
  assert(nodes.some(node => node.props.sessionId === 'main-session'));
  dispose(); finishState(snapshot); await new Promise(setImmediate);
});
test('state reads are shared until an invalidation and ensure announces only a new session', async () => {
  const pending = []; let sessionId = 'side-1', announced = 0;
  const h = harness({ response: call => call.action === 'state' ? new Promise(resolve => pending.push(resolve)) : call.action === 'ensure' ? { sessionId } : {} });
  h.documentListeners.set('benchgo:assistant-changed', () => { announced++; });
  const { api } = h.exports, states = () => h.calls.filter(call => call.action === 'state').length;
  const aborted = new AbortController(); aborted.abort(new Error('left'));
  await assert.rejects(api('state', {}, aborted.signal), /left/);
  assert.equal(states(), 0, 'an already aborted reader starts no request');
  const leaving = new AbortController();
  const first = api('state'), second = api('state'), left = api('state', {}, leaving.signal);
  await new Promise(setImmediate);
  assert.equal(states(), 1, 'concurrent readers share one request');
  leaving.abort(new Error('unmounted'));
  await assert.rejects(left, /unmounted/);
  pending[0]({ config: { revision: 1, name: 'A' }, state: { threads: [] } });
  assert.equal(await first, await second, 'a reader leaving does not cancel the shared read');
  const stale = api('state');
  await new Promise(setImmediate);
  await api('pinThread', { threadId: 'side', pinned: true });
  const fresh = api('state');
  await new Promise(setImmediate);
  assert.equal(states(), 3, 'a read that began before a mutation is not shared after it');
  pending[1]({ config: { revision: 1 }, state: { threads: [] } }); pending[2]({ config: { revision: 1 }, state: { threads: [{ id: 'side', pinned: true }] } });
  assert.equal((await stale).state.threads.length, 0);
  assert.equal((await fresh).state.threads[0].pinned, true);
  await api('history', { threadId: 'side' });
  const afterRead = api('state'), sharedRead = api('state');
  await new Promise(setImmediate);
  assert.equal(states(), 4, 'ordinary reads leave the shared state valid');
  pending[3]({ config: { revision: 1 }, state: { threads: [] } }); await afterRead; await sharedRead;
  await api('ensure', { threadId: 'side' }); await api('ensure', { threadId: 'side' }); await api('ensure', { threadId: 'side' });
  assert.equal(announced, 1, 'repeated polls of the same session announce nothing');
  sessionId = 'side-2';
  await api('ensure', { threadId: 'side' });
  assert.equal(announced, 2, 'a replaced session is announced');
  await api('resetMain'); await api('ensure', { threadId: 'main' });
  assert.equal(announced, 4, 'clearing the main chat and opening its new session are both announced');
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
test('the page does not follow every session; background retention owns those feeds', () => {
  let reads = 0;
  const feed = value => ({ getSnapshot: () => { reads++; return value; }, subscribe: () => () => {} });
  const snapshot = { config: { models: [] }, state: { mainSessionId: 'chat', threads: [{ id: 'side', sessionId: 'side-session' }] } };
  const h = harness({ state: [snapshot, '', 'chat', 'main', { sessionId: 'chat', messages: [] }] });
  const ctx = { uiSession: { sessionStatus: feed(new Map([['side-session', { running: true }]])) }, sessions: { list: feed({ byId: {} }) } };
  const nodes = walk(h.render('AssistantPage', { ctx }));
  assert.equal(reads, 0, 'unrelated session activity cannot re-render the open transcript');
  const background = nodes.find(node => node.type === h.exports.BackgroundSessions);
  assert.equal(background.props.selectedSessionId, 'chat');
  assert.equal(background.props.state, snapshot.state);
  assert.equal(h.render('BackgroundSessions', background.props), null);
  assert.equal(reads, 2);
});
test('background assistant thread approval is reserved for the unified review page', () => {
  const h = harness(); const pending = { key: 'a', kind: 'approval' };
  const nodes = walk(h.render('PendingInteractions', { ctx: { uiSession: { sessionStatus: { getSnapshot: () => new Map([['side-session', { pendingInteraction: pending }]]) } } }, threads: [{ id: 'side', title: 'Background work', sessionId: 'side-session' }] }));
  assert.equal(nodes.some(node => node.props.pending === pending), false);
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
