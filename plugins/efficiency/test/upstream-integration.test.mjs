import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mountCompaction } from '../src/compaction.mjs';
import { mountOps } from '../src/ops.mjs';
import { mountEfficiency } from '../src/plugin.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Internal source packages consume the sole installable package's dependencies.
const require = createRequire(new URL('../../benchgo/package.json', import.meta.url));
const load = name => import(pathToFileURL(require.resolve(name)).href);
const { Context } = await load('@deepseek-ai/cordis');
const { ToolRuntime } = await load('@deepseek-ai/dsh-tools');
const { createScope } = await load('@deepseek-ai/dsh-scope');
const NativeExecutor = await load('@deepseek-ai/dsh-tool-executor-native');
const ops = ctx => mountOps(ctx, {}, { load: () => load('dsh-ops/integration') });
const compaction = ctx => mountCompaction(ctx, {}, { load: () => load('smart-compaction') });

/** Real Cordis + official scope/tool registries; no model/network is involved. */
async function fixture(t, preset = 'standard') {
  const root = new Context();
  const sections = new Map();
  root.provide('systemPrompt', {
    tools() {}, getSectionOrder() { return 3250; },
    section(value) { sections.set(value.name, value); return () => sections.delete(value.name); },
    async assemble({ scope } = {}) {
      return { tools: root.tools.schemas(scope), contexts: [], variables: {}, sections: [...sections.values()].map(row => ({ name: row.name, text: typeof row.text === 'function' ? row.text({ scope, agent: scope }) : row.text })) };
    },
  });
  await root.plugin(ToolRuntime);
  await root.plugin(NativeExecutor);
  const agent = { id: 'efficiency-test', session: { id: 'efficiency-test', header: { agentPreset: preset }, surface: { nodes: [] }, eventAt() {} }, model: { current: () => ({ provider: 'test', model: 'opaque-test-model' }) } };
  const scope = createScope(root, agent); agent.ctx = scope.ctx;
  const compaction = { async compactRegion() { throw new Error('Empty history must not call the summarizer'); } };
  root.provide('agentPresets', { composedPreset: () => preset, serviceFor: (_agent, name) => name === 'compaction' ? compaction : undefined });
  root.provide('sessionProjections', { stateOf: (_session, name) => name === 'contextPressure' ? { contextWindow: 10000, surfaceTokens: 2000 } : preset });
  root.provide('agents', { list: () => [agent] });
  root.provide('sandboxPolicy', { resolve: () => ({ mode: 'read-only', workspaceRoot: process.cwd() }) });
  root.provide('subprocess', { spawn() { throw new Error('This visibility test must not spawn a process'); } });
  t.after(async () => { await scope.dispose(); await root.fiber.dispose(); });
  return { root, agent };
}

test('published smart-compaction registers real tools, reads usage, and uses the session compaction service', async t => {
  const { root, agent } = await fixture(t);
  const adapter = await compaction(root);
  t.after(() => adapter.dispose());
  assert.ok(root.tools.schemas(agent).some(row => row.name === 'context_status'));
  const signal = new AbortController().signal;
  const context = await root.tools.get('context_status', agent).execute({}, { agent, signal });
  assert.equal(context.contextWindow, 10000);
  assert.equal(context.usedTokens, 2000);
  assert.equal(context.percentUsed, 20);
  assert.deepEqual(await root.tools.get('compact_now', agent).execute({}, { agent, signal }), { compacted: false });
  assert.equal(adapter.diagnose(agent).compact, true);
  await adapter.dispose();
  assert.equal(root.tools.get('compact_now', agent), undefined);
  assert.equal(root.tools.get('context_status', agent), undefined);
});

test('published OPS integration attaches to actual official agent scopes and removes its tools on unload', async t => {
  const { root, agent } = await fixture(t);
  const adapter = await ops(root);
  t.after(() => adapter.dispose());
  // The upstream integration owns deferred publication. Await its public event
  // boundary so assertions observe registered tools rather than a timer guess.
  await root.parallel('agent/created', { agent });
  const names = root.tools.schemas(agent).map(row => row.name);
  assert.ok(names.includes('ops_inspect_local_file'), names.join(', '));
  assert.ok(names.includes('ops_read_files'), names.join(', '));
  assert.ok(names.includes('ops_status'), names.join(', '));
  assert.equal(names.includes('ops_bash'), false);
  const status = await adapter.diagnose(agent);
  assert.ok(status.tools.includes('ops_read_files'));
  await adapter.dispose();
  const after = root.tools.schemas(agent).map(row => row.name);
  assert.equal(after.some(name => name.startsWith('ops_')), false, after.join(', '));
});

test('real host injection publishes tools and hot configuration releases and restores them', async t => {
  const { root, agent } = await fixture(t);
  root.provide('connection', { fetch: { register() { return () => {}; } } });
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-real-efficiency-'));
  const service = await mountEfficiency(root, { directory, adapters: { ops, compaction } });
  t.after(async () => { await service.dispose(); await rm(directory, { recursive: true, force: true }); });
  const ready = async name => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const state = service.snapshot().features[name];
      if (state.state === 'ready') return;
      assert.notEqual(state.state, 'unavailable', state.error);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail(JSON.stringify(service.snapshot()));
  };
  await ready('ops'); await ready('compaction');
  await root.parallel('agent/created', { agent });
  assert.ok(root.tools.get('ops_read_files', agent));
  assert.ok(root.tools.get('context_status', agent));
  await service.update({ revision: 0, features: { ops: { enabled: false }, compaction: { enabled: false } } });
  assert.equal(root.tools.get('ops_read_files', agent), undefined);
  assert.equal(root.tools.get('context_status', agent), undefined);
  await service.update({ revision: 1, features: { ops: { enabled: true }, compaction: { enabled: true } } });
  await ready('ops'); await ready('compaction');
  await root.parallel('agent/created', { agent });
  assert.ok(root.tools.get('ops_read_files', agent));
  assert.ok(root.tools.get('context_status', agent));
  await service.dispose();
  assert.equal(root.tools.get('ops_read_files', agent), undefined);
  assert.equal(root.tools.get('context_status', agent), undefined);
});
