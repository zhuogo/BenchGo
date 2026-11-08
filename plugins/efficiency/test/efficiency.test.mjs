import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mountEfficiency } from '../src/plugin.mjs';
import { mountOps } from '../src/ops.mjs';
import { mountCompaction } from '../src/compaction.mjs';

function host(services = {}) {
  const effects = [], fibers = [], routes = [];
  const ctx = {
    logger: { warn() {} },
    connection: { fetch: { register(route) { routes.push(route); return () => { routes.splice(routes.indexOf(route), 1); }; } } },
    get: key => services[key],
    provide(key, value) { services[key] = value; },
    effect(callback) { effects.push(callback()); },
    inject(required, apply) {
      const child = host(services);
      const promise = Promise.resolve().then(() => { if (required.every(key => services[key])) return apply(child.ctx); });
      promise.dispose = async () => { await promise; await child.dispose(); };
      fibers.push(promise);
      return promise;
    },
  };
  return { ctx, routes, services, async settled() { await Promise.all(fibers); }, async dispose() { for (const effect of effects.reverse()) await effect?.(); } };
}

const readyServices = () => ({ tools: {}, agents: {}, agentPresets: {}, sessionProjections: {}, systemPrompt: {}, sandboxPolicy: {}, subprocess: {} });

async function fixture(t, services = readyServices()) {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-efficiency-test-'));
  const live = host(services), calls = [], disposals = [];
  const adapters = Object.fromEntries(['ops', 'compaction'].map(name => [name, async (_ctx, config) => {
    calls.push({ name, config: structuredClone(config) });
    let ended = false;
    return { diagnose: () => ({ state: ended ? 'disabled' : 'ready' }), async dispose() { if (!ended) { ended = true; disposals.push(name); } } };
  }]));
  const service = await mountEfficiency(live.ctx, { directory, adapters });
  await live.settled();
  t.after(async () => { await service.dispose(); await rm(directory, { recursive: true, force: true }); });
  return { directory, live, service, calls, disposals, adapters };
}

test('configuration saves merge one feature, remount only that feature, and survive reload', async t => {
  const { service, directory, calls, disposals, adapters } = await fixture(t);
  assert.equal(service.snapshot().features.ops.available, true);
  await service.update({ revision: 0, features: { ops: { shell: true } } });
  assert.deepEqual(disposals, ['ops']);
  assert.equal(calls.filter(row => row.name === 'compaction').length, 1);
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'efficiency.json'), 'utf8')).features,
    { ops: { enabled: true, shell: true }, compaction: { enabled: true } });
  await service.dispose();
  const restored = host(readyServices());
  const next = await mountEfficiency(restored.ctx, { directory, adapters });
  await restored.settled();
  assert.equal(next.snapshot().revision, 1);
  assert.equal(next.snapshot().features.ops.shell, true);
  await next.dispose();
});

test('concurrent stale configuration cannot overwrite another selection', async t => {
  const { service } = await fixture(t);
  const result = await Promise.allSettled([
    service.update({ revision: 0, features: { ops: { enabled: false } } }),
    service.update({ revision: 0, features: { compaction: { enabled: false } } }),
  ]);
  assert.equal(result[0].status, 'fulfilled');
  assert.equal(result[1].reason.status, 409);
  assert.equal(service.snapshot().features.compaction.enabled, true);
  assert.equal(service.snapshot().features.ops.state, 'disabled');
});

test('owner route survives unavailable optional host services and rejects cross-origin writes', async t => {
  const { service, live } = await fixture(t, {});
  assert.equal(live.routes[0].path, '/api/benchgo/efficiency');
  assert.equal(service.snapshot().features.ops.available, false);
  assert.equal(service.snapshot().features.ops.state, 'waiting_services');
  const response = await service.fetch(new Request('http://127.0.0.1:3080/api/benchgo/efficiency', {
    method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
    body: JSON.stringify({ revision: 0, features: { ops: { enabled: false } } }),
  }));
  assert.equal(response.status, 403);
  assert.equal(service.snapshot().revision, 0);
});

test('invalid settings fail without replacing saved configuration', async t => {
  const { service } = await fixture(t);
  await assert.rejects(service.update({ revision: 0, features: { ops: { enabled: 'true' } } }), /无效/);
  await assert.rejects(service.update({ revision: 0, features: { compaction: { safePointRatio: 0.5 } } }), /无效/);
  assert.equal(service.snapshot().revision, 0);
});

test('corrupt persisted settings are retained and fail explicitly', async t => {
  const { directory, service, adapters } = await fixture(t);
  await service.dispose();
  await writeFile(join(directory, 'efficiency.json'), '{broken');
  await assert.rejects(mountEfficiency(host().ctx, { directory, adapters }), SyntaxError);
  assert.equal(await readFile(join(directory, 'efficiency.json'), 'utf8'), '{broken');
});

test('dependency load failure is visible while other capability remains enabled', async t => {
  const { service, directory, adapters } = await fixture(t);
  await service.dispose();
  const root = host(readyServices());
  const broken = await mountEfficiency(root.ctx, { directory, adapters: { ...adapters, ops: async () => { throw Object.assign(new Error('missing dsh-ops'), { code: 'ERR_MODULE_NOT_FOUND' }); } } });
  await root.settled();
  assert.equal(broken.snapshot().features.ops.installed, false);
  assert.equal(broken.snapshot().features.ops.available, false);
  assert.equal(broken.snapshot().features.compaction.available, true);
  await broken.dispose();
});

test('OPS public integration keeps native CLI and official tools unchanged and tears down all presets', async () => {
  const configurations = [], disposed = [];
  const module = { integration(config) { configurations.push(config); return { config }; }, diagnose: async () => ({ state: 'ready' }) };
  const ctx = { plugin(value) { const fiber = Promise.resolve(); fiber.dispose = async () => disposed.push(value.config.preset); return fiber; } };
  const adapter = await mountOps(ctx, {}, { load: async () => module });
  assert.deepEqual(configurations.map(row => row.preset), ['standard', 'ptc', 'cordis']);
  assert.equal(configurations[1].profile, 'ptc');
  assert.ok(configurations.every(row => !row.replaceOfficial && !row.hidePwsh && !row.shell));
  await adapter.dispose(); await adapter.dispose();
  assert.equal(disposed.length, 3);
});

test('OPS partial mounting failure disposes acquired preset bindings', async () => {
  let count = 0, disposed = 0;
  const ctx = { plugin() { const fiber = ++count === 2 ? Promise.reject(new Error('preset failed')) : Promise.resolve(); fiber.dispose = async () => { disposed++; }; return fiber; } };
  await assert.rejects(mountOps(ctx, {}, { load: async () => ({ integration: () => ({}), diagnose() {} }) }), /preset failed/);
  assert.equal(disposed, 2);
});

test('smart compaction delegates existing service and never introduces an automatic trigger', async () => {
  let config, disposed = 0;
  const compaction = { compactRegion() {} }, registry = { serviceFor: () => compaction };
  const definitions = new Map(), tools = { get: name => definitions.get(name), register() {} };
  const ctx = { get: name => ({ tools, agentPresets: registry, sessionProjections: { stateOf() {} } })[name], plugin(_module, options) { config = options; definitions.set('compact_now', {}); definitions.set('context_status', {}); const fiber = Promise.resolve(); fiber.dispose = async () => { disposed++; }; return fiber; } };
  const adapter = await mountCompaction(ctx, {}, { load: async () => ({ apply() {} }) });
  assert.deepEqual(config, { safePointRatio: false });
  assert.equal(adapter.diagnose({}).compact, true);
  assert.equal(adapter.contextTools().length, 2);
  definitions.set('compact_now', {});
  assert.deepEqual(adapter.contextTools().map(row => row.name), ['context_status']);
  await adapter.dispose(); await adapter.dispose();
  assert.equal(disposed, 1);
  assert.equal(adapter.diagnose({}).state, 'disabled');
});

test('same-named context tools are not overwritten', async () => {
  const tools = { get: name => name === 'compact_now' ? {} : undefined, register() {} };
  await assert.rejects(mountCompaction({ get: () => tools }, {}, { load: async () => { throw new Error('must not load'); } }), /名称冲突/);
});
