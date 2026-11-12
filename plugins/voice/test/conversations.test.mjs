import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceConversations } from '../src/conversations.mjs';
import { CallLeases } from '../src/calls.mjs';
import { publicConfig, updateConfig, VoiceError } from '../src/config.mjs';
import { createVoiceHandlers } from '../src/web.mjs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { bridge as httpBridge } from '../../../deepseek-harness/packages/client/connection/src/http-bridge.ts';
import { VoiceConversation } from '../client/conversation.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) { for (let i = 0; i < 200; i++) { if (predicate()) return; await tick(); } assert.fail('等待会话事件超时'); }
const text = value => [{ type: 'text-delta', index: 0, text: value }, { type: 'finish', reason: { kind: 'stop' } }];
const invoke = (name, args = {}) => [{ type: 'tool-call-delta', index: 0, id: 'tool-id', name, argumentsDelta: JSON.stringify(args) }, { type: 'finish', reason: { kind: 'tool-calls' } }];
function memory() {
  const listeners = new Set();
  return { value: { dictation: true, readAloud: true, call: true, conversation: { providerId: 'Opaque Provider:01', model: 'Opaque Model:02' }, asr: { baseURL: 'https://asr.test', model: 'asr', protocol: 'transcriptions-sse' }, tts: { baseURL: 'https://tts.test', model: 'tts', protocol: 'speech', voice: 'voice', speed: 1.2, stream: true } },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async configure(patch) { this.value = updateConfig(this.value, patch); for (const listener of listeners) listener(); return this.snapshot(); },
    snapshot() { return publicConfig(this.value); },
  };
}
function fixture(t, { kind = 'ordinary', script = [text('你好，有什么可以帮你？')] } = {}) {
  const store = memory(), leases = new CallLeases(), records = [], requests = [], executions = [], listeners = new Set(), prepares = [];
  let subscriptions = 0, executeStatus = null;
  const bridge = {
    async describe() { return { kind }; }, async history() { return []; },
    async handoffContext(sessionId, requestId) {
      const current = records.findIndex(record => record.kind === 'user' && record.requestId === requestId);
      return records.slice(0, current).filter(record => ['user', 'assistant'].includes(record.kind)).slice(-5)
        .map(record => ({ sourceSeq: records.indexOf(record) + 1, role: record.kind, text: record.text }));
    },
    async append(sessionId, data) { records.push({ sessionId, ...data }); },
    subscribe(sessionId, listener) { subscriptions++; listeners.add(listener); return () => listeners.delete(listener); },
    status() { return executeStatus; },
    async execute(value) { executions.push(value); executeStatus = { requestId: value.requestId, state: 'running' }; return { ...executeStatus, userMessageId: 'real-user' }; },
    async revise(value) { executions.push({ ...value, revision: true }); return { requestId: value.requestId, state: 'accepted', userMessageId: 'real-revision' }; },
    async stop() { executions.push({ stop: true }); return { stopped: true }; }, dispose() {},
    readRecords() { return { events: [], hasMore: false, nextBefore: null }; },
  };
  const llm = { async prepareCall(route) { prepares.push(route); return { config: { ...route }, stream: request => llm.stream(request) }; }, async *stream(request) {
    requests.push(request); const next = script.shift(); if (!next) throw Error('没有预设的模型回应');
    if (typeof next === 'function') { yield* next(request); } else for (const chunk of next) yield chunk;
  } };
  const api = createVoiceConversations({ store, llm, bridge, leases, snapshot: async () => store.snapshot() });
  const identity = leases.start({ sessionId: 'session', deviceId: 'device' }), input = { sessionId: identity.sessionId, deviceId: identity.deviceId, callId: identity.callId };
  const events = []; let reader;
  async function listen() { reader = api.events(input).getReader(); void (async () => { try { for (;;) { const item = await reader.read(); if (item.done) break; for (const line of new TextDecoder().decode(item.value).trim().split('\n')) events.push(JSON.parse(line)); } } catch {} })(); }
  t.after(() => { api.dispose(); leases.clear(); void reader?.cancel(); });
  return { api, store, leases, input, bridge, llm, records, requests, executions, prepares, events, script, listen,
    get subscriptions() { return subscriptions; }, emit(event) { for (const listener of listeners) listener(event); },
    async turn(value, requestId = 'request') { return api.turn({ ...input, requestId, text: value }); },
  };
}

test('增强通话使用精确路由，寒暄流式响应不执行，思考内容不外泄', async t => {
  const f = fixture(t, { script: [[{ type: 'reasoning-delta', index: 0, text: 'PRIVATE THOUGHT' }, { type: 'text-delta', index: 1, text: '你好。' }]] });
  assert.deepEqual(await f.api.open(f.input), { mode: 'enhanced' }); await f.listen();
  assert.deepEqual(await f.turn('你好'), { accepted: true, requestId: 'request' });
  await until(() => f.events.some(event => event.type === 'end'));
  assert.equal(f.executions.length, 0); assert.equal(f.requests[0].provider, 'Opaque Provider:01'); assert.equal(f.requests[0].model, 'Opaque Model:02');
  assert.ok(f.prepares.every(request => request.reasoningEffort === 'off'));
  assert.equal(f.requests[0].reasoningEffort, 'off');
  assert.equal(f.records.find(record => record.kind === 'assistant').text, '你好。');
  assert.doesNotMatch(JSON.stringify(f.events), /PRIVATE THOUGHT/);
  assert.equal(f.events.filter(event => event.type === 'start').length, 1);
});

test('首轮语音回复完成后后台摘要标题，不等待摘要才结束回复', async t => {
  const f = fixture(t), summaries = [];
  let complete;
  const pending = new Promise(resolve => { complete = resolve; });
  f.bridge.refreshTitle = (sessionId, route) => {
    assert.equal(f.records.at(-1).kind, 'assistant');
    summaries.push({ sessionId, route }); return pending;
  };
  await f.api.open(f.input); await f.listen(); await f.turn('帮我讨论语音优化');
  await until(() => f.events.some(event => event.type === 'end'));
  assert.deepEqual(summaries, [{ sessionId: 'session', route: { providerId: 'Opaque Provider:01', model: 'Opaque Model:02' } }]);
  complete();
});

test('标题回调同步失败不影响回复结束和下一轮正常交谈', async t => {
  const f = fixture(t, { script: [text('第一句回复'), text('继续正常回复')] });
  f.bridge.refreshTitle = () => { throw new Error('Session was removed before title refresh'); };
  await f.api.open(f.input); await f.listen(); await f.turn('你好', 'first');
  await until(() => f.events.some(event => event.type === 'end'));
  await f.turn('继续', 'second');
  await until(() => f.events.filter(event => event.type === 'end').length === 2);
  assert.equal(f.events.some(event => event.type === 'error'), false);
  assert.equal(f.records.filter(record => record.kind === 'assistant').length, 2);
});

test('恢复记录是历史资料而非当前模型自述，模型身份跟随实际请求路由', async t => {
  const history=[{role:'user',text:'不要使用官方插件，保留报告里的数字。'},{role:'assistant',text:'我分两层，跟你说话的是语音层。'}];
  const f=fixture(t,{script:[text('当前配置是 Opaque Model:02。'),text('我会保留你的要求。')]});
  f.bridge.history=async()=>history;
  await f.api.open(f.input);await f.listen();await f.turn('你是什么模型？','identity');
  await until(()=>f.events.some(event=>event.type==='end'));
  const request=f.requests[0],references=request.messages.filter(message=>message.content[0]?.text.startsWith('历史对话参考资料：'));
  assert.equal(references.length,1);assert.equal(references[0].role,'user');
  assert.match(references[0].content[0].text,/不要使用官方插件/);
  assert.match(references[0].content[0].text,/我分两层/);
  assert.equal(request.messages.some(message=>message.role==='assistant'&&message.content[0]?.text.includes('我分两层')),false);
  const runtime=JSON.parse(request.messages.find(message=>message.content[0]?.text.startsWith('宿主状态')).content[0].text.slice('宿主状态（数据）：'.length));
  assert.deepEqual(runtime.currentModel,{providerId:request.provider,model:request.model});
  assert.doesNotMatch(JSON.stringify(request.tools),/执行层|原会话|语音层/);
  assert.equal(JSON.stringify(history).includes('语音层'),true,'raw history is preserved');
  await f.turn('继续','continue');await until(()=>f.events.filter(event=>event.type==='end').length===2);
  assert(f.requests[1].messages.some(message=>message.role==='assistant'&&message.content[0]?.text==='当前配置是 Opaque Model:02。'),'new responses retain normal conversational roles');
  assert.equal(f.executions.length,0);
});

test('识别文本后的供应商失败显示真实安全分类，并保留同一通话供下一句恢复', async t => {
  const f = fixture(t, { script: [[{ type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER',
    message: '502: {"message":"PRIVATE UPSTREAM BODY","request_id":"provider-request-01"}' } } }], text('现在可以继续了。')] });
  await f.api.open(f.input); await f.listen(); await f.turn('你好，请帮我看看', 'failed-turn');
  await until(() => f.events.some(event => event.type === 'error'));
  const error = f.events.find(event => event.type === 'error');
  assert.match(error.error, /服务暂时异常.*SERVER.*HTTP 502/);
  assert.equal(error.requestId, 'failed-turn');
  assert.deepEqual(error.failure, { kind: 'error', code: 'SERVER', status: 502, requestId: 'provider-request-01', providerId: 'Opaque Provider:01', model: 'Opaque Model:02' });
  assert.doesNotMatch(JSON.stringify(f.events), /PRIVATE UPSTREAM/);
  assert.doesNotThrow(() => f.leases.owned(f.input));
  assert.equal(f.executions.length, 0);
  await f.turn('现在继续', 'recovery-turn');
  await until(() => f.events.filter(event => event.type === 'end').length === 2);
  assert.equal(f.events.filter(event => event.type === 'error').length, 1);
  assert.ok(f.events.some(event => event.type === 'text' && event.text === '现在可以继续了。'));
});

test('模型拒绝、截断、中止和认证失败各自报告原因，不误报同一个连接失败', async t => {
  for (const [reason, code] of [[{ kind: 'blocked' }, 'BLOCKED'], [{ kind: 'max-tokens' }, 'MAX_TOKENS'],
    [{ kind: 'aborted', failure: { code: 'ABORTED' } }, 'ABORTED'], [{ kind: 'error', failure: { code: 'AUTH', status: 401 } }, 'AUTH']]) {
    const f = fixture(t, { script: [[{ type: 'finish', reason }]] });
    await f.api.open(f.input); await f.listen(); await f.turn('你好');
    await until(() => f.events.some(event => event.type === 'error'));
    assert.equal(f.events.find(event => event.type === 'error').failure.code, code);
    assert.equal(f.executions.length, 0);
  }
});

test('三种通话绑定后记录启动标识一次；保存失败清理绑定并允许安全重试', async t => {
  for (const kind of ['ordinary', 'native', 'direct']) {
    const f = fixture(t, { kind: kind === 'direct' ? 'ordinary' : kind }), starts = [];
    if (kind === 'direct') await f.store.configure({ conversation: { providerId: '', model: '' } });
    f.bridge.startCall = async (sessionId, start) => starts.push({ sessionId, ...start });
    const [first, repeated] = await Promise.all([f.api.open(f.input), f.api.open(f.input)]);
    assert.equal(starts.length, 1); assert.equal(starts[0].callId, f.input.callId);
    assert.equal(starts[0].mode, first.mode); assert.deepEqual(first, repeated);
    assert.equal(f.requests.length, 0); assert.equal(f.executions.length, 0);
  }
  const f = fixture(t); let released = 0;
  f.bridge.subscribe = () => () => released++;
  f.bridge.startCall = async () => { throw Error('persist failed'); };
  await assert.rejects(f.api.open(f.input), /persist failed/); assert.equal(released, 1);
  assert.throws(() => f.api.events(f.input), /尚未启动/);
  f.bridge.startCall = async () => {};
  assert.equal((await f.api.open(f.input)).mode, 'enhanced');
});

test('交接保留原话与近期对话，只执行一次；进度静默，终态只表达一次', async t => {
  const f = fixture(t, { script: [text('想调整哪一页？'), invoke('delegate', { task: '调整首页，保留既有内容。', contextSourceSeqs: [1, 2] }), text('好，我开始看。'), text('首页已经改好了。')] });
  await f.api.open(f.input); await f.listen(); await f.turn('我想改页面', 'first');
  await until(() => f.events.filter(event => event.type === 'end').length === 1);
  await f.turn('首页，按刚才说的做', 'second');
  await until(() => f.records.some(record => record.kind === 'handoff'));
  await until(() => f.events.filter(event => event.type === 'end').length === 2);
  assert.equal(f.executions.length, 1); assert.equal(f.executions[0].text, '首页，按刚才说的做');
  assert.equal(f.executions[0].task, '调整首页，保留既有内容。');
  assert.deepEqual(f.executions[0].contextSourceSeqs, [1, 2]);
  assert.equal(Object.hasOwn(f.executions[0], 'context'), false);
  const runtime = JSON.parse(f.requests[1].messages.find(message => message.role === 'user' && message.content[0]?.text.startsWith('宿主状态')).content[0].text.slice('宿主状态（数据）：'.length));
  assert.deepEqual(runtime.handoffContext, [{ sourceSeq: 1, role: 'user', text: '我想改页面' }, { sourceSeq: 2, role: 'assistant', text: '想调整哪一页？' }]);
  assert.equal(f.records.find(record => record.kind === 'handoff').userMessageId, 'real-user');
  assert.equal((await f.turn('首页，按刚才说的做', 'second')).duplicate, true);
  await assert.rejects(f.turn('换个原话', 'second'), /不能替换/);
  const before = f.requests.length; f.emit({ type: 'progress', requestId: 'second', progress: '读取首页' }); await tick();
  assert.equal(f.requests.length, before);
  f.emit({ type: 'result', requestId: 'second', text: '首页改好了' }); f.emit({ type: 'completed', requestId: 'second', text: '首页改好了' });
  await until(() => f.events.filter(event => event.type === 'end').length === 3);
  assert.equal(f.requests.length, before + 1); assert.deepEqual(f.requests.at(-1).tools, []);
  assert.ok(f.requests.every(request => request.reasoningEffort === 'off'));
});

test('交互模型无法关闭思考时在通话启动前明确拒绝，不调用执行层', async t => {
  const f = fixture(t);
  f.llm.prepareCall = async request => ({ config: { ...request, reasoningEffort: 'high' } });
  await assert.rejects(f.api.open(f.input), error => error.status === 409 && /未实际关闭思考/.test(error.message));
  assert.equal(f.requests.length, 0); assert.equal(f.executions.length, 0);
});

test('缺失任务、伪造字段和无效来源不执行；模型可在同轮整理后提交', async t => {
  const f = fixture(t, { script: [invoke('delegate'), invoke('delegate', { task: '调整首页', text: '伪造原话' }),
    invoke('delegate', { task: '调整首页', contextSourceSeqs: [1, 1] }), invoke('delegate', { task: '调整首页，禁止删除现有文件。' }), text('我来调整。')] });
  await f.api.open(f.input); await f.listen(); await f.turn('调整首页，不要删除文件');
  await until(() => f.events.some(event => event.type === 'end'));
  assert.equal(f.executions.length, 1);
  assert.equal(f.executions[0].text, '调整首页，不要删除文件');
  assert.equal(f.executions[0].task, '调整首页，禁止删除现有文件。');
  assert.equal(f.requests.at(-1).messages.filter(message => message.role === 'tool' && message.isError).length, 3);
});

test('修订仅提交模型整理的增量，早期约束仍在语音层理解历史中', async t => {
  const f = fixture(t, { script: [text('记住了。'), text('可以。'), text('继续说。'),
    invoke('delegate', { task: '优化首页，只改样式，不使用官方 DeepSeek 插件，保留文件。' }), text('我来处理。'),
    invoke('revise_execution', { task: '将首页标题字号改为 18px，原有禁止插件与保留文件约束继续生效。' }), text('我会按新字号调整。')] });
  await f.api.open(f.input); await f.listen();
  for (const [i, value] of ['不要使用官方 DeepSeek 插件，也不要删除文件', '我们只调整样式', '页面是首页', '现在开始', '标题改成18px'].entries()) {
    await f.turn(value, `turn-${i}`);
    await until(() => f.events.filter(event => event.type === 'end').length === i + 1);
  }
  assert.equal(f.executions.length, 2);
  assert.equal(f.executions[1].revision, true);
  assert.equal(f.executions[1].text, '标题改成18px');
  assert.equal(f.executions[1].task, '将首页标题字号改为 18px，原有禁止插件与保留文件约束继续生效。');
  const request = f.requests[3];
  assert.match(JSON.stringify(request.messages), /不要使用官方 DeepSeek 插件，也不要删除文件/);
  const state = JSON.parse(request.messages.findLast(message => message.role === 'user' && message.content[0]?.text.startsWith('宿主状态')).content[0].text.slice('宿主状态（数据）：'.length));
  assert.equal(state.handoffContext.length, 5);
  assert.equal(state.handoffContext.some(item => item.text.includes('不要使用官方')), false);
});

test('桥拒绝超预算任务后允许同轮精炼，未知送达后不再尝试提交', async t => {
  for (const status of [400, 409]) {
    const f = fixture(t, { script: [invoke('delegate', { task: '待精炼任务' }), invoke('delegate', { task: '精炼后任务，保留约束。' }), text('请查看实际状态。')] });
    const execute = f.bridge.execute; let attempts = 0;
    f.bridge.execute = value => {
      if (++attempts === 1) throw new VoiceError(status === 400 ? '超出预算，请重新组织' : '送达尚未确认，不会自动重发', status);
      return execute(value);
    };
    await f.api.open(f.input); await f.listen(); await f.turn('请执行并保留约束');
    await until(() => f.events.some(event => event.type === 'end'));
    assert.equal(attempts, status === 400 ? 2 : 1);
    assert.equal(f.executions.length, status === 400 ? 1 : 0);
  }
});

test('语音要求调整语速保存真实配置，下一次读取一致，不结束通话', async t => {
  const f = fixture(t, { script: [invoke('set_voice_speed', { speed: 1.5 }), text('好，语速调到一点五倍。'), invoke('get_voice_settings'), text('现在是一点五倍。')] });
  await f.api.open(f.input); await f.listen(); await f.turn('把你的语速调到 1.5');
  await until(() => f.events.some(event => event.type === 'end'));
  assert.equal(f.store.value.tts.speed, 1.5); assert.equal(f.events.find(event => event.type === 'config').config.tts.speed, 1.5);
  assert.doesNotThrow(() => f.leases.owned(f.input));
  await f.turn('现在语速多少？', 'read'); await until(() => f.events.filter(event => event.type === 'end').length === 2);
  const reply = f.requests.at(-1).messages.findLast(message => message.role === 'tool'); assert.equal(JSON.parse(reply.content[0].text).speed, 1.5);
});

test('不允许模型擅改语速，缺失和越界参数均返回工具失败', async t => {
  const f = fixture(t, { script: [invoke('set_voice_speed', { speed: 1.5 }), text('你好。'), invoke('set_voice_speed'), text('请给出具体倍速。'), invoke('set_voice_speed', { speed: 8 }), text('这个倍速不支持。')] });
  await f.api.open(f.input); await f.listen();
  for (const [i, value] of ['你好', '调整语速', '把语速调到8'].entries()) { await f.turn(value, String(i)); await until(() => f.events.filter(event => event.type === 'end').length === i + 1); }
  assert.equal(f.store.value.tts.speed, 1.2); assert.equal(f.events.some(event => event.type === 'config'), false);
  for (const index of [1, 3, 5]) assert.equal(f.requests[index].messages.findLast(message => message.role === 'tool').isError, true);
});

test('native 绕过额外模型且不受普通通话交互配置调整影响；缺配明确direct', async t => {
  const native = fixture(t, { kind: 'native' }); assert.equal((await native.api.open(native.input)).mode, 'native'); assert.equal(native.prepares.length, 0);
  await native.store.configure({ conversation: { providerId: 'new', model: 'new' } }); assert.doesNotThrow(() => native.leases.owned(native.input));
  await assert.rejects(native.turn('你好'), /原有会话/); assert.equal(native.requests.length, 0);
  const direct = fixture(t); await direct.store.configure({ conversation: { providerId: '', model: '' } });
  assert.equal((await direct.api.open(direct.input)).mode, 'direct'); assert.equal(direct.prepares.length, 0);
});

test('并发open只订阅一次，交互模型配置变化清理对应租约', async t => {
  const f = fixture(t); const results = await Promise.all([f.api.open(f.input), f.api.open(f.input)]);
  assert.deepEqual(results, [{ mode: 'enhanced' }, { mode: 'enhanced' }]); assert.equal(f.subscriptions, 1);
  await f.store.configure({ conversation: { model: 'other-model' } }); assert.throws(() => f.leases.owned(f.input), /expired/);
});

test('三种通话接入都复核可信角色，角色变化或适配失效结束租约', async t => {
  for (const mode of ['enhanced', 'direct', 'native']) {
    for (const changed of ['role', 'unsupported', 'unavailable']) {
      const f = fixture(t, { kind: mode === 'native' ? 'native' : 'ordinary' });
      if (mode === 'direct') await f.store.configure({ conversation: { providerId: '', model: '' } });
      assert.equal((await f.api.open(f.input)).mode, mode);
      await f.api.validate(f.input);
      f.bridge.describe = async () => {
        if (changed === 'unavailable') throw Error('private adapter diagnostic');
        return { kind: changed === 'unsupported' ? 'unsupported' : mode === 'native' ? 'ordinary' : 'native' };
      };
      await assert.rejects(f.api.validate(f.input), error => error.status === 409 && /归属或执行适配已改变/.test(error.message) && !/private/.test(error.message));
      assert.throws(() => f.leases.owned(f.input), /expired/);
      assert.equal(f.executions.length, 0);
      assert.equal(f.requests.length, 0);
    }
  }
});

test('新转录前角色变化，不存入或提交旧交互层', async t => {
  const f = fixture(t); await f.api.open(f.input);
  f.bridge.describe = async () => ({ kind: 'native' });
  await assert.rejects(f.turn('执行这个任务'), /归属或执行适配已改变/);
  assert.equal(f.records.length, 0); assert.equal(f.requests.length, 0);
  assert.throws(() => f.leases.owned(f.input), /expired/);
});

test('打开通话期间路由变化或服务停用，不安装过期交互层', async t => {
  for (const change of ['route', 'dispose']) {
    let release, preparing = false;
    const gate = new Promise(resolve => { release = resolve; });
    const f = fixture(t);
    const prepare = f.llm.prepareCall;
    f.llm.prepareCall = async (...args) => { preparing = true; await gate; return prepare(...args); };
    const opening = f.api.open(f.input);
    await until(() => preparing);
    if (change === 'route') await f.store.configure({ conversation: { model: 'changed-during-open' } });
    else f.api.dispose();
    release();
    await assert.rejects(opening, change === 'route' ? /配置已改变/ : /服务已停用/);
    assert.equal(f.subscriptions, 0);
    await assert.rejects(f.turn('你好'), /尚未启动/);
  }
});

test('打断仅停止交互，后台执行结果暂存并随下一轮表达，不自动重派', async t => {
  const f = fixture(t, { script: [invoke('delegate', { task: 'Inspect the home page and preserve existing content.' }), text('开始了。'), text('已经完成了。')] });
  await f.api.open(f.input); await f.listen(); await f.turn('帮我看首页');
  await until(() => f.events.some(event => event.type === 'end')); f.api.interrupt(f.input);
  f.emit({ type: 'completed', requestId: 'request', text: '首页已完成' }); await tick(); await tick();
  assert.equal(f.requests.length, 2); assert.equal(f.executions.length, 1);
  await f.turn('结果怎么样？', 'next'); await until(() => f.events.filter(event => event.type === 'end').length === 2);
  assert.match(JSON.stringify(f.requests.at(-1).messages), /首页已完成/); assert.equal(f.executions.length, 1);
});

test('进行中的交互可立即打断，末尾记录标为中断，租约隔离且事件可恢复', async t => {
  let generated;
  const f = fixture(t, { script: [async function* (request) { yield { type: 'text-delta', index: 0, text: '我正在说' }; generated = true; await new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })); }] });
  await f.api.open(f.input); await f.listen(); await f.turn('你好'); await until(() => generated);
  assert.throws(() => f.api.interrupt({ ...f.input, deviceId: 'other' }), /another device/);
  f.api.interrupt(f.input); await until(() => f.records.some(record => record.kind === 'assistant'));
  assert.equal(f.records.find(record => record.kind === 'assistant').interrupted, true);
  await tick(); assert.equal(f.events.some(event => event.type === 'error'), false);
  assert.equal(f.executions.length, 0);
  const restored = f.api.events({ ...f.input, afterSeq: 0 }).getReader(); const chunk = await restored.read(); assert.match(new TextDecoder().decode(chunk.value), /"type":"start"/); await restored.cancel();
});

test('首字前插话的AbortError不误报MODEL_ERROR，下一句仍可正常回复', async t => {
  let started;
  const f = fixture(t, { script: [async function* (request) {
    started = true;
    await new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }));
  }, text('我在，继续说。')] });
  await f.api.open(f.input); await f.listen(); await f.turn('第一句', 'old'); await until(() => started);
  f.api.interrupt(f.input);
  await f.turn('改一下，先听我说', 'new');
  await until(() => f.events.some(event => event.type === 'end' && event.requestId === 'new'));
  assert.equal(f.events.some(event => event.type === 'error'), false);
  assert.ok(f.events.some(event => event.type === 'text' && event.requestId === 'new' && event.text === '我在，继续说。'));
  assert.equal(f.executions.length, 0);
});

test('没有本地取消时上游中止与超时仍报告真实失败并关联当前回复', async t => {
  for (const [name, code] of [['AbortError', 'ABORTED'], ['TimeoutError', 'TIMEOUT']]) {
    const f = fixture(t, { script: [async function* () { throw new DOMException('private upstream detail', name); }] });
    await f.api.open(f.input); await f.listen(); await f.turn('需要回应', 'current');
    await until(() => f.events.some(event => event.type === 'error'));
    const failure = f.events.find(event => event.type === 'error');
    assert.equal(failure.failure.code, code);
    assert.equal(failure.requestId, 'current');
    assert.equal(failure.messageId, f.events.find(event => event.type === 'end').messageId);
    assert.doesNotMatch(JSON.stringify(failure), /private upstream detail/);
  }
});

test('打断同时取消等待中的旧交互，保留原文记录而不迟到执行', async t => {
  let started;
  const f = fixture(t, { script: [async function* (request) { started = true; await new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })); }, invoke('delegate', { task: 'Inspect the home page and preserve existing content.' }), text('开始执行。')] });
  await f.api.open(f.input); await f.listen(); await f.turn('第一句'); await until(() => started);
  await f.turn('旧的第二句，请执行', 'queued'); f.api.interrupt(f.input); await tick(); await tick(); await tick();
  assert.equal(f.requests.length, 1); assert.equal(f.executions.length, 0);
  assert.equal(f.records.some(record => record.kind === 'user' && record.requestId === 'queued'), true);
});

test('审批与提问事实仅表达一次，不启用执行工具', async t => {
  const f = fixture(t, { script: [text('需要你确认权限，请到原会话处理。')] }); await f.api.open(f.input); await f.listen();
  const fact = { type: 'attention', requestId: 'task', id: 'approval:one', kind: 'approval', text: '请到原会话确认权限' }; f.emit(fact); f.emit(fact);
  await until(() => f.events.some(event => event.type === 'end'));
  assert.equal(f.requests.length, 1); assert.deepEqual(f.requests[0].tools, []); assert.equal(f.executions.length, 0);
});

const json = (value, headers = {}) => new Request('http://app.test/api/voice/conversation', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(value) });
test('官方HTTP桥在首次用户讲话之前完成增强通话连接，握手期限不截断静默通话', { timeout: 5000 }, async t => {
  const f = fixture(t), events = [], errors = [];
  const handlers = createVoiceHandlers(f.store, { llm: f.llm, conversationBridge: f.bridge });
  const carrier = { requestBodyMode: () => 'streaming', fetch: request => new URL(request.url).pathname === '/api/voice' ? handlers.config(request) : handlers.conversation(request) };
  const server = createServer((request, response) => { void httpBridge(request, response, carrier, {}).catch(error => response.destroy(error)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  let client;
  t.after(async () => { await client?.dispose(); handlers.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const config = async input => fetch(origin + '/api/voice', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(2000) });
  const started = await config({ action: 'call.start', sessionId: 'session', deviceId: 'device' });
  assert.equal(started.status, 200);
  const result = await started.json(), identity = { sessionId: 'session', deviceId: 'device', callId: result.call.callId };
  assert.equal(result.conversation.mode, 'enhanced');
  client = new VoiceConversation({ endpoint: origin + '/api/voice/conversation', identity, connectTimeoutMs: 1000, onEvent: event => events.push(event), onError: error => errors.push(error) });
  await client.start();
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(client.controller.signal.aborted, false);
  assert.deepEqual(events, []); // Transport readiness is never spoken or recorded.
  assert.deepEqual(f.records, []); assert.equal(f.requests.length, 0);
  assert.equal((await config({ action: 'call.heartbeat', ...identity })).status, 200);
  await client.send('你好', 'http-first-turn');
  await until(() => events.some(event => event.type === 'end'));
  assert.equal(events.filter(event => event.type === 'text').map(event => event.text).join(''), '你好，有什么可以帮你？');
  await client.dispose();
  assert.equal((await config({ action: 'call.end', ...identity })).status, 200);
  assert.equal((await config({ action: 'call.heartbeat', ...identity })).status, 409);
  assert.deepEqual(errors, []);
});

test('完整HTTP启动、长连接、交互、语速变更和历史分页沿相同受保护入口', async t => {
  const f = fixture(t, { script: [invoke('set_voice_speed', { speed: 1.5 }), text('调好了。')] });
  const handlers = createVoiceHandlers(f.store, { llm: f.llm, conversationBridge: f.bridge }); t.after(() => handlers.dispose());
  const started = await handlers.config(json({ action: 'call.start', sessionId: 'session', deviceId: 'device' })); assert.equal(started.status, 200);
  const value = await started.json(), input = { sessionId: 'session', deviceId: 'device', callId: value.call.callId };
  assert.equal(value.conversation.mode, 'enhanced');
  const response = await handlers.conversation(json({ action: 'events', ...input })); assert.match(response.headers.get('content-type'), /ndjson/); const reader = response.body.getReader(); t.after(() => reader.cancel());
  assert.equal((await handlers.conversation(json({ action: 'turn', ...input, requestId: 'http', text: '把你的语速调到1.5' }))).status, 200);
  const seen = []; for (;;) { const chunk = await reader.read(); const event = JSON.parse(new TextDecoder().decode(chunk.value)); seen.push(event); if (event.type === 'end') break; }
  assert.equal(f.store.value.tts.speed, 1.5); assert.equal(seen.some(event => event.type === 'config'), true);
  assert.equal((await handlers.config(json({ action: 'call.heartbeat', ...input }))).status, 200);
  assert.equal((await handlers.conversation(json({ action: 'interrupt', ...input, deviceId: 'attacker' }))).status, 409);
  assert.equal((await handlers.conversation(json({ action: 'history', sessionId: 'session' }, { origin: 'https://attacker.test' }))).status, 403);
  f.bridge.readRecords = (sessionId, options) => { assert.equal(sessionId, 'session'); assert.equal(options.before, 30); return { events: [{ type: 'plugin:benchgo-plugin/voice-conversation', ignorable: true, seq: 20, data: { kind: 'assistant', messageId: 'message', text: '调好了。', interrupted: true } }], hasMore: true, nextBefore: 20 }; };
  const history = await (await handlers.conversation(json({ action: 'history', sessionId: 'session', before: 30 }))).json();
  assert.equal(history.items[0].partial, false); assert.equal(history.items[0].interrupted, true); assert.equal(history.items[0].text, '调好了。'); assert.equal(history.nextBefore, 20);
  const publicItems = [1, 2].map(id => ({ id: `notice:${id}`, sourceId: `publication:${id}`, role: 'assistant', text: '请确认。', seq: id, partial: false }));
  f.bridge.readRecords = async () => ({ items: publicItems, events: [], hasMore: false, nextBefore: null });
  const publicHistory = await (await handlers.conversation(json({ action: 'history', sessionId: 'session' }))).json();
  assert.deepEqual(publicHistory.items, publicItems); assert.deepEqual(publicHistory.events, []);
  f.bridge.describe = async () => ({ kind: 'native' });
  const changed = await handlers.config(json({ action: 'call.heartbeat', ...input }));
  assert.equal(changed.status, 409); assert.match((await changed.json()).error, /归属或执行适配已改变/);
  assert.equal((await handlers.config(json({ action: 'call.heartbeat', ...input }))).status, 409);
});
