import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceSessionTitles } from '../src/session-title.mjs';

const route = { providerId: 'Opaque Provider:01', model: 'Opaque Model:02' };
const recordType = 'plugin:benchgo-plugin/voice-conversation';
function fixture({ generate, now = Date.now } = {}) {
  const events = [], requests = [], prepares = [], flushed = [];
  const session = { id: 'voice-session', snapshotEvents: () => events,
    append(type, data) { const event = { seq: events.length + 1, type, data }; events.push(event); return event.seq; } };
  const sessions = { get: id => id === session.id ? session : null, async flush(value) { flushed.push(value); } };
  const llm = { async prepareCall(config, signal) {
    prepares.push({ config, signal });
    return { config, async *stream(request) {
      requests.push(request);
      if (generate) { yield* generate(request); return; }
      yield { type: 'text-delta', index: 0, text: '优化语音通话体验' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    } };
  } };
  const titles = createVoiceSessionTitles({ llm, sessions, now });
  const voice = text => { session.append(recordType, { kind: 'user', text }); events.at(-1).ignorable = true; };
  voice('请优化语音通话开头卡顿的问题。');
  return { titles, session, sessions, events, requests, prepares, flushed, voice, llm };
}

test('纯语音摘要使用精确配置且只写一个官方标题，不创建正式用户消息', async () => {
  const f = fixture();
  f.session.append(recordType, { kind: 'assistant', text: 'MODEL TEXT MUST NOT BECOME USER INPUT' }); f.events.at(-1).ignorable = true;
  f.session.append(recordType, { kind: 'user', text: 'UNTRUSTED RECORD' });
  for (let i = 0; i < 10; i++) f.voice('有界语音'.repeat(200));
  const first = f.titles.refresh(f.session, route), second = f.titles.refresh(f.session, route);
  assert.equal(first, second);
  await first;
  assert.deepEqual(f.prepares[0].config, { provider: route.providerId, model: route.model, reasoningEffort: 'off', maxTokens: 64 });
  assert.equal(f.requests[0].purpose, 'session-title');
  const input = f.requests[0].messages[0].content[0].text;
  assert.ok(input.length <= 1800); assert.match(input, /开头卡顿/); assert.doesNotMatch(input, /MODEL TEXT|UNTRUSTED RECORD/);
  const title = f.events.find(event => event.type === 'session/title');
  assert.deepEqual(title.data, { title: '优化语音通话体验', messageSeqs: [], source: { kind: 'provider', provider: 'benchgo-voice', model: { provider: route.providerId, model: route.model } } });
  assert.deepEqual(f.flushed, [f.session]);
  assert.equal(f.events.some(event => event.type === 'user/message'), false);
  await f.titles.refresh(f.session, route);
  assert.equal(f.requests.length, 1);
  f.titles.dispose();
});

test('已有正式标题或正式人类消息交由官方处理，非人类注入不会触发执行', async () => {
  for (const event of [
    { type: 'session/title', data: { title: '手动命名', source: { kind: 'user' } } },
    { type: 'session/title', data: { title: '官方摘要', source: { kind: 'provider' } } },
    { type: 'session/title', data: { title: '官方回退', source: { kind: 'fallback' } } },
    { type: 'user/message', data: { source: { kind: 'user' } } },
  ]) {
    const f = fixture(); f.events.push(event);
    await f.titles.refresh(f.session, route);
    assert.equal(f.prepares.length, 0); f.titles.dispose();
  }
});

test('生成期间用户改名、官方接收任务或会话被替换时不覆盖', async () => {
  for (const update of [
    f => f.session.append('session/title', { title: '用户新标题', source: { kind: 'user' } }),
    f => f.session.append('user/message', { source: { kind: 'user' } }),
    f => { f.sessions.get = () => ({ id: f.session.id }); },
  ]) {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const f = fixture({ async *generate() { await gate; yield { type: 'text-delta', index: 0, text: '过期标题' }; yield { type: 'finish', reason: { kind: 'stop' } }; } });
    const work = f.titles.refresh(f.session, route);
    update(f); release(); await work;
    assert.equal(f.events.some(event => event.type === 'session/title' && event.data.title === '过期标题'), false);
    assert.equal(f.flushed.length, 0); f.titles.dispose();
  }
});

test('摘要失败与拒绝只限次冷却重试，不阻断通话', async () => {
  let time = 0;
  const f = fixture({ now: () => time, async *generate() { yield { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER' } } }; } });
  await f.titles.refresh(f.session, route);
  await f.titles.refresh(f.session, route);
  assert.equal(f.requests.length, 1);
  time = 30000; await f.titles.refresh(f.session, route);
  assert.equal(f.requests.length, 2);
  time = 60000; await f.titles.refresh(f.session, route);
  assert.equal(f.requests.length, 2);
  assert.equal(f.flushed.length, 0); f.titles.dispose();
});

test('插件退出中止不响应取消的摘要流，禁止后续写入', async () => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const f = fixture({ async *generate() { started(); await new Promise(() => {}); } });
  const work = f.titles.refresh(f.session, route);
  await ready; f.titles.dispose(); await work;
  assert.equal(f.prepares[0].signal.aborted, true);
  assert.equal(f.flushed.length, 0);
  await f.titles.refresh(f.session, route);
  assert.equal(f.requests.length, 1);
});

test('空语音或未配置路由不请求标题模型', async () => {
  const f = fixture(); f.events.length = 0;
  await f.titles.refresh(f.session, route);
  f.voice('真实发言');
  await f.titles.refresh(f.session, { providerId: '', model: '' });
  assert.equal(f.prepares.length, 0); f.titles.dispose();
});
