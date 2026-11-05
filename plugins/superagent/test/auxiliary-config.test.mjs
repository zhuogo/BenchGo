import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantStore } from '../src/store.mjs';

async function fixture(t) {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'assistant-auxiliary-'));
  const stores = [];
  const open = async () => { const store = await createAssistantStore({ dataDirectory }); stores.push(store); return store; };
  t.after(async () => { for (const store of stores) store.close(); await rm(dataDirectory, { recursive: true, force: true }); });
  return { store: await open(), open };
}

test('auxiliary settings preserve opaque primary and fallback identities across edits and reload', async t => {
  const { store, open } = await fixture(t);
  const models = [{ providerId: 'provider/@primary', modelId: 'Main: Exact/01' }];
  const auxiliary = { models: [
    { providerId: 'provider/@aux', modelId: 'Aux: Exact/02', options: { reasoningEffort: 'custom', maxTokens: 500 } },
    { providerId: 'provider/@backup', modelId: 'Backup: Exact/03' },
  ], capabilities: ['summary', 'review'] };
  await store.updateConfig({ models, auxiliary, image: { providerId: 'images', modelId: 'image' } });
  await store.updateConfig({ auxiliary: { capabilities: ['review'] } });
  store.close();
  const restarted = await open();
  const config = await restarted.getConfig();
  assert.deepEqual(config.models, models);
  assert.deepEqual(config.auxiliary, { ...auxiliary, capabilities: ['review'] });
  assert.equal(config.image.modelId, 'image');
  assert.deepEqual((await restarted.profileExport()).config.auxiliary, config.auxiliary);
  await restarted.updateConfig({ auxiliary: null });
  assert.equal((await restarted.getConfig()).auxiliary, null);
  assert.deepEqual((await restarted.getConfig()).models, models);
});

test('legacy configuration defaults to no auxiliary without changing its revision or primary', async t => {
  const { store } = await fixture(t);
  const config = await store.updateConfig({ models: [{ providerId: 'p', modelId: 'm' }] });
  delete config.auxiliary;
  await writeFile(store.paths.config, JSON.stringify(config));
  const loaded = await store.getConfig();
  assert.equal(loaded.auxiliary, null);
  assert.equal(loaded.revision, config.revision);
  assert.deepEqual(loaded.models, config.models);
});

test('legacy key pools are stripped on load and cannot be configured again', async t => {
  const { store, open } = await fixture(t);
  const config = await store.updateConfig({ models: [{ providerId: 'opaque/provider-A', modelId: 'Exact/model' }], cardHtml: '<b>Name</b>' });
  await writeFile(store.paths.config, JSON.stringify({ ...config, keyPools: [{ providerId: 'opaque/provider-A', candidates: ['opaque/provider-B'] }] }));
  store.close(); const restored = await open();
  const before = await restored.getConfig();
  assert.equal(Object.hasOwn(before, 'keyPools'), false);
  assert.equal(before.revision, config.revision);
  for (const keyPools of [null, {}, [{ providerId: 'one', candidates: ['two'] }]]) {
    await assert.rejects(restored.updateConfig({ keyPools }), { code: 'KEY_POOL_REMOVED' });
    assert.deepEqual(await restored.getConfig(), before);
  }
  await restored.updateConfig({ keyPools: [] });
  const saved = await restored.getConfig();
  assert.equal(Object.hasOwn(saved, 'keyPools'), false);
  assert.equal(saved.models[0].modelId, 'Exact/model');
  assert.equal(saved.cardHtml, '<b>Name</b>');
});

test('invalid auxiliary configuration is atomic and cannot silently accept unsupported capabilities or credentials', async t => {
  const { store } = await fixture(t);
  const model = { providerId: 'p', modelId: 'm' };
  const auxiliary = { models: [model], capabilities: ['review'] };
  await store.updateConfig({ auxiliary });
  const before = await store.getConfig();
  for (const invalid of [false, [], { models: [] }, { capabilities: ['unknown'] },
    { capabilities: ['review', 'review'] }, { capabilities: 'review' }, { extra: true },
    { models: [model, model] }, { models: [{ ...model, modelId: ' m' }] },
    { models: [{ ...model, credentialRef: 'PRIVATE' }] },
    { models: [{ ...model, apiKey: 'SECRET' }] },
    { models: [{ ...model, options: { temperature: 1 } }] }]) {
    await assert.rejects(store.updateConfig({ auxiliary: invalid }));
    assert.deepEqual(await store.getConfig(), before);
  }
  await assert.rejects(store.updateConfig({ auxiliary: { capabilities: [] } }, { revision: before.revision - 1 }), { code: 'REVISION_CONFLICT' });
  assert.deepEqual(await store.getConfig(), before);
});
