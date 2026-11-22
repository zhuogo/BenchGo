import test from 'node:test';
import assert from 'node:assert/strict';
import { mountTooling } from '../src/tooling.mjs';
import { Commander } from '../../harness/src/runtime.mjs';

test('owner tooling route reuses provider refs, protects writes and never exposes runtime secrets', async () => {
  const effects = [], routes = []; let stopped = false;
  const ctx = { effect(fn) { const dispose = fn(); if (dispose) effects.push(dispose); }, connection: { fetch: { register(route) { routes.push(route); return () => {}; } } } };
  const installer = { list: async () => [{ id: 'codex', available: true }], job: id => ({ id }), install: tool => ({ tool, action: 'install' }), updateTool: tool => ({ tool, action: 'update' }), uninstall: tool => ({ tool, action: 'uninstall' }), cancel: id => ({ id }), close: async () => { stopped = true; } };
  let saved = {};
  const runtimeSettings = { get: async () => saved, save: async (_tool, config) => { saved = config; return saved; } };
  const commander = { sessions: new Map(), drivers: new Map(), connecting: new Map(), store: { directory: '/unused' } };
  const providers = { list: async () => [{ id: 'shared' }], models: async () => [{ id: 'model' }], resolve: async () => ({baseURL:'https://example.test/v1',apiKey:'server-only'}) };
  const { fetch } = await mountTooling(ctx, commander, providers, { installer, runtimeSettings });
  const request = (input, extra = {}) => new Request('http://test/api/commander/tooling', { method: 'POST', headers: { 'content-type': 'application/json', ...extra }, body: JSON.stringify(input) });
  assert.equal(routes[0].path, '/api/commander/tooling');
  const data = await (await fetch(request({ action: 'catalog' }))).json();
  assert.equal(data.tools[0].id, 'codex');
  assert.equal(data.tools[0].available, true);
  assert.doesNotMatch(JSON.stringify(data), /server-only|apiKey/);
  for (const action of ['install', 'update', 'uninstall']) assert.deepEqual((await (await fetch(request({ action, tool: 'codex' }))).json()).job, { tool: 'codex', action });
  assert.equal((await fetch(request({ action: 'catalog' }, { origin: 'https://evil.test' }))).status, 403);
  assert.equal((await fetch(request({ action: 'catalog' }, { 'content-type': 'text/plain' }))).status, 415);
  const config = { config: { agents: { max_threads: 3 } } };
  assert.deepEqual(await (await fetch(request({ action: 'saveToolConfig', tool: 'codex', config }))).json(), { config });
  assert.deepEqual(await (await fetch(request({ action: 'toolConfig', tool: 'codex' }))).json(), { config });
  assert.equal((await fetch(request({ action: 'saveToolConfig', padding: 'x'.repeat(310000) }))).status, 413);
  for (const action of ['setBindings', 'apply', 'restore', 'reinstall']) assert.equal((await fetch(request({ action, tool: 'codex' }))).status, 400);
  for (const dispose of effects.reverse()) await dispose(); assert.equal(stopped, true); assert.equal(commander.toolInstaller, undefined);
});

test('public model profiles use fixed server-side URL without provider credentials', async () => {
  let body = { success: true, data: [{ model_id: 'gpt-6.1-sol', context: 1050000 }] }, calls = 0;
  const ctx = { effect() {} };
  const service = await mountTooling(ctx, null, { resolve() { throw Error('must not resolve credentials'); } }, { directory: '/unused', installer: {}, fetcher: async (url, options) => {
    calls++; assert.equal(url, 'https://routergo.cn/api/x/public/models');
    assert.deepEqual(options.headers, { accept: 'application/json' });
    assert.equal(options.redirect, 'error');
    return Response.json(body);
  } });
  const request = origin => new Request('http://test/api/commander/tooling', { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify({ action: 'modelProfiles', url: 'https://ignored.test' }) });
  const response = await service.fetch(request());
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), body);
  assert.equal((await service.fetch(request('https://evil.test'))).status, 403); assert.equal(calls, 1);
  body = { success: false, data: [] };
  assert.equal((await service.fetch(request())).status, 400);
});

test('native DeepSeek sync reads the registered catalog and returns only model fields', async () => {
  const calls = [];
  const ctx = {
    effect() {},
    llm: {
      listConfigurableProviders: () => [
        { provider: 'deepseek-official', settingsNs: 'llm-deepseek' },
        { provider: 'deepseek-compatible', settingsNs: 'llm-pi-ai' },
      ],
      async listModels(provider) {
        calls.push(provider);
        return [{ id: 'opaque/Model:V1', name: 'Fixture', inputModalities: ['text', 'image'], internal: 'ignored' }];
      },
    },
  };
  const providers = { resolve() { throw Error('native discovery owns credential resolution'); } };
  const { fetch } = await mountTooling(ctx, null, providers, { directory: '/unused', installer: {} });
  const sync = providerId => fetch(new Request('http://test/api/commander/tooling', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'deepSeekModels', providerId }),
  }));
  assert.equal((await sync('deepseek-compatible')).status, 404);
  assert.deepEqual(await (await sync('deepseek-official')).json(), {
    models: [{ id: 'opaque/Model:V1', name: 'Fixture', inputModalities: ['text', 'image'] }],
  });
  assert.deepEqual(calls, ['deepseek-official']);
});

test('runtime resolves the selected system executable', async () => {
  const commander = new Commander({ providers: { codex: { env: { KEEP: 'yes' } } } });
  commander.toolInstaller = { resolveLaunch: async () => ({ command: '/managed/node', args: ['/managed/codex.js'] }) };
  const config = await commander.providerConfig('codex');
  assert.equal(config.command, '/managed/node'); assert.deepEqual(config.commandArgs, ['/managed/codex.js']); assert.equal(config.env.KEEP, 'yes');
  assert.equal(commander.providers.get('codex').config.command, undefined);
});

test('configurable provider requests require model settings API credentials', async () => {
  let gate, nextCalls = 0; const lookedUp = [];
  const ctx = { effect() {}, on(event, listener) { assert.equal(event, 'llm/stream'); gate = listener; }, llm: { listConfigurableProviders: () => [{ provider: 'openai-codex' }, { provider: 'routergo' }] } };
  const providers = { resolve: async () => ({}), describeAccess: async id => { lookedUp.push(id); return { id, authMode: id === 'openai-codex' ? 'unconfigured' : 'api' }; } };
  await mountTooling(ctx, { sessions: new Map(), store: { directory: '/unused' } }, providers, { installer: {} });
  async function* next() { nextCalls++; yield { type: 'passthrough' }; }
  const collect = async options => { const rows = []; for await (const row of gate(options, next)) rows.push(row); return rows; };
  for (const options of [{ provider: 'openai-codex' }, { provider: 'openai-codex', purpose: 'title' }]) {
    const rows = await collect(options);
    assert.equal(rows.length, 1); assert.equal(rows[0].type, 'finish');
    assert.equal(rows[0].reason.failure.code, 'API_CREDENTIAL_REQUIRED');
    assert.match(rows[0].reason.failure.message, /API 凭据/);
  }
  assert.equal(nextCalls, 0);
  for (const provider of ['routergo', 'commander-codex', 'unknown']) assert.deepEqual(await collect({ provider }), [{ type: 'passthrough' }]);
  assert.equal(nextCalls, 3); assert.deepEqual(lookedUp, ['openai-codex', 'openai-codex', 'routergo']);
});

test('managed RouterGo chat checks the exact model supports Responses before calling the engine', async () => {
  let gate;
  let modelProtocol = 'responses';
  const ctx = { effect() {}, on(_event, listener) { gate = listener; }, llm: { listConfigurableProviders: () => [{ provider: 'routergo' }] } };
  const providers = {
    resolve: async () => ({}),
    describeAccess: async () => ({ authMode: 'api', managedRouterGo: true, modelProtocol }),
    routerGoProtocolModels: async () => new Map([
      ['Exact/Model', { capabilities: ['responses'] }],
      ['chat-only', { capabilities: ['chat'] }],
      ['messages-only', { capabilities: ['anthropic-messages'] }],
      ['text-only-override', { capabilities: ['text'], providerCapabilities: ['image-generation'] }],
      ['text-disabled', { capabilities: [], providerCapabilities: ['responses'] }],
    ]),
  };
  await mountTooling(ctx, null, providers, { directory: '/unused', installer: {} });
  async function* next() { yield { type: 'passthrough' }; }
  const collect = async model => {
    const rows = [];
    for await (const row of gate({ provider: 'routergo', model }, next)) rows.push(row);
    return rows;
  };
  assert.deepEqual(await collect('Exact/Model'), [{ type: 'passthrough' }]);
  assert.equal((await collect('chat-only'))[0].reason.failure.code, 'ROUTERGO_MODEL_UNAVAILABLE');
  assert.match((await collect('exact/model'))[0].reason.failure.message, /未提供此模型/);
  assert.match((await collect('text-only-override'))[0].reason.failure.message, /未为此模型开放 Responses/);
  assert.match((await collect('text-disabled'))[0].reason.failure.message, /未启用文本能力/);
  modelProtocol = 'openai';
  assert.deepEqual(await collect('chat-only'), [{ type: 'passthrough' }]);
  assert.match((await collect('Exact/Model'))[0].reason.failure.message, /Chat Completions/);
  modelProtocol = 'anthropic';
  assert.deepEqual(await collect('messages-only'), [{ type: 'passthrough' }]);
  assert.match((await collect('chat-only'))[0].reason.failure.message, /Anthropic Messages/);
});
