import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { prepareConversationCall, conversationModelFailure } from '../src/conversation-model.mjs';
import { voiceSnapshot } from '../src/availability.mjs';
import { publicConfig } from '../src/config.mjs';

test('真实供应商SERVER失败保留分类、HTTP状态和请求ID，不公开响应正文', () => {
  const route = { providerId: 'routergo', model: 'deepseek-v4.1-flash' };
  const failure = conversationModelFailure({ kind: 'error', failure: { code: 'SERVER',
    message: '502: {"code":"model_service_error","message":"PRIVATE CONTENT sk-private-secret","request_id":"c608d6052f1570d87fdefc842fbf0f5d"}' } }, route);
  assert.equal(failure.status, 502);
  assert.match(failure.message, /服务暂时异常.*SERVER.*HTTP 502/);
  assert.deepEqual(failure.failure, { kind: 'error', code: 'SERVER', status: 502, requestId: 'c608d6052f1570d87fdefc842fbf0f5d', ...route });
  assert.doesNotMatch(JSON.stringify(failure), /PRIVATE|sk-private/);
});

test('模型失败只公开已知分类和已验证的事实，未知错误不回显原始内容', () => {
  const route = { providerId: 'Opaque Provider:01', model: 'Opaque Model:02' };
  for (const [reason, code] of [
    [{ kind: 'blocked' }, 'BLOCKED'], [{ kind: 'max-tokens' }, 'MAX_TOKENS'],
    [{ kind: 'aborted' }, 'ABORTED'], [{ kind: 'error', failure: { code: 'AUTH', status: 401 } }, 'AUTH'],
    [{ kind: 'error', failure: { code: 'TRANSPORT' } }, 'TRANSPORT'],
    [{ kind: 'error', failure: { code: 'secret-key-in-code', message: 'private-input-and-key', status: 999, requestId: 'invalid private text' } }, 'MODEL_ERROR'],
  ]) {
    const result = conversationModelFailure(reason, route);
    assert.equal(result.code, code);
    assert.doesNotMatch(JSON.stringify(result), /secret-key|private-input|invalid private/);
  }
});

test('关闭思考检查拒绝适配器映射，配置状态保留明确失败原因', async () => {
  const route = { providerId: 'routergo', model: 'deepseek-v4.1-flash' }, requests = [];
  const store = { value: { conversation: route, asr: {}, tts: {} }, snapshot() { return publicConfig(this.value); } };
  const llm = { async prepareCall(request) { requests.push(request); return { config: { ...request, reasoningEffort: 'high' } }; } };
  const config = await voiceSnapshot(store, undefined, llm);
  assert.equal(config.conversation.configured, false);
  assert.match(config.conversation.unavailableReason, /未实际关闭思考/);
  assert.deepEqual(requests[0], { provider: 'routergo', model: 'deepseek-v4.1-flash', reasoningEffort: 'off', maxTokens: 1200 });
  llm.prepareCall = async () => { throw Object.assign(Error('private upstream metadata'), { code: 'UNSUPPORTED_REASONING_EFFORT' }); };
  const unsupported = await voiceSnapshot(store, undefined, llm);
  assert.match(unsupported.conversation.unavailableReason, /不支持关闭思考/);
  assert.doesNotMatch(unsupported.conversation.unavailableReason, /private/);
});

test('真实官方运行时保留显式 off、支持 off-only 模型，并拒绝不支持关闭的模型', async t => {
  const require = createRequire(new URL('../../../deepseek-harness/packages/llm/llm/package.json', import.meta.url));
  const load = async name => import(pathToFileURL(require.resolve(name)).href);
  const { Context } = await load('@deepseek-ai/cordis');
  const { default: LlmRuntime, LlmAdapter } = await load('@deepseek-ai/dsh-llm');
  class LocalAdapter extends LlmAdapter {
    requests = [];
    async resolveModel(provider, model) {
      const efforts = model === 'always' ? ['high'] : model === 'off-only' ? ['off'] : ['off', 'high'];
      return { provider, id: model, name: model, reasoning: { efforts: efforts.map(id => ({ id, name: id })), defaultEffort: efforts.at(-1) } };
    }
    async *stream(request) { this.requests.push(request); yield { type: 'finish', reason: { kind: 'stop' } }; }
  }
  const ctx = new Context(); t.after(() => ctx.fiber.dispose()); await ctx.plugin(LlmRuntime);
  const adapter = new LocalAdapter(); ctx.llm.registerAdapter(['opaque-provider'], adapter);
  for (const model of ['deepseek-v4.1-flash', 'off-only']) {
    const prepared = await prepareConversationCall(ctx.llm, { providerId: 'opaque-provider', model });
    assert.equal(prepared.config.reasoningEffort, 'off');
    for await (const _chunk of prepared.stream({ ...prepared.config, messages: [] })) { /* dispatch through the checked handle */ }
    assert.equal(adapter.requests.at(-1).reasoningEffort, 'off');
    assert.equal(adapter.requests.at(-1).model, model);
  }
  await assert.rejects(prepareConversationCall(ctx.llm, { providerId: 'opaque-provider', model: 'always' }), error => error.status === 409 && /不支持关闭思考/.test(error.message));
  assert.equal(adapter.requests.length, 2);
});

test('官方 PiAi DeepSeek 协议将交互模型 off 编码为真实 thinking disabled，不改变模型 ID', async t => {
  const { Context } = await import('../../../deepseek-harness/vendor/cordis/lib/index.js');
  const { default: LlmRuntime } = await import('../../../deepseek-harness/packages/llm/llm/lib/index.js');
  const PiAi = await import('../../../deepseek-harness/packages/llm/llm-pi-ai/lib/index.js');
  const ctx = new Context(), requests = [], originalFetch = globalThis.fetch;
  t.after(async () => { globalThis.fetch = originalFetch; await ctx.fiber.dispose(); });
  ctx.provide('credentials', { async resolve() { return { value: 'fixture-voice-key' }; }, async readRecord() {}, async listRecords() { return []; } });
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(PiAi, { providers: { 'opaque-route': { api: 'openai-completions', baseURL: 'https://voice-model.invalid/v1', apiKeyEnv: 'VOICE_TEST_KEY', models: [
    { id: 'Opaque Model:01', reasoningEfforts: { off: null, high: 'high' }, compat: { thinkingFormat: 'deepseek' } },
  ] } } });
  globalThis.fetch = async (_input, init) => {
    requests.push(JSON.parse(init.body));
    return new Response([
      'data: {"id":"fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":null}]}',
      'data: {"id":"fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      'data: [DONE]',
    ].join('\n\n') + '\n\n', { headers: { 'content-type': 'text/event-stream' } });
  };
  const prepared = await prepareConversationCall(ctx.llm, { providerId: 'opaque-route', model: 'Opaque Model:01' });
  for await (const _chunk of prepared.stream({ ...prepared.config, messages: [{ role: 'user', content: [{ type: 'text', text: 'OK' }] }] })) { /* dispatch the validated handle */ }
  assert.equal(requests.length, 1);
  assert.equal(requests[0].model, 'Opaque Model:01');
  assert.deepEqual(requests[0].thinking, { type: 'disabled' });
  assert.equal(requests[0].reasoning_effort, undefined);
});
