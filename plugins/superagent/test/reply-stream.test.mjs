import test from 'node:test';
import assert from 'node:assert/strict';
import { PartialArguments } from '@deepseek-ai/dsh-util-values';
import { activeChatReply } from '../src/chat-publication.mjs';
import { projectReplyStream } from '../client/reply-stream.mjs';

const history = { sessionId: 'session', activeReply: { requestId: 'human', turn: 2 }, messages: [{ id: 'human', role: 'user', time: 1 }] };
const call = args => ({ name: 'assistant_reply', turn: 2, time: 2, args });
const run = (calls = [], extra = {}) => projectReplyStream({ history, sessionId: 'session', running: true, chat: { legacy: { runningCalls: calls } }, ...extra });

test('official incremental argument reader exposes decoded text only and updates in place', () => {
  const args = new PartialArguments();
  args.append('{"text":"Hello');
  assert.equal(run([call(args)]).text, 'Hello');
  args.append('\\nworld"}');
  assert.equal(run([call(args)]).text, 'Hello\nworld');
  assert.equal(run([call(args)]).streaming, true);
  assert.equal(run([call(args)]).id, 'reply:human');
});

test('reasoning, other tools, nested worker calls and stale sources never publish', () => {
  const args = PartialArguments.fromObject({ text: 'answer' });
  assert.equal(run([], { chat: { legacy: { partial: { turn: 2, blocks: [{ kind: 'reasoning', text: 'secret' }] } } } }), null);
  assert.equal(run([{ ...call(args), name: 'shell' }]), null);
  assert.equal(run([{ ...call(args), parentCallId: 'worker' }]), null);
  assert.equal(run([{ ...call(args), turn: 1 }]), null);
  assert.equal(run([call(args)], { sessionId: 'other' }), null);
  assert.equal(run([call(args)], { running: false }), null);
  assert.equal(run([call(args)], { history: { ...history, activeReply: null } }), null);
  assert.equal(run([call(args)], { history: { ...history, messages: [] } }), null);
});

test('ordinary Router text grows before completion and never includes reasoning or tool arguments', () => {
  const partial = { turn: 2, step: 1, blocks: [{ kind: 'reasoning', text: 'SECRET' }, { kind: 'text', text: '第一段' }, { kind: 'tool-call', name: 'read', argsRaw: 'PRIVATE' }] };
  const chat = { legacy: { partial } };
  const first = run([], { chat });
  assert.equal(first.text, '第一段');
  assert.equal(first.streaming, true);
  partial.blocks = [...partial.blocks, { kind: 'text', text: '第二段' }];
  const second = run([], { chat });
  assert.equal(second.text, '第一段\n第二段');
  assert.equal(second.key, first.key);
  assert.doesNotMatch(JSON.stringify(second), /SECRET|PRIVATE|argsRaw/);
  assert.equal(run([], { chat, running: false }), null);
  assert.equal(run([], { chat: { legacy: { partial: { ...partial, parentCallId: 'worker' } } } }), null);
  assert.equal(run([], { chat: { legacy: { partial: { ...partial, turn: 1 } } } }), null);
  assert.equal(run([], { chat: { legacy: { partial, turnEnds: new Map([[2, 10]]) } } }), null);
  assert.equal(run([], { chat, history: { ...history, messages: [...history.messages, { role: 'assistant', kind: 'final', requestId: 'human' }] } }), null);
});

test('an admitted user identity bridges a slow history refresh without borrowing another request', () => {
  const partial = { turn: 2, step: 1, blocks: [{ kind: 'text', text: '实时回复' }] };
  const node = { kind: 'user', seq: 8, source: { kind: 'user', rpcId: 'rpc' } };
  const chat = { legacy: { partial, nodes: [node], turnEnds: new Map([[1, 7]]) } };
  const pending = { ...history, activeReply: null, messages: [], requests: [{ requestId: 'rpc', messageId: 'persisted-human', sessionId: 'session', status: 'processing' }] };
  assert.equal(run([], { chat, history: pending }).requestId, 'persisted-human');
  assert.equal(run([], { chat, history: { ...pending, requests: [{ ...pending.requests[0], sessionId: 'other' }] } }), null);
  assert.equal(run([], { chat, history: { ...pending, requests: [{ ...pending.requests[0], status: 'queued' }] } }), null);
  assert.equal(run([], { chat: { legacy: { ...chat.legacy, nodes: [{ ...node, source: { kind: 'system', rpcId: 'rpc' } }] } }, history: pending }), null);
  assert.equal(run([], { chat: { legacy: { ...chat.legacy, nodes: [{ ...node, seq: 7 }] } }, history: pending }), null);
  const admitted = { ...pending, requests: [], messages: [{ role: 'user', id: 'human', seq: 8, rpcId: 'rpc' }] };
  assert.equal(run([], { chat, history: admitted }).requestId, 'human');
});

test('explicit assistant_reply stream supersedes ordinary public progress in the same turn', () => {
  const args = PartialArguments.fromObject({ text: '正式正文' });
  const chat = { legacy: { runningCalls: [call(args)], partial: { turn: 2, blocks: [{ kind: 'text', text: '可见进度' }] } } };
  assert.equal(run([], { chat }).text, '正式正文');
});

test('malformed, extra-field, empty and oversized reply arguments are withheld', () => {
  for (const value of [{ text: '' }, { text: 3 }, { text: 'a'.repeat(16001) }, { text: 'ok', private: 'no' }]) {
    assert.equal(run([call(PartialArguments.fromObject(value))]), null);
  }
  assert.equal(run([call(PartialArguments.fromText('{"text": broken}'))]), null);
});

test('accepted publication bridges refresh then deduplicates; rejected calls vanish', () => {
  const result = { ...call(PartialArguments.fromObject({ text: 'answer' })), kind: 'tool-result', content: [{ type: 'text', text: '{"published":true,"requestId":"human"}' }] };
  const chat = { legacy: { nodes: [result] } };
  assert.equal(run([], { chat, running: false }).streaming, false);
  assert.equal(run([], { chat, history: { ...history, messages: [...history.messages, { role: 'assistant', kind: 'final', requestId: 'human' }] } }), null);
  assert.equal(run([], { chat: { legacy: { nodes: [{ ...result, isError: true }] } } }), null);
  assert.equal(run([], { chat: { legacy: { nodes: [{ ...result, content: [{ type: 'text', text: '{"published":true,"requestId":"other"}' }] }] } } }), null);
});

const settledChat = (reason = 'completed', changes = {}) => {
  const end = reason && { seq: 12, time: 4, data: { reason: { kind: reason } } };
  return {
    timeline: { turnOrder: [2], turns: new Map([[2, { turn: 2, start: { seq: 7 }, ...(end ? { end } : {}) }]]) },
    legacy: { nodes: [
      { kind: 'user', messageId: 'human', seq: 8, source: { kind: 'user', rpcId: 'rpc' } },
      { kind: 'assistant', messageId: 'model-message', turn: 2, step: 1, seq: 10, time: 3,
        blocks: [{ kind: 'reasoning', text: 'PRIVATE' }, { kind: 'text', text: '完整正文' }], ...changes },
    ], turnEnds: new Map(end ? [[2, 12]] : []) },
  };
};

test('ordinary text survives partial → official settlement → history without a second reply store', () => {
  const partial = run([], { chat: { legacy: { partial: { turn: 2, blocks: [{ kind: 'text', text: '完整' }] } } } });
  const settling = run([], { chat: settledChat(null) });
  assert.equal(settling.text, '完整正文');
  assert.equal(settling.streaming, true, 'a settled step cannot claim the whole turn completed');
  const completed = run([], { chat: settledChat(), running: false });
  assert.equal(completed.text, '完整正文');
  assert.equal(completed.streaming, false);
  assert.equal(completed.key, partial.key);
  assert.equal(settling.key, partial.key);
  assert.doesNotMatch(JSON.stringify(completed), /PRIVATE/);
  assert.equal(run([], { chat: settledChat(), running: false,
    history: { ...history, activeReply: null, messages: [...history.messages, completed] } }), null, 'history assumes the same identity exactly once');
  assert.equal(run([], { chat: settledChat(), history: { ...history, activeReply: null }, running: false }).key, partial.key, 'closed activeReply is not needed after official completion');
});

test('settlement requires a durable ordinary answer, the latest real turn and an admitted user', () => {
  for (const reason of ['aborted', 'error', 'max-tokens', null]) {
    assert.equal(run([], { chat: settledChat(reason), running: false }), null);
  }
  for (const changes of [
    { messageId: undefined }, { interrupted: true }, { parentCallId: 'worker' }, { seq: 13 },
    { blocks: [{ kind: 'text', text: 'tool preamble' }, { kind: 'tool-call', name: 'shell' }] },
    { blocks: [{ kind: 'reasoning', text: 'PRIVATE' }] },
  ]) assert.equal(run([], { chat: settledChat('completed', changes), running: false }), null);
  const chat = settledChat();
  chat.timeline.turnOrder.push(3);
  chat.timeline.turns.set(3, { turn: 3, start: { seq: 13 } });
  assert.equal(run([], { chat }), null, 'a later turn never reuses the preceding settled answer');
  assert.equal(run([], { chat: settledChat(), history: { ...history, activeReply: { turn: 3, requestId: 'next' } } }), null);
  assert.equal(run([], { chat: settledChat(), history: { ...history, messages: [] } }), null);
  const internal = settledChat();
  internal.legacy.nodes[0].source = { kind: 'system' };
  assert.equal(run([], { chat: internal }), null);
  const truncated = settledChat();
  truncated.legacy.nodes.shift();
  assert.equal(run([], { chat: truncated }), null, 'history identity alone cannot borrow a missing user from another loaded turn');
});

test('new streams and explicit publication supersede a settled ordinary step', () => {
  const chat = settledChat(null);
  chat.legacy.partial = { turn: 2, blocks: [{ kind: 'text', text: '下一步正文' }] };
  assert.equal(run([], { chat }).text, '下一步正文');
  chat.legacy.runningCalls = [call(PartialArguments.fromObject({ text: '显式正文' }))];
  assert.equal(run([], { chat }).text, '显式正文');
  chat.legacy.nodes.push({ ...call(PartialArguments.fromObject({ text: '已发表正文' })), kind: 'tool-result',
    content: [{ type: 'text', text: '{"published":true,"requestId":"human"}' }] });
  assert.equal(run([], { chat, running: false }).text, '已发表正文');
});

test('server active reply identity requires an open user-owned turn', () => {
  const start = { type: 'turn/start', data: { turn: 2 } };
  const user = { type: 'user/message', data: { id: 'human', source: { kind: 'user' } } };
  assert.equal(activeChatReply([user]), null);
  assert.deepEqual(activeChatReply([start, user]), { turn: 2, requestId: 'human' });
  assert.equal(activeChatReply([start, { ...user, data: { ...user.data, source: { kind: 'system' } } }]), null);
  for (const kind of ['completed', 'aborted', 'error']) assert.equal(activeChatReply([start, user, { type: 'turn/end', data: { turn: 2, reason: { kind } } }]), null);
});
