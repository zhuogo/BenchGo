import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationBridge, VOICE_CONVERSATION_RECORD } from '../src/conversation-bridge.mjs';

function fixture(options = {}) {
  const events = [], handlers = new Set(), questions = new Set(), prompts = [], cancellations = [];
  const session = { id: 'session', header: {}, snapshotEvents: () => events };
  const inbox = { nextTurn: [], nextStep: [], remove(id) { for (const key of ['nextTurn', 'nextStep']) this[key] = this[key].filter(item => item.id !== id); } };
  const agent = { status: 'idle', inbox, inject(message) { inbox.nextStep.push(message); }, cancel(...args) { cancellations.push(args); if (!options.stopStuck) this.status = 'idle'; }, whenIdle: async () => {} };
  const emit = (type, data, extras = {}) => {
    const event = { type, data, seq: events.length + 1, ...extras }; events.push(event);
    for (const fn of handlers) fn(session, event);
    return event;
  };
  const appendRecord = (target, type, data) => { assert.equal(target, session); return emit(type, data, { ignorable: true }).seq; };
  const ctx = {
    sessions: { get: id => id === session.id ? session : null, flush: async () => {} },
    agents: { get: id => id === session.id ? agent : null },
    sessionController: { async prompt(request, signal) {
      prompts.push(request); assert.ok(signal instanceof AbortSignal);
      await options.beforePrompt?.(request);
      if (options.reject) throw new Error('transport');
      const message = { id: `message-${prompts.length}`, source: { kind: 'user', rpcId: request.requestId }, content: request.content };
      if (request.mode === 'queue') {
        agent.status = 'running'; emit('turn/start', { turn: 1 }); emit('user/message', message);
      } else {
        inbox.nextStep.push(message); emit('agent/inbox/spliced', { inserted: [message] });
      }
      return { accepted: true };
    } },
    on(name, fn) { const group = name === 'user-questions/request' ? questions : handlers; group.add(fn); return () => group.delete(fn); },
  };
  const build = () => createConversationBridge(ctx, { appendRecord, stopTimeout: 1 });
  return { events, ctx, session, agent, emit, build, bridge: build(), prompts, cancellations, questions };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const execute = f => f.bridge.execute({ sessionId: 'session', requestId: 'first', text: '优化页面', task: '优化页面' });
const answer = (f, content, extras = {}) => f.emit('assistant/message', { turn: 1, step: 1, message: { content }, ...extras });

test('普通会话交接保留原 Agent；只等待接受，并返回官方消息身份', async () => {
  const f = fixture();
  assert.deepEqual(await f.bridge.describe('session'), { kind: 'ordinary' });
  const receipt = await execute(f);
  assert.equal(receipt.userMessageId, 'message-1');
  assert.equal(receipt.state, 'running');
  assert.equal(f.agent.status, 'running');
  assert.deepEqual(f.prompts[0], { sessionId: 'session', requestId: 'voice:first', content: [{ type: 'text', text: '优化页面' }], mode: 'queue' });
  f.bridge.dispose();
  assert.equal(f.cancellations.length, 0);
});

test('可信 Router 使用原层，Worker 和官方子会话不误判为普通会话', async () => {
  const f = fixture();
  f.ctx.assistant = { dispatch: async () => ({ role: { role: 'router' } }) };
  assert.deepEqual(await f.bridge.describe('session'), { kind: 'native', role: 'router' });
  await assert.rejects(execute(f), /原有对话层/);
  f.ctx.assistant.dispatch = async () => ({ role: { role: 'worker' } });
  assert.equal((await f.bridge.describe('session')).kind, 'unsupported');
  delete f.ctx.assistant; f.session.header.origin = 'subagent';
  assert.equal((await f.bridge.describe('session')).kind, 'unsupported');
  f.ctx.assistant = { dispatch: async () => { throw new Error('role unavailable'); } };
  await assert.rejects(f.bridge.describe('session'), /role unavailable/);
  assert.equal(f.prompts.length, 0);
});

test('并发幂等与不明接受状态不会重交任务', async () => {
  const f = fixture();
  const results = await Promise.all([execute(f), execute(f)]);
  assert.equal(f.prompts.length, 1);
  assert.equal(results[1].duplicate, true);
  const g = fixture({ reject: true });
  await assert.rejects(execute(g), /不会自动重复提交/);
  assert.equal((await execute(g)).state, 'unknown');
  assert.equal(g.prompts.length, 1);
});

test('已有工作或待办时不偷停、不覆盖、不排入新的语音任务', async () => {
  const f = fixture(); f.agent.status = 'running';
  await assert.rejects(execute(f), /原会话正在工作/);
  f.agent.status = 'idle'; f.agent.inbox.nextTurn.push({ id: 'other' });
  await assert.rejects(execute(f), /原会话正在工作/);
  assert.equal(f.prompts.length, 0); assert.equal(f.cancellations.length, 0);
});

test('只回传最终正文；思考、工具参数和执行前计划不朗读', async () => {
  const f = fixture(), updates = [];
  f.bridge.subscribe('session', event => updates.push(event));
  await execute(f);
  answer(f, [{ type: 'text', text: '我先研究一下。' }, { type: 'tool-call', name: 'read' }]);
  f.emit('tool/call', { turn: 1, name: 'read', arguments: 'SECRET' });
  f.emit('tool/result', { turn: 1, message: { content: [{ type: 'text', text: 'SECRET' }] } });
  answer(f, [{ type: 'reasoning', text: 'PRIVATE' }, { type: 'text', text: '页面已经调整好了。' }]);
  answer(f, [{ type: 'text', text: '中断的回复' }], { interrupted: true });
  f.emit('turn/end', { turn: 1, reason: { kind: 'completed' } }); await tick();
  assert.deepEqual(updates.filter(event => event.type === 'result').map(event => event.text), ['页面已经调整好了。']);
  assert.doesNotMatch(JSON.stringify(updates), /SECRET|PRIVATE|先研究|中断的回复/);
  assert.equal(f.bridge.status('session', 'first').state, 'completed');
});

test('修订关联原执行，提供消息身份，终态一致', async () => {
  const f = fixture(); await execute(f);
  const revision = await f.bridge.revise({ sessionId: 'session', requestId: 'change', text: '只改首页', task: '只改首页' });
  assert.equal(revision.executionRequestId, 'first'); assert.equal(revision.userMessageId, 'message-2');
  assert.equal(f.prompts[1].mode, 'steer');
  answer(f, [{ type: 'text', text: '首页已改好。' }]);
  f.emit('turn/end', { turn: 1, reason: { kind: 'completed' } }); await tick();
  assert.equal(f.bridge.status('session', 'change').state, 'completed');
  assert.equal(f.bridge.status('session', 'change').executionRequestId, 'first');
});

test('停止保留无关队列，移除本通话未消费修订，等待真实退出', async () => {
  const f = fixture(); await execute(f);
  await f.bridge.revise({ sessionId: 'session', requestId: 'change', text: '不用图片', task: '不用图片' });
  f.agent.inbox.nextTurn.push({ id: 'unrelated', source: { rpcId: 'other' } });
  assert.deepEqual(await f.bridge.stop({ sessionId: 'session', requestId: 'first' }), { requestId: 'first', state: 'cancelled', stopped: true });
  assert.equal(f.agent.inbox.nextStep.length, 0);
  assert.deepEqual(f.agent.inbox.nextTurn.map(item => item.id), ['unrelated']);
  assert.deepEqual(f.cancellations, [[{ kind: 'user' }, { keepInbox: true }]]);
  const g = fixture({ stopStuck: true }); await execute(g);
  assert.equal((await g.bridge.stop({ sessionId: 'session' })).stopped, false);
});

test('停止等待在途准入，不提前确认取消或让延迟交接漏停', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ beforePrompt: () => gate });
  const sending = execute(f);
  while (!f.prompts.length) await tick();
  let stopped = false;
  const stopping = f.bridge.stop({ sessionId: 'session', requestId: 'first' }).then(value => { stopped = true; return value; });
  await tick();
  assert.equal(stopped, false);
  assert.equal(f.events.some(event => event.data?.state === 'cancelled'), false);
  release();
  assert.equal((await sending).state, 'running');
  assert.deepEqual(await stopping, { requestId: 'first', state: 'cancelled', stopped: true });
  assert.equal(f.agent.status, 'idle');
  assert.equal(f.cancellations.length, 1);
  assert.equal((await execute(f)).duplicate, true);
  assert.equal(f.prompts.length, 1);
});

test('停止等待在途修订，清理迟到队列而不影响无关输入', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ beforePrompt: request => request.mode === 'steer' ? gate : undefined });
  await execute(f);
  const revising = f.bridge.revise({ sessionId: 'session', requestId: 'change', text: '只改首页', task: '只改首页' });
  while (f.prompts.length < 2) await tick();
  const stopping = f.bridge.stop({ sessionId: 'session', requestId: 'change' });
  f.agent.inbox.nextTurn.push({ id: 'unrelated', source: { rpcId: 'other' } });
  release();
  await revising;
  assert.equal((await stopping).stopped, true);
  assert.equal(f.agent.inbox.nextStep.length, 0);
  assert.deepEqual(f.agent.inbox.nextTurn.map(message => message.id), ['unrelated']);
  assert.equal(f.bridge.status('session', 'change').state, 'cancelled');
});

test('停止与真实完成同时到达时保留完成事实，不误报已经取消', async () => {
  const f = fixture(); await execute(f);
  answer(f, [{ type: 'text', text: '工作已经完成。' }]);
  f.emit('turn/end', { turn: 1, reason: { kind: 'completed' } });
  f.agent.status = 'idle';
  const receipt = await f.bridge.stop({ sessionId: 'session', requestId: 'first' });
  assert.deepEqual(receipt, { requestId: 'first', state: 'completed', stopped: false });
  assert.equal(f.cancellations.length, 0);
  assert.equal(f.events.some(event => event.data?.state === 'cancelled'), false);
});

test('重载从官方请求证据恢复事件绑定和停止权限，不重放', async () => {
  const f = fixture(); await execute(f); f.bridge.dispose(); f.bridge = f.build();
  assert.equal(f.bridge.status('session', 'first').state, 'running');
  const updates = []; f.bridge.subscribe('session', event => updates.push(event));
  answer(f, [{ type: 'text', text: '已完成。' }]);
  f.emit('turn/end', { turn: 1, reason: { kind: 'completed' } }); await tick();
  assert.equal(updates.find(item => item.type === 'result').text, '已完成。');
  assert.equal((await execute(f)).duplicate, true); assert.equal(f.prompts.length, 1);
  f.bridge.dispose(); f.bridge = f.build();
  assert.equal(f.bridge.status('session', 'first').state, 'completed');
  await assert.rejects(f.bridge.stop({ sessionId: 'session' }), /没有匹配/);
});

test('Voice 离线期间完成可从真实 turn/end 恢复终态', async () => {
  const f = fixture(); await execute(f); f.bridge.dispose();
  answer(f, [{ type: 'text', text: '离线时已完成。' }]);
  f.emit('turn/end', { turn: 1, reason: { kind: 'completed' } });
  f.bridge = f.build();
  assert.equal(f.bridge.status('session', 'first').state, 'completed');
  assert.equal(f.bridge.status('session', 'first').text, '离线时已完成。');
});

test('接受记录没有执行证据不能取消其他任务', async () => {
  const f = fixture();
  f.emit(VOICE_CONVERSATION_RECORD, { kind: 'execution', requestId: 'first', state: 'submitting' }, { ignorable: true });
  f.agent.status = 'running';
  assert.equal((await execute(f)).state, 'unknown');
  await assert.rejects(f.bridge.stop({ sessionId: 'session' }), /没有匹配/);
  assert.equal(f.cancellations.length, 0);
});

test('历史只用可信插件记录，已委派用户内容去重，正文有界无思考链', async () => {
  const f = fixture();
  await f.bridge.append('session', { kind: 'user', requestId: 'first', text: '优化页面' });
  await execute(f);
  f.emit(VOICE_CONVERSATION_RECORD, { kind: 'assistant', text: '不可信' });
  answer(f, [{ type: 'reasoning', text: 'PRIVATE' }, { type: 'text', text: '好'.repeat(5000) }]);
  const messages = await f.bridge.history('session', { maxCharacters: 4100 });
  assert.equal(messages.filter(item => item.role === 'user').length, 1);
  assert.equal(messages.at(-1).text.length, 4000);
  assert.doesNotMatch(JSON.stringify(messages), /PRIVATE|不可信/);
});

test('语音记录倒序分页但页内正序，保留完整用户原话并隔离普通事件', async () => {
  const f = fixture();
  await f.bridge.append('session', { kind: 'user', requestId: 'first', text: '优化页面' });
  await execute(f);
  await f.bridge.append('session', { kind: 'assistant', text: '开始了。' });
  const latest = await f.bridge.readRecords('session', { limit: 2 });
  assert.equal(latest.events.length, 2); assert.equal(latest.hasMore, true);
  assert.ok(latest.events[0].seq < latest.events[1].seq);
  const older = await f.bridge.readRecords('session', { limit: 100, before: latest.nextBefore });
  assert.equal(older.events[0].data.text, '优化页面');
  assert.ok(older.events.every(event => event.seq < latest.nextBefore && event.type === VOICE_CONVERSATION_RECORD));
  assert.equal(older.hasMore, false);
  latest.events[0].data.state = 'tampered';
  assert.notEqual((await f.bridge.readRecords('session', { limit: 2 })).events[0].data.state, 'tampered');
  await assert.rejects(f.bridge.readRecords('session', { limit: 101 }), /每页数量/);
  await assert.rejects(f.bridge.readRecords('session', { before: -1 }), /分页位置/);
});

test('原始层记录读取原会话正文与可信发布，模式不依赖 SuperAgent 导入', async () => {
  const f = fixture(); await execute(f);
  answer(f, [{ type: 'text', text: '执行回复' }]);
  f.emit('plugin:benchgo-plugin/chat-publication', { kind: 'final', text: '公开回复' }, { ignorable: true });
  f.emit('plugin:benchgo-plugin/chat-publication', { kind: 'final', text: '不可信' });
  const direct = await f.bridge.readRecords('session');
  assert.deepEqual(direct.events.map(event => event.type), ['user/message', 'assistant/message', 'plugin:benchgo-plugin/chat-publication']);
  assert.equal(direct.events.at(-1).ignorable, true);
  await f.bridge.append('session', { kind: 'user', text: '语音原话' });
  assert.ok((await f.bridge.readRecords('session')).events.every(event => event.type === VOICE_CONVERSATION_RECORD));
  assert.equal((await f.bridge.readRecords('session', { mode: 'native' })).events.length, 3);
  await assert.rejects(f.bridge.readRecords('session', { mode: 'other' }), /记录模式/);
});

test('Router 通话历史复用公开投影，模式省略或伪造也不返回内部事件', async () => {
  const f = fixture(), calls = [];
  f.emit('user/message', { id: 'private', source: { kind: 'benchgo-task-reply' }, content: [{ type: 'text', text: 'PRIVATE INPUT' }] });
  answer(f, [{ type: 'text', text: 'PRIVATE DRAFT' }]);
  const publication = f.emit('plugin:benchgo-plugin/chat-publication', { kind: 'task-reply', requestId: 'notice', text: '请确认权限。' }, { ignorable: true });
  const messages = [{ id: 'reply:notice', role: 'assistant', kind: 'final', seq: publication.seq, text: '请确认权限。', approval: { privateMetadata: 'PRIVATE' } }];
  f.ctx.assistant = { async dispatch(input) {
    calls.push(input);
    return input.action === 'sessionRole' ? { role: { role: 'router', threadId: 'side-thread' } }
      : { sessionId: 'session', messages, hasMore: true, nextBefore: publication.seq, notifications: ['PRIVATE'] };
  } };
  for (const mode of [undefined, 'native', 'direct', 'enhanced']) {
    const page = await f.bridge.readRecords('session', { before: 20, limit: 2, mode });
    assert.deepEqual(page.events, []); assert.equal(page.items[0].sourceId, `publication:${publication.seq}`);
    assert.equal(page.items[0].text, '请确认权限。'); assert.equal(page.hasMore, true); assert.equal(page.nextBefore, publication.seq);
    assert.doesNotMatch(JSON.stringify(page), /PRIVATE|approval|notifications/);
    assert.deepEqual(calls.at(-1), { action: 'history', threadId: 'side-thread', before: 20, limit: 2 });
  }
  assert.deepEqual(await f.bridge.history('session'), [{ role: 'assistant', text: '请确认权限。' }]);
  f.bridge.dispose();
});

test('Router 历史拒绝会话迁移、角色失效和服务停用后的私有回退', async () => {
  const f = fixture();
  await f.bridge.startCall('session', { callId: 'native-call', mode: 'native', startedAt: 1 });
  answer(f, [{ type: 'text', text: 'PRIVATE' }]);
  f.ctx.assistant = { dispatch: async input => input.action === 'sessionRole'
    ? { role: { role: 'router', threadId: 'main' } } : { sessionId: 'replacement-session', messages: [] } };
  await assert.rejects(f.bridge.readRecords('session'), /原总助手会话已改变/);
  f.ctx.assistant.dispatch = async () => ({ role: null });
  await assert.rejects(f.bridge.readRecords('session'), /归属已改变/);
  delete f.ctx.assistant;
  await assert.rejects(f.bridge.readRecords('session'), /总助手暂不可用/);
  await assert.rejects(f.bridge.history('session'), /总助手暂不可用/);
  f.bridge.dispose();
});

test('原生幕布按官方source区分用户和注入，保留真正首句与附件，过滤替换副本', async () => {
  const f = fixture();
  const first = f.emit('user/message', { id: 'first', source: { kind: 'user', rpcId: 'real-input' }, content: [
    { type: 'text', text: '请帮我看这份 context 文件，system 提示是文档正文。' },
    { type: 'file', attachment: { name: 'context.md', attachmentId: 'file:1' } },
    { type: 'image', attachment: { name: '页面.png', attachmentId: 'image:1' } },
  ] }, { surfaceOp: 'append' });
  for (const kind of ['runtime-context', 'benchgo-voice-context', 'file-mention', 'model-selection', 'retry', 'compact-checkpoint']) {
    f.emit('user/message', { id: kind, source: { kind }, content: [{ type: 'text', text: '不应显示的宿主上下文' }] }, { surfaceOp: 'append' });
  }
  f.emit('system/message', { content: [{ type: 'text', text: '系统指令' }] }, { surfaceOp: 'append' });
  f.emit('user/message', { ...first.data, id: 'replacement' }, { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 } });
  const reply = f.emit('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'reasoning', text: '隐私思考' }, { type: 'text', text: '正式回复。' }] } }, { surfaceOp: 'append' });
  f.emit('assistant/message', reply.data, { surfaceOp: { op: 'replace', startSeq: reply.seq, endSeq: reply.seq } });
  const page = await f.bridge.readRecords('session', { mode: 'native' });
  assert.deepEqual(page.events.map(event => event.seq), [first.seq, reply.seq]);
  assert.equal(page.events[0].surfaceOp, 'append');
  const history = await f.bridge.history('session');
  assert.deepEqual(history, [{ role: 'user', text: '请帮我看这份 context 文件，system 提示是文档正文。\n［文件：context.md］\n［图片：页面.png］' }, { role: 'assistant', text: '正式回复。' }]);
  f.bridge.dispose();
});

test('通话启动以真实生命周期占用原会话，callId幂等且不制造用户、模型或幕布消息', async () => {
  const f = fixture(), start = { callId: 'voice-call', mode: 'direct', startedAt: 1731000000000 };
  const [first, repeated] = await Promise.all([f.bridge.startCall('session', start), f.bridge.startCall('session', start)]);
  assert.deepEqual(first, repeated); assert.equal(f.events.length, 1);
  assert.equal(f.events[0].type, VOICE_CONVERSATION_RECORD);
  assert.deepEqual(f.events[0].data, { kind: 'call-start', requestId: start.callId, ...start });
  assert.equal(f.prompts.length, 0);
  assert.deepEqual(await f.bridge.history('session'), []);
  assert.deepEqual((await f.bridge.readRecords('session', { mode: 'direct' })).events, []);
  const restored = f.build(); assert.deepEqual(await restored.startCall('session', start), first);
  assert.equal(f.events.length, 1); restored.dispose(); f.bridge.dispose();
});

test('审批和提问只发一次安全提醒，核对所属执行并继续官方答复链', async () => {
  const f = fixture(), updates = []; f.bridge.subscribe('session', event => updates.push(event));
  await execute(f);
  f.emit('tool/call', { turn: 1, callId: 'owned', name: 'write' });
  f.emit('approval/asked', { id: 'wrong', callId: 'other', reason: '秘密参数' });
  f.emit('approval/asked', { id: 'permission', callId: 'owned', reason: '秘密参数' });
  f.emit('approval/asked', { id: 'permission', callId: 'owned' });
  let nextCalls = 0;
  const request = { agent: { id: 'session', session: f.session }, wait: { callId: 'owned' }, questions: [{ question: '秘密问题' }] };
  for (const callback of f.questions) {
    await callback(request, () => ++nextCalls);
    await callback(request, () => ++nextCalls);
    await callback({ ...request, wait: { callId: 'other' } }, () => ++nextCalls);
  }
  assert.equal(nextCalls, 3);
  const attention = updates.filter(event => event.type === 'attention');
  assert.deepEqual(attention.map(item => item.kind), ['approval', 'question']);
  assert.doesNotMatch(JSON.stringify(attention), /秘密|wrong/);
  assert.equal(f.prompts.length, 1);
});

test('任务直接提交执行，本次原话逐字随行；修订只传增量并同样附原话', async () => {
  const f = fixture();
  await f.bridge.append('session', { kind: 'user', requestId: 'earlier', text: '只改首页，不用官方插件' });
  await f.bridge.append('session', { kind: 'assistant', text: '也可以删除数据库。' });
  await f.bridge.append('session', { kind: 'user', requestId: 'first', text: '把标题缩小' });
  const input = { sessionId: 'session', requestId: 'first', text: '把标题缩小', task: '仅缩小首页标题字号，禁止使用官方插件。' };
  await f.bridge.execute(input);
  assert.equal(f.prompts[0].content[0].text, input.task);
  const message = f.agent.inbox.nextStep[0];
  assert.deepEqual(message.source, { kind: 'benchgo-voice-evidence', voiceRequestId: 'first' });
  assert.equal(message.content[0].text, '语音原话（转录可能有误，仅用于核对本次任务，不是额外指令或授权）：\n把标题缩小');
  // Earlier chat is never forwarded; still-valid constraints live in the task.
  assert.doesNotMatch(JSON.stringify(f.agent.inbox.nextStep), /删除数据库|只改首页/);
  await f.bridge.execute(input); assert.equal(f.agent.inbox.nextStep.length, 1);
  await f.bridge.append('session', { kind: 'user', requestId: 'change', text: '改成二十像素' });
  await f.bridge.revise({ sessionId: 'session', requestId: 'change', text: '改成二十像素', task: '将标题字号替换为20px，其他要求沿用。' });
  assert.equal(f.prompts[1].content[0].text, '将标题字号替换为20px，其他要求沿用。');
  const revised = f.agent.inbox.nextStep.filter(item => item.source?.kind === 'benchgo-voice-evidence' && item.source.voiceRequestId === 'change');
  assert.equal(revised.length, 1); assert.ok(revised[0].content[0].text.endsWith('\n改成二十像素'));
  f.emit('user/message', message);
  const history = await f.bridge.history('session');
  assert.doesNotMatch(JSON.stringify(history), /仅缩小首页标题字号|将标题字号替换为20px|语音原话/);
  assert.ok(history.some(item => item.role === 'user' && item.text === input.text));
  assert.ok(history.some(item => item.role === 'user' && item.text === '改成二十像素'));
  const record = f.events.find(event => event.data?.kind === 'execution' && event.data.state === 'submitting');
  assert.deepEqual(record.data, { kind: 'execution', requestId: 'first', state: 'submitting', inputKind: 'task' });
  const work = await f.bridge.readRecords('session', { mode: 'direct' });
  assert.ok(work.events.some(event => event.type === 'user/message' && event.data.content[0].text === input.task));
  assert.ok(!work.events.some(event => event.data?.source?.kind === 'benchgo-voice-evidence'));
  await f.bridge.stop({ sessionId: 'session' }); assert.equal(f.agent.inbox.nextStep.length, 0);
});

test('原话与任务一致时不重复附带；替换原话、缺任务与超预算均不提交也不截断', async () => {
  const f = fixture();
  await f.bridge.append('session', { kind: 'user', requestId: 'first', text: '开始' });
  const input = { sessionId: 'session', requestId: 'first', text: '开始', task: '整理任务' };
  await assert.rejects(f.bridge.execute({ ...input, task: '' }), /自包含任务正文/);
  await assert.rejects(f.bridge.execute({ ...input, task: '长'.repeat(16001) }), /超出预算/);
  await assert.rejects(f.bridge.execute({ ...input, text: '替换原话' }), /原始转录/);
  assert.equal(f.prompts.length, 0); assert.equal(f.agent.inbox.nextStep.length, 0);
  assert.equal(f.events.some(event => event.data?.kind === 'execution'), false);
  await f.bridge.execute({ ...input, task: ' 开始 ' });
  assert.equal(f.agent.inbox.nextStep.length, 0);
  assert.equal(f.prompts[0].content[0].text, ' 开始 ');
});

test('任务与原话各自最多 16000 字符且不截断，完整原口述同时留在语音记录', async () => {
  const f = fixture(), raw = '口'.repeat(16000), task = '任'.repeat(16000);
  await f.bridge.append('session', { kind: 'user', requestId: 'first', text: raw });
  await f.bridge.execute({ sessionId: 'session', requestId: 'first', text: raw, task });
  assert.equal(f.prompts[0].content[0].text, task);
  assert.ok(f.agent.inbox.nextStep[0].content[0].text.endsWith('\n' + raw));
  const records = await f.bridge.readRecords('session', { mode: 'enhanced' });
  assert.equal(records.events.find(event => event.data.kind === 'user').data.text, raw);
});

test('原会话不支持随行原话时在提交前明确拒绝，不留下未知送达记录', async () => {
  const f = fixture(); delete f.agent.inject;
  await f.bridge.append('session', { kind: 'user', requestId: 'first', text: '把标题缩小' });
  await assert.rejects(f.bridge.execute({ sessionId: 'session', requestId: 'first', text: '把标题缩小', task: '缩小首页标题字号。' }), /不支持随任务附带语音原话/);
  assert.equal(f.prompts.length, 0);
  assert.equal(f.events.some(event => event.data?.kind === 'execution'), false);
});

test('重载后语音历史保留原口述，任务副本与随行原话不混入，旧原话交接仍去重', async () => {
  const f = fixture();
  await f.bridge.append('session', { kind: 'user', requestId: 'first', text: '按刚才的做' });
  await f.bridge.execute({ sessionId: 'session', requestId: 'first', text: '按刚才的做', task: '将首页标题字号设置为24px。' });
  f.emit('user/message', f.agent.inbox.nextStep[0]);
  const restored = f.build();
  const speech = await restored.history('session');
  assert.equal(speech.filter(item => item.text === '按刚才的做').length, 1);
  assert.ok(!speech.some(item => /将首页标题字号设置为24px|语音原话/.test(item.text)));
  restored.dispose(); f.bridge.dispose();
  const legacy = fixture();
  await legacy.bridge.append('session', { kind: 'user', requestId: 'legacy', text: '旧原话' });
  await legacy.bridge.append('session', { kind: 'execution', requestId: 'legacy', state: 'accepted' });
  legacy.emit('user/message', { id: 'old', source: { kind: 'user', rpcId: 'voice:legacy' }, content: [{ type: 'text', text: '旧原话' }] });
  assert.deepEqual(await legacy.bridge.history('session'), [{ role: 'user', text: '旧原话' }]);
  legacy.bridge.dispose();
});

test('送达未知时撤回随行原话，重载仍不盲重发', async () => {
  const f = fixture({ reject: true });
  await f.bridge.append('session', { kind: 'user', requestId: 'first', text: '开始' });
  const input = { sessionId: 'session', requestId: 'first', text: '开始', task: '仅修改首页' };
  await assert.rejects(f.bridge.execute(input), /不会自动重复提交/);
  assert.equal(f.agent.inbox.nextStep.length, 0);
  const restored = f.build();
  assert.equal((await restored.execute(input)).state, 'unknown'); assert.equal(f.prompts.length, 1);
  assert.equal(f.agent.inbox.nextStep.length, 0);
  restored.dispose(); f.bridge.dispose();
});

test('修订送达未知不能借父执行状态误报接收，并撤回随行原话', async () => {
  const f = fixture({ beforePrompt(request) { if (request.mode === 'steer') throw new Error('transport'); } });
  await execute(f);
  await f.bridge.append('session', { kind: 'user', requestId: 'change', text: '按这个改' });
  const input = { sessionId: 'session', requestId: 'change', text: '按这个改', task: '新增约束：不用图片。' };
  await assert.rejects(f.bridge.revise(input), /不会自动重发/);
  assert.equal((await f.bridge.revise(input)).state, 'unknown');
  assert.equal(f.bridge.status('session', 'change').state, 'unknown');
  assert.ok(!f.agent.inbox.nextStep.some(item => item.source?.voiceRequestId === 'change'));
  assert.equal(f.prompts.length, 2);
});

test('进行中状态提供工具步数与最近公开正文供追问，不含思考与工具参数，重载可恢复', async () => {
  const f = fixture(), updates = []; f.bridge.subscribe('session', event => updates.push(event));
  await execute(f);
  assert.deepEqual(f.bridge.status('session'), { requestId: 'first', state: 'running' });
  answer(f, [{ type: 'reasoning', text: 'PRIVATE' }, { type: 'text', text: '我先看首页结构。' }, { type: 'tool-call', name: 'read' }]);
  f.emit('tool/call', { turn: 1, name: 'read', arguments: 'SECRET' });
  f.emit('tool/result', { turn: 1, message: { content: [{ type: 'text', text: 'SECRET' }] } });
  assert.equal(f.bridge.status('session').latestText, '我先看首页结构。');
  answer(f, [{ type: 'text', text: '长'.repeat(700) }, { type: 'tool-call', name: 'write' }]);
  f.emit('tool/call', { turn: 1, name: 'write', arguments: 'SECRET' });
  const status = f.bridge.status('session');
  assert.equal(status.steps, 2); assert.equal(status.latestText, '长'.repeat(600)); assert.equal(status.progress, '正在调用 write');
  assert.doesNotMatch(JSON.stringify(status), /SECRET|PRIVATE/);
  await tick();
  // Interim text answers a follow-up only; it is never pushed as a spoken result.
  assert.doesNotMatch(JSON.stringify(updates), /先看首页结构|长长/);
  f.bridge.dispose(); f.bridge = f.build();
  const restored = f.bridge.status('session');
  assert.equal(restored.steps, 2); assert.equal(restored.latestText, '长'.repeat(600));
  f.bridge.dispose();
});
