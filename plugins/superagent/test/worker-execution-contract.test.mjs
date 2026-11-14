import test from 'node:test';
import assert from 'node:assert/strict';
import { workerModelRoute, workerRequest } from '../src/worker-model-route.mjs';
import { installWorkerFailureConvergence } from '../src/worker-permissions.mjs';
import { attachExecutionSession, executionSessionProjection, findExecutionSessionOwner } from '../src/execution-session.mjs';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const primary = { providerId: 'Opaque/@', modelId: 'Work:1', options: { reasoningEffort: 'high', maxTokens: 700, temperature: 0.3 } };
const backup = { providerId: 'Other/@', modelId: 'Work:2', options: { maxTokens: 200 } };

test('new Worker uses only its work role; resume preserves the frozen queue and actual backup parameters', () => {
  const policy = { models: [{ providerId: 'router', modelId: 'router' }], workerModels: [primary, backup] };
  const frozen = workerModelRoute({ policy });
  policy.workerModels[0].options.maxTokens = 1;
  assert.equal(frozen.models[0].options.maxTokens, 700);
  const resumed = workerModelRoute({ policy: { workerModels: [] }, savedQueue: { ...frozen, index: 1 }, resumed: true });
  assert.equal(resumed.index, 1);
  assert.deepEqual(workerRequest({ provider: 'project', model: 'default', reasoningEffort: 'ultra', maxTokens: 900, tools: [] }, resumed.models[1]),
    { provider: backup.providerId, model: backup.modelId, maxTokens: 200, tools: [] });
  assert.throws(() => workerModelRoute({ policy: { models: [primary] } }), /not configured/);
  assert.throws(() => workerModelRoute({ policy, resumed: true }), /route is missing/, 'a continued Run never adopts current settings');
  assert.throws(() => workerModelRoute({ policy, savedQueue: { models: frozen.models, index: 99 }, resumed: true }), /outside/);
});

test('Worker route freezes once, preserves its selection after reopen and rejects a stale writer', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-worker-state-'));
  let database = createAssistantOrchestrationStore({ directory });
  t.after(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
  database.createThread({ id: 'thread', source: { type: 'desktop', id: 'owner' } });
  const task = database.createTask({ threadId: 'thread', target: 'work', mandate: {} });
  database.createAssignment(task.id, {});
  const [assignment] = database.claimAssignments('owner', { validateMandate: () => true });
  const run = database.prepareRun(assignment.id, { owner: assignment.owner, fence: assignment.fence, sessionId: 'worker-session', directory });
  const identity = { assignmentId: assignment.id, runId: run.id, owner: assignment.owner, fence: assignment.fence };
  database.freezeWorkerModelRoute({ ...identity, models: [primary, backup], index: 0 });
  database.selectWorkerModelRoute({ ...identity, index: 1 });
  database.freezeWorkerModelRoute({ ...identity, models: [{ providerId: 'new', modelId: 'foreign' }], index: 0 });
  assert.throws(() => database.selectWorkerModelRoute({ ...identity, owner: 'other', index: 0 }), /owner changed/);
  database.close(); database = createAssistantOrchestrationStore({ directory });
  const state = database.getWorkerExecutionState(run.id);
  assert.deepEqual(state.models, [primary, backup]);
  assert.equal(state.index, 1);
});

test('official loop stops repeated shared structural failures across tools without another model request', { timeout: 15000 }, async t => {
  const requireHarness = createRequire(new URL('../../../deepseek-harness/packages/core/agent-loop/package.json', import.meta.url));
  const load = name => import(pathToFileURL(requireHarness.resolve(name)).href);
  const { Context } = await load('@deepseek-ai/cordis');
  const { default: LlmRuntime, LlmAdapter, createUserMessage, HarnessError } = await load('@deepseek-ai/dsh-llm');
  const ctx = new Context(); t.after(() => ctx.fiber.dispose());
  await ctx.plugin(LlmRuntime);
  for (const name of ['@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-projection', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-agent-loop']) {
    await ctx.plugin((await load(name)).default, name === '@deepseek-ai/dsh-agent-loop' ? { agents: [] } : undefined);
  }
  const requireNative = createRequire(new URL('../../../deepseek-harness/packages/core/tool-executor-native/package.json', import.meta.url));
  await ctx.plugin(await import(pathToFileURL(requireNative.resolve('@deepseek-ai/dsh-tool-executor-native')).href));
  const requests = [];
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 131072 } }; }
    async *stream(request) {
      requests.push(request);
      assert.ok(requests.length <= 2, 'shared structural failure must stop at the next official boundary');
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `failure-${requests.length}`, name: requests.length === 1 ? 'first' : 'alternate', arguments: '{}' } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    }
  }
  ctx.llm.registerAdapter(['convergence-test'], new Adapter());
  const assignment = { id: 'a', taskId: 't', owner: 'o', fence: 1, state: 'claimed', leaseUntil: Date.now() + 60000 };
  const run = { id: 'r', sessionId: 'convergence-same-session', owner: 'o', fence: 1, state: 'running' };
  const task = { id: 't', status: 'running', instructionRevision: 1 };
  const database = { getTask: () => task };
  let created = 0, record;
  ctx.on('agent/created', () => { created++; });
  const handle = await ctx.agents.create({ sessionId: run.sessionId, setup: async (scope, agent) => {
    record = installWorkerFailureConvergence(scope, agent, { database, assignment });
    for (const name of ['first', 'alternate']) scope.tools.register({ name, description: 'test', parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object' }, render: () => [] },
      execute() { throw new HarnessError('Disk quota exhausted before dispatch', 'ENOSPC'); } });
  } });
  t.after(() => handle.dispose());
  handle.agent.model.select({ provider: 'convergence-test', model: 'opaque-model' });
  handle.agent.followup(createUserMessage({ source: { kind: 'benchgo-worker-instruction' }, content: [{ type: 'text', text: 'Finish the assigned task' }] }));
  await handle.agent.whenIdle();
  const events = handle.agent.session.snapshotEvents();
  assert.equal(created, 1); assert.equal(handle.agent.id, run.sessionId);
  assert.equal(requests.length, 2);
  assert.equal(events.filter(event => event.type === 'tool/result').length, 2);
  assert.equal(record.failure().code, 'ENOSPC');
  assert.equal(record.failure().callId, 'failure-1');
  assert.equal(events.findLast(event => event.type === 'turn/end').data.reason.kind, 'blocked');
});

test('project membership attaches the same official session; no-project remains in the official ungrouped bucket', async () => {
  const calls = [], events = [], workspace = { id: 'workspace', attachSession: async id => calls.push(id) };
  const ctx = { workspaceRegistry: { resolveByPath: async path => { assert.equal(path, '/project'); return workspace; }, create: () => assert.fail('existing workspace must be reused') } };
  const input = { task: { id: 't', mandate: { project: { path: '/project' } } }, assignment: { id: 'a' }, run: { id: 'r', sessionId: 'same-session' }, appendRecord: (_session, type, data) => events.push({ type, data }) };
  await attachExecutionSession(ctx, { session: {} }, input);
  await attachExecutionSession(ctx, { session: {} }, input);
  assert.deepEqual(calls, ['same-session', 'same-session']);
  await attachExecutionSession({}, { session: {} }, { ...input, task: { id: 't', mandate: {} } });
  assert.equal(events.length, 0, 'membership never extends the official Session log');
});

test('session lookup and projection keep completed execution accessible without archival', async () => {
  const task = { id: 't', title: 'Task', status: 'running', mandate: {} }, assignment = { id: 'a', fence: 2 }, run = { id: 'r', sessionId: 'same', fence: 2 };
  const database = { listTasks: () => [task], getTask: () => task, assignments: () => [assignment], runs: () => [run] };
  assert.equal(findExecutionSessionOwner(database, 'same').run, run);
  assert.equal(findExecutionSessionOwner(database, 'missing'), null);
  assert.deepEqual(executionSessionProjection(database, 't'), { available: true, taskId: 't', title: 'Task', sessionId: 'same', assignmentId: 'a', runId: 'r', status: 'running', placement: 'ungrouped' });
  task.status = 'completed';
  assert.equal(executionSessionProjection(database, 't').sessionId, 'same');
  assert.equal(executionSessionProjection(database, 't').status, 'completed');
});
