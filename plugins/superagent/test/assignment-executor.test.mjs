import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssignmentExecutor } from '../src/assignment-executor.mjs';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { installRoleHost, loadRolePackage } from './role-host-fixture.mjs';

const loadHost = name => loadRolePackage('core/agent-loop', name);
const { Context } = await loadHost('@deepseek-ai/cordis');
const { createScope } = await loadHost('@deepseek-ai/dsh-scope');
// Keep execution/transcript controls local while composing the real upstream role services.
async function installExecutionRoleHost(t, ctx) {
  const host = new Context();
  t.after(() => host.fiber.dispose());
  for (const name of ['session', 'session-projection', 'system-prompt', 'tools', 'agent'])
    await host.plugin((await loadHost(`@deepseek-ai/dsh-${name}`)).default);
  await installRoleHost(host);
  for (const name of ['agentPresets', 'permissionPresets', 'sandboxPolicy', 'approval']) ctx[name] = host[name];
  ctx.on ??= (...args) => host.on(...args);
  ctx.agents.turnBoundaryOf = session => host.agents.turnBoundaryOf(session);
  const create = ctx.agents.create;
  ctx.agents.create = input => create({ ...input, setup: async (fixture, agent) => {
    const scope = createScope(host, {});
    t.after(() => scope.dispose());
    const snapshotEvents = agent.session?.snapshotEvents;
    agent.id ??= input.sessionId;
    agent.session = host.sessions.create(agent.id, { meta: input.meta });
    if (snapshotEvents) agent.session.snapshotEvents = snapshotEvents;
    agent.model ??= { current: () => null, select() {} };
    fixture.tools.schemas = value => host.get('tools').schemas(value);
    agent.ctx = scope.ctx.extend({ ...fixture, get: name => fixture.get?.(name) ?? scope.ctx.get(name) });
    await input.setup(agent.ctx, agent);
  } });
}

for (const selection of ['worker', 'explicit']) test(`Worker ignores ${selection} assignment selection and uses its ordered work-role queue`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-worker-models-'));
  const database = createAssistantOrchestrationStore({ directory });
  t.after(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
  database.createThread({ id: 'thread', source: { type: 'desktop', id: 'main' } });
  const ticket = database.createTicket({ threadId: 'thread', target: 'inspect', mandate: {} });
  const router = { providerId: 'Router/@', modelId: 'Exact: Router/1', options: { maxTokens: 100 } };
  const worker = { providerId: 'Worker/@', modelId: 'Exact: Worker/2', options: { reasoningEffort: 'ultra', maxTokens: 700 } };
  const backup = { providerId: 'Backup/@', modelId: 'Exact: Worker/3', options: { maxTokens: 200 } };
  const explicit = { providerId: 'Explicit/@', modelId: 'Exact: Selected/4', options: { maxTokens: 900 } };
  const workers = selection === 'inherit' ? [] : [worker, backup];
  const expected = workers;
  database.createAssignment(ticket.id, selection === 'explicit' ? { model: explicit } : {});
  const [assignment] = database.claimAssignments('worker', { validateMandate: () => true });
  const tools = new Map();
  const hooks = new Map(), seen = [], selected = [], transcript = [], injected = [];
  const signal = new AbortController().signal;
  const ctx = {
    on() { return () => {}; },
    llm: { prepareCall: async request => {
      seen.push([request.provider, request.model, request.maxTokens]);
      if (seen.length < expected.length) throw Object.assign(new Error('Temporary failure'), { status: 503 });
    } },
    sessionQuery: { readSession: async () => ({ events: [...transcript, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'done' }] } } }] }) },
    agents: { create: async input => {
      let turn = 0;
      const agent = { id: input.sessionId, session: { snapshotEvents: () => structuredClone(transcript) }, model: { current: () => selected.at(-1), select: value => selected.push(value) }, inject: message => injected.push(message), followup(message) {
        transcript.push({ seq: transcript.length, type: 'turn/start', data: { turn: ++turn } });
        hooks.get('agent/status')({ status: 'running' });
        queueMicrotask(async () => {
          try {
            await hooks.get('agent/pre-step')({ turn, messages: [...injected.splice(0), message] }, async () => ({ kind: 'enter', messages: [] }));
            await hooks.get('agent/request')({ signal }, async () => ({ provider: 'host-default', model: 'host-default' }));
            await tools.get('assistant_task_result').execute({ selfCheck: { summary: 'Verified output' } }, { agent, signal, callId: 'self-check' });
          } catch (error) { hooks.get('agent/error')({ error }); }
          finally { transcript.push({ seq: transcript.length, type: 'turn/end', data: { turn, reason: { kind: 'completed' } } }); hooks.get('agent/status')({ status: 'idle' }); }
        });
      } };
      await input.setup({ tools: { register: tool => tools.set(tool.name, tool) }, effect: fn => fn(), get: () => undefined, systemPrompt: { section() {}, context() {} }, on: (name, handler) => hooks.set(name, handler) }, agent);
      return { agent, dispose: async () => {} };
    } },
  };
  await installExecutionRoleHost(t, ctx);
  const executor = createAssignmentExecutor({ ctx, database, workspaceRoot: join(directory, 'workers'), readPolicy: async () => ({ model: router, models: [router], workerModels: workers }), authorizeAction: async () => ({ allowed: true }), captureCheckpoint: async () => ({ version: 1, manifestHash: 'checkpoint' }) });
  await executor(assignment, { ticket, signal, renew: async () => {} });
  assert.deepEqual(seen, expected.map(model => [model.providerId, model.modelId, model.options.maxTokens]));
  assert.equal(selected[0].provider, expected[0].providerId);
  assert.equal(selected[0].model, expected[0].modelId);
  assert.equal(selected[0].reasoningEffort, expected[0].options.reasoningEffort);
});

for (const [projectMode, ending] of [[false, 'completed'], [true, 'completed'], [false, 'max-tokens'], [false, 'paused']]) test(`host execution is persisted, isolated and permission-gated (project=${projectMode}, ending=${ending})`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-executor-'));
  const database = createAssistantOrchestrationStore({ directory });
  t.after(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
  database.createThread({ id: 'thread', source: { type: 'desktop', id: 'main' } });
  const project = { id: 'opaque-project', path: join(directory, 'source') };
  const ticket = database.createTicket({ threadId: 'thread', target: 'inspect', mandate: { scope: ['read'], source: { channel: 'feishu', chatId: 'chat' }, ...(projectMode ? { project } : {}) } });
  database.createAssignment(ticket.id, { model: { providerId: 'provider', modelId: 'opaque/model' } });
  const [assignment] = database.claimAssignments('worker', { validateMandate: () => true });
  const events = new Map(); let disposed = false, meta, submitted = false, sourceReference;
  const transcript = [], tools = new Map();
  const environment = { path: join(directory, 'isolated'), branch: 'branch', baseCommit: 'commit', repositoryRoot: project.path };
  const worktrees = { create: async (agent, request) => {
    assert.equal(submitted, false);
    assert.equal(meta.cwd, project.path);
    assert.equal(database.runs(assignment.id)[0].state, 'prepared');
    assert.equal(request.from, 'HEAD');
    return environment;
  } };
  const ctx = {
    workspaceRegistry: { resolveByPath: async () => ({ attachSession: async id => assert.equal(id, database.runs(assignment.id)[0].sessionId) }) },
    on() { return () => {}; },
    llm: { prepareCall: async request => assert.equal(request.model, 'opaque/model') },
    sessionQuery: { readSession: async () => ({ events: [...transcript, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Evidence found' }] } } }, { type: 'turn/end', data: { turn: 1, reason: { kind: ending === 'paused' ? 'blocked' : ending } } }] }) },
    agents: { create: async input => {
      meta = input.meta;
      assert.equal(database.runs(assignment.id)[0].state, 'prepared');
      const agent = { id: input.sessionId, session: { snapshotEvents: () => transcript }, async followup() {
        assert.equal(database.runs(assignment.id)[0].state, 'submitted');
        submitted = true;
        await tools.get('assistant_task_result').execute({ selfCheck: { summary: 'Verified evidence' } }, { agent, signal: new AbortController().signal, callId: 'self-check' });
        if (ending === 'paused') {
          database.pauseTicket(ticket.id);
          await events.get('agent/pre-step')({ messages: [] }, async () => ({ kind: 'enter', messages: [] }));
        }
        events.get('agent/status')({ status: 'running' });
        queueMicrotask(() => events.get('agent/status')({ status: 'idle' }));
      } };
      await input.setup({ tools: { register: tool => tools.set(tool.name, tool) }, effect: fn => fn(), get: name => name === 'worktrees' ? worktrees : undefined, systemPrompt: { section() {}, context(entry) { if (entry.name === 'benchgo-worker-source-reference') sourceReference = JSON.parse(entry.text()); } }, on: (name, listener) => events.set(name, listener) }, agent);
      return { agent, dispose: async () => { disposed = true; } };
    } },
  };
  await installExecutionRoleHost(t, ctx);
  const executor = createAssignmentExecutor({ ctx, database, workspaceRoot: join(directory, 'workers'), readSourceContext: async () => ({ status: 'available', messages: [{ text: 'Earlier discussion' }] }), readPolicy: async () => ({ version: 'p1', projects: [project], workerModels: [{ providerId: 'provider', modelId: 'opaque/model' }] }), authorizeAction: async () => ({ allowed: true }), captureCheckpoint: async input => { assert.deepEqual(input, projectMode ? environment : meta.cwd); return { version: 1, manifestHash: 'mock-checkpoint' }; } });
  const signal = new AbortController().signal;
  if (ending === 'max-tokens') {
    await assert.rejects(executor(assignment, { ticket, signal, renew: async () => {} }), error => error.code === 'WORKER_TURN_INCOMPLETE' && error.executionPhase === 'evidence');
    const run = database.runs(assignment.id)[0];
    assert.equal(database.getWorkerExecutionState(run.id).selfCheck.selfCheck.summary, 'Verified evidence');
    assert.equal(run.state, 'uncertain'); assert.equal(disposed, true);
    return;
  }
  const result = await executor(assignment, { ticket, signal, renew: async () => {} });
  if (ending === 'paused') { assert.equal(result.waitingPause, true); assert.equal(database.runs(assignment.id)[0].state, 'verifying'); return; }
  assert.equal(submitted, true); assert.equal(disposed, true);
  assert.equal(sourceReference.kind, 'untrusted-source-reference');
  assert.equal(sourceReference.messages[0].content, 'Earlier discussion');
  assert.equal(result.summary, 'Evidence found');
  assert.equal(result.directory, projectMode ? environment.path : meta.cwd);
  if (projectMode) {
    assert.deepEqual(database.runs(assignment.id)[0].environment, environment);
    assert.equal(result.checkpoint.manifestHash, 'mock-checkpoint');
    assert.throws(() => database.setRunEnvironment(result.runId, { owner: assignment.owner, fence: assignment.fence, environment }), /cannot change/);
  }
  assert.equal(database.runs(assignment.id)[0].state, 'verifying');
  assert.equal(typeof events.get('tools/execute'), 'function');
  const request = await events.get('agent/request')({ signal }, async () => ({ temperature: 0.2, provider: 'inherited', model: 'inherited' }));
  assert.equal(request.temperature, undefined);
  assert.equal(request.provider, 'provider');
  assert.equal(request.model, 'opaque/model');
  await assert.rejects(executor(assignment, { ticket, signal, renew: async () => {} }), /reconciliation/);
});

test('elapsed time never interrupts execution; an explicit abort keeps its submitted run uncertain', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-executor-timeout-'));
  const database = createAssistantOrchestrationStore({ directory });
  t.after(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
  database.createThread({ id: 'thread', source: { type: 'desktop', id: 'main' } });
  const ticket = database.createTicket({ threadId: 'thread', target: 'inspect', mandate: { scope: ['read'] } });
  database.createAssignment(ticket.id, { model: { providerId: 'provider', modelId: 'opaque/model' } });
  const [assignment] = database.claimAssignments('worker', { validateMandate: () => true });
  let interrupted = 0, disposed = 0;
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  const ctx = {
    sessionQuery: { readSession: async () => { throw new Error('must not read a successful transcript'); } },
    agents: { create: async input => {
      const agent = { followup() {}, cancel() { interrupted++; } };
      await input.setup({ tools: { register() {} }, systemPrompt: { section() {}, context() {} }, on() {} }, agent);
      return { agent, dispose: async () => { disposed++; } };
    } },
  };
  await installExecutionRoleHost(t, ctx);
  const executor = createAssignmentExecutor({ ctx, database, workspaceRoot: join(directory, 'workers'), readPolicy: async () => ({ workerModels: [{ providerId: 'provider', modelId: 'opaque/model' }] }), authorizeAction: async () => ({ allowed: true }), executionTimeoutMs: 20, executionPauseGraceMs: 20 });
  const controller = new AbortController();
  const execution = executor(assignment, { ticket, signal: controller.signal, renew: async () => {} });
  execution.catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(interrupted, 0, 'the removed execution-time gate no longer cancels long work');
  assert.equal(database.getTicket(ticket.id).status, 'open');
  controller.abort(new Error('owner stopped'));
  await assert.rejects(execution, /owner stopped/);
  assert.equal(interrupted, 1);
  assert.equal(disposed, 1);
  assert.equal(database.runs(assignment.id)[0].state, 'uncertain');
});

for (const cleanupFails of [false, true]) test(`cancel waits for confirmed host disposal (cleanupFails=${cleanupFails})`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-executor-cancel-'));
  const database = createAssistantOrchestrationStore({ directory });
  t.after(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
  database.createThread({ id: 'thread', source: { type: 'desktop', id: 'main' } });
  const ticket = database.createTicket({ threadId: 'thread', target: 'inspect', mandate: {} });
  database.createAssignment(ticket.id, { model: { providerId: 'provider', modelId: 'opaque/model' } });
  const [assignment] = database.claimAssignments('worker', { validateMandate: () => true });
  let submitted, disposing, release;
  const started = new Promise(resolve => { submitted = resolve; });
  const cleanupStarted = new Promise(resolve => { disposing = resolve; });
  const cleanup = new Promise(resolve => { release = resolve; });
  const ctx = { sessionQuery: { readSession: async () => assert.fail('cancel must not read result') }, agents: { create: async input => {
    const agent = { followup() { submitted(); }, cancel() {} };
    await input.setup({ tools: { register() {} }, systemPrompt: { section() {}, context() {} }, on() {} }, agent);
    return { agent, dispose: async () => { disposing(); await cleanup; if (cleanupFails) throw new Error('cleanup failed'); } };
  } } };
  await installExecutionRoleHost(t, ctx);
  const executor = createAssignmentExecutor({ ctx, database, workspaceRoot: join(directory, 'workers'), readPolicy: async () => ({ workerModels: [{ providerId: 'provider', modelId: 'opaque/model' }] }), authorizeAction: async () => ({ allowed: true }) });
  const controller = new AbortController();
  const work = executor(assignment, { ticket, signal: controller.signal, renew: async () => {} });
  const rejected = assert.rejects(work, cleanupFails ? /cleanup failed/ : /requested stop/);
  await started;
  assert.equal(database.cancelTicket(ticket.id).status, 'cancelling');
  controller.abort(new Error('requested stop'));
  await cleanupStarted;
  assert.equal(database.getTicket(ticket.id).status, 'cancelling');
  release(); await rejected;
  assert.equal(database.getTicket(ticket.id).status, cleanupFails ? 'cancelling' : 'cancelled');
});
