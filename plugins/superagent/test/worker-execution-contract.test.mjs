import test from 'node:test';
import assert from 'node:assert/strict';
import { workerModelRoute, workerRequest } from '../src/worker-model-route.mjs';
import { attachExecutionSession, executionSessionProjection, findExecutionSessionOwner } from '../src/execution-session.mjs';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  assert.deepEqual(workerModelRoute({ policy: { models: [primary, backup], workerModels: [] } }).models, [primary, backup]);
  assert.throws(() => workerModelRoute({ policy: {} }), /not configured/);
  assert.throws(() => workerModelRoute({ policy, resumed: true }), /route is missing/, 'a continued Run never adopts current settings');
  assert.throws(() => workerModelRoute({ policy, savedQueue: { models: frozen.models, index: 99 }, resumed: true }), /outside/);
});

test('Worker Harness selection stays frozen and external routes never inherit Router models', () => {
  const external = { providerId: 'router/api', modelId: 'vendor/model' };
  const policy = { workerHarness: 'codex', models: [{ providerId: 'router/api', modelId: 'router/model' }], workerModels: [external], routingConfig: { workerModels: [external], workerHarness: 'codex' } };
  const frozen = workerModelRoute({ policy });
  assert.equal(frozen.harness, 'codex');
  assert.deepEqual(frozen.models, [{ ...external, harness: 'codex' }]);
  assert.throws(() => workerModelRoute({ policy: { ...policy, workerModels: [], routingConfig: { workerModels: [], workerHarness: 'claude' }, workerHarness: 'claude' } }), /外部 Worker/);
  const resumed = workerModelRoute({ policy: { workerHarness: 'official', workerModels: [] }, savedQueue: frozen, resumed: true });
  assert.equal(resumed.harness, 'codex');
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
