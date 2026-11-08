import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssignmentExecutor } from '../src/assignment-executor.mjs';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { modelFallbackSource, modelFallbackType } from '../src/model-fallback.mjs';

const requireHarness = createRequire(new URL('../../../deepseek-harness/packages/core/agent-loop/package.json', import.meta.url));
const load = name => import(pathToFileURL(requireHarness.resolve(name)).href);
const { Context } = await load('@deepseek-ai/cordis');
const { default: LlmRuntime, LlmAdapter } = await load('@deepseek-ai/dsh-llm');
const modules = await Promise.all(['@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-projection', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-agent-loop'].map(load));
const loadPackage = (directory, name) => import(pathToFileURL(createRequire(new URL(`../../../deepseek-harness/packages/${directory}/package.json`, import.meta.url)).resolve(name)).href);
const NativeToolExecutor = await loadPackage('core/tool-executor-native', '@deepseek-ai/dsh-tool-executor-native');
const text = value => [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text: value }, { type: 'block-end', index: 0, block: { type: 'text', text: value } }, { type: 'finish', reason: { kind: 'stop' } }];
const failure = (code = 'SERVER', status = 503) => [{ type: 'finish', reason: { kind: 'error', failure: { code, status, message: 'Synthetic provider failure' } } }];
const tool = (id, name) => [{ type: 'block-start', index: 0, blockType: 'tool-call' }, { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: '{}' } }, { type: 'finish', reason: { kind: 'tool-calls' } }];
const primary = { providerId: 'test', modelId: 'Exact Worker/high', options: { reasoningEffort: 'high', maxTokens: 700 } };
const backup = { providerId: 'test', modelId: 'Exact Worker/default' };

async function fixture(t, script, { install, models = [primary, backup], persistent = false, task = {}, assignmentInput = {} } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-worker-fallback-'));
  const database = createAssistantOrchestrationStore({ directory });
  const ctx = new Context();
  t.after(async () => { await ctx.fiber.dispose(); database.close(); await rm(directory, { recursive: true, force: true }); });
  await ctx.plugin(LlmRuntime);
  for (let i = 0; i < modules.length; i++) await ctx.plugin(modules[i].default, i === modules.length - 1 ? { agents: [] } : undefined);
  await ctx.plugin(NativeToolExecutor);
  if (persistent) await ctx.plugin(await loadPackage('session/session-persistence-jsonl', '@deepseek-ai/dsh-session-persistence-jsonl'), { root: join(directory, 'sessions'), compression: 'none' });
  const requests = [], selections = [], logs = new Map();
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 131072 }, reasoning: { efforts: [{ id: 'high', name: 'High' }] } }; }
    async *stream(request) { requests.push(request); yield* await script(request, requests.length); }
  }
  ctx.llm.registerAdapter(['test'], new Adapter());
  ctx.provide('sessionQuery', { readSession: async id => {
    const agent = ctx.agents.get(id);
    if (agent) { const log = { events: agent.session.snapshotEvents() }; logs.set(id, log); return log; }
    if (!persistent) return logs.get(id);
    const handle = await ctx.sessionPersistence.open(id, 'read');
    try { return await handle.read(); } finally { await handle.close(); }
  } });
  ctx.on('agent/created', ({ agent }) => agent.ctx.on('agent/pre-step', ({ modelSelection }, next) => {
    selections.push({ ...modelSelection }); Object.freeze(modelSelection); return next();
  }));
  await install?.(ctx);
  database.createThread({ id: 'thread', source: { type: 'desktop', id: 'owner' } });
  const ticket = database.createTicket({ threadId: 'thread', target: 'Use existing evidence to finish the original task', acceptance: 'A supported result', mandate: { source: { channel: 'desktop', sessionId: 'owner' } }, ...task });
  database.createAssignment(ticket.id, assignmentInput);
  const [assignment] = database.claimAssignments('worker', { validateMandate: () => true });
  let configured = models;
  const executor = createAssignmentExecutor({ ctx, database, workspaceRoot: join(directory, 'workers'), appendRecord: modules[0].appendPluginRecord,
    readPolicy: async () => ({ workerModels: configured }), authorizeAction: async () => ({ allowed: true }) });
  const context = { ticket, signal: AbortSignal.timeout(15000), renew: async () => {} };
  return { ctx, database, ticket, assignment, executor, context, requests, selections, logs, setModels: value => { configured = value; } };
}

test('Worker receives the literal current owner instruction instead of a shortened Router task', async t => {
  const instruction = 'Read the report, formally verify both existing totals, then ask me for the final layout. The totals are already known; the verification procedure is required.';
  const target = 'Read the report and only ask for the layout; skip the known totals.';
  const f = await fixture(t, () => text('Supported result'), { task: { target, acceptance: 'Deliver the report',
    mandate: { instruction, source: { channel: 'desktop', sessionId: 'owner' } } } });
  const result = await f.executor(f.assignment, f.context);
  const users = f.logs.get(result.sessionId).events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user');
  assert.equal(users.length, 1);
  assert.equal(users[0].data.content[0].text, instruction);
  assert.ok(f.requests[0].messages.some(message => message.role === 'user' && message.content.some(block => block.type === 'text' && block.text === instruction)));
  const system = f.requests[0].messages.filter(message => message.role === 'system').map(message => message.content.map(block => block.text || '').join('\n')).join('\n');
  assert.match(system, /explicit requirements take precedence over derived task summaries/);
  assert.match(system, /must actually run and produce evidence/);
});

test('Worker keeps an explicit assignment scope when the owner instruction includes sibling work', async t => {
  const instruction = 'Complete the report and deployment goal. For the report, verify both totals. Another Worker handles deployment.';
  const scope = 'Report leaf only: read the report and verify both totals.';
  const f = await fixture(t, () => text('Report complete'), { task: { target: 'Complete the report and deployment goal',
    mandate: { instruction, source: { channel: 'desktop', sessionId: 'owner', messageId: 'owner#goal:report' } } }, assignmentInput: { text: scope } });
  const result = await f.executor(f.assignment, f.context);
  const user = f.logs.get(result.sessionId).events.find(event => event.type === 'user/message' && event.data.source.kind === 'user');
  assert.equal(user.data.content[0].text, instruction);
  const system = f.requests[0].messages.filter(message => message.role === 'system').map(message => message.content.map(block => block.text || '').join('\n')).join('\n');
  assert.ok(system.includes(JSON.stringify({ executionScope: scope }).slice(1, -1)));
  assert.match(system, /does not authorize sibling assignments or other Goal leaves/);
});

test('Worker fallback clears effort, rebuilds model tools and prompt, and never replays a completed action', async t => {
  let effects = 0;
  const f = await fixture(t, (_request, count) => count === 1 ? tool('original', 'effect_once') : count === 2 ? failure() : count === 3 ? tool('repeat', 'effect_once') : text('Complete from saved evidence'), {
    install(ctx) {
      ctx.tools.register({ name: 'effect_once', description: 'One effect', parameters: { type: 'object', properties: {} }, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => { effects++; return 'saved effect'; } });
      ctx.tools.register({ name: 'backup_only', description: 'Backup capability', parameters: { type: 'object', properties: {} }, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => 'backup' }, { when: ({ modelSelection }) => modelSelection.model === backup.modelId });
      ctx.systemPrompt.section({ name: 'route-fixture', order: 100, text: ({ modelSelection }) => `Current capability route: ${modelSelection.model}` });
    },
  });
  const result = await f.executor(f.assignment, f.context);
  assert.equal(result.finalSummary, 'Complete from saved evidence');
  assert.deepEqual(f.requests.map(request => request.model), [primary.modelId, primary.modelId, backup.modelId, backup.modelId]);
  assert.equal(f.requests[0].reasoningEffort, 'high');
  assert.equal(f.requests[2].reasoningEffort, undefined);
  assert.equal(f.requests[2].maxTokens, undefined);
  assert.equal(effects, 1);
  assert.equal(result.executionEffects.effectsVerified, true);
  assert.ok(!f.requests[0].tools.some(tool => tool.name === 'backup_only'));
  assert.ok(f.requests[2].tools.some(tool => tool.name === 'backup_only'));
  assert.match(JSON.stringify(f.requests[2].messages), /Current capability route: Exact Worker\/default/);
  const events = f.logs.get(result.sessionId).events;
  assert.equal(events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user').length, 1);
  assert.equal(events.filter(event => event.type === 'user/message' && event.data.source.kind === modelFallbackSource).length, 1);
  assert.equal(events.filter(event => event.type === modelFallbackType).length, 1);
  assert.ok(events.some(event => event.type === 'tool/result' && JSON.stringify(event.data).includes('prior model already dispatched')));
  assert.ok(f.selections.some(selection => selection.model === backup.modelId && selection.reasoningEffort === undefined));
});

test('Worker preparation failure re-admits the original unlogged identity once at the next model boundary', async t => {
  const f = await fixture(t, () => text('Prepared backup completed'));
  const prepare = f.ctx.llm.prepareCall.bind(f.ctx.llm);
  f.ctx.llm.prepareCall = async (request, signal) => {
    if (request.model === primary.modelId) throw Object.assign(new Error('Synthetic adapter unavailable'), { code: 'NO_ADAPTER' });
    return prepare(request, signal);
  };
  const result = await f.executor(f.assignment, f.context);
  assert.deepEqual(f.requests.map(request => request.model), [backup.modelId]);
  const events = f.logs.get(result.sessionId).events;
  const users = events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user');
  assert.equal(users.length, 1);
  assert.equal(users[0].data.content[0].text, f.ticket.target);
  const plan = events.find(event => event.type === modelFallbackType).data;
  assert.equal(plan.unadmitted[0].id, users[0].data.id);
  assert.equal(plan.requestId, users[0].data.id);
});

test('resumed Worker keeps the saved backup and frozen role queue after configuration changes', async t => {
  const f = await fixture(t, (_request, count) => count === 1 ? failure() : text(count === 2 ? 'Original draft' : 'Corrected draft'), { persistent: true });
  const first = await f.executor(f.assignment, f.context);
  f.database.commitResult(f.ticket.id, { assignment: f.assignment, result: { ...first, review: { verdict: 'failed', reason: 'Needs correction' } }, status: 'waiting', uniqueKey: 'draft', rework: { instruction: 'Correct the existing draft' } });
  const [resumed] = f.database.claimAssignments('worker-resumed', { validateMandate: () => true });
  f.setModels([{ providerId: 'test', modelId: 'Unrelated new primary' }]);
  const result = await f.executor(resumed, { ...f.context, ticket: f.database.getTicket(f.ticket.id) });
  assert.equal(result.sessionId, first.sessionId);
  assert.equal(result.runId, first.runId);
  assert.deepEqual(f.requests.map(request => request.model), [primary.modelId, backup.modelId, backup.modelId]);
  assert.equal(f.requests.at(-1).reasoningEffort, undefined);
  assert.equal(result.finalSummary, 'Corrected draft');
});

test('Worker never falls back while a dispatched action has an unknown external outcome', async t => {
  let effects = 0;
  const f = await fixture(t, (_request, count) => count === 1 ? tool('unknown-action', 'unknown_effect') : failure(), {
    install(ctx) {
      ctx.tools.register({ name: 'unknown_effect', description: 'Uncertain effect', parameters: { type: 'object', properties: {} }, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => {
        effects++; throw new Error('Connection lost after dispatch');
      } });
    },
  });
  await assert.rejects(f.executor(f.assignment, f.context));
  assert.equal(effects, 1);
  assert.deepEqual(f.requests.map(request => request.model), [primary.modelId, primary.modelId]);
  assert.equal(f.database.runs(f.assignment.id)[0].state, 'uncertain');
});

for (const denied of [false, true]) test(`Worker ${denied ? 'permission denial' : 'explicit cancellation'} never starts its fallback`, async t => {
  const controller = new AbortController();
  const f = await fixture(t, () => { if (!denied) controller.abort(new Error('Owner stopped')); return failure(denied ? 'PERMISSION_DENIED' : 'SERVER', denied ? 403 : 503); });
  await assert.rejects(f.executor(f.assignment, { ...f.context, signal: controller.signal }));
  assert.deepEqual(f.requests.map(request => request.model), [primary.modelId]);
  assert.equal(f.database.runs(f.assignment.id).length, 1);
});
