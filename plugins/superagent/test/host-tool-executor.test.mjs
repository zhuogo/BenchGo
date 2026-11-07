import test from 'node:test';
import assert from 'node:assert/strict';
import { createOfficialHostExecutor, OFFICIAL_NATIVE_EXECUTOR } from '../src/host-tool-executor.mjs';

test('loads the official native executor through the Cordis loader by package specifier', async () => {
  const loaded = [];
  class NativeToolExecutor { constructor(scope) { this.scope = scope; } }
  const scope = { tools: {}, loader: { import: async specifier => { loaded.push(specifier); return { NativeToolExecutor }; } } };
  const executor = await createOfficialHostExecutor(scope);
  assert.ok(executor instanceof NativeToolExecutor);
  assert.equal(executor.scope, scope);
  assert.deepEqual(loaded, [OFFICIAL_NATIVE_EXECUTOR]);
});

test('prefers scope.ctx.loader when the scope itself carries no loader', async () => {
  const loaded = [];
  class NativeToolExecutor { constructor(scope) { this.scope = scope; } }
  const scope = { tools: {}, ctx: { loader: { import: async specifier => { loaded.push(specifier); return { default: { NativeToolExecutor } }; } } } };
  const executor = await createOfficialHostExecutor(scope);
  assert.ok(executor instanceof NativeToolExecutor);
  assert.deepEqual(loaded, [OFFICIAL_NATIVE_EXECUTOR]);
});

test('a host without the official executor fails loudly rather than falling back to a local copy', async () => {
  await assert.rejects(createOfficialHostExecutor({ tools: {}, loader: { import: async () => ({}) } }), /宿主未提供官方原生执行器/);
  await assert.rejects(createOfficialHostExecutor({}), /工具服务未就绪/);
});
