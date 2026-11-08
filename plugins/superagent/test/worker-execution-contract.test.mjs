import test from 'node:test';
import assert from 'node:assert/strict';
import { workerModelRoute, workerRequest, installWorkerChildModelRoute } from '../src/worker-model-route.mjs';
import { installWorkerSelfCheck, validateWorkerSelfCheck } from '../src/worker-self-check.mjs';
import { attachExecutionSession, archiveClosedExecutionSessions, executionSessionProjection, findExecutionSessionOwner } from '../src/execution-session.mjs';
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
  const resumed = workerModelRoute({ policy: { workerModels: [] }, savedQueue: { ...frozen, index: 1 },
    current: { provider: backup.providerId, model: backup.modelId }, resumed: true });
  assert.equal(resumed.index, 1);
  assert.deepEqual(workerRequest({ provider: 'project', model: 'default', reasoningEffort: 'ultra', maxTokens: 900, tools: [] }, resumed.models[1]),
    { provider: backup.providerId, model: backup.modelId, maxTokens: 200, tools: [] });
  assert.throws(() => workerModelRoute({ policy: { models: [primary] } }), /not configured/);
  assert.throws(() => workerModelRoute({ policy, savedQueue: { models: frozen.models, index: 99 }, current: { provider: 'other', model: 'foreign' }, resumed: true }), /outside/);
});

test('legacy resume freezes only the saved request instead of combining new backups', () => {
  const route = workerModelRoute({ policy: { workerModels: [primary, backup] }, resumed: true,
    current: { provider: 'historic', model: 'opaque historical', reasoningEffort: 'high' }, requestConfig: { maxTokens: 333 } });
  assert.deepEqual(route.models, [{ providerId: 'historic', modelId: 'opaque historical', options: { reasoningEffort: 'high', maxTokens: 333 } }]);
});

test('Worker metadata migrates once, preserves fallback after reopen and rejects a stale writer', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-worker-state-'));
  let database = createAssistantOrchestrationStore({ directory });
  t.after(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
  database.createThread({ id: 'thread', source: { type: 'desktop', id: 'owner' } });
  const ticket = database.createTicket({ threadId: 'thread', target: 'work', mandate: {} });
  database.createAssignment(ticket.id, {});
  const [assignment] = database.claimAssignments('owner', { validateMandate: () => true });
  const run = database.prepareRun(assignment.id, { owner: assignment.owner, fence: assignment.fence, sessionId: 'worker-session', directory });
  const identity = { assignmentId: assignment.id, runId: run.id, owner: assignment.owner, fence: assignment.fence };
  database.freezeWorkerModelRoute({ ...identity, models: [primary, backup], index: 0, routeOrigin: 'legacy-queue' });
  database.selectWorkerModelRoute({ ...identity, index: 1 });
  database.freezeWorkerModelRoute({ ...identity, models: [{ providerId: 'new', modelId: 'foreign' }], index: 0 });
  assert.throws(() => database.selectWorkerModelRoute({ ...identity, owner: 'other', index: 0 }), /owner changed/);
  database.close(); database = createAssistantOrchestrationStore({ directory });
  const state = database.getWorkerExecutionState(run.id);
  assert.deepEqual(state.models, [primary, backup]);
  assert.equal(state.index, 1); assert.equal(state.routeOrigin, 'legacy-queue');
});

test('child inherits the actual parent work selection and cannot leave it through request overrides', async () => {
  const hooks = new Map(), selected = [];
  installWorkerChildModelRoute({ on: (name, fn) => hooks.set(name, fn) }, { model: { select: value => selected.push(value) } },
    { worker: { session: {} }, models: [primary, backup], currentModel: () => backup });
  assert.equal(selected[0].model, backup.modelId);
  const request = await hooks.get('agent/request')({}, async () => ({ provider: backup.providerId, model: backup.modelId, maxTokens: 999, reasoningEffort: 'ultra' }));
  assert.equal(request.maxTokens, 200); assert.equal(request.reasoningEffort, undefined);
  await assert.rejects(hooks.get('agent/request')({}, async () => ({ provider: 'foreign', model: 'auxiliary' })), /override/);
});

test('self-check records only the owning live Worker and validates structural failure details', async () => {
  const entries = [], tools = new Map(), agent = { id: 'session', session: {} }, assignment = { id: 'a', ticketId: 't', owner: 'o', fence: 2 };
  const run = { id: 'r', sessionId: 'session', owner: 'o', fence: 2, state: 'submitted' };
  const database = { getAssignment: () => ({ ...assignment, state: 'claimed' }), getTicket: () => ({ id: 't', status: 'open', instructionRevision: 3 }),
    runs: () => [run], appliedTicketSnapshot: () => ({ instructionRevision: 3 }), recordWorkerSelfCheck: ({value}) => entries.push(value), getWorkerExecutionState: () => ({selfCheck: entries.at(-1)}) };
  const record = installWorkerSelfCheck({ tools: { register: tool => tools.set(tool.name, tool) } }, agent, { database, assignment, run,
    appendRecord: (_session, type, data) => entries.push({ type, data }) });
  assert.throws(() => record.read({ events: [] }), /without recording/);
  const tool = tools.get('assistant_task_result'), execution = { agent, signal: new AbortController().signal, callId: 'c' };
  await assert.rejects(tool.execute({ selfCheck: { summary: 'done' } }, { ...execution, agent: {} }), /stale/);
  await assert.rejects(tool.execute({ selfCheck: { summary: 'blocked' }, outcome: 'failed', failure: { attempted: 'read' } }, execution), /requires/);
  await tool.execute({ selfCheck: { summary: 'Tests and output checked', checks: ['test command passed'] } }, execution);
  assert.deepEqual(record.read({ events: entries }), { selfCheck: { summary: 'Tests and output checked', checks: ['test command passed'] }, outcome: 'completed', selfCheckRevision: 3 });
  assert.equal(validateWorkerSelfCheck({ selfCheck: { summary: 'Unsupported file' }, outcome: 'failed', failure: { attempted: 'Read file', cause: 'Format unsupported', resumeConditions: 'Provide supported format' } }).outcome, 'failed');
});

test('project membership attaches the same official session; no-project remains in the official ungrouped bucket', async () => {
  const calls = [], events = [], workspace = { id: 'workspace', attachSession: async id => calls.push(id) };
  const ctx = { workspaceRegistry: { resolveByPath: async path => { assert.equal(path, '/project'); return workspace; }, create: () => assert.fail('existing workspace must be reused') } };
  const input = { ticket: { id: 't', mandate: { project: { path: '/project' } } }, assignment: { id: 'a' }, run: { id: 'r', sessionId: 'same-session' }, appendRecord: (_session, type, data) => events.push({ type, data }) };
  await attachExecutionSession(ctx, { session: {} }, input);
  await attachExecutionSession(ctx, { session: {} }, input);
  assert.deepEqual(calls, ['same-session', 'same-session']);
  await attachExecutionSession({}, { session: {} }, { ...input, ticket: { id: 't', mandate: {} } });
  assert.equal(events.length, 0, 'membership never extends the official Session log');
});

test('session lookup and projection use persisted ownership; only closed Tickets archive through official registry', async () => {
  const ticket = { id: 't', title: 'Task', status: 'open', mandate: {} }, assignment = { id: 'a', fence: 2 }, run = { id: 'r', sessionId: 'same', fence: 2 };
  const database = { listTickets: () => [ticket], getTicket: () => ticket, assignments: () => [assignment], runs: () => [run] };
  assert.equal(findExecutionSessionOwner(database, 'same').run, run);
  assert.equal(findExecutionSessionOwner(database, 'missing'), null);
  assert.deepEqual(executionSessionProjection(database, 't'), { available: true, ticketId: 't', title: 'Task', sessionId: 'same', assignmentId: 'a', runId: 'r', status: 'open', placement: 'ungrouped', closed: false });
  const archived = [], ctx = { workspaceRegistry: { archiveSession: async id => archived.push(id) } };
  assert.equal(await archiveClosedExecutionSessions(ctx, database, 't'), false);
  ticket.status = 'completed';
  assert.equal(await archiveClosedExecutionSessions(ctx, database, 't'), true);
  assert.deepEqual(archived, ['same']);
});
