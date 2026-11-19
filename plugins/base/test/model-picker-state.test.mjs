import test from 'node:test';
import assert from 'node:assert/strict';
import { availableTools, currentToolId, providersForTool, selectionReasoningEffort } from '../client/model-picker-state.mjs';

const route = { tool: 'codex', providerId: 'routergo', providerName: 'RouterGo', modelId: 'opaque:/model+id', nativeModelId: 'vendor/model', protocol: 'openai-responses' };
const groups = [
  { id: 'routergo', name: 'RouterGo', models: [{ id: 'deepseek-test', name: 'DS' }] },
  { id: 'commander-codex', name: 'Codex', models: [{ id: route.modelId, name: 'Codex test' }, { id: 'unmapped', name: 'Do not guess' }] },
  { id: 'commander-claude', name: 'Claude Code', models: [{ id: route.modelId, name: 'Other tool' }] },
];

test('reasoning choices follow exact model capabilities', () => {
  const current = { provider: 'routergo', model: 'm', reasoningEffort: 'off' };
  assert.equal(selectionReasoningEffort('routergo', { id: 'm' }, current), undefined);
  const model = { id: 'm', reasoning: { defaultEffort: 'high', efforts: [{ id: 'high' }, { id: 'off' }] } };
  assert.equal(selectionReasoningEffort('routergo', model, current), 'off');
  assert.equal(selectionReasoningEffort('other', model, current), 'high');
  assert.throws(() => selectionReasoningEffort('routergo', model, current, 'invalid'), /不支持/);
});

test('workbench tool list shows installed coding tools and lets the menu explain unavailable routes', () => {
  const tools = availableTools({ tools: [
    { id: 'codex', name: 'Codex', installed: true, available: true, chatSupported: true, routeSupported: true },
    { id: 'claude', installed: true, available: false, chatSupported: true, routeSupported: true },
    { id: 'pi', installed: true, available: true, chatSupported: true, routeSupported: false },
    { id: 'missing', installed: false, available: false, chatSupported: true, routeSupported: true },
  ] });
  assert.deepEqual(tools.map(item => item.id), ['deepseek', 'codex', 'claude', 'pi']);
  assert.equal(tools[2].available, false);
});

test('provider and model lists use exact per-tool routes', () => {
  assert.equal(currentToolId('routergo'), 'deepseek');
  assert.equal(currentToolId('commander-codex'), 'codex');
  assert.deepEqual(providersForTool(groups, { providers: [{ id: 'routergo', tools: ['deepseek'] }], routes: [route] }, 'deepseek').map(item => item.id), ['routergo']);
  const providers = providersForTool(groups, { routes: [route, { ...route, tool: 'claude', providerId: 'unexpected' }] }, 'codex');
  assert.deepEqual(providers.map(item => item.id), ['routergo']);
  assert.equal(providers[0].models[0].model.id, route.modelId);
  assert.equal(providers[0].models[0].nativeModelId, route.nativeModelId);
  assert.deepEqual(providersForTool(groups, {}, 'codex'), []);
});

test('managed RouterGo picker only displays exact conversational routes', () => {
  const catalog = {
    providers: [{ id: 'routergo', accountManaged: true, tools: ['deepseek'] }],
    routes: [{ tool: 'deepseek', providerId: 'routergo', nativeModelId: 'exact' }],
  };
  const providers = providersForTool([{ id: 'routergo', models: [{ id: 'exact' }, { id: 'Exact' }, { id: 'image-model' }] }], catalog, 'deepseek');
  assert.deepEqual(providers[0].models.map(({ model }) => model.id), ['exact']);
});
