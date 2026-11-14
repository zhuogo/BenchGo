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
  bundle: true, write: false, format: 'cjs', platform: 'browser', external: ['@deepseek-ai/*'],
  alias: { '@deepseek-ai/dsh-util-workspace-path': fileURLToPath(new URL('../../../deepseek-harness/packages/util/workspace-path/src/index.ts', import.meta.url)) } });
const navigationModule = { exports: {} };
runInNewContext(navigationBundle.outputFiles[0].text, { module: navigationModule, exports: navigationModule.exports });
const { createReplyFileOpener } = navigationModule.exports;
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
  let cwd = 'E:/workspace', current = 'E:/workspace/first', connected = true;
  const opened = [], ctx = {
    sessions: { list: { getSnapshot: () => ({ byId: { 'session id': { cwd } } }) },
      binding: id => { assert.equal(id, 'session id'); return connected ? { session: { projections: { faceOf: key => {
        assert.equal(key, 'workingDirectory'); return { getSnapshot: () => current };
      } } } } : undefined; } },
    sidebarRight: { openResource: (...args) => opened.push(args) },
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
