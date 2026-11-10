import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { identityConfigPatch, auxiliaryModelPatch, auxiliaryCapabilityPatch, validateModelSettings } from '../client/model-settings.mjs';
import { createAssistantStore } from '../src/store.mjs';
import { collectAuxiliaryText } from '../src/auxiliary-request.mjs';
import { roleModels } from '../src/routing.mjs';

test('whole draft validation catches hidden role errors without rewriting opaque IDs', () => {
  const opaque = { providerId: 'Exact/@ Provider', modelId: 'Exact: Model/01' };
  const draft = { models: [opaque], workerModels: [], auxiliary: { models: [opaque], capabilities: ['review'] } };
  assert.equal(validateModelSettings(draft), null);
  for (const invalid of [{ providerId: '', modelId: 'x' }, { providerId: 'p', modelId: ' x' }, { providerId: 'p', modelId: 'x\n' }, { providerId: 'p', modelId: 'x'.repeat(513) }]) {
    assert.equal(validateModelSettings({ ...draft, workerModels: [invalid] }).role, 'worker');
  }
  assert.equal(validateModelSettings({ ...draft, auxiliary: { models: [opaque, { ...opaque }] } }).role, 'auxiliary');
  assert.equal(validateModelSettings({ models: Array.from({ length: 33 }, (_, index) => ({ ...opaque, modelId: `${index}` })) }).role, 'router');
  assert.deepEqual(draft.models, [opaque]);
  assert.equal(opaque.providerId, 'Exact/@ Provider');
  assert.equal(opaque.modelId, 'Exact: Model/01');
});

test('model editor saves and reloads capability choices and routes opaque model IDs without dropping other settings', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'model-settings-'));
  let store = await createAssistantStore({ dataDirectory: directory });
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const main = { providerId: 'Main/Exact', modelId: 'Main:opaque', options: { maxTokens: 333 } };
  const aux = { providerId: 'Aux/Exact', modelId: 'Aux:opaque', options: { maxTokens: 222 } };
  const worker = { providerId: 'Worker/Exact', modelId: 'Worker:opaque', options: { maxTokens: 111, reasoningEffort: 'ultra' } };
  const base = await store.updateConfig({ models: [main], workerModels: [worker], cardHtml: '<b>BenchGo</b>' });
  let draft = { ...base, ...auxiliaryModelPatch(null, [aux]) };
  draft = { ...draft, ...auxiliaryCapabilityPatch(draft.auxiliary, 'summary', true) };
  const patch = identityConfigPatch(draft, base);
  assert.deepEqual(Object.keys(patch), ['auxiliary']);
  await store.updateConfig(patch, { revision: base.revision });
  store.close(); store = await createAssistantStore({ dataDirectory: directory });
  const config = await store.getConfig();
  assert.deepEqual(config.models, [main]);
  assert.deepEqual(config.workerModels, [worker]);
  assert.equal(config.cardHtml, '<b>BenchGo</b>');
  assert.deepEqual(config.auxiliary, draft.auxiliary);
  const seen = [];
  const llm = { async *stream(request) { seen.push([request.provider, request.model, request.maxTokens]); yield { type: 'text-delta', text: 'ok' }; yield { type: 'finish', reason: { kind: 'stop' } }; } };
  for (const capability of ['summary', 'review']) await collectAuxiliaryText({ llm, config, capability, model: main, request: {} });
  assert.deepEqual(seen, [['Aux/Exact', 'Aux:opaque', 222], ['Main/Exact', 'Main:opaque', 333]]);
  const disabled = { ...config, ...auxiliaryCapabilityPatch(config.auxiliary, 'summary', false) };
  assert.deepEqual(disabled.auxiliary.models, [aux]);
  await store.updateConfig(identityConfigPatch(disabled, config));
  await collectAuxiliaryText({ llm, config: await store.getConfig(), capability: 'summary', model: main, request: {} });
  assert.deepEqual(seen.at(-1), ['Main/Exact', 'Main:opaque', 333]);
  await store.updateConfig(auxiliaryModelPatch(disabled.auxiliary, []));
  assert.equal((await store.getConfig()).auxiliary, null);
});

test('Worker-only edits survive reload, preserve other roles and reset to Router without legacy credential pools', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'model-worker-settings-'));
  let store = await createAssistantStore({ dataDirectory: directory });
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  assert.deepEqual((await store.getConfig()).workerModels, []);
  const router = { providerId: 'Router/@', modelId: 'Exact: Router/01' };
  const workers = [{ providerId: 'Worker/@', modelId: 'Exact: Worker/02', options: { reasoningEffort: 'ultra', maxTokens: 700 } }, { providerId: 'Worker/Backup', modelId: 'Exact: Worker/03' }];
  const auxiliary = { models: [{ providerId: 'Aux/@', modelId: 'Exact: Aux/04' }], capabilities: ['summary', 'review'] };
  const base = await store.updateConfig({ models: [router], auxiliary, capabilities: { proactive: true }, workerConcurrency: 3 });
  const patch = identityConfigPatch({ ...base, workerModels: workers }, base);
  assert.deepEqual(Object.keys(patch), ['workerModels']);
  await store.updateConfig(patch, { revision: base.revision });
  store.close(); store = await createAssistantStore({ dataDirectory: directory });
  const config = await store.getConfig();
  assert.deepEqual(config.workerModels, workers);
  assert.deepEqual(config.models, [router]);
  assert.deepEqual(config.auxiliary, auxiliary);
  assert.deepEqual(config.capabilities, { proactive: true });
  assert.equal(config.workerConcurrency, 3);
  assert.equal(Object.hasOwn(config, 'keyPools'), false);
  assert.deepEqual(roleModels(undefined, config, 'worker'), workers);
  for (const workerModels of [null, {}, [{ providerId: 'p' }], [workers[0], workers[0]], [{ ...workers[0], apiKey: 'secret' }]]) {
    await assert.rejects(store.updateConfig({ workerModels }));
    assert.deepEqual((await store.getConfig()).workerModels, workers);
  }
  await store.updateConfig(identityConfigPatch({ ...config, workerModels: [] }, config));
  store.close(); store = await createAssistantStore({ dataDirectory: directory });
  const inherited = await store.getConfig();
  assert.deepEqual(inherited.workerModels, []);
  assert.deepEqual(roleModels(undefined, inherited, 'worker'), [router]);
  assert.deepEqual(inherited.auxiliary, auxiliary);
});
