import test from 'node:test';
import assert from 'node:assert/strict';
import { workerModelRoute, workerRequest, installWorkerChildModelRoute } from '../src/worker-model-route.mjs';
import { installWorkerSelfCheck, validateWorkerSelfCheck } from '../src/worker-self-check.mjs';
import { attachExecutionSession, archiveClosedExecutionSessions, executionSessionProjection, findExecutionSessionOwner } from '../src/execution-session.mjs';
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

function selfCheckStopFixture(options = {}) {
  const hooks = new Map(), steered = [], assignment = { id: 'a', ticketId: 't', owner: 'o', fence: 2, state: 'claimed', leaseUntil: Date.now() + 60000 };
  const run = { id: 'r', sessionId: 's', owner: 'o', fence: 2, state: 'running' }, ticket = { id: 't', status: 'open', instructionRevision: 3 };
  const state = { selfCheck: null }, snapshot = { instructionRevision: 3 }, controller = new AbortController();
  const agent = { id: 's', steer: message => steered.push(message) };
  let waiting = false, renewed = 0;
  const database = { getAssignment: () => assignment, getTicket: () => ticket, runs: () => [run],
    appliedTicketSnapshot: () => snapshot, getWorkerExecutionState: () => state };
  installWorkerSelfCheck({ on: (name, fn) => hooks.set(name, fn) }, agent, { database, assignment: { ...assignment }, run: { ...run },
    isWaiting: () => waiting, renew: async () => { renewed++; await options.onRenew?.({ assignment, ticket, run, state, controller, snapshot, wait: () => { waiting = true; } }); } });
  return { assignment, ticket, run, state, snapshot, controller, agent, steered, wait: () => { waiting = true; }, renewed: () => renewed,
    stop: subject => hooks.get('agent/turn-stopping')({ agent: subject || agent, signal: controller.signal }) };
}

test('self-check stop boundary steers the same Worker once and leaves missing evidence to the hard check', async () => {
  const f = selfCheckStopFixture();
  await f.stop({}); assert.equal(f.renewed(), 0);
  await f.stop(); await f.stop();
  assert.equal(f.renewed(), 1); assert.equal(f.steered.length, 1);
  assert.deepEqual(f.steered[0].source, { kind: 'benchgo-worker-self-check', ticketId: 't', runId: 'r' });
  assert.match(f.steered[0].content[0].text, /do not restart or repeat completed actions/);
});

test('self-check stop boundary accepts valid current evidence and supplements stale revision', async () => {
  const f = selfCheckStopFixture();
  f.state.selfCheck = { selfCheck: { summary: 'checked' }, instructionRevision: 3 };
  await f.stop(); assert.equal(f.steered.length, 0);
  f.state.selfCheck.instructionRevision = 2;
  await f.stop(); assert.equal(f.steered.length, 1);
});

test('self-check stop boundary does not wake waiting, paused, cancelled, aborted or stale execution', async () => {
  for (const mutate of [f => f.wait(), f => { f.ticket.status = 'pausing'; }, f => { f.ticket.status = 'paused'; },
    f => { f.ticket.status = 'cancelled'; }, f => f.controller.abort(), f => { f.assignment.fence++; },
    f => { f.assignment.leaseUntil = 0; }, f => { f.run.sessionId = 'other'; }, f => { f.snapshot.instructionRevision = 2; }]) {
    const f = selfCheckStopFixture(); mutate(f); await f.stop();
    assert.equal(f.steered.length, 0); assert.equal(f.renewed(), 0);
  }
});

test('self-check stop boundary revalidates ownership, signal, revision and evidence after renewal', async () => {
  for (const onRenew of [f => { f.assignment.fence++; }, f => f.controller.abort(), f => f.wait(), f => { f.ticket.status = 'pausing'; },
    f => { f.assignment.leaseUntil = 0; }, f => { f.snapshot.instructionRevision = 2; },
    f => { f.state.selfCheck = { selfCheck: { summary: 'checked during renewal' }, instructionRevision: 3 }; }]) {
    const f = selfCheckStopFixture({ onRenew }); await f.stop();
    assert.equal(f.renewed(), 1); assert.equal(f.steered.length, 0);
  }
});

for (const truncated of [false, true]) test(`official AgentLoop ${truncated ? 'preserves max-tokens without completion steering' : 'continues the original turn to record self-check through the real tool executor'}`, { timeout: 15000 }, async t => {
  const requireHarness = createRequire(new URL('../../../deepseek-harness/packages/core/agent-loop/package.json', import.meta.url));
  const load = name => import(pathToFileURL(requireHarness.resolve(name)).href);
  const { Context } = await load('@deepseek-ai/cordis');
  const { default: LlmRuntime, LlmAdapter, createUserMessage } = await load('@deepseek-ai/dsh-llm');
  const ctx = new Context(); t.after(() => ctx.fiber.dispose());
  await ctx.plugin(LlmRuntime);
  for (const name of ['@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-projection', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-agent-loop']) {
    await ctx.plugin((await load(name)).default, name === '@deepseek-ai/dsh-agent-loop' ? { agents: [] } : undefined);
  }
  const requireNative = createRequire(new URL('../../../deepseek-harness/packages/core/tool-executor-native/package.json', import.meta.url));
  await ctx.plugin(await import(pathToFileURL(requireNative.resolve('@deepseek-ai/dsh-tool-executor-native')).href));
  const requests = [], state = { selfCheck: null };
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 131072 } }; }
    async *stream(request) {
      requests.push(request);
      if (requests.length === 2) {
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'actual-self-check', name: 'assistant_task_result', arguments: JSON.stringify({ selfCheck: { summary: 'Verified original task evidence' } }) } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
      }
      assert.ok(requests.length <= 3, 'no unbounded completion loop');
      const text = requests.length === 1 ? 'Now preparing the final report' : 'Complete final report';
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'finish', reason: { kind: truncated ? 'max-tokens' : 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['self-check-test'], new Adapter());
  const assignment = { id: 'a', ticketId: 't', owner: 'o', fence: 1, state: 'claimed', leaseUntil: Date.now() + 60000 };
  const run = { id: 'r', sessionId: 'self-check-same-session', owner: 'o', fence: 1, state: 'running' };
  const ticket = { id: 't', status: 'open', instructionRevision: 1 };
  const database = { getAssignment: () => assignment, getTicket: () => ticket, runs: () => [run],
    appliedTicketSnapshot: () => ({ instructionRevision: 1 }), getWorkerExecutionState: () => state,
    recordWorkerSelfCheck: ({ value }) => { state.selfCheck = value; } };
  let created = 0, record;
  ctx.on('agent/created', () => { created++; });
  const handle = await ctx.agents.create({ sessionId: run.sessionId, setup: async (scope, agent) => {
    record = installWorkerSelfCheck(scope, agent, { database, assignment, run });
  } });
  t.after(() => handle.dispose());
  handle.agent.model.select({ provider: 'self-check-test', model: 'opaque-model' });
  handle.agent.followup(createUserMessage({ source: { kind: 'benchgo-worker-instruction' }, content: [{ type: 'text', text: 'Finish the assigned task' }] }));
  await handle.agent.whenIdle();
  const events = handle.agent.session.snapshotEvents();
  assert.equal(created, 1); assert.equal(handle.agent.id, run.sessionId);
  if (truncated) {
    assert.equal(requests.length, 1);
    assert.equal(events.filter(event => event.type === 'turn/start').length, 1);
    assert.equal(events.filter(event => event.type === 'step/start').length, 1);
    assert.equal(events.findLast(event => event.type === 'turn/end').data.reason.kind, 'max-tokens');
    assert.equal(events.filter(event => event.type === 'user/message' && event.data.source.kind === 'benchgo-worker-self-check').length, 0);
    assert.throws(() => record.read(), /without recording/);
    return;
  }
  assert.equal(requests.length, 3);
  assert.equal(events.filter(event => event.type === 'turn/start').length, 1);
  assert.equal(events.filter(event => event.type === 'turn/end').length, 1);
  assert.equal(events.filter(event => event.type === 'step/start').length, 3);
  assert.equal(events.filter(event => event.type === 'user/message' && event.data.source.kind === 'benchgo-worker-self-check').length, 1);
  assert.equal(record.read().selfCheck.summary, 'Verified original task evidence');
  assert.equal(events.findLast(event => event.type === 'assistant/message').data.message.content.find(block => block.type === 'text').text, 'Complete final report');
  assert.equal(events.findLast(event => event.type === 'turn/end').data.reason.kind, 'completed');
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
