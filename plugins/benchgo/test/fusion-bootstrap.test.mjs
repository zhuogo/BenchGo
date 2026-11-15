import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import { Context } from '@deepseek-ai/cordis';

test('base composition keeps optional service objects out of Cordis disposer collection', async () => {
  const ctx = new Context(), live = new Set(), errors = [];
  let managementClosed = 0;
  ctx.on('internal/error', error => errors.push(error));
  ctx.provide('connection', { fetch: { register: () => () => {} } });
  ctx.provide('webServer', {});
  const mockMount = name => async child => {
    child.provide(name, { available: true }); live.add(name);
    child.effect(() => () => live.delete(name));
    return { snapshot() {}, dispose() {} };
  };
  const noop = () => {};
  const imports = {
    mkdir: async () => {}, mountInteractivePrompt: noop, hostScope: noop,
    createSettingsManagement: () => ({ register: () => () => {}, close: async () => { managementClosed++; } }),
    mountWorkbench: mockMount('benchgoWorkbench'), mountEfficiency: mockMount('benchgoEfficiency'),
    mountSkills: noop, mountPreviewAssets: noop, mountUsage: noop, mountUpdates: noop,
  };
  const exports = {}, source = readFileSync(new URL('../src/plugin.mjs', import.meta.url), 'utf8');
  const transformed = transformSync(source, { format: 'cjs', platform: 'node' }).code;
  const module = { exports };
  runInNewContext(transformed, { module, exports, require: () => imports, Response });
  const fiber = ctx.plugin({ apply: module.exports.apply }, { dataDir: 'unused-fixture-directory' });
  try {
    await fiber.await();
    assert.deepEqual([...live].sort(), ['benchgoEfficiency', 'benchgoWorkbench']);
    assert.deepEqual(errors, []);
    await fiber.dispose(); assert.equal(live.size, 0);
    assert.equal(managementClosed, 1, 'the base awaits its owned management journal disposal');
  } finally { await ctx.fiber.dispose(); }
});

test('module probe route survives pending or failed preview initialization', async t => {
  for (const fail of [false, true]) await t.test(fail ? 'failed preview' : 'pending preview', async () => {
    const ctx = new Context(), routes = new Map(), errors = [];
    ctx.on('internal/error', error => errors.push(error));
    ctx.provide('connection', {fetch: {register(route) {
      routes.set(route.path, route); return () => routes.delete(route.path);
    }}});
    let releasePreview, startPreview;
    const started = new Promise(resolve => { startPreview = resolve; });
    const pending = new Promise(resolve => { releasePreview = resolve; });
    const previewError = new Error('preview manifest unavailable');
    const noop = () => {};
    const imports = new Proxy({
      createSettingsManagement: () => ({close: noop}),
      mountPreviewAssets: async () => { startPreview(); await pending; if (fail) throw previewError; },
    }, {get: (value, key) => value[key] ?? noop});
    const module = {exports: {}};
    runInNewContext(transformSync(readFileSync(new URL('../src/plugin.mjs', import.meta.url), 'utf8'), {format: 'cjs', platform: 'node'}).code,
      {module, exports: module.exports, require: () => imports, Response});
    const fiber = ctx.plugin({apply: module.exports.apply}, {dataDir: 'unused-fixture-directory'});
    const ready = fiber.await().catch(error => error);
    try {
      await started;
      const route = routes.get('/api/benchgo/modules');
      assert(route, 'the module probe must not wait for preview resources');
      const response = await route.fetch(new Request('https://benchgo.test/api/benchgo/modules'));
      assert.equal(response.status, 200);
      assert.equal(typeof (await response.json()).modules.base.available, 'boolean');
      releasePreview(); await ready;
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(routes.get('/api/benchgo/modules'), route, 'preview failure must not retire the probe owner');
      if (!fail) assert.deepEqual(errors, []);
    } finally { releasePreview(); await ctx.fiber.dispose(); }
    assert.equal(routes.size, 0, 'client owner disposal still releases the route');
  });
});
