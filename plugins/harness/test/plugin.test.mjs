import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import * as NativeToolExecutor from '../../../deepseek-harness/packages/core/tool-executor-native/lib/index.js';
import * as plugin from '../src/plugin.mjs';
import { Commander } from '../src/runtime.mjs';

function loadHarness(ctx, directory) {
  ctx.provide('benchgo', { directory, config: {} });
  ctx.provide('benchgoTooling', {});
  return ctx.plugin(plugin);
}

test('a live owner prevents Harness startup without changing the original data or services', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'harness-startup-'));
  const owner = await new Commander({ dataDir: directory }).open();
  const record = await readFile(join(directory, 'owner.lock'), 'utf8');
  const ctx = new Context(), tools = new Map();
  ctx.provide('tools', { register(value) { tools.set(value.name, value); } });
  t.after(async () => { await ctx.fiber.dispose(); await owner.close(); await rm(directory, { recursive: true, force: true }); });
  const fiber = loadHarness(ctx, directory);
  await assert.rejects(fiber.await(), /already in use/);
  assert.equal(ctx.get('commander'), undefined);
  assert.ok(ctx.get('benchgo'));
  assert.equal(tools.size, 0);
  assert.equal(await readFile(join(directory, 'owner.lock'), 'utf8'), record);
});

test('invalid saved state fails only Harness and never publishes native tools', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'harness-invalid-startup-'));
  const data = '{corrupt sessions';
  await writeFile(join(directory, 'sessions.json'), data);
  const ctx = new Context();
  ctx.provide('tools', { register() { assert.fail('must not register tools with an unavailable store'); } });
  t.after(async () => { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }); });
  await assert.rejects(loadHarness(ctx, directory).await());
  assert.ok(ctx.get('benchgo'));
  assert.equal(await readFile(join(directory, 'sessions.json'), 'utf8'), data);
  await assert.rejects(readFile(join(directory, 'owner.lock')), { code: 'ENOENT' });
});

test('actual Cordis loads/unloads the service and tools; conversations cannot access each other or self-approve', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'commander-plugin-'));
  const ctx = new Context(); const tools = new Map();
  ctx.provide('tools', { register(definition) { tools.set(definition.name, definition); } });
  try {
    await loadHarness(ctx, directory);
    assert.ok(ctx.commander);
    assert.ok(tools.has('commander_create'));
    assert.equal(tools.has('commander_approve'), false);
    const exec = { signal: new AbortController().signal, agent: { session: { id: 'owner' } } };
    await assert.rejects(tools.get('commander_create').execute({ provider: 'codex', cwd: directory }, exec), /approval service/);
    ctx.commander.providers.set('test', { async connect() { return { nativeId: 'native', close: async () => {} }; } });
    const { id } = await ctx.commander.create({ provider: 'test', ownerSessionId: 'someone-else' });
    await assert.rejects(tools.get('commander_events').execute({ id }, exec), /different Harness session/);
    assert.deepEqual(await tools.get('commander_sessions').execute({}, exec), { sessions: [] });
    const catalog = await tools.get('commander_providers').execute({}, exec);
    assert.equal(catalog.providers.length, 9);
  } finally {
    await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true });
  }
});

test('official Harness ToolRuntime validates and executes Commander tool output; unload removes registrations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'commander-harness-tools-'));
  const ctx = new Context();
  ctx.provide('systemPrompt', { tools() {}, section() {} });
  try {
    await ctx.plugin(ToolRuntime);
    await ctx.plugin(NativeToolExecutor);
    const fiber = loadHarness(ctx, directory); await fiber;
    assert.equal(ctx.tools.schemas().filter(s => s.name.startsWith('commander_')).length, 14);
    const batch = await ctx.tools.execute({ calls: [{ type: 'tool-call', id: 'test-call', name: 'commander_providers', arguments: '{}' }], signal: new AbortController().signal });
    assert.equal(batch.results.length, 1);
    const result = batch.results[0].result;
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.match(result.content[0].text, /codex/);
    await fiber.dispose();
    assert.equal(ctx.tools.schemas().filter(s => s.name.startsWith('commander_')).length, 0);
  } finally { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('native permissions and questions go to human services associated with the owning Harness agent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'commander-human-'));
  const ctx = new Context(); const tools = new Map(); const grants = []; const questions = [];
  ctx.provide('tools', { register(definition) { tools.set(definition.name, definition); } });
  ctx.provide('approval', { async request(request) { grants.push(request); return 'allowed-once'; } });
  ctx.provide('userQuestions', { async ask(request) { questions.push(request); return { answers: [{ id: 'q1', selected: ['B'] }] }; } });
  try {
    await loadHarness(ctx, directory);
    ctx.commander.providers.set('codex', { async connect() { return { nativeId: 'native', close: async () => {} }; } });
    const agent = { session: { id: 'owner' } };
    const exec = { agent, callId: 'human-test', signal: new AbortController().signal };
    const session = await tools.get('commander_create').execute({ provider: 'codex', cwd: directory }, exec);
    assert.deepEqual(await ctx.commander.ask(session.id, { kind: 'permission', method: 'bash', details: { command: 'echo safe' } }), { allow: true });
    const reply = await ctx.commander.ask(session.id, { kind: 'question', details: { questions: [{ id: 'q1', question: 'Pick', options: [{ label: 'B' }] }] } });
    assert.deepEqual(reply, { allow: false, answers: { q1: { answers: ['B'] } } });
    assert.equal(grants.length, 2); assert.equal(questions.length, 1);
    assert.equal(grants[1].agent, agent); assert.equal(questions[0].agent, agent);
  } finally { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('full Commander composition registers native engines in the official model catalog', async () => {
  const { default: LlmRuntime } = await import('@deepseek-ai/dsh-llm');
  const directory = await mkdtemp(join(tmpdir(), 'commander-catalog-'));
  const ctx = new Context();
  ctx.provide('tools', { register() { return () => {}; } });
  ctx.provide('agents', {});
  ctx.provide('workspaceRegistry', { list: () => [] });
  try {
    await ctx.plugin(LlmRuntime);
    const fiber = loadHarness(ctx, directory); await fiber;
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(ctx.llm.listProviders().map(p => p.id).sort(), ['commander-claude', 'commander-codex', 'commander-gemini', 'commander-grok', 'commander-hermes', 'commander-mcode', 'commander-opencode', 'commander-pi']);
    assert.equal((await ctx.llm.listModels('commander-codex'))[0].id, 'native-default');
    await fiber.dispose();
    assert.deepEqual(ctx.llm.listProviders(), []);
  } finally { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }); }
});
