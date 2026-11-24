import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssignmentExecutor } from '../src/assignment-executor.mjs';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { installRoleHost, loadRolePackage } from './role-host-fixture.mjs';

const loadHost = name => loadRolePackage('core/agent-loop', name);
const { Context } = await loadHost('@deepseek-ai/cordis');
const { createScope } = await loadHost('@deepseek-ai/dsh-scope');

for (const harness of ['codex', 'claude']) test(`local ${harness} Worker uses the admitted API route and returns a result on the original Run`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-external-worker-'));
  const database = createAssistantOrchestrationStore({ directory });
  t.after(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
  database.createThread({ id: 'thread', source: { type: 'desktop', id: 'main' } });
  const task = database.createTask({ threadId: 'thread', target: 'Inspect the local project',
    mandate: { actorId: 'desktop-owner', source: { channel: 'desktop', sessionId: 'main' } } });
  const model = { harness, providerId: 'Opaque Provider', modelId: 'opaque/model', options: { reasoningEffort: 'low' } };
  database.createAssignment(task.id, { model });
  const [assignment] = database.claimAssignments('worker', { validateMandate: () => true });
  let session, released, disconnected, ask;
  const commander = {
    pickerCatalog: { list: async () => ({ routes: [{ tool: harness, providerId: model.providerId, nativeModelId: model.modelId, reasoning: { efforts: [{ id: 'low' }] } }] }) },
    async prepareExecution(input) {
      assert.equal(input.provider, harness);
      assert.deepEqual(input.route, { providerId: model.providerId, model: model.modelId });
      assert.deepEqual(input.advancedConfig, harness === 'codex' ? { config: { model_reasoning_effort: 'low' } } : { settings: { effortLevel: 'low' } });
      assert.equal(input.executionId, database.runs(assignment.id)[0].id);
      return session = { id: input.sessionId, cursor: 0, nativeId: 'native-handle' };
    },
    registerExecutionHandler(_id, handler) { ask = handler; return () => { released = true; }; },
    async submit(id, prompt, { requestId }) {
      assert.equal(id, session.id);
      assert.ok(prompt.includes(task.target));
      assert.ok(prompt.includes('进展：'));
      assert.equal(requestId, `worker:${database.runs(assignment.id)[0].id}`);
      const answer = ask({ kind: 'question', id: 'approval', nativeRequestId: 'native-question', details: {
        questions: [{ id: 'question', question: 'Which environment?', options: [{ label: 'Test' }] }],
      } });
      const [attention] = database.attentions(task.id);
      assert.equal(attention.callId, 'native-question');
      database.answerDesktopAttention({ taskId: task.id, attentionId: attention.id, instructionRevision: 1,
        requestId: 'answer', answer: { selected: ['Test'] } });
      assert.deepEqual(await answer, harness === 'codex' ? { allow: false, answers: { question: { answers: ['Test'] } } }
        : { allow: true, answers: { 'Which environment?': 'Test' } });
      return { turnId: 'turn', status: 'accepted' };
    },
    events: (_id, cursor) => cursor === 0 ? { cursor: 1, latest: 2, events: [
      { seq: 1, turnId: 'turn', type: 'text.delta', time: '2026-11-17T11:59:00.000Z',
        data: { text: '进展：正在核对本地项目\nObserved result' } },
    ] } : { cursor: 2, events: [
      { seq: 2, turnId: 'turn', type: 'turn.completed', time: '2026-11-17T12:00:00.000Z',
        data: { status: 'completed' } },
    ] },
    snapshot: () => session,
    persist: async () => {},
    stopExecution() { assert.fail('Completed execution never requires interruption'); },
    async disconnect(id) { disconnected = id; },
  };
  const ctx = { agents: { create() { assert.fail('External execution cannot start an official Agent'); } },
    sessionQuery: { readSession() {} }, get: name => name === 'commander' ? commander : undefined };
  const executor = createAssignmentExecutor({ ctx, database, workspaceRoot: join(directory, 'workers'),
    readPolicy: async () => ({ workerHarness: 'official', workerModels: [{ providerId: 'new-policy', modelId: 'new-model' }] }),
    authorizeAction: async () => ({ allowed: true }) });
  const result = await executor(assignment, { task, signal: new AbortController().signal, renew: async () => {} });
  const [run] = database.runs(assignment.id);
  assert.deepEqual(database.getWorkerExecutionState(run.id).models, [model]);
  assert.equal(result.summary, 'Observed result');
  assert.equal(run.sessionId, session.id);
  assert.equal(run.evidence.nativeExecution.nativeId, 'native-handle');
  assert.equal(database.getExecutionProjection(session.id).state.status, 'completed');
  assert.deepEqual(database.getExecutionProjection(session.id).state.activityHistory, [
    { seq: 1, time: '2026-11-17T11:59:00.000Z', status: 'running', activity: '正在核对本地项目', activitySource: 'report' },
  ]);
  assert.equal(disconnected, session.id);
  assert.equal(released, true);
});

for (const confirmed of [true, false]) test(`local external Worker stop ${confirmed ? 'confirmed' : 'unverified'}`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-external-stop-'));
  const database = createAssistantOrchestrationStore({ directory });
  t.after(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
  database.createThread({ id: 'thread', source: { type: 'desktop', id: 'main' } });
  const task = database.createTask({ threadId: 'thread', target: 'Inspect project',
    mandate: { actorId: 'desktop-owner', source: { channel: 'desktop', sessionId: 'main' } } });
  database.createAssignment(task.id, { model: { harness: 'codex', providerId: 'provider', modelId: 'model' } });
  const [assignment] = database.claimAssignments('worker', { validateMandate: () => true });
  let disconnects = 0;
  const commander = {
    pickerCatalog: { list: async () => ({ routes: [{ tool: 'codex', providerId: 'provider', nativeModelId: 'model' }] }) },
    prepareExecution: async ({ sessionId }) => ({ id: sessionId, cursor: 0 }),
    registerExecutionHandler: () => () => {},
    submit: async () => ({ turnId: 'turn', status: 'accepted' }),
    events: () => ({ cursor: 0, events: [] }),
    async wait() {
      database.cancelTask(task.id);
      return { status: 'running', cursor: 1, updatedAt: new Date().toISOString() };
    },
    async stopExecution() {
      assert.equal(database.getTask(task.id).executionControl.stopRequested, true);
      assert.equal(database.getTask(task.id).executionControl.stopped, false);
      if (!confirmed) throw new Error('Native stop has not been confirmed');
      return { status: 'idle', cursor: 2, updatedAt: new Date().toISOString() };
    },
    async persist() {},
    async disconnect() { disconnects++; },
  };
  const ctx = { agents: { create() { assert.fail('External execution cannot start an official Agent'); } },
    sessionQuery: { readSession() {} }, get: name => name === 'commander' ? commander : undefined };
  const executor = createAssignmentExecutor({ ctx, database, workspaceRoot: join(directory, 'workers'),
    readPolicy: async () => ({}), authorizeAction: async () => ({ allowed: true }) });
  await assert.rejects(executor(assignment, { task, signal: new AbortController().signal, renew: async () => {} }), error => {
    assert.equal(error.code, 'NATIVE_WORKER_STOP_REQUESTED');
    assert.equal(error.cleanupFailure, confirmed ? undefined : 'Native stop has not been confirmed');
    return true;
  });
  assert.equal(database.getTask(task.id).executionControl.stopped, confirmed);
  assert.equal(disconnects, Number(confirmed));
  if (!confirmed) assert.equal(database.runs(assignment.id)[0].state, 'uncertain');
});

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

for (const selection of ['worker', 'explicit', 'inherit']) test(`Worker uses the effective work-role queue (${selection})`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-worker-models-'));
  const database = createAssistantOrchestrationStore({ directory });
  t.after(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
  database.createThread({ id: 'thread', source: { type: 'desktop', id: 'main' } });
  const task = database.createTask({ threadId: 'thread', target: 'inspect', mandate: {} });
  const router = { providerId: 'Router/@', modelId: 'Exact: Router/1', options: { maxTokens: 100, reasoningEffort: 'low' } };
  const routerBackup = { providerId: 'Router Backup/@', modelId: 'Exact: Router/2', options: { maxTokens: 250 } };
  const worker = { providerId: 'Worker/@', modelId: 'Exact: Worker/2', options: { reasoningEffort: 'ultra', maxTokens: 700 } };
  const backup = { providerId: 'Backup/@', modelId: 'Exact: Worker/3', options: { maxTokens: 200 } };
  const explicit = { providerId: 'Explicit/@', modelId: 'Exact: Selected/4', options: { maxTokens: 900 } };
  const workers = selection === 'inherit' ? [] : [worker, backup];
  const expected = workers.length ? workers : [router, routerBackup];
  database.createAssignment(task.id, selection === 'explicit' ? { model: explicit } : selection === 'inherit' ? { model: { ...router, harness: 'official' } } : {});
  const [assignment] = database.claimAssignments('worker', { validateMandate: () => true });
  const tools = new Map();
  const hooks = new Map(), seen = [], selected = [], transcript = [], injected = [];
  const signal = new AbortController().signal;
  const ctx = {
    on() { return () => {}; },
    llm: { prepareCall: async request => {
      seen.push([request.provider, request.model, request.maxTokens, request.reasoningEffort]);
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
          } catch (error) { hooks.get('agent/error')({ error }); }
          finally { transcript.push({ seq: transcript.length, type: 'turn/end', data: { turn, reason: { kind: 'completed' } } }); hooks.get('agent/status')({ status: 'idle' }); }
        });
      } };
      await input.setup({ tools: { register: tool => tools.set(tool.name, tool) }, effect: fn => fn(), get: () => undefined, systemPrompt: { section() {}, context() {} }, on: (name, handler) => hooks.set(name, handler) }, agent);
      return { agent, dispose: async () => {} };
    } },
  };
  await installExecutionRoleHost(t, ctx);
  const executor = createAssignmentExecutor({ ctx, database, workspaceRoot: join(directory, 'workers'), readPolicy: async () => ({ model: router, models: [router, routerBackup], workerModels: workers }), authorizeAction: async () => ({ allowed: true }) });
  await executor(assignment, { task, signal, renew: async () => {} });
  assert.deepEqual(seen, expected.map(model => [model.providerId, model.modelId, model.options.maxTokens, model.options.reasoningEffort]));
  assert.equal(selected[0].provider, expected[0].providerId);
  assert.equal(selected[0].model, expected[0].modelId);
  assert.equal(selected[0].reasoningEffort, expected[0].options.reasoningEffort);
});

for (const [projectMode, ending] of [[false, 'completed'], [true, 'completed'], ['directory', 'completed'], [false, 'max-tokens'], [false, 'paused']]) test(`host execution is persisted, isolated and permission-gated (project=${projectMode}, ending=${ending})`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-executor-'));
  const database = createAssistantOrchestrationStore({ directory });
  t.after(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
  database.createThread({ id: 'thread', source: { type: 'desktop', id: 'main' } });
  const project = { id: 'opaque-project', path: join(directory, 'source') };
  if (projectMode) await mkdir(projectMode === true ? join(project.path, '.git') : project.path, { recursive: true });
  const source = { channel: 'feishu', chatId: 'chat', messageId: 'message' };
  const original = 'Inspect the saved build without changing files.';
  const { trigger } = database.ingest({ dedupeKey: 'request', thread: { id: 'thread', source: { type: 'desktop', id: 'main' } }, source,
    actor: { kind: 'human', id: 'owner' }, content: original, mode: 'direct' });
  const task = database.createTask({ threadId: 'thread', target: 'inspect', sourceTriggerIds: [trigger.id],
    mandate: { scope: ['read'], source, triggerId: trigger.id, instruction: original, ...(projectMode ? { project } : {}) } });
  database.createAssignment(task.id, { model: { providerId: 'provider', modelId: 'opaque/model' } });
  const [assignment] = database.claimAssignments('worker', { validateMandate: () => true });
  const events = new Map(); let disposed = false, meta, submitted = false, sourceReference, assignmentContext;
  const transcript = [], tools = new Map();
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
        await events.get('tools/execute')({ agent, name: 'write', arguments: {}, callId: 'project-write', signal: new AbortController().signal }, async () => 'written');
        if (ending === 'paused') {
          database.pauseTask(task.id);
          await events.get('agent/pre-step')({ messages: [] }, async () => ({ kind: 'enter', messages: [] }));
        }
        events.get('agent/status')({ status: 'running' });
        queueMicrotask(() => events.get('agent/status')({ status: 'idle' }));
      } };
      await input.setup({ tools: { register: tool => tools.set(tool.name, tool) }, effect: fn => fn(), get: name => { if (name === 'worktrees') throw new Error('Worktree must not be required for dispatch'); }, systemPrompt: { section() {}, context(entry) {
        if (entry.name === 'benchgo-worker-source-reference') sourceReference = JSON.parse(entry.text());
        if (entry.name === 'benchgo-assignment') assignmentContext = entry.text;
      } }, on: (name, listener) => events.set(name, listener) }, agent);
      return { agent, dispose: async () => { disposed = true; } };
    } },
  };
  await installExecutionRoleHost(t, ctx);
  const executor = createAssignmentExecutor({ ctx, database, workspaceRoot: join(directory, 'workers'), readSourceContext: async () => ({ status: 'available', messages: [{ text: 'Earlier discussion' }] }), readPolicy: async () => ({ version: 'p1', projects: [project], workerModels: [{ providerId: 'provider', modelId: 'opaque/model' }] }), authorizeAction: async () => ({ allowed: true }) });
  const signal = new AbortController().signal;
  if (ending === 'max-tokens') {
    await assert.rejects(executor(assignment, { task, signal, renew: async () => {} }), error => error.code === 'WORKER_TURN_INCOMPLETE' && error.executionPhase === 'evidence');
    const run = database.runs(assignment.id)[0];
    assert.equal(tools.has('assistant_task_result'), false);
    assert.equal(run.state, 'submitted'); assert.equal(disposed, true);
    return;
  }
  const result = await executor(assignment, { task, signal, renew: async () => {} });
  if (ending === 'paused') { assert.equal(result.waitingPause, true); assert.equal(database.runs(assignment.id)[0].state, 'verifying'); return; }
  assert.equal(submitted, true); assert.equal(disposed, true);
  assert.equal(sourceReference.kind, 'untrusted-source-reference');
  assert.equal(sourceReference.messages[0].content, 'Earlier discussion');
  const taskPackage = JSON.parse(assignmentContext().split('\nTask package:\n')[1]);
  assert.equal(taskPackage.mandate.triggerId, trigger.id);
  assert.deepEqual(taskPackage.mandate.source, source);
  assert.equal(taskPackage.mandate.instruction, original);
  assert.equal(result.summary, 'Evidence found');
  for (const key of ['finalSummary', 'toolEvidence', 'selfCheck', 'outcome', 'failure']) assert.equal(Object.hasOwn(result, key), false, key);
  assert.equal(meta.cwd, projectMode ? project.path : database.runs(assignment.id)[0].directory);
  assert.equal(database.runs(assignment.id)[0].workingDirectory, meta.cwd);
  assert.equal(result.directory, database.runs(assignment.id)[0].directory);
  assert.equal(Object.hasOwn(result, 'checkpoint'), false);
  assert.equal(result.environment, undefined);
  assert.equal(database.runs(assignment.id)[0].environment, undefined);
  assert.equal(database.runs(assignment.id)[0].state, 'verifying');
  assert.equal(typeof events.get('tools/execute'), 'function');
  const request = await events.get('agent/request')({ signal }, async () => ({ temperature: 0.2, provider: 'inherited', model: 'inherited' }));
  assert.equal(request.temperature, undefined);
  assert.equal(request.provider, 'provider');
  assert.equal(request.model, 'opaque/model');
  await assert.rejects(executor(assignment, { task, signal, renew: async () => {} }), /reconciliation/);
});

for (const hostStop of [false, true]) test(`elapsed time never interrupts execution; host shutdown is classified separately (hostStop=${hostStop})`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-executor-timeout-'));
  const database = createAssistantOrchestrationStore({ directory });
  t.after(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
  database.createThread({ id: 'thread', source: { type: 'desktop', id: 'main' } });
  const task = database.createTask({ threadId: 'thread', target: 'inspect', mandate: { scope: ['read'] } });
  database.createAssignment(task.id, { model: { providerId: 'provider', modelId: 'opaque/model' } });
  const [assignment] = database.claimAssignments('worker', { validateMandate: () => true });
  let interrupted = 0, disposed = 0, cancellation;
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  const ctx = {
    sessionQuery: { readSession: async () => { throw new Error('must not read a successful transcript'); } },
    agents: { create: async input => {
      const agent = { followup() {}, cancel(reason) { interrupted++; cancellation = reason; } };
      await input.setup({ tools: { register() {} }, systemPrompt: { section() {}, context() {} }, on() {} }, agent);
      return { agent, dispose: async () => { disposed++; } };
    } },
  };
  await installExecutionRoleHost(t, ctx);
  const executor = createAssignmentExecutor({ ctx, database, workspaceRoot: join(directory, 'workers'), readPolicy: async () => ({ workerModels: [{ providerId: 'provider', modelId: 'opaque/model' }] }), authorizeAction: async () => ({ allowed: true }), executionTimeoutMs: 20, executionPauseGraceMs: 20 });
  const controller = new AbortController();
  const execution = executor(assignment, { task, signal: controller.signal, renew: async () => {} });
  execution.catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(interrupted, 0, 'the removed execution-time gate no longer cancels long work');
  assert.equal(database.getTask(task.id).status, 'running');
  controller.abort(Object.assign(new Error('owner stopped'), hostStop ? { code: 'WORKER_HOST_STOPPED' } : {}));
  await assert.rejects(execution, /owner stopped/);
  assert.equal(interrupted, 1);
  assert.deepEqual(cancellation, { kind: hostStop ? 'disposed' : 'user' });
  assert.equal(disposed, 1);
  assert.equal(database.runs(assignment.id)[0].state, 'submitted');
});

for (const cleanupFails of [false, true]) test(`cancel waits for confirmed host disposal (cleanupFails=${cleanupFails})`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-executor-cancel-'));
  const database = createAssistantOrchestrationStore({ directory });
  t.after(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
  database.createThread({ id: 'thread', source: { type: 'desktop', id: 'main' } });
  const task = database.createTask({ threadId: 'thread', target: 'inspect', mandate: {} });
  database.createAssignment(task.id, { model: { providerId: 'provider', modelId: 'opaque/model' } });
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
  const work = executor(assignment, { task, signal: controller.signal, renew: async () => {} });
  const rejected = assert.rejects(work, error => error.message === 'requested stop' && (!cleanupFails || error.cleanupFailure === 'cleanup failed'));
  await started;
  assert.equal(database.cancelTask(task.id).status, 'waiting');
  assert.equal(database.getTask(task.id).executionControl.stopRequested, true);
  controller.abort(new Error('requested stop'));
  await cleanupStarted;
  assert.equal(database.getTask(task.id).status, 'waiting');
  assert.equal(database.getTask(task.id).executionControl.stopRequested, true);
  release(); await rejected;
  assert.equal(database.getTask(task.id).status, 'waiting');
  assert.equal(database.getTask(task.id).executionControl.stopRequested, cleanupFails);
  assert.equal(database.getTask(task.id).executionControl.stopped, !cleanupFails);
});
