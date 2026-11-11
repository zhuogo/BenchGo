import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { readVoiceTranscript, voiceRecordOf, VOICE_CONVERSATION_RECORD } from '../client/conversation-records.mjs';

const require = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url));
const { build } = createRequire(new URL('../../benchgo/package.json', import.meta.url))('esbuild');
const bundle = await build({ stdin: { resolveDir: fileURLToPath(new URL('../../../', import.meta.url)), contents: `
  export * from './plugins/voice/client/conversation-records.jsx';
  export {ConversationNodeAssembler} from './deepseek-harness/packages/client/ui-conversation/src/client/conversation/assembler.ts';
  export {chatViewDefinition} from './deepseek-harness/packages/client/ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts';
` }, bundle: true, write: false, nodePaths: [fileURLToPath(new URL('../../../deepseek-harness/apps/web/node_modules', import.meta.url))],
  platform: 'node', format: 'esm', loader: { '.css': 'text' }, alias: { react: dirname(require.resolve('react/package.json')) }, logLevel: 'silent' });
const { voiceMessageDefinition: definition, registerVoiceConversationRows, ConversationNodeAssembler, chatViewDefinition } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const event = (kind, seq, patch = {}) => ({ type: VOICE_CONVERSATION_RECORD, ignorable: true, seq, time: 1731000000000 + seq,
  data: { kind, callId: 'call', requestId: 'turn', messageId: kind + '-id', text: kind === 'user' ? '帮我检查页面' : '我看一下。', ...patch } });
function project(events) {
  const contexts = new Map();
  for (const event of events) {
    const identity = definition.match(event);
    if (!identity) continue;
    const match = { ...identity, event, location: { kind: 'session' } };
    const previous = contexts.get(identity.id);
    contexts.set(identity.id, { key: identity.id, id: identity.id, start: previous?.start || match,
      state: previous ? definition.update(previous, match) : definition.start({}, match) });
  }
  return [...contexts.values()].map(context => definition.buildViewNode(context));
}

test('executor chat hides voice-only dialogue before and after handoff without deleting durable records', () => {
  const user = event('user', 1), assistant = event('assistant', 2);
  let nodes = project([user, assistant]);
  assert.deepEqual(nodes.map(node => node.visibility), ['hidden', 'hidden']);
  nodes = project([user, assistant, event('handoff', 4, { userMessageId: 'official-user' }), event('execution', 5)]);
  assert.deepEqual(nodes.map(node => node.visibility), ['hidden', 'hidden', 'hidden']);
  assert.equal(nodes[0].anchorSeq, 1);
  assert.equal(nodes[1].data.text, assistant.data.text);
  assert.equal(project([user, event('handoff', 4, { userMessageId: '' })])[0].visibility, 'hidden');
});

test('official assembler shows call milestone while excluding spoken dialogue from executor Chat', () => {
  const routes = new Set([{ definition, match: definition.match.bind(definition) }]);
  const assembler = new ConversationNodeAssembler({ entries: () => [definition], forEvent: () => routes, fallbackEntry: () => undefined },
    { entries: () => [chatViewDefinition] });
  assembler.replaceWindow([event('call-start', 0, { requestId: 'call' }), event('user', 1), event('assistant', 2), event('handoff', 3, { userMessageId: 'official-user' }), event('execution', 4)]
    .map(event => ({ event, durable: true })), false);
  assembler.activateTarget('chat'); assembler.flush();
  const snapshot = assembler.snapshot('chat');
  assert.equal(snapshot.order.length, 1);
  assert.equal(snapshot.nodes.get(snapshot.order[0]).data.kind, 'call-start');
  assert.equal(readVoiceTranscript([event('user', 1), event('assistant', 2)]).length, 2);
});

test('spoken transcript keeps original user once after delegation, supports replay and full assistant snapshots', () => {
  const entries = [event('user', 1), event('assistant', 2, { partial: true, text: '我看' }),
    event('handoff', 3, { userMessageId: 'official-user' }), { type: 'user/message', seq: 4, data: { text: '帮我检查页面' } },
    event('execution', 5), event('assistant', 6, { text: '我看一下。' }), event('user', 7, { requestId: 'greeting', text: '你好' }),
    event('assistant', 8, { requestId: 'greeting', text: '你好呀。' }), event('user', 9, { callId: 'other-call', text: '另一次通话' })];
  const transcript = readVoiceTranscript(entries.map(event => ({ event })), { callId: 'call' });
  assert.deepEqual(transcript.map(row => row.text), ['帮我检查页面', '我看一下。', '你好', '你好呀。']);
  assert.equal(transcript[1].seq, 2); assert.equal(transcript[1].updatedSeq, 6); assert.equal(transcript[1].partial, false);
  assert.deepEqual(readVoiceTranscript([...entries, ...entries], { callId: 'call' }), transcript);
  assert.deepEqual(readVoiceTranscript([...entries].reverse(), { callId: 'call' }), transcript);
  assert.equal(readVoiceTranscript(entries).length, 5);
});

test('malformed records are rejected and arbitrary spoken text stays out of executor Chat', () => {
  for (const record of [null, { ...event('user', 1), type: 'user/message' }, { ...event('user', 1), ignorable: false },
    event('unknown', 1), event('user', 1, { callId: '' }), event('user', 1, { requestId: null })]) {
    assert.equal(voiceRecordOf(record), null); assert.equal(definition.match(record), null);
  }
  const text = '<img src=x onerror=alert(1)>', node = project([event('assistant', 1, { text })])[0];
  assert.equal(node.visibility, 'hidden');
  assert.equal(readVoiceTranscript([event('assistant', 1, { text })])[0].text, text);
});

test('voice record definition and call milestone renderer use host lifetime cleanup', () => {
  const effects = [], removed = [];
  registerVoiceConversationRows({ effect: register => effects.push(register()),
    uiConversation: { events: { register(value) { assert.equal(value, definition); return () => removed.push('definition'); } } },
    slots: { inject(name, register) { assert.equal(name, 'conversation.chat.node'); return register(); }, register(meta) { assert.equal(meta.key, definition.kind); return () => removed.push('renderer'); } } });
  effects.forEach(dispose => dispose()); assert.deepEqual(removed, ['definition', 'renderer']);
});

test('call-start milestone appears once in executor chat without becoming a spoken message', () => {
  const start = event('call-start', 1, { requestId: 'call', mode: 'native', startedAt: 1731000000000 });
  const nodes = project([start, start]);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].visibility, 'visible');
  assert.equal(nodes[0].data.time, start.data.startedAt);
  assert.deepEqual(readVoiceTranscript([start]), []);
});
