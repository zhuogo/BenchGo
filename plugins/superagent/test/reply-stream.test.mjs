import test from 'node:test';
import assert from 'node:assert/strict';
import { PartialArguments } from '@deepseek-ai/dsh-util-values';
import { activeChatReply, projectChatMessages } from '../src/chat-publication.mjs';
import { projectReplyStream, projectReplyRows, conversationActivity } from '../client/reply-stream.mjs';

const history = { sessionId: 'session', activeReply: { requestId: 'human', turn: 2 }, messages: [{ id: 'human', role: 'user', time: 1 }] };
const rows = (chat, extra = {}) => projectReplyRows({ history, sessionId: 'session', running: true, chat, ...extra });
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
  const partial = run([], { chat: { legacy: { partial: { turn: 2, step: 1, blocks: [{ kind: 'text', text: '完整' }] } } } });
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

test('new ordinary steps append while explicit publication may replace the public draft', () => {
  const chat = settledChat(null);
  chat.legacy.partial = { turn: 2, step: 2, blocks: [{ kind: 'text', text: '下一步正文' }] };
  assert.deepEqual(rows(chat).map(row => row.text), ['完整正文', '下一步正文']);
  chat.legacy.runningCalls = [call(PartialArguments.fromObject({ text: '显式正文' }))];
  assert.equal(run([], { chat }).text, '显式正文');
  chat.legacy.nodes.push({ ...call(PartialArguments.fromObject({ text: '已发表正文' })), kind: 'tool-result',
    content: [{ type: 'text', text: '{"published":true,"requestId":"human"}' }] });
  assert.equal(run([], { chat, running: false }).text, '已发表正文');
});

test('all public steps survive tools and reasoning, then hand off unchanged to completed history', () => {
  const chat = settledChat(null, { blocks: [{ kind: 'text', text: '先看资料。' }, { kind: 'tool-call', name: 'read', argsRaw: 'PRIVATE_ARGS' }] });
  const first = run([], { chat });
  assert.equal(first.text, '先看资料。');
  chat.legacy.nodes.push({ kind: 'tool-result', seq: 11, turn: 2, step: 1, content: [{ type: 'text', text: 'PRIVATE_RESULT' }] });
  for (const partial of [undefined, { turn: 2, step: 2, blocks: [] }, { turn: 2, step: 2, blocks: [{ kind: 'reasoning', text: 'PRIVATE_REASONING' }] }]) {
    chat.legacy.partial = partial;
    assert.equal(run([], { chat }).text, first.text, 'a content-free phase keeps earlier public text');
  }
  chat.legacy.partial.blocks.push({ kind: 'text', text: '找到结果。' });
  assert.deepEqual(rows(chat).map(row => row.text), ['先看资料。', '找到结果。']);
  chat.legacy.nodes.push({ kind: 'assistant', messageId: 'second', seq: 13, turn: 2, step: 2, blocks: chat.legacy.partial.blocks });
  assert.deepEqual(rows(chat).map(row => row.text), ['先看资料。', '找到结果。'], 'settled step wins over a delayed matching partial');
  chat.legacy.partial = { turn: 2, step: 1, blocks: [{ kind: 'text', text: 'LATE_PARTIAL' }] };
  assert.deepEqual(rows(chat).map(row => row.text), ['先看资料。', '找到结果。']);
  const end = { seq: 14, time: 4, data: { turn: 2, reason: { kind: 'completed' } } };
  chat.timeline.turns.get(2).end = end;
  chat.legacy.turnEnds.set(2, 14);
  const completed = run([], { chat, running: false });
  assert.equal(completed.text, '找到结果。');
  assert.equal(rows(chat, { running: false })[0].key, first.key);
  const events = [{ type: 'turn/start', seq: 7, data: { turn: 2 } },
    { type: 'user/message', seq: 8, data: { id: 'human', source: { kind: 'user' }, content: [] } },
    ...chat.legacy.nodes.filter(node => node.kind === 'assistant').map(node => ({ type: 'assistant/message', seq: node.seq, data: {
      turn: node.turn, step: node.step, message: { id: node.messageId, source: { kind: 'model' }, content: node.blocks.map(({ kind, ...block }) => ({ type: kind, ...block })) },
    } })), { type: 'turn/end', ...end }];
  const messages = projectChatMessages(JSON.parse(JSON.stringify(events)));
  assert.deepEqual(messages.filter(row => row.role === 'assistant').map(row => row.text), ['先看资料。', '找到结果。']);
  assert.equal(messages.at(-1).text, completed.text);
  assert.equal(messages.at(-1).id, completed.id);
  assert.equal(run([], { chat, running: false, history: { ...history, activeReply: null, messages } }), null);
  assert.doesNotMatch(JSON.stringify(completed), /PRIVATE|LATE_PARTIAL/);
});

test('tools may conclude a successful turn without erasing their preceding public text', () => {
  const chat = settledChat('completed', { blocks: [{ kind: 'text', text: '已处理。' }, { kind: 'tool-call', name: 'read' }] });
  assert.equal(run([], { chat, running: false }).text, '已处理。');
  chat.legacy.nodes.push({ kind: 'assistant', messageId: 'reasoning', seq: 11, turn: 2, step: 2, blocks: [{ kind: 'reasoning', text: 'PRIVATE' }] });
  assert.equal(run([], { chat, running: false }).text, '已处理。');
});

test('same-turn steering and late events cannot borrow the earlier request text', () => {
  const chat = settledChat(null);
  const next = { role: 'user', id: 'next', seq: 11, text: '新请求' };
  chat.legacy.nodes.push({ kind: 'steering', messageId: next.id, seq: next.seq, source: { kind: 'user' } });
  chat.timeline.turns.get(2).steps = [{ step: 1, start: { seq: 8 }, end: { seq: 10 } }, { step: 2, start: { seq: 10.5 } }];
  const updated = { ...history, activeReply: { turn: 2, requestId: next.id }, messages: [...history.messages, next] };
  chat.legacy.partial = { turn: 2, step: 1, blocks: [{ kind: 'text', text: 'LATE_FIRST_REQUEST' }] };
  assert.equal(run([], { chat, history: updated }), null);
  chat.legacy.partial = { turn: 2, step: 2, blocks: [{ kind: 'text', text: '只答新请求' }] };
  const answer = run([], { chat, history: updated });
  assert.equal(answer.text, '只答新请求');
  assert.equal(answer.requestId, 'next');
  chat.legacy.runningCalls = [{ ...call(PartialArguments.fromObject({ text: 'LATE_OLD_PUBLICATION' })), step: 1 }];
  assert.equal(run([], { chat, history: updated }).text, answer.text, 'a delayed publication draft also keeps its original request boundary');
  assert.equal(run([], { chat }), null, 'old history identity cannot adopt newly admitted user text');
  assert.equal(run([], { chat, history: updated, sessionId: 'other-session' }), null);
  chat.timeline.turnOrder.push(3);
  chat.timeline.turns.set(3, { turn: 3, start: { seq: 20 } });
  assert.equal(run([], { chat, history: updated }), null, 'late old-turn text cannot enter the next turn');
});

test('cancel and failure discard all uncommitted steps but preserve an accepted publication', () => {
  for (const reason of ['aborted', 'error']) {
    const chat = settledChat(reason, { blocks: [{ kind: 'text', text: '未提交进度' }, { kind: 'tool-call', name: 'read' }] });
    assert.equal(run([], { chat, running: false }), null);
    chat.legacy.nodes.push({ ...call(PartialArguments.fromObject({ text: '已正式提交' })), kind: 'tool-result',
      content: [{ type: 'text', text: '{"published":true,"requestId":"human"}' }] });
    assert.equal(run([], { chat, running: false }).text, '已正式提交');
  }
});

test('server active reply identity requires an open user-owned turn', () => {
  const start = { type: 'turn/start', data: { turn: 2 } };
  const user = { type: 'user/message', data: { id: 'human', source: { kind: 'user' } } };
  assert.equal(activeChatReply([user]), null);
  assert.deepEqual(activeChatReply([start, user]), { turn: 2, requestId: 'human' });
  assert.equal(activeChatReply([start, { ...user, data: { ...user.data, source: { kind: 'system' } } }]), null);
  for (const kind of ['completed', 'aborted', 'error']) assert.equal(activeChatReply([start, user, { type: 'turn/end', data: { turn: 2, reason: { kind } } }]), null);
});

test('explicit final preserves earlier public steps in live view, accepted publication and reloaded history', () => {
  const chat = settledChat(null, { blocks: [{ kind: 'text', text: '我先检查服务器。' }] });
  const publish = { ...call(PartialArguments.fromObject({ text: '检查完成。' })), step: 2, seq: 12 };
  chat.legacy.runningCalls = [publish];
  const live = rows(chat);
  assert.deepEqual(live.map(row => row.text), ['我先检查服务器。', '检查完成。']);
  chat.legacy.nodes.push({ ...publish, kind: 'tool-result', content: [{ type: 'text', text: '{"published":true,"requestId":"human"}' }] });
  const accepted = rows(chat, { running: false });
  assert.deepEqual(accepted.map(row => row.id), live.map(row => row.id));
  assert(accepted.every(row => !row.streaming));
  const messages = projectChatMessages([
    { type: 'turn/start', seq: 7, data: { turn: 2 } },
    { type: 'user/message', seq: 8, data: { id: 'human', source: { kind: 'user' }, content: [] } },
    { type: 'assistant/message', seq: 10, data: { turn: 2, step: 1, message: { id: 'model-message', source: { kind: 'model' }, content: [{ type: 'text', text: '我先检查服务器。' }] } } },
    { type: 'tool/call', seq: 11, data: { turn: 2, step: 2, name: 'assistant_reply', callId: 'final', arguments: '{"text":"检查完成。"}' } },
    { type: 'plugin:benchgo-plugin/chat-publication', ignorable: true, seq: 12, data: { kind: 'final', requestId: 'human', text: '检查完成。' } },
  ]);
  assert.deepEqual(messages.filter(row => row.role === 'assistant').map(row => row.id), accepted.map(row => row.id));
  assert.deepEqual(rows(chat, { running: false, history: { ...history, messages } }), []);
});

test('activity uses public labels, subtle model waits and actual interaction or error facts', () => {
  assert.deepEqual(conversationActivity({ running: true }, {}), { kind: 'waiting', label: '正在处理', subtle: true });
  assert.deepEqual(conversationActivity({ running: true }, { legacy: { runningCalls: [{ name: 'assistant_memory_search' }] } }), { kind: 'search', label: '搜索中' });
  assert.deepEqual(conversationActivity({ running: true }, { legacy: { runningCalls: [{ name: 'private_protocol_tool' }] } }), { kind: 'work', label: '工作中' });
  assert.equal(conversationActivity({ running: true }, {}, { kind: 'question' }).label, '等待你的回答');
  assert.equal(conversationActivity({ running: true }, {}, { kind: 'approval' }).label, '等待你的确认');
  assert.equal(conversationActivity({ openState: 'error' }, {}).kind, 'error');
  assert.equal(conversationActivity({ openState: 'loading' }, {}).kind, 'connecting');
  assert.equal(conversationActivity({ running: false }, {}), null);
});
