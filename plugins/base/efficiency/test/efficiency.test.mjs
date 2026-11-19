import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
  const live = host(services), calls = [], disposals = [], definitions = [{ name: 'context_status', definition: {} }];
  const adapters = Object.fromEntries(['ops', 'compaction'].map(name => [name, async (_ctx, config) => {
    calls.push({ name, config: structuredClone(config) });
    let ended = false;
    return { contextTools: () => ended ? [] : definitions, diagnose: () => ({ state: ended ? 'disabled' : 'ready' }), async dispose() { if (!ended) { ended = true; disposals.push(name); } } };
  }]));
  const service = await mountEfficiency(live.ctx, { directory, adapters });
  await live.settled();
  t.after(async () => { await service.dispose(); await rm(directory, { recursive: true, force: true }); });
  return { directory, live, service, calls, disposals, adapters, definitions };
}

test('built-in tools and context management start without settings, routes, or configuration files', async t => {
  const { service, live, directory, calls } = await fixture(t);
  assert.deepEqual(calls.map(row => [row.name, row.config]), [
    ['ops', { enabled: true, shell: false }], ['compaction', { enabled: true }],
  ]);
  assert.equal(live.services.benchgoEfficiency, service);
  assert.equal(service.snapshot().features.ops.available, true);
  assert.equal(service.snapshot().features.compaction.available, true);
  assert.equal(service.snapshot().features.ops.version, undefined);
  assert.equal(service.update, undefined);
  assert.equal(service.fetch, undefined);
  assert.deepEqual(live.routes, []);
  assert.deepEqual(await readdir(directory), []);
});

test('built-in defaults ignore legacy switches and preserve existing configuration bytes', async t => {
  const { directory, service, adapters } = await fixture(t);
  await service.dispose();
  const legacy = '{broken legacy settings';
  await writeFile(join(directory, 'efficiency.json'), legacy);
  const root = host(readyServices());
  const next = await mountEfficiency(root.ctx, { directory, config: { features: { ops: { enabled: false, shell: true }, compaction: { enabled: false } } }, adapters });
  await root.settled();
  assert.equal(next.snapshot().features.ops.shell, false);
  assert.equal(next.snapshot().features.ops.available, true);
  assert.equal(next.snapshot().features.compaction.available, true);
  assert.equal(await readFile(join(directory, 'efficiency.json'), 'utf8'), legacy);
  await next.dispose();
});

test('missing host services are reported without disabling other capabilities or mounting settings', async t => {
  const { service, calls, live } = await fixture(t, { tools: {} });
  assert.equal(service.snapshot().features.ops.state, 'waiting_services');
  assert.equal(service.snapshot().features.ops.available, false);
  assert.equal(service.snapshot().features.compaction.available, true);
  assert.deepEqual(calls.map(row => row.name), ['compaction']);
  assert.deepEqual(live.routes, []);
});

test('diagnostics preserve owned definitions and built-in scopes clean up once', async t => {
  const { service, definitions, disposals } = await fixture(t);
  assert.deepEqual(service.contextTools(), definitions);
  assert.equal((await service.diagnose({})).features.ops.session.state, 'ready');
  await service.dispose(); await service.dispose();
  assert.deepEqual(disposals.sort(), ['compaction', 'ops']);
  assert.deepEqual(service.contextTools(), []);
  assert.equal(service.snapshot().features.ops.available, false);
});

test('dependency failure reports BenchGo capability names and leaves context management available', async t => {
  const { service, directory, adapters } = await fixture(t);
  await service.dispose();
  const root = host(readyServices());
  const broken = await mountEfficiency(root.ctx, { directory, adapters: { ...adapters, ops: async () => { throw Object.assign(new Error('missing dsh-ops'), { code: 'ERR_MODULE_NOT_FOUND' }); } } });
  await root.settled();
  assert.equal(broken.snapshot().features.ops.installed, false);
  assert.equal(broken.snapshot().features.ops.available, false);
  assert.equal(broken.snapshot().features.ops.error, 'missing 执行工具');
  assert.equal(broken.snapshot().features.compaction.available, true);
  await broken.dispose();
});

test('OPS public integration keeps native CLI and official tools unchanged and tears down all presets', async () => {
  const configurations = [], disposed = [];
  const module = { integration(config) { configurations.push(config); return { config }; }, diagnose: async () => ({ state: 'ready' }) };
  const ctx = { plugin(value) { const fiber = Promise.resolve(); fiber.dispose = async () => disposed.push(value.config.preset); return fiber; } };
  const adapter = await mountOps(ctx, { shell: true }, { load: async () => module });
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
