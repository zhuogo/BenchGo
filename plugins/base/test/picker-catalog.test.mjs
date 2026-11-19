import test from 'node:test';
import assert from 'node:assert/strict';
import { createPickerCatalog, decodeRouteModelId, encodeRouteModelId } from '../src/picker-catalog.mjs';
import { sessionRouteSupport } from '../src/session-routes.mjs';

const provider = (id, modelProtocol) => ({ id, name: id, authMode: 'api', configured: true, modelProtocol });
const tool = (id, available = true) => ({ id, installed: true, available, chatSupported: true });
const fixture = ({ installed = [tool('codex'), tool('claude')], providers = [], accountModels, listModels = async () => [{ id: 'vendor/Exact-ID' }] } = {}) => createPickerCatalog({
  installer: { list: async () => installed },
  providers: { list: async () => providers, routerGoProtocolModels: async () => accountModels },
  routeService: { supports: sessionRouteSupport },
  llm: { listModels },
});

test('opaque routes preserve exact provider and model identifiers', () => {
  const route = encodeRouteModelId('vendor/a', 'b/c');
  assert.notEqual(route, encodeRouteModelId('vendor', 'a/b/c'));
  assert.deepEqual(decodeRouteModelId(route), { providerId: 'vendor/a', model: 'b/c' });
  assert.equal(decodeRouteModelId('vendor/model'), null);
  assert.throws(() => decodeRouteModelId(route + '='), /Invalid/);
});

test('shared API catalog computes exact wire compatibility without tool bindings or credentials', async () => {
  const catalog = fixture({ providers: [
    { ...provider('responses', 'responses'), apiKey: 'fixture-secret' },
    provider('messages', 'anthropic'),
    provider('chat', 'openai'),
    { id: 'no-key', authMode: 'unconfigured', configured: false },
  ] });
  const value = await catalog.list();
  assert.deepEqual(value.routes.map(row => [row.tool, row.providerId]), [
    ['claude', 'messages'], ['codex', 'responses'], ['deepseek', 'chat'], ['deepseek', 'messages'], ['deepseek', 'responses'],
  ]);
  assert.match(value.providers.find(row => row.id === 'responses').unavailableTools.claude, /Messages/);
  assert.match(value.providers.find(row => row.id === 'messages').unavailableTools.codex, /Responses/);
  assert.deepEqual(decodeRouteModelId((await catalog.models('codex'))[0].id), { providerId: 'responses', model: 'vendor/Exact-ID' });
  assert.doesNotMatch(JSON.stringify(value), /fixture-secret|apiKey|no-key/);
});

test('unlaunchable and unsupported tools are omitted from model routes', async () => {
  const catalog = fixture({ installed: [tool('codex', false), tool('pi')], providers: [provider('primary', 'responses')] });
  const value = await catalog.list();
  assert.equal(value.tools.find(row => row.id === 'codex').available, false);
  assert.equal(value.tools.find(row => row.id === 'pi').routeSupported, false);
  assert.deepEqual(await catalog.models('codex'), []);
  assert.deepEqual(await catalog.models('pi'), []);
});

test('managed RouterGo lists routes by account capabilities and exact registered model IDs', async () => {
  const routes = [
    { id: 'vendor/Exact-ID', capabilities: ['chat', 'responses'] },
    { id: 'chat-only', capabilities: ['chat'] },
    { id: 'media-model', capabilities: ['image-generation'] },
  ];
  const catalog = fixture({
    providers: [{ ...provider('routergo', 'responses'), protocol: 'openai-responses', managedRouterGo: true }],
    accountModels: new Map(routes.map(row => [row.id, row])),
    listModels: async () => [...routes, { id: 'vendor/exact-id' }],
  });
  const value = await catalog.list();
  assert.equal(value.providers[0].accountManaged, true);
  assert.deepEqual(value.routes.map(({ tool, nativeModelId, protocol }) => [tool, nativeModelId, protocol]), [
    ['claude', 'chat-only', 'anthropic'], ['claude', 'vendor/Exact-ID', 'anthropic'],
    ['codex', 'vendor/Exact-ID', 'responses'], ['deepseek', 'vendor/Exact-ID', 'openai-responses'],
  ]);
});

test('concurrent reads share a build, then resolve current provider models', async () => {
  let calls = 0, id = 'first';
  const catalog = fixture({ providers: [provider('primary', 'responses')], listModels: async () => {
    calls++;
    return [{ id, reasoning: { efforts: [{ id: 'high' }] } }];
  } });
  const [value, models] = await Promise.all([catalog.list(), catalog.models('codex')]);
  assert.equal(calls, 1);
  assert.equal(value.routes.find(row => row.tool === 'deepseek').reasoning.efforts[0].id, 'high');
  assert.equal(models[0].reasoning, undefined);
  id = 'second';
  assert.equal((await catalog.models('codex'))[0].nativeModelId, 'second');
  assert.equal(calls, 2);
});

test('failed provider metadata adds a bounded reason without returning native defaults', async () => {
  const catalog = fixture({ providers: [provider('primary', 'responses')], listModels: async () => { throw Error('fixture-secret'); } });
  const value = await catalog.list();
  assert.deepEqual(value.routes, []);
  assert.match(value.providers[0].unavailableReason, /无法读取/);
  assert.doesNotMatch(JSON.stringify(value), /fixture-secret/);
});
