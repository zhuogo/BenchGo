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
    mkdir: async () => {}, mountInteractivePrompt: noop,
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
