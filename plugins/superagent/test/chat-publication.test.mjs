import test from 'node:test';
import assert from 'node:assert/strict';
import { activeChatReply, chatPublicationType, executionInputSource, installChatPublication, projectChatMessages } from '../src/chat-publication.mjs';
import { ticketStateSource } from '../src/ticket-state-report.mjs';
import { ticketReplySource } from '../src/ticket-reply.mjs';

const user = { type: 'user/message', seq: 0, data: { id: 'human-1', source: { kind: 'user' }, content: [{ type: 'text', text: 'question' }] } };
const reply = (seq, data = {}, extra = {}) => ({ seq, type: chatPublicationType, ignorable: true, data: { kind: 'final', requestId: 'human-1', text: 'answer', ...data }, ...extra });
const start = (turn = 1) => ({ type: 'turn/start', seq: 0, data: { turn } });
const answer = (content, turn = 1) => ({ type: 'assistant/message', seq: 2, data: { turn, message: { source: { kind: 'model' }, content } } });
const end = (kind = 'completed', turn = 1) => ({ type: 'turn/end', seq: 3, data: { turn, reason: { kind } } });

test('execution scope notices hide their source, publish only after current host validation, and restore one natural reply', async () => {
  for (const allowed of [true, false]) {
    const notice = { ...user, data: { ...user.data, id: 'execution-notice', source: { kind: executionInputSource, triggerId: 'native', ticketId: 'same-ticket' },
      content: [{ type: 'text', text: 'PRIVATE_EXPANSION_ORIGINAL' }] } };
    const events = [start(), notice, answer([{ type: 'text', text: '新增范围需要你确认。' }])];
    assert.equal(activeChatReply(events).requestId, 'execution-notice');
    assert.deepEqual(projectChatMessages([...events, end()]), []);
    let stopping;
    const agent = { session: { snapshotEvents: () => events } };
    installChatPublication({ on: (_name, handler) => { stopping = handler; }, tools: { register() {} } }, agent,
      { canPublish: async request => { assert.equal(request.source.triggerId, 'native'); return allowed; },
        appendRecord: (_session, type, data) => events.push({ type, data, ignorable: true, seq: events.length }) });
    await stopping({ agent, turn: 1 }); await stopping({ agent, turn: 1 });
    const restored = projectChatMessages(JSON.parse(JSON.stringify([...events, end()])));
    assert.equal(restored.length, allowed ? 1 : 0);
    if (allowed) assert.equal(restored[0].text, '新增范围需要你确认。');
    assert.doesNotMatch(JSON.stringify(restored), /PRIVATE_EXPANSION_ORIGINAL/);
  }
});

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

const stateNotice = { type: 'user/message', seq: 5, data: { id: 'state-notice', source: { kind: ticketReplySource, replyKind: 'state', eventKey: 'notice:1', ticketId: 'ticket' },
  content: [{ type: 'text', text: 'PRIVATE HOST STATE INSTRUCTION' }] } };
const statePermit = (text, data = {}) => ({ type: chatPublicationType, ignorable: true, seq: 7,
  data: { kind: 'state-final-permit', requestId: stateNotice.data.id, ticketStateEventKey: 'notice:1', turn: 2, text, ...data } });

test('state prompts stay private while natural reports project independently of the preceding human reply', () => {
  const report = '“整理资料”的执行状态还在核实，已有记录已保留。';
  const events = [start(), user, answer([{ type: 'text', text: '先回答用户的问题。' }]), end(),
    start(2), stateNotice, answer([{ type: 'reasoning', text: 'PRIVATE REASONING' }, { type: 'text', text: report }], 2), statePermit(report), end('completed', 2)];
  const rows = projectChatMessages(JSON.parse(JSON.stringify(events)));
  assert.deepEqual(rows.map(row => [row.role, row.requestId, row.text]), [
    ['user', undefined, 'question'], ['assistant', 'human-1', '先回答用户的问题。'],
  ]);
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE/);
  assert.equal(activeChatReply(events), null);
});

test('explicit status publications deduplicate against natural completion and retain the human reply', () => {
  const rows = projectChatMessages([start(), user, reply(2), end(), start(2), stateNotice,
    answer([{ type: 'text', text: 'unpublished draft' }], 2), reply(7, { requestId: 'state-notice', ticketStateEventKey: 'notice:1', text: '状态自然报告' }),
    reply(8, { requestId: 'state-notice', ticketStateEventKey: 'notice:1', text: '重复报告' }), end('completed', 2)]);
  assert.deepEqual(rows.map(row => row.text), ['question', 'answer']);
  assert.deepEqual(rows.filter(row => row.role === 'assistant').map(row => row.requestId), ['human-1']);
  assert.equal(projectChatMessages([start(), stateNotice, answer([{ type: 'text', text: 'partial' }]), end('error')]).length, 0);
});

test('assistant_reply binds an active state report to its own request and never consumes the previous human reply', async () => {
  const events = [start(), user, end(), start(2), stateNotice];
  let tool, conclusions = 0;
  const agent = { session: { snapshotEvents: () => events } };
  installChatPublication({ tools: { register: value => { tool = value; } } }, agent, {
    canPublish: async () => true,
    appendRecord: (_session, type, data) => events.push({ type, data, ignorable: true, seq: events.length }),
  });
  assert.equal(activeChatReply(events), null);
  assert.deepEqual(activeChatReply(events, { includeInternal: true }), { turn: 2, requestId: 'state-notice' });
  const execution = { agent, concludeTurn: () => { conclusions++; } };
  assert.deepEqual(await tool.execute({ text: '已有执行记录保留，当前状态待核实。' }, execution), { published: true, requestId: 'state-notice' });
  assert.deepEqual(await tool.execute({ text: '已有执行记录保留，当前状态待核实。' }, execution), { published: true, duplicate: true, requestId: 'state-notice' });
  assert.equal(conclusions, 2);
  assert.throws(() => tool.execute({ text: '改写状态' }, execution), /不能重复或改写/);
  assert.equal(events.filter(event => event.type === chatPublicationType).length, 1);
  assert.equal(events.find(event => event.type === chatPublicationType).data.requestId, 'state-notice');
  assert.deepEqual(projectChatMessages(events).map(row => row.text), ['question']);
});

test('unpermitted state drafts and mismatched publication identities never become reports', () => {
  const prefix = [start(2), stateNotice, answer([{ type: 'text', text: '状态报告' }], 2)];
  assert.deepEqual(projectChatMessages([...prefix, end('completed', 2)]), []);
  for (const data of [{ text: '不同正文' }, { turn: 1 }, { requestId: 'human-1' }, { ticketStateEventKey: 'other' }]) {
    assert.deepEqual(projectChatMessages([...prefix, statePermit('状态报告', data), end('completed', 2)]), []);
  }
  for (const ticketStateEventKey of [undefined, 'other']) {
    assert.deepEqual(projectChatMessages([...prefix, reply(7, { requestId: 'state-notice', ticketStateEventKey }), end('completed', 2)]), []);
  }
});

test('state publication rechecks permission for explicit and natural replies and preserves denied drafts privately', async () => {
  for (const allowed of [false, true]) {
    const events = [start(2), stateNotice, answer([{ type: 'text', text: '状态报告' }], 2)];
    let tool, stopping, concluded = false;
    const checked = [], agent = { session: { snapshotEvents: () => events } };
    installChatPublication({ on: (name, hook) => { assert.equal(name, 'agent/turn-stopping'); stopping = hook; },
      tools: { register: value => { tool = value; } } }, agent, {
      canPublish: async request => { checked.push(request.id); return allowed; },
      appendRecord: (_session, type, data) => events.push({ type, data, ignorable: true, seq: events.length }),
    });
    if (!allowed) {
      await assert.rejects(tool.execute({ text: '状态报告' }, { agent, concludeTurn: () => { concluded = true; } }), /状态或授权已变化/);
      assert.equal(concluded, false);
    }
    await stopping({ agent, turn: 2 });
    assert.equal(checked.length, allowed ? 1 : 2);
    assert(checked.every(id => id === 'state-notice'));
    const rows = projectChatMessages([...events, end('completed', 2)]);
    assert.equal(rows.length, 0);
    assert.equal(events.some(event => event.type === chatPublicationType && event.data.kind === 'ticket-reply'), allowed);
  }
});


test('retired state reports never stream or project even with a historical permit or publication', () => {
  const legacy = { ...stateNotice, data: { ...stateNotice.data, source: { ...stateNotice.data.source, kind: ticketStateSource } } };
  const events = [start(2), legacy, answer([{ type: 'text', text: 'LEGACY REPORT' }], 2), statePermit('LEGACY REPORT'),
    reply(8, { requestId: legacy.data.id, ticketStateEventKey: 'notice:1', text: 'LEGACY REPORT' })];
  assert.equal(activeChatReply(events), null);
  assert.deepEqual(projectChatMessages([...events, end('completed', 2)]), []);
});

test('retired state publication is rejected even if a callback permits it or a matching reply already exists', () => {
  for (const existing of [false, true]) {
    const legacy = { ...stateNotice, data: { ...stateNotice.data, source: { kind: ticketStateSource } } };
    const events = [start(2), legacy];
    if (existing) events.push(reply(8, { requestId: legacy.data.id, text: 'LEGACY REPORT' }));
    let tool, checked = false;
    const agent = { session: { snapshotEvents: () => events } };
    installChatPublication({ tools: { register: value => { tool = value; } } }, agent, {
      canPublish: () => { checked = true; return true; },
      appendRecord: () => assert.fail('retired source cannot publish'),
    });
    assert.throws(() => tool.execute({ text: 'LEGACY REPORT' }, { agent,
      concludeTurn: () => assert.fail('retired source cannot conclude a published reply') }), /旧工单状态发布路径已停用/);
    assert.equal(checked, false);
    assert.deepEqual(projectChatMessages([...events, end('completed', 2)]), []);
  }
});
