import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { Context } from '../../../deepseek-harness/vendor/cordis/lib/index.js';
import LlmRuntime, { BlockAssembler, createUserMessage } from '../../../deepseek-harness/packages/llm/llm/lib/index.js';
import * as LlmPiAi from '../../../deepseek-harness/packages/llm/llm-pi-ai/lib/index.js';
import { reconcileReasoning } from '../shared/live-reasoning.mjs';
import { modelProfilePatch } from '../shared/model-profile-match.mjs';

// Exercise the installed official plugin and its SDK, not a local serializer.
// No real credentials, sessions, or network are used.
const fixtureURL = new URL('../config/routergo-deepseek.example.yml', import.meta.url);
const envRef = 'DOWORK_ROUTERGO_REASONING_TEST_KEY';
const modelId = 'deepseek-v4.1-flash';

async function harness(t, { withoutReasoning = false, high = 'high', thinkingLevels, responses = false } = {}) {
  const [entry] = parse(await readFile(fixtureURL, 'utf8'));
  const profile = entry.config.providers.routergo;
  assert.equal(profile.apiKeyEnv, 'ROUTERGO_API_KEY');
  assert.equal(Object.hasOwn(profile, 'apiKey'), false);
  assert.equal(profile.api, 'openai-completions');
  profile.baseURL = 'https://gateway.test/v1';
  profile.apiKeyEnv = envRef;
  if (withoutReasoning) delete profile.models[0].reasoningEfforts;
  else if (thinkingLevels) Object.assign(profile.models[0], modelProfilePatch({ thinking_levels: thinkingLevels }, { reasoning: true }));
  else profile.models[0].reasoningEfforts.high = high;
  const model = responses ? 'gpt-6.2-sol' : modelId;
  if (responses) {
    profile.api = 'openai-responses';
    profile.models[0] = { id: model, reasoningEfforts: profile.models[0].reasoningEfforts };
  }

  const previous = process.env[envRef], forks = [], requests = [];
  process.env[envRef] = 'fixture-key';
  t.after(async () => {
    try {
      for (const fork of forks.reverse()) await fork.dispose();
    } finally {
      if (previous === undefined) delete process.env[envRef];
      else process.env[envRef] = previous;
    }
  });
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(String(url), 'https://gateway.test/v1/' + (responses ? 'responses' : 'chat/completions'));
    assert.equal(init.method, 'POST');
    requests.push(JSON.parse(init.body));
    const item = { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'OK', annotations: [] }] };
    const response = { id: 'resp_1', status: 'in_progress', output: [] };
    const frames = responses ? [
      { type: 'response.created', response },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
      { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'OK' },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { ...response, status: 'completed', output: [item] } },
    ] : [
      { choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } },
    ];
    return new Response(frames.map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join('') + 'data: [DONE]\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    });
  });

  const ctx = new Context();
  forks.push(await ctx.plugin(LlmRuntime));
  forks.push(await ctx.plugin(LlmPiAi, entry.config));
  const collect = async effort => {
    const assembler = new BlockAssembler();
    for await (const chunk of ctx.llm.stream({
      provider: 'routergo', model, reasoningEffort: effort, maxTokens: 128,
      messages: [createUserMessage({ content: [{ type: 'text', text: 'Reply only OK.' }] })],
    })) assembler.push(chunk);
    return assembler;
  };
  const send = async effort => {
    const assembler = await collect(effort);
    assert.deepEqual(assembler.finish, { kind: 'stop' });
    assert.deepEqual(assembler.message({ provider: 'routergo', model }).content, [{ type: 'text', text: 'OK' }]);
  };
  return { ctx, requests, collect, send };
}

test('RouterGo DeepSeek declaration advertises exactly off and high through the official model API', async t => {
  const { ctx, requests } = await harness(t);
  const info = await ctx.llm.resolveModelInfo('routergo', modelId);
  assert.deepEqual(info.reasoning.efforts.map(effort => effort.id), ['off', 'high']);
  assert.deepEqual(requests, []);
});

for (const effort of ['off', 'high']) test('RouterGo DeepSeek ' + effort + ' reaches the SDK wire and completes normally', async t => {
  const { requests, send } = await harness(t);
  await send(effort);
  assert.equal(requests.length, 1);
  const [body] = requests;
  assert.equal(body.model, modelId);
  assert.deepEqual(body.thinking, { type: effort === 'off' ? 'disabled' : 'enabled' });
  assert.equal(body.max_tokens, 128);
  assert.equal(Object.hasOwn(body, 'max_completion_tokens'), false);
  if (effort === 'off') assert.equal(Object.hasOwn(body, 'reasoning_effort'), false);
  else assert.equal(body.reasoning_effort, 'high');
});

test('an undeclared reasoning capability reproduces the original local rejection before any request', async t => {
  const { ctx, requests, collect } = await harness(t, { withoutReasoning: true });
  const info = await ctx.llm.resolveModelInfo('routergo', modelId);
  assert.equal(info.reasoning, undefined);
  const assembler = await collect('off');
  assert.equal(assembler.finish.kind, 'error');
  assert.equal(assembler.finish.failure.code, 'UNSUPPORTED_REASONING_EFFORT');
  assert.deepEqual(requests, []);
});

test('a custom effort uses the exact configured supplier value on the wire', async t => {
  const { requests, send } = await harness(t, { high: 'vendor:extended/32K' });
  await send('high');
  assert.equal(requests[0].reasoning_effort, 'vendor:extended/32K');
});

test('Responses omits reasoning with the provider default when the model does not advertise off', async t => {
  const { ctx, requests, collect, send } = await harness(t, { responses: true, thinkingLevels: ['low', 'medium', 'high', 'xhigh', 'max'] });
  const info = await ctx.llm.resolveModelInfo('routergo', 'gpt-6.2-sol');
  assert.deepEqual(info.reasoning.efforts.map(effort => effort.id), ['low', 'medium', 'high', 'xhigh', 'max']);
  const assembler = await collect('off');
  assert.equal(assembler.finish.failure.code, 'UNSUPPORTED_REASONING_EFFORT');
  assert.deepEqual(requests, []);
  await send();
  await send('high');
  assert.equal(requests[0].model, 'gpt-6.2-sol');
  assert.equal(Object.hasOwn(requests[0], 'reasoning'), false);
  assert.equal(requests[1].reasoning.effort, 'high');
});

test('a removed effort is dropped before requesting the same opaque model', async t => {
  const { ctx, requests, send } = await harness(t, { withoutReasoning: true });
  const selection = await reconcileReasoning(ctx.llm, { provider: 'routergo', model: modelId, reasoningEffort: 'high' });
  assert.deepEqual(selection, { provider: 'routergo', model: modelId });
  await send(selection.reasoningEffort);
  assert.equal(requests[0].model, modelId);
  assert.equal(Object.hasOwn(requests[0], 'reasoning_effort'), false);
});
