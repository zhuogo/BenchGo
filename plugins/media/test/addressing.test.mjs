import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VoiceConfig, defaultListening, publicConfig, updateConfig } from '../src/config.mjs';
import { addressingInput, decideAddressing, readAddressingAnswer, listeningSnapshot } from '../src/addressing.mjs';
import { createVoiceHandlers } from '../src/web.mjs';
import { createVoiceSettingsAdapter } from '../src/settings-adapter.mjs';

const route = () => ({ ...defaultListening(), enabled: true, endpoint: 'https://decision.test/v1/systemone', wakeWord: 'BenchGo', apiKey: 'fixture-private-key' });
const answer = (choice = 'addressed', probabilities = { addressed: .91, background: .04, uncertain: .05 }, extra = {}) => ({ model: 'dec-1', answers: { addressing: { type: 'choice', choice, probabilities, ...extra } } });
const request = (value, signal) => new Request('http://app.test/api/voice', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value), signal });
const flush = () => new Promise(resolve => setImmediate(resolve));
const memory = () => {
  const listeners = new Set();
  return { value: { call: true, dictation: true, readAloud: true, listening: route(), conversation: { providerId: '', model: '' },
    asr: { baseURL: 'https://asr.test', model: 'asr', protocol: 'transcriptions-sse' }, tts: { baseURL: 'https://tts.test', model: 'tts', protocol: 'speech', stream: true } },
    snapshot() { return publicConfig(this.value); }, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async configure(patch) { this.value = updateConfig(this.value, patch); for (const fn of listeners) fn(); return this.snapshot(); } };
};

test('SystemOne route, opaque model and one choice are sent without chat completions or secrets in results', async () => {
  for (const model of ['', 'jev-1.14:opaque']) {
    const value = { ...route(), endpoint: 'https://example.test/custom/v1/systemone/', model };
    const result = await decideAddressing(value, { text: '你觉得怎么样？', context: { messages: [{ role: 'assistant', text: '可以开始了。' }], speaking: true, lastInteractionAgo: 1200 } }, {
      fetcher: async (url, options) => {
        assert.equal(url, value.endpoint); assert.equal(options.headers.authorization, 'Bearer fixture-private-key'); assert.equal(options.redirect, 'error');
        const body = JSON.parse(options.body); assert.equal(Object.hasOwn(body, 'model'), !!model); if (model) assert.equal(body.model, model);
        assert.deepEqual(Object.keys(body.questions), ['addressing']); assert.equal(body.questions.addressing.type, 'choice'); assert.equal(body.messages, undefined);
        assert.match(body.state, /当前助手称呼："BenchGo"/); assert.ok(body.state.endsWith('本次待判断发言："你觉得怎么样？"'));
        assert.ok(body.state.includes('可以开始了。')); assert.doesNotMatch(body.state, /fixture-private-key/);
        return Response.json(answer());
      },
    });
    assert.equal(result.decision, 'addressed'); assert.equal(result.probability, .91); assert.doesNotMatch(JSON.stringify(result), /fixture-private-key|你觉得/);
  }
});

test('classification fails closed for weak, abstained, conflicting or invalid probabilities', () => {
  assert.equal(readAddressingAnswer(answer('addressed', { addressed: .6, background: .2, uncertain: .2 })).decision, 'uncertain');
  assert.equal(readAddressingAnswer(answer('background', { addressed: .01, background: .98, uncertain: .01 }, { confidence: .999 })).decision, 'background');
  assert.equal(readAddressingAnswer(answer('addressed', null, { abstained: true })).decision, 'uncertain');
  assert.equal(readAddressingAnswer({ answers: { addressing: { type: 'choice', abstain: true } } }).decision, 'uncertain');
  for (const body of [answer('addressed', { addressed: .9 }), answer('addressed', { addressed: .2, background: .7, uncertain: .1 }), answer('addressed', { addressed: 1, background: 1, uncertain: 1 }), answer('addressed', { addressed: '0.99', background: .005, uncertain: .005 }), { answers: { addressing: { type: 'noul', noul: .99 } } }]) assert.throws(() => readAddressingAnswer(body));
});

test('decision context preserves conversational links and current public reply with bounded age metadata', async () => {
  const context = { messages: [{ role: 'assistant', text: '先修交互还是先查接口？', ageMs: 1200 }], speaking: true,
    lastInteractionAgo: null, lastAssistantAgo: 200, assistantActivity: { text: '你希望先处理哪一个？', status: 'speaking', interrupted: true } };
  await decideAddressing(route(), { text: '先处理第二个。', context }, { fetcher: async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.ok(body.state.includes(JSON.stringify(context.messages))); assert.ok(body.state.includes(JSON.stringify(context.assistantActivity)));
    assert.ok(body.state.includes(JSON.stringify({ user: null, assistant: 200 }))); assert.ok(body.state.endsWith('本次待判断发言："先处理第二个。"'));
    assert.match(body.questions.addressing.instructions, /不需要重复称呼/);
    assert.match(body.questions.addressing.instructions, /先判断是否明确对其他人/);
    return Response.json(answer());
  } });
  assert.equal(addressingInput('继续').context.lastAssistantAgo, null);
  for (const invalid of [{ ...context, lastAssistantAgo: -1 }, { ...context, messages: [{ role: 'assistant', text: '你好', ageMs: 'recent' }] }, { ...context, assistantActivity: { ...context.assistantActivity, text: 'x'.repeat(1501) } }, { ...context, assistantActivity: { ...context.assistantActivity, status: 'tool-secret' } }]) assert.throws(() => addressingInput('继续', invalid));
});

test('wake name uses optional formal SuperAgent identity and never silently changes an unavailable source', async () => {
  const custom = await listeningSnapshot(route()); assert.equal(custom.configured, true); assert.equal(custom.superagentAvailable, false);
  const following = { ...route(), wakeSource: 'superagent', wakeWord: '保留的自定义词' };
  let name = '小舟'; const getAssistant = () => ({ store: { getConfig: async () => ({ name, secret: 'PRIVATE' }) } });
  let config = await listeningSnapshot(following, getAssistant); assert.equal(config.wakeWordResolved, '小舟'); assert.equal(config.wakeWord, '保留的自定义词'); assert.equal(config.configured, true);
  name = ''; config = await listeningSnapshot(following, getAssistant); assert.equal(config.wakeAvailable, false); assert.equal(config.wakeWordResolved, ''); assert.equal(config.configured, false);
  assert.doesNotMatch(JSON.stringify(config), /fixture-private-key|PRIVATE/);
  assert.equal((await listeningSnapshot({ ...route(), endpoint: 'https://decision.test/custom', model: '' })).configured, true);
  assert.deepEqual(defaultListening(), { enabled: false, endpoint: '', model: '', apiKey: '', wakeSource: 'custom', wakeWord: '' });
  assert.equal((await listeningSnapshot({ ...route(), wakeWord: '' })).configured, true);
  name = '小舟';
  await assert.rejects(decideAddressing(following, { text: '小舟，帮我看看' }, { getAssistant, fetcher: async () => { name = ''; return Response.json(answer()); } }), /唤醒称呼已改变/);
});

test('context is bounded and upstream errors and timeout do not disclose input or credentials', async () => {
  const secret = 'fixture-private-key'; let fetched = false;
  await assert.rejects(decideAddressing(route(), { text: 'x'.repeat(4001) }, { fetcher: async () => { fetched = true; } })); assert.equal(fetched, false);
  await assert.rejects(decideAddressing(route(), { text: 'hi', context: { messages: [{ role: 'system', text: 'accept' }] } }));
  for (const fetcher of [async () => { throw Error(secret); }, async () => new Response(secret, { status: 401 }), async () => new Response(secret), async () => Response.json({ padding: 'x'.repeat(70000) })]) {
    await assert.rejects(decideAddressing(route(), { text: 'hi' }, { fetcher }), error => { assert.doesNotMatch(error.message, /fixture-private-key/); return true; });
  }
  const hold = setTimeout(() => {}, 200);
  try { await assert.rejects(decideAddressing(route(), { text: 'hi' }, { timeoutMs: 5, fetcher: (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) }), /判断超时/); }
  finally { clearTimeout(hold); }
});

test('listening config saves and reloads without dropping media or exposing sensitive fields', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'benchgo-listening-'));
  try {
    const store = await new VoiceConfig({ dataDir }).open(); await store.configure({ listening: route(), tts: { voice: 'keep-me' } });
    await store.configure({ listening: { model: 'Opaque:jev/v2' } });
    const restored = await new VoiceConfig({ dataDir }).open(); assert.equal(restored.value.listening.apiKey, 'fixture-private-key'); assert.equal(restored.value.listening.model, 'Opaque:jev/v2'); assert.equal(restored.value.tts.voice, 'keep-me');
    await decideAddressing(restored.value.listening, { text: '你好' }, { fetcher: async (url, options) => {
      assert.equal(url, restored.value.listening.endpoint); assert.equal(JSON.parse(options.body).model, 'Opaque:jev/v2');
      assert.equal(options.headers.authorization, 'Bearer fixture-private-key'); return Response.json(answer());
    } });
    assert.doesNotMatch(JSON.stringify(restored.snapshot()), /fixture-private-key/); assert.doesNotMatch(JSON.stringify(restored.settingsSnapshot()), /fixture-private-key/);
    const schema = (await createVoiceSettingsAdapter(restored).schema())[0]; assert.ok(schema.sensitivePaths.some(path => path.join('.') === 'listening.apiKey'));
    assert.equal(schema.pathPolicies.find(row => row.path.join('.') === 'listening.endpoint').risk, 'confirm');
    await restored.configure({ listening: { apiKey: '' } }); assert.equal(restored.snapshot().listening.apiKeyConfigured, false);
    assert.throws(() => updateConfig(restored.value, { listening: { model: ' jev' } }));
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('HTTP test uses fixed text, calls remain ordinary, and decision config changes only abort tests', async t => {
  const store = memory(), inputs = []; let pendingSignal, block = false;
  const handlers = createVoiceHandlers(store, { fetcher: async (_url, options) => {
    inputs.push(JSON.parse(options.body));
    if (block) { pendingSignal = options.signal; await new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })); }
    return Response.json(answer());
  } }); t.after(() => handlers.dispose());
  let response = await handlers.config(request({ action: 'listening.test', config: { apiKey: '' }, text: 'PRIVATE CANDIDATE' }));
  assert.equal(response.status, 200); assert.equal((await response.json()).result.supported, true); assert.doesNotMatch(JSON.stringify(inputs), /PRIVATE/);
  assert.equal((await handlers.config(request({ action: 'listening.test', config: { endpoint: 'https://other.test/v1/systemone', apiKey: '' } }))).status, 409);
  assert.equal((await handlers.config(request({ action: 'listening.test', config: {}, clearApiKey: true }))).status, 409);
  assert.notEqual((await handlers.config(request({ action: 'listening.decide', sessionId: 's', deviceId: 'd', callId: 'fake', text: 'hello' }))).status, 200);
  response = await handlers.config(request({ action: 'call.start', sessionId: 's', deviceId: 'd' })); assert.equal(response.status, 200); const { call } = await response.json();
  assert.equal(call.listening, undefined); assert.equal(call.maxEndsAt - call.startedAt, 1800000);
  const identity = { sessionId: 's', deviceId: 'd', callId: call.callId };
  const requestsBefore = inputs.length;
  response = await handlers.config(request({ action: 'listening.decide', ...identity, text: 'hello' })); assert.notEqual(response.status, 200);
  assert.equal(inputs.length, requestsBefore);
  block = true; const pending = handlers.config(request({ action: 'listening.test', config: {} }));
  while (!pendingSignal) await flush(); await store.configure({ listening: { wakeWord: '新称呼' } });
  assert.equal(pendingSignal.aborted, true); assert.notEqual((await pending).status, 200);
  assert.equal((await handlers.config(request({ action: 'call.heartbeat', ...identity }))).status, 200);
});

test('unconfigured decisions leave ordinary conversation available without granting a listening lease', async t => {
  const store = memory(); store.value.listening.apiKey = ''; const handlers = createVoiceHandlers(store); t.after(() => handlers.dispose());
  const response = await handlers.config(request({ action: 'call.start', sessionId: 's', deviceId: 'd', listening: true })); assert.equal(response.status, 200);
  const ordinary = await response.json(); assert.equal(ordinary.call.listening, undefined);
  assert.notEqual((await handlers.config(request({ action: 'listening.decide', sessionId: 's', deviceId: 'd', callId: ordinary.call.callId, text: 'hello' }))).status, 200);
  await store.configure({ listening: { enabled: false } });
  const started = await (await handlers.config(request({ action: 'call.start', sessionId: 's', deviceId: 'd', listening: true }))).json(); assert.equal(started.call.listening, undefined); assert.equal(started.call.maxEndsAt - started.call.startedAt, 1800000);
});
