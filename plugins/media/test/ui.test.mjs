import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { createModuleSource } from '../../base/client/modules.mjs';
import * as settingsState from '../client/settings-state.mjs';
import { callStreamingReason } from '../src/call-streaming.mjs';
import * as protocolCatalog from '../shared/protocol-catalog.mjs';
import * as micShortcut from '../client/mic-shortcut.mjs';

const require = createRequire(new URL('../../base/package.json', import.meta.url));
const { transformSync } = require('esbuild');
const source = readFileSync(new URL('../client/index.jsx', import.meta.url), 'utf8');
const stageSource = readFileSync(new URL('../client/call-stage.jsx', import.meta.url), 'utf8');
const stageCode = transformSync(stageSource, { loader: 'jsx', format: 'cjs' }).code;
const css = readFileSync(new URL('../client/style.css', import.meta.url), 'utf8');
const code = transformSync(source + '\nexport { ProviderSettings, ConversationSettings, MediaSettings, GenerationSettings, VoiceSettings };', { loader: 'jsx', format: 'cjs' }).code;
function mount(overrides = {}, hookValues = [], response = {}) {
  const state = { config: { dictation: true, readAloud: true, call: true, asr: { configured: true, model: 'asr', protocol: 'transcriptions-sse' }, tts: { configured: true, model: 'tts', protocol: 'speech' } }, sessionId: 'session', mode: 'call', phase: 'listening', muted: false, level: .3, readEnabled: true, ...overrides };
  const effects = [], actions = [], registrations = [], refs = [], requests = [], stateChanges = [];
  let hookIndex = 0;
  const controller = { state: { subscribe: () => () => {}, getSnapshot: () => state }, load: async () => {}, dispose: async () => {}, releaseSessionView: id => actions.push(['release-view', id]), hangup: async () => { actions.push('hangup'); }, setMuted: async value => { actions.push(['muted', value]); } };
  const callView = { getSnapshot: () => ({ sessionId: state.sessionId }), expand: () => actions.push('expand'), minimize() {}, leave: id => actions.push(['leave-view', id]), history: id => actions.push(['history', id]), start: args => actions.push(['call-entry', args.sessionId]), dispose() {} };
  const react = { createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(x => x !== false && x != null) }), useEffect: effect => { effects.push(effect); }, useRef: value => { const ref = { current: value }; refs.push(ref); return ref; }, useState: value => [hookIndex < hookValues.length ? hookValues[hookIndex++] : (hookIndex++, value), next => stateChanges.push(next)], useSyncExternalStore: (_, get) => get(), useId: () => 'id' };
  const stageModule = { exports: {} };
  runInNewContext(stageCode, { module: stageModule, exports: stageModule.exports, require: path => path === 'react' ? react : path === 'react-dom' ? { createPortal: child => child } : new Proxy({}, { get: (_, name) => name }) });
  const primitives = new Proxy({}, { get: (_, name) => name });
  const document = { baseURI: 'https://benchgo.test/', createElement: () => ({ remove() {} }), head: { append() {} }, dispatchEvent() {} };
  const module = { exports: {} }, moduleSource = createModuleSource();
  moduleSource.update({base: true, superagent: overrides.superagent !== false, voice: overrides.voice !== false});
  runInNewContext(code, { module, exports: module.exports, document, console, URL, AbortController, fetch: async (url, options) => { requests.push({ url: String(url), ...(options.body ? JSON.parse(options.body) : {}) }); return { ok: true, json: async () => response }; }, require: path => path.endsWith('call-presentation.mjs') ? { createCallPresentation: () => callView } : path.endsWith('call-host.jsx') ? { VoiceCallHost: 'VoiceCallHost' } : path.endsWith('protocol-catalog.mjs') ? protocolCatalog : path.endsWith('custom-select.jsx') ? { CustomSelect: 'CustomSelect' } : path.endsWith('ui/collapsible.jsx') ? { Disclosure: 'Disclosure' } : path.endsWith('ui/button.jsx') ? { Button: 'Button' } : path.endsWith('ui/tooltip.jsx') ? { Tooltip: 'Tooltip' } : path.endsWith('ui/loading.jsx') ? { Loading: 'Loading' } : path.endsWith('call-entry.jsx') ? { CallEntry: 'CallEntry' } : path.endsWith('mic-shortcut.mjs') ? micShortcut : path.endsWith('call-stage.jsx') ? stageModule.exports : path.endsWith('generation-results.jsx') ? { registerMediaGenerationResults() {} } : path.endsWith('conversation-records.jsx') ? { registerVoiceConversationRows() {} } : path.endsWith('call-streaming.mjs') ? { callStreamingReason } : path.endsWith('segmented-control.jsx') ? { SegmentedControl: 'SegmentedControl' } : path.endsWith('iconsax.jsx') ? { UIIcon: () => null } : path.endsWith('modules.mjs') ? { moduleSource } : path === 'react' ? react : path.includes('ui-primitives') ? primitives : path.endsWith('controller.mjs') ? { createVoiceController: () => controller } : path.endsWith('settings-state.mjs') ? settingsState : path.endsWith('.css') ? { default: css } : (() => { throw Error(path); })() });
  const ctx = { effect() {}, inject() {}, slots: { inject: (_, action) => action(), register: (options, component) => { registrations.push({ options, component }); } } };
  module.exports.mountMediaSettings(ctx);
  if (overrides.voice !== false) module.exports.apply(ctx);
  const component = registrations.find(item => item.options.name === 'conversation.input.activity')?.component;
  const render = (sessionId = 'session') => component({ controller, callView, sessionStatus: { subscribe: () => () => {}, getSnapshot: () => new Map([[sessionId, {pendingInteraction:overrides.pendingInteraction}]]) }, sessionId, locked: false, inputActions: {}, onActiveChange() {} });
  return { render, effects, refs, actions, state, controller, registrations, requests, stateChanges, exports: module.exports };
}
const nodes = root => root && typeof root === 'object' ? [root, ...root.children.flatMap(nodes)] : [];

test('all call modes register one global host and page cleanup releases only its view', () => {
  for (const conversationMode of ['enhanced', 'native', 'direct']) {
    const h = mount({ conversationMode });
    const tree = h.render();
    assert(!nodes(tree).some(node => node.type?.name === 'CallStage'));
    assert.equal(h.registrations.filter(row => row.options.name === 'shell.overlay' && row.component === 'VoiceCallHost').length, 1);
    h.effects[2]()();
    assert.deepEqual(h.actions, [['leave-view', 'session'], ['release-view', 'session']]);
    assert.equal(h.state.mode, 'call');
  }
});

test('pending official interaction releases composer takeover even during speech', () => {
  for (const pending of [{phase:'waiting'}, {phase:'speaking',pendingInteraction:{kind:'approval'}}]) {
    const h=mount({conversationMode:'enhanced',...pending},[false,'',false,true,false,false]);
    const tree=h.render();
    assert(nodes(tree).some(node=>node.children.includes('等待确认 · 请在对话中处理')));
    assert.equal(h.effects[0](),undefined);
  }
});

test('non-streaming ASR and buffered playback keep independent features available but disable call with a settings reason', () => {
  for (const blocked of ['asr', 'tts']) {
    const config = { dictation: true, readAloud: true, call: true, asr: { configured: true, model: 'ASR', protocol: blocked === 'asr' ? 'transcriptions' : 'transcriptions-sse' }, tts: { configured: true, model: 'TTS', protocol: 'speech', stream: blocked !== 'tts' } };
    const h = mount({ mode: 'idle', config });
    const tree = h.render(), buttons = nodes(tree).filter(node => node.type === 'button');
    assert.equal(nodes(tree).find(node => node.type === 'CallEntry').props.disabled, true);
    assert.equal(buttons.find(node => node.props['aria-label'] === '语音转文本').props.disabled, false);
    assert.equal(buttons.find(node => node.props['aria-label'] === '自动朗读开启').props.disabled, false);
    assert.equal(nodes(tree).find(node => node.type === 'CallEntry').props.hint, callStreamingReason(config));
    assert(!buttons.some(node => node.props.className?.includes('voice-text-button')));
  }
});
test('ordinary conversation remains available when decision configuration is unavailable', () => {
  for (const enabled of [false, true]) {
    const config = { call: true, asr: { configured: true, model: 'ASR', protocol: 'transcriptions-sse' }, tts: { configured: true, model: 'TTS', protocol: 'speech', stream: true }, listening: { enabled, configured: false, unavailableReason: '请配置决策服务' } };
    const h = mount({ mode: 'idle', config }), tree = h.render();
    assert.equal(nodes(tree).find(node => node.type === 'CallEntry').props.disabled, false);
    assert.equal(nodes(tree).some(node => node.type === 'button' && node.children.includes('决策需配置 · 设置')), false);
  }
});
test('call composer restores the shared host without duplicating media controls', async () => {
  const h = mount();
  const tree = h.render(), buttons = nodes(tree).filter(node => node.type === 'button');
  assert.deepEqual(buttons.map(node => node.props['aria-label']), ['返回语音通话']);
  await buttons[0].props.onClick();
  assert.deepEqual(h.actions, ['expand']);
  const orb = nodes(tree).find(node => node.type?.name === 'CallOrb');
  const rendered = orb.type(orb.props);
  assert.equal(rendered.props.className, 'voice-call-orb voice-orb-listening');
  assert.equal(rendered.props.style['--voice-level'], .3);
});
test('muted call keeps its playback phase when reopening the global controls', async () => {
  const h = mount({ muted: true, phase: 'speaking', playbackLevel: .65 });
  const tree = h.render(), buttons = nodes(tree).filter(node => node.type === 'button');
  assert.equal(buttons[0].props['aria-label'], '返回语音通话');
  await buttons[0].props.onClick();
  assert.deepEqual(h.actions, ['expand']);
  const orb = nodes(tree).find(node => node.type?.name === 'CallOrb');
  const rendered = orb.type(orb.props);
  assert.equal(rendered.props.className, 'voice-call-orb voice-orb-speaking');
  assert.equal(rendered.props.style['--voice-level'], .65);
});
test('TTS speed defaults to 1.2, stays in the supported range, and is round-tripped by settings', () => {
  const h = mount();
  assert.equal(h.exports.normalizeTtsSpeed(undefined), 1.2);
  assert.equal(h.exports.normalizeTtsSpeed('1.375'), 1.38);
  assert.equal(h.exports.normalizeTtsSpeed(0.1), 1.2);
  assert.equal(h.exports.normalizeTtsSpeed(4.5), 1.2);
  assert.equal(h.exports.draftFrom({ tts: { model: 'speaker', speed: 1.65 } }).tts.speed, 1.65);
  assert.equal(h.exports.draftFrom({ tts: { model: 'speaker' } }).tts.speed, 1.2);
});

test('conversation settings are call-only, use exact shared model IDs and preserve other endpoints', async () => {
  const config = { dictation: true, readAloud: true, call: true, asr: { protocol: 'transcriptions-sse', model: 'ASR/@01' }, tts: { protocol: 'speech-stream', model: 'TTS/@01', speed: 1.5 }, conversation: { providerId: 'Cloud/@01', model: 'Exact Model:02', configured: true } };
  const h = mount({ config }), original = h.exports.draftFrom(config);
  assert.deepEqual(JSON.parse(JSON.stringify(original.conversation)), { providerId: 'Cloud/@01', model: 'Exact Model:02' });
  for (const mode of ['dictation', 'readAloud', 'call']) {
    const f = mount({ config }, [original, false, false, '', false, {}, mode]);
    const form = f.exports.VoiceSettings({ controller: f.controller });
    assert.equal(nodes(form).filter(node => node.type?.name === 'ConversationSettings').length, mode === 'call' ? 1 : 0);
  }
  const draft = { ...original, conversation: { ...original.conversation, model: 'Exact Model:03' } }, f = mount({ config }, [draft, true]);
  const saved = []; f.controller.configure = async patch => saved.push(patch);
  const form = f.exports.VoiceSettings({ controller: f.controller }); f.refs[0].current = original;
  await form.props.onSubmit({ preventDefault() {} });
  assert.deepEqual(JSON.parse(JSON.stringify(saved)), [{ conversation: { model: 'Exact Model:03' } }]);
});

test('conversation model list is not filtered to audio kinds and has no independent secret fields', () => {
  const models = [{ id: 'Reasoning/@01', name: 'Thinking', kinds: ['text'] }, { id: 'Conversation:02', name: 'Quick', kinds: [] }];
  const h = mount({}, [models]), updates = [];
  const tree = h.exports.ConversationSettings({ draft: { providerId: 'Cloud/@01', model: 'Conversation:02' }, config: { providerId: 'Cloud/@01', model: 'Conversation:02', configured: true }, providers: [{ id: 'Cloud/@01', configured: true }], update: patch => updates.push(patch) });
  const select = nodes(tree).find(node => node.props.label === '交互模型');
  assert.deepEqual(Array.from(select.props.options, option => option.value), ['Reasoning/@01', 'Conversation:02']);
  assert(!nodes(tree).some(node => node.type === 'input' && ['password', 'url'].includes(node.props.type)));
  const provider = nodes(tree).find(node => node.props.label === '交互模型供应商');
  provider.props.onChange('');
  assert.deepEqual(JSON.parse(JSON.stringify(updates)), [{ providerId: '', model: '' }]);
  assert(nodes(tree).some(node => node.props.role === 'status' && node.props.className.includes('is-available')));
});
test('reselecting a voice provider preserves choices; switching providers resets borrowed settings', () => {
  const h = mount();
  for (const name of ['asr', 'tts']) {
    const updates = [];
    const tree = h.exports.ProviderSettings({ name, draft: { providerId: 'current', model: 'chosen', protocol: name === 'asr' ? 'step-websocket' : 'step-speech' }, providers: [{ id: 'current' }, { id: 'next', baseURL: 'https://next.test/v1' }], update: value => updates.push(value) });
    const select = nodes(tree).find(node => node.props.label === '模型供应商');
    select.props.onChange('current');
    assert.equal(updates.length, 0);
    select.props.onChange('next');
    assert.equal(updates[0].providerId, 'next');
    assert.equal(updates[0].model, '');
    assert.equal(updates[0].apiKey, '');
    assert.equal(updates[0].protocol, '');
    assert.equal(updates[0].apiType, '');
  }
});
test('editing a realtime URL preserves saved routing query and model placeholders', () => {
  const h = mount(), updates = [];
  const realtime = { url: 'wss://old.test/realtime', query: { model: '{model}', exit_id: 'chosen.route' } };
  const tree = h.exports.ProviderSettings({ name: 'asr', draft: { providerId: '', model: 'step-asr', protocol: 'openai-websocket', realtime }, providers: [], update: value => updates.push(value) });
  const input = nodes(tree).find(node => node.type === 'input' && node.props.value === realtime.url);
  input.props.onChange({ target: { value: 'wss://new.test/realtime' } });
  assert.equal(updates[0].realtime.url, 'wss://new.test/realtime');
  assert.deepEqual(updates[0].realtime.query, realtime.query);
  assert.equal(realtime.url, 'wss://old.test/realtime');
});
test('call takeover restores editor inert flags and card class after cleanup', () => {
  const h = mount(); const tree = h.render();
  const activity = {}, classes = new Set(), editor = { inert: false, contains: () => false }, attachment = { inert: true, contains: () => false }, row = { contains: node => node === activity };
  const card = { children: [editor, attachment, row], classList: { add: value => classes.add(value), remove: value => classes.delete(value) } };
  activity.closest = () => card; tree.props.ref.current = activity;
  const cleanup = h.effects[0]();
  assert(classes.has('voice-call-composer')); assert.equal(editor.inert, true);
  cleanup(); assert.equal(classes.size, 0); assert.equal(editor.inert, false); assert.equal(attachment.inert, true);
});
test('other sessions retain ordinary composer and no call takeover', () => {
  const h = mount(), tree = h.render('other');
  assert(!tree.props.className.includes('voice-calling'));
  assert.equal(h.effects[0](), undefined);
  assert(!nodes(tree).some(node => node.props['aria-label'] === '结束语音通话'));
});
test('voice palette and motion use blue theme and honor reduced motion', () => {
  assert(!css.includes('state-success'));
  assert(css.includes('--voice-blue:var(--dsw-alias-state-business-primary'));
  assert(css.includes('.voice-call-composer [class*="_trailing"]>:not(:has(.voice-calling))'));
  assert(css.includes('@media(prefers-reduced-motion:reduce){.voice-call-orb'));
});

test('one Media settings entry exposes Media Generation and Voice tabs', () => {
  const h = mount();
  const entries = h.registrations.filter(item => item.options.name === 'settings.section');
  assert.deepEqual(entries.map(item => [item.options.id, item.options.label()]), [['media', '媒体']]);
  const media = entries[0].component({});
  assert.deepEqual(Array.from(nodes(media).find(node => node.type === 'SegmentedControl').props.options, option => option.label), ['媒体生成', '语音']);
  const generation = nodes(media).find(node => node.type?.name === 'GenerationSettings');
  const generationTree = generation.type(generation.props);
  assert.deepEqual(Array.from(nodes(generationTree).find(node => node.type === 'SegmentedControl').props.options, option => option.label), ['图片', '视频', '音频']);
  assert(nodes(media).some(node => node.type?.name === 'VoiceSettings'));
  const voice = mount({}, [h.exports.draftFrom(h.state.config)]);
  const voiceTree = voice.exports.VoiceSettings({ controller: voice.controller });
  assert.deepEqual(Array.from(nodes(voiceTree).find(node => node.type === 'SegmentedControl').props.options, option => option.label), ['语音转文本', '朗读', '实时通话']);
});

test('generation uses its own settings endpoint before voice availability is known', async () => {
  const h = mount({ superagent: false, voice: false });
  const media = h.exports.MediaSettings({});
  const generation = nodes(media).find(node => node.type?.name === 'GenerationSettings');
  const loading = generation.type(generation.props);
  assert(nodes(loading).some(node => node.props.label === '正在加载媒体设置…'));
  for (const effect of h.effects) effect();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(h.requests.map(request => request.url), ['https://benchgo.test/api/commander/tooling', 'https://benchgo.test/api/benchgo/media/settings']);
});

test('OpenAI routes preserve opaque model IDs and legacy protocols until explicit selection', () => {
  const h = mount();
  const old = h.exports.draftFrom({ asr: { protocol: 'step-websocket', model: 'Exact Model/@01' }, tts: { protocol: 'step-speech', model: 'Exact Voice:02', stream: false } });
  assert.equal(old.asr.model, 'Exact Model/@01');
  assert.equal(old.asr.protocol, 'step-websocket');
  assert.equal(old.tts.protocol, 'step-speech');
  assert.equal(old.tts.stream, false);
  assert.equal(h.exports.draftFrom({ tts: { model: 'step-tts-mini' } }).tts.protocol, '');
  assert.equal(h.exports.draftFrom({}).tts.stream, true);
  for (const name of ['asr', 'tts']) {
    const updates = [];
    const tree = h.exports.ProviderSettings({ name, draft: old[name], providers: [], update: patch => updates.push(patch) });
    const route = nodes(tree).find(node => node.props.label === '协议');
    assert.deepEqual(Array.from(route.props.options, item => item.value), Array.from(protocolCatalog.protocolOptions(name), item => item.value));
    assert(nodes(tree).some(node => node.props.role === 'alert'));
    route.props.onChange(name === 'asr' ? 'transcriptions-sse' : 'speech');
    assert.deepEqual(Object.keys(updates[0]), ['protocol']);
  }
});

test('streaming synthesis selection saves only the protocol and keeps playback independent', async () => {
  const config = { dictation: true, readAloud: true, call: true, asr: { protocol: 'transcriptions-sse', model: 'ASR/@01' }, tts: { providerId: 'Cloud/@01', protocol: 'speech', model: 'TTS/@01', voice: 'Voice:02', speed: 1.35, stream: false } };
  const h = mount({ config }), original = h.exports.draftFrom(config), updates = [];
  const tree = h.exports.ProviderSettings({ name: 'tts', draft: original.tts, providers: [{ id: 'Cloud/@01', configured: true }], update: patch => updates.push(patch) });
  const route = nodes(tree).find(node => node.props.label === '协议');
  const streamed = route.props.options.find(item => item.value === 'speech-stream');
  assert.equal(streamed.label, protocolCatalog.protocolDescriptor('tts', 'speech-stream').label);
  assert.equal(streamed.streaming, true);
  assert.equal(route.props.options.find(item => item.value === 'speech').transport, 'http');
  route.props.onChange('speech-stream');
  const draft = { ...original, tts: { ...original.tts, ...updates[0] } };
  const form = mount({ config }, [draft, true]);
  const saved = [];
  form.controller.configure = async patch => saved.push(patch);
  const settings = form.exports.VoiceSettings({ controller: form.controller });
  form.refs[0].current = original;
  await settings.props.onSubmit({ preventDefault() {} });
  assert.deepEqual(JSON.parse(JSON.stringify(saved)), [{ tts: { protocol: 'speech-stream' } }]);
  assert.equal(draft.tts.model, 'TTS/@01');
  assert.equal(draft.tts.voice, 'Voice:02');
  assert.equal(draft.tts.stream, false);
  const reloaded = h.exports.draftFrom({ ...config, tts: { ...config.tts, protocol: 'speech-stream' } });
  assert.equal(reloaded.tts.protocol, 'speech-stream');
});

test('streaming synthesis enables read and call controls only with configured model', () => {
  for (const configured of [true, false]) {
    const h = mount({ mode: 'idle', readEnabled: false, config: { dictation: true, readAloud: true, call: true, asr: { configured: true, model: 'ASR/@01', protocol: 'transcriptions-sse' }, tts: { configured, protocol: 'speech-stream', model: 'TTS/@01' } } });
    const tree = h.render();
    const call = nodes(tree).find(node => node.type === 'CallEntry');
    const read = nodes(tree).find(node => node.props.className === 'voice-icon-button voice-read-button');
    assert.equal(call.props.disabled, !configured);
    assert.equal(read.props.disabled, !configured);
    assert.equal(call.props.available, configured);
  }
});

test('transcript recovery has no action panel and returns to the original draft after hangup', () => {
  for (const mode of ['call', 'idle']) {
    const h = mount({ mode, recoveryText: '完整的未发送文字', recoverySessionId: 'session' });
    h.controller.recoverToDraft = () => { h.actions.push('recover'); };
    const tree = h.render();
    assert(!nodes(tree).some(node => node.props['aria-label'] === '待恢复的语音文字'));
    assert(!nodes(tree).some(node => node.type?.name === 'CallStage'));
    h.effects[3]();
    assert.deepEqual(h.actions, mode === 'idle' ? ['recover'] : []);
  }
  const other = mount({ mode: 'idle', recoveryText: '其他会话文字', recoverySessionId: 'session' });
  other.controller.recoverToDraft = () => { other.actions.push('recover'); };
  other.render('other'); other.effects[3]();
  assert.deepEqual(other.actions, []);
});

test('failed automatic draft recovery keeps the text and reports a concise error', () => {
  const h = mount({ mode: 'idle', recoveryText: '保留文字', recoverySessionId: 'session' });
  h.controller.selectSession = id => h.actions.push(['select', id]);
  h.controller.recoverToDraft = () => { throw Error('草稿当前不可编辑'); };
  h.render(); h.effects[2](); h.effects[3]();
  assert.deepEqual(h.actions, [['select', 'session']]);
  assert(h.stateChanges.includes('草稿当前不可编辑'));
  assert.equal(h.state.recoveryText, '保留文字');
});
