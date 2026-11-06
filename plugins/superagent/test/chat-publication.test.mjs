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

test('normal and explicit conversational replies preserve natural text verbatim', () => {
  const text = '  自然正文。\n\n保留段落与末尾换行。\n';
  assert.equal(projectChatMessages([start(), user, answer([{ type: 'text', text }]), end()])[1].text, text);
  assert.equal(projectChatMessages([start(), user, reply(2, { text }), end()])[1].text, text);
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

test('answered official questions become one visible choice bubble; pending, failed or malformed answers stay private', () => {
  const ask = (callId, questions, seq = 2) => ({ type: 'tool/call', seq, data: { turn: 1, callId, name: 'ask_user_question', arguments: JSON.stringify({ questions }) } });
  const result = (callId, value, seq = 3, isError = false) => ({ type: 'tool/result', seq, time: 9, data: { message: { source: { callId }, isError, content: [{ type: 'text', text: JSON.stringify(value) }] } } });
  const questions = [{ id: 'use', question: '主要用途？', header: '用途', options: [{ label: '网站' }] }, { id: 'budget', question: '预算？' }];
  const rows = projectChatMessages([start(), user,
    ask('c1', questions), result('c1', { answers: [{ id: 'use', selected: ['网站', '文件共享'] }, { id: 'budget', selected: [], custom: '100 元内' }] }),
    ask('c2', [{ id: 'later', question: '稍后？' }], 4), result('c2', { pending: true, callId: 'c2' }, 5),
    ask('c3', [{ id: 'x', question: 'X？' }], 6), result('c3', 'boom', 7, true),
    ask('c4', [{ id: 'y', question: 'Y？' }], 8), result('c4', { answers: [{ id: 'other', selected: [] }] }, 9)]);
  const replies = rows.filter(row => row.kind === 'question-reply');
  assert.equal(replies.length, 1);
  assert.equal(replies[0].role, 'user');
  assert.equal(replies[0].id, 'question:c1');
  assert.deepEqual(replies[0].questions, [{ id: 'use', question: '主要用途？', header: '用途' }, { id: 'budget', question: '预算？' }]);
  assert.equal(replies[0].text, '用途：网站、文件共享\n预算？：100 元内');
  assert.doesNotMatch(JSON.stringify(replies), /options/);
});
