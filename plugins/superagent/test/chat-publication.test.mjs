import { channelMessageRecordType } from '../src/channel-session-record.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { activeChatReply, chatPublicationType, executionInputSource, installChatPublication, projectChatMessages, chatNotificationIdentities } from '../src/chat-publication.mjs';
import { ticketStateSource } from '../src/ticket-state-report.mjs';
import { ticketReplySource } from '../src/ticket-reply.mjs';

const user = { type: 'user/message', seq: 0, data: { id: 'human-1', source: { kind: 'user' }, content: [{ type: 'text', text: 'question' }] } };
const reply = (seq, data = {}, extra = {}) => ({ seq, type: chatPublicationType, ignorable: true, data: { kind: 'final', requestId: 'human-1', text: 'answer', ...data }, ...extra });
const start = (turn = 1) => ({ type: 'turn/start', seq: 0, data: { turn } });
const answer = (content, turn = 1) => ({ type: 'assistant/message', seq: 2, data: { turn, message: { source: { kind: 'model' }, content } } });
const end = (kind = 'completed', turn = 1) => ({ type: 'turn/end', seq: 3, data: { turn, reason: { kind } } });

test('notification identities reflect only newly public replies, including short completion and explicit cancellation', () => {
  const events = [start(), user, answer([{ type: 'text', text: 'Short reply' }, { type: 'reasoning', text: 'PRIVATE' }])];
  assert.deepEqual(chatNotificationIdentities(events, events.at(-1)), []);
  for (const kind of ['error', 'aborted']) assert.deepEqual(chatNotificationIdentities([...events, end(kind)], end(kind)), []);
  assert.deepEqual(chatNotificationIdentities([...events, end()], end()), [{ requestId: 'human-1' }]);
  const explicit = reply(3);
  assert.deepEqual(chatNotificationIdentities([...events, explicit], explicit), [{ requestId: 'human-1' }]);
  assert.deepEqual(chatNotificationIdentities([...events, explicit, end('aborted')], end('aborted')), [{ requestId: 'human-1' }]);
  const privateNotice = { ...user, data: { ...user.data, source: { kind: ticketReplySource, replyKind: 'result' } } };
  assert.deepEqual(chatNotificationIdentities([start(), privateNotice, explicit], explicit), []);
  assert.deepEqual(chatNotificationIdentities([start(), user, { ...explicit, ignorable: false }], explicit), []);
  const old = [start(), user, events[2], end()];
  const laterStart = { ...start(2), seq: 10 }, laterEnd = { ...end('completed', 2), seq: 12 };
  assert.deepEqual(chatNotificationIdentities([...old, laterStart, laterEnd], laterEnd), [], 'an empty new turn cannot notify for old replies');
});

test('approval reminder publishes only after host validation and preserves its historical natural reply after approval is decided', async () => {
  for (const allowed of [true, false]) {
    const notice = { ...user, data: { ...user.data, id: 'approval-request', source: { kind: ticketReplySource, replyKind: 'approval' },
      content: [{ type: 'text', text: 'PRIVATE HOST SIGNAL' }] } };
    const events = [start(), notice, answer([{ type: 'text', text: '有项发送需要你确认，可在任务审核里看一下。' }])];
    assert.deepEqual(projectChatMessages(events), []);
    let stopping;
    const agent = { session: { snapshotEvents: () => events } };
    installChatPublication({ on: (_name, handler) => { stopping = handler; }, tools: { register() {} } }, agent,
      { canPublish: async () => allowed, appendRecord: (_session, type, data) => events.push({ type, data, ignorable: true, seq: events.length }) });
    await stopping({ agent, turn: 1 }); await stopping({ agent, turn: 1 });
    const restored = projectChatMessages(JSON.parse(JSON.stringify([...events, end(), { type: 'approval/decided', data: { id: 'ask', outcome: 'allowed-once' } }])));
    assert.equal(restored.length, allowed ? 1 : 0);
    assert.deepEqual(chatNotificationIdentities([...events, end()], end()), allowed ? [{ requestId: 'approval-request' }] : []);
    if (allowed) assert.match(restored[0].text, /任务审核/);
    assert.doesNotMatch(JSON.stringify(restored), /PRIVATE HOST SIGNAL/);
  }
});

test('only a bound internal approval publication can become a natural chat reminder', () => {
  const notice = { ...user, data: { ...user.data, id: 'approval-request', source: { kind: ticketReplySource, replyKind: 'approval' } } };
  const publication = reply(3, { kind: 'ticket-reply', requestId: notice.data.id, text: '已备好，请到任务审核确认。' });
  assert.deepEqual(projectChatMessages([publication, notice]), [], 'a future internal request cannot authorize an earlier publication');
  assert.deepEqual(projectChatMessages([notice, { ...publication, ignorable: false }]), []);
  assert.deepEqual(projectChatMessages([notice, { ...publication, data: { ...publication.data, suppressed: true } }]), []);
  assert.deepEqual(projectChatMessages([notice, { ...publication, data: { ...publication.data, requestId: 'foreign' } }]), []);
  assert.equal(projectChatMessages([{ ...notice, data: { ...notice.data, source: { kind: 'user', replyKind: 'approval' } } }, publication]).length, 1,
    'an ordinary human source with a forged approval tag has no internal reminder publication');
  assert.deepEqual(projectChatMessages([{ ...notice, data: { ...notice.data, source: { kind: ticketReplySource, replyKind: 'result' } } }, publication]), [],
    'result expressions still use their owned outbox instead of this reminder projection');
});

const approvalBinding = { sessionId: 'worker', callId: 'submit-call', approvalId: 'official-ask', actionId: 'action',
  ticketId: 'ticket', assignmentId: 'assignment', runId: 'run', ownerThreadId: 'main', eventKey: 'approval:worker:official-ask' };
const boundApprovalNotice = () => ({ ...user, data: { ...user.data, id: 'bound-notice',
  source: { kind: ticketReplySource, replyKind: 'approval', ticketId: approvalBinding.ticketId,
    eventKey: approvalBinding.eventKey, approval: { ...approvalBinding, privateValue: 'PRIVATE' } } } });
const boundApprovalPublication = () => reply(3, { kind: 'ticket-reply', requestId: 'bound-notice',
  ticketReplyEventKey: approvalBinding.eventKey, text: '发送内容准备好了，请确认。' });

test('approval card identity restores from the exact host reminder request and excludes private or model fields', () => {
  const notice = boundApprovalNotice(), publication = boundApprovalPublication();
  publication.data.approval = { ...approvalBinding, actionId: 'MODEL_FORGERY' };
  const events = [start(), notice, publication, { ...publication, seq: 4 }, end()];
  const restored = projectChatMessages(JSON.parse(JSON.stringify(events)));
  assert.equal(restored.length, 1);
  assert.equal(restored[0].requestId, notice.data.id);
  assert.equal(restored[0].id, `reply:${notice.data.id}`);
  assert.deepEqual(restored[0].approval, approvalBinding);
  assert.doesNotMatch(JSON.stringify(restored), /PRIVATE|MODEL_FORGERY/);
});

test('model text and publication metadata cannot fabricate an approval card binding', () => {
  const publication = boundApprovalPublication();
  publication.data.approval = approvalBinding;
  const notice = boundApprovalNotice();
  delete notice.data.source.approval;
  notice.data.content = [{ type: 'text', text: JSON.stringify({ approval: approvalBinding }) }];
  assert.equal(projectChatMessages([notice, publication])[0].approval, undefined);
  const normal = reply(3, { approval: approvalBinding });
  assert.equal(projectChatMessages([user, normal]).at(-1).approval, undefined);
});

test('incomplete or cross-request approval sources never attach a card to a natural reply', () => {
  const variants = [
    source => { source.eventKey = 'another-event'; },
    source => { source.ticketId = 'another-ticket'; },
    source => { source.approval.eventKey = 'approval:foreign:official-ask'; },
    source => { delete source.approval.callId; },
    source => { source.replyKind = 'recovery'; },
  ];
  for (const change of variants) {
    const notice = boundApprovalNotice(); change(notice.data.source);
    assert.equal(projectChatMessages([notice, boundApprovalPublication()])[0].approval, undefined);
  }
  const publication = boundApprovalPublication(); publication.data.ticketReplyEventKey = 'foreign-request';
  assert.equal(projectChatMessages([boundApprovalNotice(), publication])[0].approval, undefined);
});

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
  assert.equal(rows[1].seq, 2);
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE/);
});

test('normal and explicit conversational replies preserve natural text verbatim', () => {
  const text = '  自然正文。\n\n保留段落与末尾换行。\n';
  assert.equal(projectChatMessages([start(), user, answer([{ type: 'text', text }]), end()])[1].text, text);
  assert.equal(projectChatMessages([start(), user, reply(2, { text }), end()])[1].text, text);
});

test('completed turns preserve public text across tools and reasoning but discard failed drafts', () => {
  const narration = answer([{ type: 'text', text: '先检查资料。' }, { type: 'tool-call', name: 'read', arguments: { secret: 'PRIVATE_ARGS' } }]);
  assert.equal(projectChatMessages([start(), user, narration, end()])[1].text, '先检查资料。');
  for (const kind of ['error', 'aborted', 'interrupted', 'max-tokens', 'blocked']) {
    assert.equal(projectChatMessages([start(), user, answer([{ type: 'text', text: 'partial' }]), end(kind)]).length, 1);
  }
  const reasoning = answer([{ type: 'reasoning', text: 'PRIVATE_REASONING' }]);
  assert.equal(projectChatMessages([start(), user, narration, reasoning, end()])[1].text, '先检查资料。');
  const rows = projectChatMessages([start(), user, narration, reasoning,
    { type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'PRIVATE_RESULT' }] } } },
    answer([{ type: 'text', text: 'Final answer' }]), end()]);
  assert.deepEqual(rows.map(row => row.text), ['question', '先检查资料。', 'Final answer']);
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE/);
});

test('public text belongs to its admitted request, with explicit publication surviving cancellation', () => {
  const old = answer([{ type: 'text', text: 'Earlier request' }]);
  const next = { ...user, seq: 3, data: { ...user.data, id: 'human-2' } };
  const current = answer([{ type: 'text', text: 'Current request' }]);
  const interrupted = { ...old, data: { ...old.data, interrupted: true } };
  const nested = { ...old, data: { ...old.data, parentCallId: 'worker' } };
  const rows = projectChatMessages([start(), user, old, next, interrupted, nested,
    answer([{ type: 'text', text: 'FOREIGN_TURN' }], 2), current, end()]);
  assert.equal(rows.at(-1).requestId, 'human-2');
  assert.equal(rows.at(-1).text, 'Current request');
  for (const reason of ['aborted', 'error']) {
    const published = projectChatMessages([start(), user, old, reply(3), end(reason)]);
    assert.deepEqual(published.map(row => row.text), ['question', 'answer']);
  }
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

const channelMirror = (seq, direction = 'inbound', mirrorKey = `intake:${seq}`) => ({
  type: channelMessageRecordType, seq, time: '2026-11-10T12:00:00Z', ignorable: true,
  data: { mirrorKey, direction, text: direction === 'inbound' ? '飞书来源正文' : '已确认送达的回复',
    source: { channel: 'feishu', sourceType: 'direct', conversationId: 'source-chat' } },
});

test('channel mirrors appear in actual Router history as public rows without becoming requests or model replies', () => {
  const inbound = channelMirror(1), delivered = channelMirror(8, 'delivery', 'delivery:ticket:sent-result');
  const events = [inbound, start(), { ...user, seq: 2 }, reply(5), end(), delivered];
  const before = JSON.stringify(events), rows = projectChatMessages(events);
  assert.deepEqual(rows.map(row => [row.id, row.role]), [
    ['channel:intake:1', 'user'], ['human-1', 'user'], ['reply:human-1', 'assistant'], ['channel:delivery:ticket:sent-result', 'assistant'],
  ]);
  for (const [row, event] of [[rows[0], inbound], [rows[3], delivered]]) {
    assert.deepEqual(row, { seq: event.seq, id: `channel:${event.data.mirrorKey}`, kind: 'channel-message',
      role: event.data.direction === 'inbound' ? 'user' : 'assistant', direction: event.data.direction,
      mirrorKey: event.data.mirrorKey, source: { kind: 'benchgo-channel', channelSource: event.data.source },
      text: event.data.text, content: [{ type: 'text', text: event.data.text }], time: event.time });
  }
  assert.equal(activeChatReply([inbound]), null, 'display-only channel input never activates a Router request');
  assert.deepEqual(chatNotificationIdentities(events, inbound), []);
  assert.deepEqual(chatNotificationIdentities(events, delivered), [{ mirrorKey: delivered.data.mirrorKey }]);
  assert.equal(JSON.stringify(events), before, 'reading history never rewrites the stored mirrors');
  assert.deepEqual(rows.filter(row => row.seq < 8).slice(-2).map(row => row.id), ['human-1', 'reply:human-1'], 'public sequence pagination retains channel ordering');
});

test('channel history deduplicates persisted mirror identity and excludes arbitrary context or malformed records', () => {
  const inbound = channelMirror(1), delivered = channelMirror(3, 'delivery', 'delivery:ticket:result');
  const invalid = [
    { ...inbound, ignorable: false }, { ...inbound, type: 'plugin:other/channel-message' },
    { ...inbound, data: { ...inbound.data, mirrorKey: '' } },
    { ...inbound, data: { ...inbound.data, direction: 'tool' } },
    { ...inbound, data: { ...inbound.data, text: undefined } },
    { ...inbound, data: { ...inbound.data, source: { channel: 'feishu' } } },
    { type: 'system/message', seq: 0, data: { content: [{ type: 'text', text: 'PRIVATE_CONTEXT' }] } },
    { type: 'user/message', seq: 0, data: { id: 'internal', source: { kind: 'benchgo-subscription' }, content: [{ type: 'text', text: 'PRIVATE_WORKER_INPUT' }] } },
  ];
  const rows = projectChatMessages([...invalid, inbound, { ...inbound, seq: 2 }, delivered]);
  assert.deepEqual(rows.map(row => row.id), ['channel:intake:1', 'channel:delivery:ticket:result']);
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE_CONTEXT|PRIVATE_WORKER_INPUT/);
});
