import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { groupHomeActivity, activityLabels } from '../client/activity-data.mjs';
import { quietChatRows } from '../client/quiet-chat.mjs';
import * as petState from '../client/pet-state.mjs';

const { transformSync, buildSync } = createRequire(new URL('../../benchgo/package.json', import.meta.url))('esbuild');
const navigationBundle = buildSync({ entryPoints: [fileURLToPath(new URL('../client/reply-file-navigation.mjs', import.meta.url))],
  bundle: true, write: false, format: 'cjs', platform: 'browser', external: ['@deepseek-ai/*', '../../link/client/resource-navigation-store.mjs'],
  alias: { '@deepseek-ai/dsh-util-workspace-path': fileURLToPath(new URL('../../../deepseek-harness/packages/util/workspace-path/src/index.ts', import.meta.url)) } });
function navigationExports(openRemoteResource = () => assert.fail('unexpected remote navigation')) {
  const module = { exports: {} };
  runInNewContext(navigationBundle.outputFiles[0].text, { module, exports: module.exports, require: id => {
    assert.equal(id, '../../link/client/resource-navigation-store.mjs');
    return { openRemoteResource };
  } });
  return module.exports;
}
const { createReplyFileOpener } = navigationExports();
const homeCode = transformSync(readFileSync(new URL('../client/home.jsx', import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs' }).code;
const conversationCode = transformSync(readFileSync(new URL('../client/conversation.jsx', import.meta.url), 'utf8') + '\nexport { FixedChatView, OfficialConversation };', { loader: 'jsx', format: 'cjs' }).code;
function load(code, context = null, activity = { rows: [], error: '', loading: false }) {
  const react = { createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(value => value != null && value !== false) }), useRef: () => ({ current: null }), useState: value => [value, () => {}], createContext: () => ({}), useContext: () => context };
  const module = { exports: {} };
  react.useEffect = () => {};
  react.useMemo = read => read();
  react.useSyncExternalStore = (subscribe, snapshot) => snapshot();
  runInNewContext(code, { module, exports: module.exports, document: { baseURI: 'https://bench.example/' }, require: id => {
    if (id.endsWith('/ui/button.jsx')) return { Button: 'button' };
    if (id.endsWith('/ui/collapsible.jsx')) return { Disclosure: 'Disclosure' };
    if (id === 'react') return react;
    if (id.endsWith('conversation-width.jsx')) return { ConversationWidth: 'NativeWidthControls' };
    if (id.endsWith('pet-state.mjs')) return petState;
    if (id.endsWith('.css')) return '';
    if (id.endsWith('activity-data.mjs')) return { groupHomeActivity, activityLabels };
    if (id.endsWith('use-activity.jsx')) return { useAssistantActivity: () => activity };
    if (id.endsWith('quiet-chat.mjs')) return { quietChatRows };
    if (id.endsWith('quiet-chat.jsx')) return { QuietChat: 'QuietChat' };
    if (id.endsWith('reply-file-navigation.mjs')) return { createReplyFileOpener };
    if (id.endsWith('home.jsx')) return { AssistantHome: 'AssistantHome' };
    return {};
  } });
  return module.exports;
}
function walk(node) { return !node || typeof node !== 'object' ? [] : [node, ...node.children.flatMap(walk)]; }
const input = { phase: 'plain', draft: '', occurrences: [] };

test('main and side conversations reuse native main width layout and width controls', () => {
  const { OfficialConversation } = load(conversationCode, { api() {} });
  let content;
  OfficialConversation({ useSession: select => select({ blank: false, running: false }), useConversation: select => select({ activeTargets: new Set(['chat']) }), renderFactorySlot: (name, props, options) => { content = { name, props, options }; return null; } });
  assert.equal(content.name, 'conversation.content');
  assert.equal(content.props.variant, 'main');
  assert.equal(content.options.slots.widthControls, 'NativeWidthControls');
  assert.equal(typeof content.options.slots.views, 'function');
});

test('execution conversations retain the official transcript and input factory without QuietChat replacement', () => {
  const { OfficialConversation } = load(conversationCode);
  let content;
  OfficialConversation({ useSession: select => select({ blank: false, running: true }), useConversation: select => select({ activeTargets: new Set(['chat']) }), renderFactorySlot: (name, props, options) => { content = { name, props, options }; return null; } });
  assert.equal(content.name, 'conversation.content');
  assert.equal(content.options.slots.views, undefined);
  assert.equal(content.props.hero, false);
});

test('starter inserts and persists an editable draft without submitting, and preserves existing drafts', () => {
  const { AssistantHome } = load(homeCode), calls = [];
  const span = { start: 0, end: 0, draftRev: 4 };
  const props = { api() {}, onOpenResources() {}, input, inputActions: { captureInsertion: () => span, insertText: (text, selection) => { calls.push({ text, selection }); return true; }, persistDraft: () => calls.push('persist'), submit: () => { throw new Error('must not send'); } } };
  const starters = tree => walk(tree).filter(node => node.type === 'button' && node.props.title?.startsWith('起草'));
  starters(AssistantHome(props))[0].props.onClick();
  assert.match(calls[0].text, /当前目标/); assert.equal(calls[0].selection, span); assert.equal(calls[1], 'persist');
  const withDraft = walk(AssistantHome({ ...props, input: { ...input, draft: 'Keep this' } })).filter(node => node.type === 'button' && node.props.title?.includes('当前草稿'));
  assert.equal(withDraft.length, 3); assert(withDraft.every(node => node.props.disabled));
  withDraft[0].props.onClick(); assert.equal(calls.length, 2);
});

test('a rejected revision-guarded insertion does not persist or submit', () => {
  const { AssistantHome } = load(homeCode); let persisted = false;
  const tree = AssistantHome({ api() {}, onOpenResources() {}, input, inputActions: { captureInsertion: () => ({}), insertText: () => false, persistDraft: () => { persisted = true; } } });
  walk(tree).find(node => node.type === 'button' && node.props.title?.startsWith('起草')).props.onClick();
  assert.equal(persisted, false);
});

test('home yields to existing, running and loading conversations while rendering only the controlled chat projection', () => {
  const { FixedChatView } = load(conversationCode, { api() {} });
  const base = { blank: true, awaitingFirstTurn: true, running: false, promptAttempted: false, openState: 'open' };
  const render = (session = base, activeTargets = new Set()) => walk(FixedChatView({ useSession: selector => selector(session), useConversation: selector => selector({ activeTargets }), useInput: selector => selector(input), inputActions: {}, renderSlot: () => ({ type: 'official', props: {}, children: [] }) }));
  assert(render().some(node => node.type === 'AssistantHome'));
  for (const session of [{ ...base, blank: false, awaitingFirstTurn: false }, { ...base, running: true }, { ...base, openState: 'loading' }, { ...base, promptAttempted: true }]) {
    const nodes = render(session); assert(!nodes.some(node => node.type === 'AssistantHome')); assert(nodes.some(node => node.type === 'QuietChat')); assert(!nodes.some(node => node.type === 'official'));
  }
  assert(!render(base, new Set(['chat'])).some(node => node.type === 'AssistantHome'));
});

test('real FixedChatView opens local files through the Sidebar using the latest session cwd and source line', async () => {
  let cwd = 'E:/workspace', current = 'E:/workspace/first', connected = true, mounted = 'session id';
  const opened = [], ctx = {
    sessions: { list: { getSnapshot: () => ({ byId: { 'session id': { cwd } } }) },
      binding: id => { assert.equal(id, 'session id'); return connected ? { session: { projections: { faceOf: key => {
        assert.equal(key, 'workingDirectory'); return { getSnapshot: () => current };
      } } } } : undefined; } },
    sidebarRight: { mounted: { getSnapshot: () => mounted }, openResource: (...args) => opened.push(args) },
  };
  const { FixedChatView } = load(conversationCode, { ctx, sessionId: 'session id', api() {} });
  const nodes = walk(FixedChatView({ useSession: select => select({ openState: 'open', blank: false }),
    useConversation: select => select({ activeTargets: new Set(['chat']) }), useInput: select => select(input), inputActions: {},
    openFile: () => { throw Error('views has no native openFile prop'); } }));
  const open = nodes.find(node => node.type === 'QuietChat').props.onOpenFile;
  assert.equal(typeof open, 'function');
  await open('notes.txt', { line: 24 });
  assert.equal(opened[0][0], 'dsh-resource://file/session/session%20id/first/notes.txt');
  assert.equal(opened[0][1].params.line, 24);
  current = 'E:/workspace/second';
  await open('notes.txt');
  assert.deepEqual(opened[1], ['dsh-resource://file/session/session%20id/second/notes.txt']);
  cwd = 'F:/new-root'; current = undefined;
  await open('notes.txt');
  assert.deepEqual(opened[2], ['dsh-resource://file/session/session%20id/notes.txt']);
  await open('C:/outside/a b.txt', { line: 7 });
  assert.equal(opened[3][0], 'dsh-resource://file/session/session%20id/C:/outside/a%20b.txt');
  assert.equal(opened[3][1].params.line, 7);
  mounted = 'another session';
  await assert.rejects(open('notes.txt'), /回到该聊天/);
  assert.equal(opened.length, 4, 'a stale file action cannot open into the next chat');
  mounted = 'session id';
  connected = false;
  await assert.rejects(open('notes.txt'), /当前会话尚未连接/);
  assert.doesNotMatch(navigationBundle.outputFiles[0].text, /require\(["']@deepseek-ai\/dsh-util-workspace-path/);
});

test('local delivery keeps its unavailable fallback when native Sidebar navigation is absent', () => {
  assert.equal(createReplyFileOpener({}, 'session'), undefined);
  const { FixedChatView } = load(conversationCode, { ctx: {}, sessionId: 'session', api() {} });
  const nodes = walk(FixedChatView({ useSession: select => select({ openState: 'open', blank: false }),
    useConversation: select => select({ activeTargets: new Set(['chat']) }), useInput: select => select(input), inputActions: {} }));
  assert.equal(nodes.find(node => node.type === 'QuietChat').props.onOpenFile, undefined);
});

function replyWorkspace() {
  const state = { mounted: 'router', cwd: 'E:/workspace', directory: 'E:/workspace/initial' }, opened = [];
  const ctx = {
    sidebarRight: { mounted: { getSnapshot: () => state.mounted }, openResource: (...args) => opened.push(args) },
    sessions: {
      list: { getSnapshot: () => ({ byId: { router: { cwd: state.cwd } } }) },
      binding: () => ({ session: { projections: { faceOf: () => ({ getSnapshot: () => state.directory }) } } }),
    },
  };
  return { state, ctx, opened };
}
const remoteSource = { remote: true, available: true, deviceId: 'device-b', hostId: 'host-b', authorizationId: 'auth-b',
  sessionId: 'worker-session', ownerHostId: 'host-a', taskId: 'task-a', executionId: 'execution-b' };

test('FixedChatView resolves reply provenance with its actual thread and uses the latest local cwd after verification', async () => {
  const f = replyWorkspace(), calls = [];
  let release;
  const home = { ctx: f.ctx, sessionId: 'router', threadId: 'thread-a', api: async (...args) => {
    calls.push(args); return new Promise(resolve => { release = resolve; });
  } };
  const { FixedChatView } = load(conversationCode, home);
  const nodes = walk(FixedChatView({ useSession: select => select({ openState: 'open', blank: false }),
    useConversation: select => select({ activeTargets: new Set(['chat']) }), useInput: select => select(input), inputActions: {} }));
  const open = nodes.find(node => node.type === 'QuietChat').props.onOpenFile;
  const pending = open('notes.txt', { requestId: 'reply-a', line: 12 });
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['replyFileSource', { threadId: 'thread-a', sessionId: 'router', requestId: 'reply-a' }]]);
  assert.equal(f.opened.length, 0);
  f.state.directory = 'E:/workspace/current';
  release({ remote: false }); await pending;
  assert.equal(f.opened[0][0], 'dsh-resource://file/session/router/current/notes.txt');
  assert.equal(f.opened[0][1].params.line, 12);
  await open('E:/verified/artifact.md');
  assert.equal(calls.length, 1, 'verified artifact paths without reply IDs avoid provenance requests');
  assert.equal(f.opened[1][0], 'dsh-resource://file/session/router/E:/verified/artifact.md');
});

test('remote reply files retain execution, device and line identity and never use the local workspace', async () => {
  const f = replyWorkspace(), remote = [];
  const { createReplyFileOpener } = navigationExports(async (input, options) => remote.push({ input, options }));
  const open = createReplyFileOpener(f.ctx, 'router', { threadId: 'thread-a', api: async () => remoteSource });
  await open('/b/output/report.md', { requestId: 'reply-a', line: 32 });
  assert.deepEqual(JSON.parse(JSON.stringify(remote[0].input)), {
    device: { id: 'device-b', hostId: 'host-b', authorizationId: 'auth-b' },
    resource: { kind: 'sessions', resourceId: 'worker-session', ownerTask: { taskId: 'task-a', ownerHostId: 'host-a', executionId: 'execution-b' },
      file: { path: '/b/output/report.md', line: 32 } },
  });
  assert.equal(remote[0].options.isCurrent(), true);
  f.state.mounted = 'other';
  assert.equal(remote[0].options.isCurrent(), false, 'the remote device query retains the live mounted-session guard');
  assert.deepEqual(f.opened, []);
});

test('reply file source failures never fall back to a same-name local path', async () => {
  for (const [api, threadId, requestId, expected] of [
    [undefined, 'thread-a', 'reply-a', /尚未核实/],
    [async () => ({ remote: false }), undefined, 'reply-a', /尚未核实/],
    [async () => ({ remote: false }), 'thread-a', '', /尚未核实/],
    [async () => ({ remote: false }), 'thread-a', null, /尚未核实/],
    [async () => { throw Error('来源读取失败'); }, 'thread-a', 'reply-a', /来源读取失败/],
    [async () => undefined, 'thread-a', 'reply-a', /无法核实/],
    [async () => ({ remote: 'true' }), 'thread-a', 'reply-a', /无法核实/],
    [async () => ({ ...remoteSource, available: false, reason: '远端已离线' }), 'thread-a', 'reply-a', /远端已离线/],
    [async () => ({ ...remoteSource, authorizationId: '' }), 'thread-a', 'reply-a', /远端执行暂不可用/],
    [async () => ({ ...remoteSource, executionId: undefined }), 'thread-a', 'reply-a', /远端执行暂不可用/],
  ]) {
    const f = replyWorkspace();
    const open = createReplyFileOpener(f.ctx, 'router', { api, threadId });
    await assert.rejects(open('/same-name/output.md', { requestId }), expected);
    assert.deepEqual(f.opened, []);
  }
});

test('switching chats before or during source resolution suppresses stale file navigation', async () => {
  const f = replyWorkspace(); let release, calls = 0;
  const open = createReplyFileOpener(f.ctx, 'router', { threadId: 'thread-a', api: () => {
    calls++; return new Promise(resolve => { release = resolve; });
  } });
  f.state.mounted = 'other';
  await assert.rejects(open('output.md', { requestId: 'reply-a' }), /回到该聊天/);
  assert.equal(calls, 0);
  for (const source of [{ remote: false }, remoteSource]) {
    f.state.mounted = 'router';
    const pending = open('output.md', { requestId: 'reply-a' });
    f.state.mounted = 'other'; release(source);
    await assert.rejects(pending, /回到该聊天/);
  }
  assert.deepEqual(f.opened, []);
});
