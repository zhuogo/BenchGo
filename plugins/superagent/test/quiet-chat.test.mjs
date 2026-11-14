import test from 'node:test';
import assert from 'node:assert/strict';
import { quietChatRows, historyReconcileSeq } from '../client/quiet-chat.mjs';
import { projectReplyStream, projectReplyRows, conversationActivity } from '../client/reply-stream.mjs';
import { continuationRecovery, taskSnapshot } from '../client/task-state.mjs';
import { PartialArguments } from '@deepseek-ai/dsh-util-values';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

test('official submission is visible immediately, reconciles by identity and withdraws on failure', () => {
  const pending = { requestId: 'rpc-1', placement: 'transcript', text: '你好', time: 1, attachments: [] };
  const session = { pendingSubmissions: [pending] };
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

test('running human input remains visible from accepted echo through official inbox, admission and durable history', () => {
  for (const [target, placement] of [['next-step', 'steering'], ['next-turn', 'queued']]) {
    const pending = { requestId: 'rpc', placement, text: '补充要求', time: 10, attachments: [] };
    const message = { id: 'human', source: { kind: 'user', rpcId: 'rpc' }, content: [{ type: 'text', text: '补充要求' }] };
    const inbox = { [target]: [message, { ...message, id: 'internal', source: { kind: 'benchgo-task-reply' } }] };
    const echo = quietChatRows({}, 'main', { pendingSubmissions: [pending] });
    assert.equal(echo.length, 1); assert.equal(echo[0].submissionState, placement);
    const accepted = quietChatRows({}, 'main', { pendingSubmissions: [pending] }, undefined, inbox);
    assert.equal(accepted.length, 1); assert.equal(accepted[0].text, '补充要求');
    assert.equal(accepted[0].key, echo[0].key);
    const afterEchoRetired = quietChatRows({}, 'main', {}, undefined, inbox);
    assert.equal(afterEchoRetired.length, 1); assert.equal(afterEchoRetired[0].submissionState, placement);
    const chat = { legacy: { nodes: [{ ...message, kind: 'steering', messageId: message.id, seq: 5, time: 10 }] } };
    const admitted = quietChatRows({}, 'main', { pendingSubmissions: [pending] }, chat, inbox);
    assert.equal(admitted.length, 1); assert.equal(admitted[0].submissionState, undefined);
    const history = { messages: [{ id: message.id, rpcId: 'rpc', seq: 5, role: 'user', text: '补充要求', time: 10 }] };
    const saved = quietChatRows(history, 'main', { pendingSubmissions: [pending] }, chat, inbox);
    assert.equal(saved.length, 1); assert.equal(saved[0].id, 'human');
    assert.equal(quietChatRows({}, 'main', {}, undefined, { [target]: [] }).length, 0, 'cancelled input has no retained local queue');
  }
});

test('private scheduling, recovery and execution requests cannot masquerade as human messages or send failures', () => {
  const requests = ['taskReply', 'taskState', 'executionInput'].flatMap(key => ['queued', 'failed', 'uncertain'].map(status => ({
    threadId: 'main', requestId: `${key}:${status}`, status, text: 'PRIVATE_NOTICE', error: 'PRIVATE_ERROR', [key]: {},
  })));
  requests.push({ threadId: 'main', requestId: 'schedule', status: 'failed', text: 'PRIVATE_SCHEDULE',
    message: { source: { kind: 'schedule' } } });
  assert.deepEqual(quietChatRows({ requests, messages: [{ id: 'private', role: 'user', text: 'PRIVATE_NOTICE', source: { kind: 'benchgo-task-reply' } }] }), []);
});

test('official inbox order survives retired echoes, edited queue order and skewed client clocks', () => {
  const message = id => ({ id, source: { kind: 'user', rpcId: id }, content: [{ type: 'text', text: id }] });
  const history = { messages: [{ id: 'reply', role: 'assistant', kind: 'final', text: '已有回复', time: 50 }] };
  const pending = id => ({ requestId: id, placement: 'queued', text: id, time: id === 'a' ? 100 : 1 });
  for (const echoes of [[], [pending('b')], [pending('a'), pending('b')]]) {
    const rows = quietChatRows(history, 'main', { pendingSubmissions: echoes }, undefined, { 'next-turn': [message('a'), message('b')] });
    assert.deepEqual(rows.map(row => row.text), ['已有回复', 'a', 'b']);
  }
  const reordered = quietChatRows(history, 'main', { pendingSubmissions: [pending('a'), pending('b')] }, undefined, { 'next-turn': [message('b'), message('a')] });
  assert.deepEqual(reordered.map(row => row.text), ['已有回复', 'b', 'a']);
  const newlyAccepted = quietChatRows(history, 'main', { pendingSubmissions: [pending('c')] }, undefined, { 'next-turn': [message('a'), message('b')] });
  assert.deepEqual(newlyAccepted.map(row => row.text), ['已有回复', 'a', 'b', 'c']);
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
    { id: 'n', type: 'task.result', origin: 'router', publication: { action: 'deliver' }, threadId: 'side', text: 'Done', createdAt: 2 },
    { id: 'n', type: 'task.result', origin: 'router', publication: { action: 'deliver' }, threadId: 'side', text: 'Done', createdAt: 2 },
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

const stateNotification = { type: 'task.result', eventId: 'notice:1', threadId: 'main', taskId: 'task', title: '资料整理',
  text: '【资料整理】\n\n系统状态：系统状态：执行记录已保留，等待恢复条件。', createdAt: 1,
  publication: { origin: 'system', systemState: { state: 'continuation_wait', code: 'MODEL_UNAVAILABLE', stage: 'execution' } } };

test('chat hides legacy metadata and Worker drafts while preserving Router expression and actual questions', () => {
  const router = { ...stateNotification, eventId: 'router', origin: 'router', text: '我已整理好结果，重点如下。',
    publication: { action: 'deliver', origin: 'router', text: '我已整理好结果，重点如下。' } };
  const question = { eventId: 'question', type: 'task.attention', origin: 'worker', threadId: 'main', text: '你更倾向哪个范围？',
    attention: { id: 'q', question: { question: '你更倾向哪个范围？' } } };
  const notifications = [stateNotification, router, question,
    { ...router, eventId: 'worker', origin: 'worker', publication: { action: 'deliver', origin: 'worker', text: '原始执行报告' } },
    { ...router, eventId: 'old-worker', origin: undefined, publication: { action: 'deliver', text: '旧版Worker结果' } },
    { ...router, eventId: 'schedule', type: 'schedule.lifecycle', schedule: { phase: 'completed' } },
    { eventId: 'ordinary-ask', threadId: 'main', text: '要继续吗？', options: ['继续'] },
    { ...question, eventId: 'missing-card', attention: undefined },
  ];
  assert.deepEqual(quietChatRows({ notifications }).map(row => row.eventId).sort(), ['question', 'router']);
  assert.deepEqual(quietChatRows({ messages: [{ id: 'old', role: 'assistant', kind: 'final', origin: 'worker', text: '旧原稿' }] }), []);
});

test('a persisted Router message replaces only its event and duplicate delivery UUIDs cannot replay it', () => {
  const notification = { ...stateNotification, origin: 'router', taskStateEventKey: 'assignment-system-state:worker:4:execution',
    publication: { action: 'deliver', origin: 'router', text: '资料整理暂时在等待恢复。' }, text: '资料整理暂时在等待恢复。' };
  const report = { id: 'reply:state', role: 'assistant', kind: 'final', text: '资料整理暂时在等待恢复，执行记录已保留。', time: 2, taskStateEventKey: 'notice:1' };
  const matching = { ...report, taskStateEventKey: notification.taskStateEventKey };
  assert.deepEqual(quietChatRows({ notifications: [notification], messages: [matching] }).map(row => row.id), [report.id]);
  for (const change of [{ taskStateEventKey: 'other' }, { taskStateEventKey: undefined }, { streaming: true }, { kind: 'draft' }, { text: '' }]) {
    assert(quietChatRows({ notifications: [notification], messages: [{ ...matching, ...change }] }).some(row => row.notification), 'unrelated, unfinished or empty messages cannot hide Router delivery');
  }
  assert.equal(quietChatRows({ notifications: [notification, { ...notification, eventId: 'another-uuid' }] }).length, 1);
  assert(quietChatRows({ notifications: [{ ...notification, eventId: 'notification-uuid' }], messages: [{ ...report, taskStateEventKey: 'notification-uuid' }] }).some(row => row.notification), 'notification UUID cannot replace the persisted outbox identity');
  assert.equal(quietChatRows({ notifications: [{ ...notification, taskStateEventKey: undefined, eventKey: 'event-key' }], messages: [{ ...report, eventKey: 'event-key', taskStateEventKey: undefined }] }).length, 1);
});

test('legacy state stays out of chat and ordinary send errors remain visible', () => {
  const history = { messages: [{ id: 'report', role: 'assistant', kind: 'final', text: '状态报告', taskStateEventKey: 'notice:1' }],
    notifications: [stateNotification, { ...stateNotification, eventId: 'notice:2' }],
    requests: [{ threadId: 'main', requestId: 'send', status: 'failed', text: '用户消息', error: '连接中断，消息发送失败', createdAt: 2 }] };
  const rows = quietChatRows(history);
  assert.equal(rows.filter(row => row.notification).length, 0);
  assert(rows.some(row => row.role === 'user' && row.text === '用户消息'));
  assert(rows.some(row => row.role === 'system' && row.text === '连接中断，消息发送失败'));
});

test('task acknowledgements require Router provenance and durable request identity', () => {
  const ack = { eventId: 'ack', type: 'task.accepted', threadId: 'main', origin: 'router', taskId: 'task', requestId: 'request', text: '好，我来整理。' };
  for (const invalid of [{ origin: undefined }, { origin: 'system' }, { taskId: undefined }, { requestId: undefined }]) {
    assert.equal(quietChatRows({ notifications: [{ ...ack, ...invalid }] }).length, 0);
  }
  assert.equal(quietChatRows({ notifications: [ack] })[0].text, ack.text);
});

test('history reconciles on nodes that change durable history, not on every settled step', () => {
  const user = { kind: 'user', seq: 3 }, step = { kind: 'assistant', seq: 4 }, tool = { kind: 'tool-result', name: 'read', seq: 5 };
  const published = { kind: 'tool-result', name: 'assistant_reply', seq: 6 }, notice = { kind: 'context', seq: 7 };
  const seq = nodes => historyReconcileSeq({ legacy: { nodes } });
  assert.equal(historyReconcileSeq(undefined), undefined);
  assert.equal(seq([]), undefined);
  assert.equal(seq([user]), 3);
  assert.equal(seq([user, step, tool, { ...step, seq: 8 }, { ...tool, seq: 9 }]), 3, 'steps and ordinary tool results keep the previous reconcile point');
  assert.equal(seq([user, step, tool, published]), 6, 'an executed publication reconciles immediately');
  assert.equal(seq([user, step, notice, { ...tool, seq: 8 }]), 7);
  assert.equal(seq([step, tool]), undefined);
});

test('option accompanies its body and uses the validated endpoint, never approval or raw send', async () => {
  const { transformSync } = createRequire(new URL('../../benchgo/package.json', import.meta.url))('esbuild');
  const code = transformSync(readFileSync(new URL('../client/quiet-chat.jsx', import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs' }).code;
  const react = { createElement: (type, props, ...children) => typeof type === 'function' ? type(props || {}) : ({ type, props: props || {}, children: children.flat(Infinity).filter(x => x != null && x !== false) }), memo: component => component, useCallback: callback => callback, useState: value => [value, () => {}], useRef: () => ({ current: null }), useEffect() {}, useSyncExternalStore: (_subscribe, snapshot) => snapshot() };
  const module = { exports: {} }, calls = [];
  runInNewContext(code, { module, exports: module.exports, require: id => id.endsWith('approval-review.jsx') ? { useApprovalIndex: () => ({ entries: [], current: { current: [] } }), InlineApproval: 'InlineApproval' } : id.endsWith('approval-flow.mjs') ? { approvalReminderNavigation: { subscribe() {}, getSnapshot: () => null } } : id.endsWith('/ui/button.jsx') ? { Button: 'button' } : id.endsWith('/ui/collapsible.jsx') ? { Disclosure: 'Disclosure' } : id.endsWith('task-state.mjs') ? { continuationRecovery, taskSnapshot } : id.endsWith('task-attention.jsx') ? { TaskAttention: 'TaskAttention' } : id.endsWith('message-actions.jsx') ? { MessageActions: 'MessageActions' } : id === 'react' ? react : id.endsWith('use-chat-scroll.jsx') ? { useChatScroll: () => ({ root: null, host: null }) } : id.endsWith('quiet-chat.mjs') ? { quietChatRows, historyReconcileSeq } : id.endsWith('reply-stream.mjs') ? { projectReplyStream, projectReplyRows, conversationActivity } : id.endsWith('conversation-activity.jsx') ? { ConversationActivity: 'ConversationActivity' } : {} });
  const tree = module.exports.QuietChat({ session: { running: false }, home: { threadId: 'side', api: async (...args) => calls.push(args), history: { notifications: [{ eventId: 'e', type: 'task.result', origin: 'router', publication: { action: 'ask' }, threadId: 'side', text: '方案已准备好', options: ['就这么办'] }] } } });
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
  assert(waiting.some(node => node.type === 'ConversationActivity' && node.props.activity.kind === 'waiting' && node.props.activity.subtle));
  assert(!waiting.some(node => node.children?.includes('加载中')));
  const questionApi = async () => {};
  const statusAndQuestion = walk(module.exports.QuietChat({ session: { running: true }, home: { api: questionApi, threadId: 'side', history: { notifications: [
    { eventId: 'system', threadId: 'side', text: '执行模型暂不可用', publication: { origin: 'system', systemState: { state: 'continuation_wait', code: 'MODEL_UNAVAILABLE', stage: 'execution' } } },
    { eventId: 'ask', type: 'task.attention', threadId: 'side', taskId: 'original', instructionRevision: 1, currentInstructionRevision: 2, currentResultVersion: 3, taskStatus: 'waiting', text: '采用哪个范围？', options: ['国内外'], attention: { id: 'a', question: { question: '采用哪个范围？' }, state: 'waiting' } },
  ] } } }));
  assert(!statusAndQuestion.some(node => node.type === 'article' && node.props['data-role'] === 'system'));
  const fallbackTree = walk(module.exports.QuietChat({ session: { running: false }, home: { history: { notifications: [stateNotification] } } }));
  assert(!fallbackTree.some(node => node.type === 'article'));
  assert(!fallbackTree.some(node => node.type === 'TaskWaiting' || node.props?.['aria-label'] === '任务执行会话'));
  const question = statusAndQuestion.find(node => node.type === 'TaskAttention');
  assert.equal(question.props.task.id, 'original');
  assert.equal(question.props.task.instructionRevision, 2);
  assert.equal(question.props.task.resultVersion, 3);
  assert.equal(question.props.task.status, 'waiting');
  assert.equal(question.props.api, questionApi);
  assert(!statusAndQuestion.some(node => node.type === 'button' && node.children?.includes('国内外')), 'Attention options belong to the version-bound answer form');
  const recoveryCalls = [];
  const recoveryEvent = { taskId: 'original', taskStatus: 'waiting', currentInstructionRevision: 2, currentResultVersion: 3,
    continuationWait: { code: 'EXECUTION_BUDGET_EXHAUSTED', sourceResultVersion: 3 }, threadId: 'side', text: '已答复，系统等待续做资源' };
  const recoveryTree = walk(module.exports.QuietChat({ session: { running: false }, home: { threadId: 'side', api: async (...args) => recoveryCalls.push(args), history: { notifications: [{ ...recoveryEvent, eventId: 'old', createdAt: 1 }, { ...recoveryEvent, eventId: 'new', createdAt: 2 }] } } }));
  assert(!recoveryTree.some(node => node.type === 'TaskWaiting'));
  assert(!statusAndQuestion.some(node => node.type === 'TaskWaiting'), 'question card is not followed by a duplicate waiting panel');
  assert.equal(recoveryCalls.length, 0);
  const opened = [];
  for (const executionSession of [undefined, { available: false }, { available: true, sessionId: 'worker' }]) {
    const tree = walk(module.exports.QuietChat({ session: { running: false }, home: { threadId: 'side',
      onOpenExecution: value => opened.push(value), onRefresh: () => opened.push('refresh'),
      history: { notifications: [{ ...recoveryEvent, eventId: 'current', executionSession }] } } }));
    assert(!tree.some(node => node.type === 'TaskWaiting' || node.props?.['aria-label'] === '任务执行会话'));
    for (const label of ['查看执行会话', '刷新状态', '停止任务']) assert(!tree.some(node => node.type === 'button' && node.children.includes(label)));
  }
  assert.deepEqual(opened, []);
  assert.equal(module.exports.ScheduleLifecycle, undefined);
});

test('quiet chat keeps answered question bubbles in history order', () => {
  const rows = quietChatRows({ messages: [
    { id: 'u1', seq: 1, role: 'user', text: '规划服务器', time: 1 },
    { id: 'question:c1', seq: 3, role: 'user', kind: 'question-reply', questions: [{ id: 'q', question: '预算？' }], answers: [{ id: 'q', selected: ['100 元内'] }], text: '预算？：100 元内', time: 2 },
    { id: 'reply:u1', seq: 5, role: 'assistant', kind: 'final', requestId: 'u1', text: '好的', time: 3 },
  ] }, 'main');
  assert.deepEqual(rows.map(row => row.kind || row.role), ['user', 'question-reply', 'final']);
});


test('channel mirrors remain visible in the actual quiet projection and reconcile live with paged history', () => {
  const source = { kind: 'benchgo-channel', channelSource: { channel: 'feishu', sourceType: 'direct', conversationId: 'oc_exact' }, mirrorKey: 'intake:one', direction: 'inbound' };
  const node = { kind: 'context', form: 'notice', producer: { role: 'inject', label: 'benchgo-channel' }, seq: 12, time: 12,
    source, content: [{ type: 'text', text: '飞书原文' }] };
  const chat = { legacy: { nodes: [node, { ...node, seq: 13, source: { kind: 'system' }, content: [{ type: 'text', text: 'PRIVATE context' }] }] } };
  const live = quietChatRows({}, 'channel-thread', {}, chat);
  assert.equal(live.length, 1); assert.equal(live[0].text, '飞书原文');
  assert.equal(live[0].key, 'message:channel:intake:one');
  assert.equal(quietChatRows({}, 'channel-thread', {}, { legacy: { nodes: [{ kind: 'user', seq: 11, source: { kind: 'user' }, content: [{ type: 'text', text: '本机回复' }] }, node] } }).length, 2, 'a newer live channel mirror cannot hide an admitted local user message');
  const history = { messages: [{ ...live[0] }, { ...live[0], id: 'channel:delivery:one', mirrorKey: 'delivery:one', direction: 'delivery', role: 'assistant', seq: 14, time: 14, text: '已交付结果' }] };
  assert.deepEqual(quietChatRows(history, 'channel-thread', {}, chat).map(row => row.text), ['飞书原文', '已交付结果']);
  assert.deepEqual(quietChatRows({ ...history, hasMore: true, messages: [history.messages[1]] }, 'channel-thread', {}, chat).map(row => row.text), ['已交付结果'], 'live nodes never reveal unloaded older pages');
  for (const patch of [{ source: { kind: 'system' } }, { mirrorKey: '' }, { direction: 'outbound' }, { role: 'assistant' }]) {
    assert.deepEqual(quietChatRows({ messages: [{ ...live[0], ...patch }] }), [], 'invalid channel rows cannot gain user or assistant visibility');
  }
});
