import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelCatalogLoader, mountModelCatalogs, pickerCatalog } from '../client/model-catalog.mjs';

test('catalog readers share one request and reuse successful reads until the TTL expires', async () => {
  let time = 0, reads = 0;
  const loader = createModelCatalogLoader(async () => ({ id: ++reads }), { now: () => time });
  const first = loader.load(), second = loader.load();
  assert.equal(first, second);
  assert.deepEqual(await Promise.all([first, second]), [{ id: 1 }, { id: 1 }]);
  time = 29_999;
  assert.deepEqual(await loader.load(), { id: 1 }); assert.equal(reads, 1);
  time = 30_000;
  assert.equal(loader.peek(), null);
  assert.deepEqual(await loader.load(), { id: 2 });
});

test('failed reads can retry immediately and never become a successful catalog', async () => {
  let reads = 0;
  const loader = createModelCatalogLoader(async () => { if (++reads === 1) throw Error('offline'); return { providers: [] }; });
  await assert.rejects(loader.load(), /offline/);
  assert.equal(loader.peek(), null);
  assert.deepEqual(await loader.load(), { providers: [] }); assert.equal(reads, 2);
});

test('configuration invalidation supersedes pending results for every reader', async () => {
  const finish = [], loader = createModelCatalogLoader(() => new Promise(resolve => finish.push(resolve)));
  const stale = loader.load(); await Promise.resolve();
  let updates = 0; const unsubscribe = loader.subscribe(() => updates++);
  loader.invalidate(); assert.equal(updates, 1);
  const fresh = loader.load(); await Promise.resolve();
  finish[1]({ id: 'new' }); assert.deepEqual(await fresh, { id: 'new' });
  finish[0]({ id: 'old' }); assert.deepEqual(await stale, { id: 'new' });
  assert.deepEqual(loader.peek(), { id: 'new' }); unsubscribe();
});

test('service addresses isolate values and pending requests, including a stale error', async () => {
  let address = 'host-a'; const finish = [];
  const loader = createModelCatalogLoader(scope => new Promise((resolve, reject) => finish.push({ scope, resolve, reject })), { scope: () => address });
  const stale = loader.load(); await Promise.resolve(); address = 'host-b';
  assert.equal(loader.peek(), null);
  const fresh = loader.load(); await Promise.resolve();
  assert.deepEqual(finish.map(item => item.scope), ['host-a', 'host-b']);
  finish[1].resolve({ host: 'b' }); assert.deepEqual(await fresh, { host: 'b' });
  finish[0].reject(Error('old host failed')); assert.deepEqual(await stale, { host: 'b' });
  address = 'host-a'; assert.equal(loader.peek(), null);
});

test('returning to a service address cannot revive its older in-flight catalog', async () => {
  let address = 'a'; const finish = [];
  const loader = createModelCatalogLoader(() => new Promise(resolve => finish.push(resolve)), { scope: () => address });
  const oldA = loader.load(); await Promise.resolve(); address = 'b';
  const oldB = loader.load(); await Promise.resolve(); address = 'a';
  const freshA = loader.load(); await Promise.resolve();
  finish[0]({ value: 'old-a' }); finish[1]({ value: 'old-b' }); finish[2]({ value: 'fresh-a' });
  assert.deepEqual(await Promise.all([oldA, oldB, freshA]), Array(3).fill({ value: 'fresh-a' }));
  assert.deepEqual(loader.peek(), { value: 'fresh-a' });
});

test('malformed successful HTTP responses are not cached and retry accepts complete catalogs', async () => {
  const previousFetch = globalThis.fetch, previousDocument = globalThis.document;
  let reads = 0;
  globalThis.document = { baseURI: 'https://catalog-format.test/' };
  globalThis.fetch = async () => new Response(JSON.stringify(++reads === 1 ? {} : { tools: [], providers: [], routes: [] }));
  pickerCatalog.invalidate();
  try {
    await assert.rejects(pickerCatalog.load(), /响应格式不完整/);
    assert.equal(pickerCatalog.peek(), null);
    assert.deepEqual(await pickerCatalog.load(), { tools: [], providers: [], routes: [] });
    assert.equal(reads, 2);
  } finally { pickerCatalog.invalidate(); globalThis.fetch = previousFetch; if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument; }
});

test('official configuration, credentials, model and connection events invalidate shared metadata', () => {
  const events = new Map(), cleanups = [];
  mountModelCatalogs({ effect: fn => cleanups.push(fn()), on: (event, fn) => events.set(event, fn), remote: { $on: (event, fn) => events.set(event, fn) } });
  for (const event of ['connection/reset', 'llm/adapters-updated', 'llm/models-updated', 'settings/document-updated', 'credentials/record-updated', 'credentials/reference-updated']) {
    const before = pickerCatalog.getSnapshot(); events.get(event)(); assert.equal(pickerCatalog.getSnapshot(), before + 1);
  }
  const before = pickerCatalog.getSnapshot(); cleanups[0](); assert.equal(pickerCatalog.getSnapshot(), before + 1);
});
