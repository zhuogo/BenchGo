import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRouterGoAccount } from '../src/routergo-account.mjs';
import { createModelCapabilitySettings } from '../src/model-capability-settings.mjs';

const device = 'fixture-private-device-code';
const key = 'fixture-private-router-key';
const token = 'fixture-private-account-token';
const identity = { id: '12', name: '测试账号', username: 'fixture-user' };
const baseURL = 'https://routergo.cn/api/v1';

function fixture({ manual = false, base = baseURL, directory } = {}) {
  const existing = { id: 'Opaque/Model:A', contextWindow: 10000, reasoningEfforts: false };
  const doc = { ns: 'llm-pi-ai', revision: 6, value: { providers: { other: { api: 'openai-responses' }, ...(manual && {
    routergo: { displayName: '手填名称', api: 'openai-completions', baseURL: base, apiKeyEnv: 'ROUTERGO_API_KEY', models: [existing] },
  }) } } };
  const refs = new Map(manual ? [['ROUTERGO_API_KEY', 'old-manual-secret']] : []);
  const requests = [];
  let result = 'authorization_pending', now = 0, failure, discoveries = 0;
  let catalog = [{ id: existing.id, name: '目录名称', contextWindow: 20000 }, {
    id: 'Opaque/Model:a', name: '另一个模型', contextWindow: 24000, maxTokens: 4096,
    inputModalities: ['text', 'image', 'audio'], thinkingLevels: ['off', 'min', 'high'],
  }];
  const ctx = {
    settings: {
      describe: () => [structuredClone(doc)],
      async mutate(ns, ops, revision) {
        assert.equal(ns, doc.ns); assert.equal(revision, doc.revision);
        if (failure === 'settings') throw Error(key);
        for (const { path, value } of ops) {
          const target = path.slice(0, -1).reduce((at, segment) => at[segment], doc.value);
          target[path.at(-1)] = structuredClone(value);
        }
        doc.revision++;
      },
    },
    credentials: {
      async resolve(ref) { return refs.has(ref) ? { value: refs.get(ref) } : undefined; },
      async set(ref, value) { refs.set(ref, value); },
      async unset(ref) { refs.delete(ref); },
    },
  };
  const options = {
    directory,
    now: () => now,
    async fetcher(url, options) {
      requests.push({ url, options });
      assert.equal(options.redirect, 'error');
      const action = new URL(url).pathname.split('/').at(-1);
      if (action === 'device') return Response.json({ device_code: device, expires_in: 60, interval: 2, verification_uri_complete: 'https://routergo.cn/benchgo/authorize?request=public-id' });
      if (action === 'token') return result ? Response.json({ error: result }, { status: 400 }) : Response.json({ api_key: key, token_type: 'Bearer', access_token: token, account: identity });
      assert.equal(action, 'account');
      assert.equal(options.headers['X-BenchGo-Account-Proof'], token);
      return Response.json({ account: identity, balance: { amount: '0.000030', unit: '额度' } });
    },
    async discover(apiKey) {
      assert.equal(apiKey, key);
      discoveries++;
      if (failure === 'catalog') throw Error(key);
      return catalog;
    },
  };
  const service = createRouterGoAccount(ctx, options);
  return { service, doc, refs, requests, existing, mode: next => { result = next; }, advance: seconds => { now += seconds * 1000; }, fail: code => { failure = code; },
    restart: () => createRouterGoAccount(ctx, options), discoveries: () => discoveries, catalog: next => { catalog = next; } };
}

async function call(service, action, extra = {}, origin = 'http://localhost:4000') {
  const response = await service.fetch(new Request('http://localhost:4000/api/benchgo/routergo', {
    method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ action, ...extra }),
  }));
  const body = await response.json();
  for (const secret of [device, key, token, 'old-manual-secret']) assert(!JSON.stringify(body).includes(secret));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return { status: response.status, body };
}

test('first sign-in respects polling interval, imports exact ids and restores balance through the official references', async t => {
  const f = fixture(); t.after(f.service.clear);
  const { body: session } = await call(f.service, 'start');
  assert.equal(session.verificationURL, 'https://routergo.cn/benchgo/authorize?request=public-id');
  const request = { id: session.id };
  assert.deepEqual((await call(f.service, 'poll', request)).body, { state: 'pending', retryAfter: 2 });
  assert.equal(f.requests.length, 1);
  f.advance(2); f.mode('slow_down');
  assert.deepEqual((await call(f.service, 'poll', request)).body, { state: 'pending', retryAfter: 7 });
  assert.deepEqual(JSON.parse(f.requests.at(-1).options.body), { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: 'benchgo' });
  assert.equal(f.requests.at(-1).options.headers['X-BenchGo-Device-Code'], device);
  f.advance(7); f.mode(null);
  assert.deepEqual((await call(f.service, 'poll', request)).body, { state: 'authorized', account: identity, requireSwitch: false });
  assert.equal((await call(f.service, 'save', request)).body.imported, 2);
  const { routergo, other } = f.doc.value.providers;
  assert.deepEqual(other, { api: 'openai-responses' });
  assert.equal(routergo.api, 'openai-responses');
  assert.equal(f.refs.get(routergo.apiKeyEnv), key);
  assert.deepEqual(routergo.models[1], { id: 'Opaque/Model:a', name: '另一个模型', contextWindow: 24000, maxTokens: 4096, input: ['text', 'image'], reasoningEfforts: { off: null, minimal: 'min', high: 'high' } });
  const restarted = createRouterGoAccount({ settings: { describe: () => [f.doc] }, credentials: { resolve: async ref => ({ value: f.refs.get(ref) }) } }, {
    fetcher: async (_url, options) => { assert.equal(options.headers['X-BenchGo-Account-Proof'], token); return Response.json({ balance: { amount: '0.000030', unit: '额度' }, account: identity }); },
  });
  assert.deepEqual((await call(restarted, 'status')).body, { state: 'connected', account: identity, balance: { amount: '0.000030', unit: '额度' } });
  assert.equal((await call(f.service, 'poll', request)).status, 410);
});

test('manual credential needs explicit replacement, retry preserves existing configuration and cleans uncommitted credentials', async t => {
  const f = fixture({ manual: true }); t.after(f.service.clear);
  const { body: { id } } = await call(f.service, 'start');
  f.advance(2); f.mode(null);
  assert.equal((await call(f.service, 'poll', { id })).body.requireSwitch, true);
  assert.equal((await call(f.service, 'save', { id })).body.code, 'switch_required');
  f.fail('catalog');
  assert.equal((await call(f.service, 'save', { id, replace: true })).status, 502);
  f.fail('settings');
  assert.equal((await call(f.service, 'save', { id, replace: true })).status, 409);
  assert.deepEqual([...f.refs], [['ROUTERGO_API_KEY', 'old-manual-secret']]);
  f.fail();
  assert.equal((await call(f.service, 'save', { id, replace: true })).body.imported, 1);
  assert.equal(f.doc.value.providers.routergo.api, 'openai-completions');
  assert.equal(f.doc.value.providers.routergo.displayName, 'RouterGo');
  assert.deepEqual(f.doc.value.providers.routergo.models[0], f.existing);
  assert.equal(f.refs.get('ROUTERGO_API_KEY'), 'old-manual-secret');
});

test('existing account sync updates the managed connection and preserves the exact credentials and model list', async t => {
  const f = fixture({ manual: true }); t.after(f.service.dispose);
  const ref = 'BENCHGO_ROUTERGO_KEY_0123456789abcdef0123456789abcdef';
  const profile = f.doc.value.providers.routergo;
  profile.apiKeyEnv = ref;
  profile.baseURL += '/';
  f.refs.set(ref, key);
  f.catalog([]);
  assert.deepEqual((await call(f.service, 'sync')).body, { state: 'synced', added: 0, updated: 0, removed: 0 });
  assert.deepEqual(profile, {
    displayName: 'RouterGo', api: 'openai-completions', baseURL, apiKeyEnv: ref, models: [f.existing],
  });
  assert.equal(f.refs.get(ref), key);
  assert.equal(f.refs.get('ROUTERGO_API_KEY'), 'old-manual-secret');
});

test('custom endpoint and foreign origins are rejected before outbound requests, cancel and timeout invalidate the code', async t => {
  const f = fixture(); t.after(f.service.clear);
  assert.equal((await call(f.service, 'start', {}, 'https://foreign.invalid')).status, 403);
  assert.equal(f.requests.length, 0);
  const custom = fixture({ manual: true, base: 'https://other.invalid/v1' });
  assert.equal((await call(custom.service, 'start')).status, 409);
  assert.equal(custom.requests.length, 0);
  const { body: { id } } = await call(f.service, 'start');
  assert.equal((await call(f.service, 'cancel', { id })).body.state, 'cancelled');
  assert.equal((await call(f.service, 'poll', { id })).status, 410);
  const { body: next } = await call(f.service, 'start');
  f.advance(60);
  assert.equal((await call(f.service, 'poll', { id: next.id })).status, 410);
});

test('catalog sync persists automatic ownership, protects local changes and retries without overlapping discovery', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-routergo-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const f = fixture({ directory });
  t.after(f.service.dispose);
  const { body: { id } } = await call(f.service, 'start');
  f.advance(2); f.mode(null);
  f.catalog(['Update', 'Remove', 'Edited', 'Capability', 'Deleted'].map(id => ({ id, name: id, contextWindow: 24000, ...(id === 'Update' ? { thinkingLevels: ['off', 'high'] } : {}) })));
  await call(f.service, 'poll', { id });
  assert.equal((await call(f.service, 'save', { id })).body.imported, 5);
  const saved = f.doc.value.providers.routergo;
  assert.deepEqual(saved.models[0].reasoningEfforts, { off: null, high: 'high' });
  const edited = { ...saved.models.find(model => model.id === 'Edited'), contextWindow: 99_000 };
  saved.models = saved.models.filter(model => model.id !== 'Deleted').map(model => model.id === 'Edited' ? edited : model);
  saved.models.push({ id: 'Manual', name: '手动保留' });
  await createModelCapabilitySettings(directory).save('routergo', 'Capability', ['chat']);
  const next = f.restart();
  t.after(next.dispose);
  const before = structuredClone(saved.models);
  f.catalog([
    { id: 'Update', name: '新名称', contextWindow: 32000, thinkingLevels: ['high'] }, { id: 'Deleted', name: 'Deleted' },
    { id: 'Edited', name: '更新显示名', contextWindow: 48_000 }, { id: 'update', name: '区分大小写' },
  ]);
  f.fail('catalog');
  const error = await call(next, 'sync', { force: true });
  assert.equal(error.status, 502);
  assert.deepEqual(saved.models, before);
  f.fail();
  const reads = f.discoveries();
  const results = await Promise.all([call(next, 'sync', { force: true }), call(next, 'sync', { force: true })]);
  assert.deepEqual(results.map(result => result.body), Array(2).fill({ state: 'synced', added: 1, updated: 2, removed: 1 }));
  assert.equal(f.discoveries(), reads + 1);
  assert.deepEqual(saved.models, [
    { id: 'Update', name: '新名称', contextWindow: 32000, reasoningEfforts: { high: 'high' } }, { ...edited, name: '更新显示名' },
    { id: 'Capability', name: 'Capability', contextWindow: 24000 }, { id: 'Manual', name: '手动保留' }, { id: 'update', name: '区分大小写' },
  ]);
  f.catalog([]);
  assert.equal((await call(next, 'sync')).body.state, 'recent');
  f.advance(61);
  assert.equal((await call(next, 'sync')).body.removed, 2);
  assert.deepEqual(saved.models.map(model => model.id), ['Edited', 'Capability', 'Manual']);
  assert.equal(f.doc.value.providers.other.api, 'openai-responses');
});
