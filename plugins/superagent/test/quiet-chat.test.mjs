import test from 'node:test';
import assert from 'node:assert/strict';
import { quietChatRows } from '../client/quiet-chat.mjs';
import { projectReplyStream } from '../client/reply-stream.mjs';
import { continuationRecovery, ticketSnapshot } from '../client/ticket-state.mjs';
import { PartialArguments } from '@deepseek-ai/dsh-util-values';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

test('official submission is visible immediately, reconciles by identity and withdraws on failure', () => {
  const pending = { requestId: 'rpc-1', placement: 'transcript', text: '你好', time: 1, attachments: [] };
  const session = { pendingSubmissions: [pending, { ...pending, requestId: 'queued', placement: 'queued' }] };
  assert.deepEqual(quietChatRows({}, 'main', session).map(row => row.key), ['pending:rpc-1']);
  assert.equal(quietChatRows({}, 'main', { pendingSubmissions: [] }).length, 0);
  const user = { kind: 'user', seq: 12, source: { kind: 'user', rpcId: 'rpc-1' }, content: [{ type: 'text', text: '你好' }], time: 1 };
  const chat = { legacy: { nodes: [user, { kind: 'assistant', text: 'private' }, { ...user, seq: 13, source: { kind: 'system' } }] } };
  assert.deepEqual(quietChatRows({}, 'main', session, chat).map(row => row.key), ['live-user:12']);
  const history = { messages: [{ id: 'saved', seq: 12, role: 'user', text: '你好', time: 1 }] };
  assert.deepEqual(quietChatRows(history, 'main', session, chat).map(row => row.key), ['message:saved']);
  const repeated = { legacy: { nodes: [user, { ...user, seq: 14, source: { kind: 'user', rpcId: 'rpc-2' } }] } };
  assert.equal(quietChatRows(history, 'main', session, repeated).length, 2);
  assert.equal(quietChatRows({ messages: [{ id: 'saved', role: 'user', seq: 12, rpcId: 'rpc-1' }] }, 'main', session).length, 1, 'history may arrive before official live nodes');
  assert.equal(quietChatRows(history, 'main', {}, { legacy: { nodes: [{ ...user, seq: 1, source: { kind: 'user', rpcId: 'old' } }] } }).length, 1, 'live user nodes cannot expose older unloaded pages');
});

test('quiet chat admits user and explicit final only, never raw or streaming steps', () => {
  const messages = [
    { id: 'u', role: 'user', text: 'Work' },
    { id: 'raw', role: 'assistant', text: 'Checking files' },
    { id: 'tool', role: 'tool', text: 'secret' },
    { id: 'final', role: 'assistant', kind: 'final', text: 'Done' },
    { id: 'partial', role: 'assistant', kind: 'final', streaming: true, text: 'partial' },
  ];
  assert.deepEqual(quietChatRows({ messages }).map(row => row.id), ['u', 'final']);
});

test('delivery is source-bound, deduplicated, and ordered with final replies', () => {
  const history = { messages: [{ id: 'u', role: 'user', time: 1 }, { id: 'f', role: 'assistant', kind: 'final', time: 3 }], notifications: [
    { id: 'n', threadId: 'side', text: 'Done', createdAt: 2 },
    { id: 'n', threadId: 'side', text: 'Done', createdAt: 2 },
    { id: 'unknown', text: 'Unbound' },
    { id: 'empty', threadId: 'side', text: '' },
  ] };
  assert.deepEqual(quietChatRows(history, 'side').map(row => row.id), ['u', 'n', 'f']);
  assert.deepEqual(quietChatRows(history, 'main').map(row => row.id), ['u', 'f']);
});

test('durable inbox requests echo the user while queued and reconcile by message or request identity', () => {
  const request = { threadId: 'side', requestId: 'rpc', messageId: 'user-msg', status: 'queued', text: '调研新闻', createdAt: 1 };
  const pending = { requestId: 'rpc', placement: 'transcript', text: '调研新闻', time: 1 };
  assert.deepEqual(quietChatRows({ requests: [request] }, 'side', { pendingSubmissions: [pending] }).map(row => row.key), ['request:rpc']);
  assert.deepEqual(quietChatRows({ requests: [request] }, 'main'), []);
  for (const message of [{ id: 'user-msg' }, { id: 'saved', requestId: 'rpc' }, { id: 'saved', source: { requestId: 'rpc' } }]) {
    assert.equal(quietChatRows({ requests: [request], messages: [{ ...message, role: 'user', text: '调研新闻', time: 1 }] }, 'side').length, 1);
  }
  const live = { legacy: { nodes: [{ kind: 'user', seq: 1, source: { kind: 'user', requestId: 'rpc' }, content: [{ type: 'text', text: '调研新闻' }], time: 1 }] } };
  assert.deepEqual(quietChatRows({ requests: [request] }, 'side', {}, live).map(row => row.key), ['live-user:1']);
});

test('failed and uncertain inbox requests expose their real system error without an assistant report', () => {
  for (const status of ['failed', 'uncertain']) {
    const rows = quietChatRows({ requests: [{ threadId: 'main', requestId: 'rpc', status, text: '调研新闻', createdAt: 1, updatedAt: 2, error: '持久队列状态待核实' }] });
    assert.deepEqual(rows.map(row => row.role), ['user', 'system']);
    assert.equal(rows[1].origin, 'system');
    assert.equal(rows[1].text, '持久队列状态待核实');
  }
});

const stateNotification = { type: 'ticket.result', eventId: 'notice:1', threadId: 'main', ticketId: 'ticket', title: '资料整理',
  text: '【资料整理】\n\n系统状态：系统状态：执行记录已保留，等待恢复条件。', createdAt: 1,
  publication: { origin: 'system', systemState: { state: 'continuation_wait', code: 'MODEL_UNAVAILABLE', stage: 'execution' } } };

test('legacy state remains a natural titled summary until the same event has a persisted Router report', () => {
  const summary = quietChatRows({ notifications: [stateNotification] });
  assert.equal(summary.length, 1);
  assert.equal(summary[0].role, 'system');
  assert.equal(summary[0].title, '资料整理');
  assert.equal(summary[0].text, '执行记录已保留，等待恢复条件。');
  const report = { id: 'reply:state', role: 'assistant', kind: 'final', text: '资料整理暂时在等待恢复，执行记录已保留。', time: 2, ticketStateEventKey: 'notice:1' };
  assert.deepEqual(quietChatRows({ notifications: [stateNotification], messages: [report] }).map(row => row.id), [report.id]);
  for (const change of [{ ticketStateEventKey: 'other' }, { ticketStateEventKey: undefined }, { streaming: true }, { kind: 'draft' }, { text: '' }]) {
    assert(quietChatRows({ notifications: [stateNotification], messages: [{ ...report, ...change }] }).some(row => row.notification), 'unrelated, unfinished or empty reports cannot hide the state');
  }
  const explicitKey = { ...stateNotification, eventKey: 'event-key', eventId: 'different-notification-id' };
  assert.equal(quietChatRows({ notifications: [explicitKey], messages: [{ ...report, ticketStateEventKey: 'event-key' }] }).length, 1);
  assert(quietChatRows({ notifications: [explicitKey], messages: [report] }).some(row => row.notification));
  const persistedKey = { ...stateNotification, ticketStateEventKey: 'assignment-system-state:worker:4:execution', eventId: 'notification-uuid', id: 'other-uuid', eventKey: 'other-key' };
  assert.equal(quietChatRows({ notifications: [persistedKey], messages: [{ ...report, ticketStateEventKey: persistedKey.ticketStateEventKey }] }).length, 1, 'persisted outbox key matches despite independent notification UUIDs');
  assert(quietChatRows({ notifications: [persistedKey], messages: [{ ...report, ticketStateEventKey: 'notification-uuid' }] }).some(row => row.notification), 'notification UUID cannot replace the persisted outbox identity');
});

test('only the matching state event is replaced and ordinary send errors remain visible', () => {
  const history = { messages: [{ id: 'report', role: 'assistant', kind: 'final', text: '状态报告', ticketStateEventKey: 'notice:1' }],
    notifications: [stateNotification, { ...stateNotification, eventId: 'notice:2' }],
    requests: [{ threadId: 'main', requestId: 'send', status: 'failed', text: '用户消息', error: '连接中断，消息发送失败', createdAt: 2 }] };
  const rows = quietChatRows(history);
  assert.deepEqual(rows.filter(row => row.notification).map(row => row.eventId), ['notice:2']);
  assert(rows.some(row => row.role === 'user' && row.text === '用户消息'));
  assert(rows.some(row => row.role === 'system' && row.text === '连接中断，消息发送失败'));
});

test('option accompanies its body and uses the validated endpoint, never approval or raw send', async () => {
  const { transformSync } = createRequire(new URL('../../benchgo/package.json', import.meta.url))('esbuild');
  const code = transformSync(readFileSync(new URL('../client/quiet-chat.jsx', import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs' }).code;
  const react = { createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(x => x != null && x !== false) }), useState: value => [value, () => {}], useRef: () => ({ current: null }), useEffect() {}, useSyncExternalStore: (_subscribe, snapshot) => snapshot() };
  const module = { exports: {} }, calls = [];
  runInNewContext(code, { module, exports: module.exports, require: id => id.endsWith('/ui/button.jsx') ? { Button: 'button' } : id.endsWith('/ui/collapsible.jsx') ? { Disclosure: 'Disclosure' } : id.endsWith('ticket-state.mjs') ? { continuationRecovery, ticketSnapshot } : id.endsWith('ticket-attention.jsx') ? { TicketAttention: 'TicketAttention' } : id.endsWith('message-actions.jsx') ? { MessageActions: 'MessageActions' } : id === 'react' ? react : id.endsWith('use-chat-scroll.jsx') ? { useChatScroll: () => ({ root: null, host: null }) } : id.endsWith('quiet-chat.mjs') ? { quietChatRows } : id.endsWith('reply-stream.mjs') ? { projectReplyStream } : {} });
  const tree = module.exports.QuietChat({ session: { running: false }, home: { threadId: 'side', api: async (...args) => calls.push(args), history: { notifications: [{ eventId: 'e', threadId: 'side', text: '方案已准备好', options: ['就这么办'] }] } } });
  const walk = node => node && typeof node === 'object' ? [node, ...(node.children || []).flatMap(walk)] : [];
  const nodes = walk(tree);
  assert(nodes.some(node => node.props?.text === '方案已准备好'));
  const delivery = nodes.find(node => node.type === 'article');
  assert.equal(delivery.props['data-role'], 'assistant', 'delivery uses the ordinary assistant message');
  assert(!nodes.some(node => node.children?.includes('交付通知') || node.children?.includes('标记已读')), 'delivery has no notification heading or read action');
  await nodes.find(node => node.type === 'button' && node.children?.includes('就这么办')).props.onClick();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['notificationOption', { eventId: 'e', threadId: 'side', text: '就这么办' }]]);
  const streaming = walk(module.exports.QuietChat({ session: { running: true }, home: { sessionId: 's', history: { sessionId: 's', activeReply: { turn: 1, requestId: 'u' }, messages: [{ id: 'u', seq: 1, role: 'user', text: '问题' }] } }, chat: { legacy: { runningCalls: [{ name: 'assistant_reply', turn: 1, args: PartialArguments.fromText('{"text":"正式回复') }], partial: { blocks: [{ kind: 'reasoning', text: '隐藏推理' }] } } } }));
  assert(streaming.some(node => node.props?.text === '正式回复'));
  assert(!streaming.some(node => node.props?.text === '隐藏推理'));
  assert(!streaming.some(node => node.props?.['aria-label'] === '加载中'));
  const waiting = walk(module.exports.QuietChat({ session: { running: true }, home: {} }));
  assert(waiting.some(node => node.props?.role === 'status' && node.props?.['aria-label'] === '加载中'));
  assert(!waiting.some(node => node.children?.includes('加载中')));
  const questionApi = async () => {};
  const statusAndQuestion = walk(module.exports.QuietChat({ session: { running: true }, home: { api: questionApi, threadId: 'side', history: { notifications: [
    { eventId: 'system', threadId: 'side', text: '执行模型暂不可用', publication: { origin: 'system', systemState: { state: 'continuation_wait', code: 'MODEL_UNAVAILABLE', stage: 'execution' } } },
    { eventId: 'ask', type: 'ticket.attention', threadId: 'side', ticketId: 'original', instructionRevision: 1, currentInstructionRevision: 2, currentResultVersion: 3, ticketStatus: 'waiting', text: '采用哪个范围？', options: ['国内外'], attention: { id: 'a', question: { question: '采用哪个范围？' }, state: 'waiting' } },
  ] } } }));
  const system = statusAndQuestion.find(node => node.type === 'article' && node.props['data-role'] === 'system');
  assert(system);
  assert(!walk(system).some(node => node.children?.includes('系统状态')));
  assert(!walk(system).some(node => node.type === 'MessageActions'));
  const detailCalls = [];
  const fallbackTree = walk(module.exports.QuietChat({ session: { running: false }, home: { onOpenResources: (...args) => detailCalls.push(args),
    history: { notifications: [stateNotification] } } }));
  assert(fallbackTree.some(node => node.type === 'strong' && node.children.includes('资料整理')));
  assert(fallbackTree.some(node => node.type === 'span' && node.children.includes('执行记录已保留，等待恢复条件。')));
  const detail = fallbackTree.find(node => node.type === 'button' && node.children.includes('查看工单详情'));
  assert.equal(detail.props.variant, 'link');
  assert.equal(detail.props.size, 'sm');
  await detail.props.onClick();
  assert.deepEqual(JSON.parse(JSON.stringify(detailCalls)), [['tasks', { ticketId: 'ticket' }]]);
  assert(!fallbackTree.some(node => node.type === 'TicketWaiting' || node.props?.['aria-label'] === '工单执行会话'));
  const question = statusAndQuestion.find(node => node.type === 'TicketAttention');
  assert.equal(question.props.ticket.id, 'original');
  assert.equal(question.props.ticket.instructionRevision, 2);
  assert.equal(question.props.ticket.resultVersion, 3);
  assert.equal(question.props.ticket.status, 'waiting');
  assert.equal(question.props.api, questionApi);
  assert(!statusAndQuestion.some(node => node.type === 'button' && node.children?.includes('国内外')), 'Attention options belong to the version-bound answer form');
  const recoveryCalls = [];
  const recoveryEvent = { ticketId: 'original', ticketStatus: 'waiting', currentInstructionRevision: 2, currentResultVersion: 3,
    continuationWait: { code: 'EXECUTION_BUDGET_EXHAUSTED', sourceResultVersion: 3 }, threadId: 'side', text: '已答复，系统等待续做资源' };
  const recoveryTree = walk(module.exports.QuietChat({ session: { running: false }, home: { threadId: 'side', api: async (...args) => recoveryCalls.push(args), history: { notifications: [{ ...recoveryEvent, eventId: 'old', createdAt: 1 }, { ...recoveryEvent, eventId: 'new', createdAt: 2 }] } } }));
  assert(!recoveryTree.some(node => node.type === 'TicketWaiting'));
  assert(!statusAndQuestion.some(node => node.type === 'TicketWaiting'), 'question card is not followed by a duplicate waiting panel');
  assert.equal(recoveryCalls.length, 0);
  const opened = [];
  for (const executionSession of [undefined, { available: false }, { available: true, sessionId: 'worker' }]) {
    const tree = walk(module.exports.QuietChat({ session: { running: false }, home: { threadId: 'side',
      onOpenExecution: value => opened.push(value), onRefresh: () => opened.push('refresh'),
      history: { notifications: [{ ...recoveryEvent, eventId: 'current', executionSession }] } } }));
    assert(!tree.some(node => node.type === 'TicketWaiting' || node.props?.['aria-label'] === '工单执行会话'));
    for (const label of ['查看执行会话', '刷新状态', '停止工单']) assert(!tree.some(node => node.type === 'button' && node.children.includes(label)));
  }
  assert.deepEqual(opened, []);
  const schedule = walk(module.exports.ScheduleLifecycle({ row: { schedule: { phase: 'completed', ticketId: 'original' }, executionSession: { available: true } },
    onOpenResources: (...args) => opened.push(args), onOpenExecution: () => opened.push('execution') }));
  assert(!schedule.some(node => node.children.includes('查看执行会话')));
  await schedule.find(node => node.type === 'button' && node.children.includes('查看关联工单')).props.onClick();
  assert.deepEqual(JSON.parse(JSON.stringify(opened)), [['tasks', { ticketId: 'original' }]]);
});

test('quiet chat keeps answered question bubbles in history order', () => {
  const rows = quietChatRows({ messages: [
    { id: 'u1', seq: 1, role: 'user', text: '规划服务器', time: 1 },
    { id: 'question:c1', seq: 3, role: 'user', kind: 'question-reply', questions: [{ id: 'q', question: '预算？' }], answers: [{ id: 'q', selected: ['100 元内'] }], text: '预算？：100 元内', time: 2 },
    { id: 'reply:u1', seq: 5, role: 'assistant', kind: 'final', requestId: 'u1', text: '好的', time: 3 },
  ] }, 'main');
  assert.deepEqual(rows.map(row => row.kind || row.role), ['user', 'question-reply', 'final']);
});
