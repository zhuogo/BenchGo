import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import { officialModelsStore } from '../scripts/official-models-store.mjs';

const path = fileURLToPath(new URL('../../../deepseek-harness/packages/client/ui-settings-models/src/client/store.ts', import.meta.url));
const flush = () => new Promise(resolve => setImmediate(resolve));
const defer = () => Promise.withResolvers();
const found = available => ({ ok: true, value: { groups: available ? [{ id: 'deepseek-account', models: [{ id: 'account-model' }] }] : [] } });
function evaluate(source, require) {
  const module = { exports: {} };
  runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code,
    { module, exports: module.exports, require, Promise, Map, Set });
  return module.exports;
}
async function harness() {
  let handler;
  officialModelsStore().setup({ onLoad(_match, callback) { handler = callback; } });
  const original = await readFile(path, 'utf8');
  const { contents } = await handler({ path });
  const createSnapshotStore = initial => {
    let value = initial;
    return { getSnapshot: () => value, update: update => { value = { ...value }; update(value); } };
  };
  const requireStore = name => {
    assert.equal(name, '@deepseek-ai/dsh-client-store');
    return { createSnapshotStore };
  };
  const { ModelsSettingsStore: OfficialStore } = evaluate(original, requireStore);
  const adapted = evaluate(contents, requireStore);
  const helper = evaluate(await readFile(new URL('../client/provider-store.mjs', import.meta.url), 'utf8'), () => adapted);
  let accountListed = true;
  const catalogs = [];
  const account = { provider: 'deepseek-account', displayName: 'Account', settingsNs: 'account', settingsPath: [] };
  const stepfun = { provider: 'stepfun', displayName: 'StepFun', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'stepfun'] };
  const ctx = { remote: {
    llm: {
      listProviders: async () => ({ ok: true, value: (accountListed ? [account, stepfun] : [stepfun]).map(row => ({ id: row.provider, name: row.displayName })) }),
      listConfigurableProviders: async () => ({ ok: true, value: accountListed ? [account, stepfun] : [stepfun] }),
    },
    session: { modelCatalog: () => { const pending = defer(); catalogs.push(pending); return pending.promise; } },
    credentials: { describe: async refs => ({ ok: true, value: Object.fromEntries(refs.map(ref => [ref, { configured: true }])) }) },
  } };
  const getPath = (value, keys) => keys.reduce((next, key) => next?.[key], value);
  const schema = { getPath, hasPath: (value, keys) => getPath(value, keys) !== undefined };
  const describe = { ensure: async () => {}, getSnapshot: () => ({ view: { writable: true, namespaces: [
    { ns: 'llm-pi-ai', value: { providers: { stepfun: { apiKeyEnv: 'STEPFUN_API_KEY' } } }, user: {}, base: {}, revision: 7 },
  ] } }) };
  const controller = new OfficialStore(ctx, schema, describe);
  const load = controller.load, store = controller.store;
  let dispose;
  const mount = () => { dispose = helper.adaptProviderStore(controller); return dispose; };
  mount();
  assert.equal(controller.load, load);
  assert.equal(controller.store, store);
  assert.equal(await readFile(path, 'utf8'), original);
  return { controller, catalogs, mount, dispose: () => dispose(), removeAccount: () => { accountListed = false; }, originalRead: OfficialStore.prototype.read };
}

test('a delayed full model catalog does not hold up StepFun or the official revision snapshot', async () => {
  const { controller, catalogs } = await harness();
  await controller.load();
  assert.equal(catalogs.length, 1);
  let state = controller.store.getSnapshot();
  assert.equal(state.status, 'ready');
  assert.deepEqual(Array.from(state.rows, row => row.entry.provider), ['stepfun']);
  assert.equal(state.rows[0].credential.configured, true);
  assert.equal(state.namespaces.get('llm-pi-ai').revision, 7);
  catalogs[0].resolve(found(true));
  await flush();
  state = controller.store.getSnapshot();
  assert.deepEqual(Array.from(state.rows, row => row.entry.provider), ['deepseek-account', 'stepfun']);
});

test('a later invalidation ignores the old catalog and starts one fresh enrichment', async () => {
  const { controller, catalogs } = await harness();
  await controller.load();
  await controller.load();
  await controller.load();
  assert.equal(catalogs.length, 1, 'deduplicate the in-flight account request');
  catalogs[0].resolve(found(true));
  await flush();
  assert.equal(catalogs.length, 2);
  assert.deepEqual(Array.from(controller.store.getSnapshot().rows, row => row.entry.provider), ['stepfun']);
  catalogs[1].resolve(found(true));
  await flush();
  assert.equal(controller.store.getSnapshot().rows[0].entry.provider, 'deepseek-account');
});

test('refresh preserves the last confirmed account, failures are contained, and another load retries', async () => {
  const { controller, catalogs } = await harness();
  await controller.load();
  catalogs[0].resolve(found(true));
  await flush();
  await controller.load();
  assert.equal(controller.store.getSnapshot().rows[0].accountAvailable, true);
  catalogs[1].reject(Error('temporary network failure'));
  await flush();
  assert.equal(controller.store.getSnapshot().rows[0].accountAvailable, true);
  await controller.load();
  assert.equal(catalogs.length, 3);
  catalogs[2].resolve(found(false));
  await flush();
  assert.deepEqual(Array.from(controller.store.getSnapshot().rows, row => row.entry.provider), ['stepfun']);
});

test('a removed account route cannot be revived by a late catalog response', async () => {
  const { controller, catalogs, removeAccount } = await harness();
  await controller.load();
  removeAccount();
  await controller.load();
  catalogs[0].resolve(found(true));
  await flush();
  assert.equal(catalogs.length, 1);
  assert.deepEqual(Array.from(controller.store.getSnapshot().rows, row => row.entry.provider), ['stepfun']);
});

test('disposing the adapter restores the official method and suppresses late enrichment', async () => {
  const { controller, catalogs, dispose, originalRead } = await harness();
  await controller.load();
  dispose();
  assert.equal(controller.read, originalRead);
  assert.equal(Object.hasOwn(controller, 'accountScope'), false);
  assert.equal(Object.hasOwn(controller, 'refreshAccount'), false);
  dispose();
  catalogs[0].resolve(found(true));
  await flush();
  assert.deepEqual(Array.from(controller.store.getSnapshot().rows, row => row.entry.provider), ['stepfun']);
});

test('remounting the same controller isolates the new catalog from the old pending response', async () => {
  const { controller, catalogs, dispose, mount } = await harness();
  await controller.load();
  dispose();
  mount();
  await controller.load();
  assert.equal(catalogs.length, 2);
  const current = controller.accountLoad;
  catalogs[0].resolve(found(true));
  await flush();
  assert.equal(controller.accountLoad, current, 'old finally cannot clear the new request');
  assert.deepEqual(Array.from(controller.store.getSnapshot().rows, row => row.entry.provider), ['stepfun']);
  catalogs[1].resolve(found(true));
  await flush();
  assert.equal(controller.store.getSnapshot().rows[0].entry.provider, 'deepseek-account');
});
