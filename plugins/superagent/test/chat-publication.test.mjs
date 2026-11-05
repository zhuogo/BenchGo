import test from 'node:test';
import assert from 'node:assert/strict';
import { chatPublicationType, projectChatMessages } from '../src/chat-publication.mjs';

const user = { type: 'user/message', seq: 0, data: { id: 'human-1', source: { kind: 'user' }, content: [{ type: 'text', text: 'question' }] } };
const reply = (seq, data = {}, extra = {}) => ({ seq, type: chatPublicationType, ignorable: true, data: { kind: 'final', requestId: 'human-1', text: 'answer', ...data }, ...extra });
const start = (turn = 1) => ({ type: 'turn/start', seq: 0, data: { turn } });
const answer = (content, turn = 1) => ({ type: 'assistant/message', seq: 2, data: { turn, message: { source: { kind: 'model' }, content } } });
const end = (kind = 'completed', turn = 1) => ({ type: 'turn/end', seq: 3, data: { turn, reason: { kind } } });

test('usage comes only from final model request and exposes numeric allowlist', () => {
  const first = answer([{ type: 'tool-call', name: 'read' }]);
  first.data.usage = { inputTokens: 900 };
  const final = answer([{ type: 'text', text: 'done' }]);
  final.data.usage = { inputTokens: 10, outputTokens: 2, reasoningTokens: 0, cacheReadTokens: -1, secret: 'hidden', totalTokens: Infinity };
  const rows = projectChatMessages([start(), user, first, final, end()]);
  assert.deepEqual(rows[1].usage, { inputTokens: 10, outputTokens: 2, reasoningTokens: 0 });
  const explicit = projectChatMessages([start(), user, final, reply(3), end()]);
  assert.deepEqual(explicit[1].usage, rows[1].usage);
  assert.equal(projectChatMessages([start(), user, answer([{ type: 'text', text: 'done' }]), end()])[1].usage, undefined);
  assert.equal(projectChatMessages([start(), user, final, end('aborted'), start(2), reply(5), end('completed', 2)])[1].usage, undefined);
});

test('normal completed answer is visible without a publication tool and survives history reload', () => {
  const events = [start(), user, answer([{ type: 'reasoning', text: 'PRIVATE' }, { type: 'text', text: '我是当前配置的模型。' }]), end()];
  const rows = projectChatMessages(JSON.parse(JSON.stringify(events)));
  assert.equal(rows[1].text, '我是当前配置的模型。');
  assert.equal(rows[1].kind, 'final');
  assert.equal(rows[1].seq, 3);
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE/);
});

test('only completed terminal text is published, never tool narration or failed partial output', () => {
  const narration = answer([{ type: 'text', text: 'PRIVATE PROCESS' }, { type: 'tool-call', name: 'read' }]);
  assert.equal(projectChatMessages([start(), user, narration, end()]).length, 1);
  for (const kind of ['error', 'aborted', 'interrupted', 'max-tokens', 'blocked']) {
    assert.equal(projectChatMessages([start(), user, answer([{ type: 'text', text: 'partial' }]), end(kind)]).length, 1);
  }
  const rows = projectChatMessages([start(), user, narration, answer([{ type: 'text', text: 'Final answer' }]), end()]);
  assert.deepEqual(rows.map(row => row.text), ['question', 'Final answer']);
});

test('explicit publication wins and internal or mismatched turns cannot reply to an old user', () => {
  const text = answer([{ type: 'text', text: 'Ordinary answer' }]);
  assert.deepEqual(projectChatMessages([start(), user, text, end(), reply(4)]).map(row => row.text), ['question', 'answer']);
  assert.equal(projectChatMessages([start(), user, end('aborted'), start(2), answer([{ type: 'text', text: 'INTERNAL' }], 2), end('completed', 2)]).length, 1);
  assert.equal(projectChatMessages([start(), user, answer([{ type: 'text', text: 'foreign' }], 2), end()]).length, 1);
});

test('chat projection denies raw execution, foreign requests and malformed publications', () => {
  const events = [user,
    { type: 'user/message', seq: 1, data: { id: 'system', source: { kind: 'schedule' }, content: [{ type: 'text', text: 'private prompt' }] } },
    { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: 'private narration' }, { type: 'reasoning', text: 'secret' }] } } },
    { type: 'tool/result', seq: 3, data: { message: { content: [{ type: 'text', text: 'credential' }] } } },
    reply(4, { requestId: 'another-session' }), reply(5, { kind: 'progress' }), reply(6, {}, { ignorable: false }),
    reply(7, { text: ' ' }), reply(8, { text: 'x'.repeat(16001) }), reply(9), reply(10, { text: 'duplicate' }),
  ];
  assert.deepEqual(projectChatMessages(events).map(row => row.text), ['question', 'answer']);
});

test('publication projection keeps stable sequence cursors without exposing event internals', () => {
  const rows = projectChatMessages([user, reply(12)]);
  assert.equal(rows[1].seq, 12);
  assert.equal(rows[1].id, 'reply:human-1');
  assert.deepEqual(rows[1].content, [{ type: 'text', text: 'answer' }]);
  assert.equal('data' in rows[1], false);
});
