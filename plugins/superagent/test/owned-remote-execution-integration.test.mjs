import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAssistantStore } from '../src/store.mjs';
import { readAssessmentPolicy } from '../src/assessment-policy.mjs';
import { createOrchestrationRuntime } from '../src/orchestration-runtime.mjs';
import { createDesktopTaskAccess } from '../src/desktop-task-access.mjs';
import { createRouterTools } from '../src/router-tools.mjs';
import { createTaskCleanupContinuation } from '../src/task-cleanup-continuation.mjs';
import { createTaskManagement } from '../src/task-management.mjs';
import { createAssistantRuntimeStore } from '../src/runtime-store.mjs';
import { taskReplyInstruction, taskReplySignal } from '../src/task-reply.mjs';
import { createRemoteAssignmentExecutor } from '../src/remote-assignment-executor.mjs';
import { commitWorkerResult } from '../src/result-commit.mjs';
import { createRemoteExecutionService } from '../../harness/src/remote-execution.mjs';
import { remoteExecutionFixture } from '../../harness/test/fixtures/remote-execution.mjs';
import { Commander } from '../../harness/src/runtime.mjs';
import { fixtureRouteService } from '../../harness/test/fixtures/api-route.mjs';
import { readNativeWorkerSession } from '../src/execution-session.mjs';
import { createWorkerArchive } from '../src/worker-archive.mjs';

const waitFor = async predicate => { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('Execution boundary timed out'); };
async function fixture(t, { external = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-owned-dual-'));
  const official = remoteExecutionFixture();
  const config = external ? { harness: 'codex', models: [{ providerId: 'exact-provider', modelId: 'opaque-model/1' }] }
    : { harness: 'official', models: [{ providerId: 'exact-provider', modelId: 'opaque-model/1' }] };
  let commander;
  if (external) {
    const script = fileURLToPath(new URL('../../harness/test/codex-fixture.mjs', import.meta.url));
    commander = await new Commander({ dataDir: join(directory, 'commander'), providers: { codex: { command: process.execPath, commandArgs: [script] } },
      routeService: fixtureRouteService }).open();
    commander.pickerCatalog = { list: async () => ({ routes: [{ tool: 'codex', providerId: 'exact-provider', nativeModelId: 'opaque-model/1' }] }) };
  }
  const peer = await createRemoteExecutionService({ ctx: official.ctx, directory, ...(commander ? { commander } : {}) });
  const store = await createAssistantStore({ dataDirectory: directory });
  let runtimeStore;
  const database = store.orchestration, policy = await readAssessmentPolicy(store);
  let clock = Date.now(), offline = false, runtime, archives;
  const calls = [], execution = { deviceId: 'device-B', hostId: 'host-B', authorizationId: 'A-B-grant', protocolVersion: 2, config };
  const ctx = { logger: { warn() {} }, get: name => name === 'benchgoLink' ? { callDevice: async input => {
    assert.equal(input.expectedHostId, execution.hostId); assert.equal(input.expectedAuthorizationId, execution.authorizationId);
    calls.push(structuredClone(input.input));
    if (offline) throw Object.assign(new Error('offline'), { code: 'DEVICE_OFFLINE' });
    return peer.dispatch(input.input, { principal: { kind: 'device', deviceId: 'B-sees-A' }, signal: input.signal, hostId: execution.hostId });
  } } : undefined };
  const source = { channel: 'desktop', sessionId: 'owner-session', threadId: 'main', messageId: 'initial' };
  const mandate = { source, actorId: 'desktop-owner', admission: 'desktop-approved-delegation', instruction: 'do the work',
    controlledActions: 'require-current-policy-and-harness-approval', policyVersion: policy.desktopVersion, execution };
  database.createThread({ id: 'desktop:owner-session', source: { type: 'desktop', id: source.sessionId } });
  const task = database.createTask({ threadId: 'desktop:owner-session', target: 'do the work', acceptance: 'verified result', mandate });
  database.createAssignment(task.id, { executor: 'remote', execution, text: task.target });
  const [assignment] = database.claimAssignments('initial-worker', { validateMandate: () => true });
  const create = () => createRemoteAssignmentExecutor({ ctx, database, now: () => clock, pollMs: 10,
    readPolicy: async () => policy, commitResult: async (result, { assignment, task }) => commitWorkerResult({
      database, result, assignment, task, uniqueKey: `assignment-result:${assignment.id}:${result.runId}:${assignment.fence}` }) });
  let owner = create();
  t.after(async () => { await archives?.dispose(); await runtime?.stop(); await owner.stop(); await peer.close(); await commander?.close(); runtimeStore?.close(); await store.close(); await rm(directory, { recursive: true, force: true }); });
  const human = (text, key) => database.ingest({ dedupeKey: key, thread: { id: 'desktop:owner-session', source: { type: 'desktop', id: source.sessionId } },
    source: { ...source, messageId: key }, actor: { kind: 'human', id: 'desktop-owner' }, content: text, mode: 'direct' }).trigger;
  await owner.execute(assignment, { task });
  if (!external) await waitFor(() => official.instances[0]?.pending.length);
  return { ctx, commander, database, peer, official, task, assignment, calls, human,
    get owner() { return owner; },
    async tick() { clock += 100000; await owner.tick(); },
    async restartOwner() { await owner.stop(); owner = create(); },
    offline(value) { offline = value; },
    get taskCleanup() {
      runtimeStore ??= createAssistantRuntimeStore({ filename: store.paths.database });
      return runtimeStore.taskCleanup;
    },
    archive() {
      runtimeStore ??= createAssistantRuntimeStore({ filename: store.paths.database });
      const archive = createWorkerArchive({ ctx, commander: commander || {}, orchestration: database, database: runtimeStore,
        signal: new AbortController().signal, wake() {} });
      archives = archive;
      return archive;
    },
    cleanup() {
      runtimeStore ??= createAssistantRuntimeStore({ filename: store.paths.database });
      const taskManagement = createTaskManagement({ database: runtimeStore, orchestration: database });
      return createTaskCleanupContinuation({ database: runtimeStore, orchestration: database, taskManagement });
    },
    scheduler() {
      return runtime ||= createOrchestrationRuntime({ ctx, store, execute: async () => assert.fail('Remote work must use B') });
    },
    manage(text, operation) {
      const human = { id: operation, content: [{ type: 'text', text }], source: { kind: 'user' } };
      const agent = { id: source.sessionId, status: 'running', session: { header: { origin: 'main' },
        snapshotEvents: () => [{ type: 'turn/start' }, { type: 'user/message', data: human }] } };
      const tools = new Map();
      createRouterTools({ ctx: { ...ctx, agents: { get: id => id === agent.id ? agent : undefined,
        currentInitiator: () => agent, turnBoundaryOf: () => ({ openTurnStartSeq: 0 }) } },
        store: { getState: async () => ({ mainSessionId: agent.id }) }, database, shutdown: new AbortController(),
        desktopTasks: createDesktopTaskAccess(database), orchestrationRuntime: this.scheduler() })(
        { tools: { register(definition) { tools.set(definition.name, definition); } }, systemPrompt: { section() {}, context() {} } }, { agent, threadId: 'main' });
      return tools.get('assistant_execution_manage').execute({ taskId: task.id, operation }, { agent });
    },
    revise(revision) {
      const trigger = human(`owner revision ${revision}`, `revision-${revision}`);
      database.changeTask(task.id, { operation: 'revise', expectedInstructionRevision: revision - 1,
        target: `do the work version ${revision}`, acceptance: 'verified result', reason: 'owner instruction', requestKey: `revision-${revision}`,
        triggerId: trigger.id, mandate: { ...mandate, source: { ...source, messageId: `revision-${revision}` }, instruction: trigger.content },
        model: execution.config.models[0], validateMandate: () => true });
    },
  };
}

async function finishFirst(app, kind = 'completed') {
  const instance = app.official.instances[0];
  if (kind === 'error') {
    const error = { code: 'TOOL_ACTIVATION_FAILED', message: 'Cannot activate tool' };
    instance.append('turn/start', { turn: 1 });
    instance.append('turn/end', { reason: { kind: 'error', error } });
    instance.listeners.get('agent/error')[0]({ error });
  } else {
    await instance.step();
    await instance.finish();
  }
  await waitFor(() => instance.disposed);
  await app.tick();
}

for (const [initial, outcome] of [['completed', 'completed'], ['error', 'waiting']]) {
  test(`a revision after actual B ${initial} starts a new execution and updates the same Task`, async t => {
    const app = await fixture(t);
    await finishFirst(app, initial);
    const previous = app.database.remoteExecution(app.assignment.id);
    assert.equal(app.database.getTask(app.task.id).status, outcome);
    if (initial === 'error') {
      const failure = app.database.deliveries(app.task.id).find(row => row.payload.assignmentId === app.assignment.id);
      assert.match(taskReplyInstruction(taskReplySignal(app.database, failure)), /询问用户是否停止/);
    }
    app.revise(2);
    const assignments = app.database.assignments(app.task.id);
    assert.equal(assignments.length, 2);
    const replacement = assignments.at(-1), runtime = app.scheduler();
    assert.equal(replacement.redispatchOfAssignmentId, app.assignment.id);
    await runtime.tick();
    await waitFor(() => app.official.instances[1]?.pending.length);
    const view = runtime.state({ taskId: app.task.id })[0];
    assert.equal(view.execution.assignmentId, replacement.id);
    assert.equal(view.executionSession.assignmentId, replacement.id);
    assert.notEqual(view.execution.runId, previous.runId);
    assert.notEqual(view.execution.sessionId, previous.sessionId);
    assert.notEqual(view.execution.remote.executionId, previous.executionId);
    const revision = app.database.taskInputs(app.task.id).find(row => row.kind === 'revision');
    assert.equal(revision.state, 'pending');
    assert.deepEqual(app.calls.filter(row => row.operation === 'submit').map(row => row.requirements.instructionRevision), [1, 2]);
    const worker = app.official.instances[1];
    await worker.step();
    await worker.finish();
    await waitFor(() => worker.disposed);
    for (let i = 0; i < 30 && app.database.getTask(app.task.id).status !== 'completed'; i++) {
      await runtime.tick(); await new Promise(resolve => setTimeout(resolve, 45));
    }
    assert.equal(app.database.getTask(app.task.id).status, 'completed');
    assert.equal(runtime.state({ taskId: app.task.id })[0].execution.appliedInstructionRevision, 2);
    const applied = app.database.taskInputs(app.task.id).find(row => row.id === revision.id);
    assert.equal(applied.state, 'applied');
    assert.equal(applied.application.assignmentId, replacement.id);
    assert.equal(applied.application.runId, view.execution.runId);
    assert.equal(app.database.listTasks().length, 1);
    assert.equal(app.database.results(app.task.id).length, initial === 'completed' ? 2 : 1);
    assert.equal(app.calls.some(row => row.operation === 'input' && row.kind === 'revision'), false);
  });
}

test('assistant_execution_manage abandons an unreachable execution then dispatches a new peer execution on explicit retry', async t => {
  const app = await fixture(t);
  const previous = app.database.remoteExecution(app.assignment.id);
  app.offline(true); await app.tick();
  const abandoned = await app.manage('按失败处理这张工单。', 'abandon');
  assert.equal(abandoned.status, 'abandoned');
  assert.equal(abandoned.executionId, previous.executionId);
  const original = app.database.getAssignment(app.assignment.id);
  assert.equal(original.state, 'failed');
  assert.equal(original.firstFailure.code, 'REMOTE_EXECUTION_ABANDONED');
  assert.ok(app.calls.some(row => row.operation === 'control' && row.control === 'cancel' && row.executionId === previous.executionId));
  app.offline(false);
  const queued = await app.manage('把同一张工单再派一次。', 'redispatch');
  assert.equal(queued.status, 'queued');
  assert.equal(queued.previousAssignmentId, app.assignment.id);
  assert.notEqual(queued.assignmentId, app.assignment.id);
  await waitFor(() => app.official.instances[1]?.pending.length);
  const execution = app.scheduler().state({ taskId: app.task.id })[0].execution;
  assert.equal(execution.assignmentId, queued.assignmentId);
  assert.notEqual(execution.remote.executionId, previous.executionId);
  assert.deepEqual(app.calls.filter(row => row.operation === 'submit').map(row => row.identity.assignmentId), [app.assignment.id, queued.assignmentId]);
});

test('A observes one Codex run on B through actual Commander and reads its original output', async t => {
  const app = await fixture(t, { external: true });
  const remote = app.database.remoteExecution(app.assignment.id);
  for (let i = 0; i < 100; i++) {
    const result = await app.peer.dispatch({ action: 'execution', version: 2, operation: 'get', executionId: remote.executionId },
      { principal: { kind: 'device', deviceId: 'B-sees-A' } });
    if (result.execution.phase === 'completed') break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  await app.restartOwner();
  await app.tick();
  const observed = app.database.remoteExecution(app.assignment.id);
  assert.equal(app.database.getTask(app.task.id).status, 'completed', JSON.stringify({ phase: observed.phase, code: observed.code, error: observed.observed?.error }));
  assert.match(app.database.results(app.task.id)[0].summary, /fixture/);
  const view = await readNativeWorkerSession({ ctx: app.ctx, database: app.database, taskId: app.task.id, sessionId: remote.sessionId });
  assert.equal(view.status, 'completed');
  assert.match(view.events.map(event => event.text).join(''), /fixture/);
  assert.equal(app.calls.filter(row => row.operation === 'submit').length, 1);
  assert.equal(app.official.instances.length, 0);
});

test('actual A coordinator and independent B service complete one host Task through the official lifecycle', async t => {
  const app = await fixture(t), instance = app.official.instances[0];
  assert.equal(app.official.services.assistant, undefined);
  await instance.step();
  await app.tick();
  assert.equal(app.database.remoteExecution(app.assignment.id).available, true, 'initial submit applied receipt is accepted');
  await app.restartOwner();
  assert.equal(instance.disposed, undefined, 'A restart does not dispose B');
  await instance.finish(); await waitFor(() => instance.disposed); await app.tick();
  assert.equal(app.database.getTask(app.task.id).status, 'completed');
  assert.equal(app.database.results(app.task.id)[0].summary, 'Actual execution result');
  assert.equal(app.calls.filter(row => row.operation === 'submit').length, 1);
  assert.equal(app.database.listTasks().length, 1);
  assert.equal(app.database.runs(app.assignment.id).length, 1);
});

test('official peer progress reaches the owner timeline and catches up after a disconnect', async t => {
  const app = await fixture(t), instance = app.official.instances[0];
  const runtime = app.scheduler();
  const read = () => runtime.state({ taskId: app.task.id })[0];
  const report = text => instance.append('assistant/message', { message: {
    role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text }],
  } });
  instance.append('turn/start', { turn: 1 });
  await instance.step();
  const cursor = runtime.executionFacts.currentCursor();
  report('进展：核对原始执行记录');
  await app.tick();
  const first = read();
  assert.equal(first.execution.worker.activity, '核对原始执行记录');
  assert.equal(first.execution.worker.activitySource, 'report');
  assert.equal(first.execution.uncertainty, null);
  assert.equal(first.liveSummary?.blocker || '', '');
  const facts = runtime.executionFacts.page({ after: cursor });
  assert.ok(facts.entries.some(row => row.taskId === app.task.id));

  app.offline(true);
  await app.tick();
  report('进展：找到原会话并确认记录边界');
  await app.tick();
  const disconnected = read();
  assert.ok(disconnected.execution.uncertainty);
  assert.ok(disconnected.execution.worker.history.some(row => row.activity === '核对原始执行记录'));

  await app.restartOwner();
  app.offline(false);
  await app.tick();
  const resumed = read();
  assert.equal(resumed.execution.worker.activity, '找到原会话并确认记录边界');
  assert.equal(resumed.execution.uncertainty, null);
  const reports = resumed.execution.worker.history.filter(row => row.activitySource === 'report');
  assert.deepEqual(reports.map(row => row.activity), ['核对原始执行记录', '找到原会话并确认记录边界']);
  await app.tick();
  assert.deepEqual(read().execution.worker.history.filter(row => row.activitySource === 'report'), reports);

  await instance.finish();
  await waitFor(() => instance.disposed);
  await app.tick();
  const completed = read();
  assert.equal(completed.execution.worker.status, 'completed');
  assert.deepEqual(completed.execution.worker.history.filter(row => row.activitySource === 'report'), reports);
  assert.equal(app.database.results(app.task.id)[0].summary, 'Actual execution result');
  assert.equal(app.calls.filter(row => row.operation === 'submit').length, 1);
});

test('actual B context and question inputs are applied only at their official boundaries', async t => {
  const app = await fixture(t), instance = app.official.instances[0]; await instance.step(); await app.tick();
  const trigger = app.human('additional factual context', 'context');
  app.database.deliverSubscribedMessage(trigger.id, { taskId: app.task.id, subscribeIfMissing: true });
  await app.tick();
  assert.equal(app.database.taskInputs(app.task.id).find(row => row.triggerId === trigger.id).state, 'pending');
  await instance.step(); await app.tick();
  assert.equal(app.database.taskInputs(app.task.id).find(row => row.triggerId === trigger.id).state, 'applied');
  assert.deepEqual(app.database.pendingSubscriptionMessages(app.task.id), []);
  const question = instance.question([{ id: 'one', question: 'First?' }, { id: 'two', question: 'Second?' }]);
  await new Promise(resolve => setImmediate(resolve)); await app.tick();
  const entries = app.database.attentions(app.task.id);
  assert.equal(entries.length, 2);
  for (const entry of entries) app.database.answerDesktopAttention({ taskId: app.task.id, attentionId: entry.id,
    instructionRevision: 1, requestId: `answer:${entry.id}`, answer: { selected: [], custom: `actual ${entry.question.id}` } });
  await app.tick();
  assert.deepEqual((await question).answers.map(row => row.custom), ['actual one', 'actual two']);
  await instance.finish(); await waitFor(() => instance.disposed); await app.tick();
  assert.equal(app.database.getTask(app.task.id).status, 'completed');
});

test('actual B pause and original-session resume retain A Run, fence and requirement versions', async t => {
  const app = await fixture(t), first = app.official.instances[0]; await first.step(); await app.tick();
  const before = app.database.remoteExecution(app.assignment.id);
  app.database.pauseTask(app.task.id); await app.tick();
  assert.equal(app.database.getTask(app.task.id).executionControl.paused, false);
  await first.step(); await waitFor(() => first.disposed); await app.tick();
  assert.equal(app.database.getTask(app.task.id).executionControl.paused, true);
  app.database.resumeTask(app.task.id); await app.tick();
  await waitFor(() => app.official.instances[1]?.pending.length);
  const second = app.official.instances[1]; await second.step(); await app.tick();
  assert.equal(second.agent.id, first.agent.id);
  assert.equal(app.database.remoteExecution(app.assignment.id).runId, before.runId);
  assert.equal(app.database.getAssignment(app.assignment.id).fence, before.fence);
  await second.finish(); await waitFor(() => second.disposed); await app.tick();
  assert.equal(app.database.getTask(app.task.id).status, 'completed');
});

test('actual B serializes requirement acknowledgements while A receives a newer revision', async t => {
  const app = await fixture(t), instance = app.official.instances[0]; await instance.step(); await app.tick();
  app.revise(2); await app.tick();
  app.revise(3); await app.tick();
  assert.deepEqual(app.calls.filter(row => row.operation === 'input' && row.kind === 'revision').map(row => row.instructionRevision), [2, 2]);
  assert.equal(app.database.getAssignment(app.assignment.id).instructionRevision, 1);
  await instance.step(); await app.tick();
  assert.equal(app.database.getAssignment(app.assignment.id).instructionRevision, 2);
  assert.equal(app.database.getTask(app.task.id).instructionRevision, 3);
  await instance.step(); await app.tick();
  assert.equal(app.database.getAssignment(app.assignment.id).instructionRevision, 3);
  assert.equal(app.database.pendingTaskInputs(app.task.id).filter(row => row.kind === 'revision').length, 0);
  await instance.finish(); await waitFor(() => instance.disposed); await app.tick();
  assert.equal(app.database.getTask(app.task.id).status, 'completed');
});

test('actual B cancellation is unconfirmed while official writer disposal remains pending', async t => {
  const app = await fixture(t), instance = app.official.instances[0]; await instance.step(); await app.tick();
  let release; app.official.setStopBarrier(new Promise(resolve => { release = resolve; }));
  app.database.cancelTask(app.task.id); await app.tick();
  assert.equal(app.database.getTask(app.task.id).executionControl.stopped, false);
  release(); await waitFor(() => instance.disposed); await app.tick();
  assert.equal(app.database.getTask(app.task.id).executionControl.stopped, true);
  assert.equal(app.calls.filter(row => row.operation === 'submit').length, 1);
});

test('archiving from the task owner persists both records before the official Worker releases its writer', async t => {
  const app = await fixture(t), instance = app.official.instances[0];
  await instance.step(); await app.tick();
  const archive = app.archive(), worker = archive.describeTask(app.task.id);
  let release; app.official.setStopBarrier(new Promise(resolve => { release = resolve; }));
  try {
    assert.equal(worker.sessionId, instance.agent.id);
    assert.deepEqual(await archive.archiveTask({ taskId: app.task.id, worker, requestId: 'archive-worker' }), { archived: true });
    assert.equal(app.database.getTask(app.task.id).archived, true);
    assert.equal(app.database.getTask(app.task.id).executionControl.stopped, false);
    assert.equal(app.official.services.workspaceRegistry.archivedSessionIds.includes(worker.sessionId), true);
    assert.equal(instance.disposed, undefined);
  } finally { release(); }
  await waitFor(() => instance.disposed); await app.tick();
  assert.equal(app.database.getTask(app.task.id).executionControl.stopped, true);
  assert.equal(app.calls.filter(row => row.operation === 'control' && row.control === 'cancel').length, 0);
});

test('the original task host catches up with a Worker archived while disconnected', async t => {
  const app = await fixture(t), instance = app.official.instances[0], registry = app.official.services.workspaceRegistry;
  await instance.step(); await app.tick();
  app.offline(true);
  const archive = app.archive();
  await assert.rejects(registry.archiveSession(instance.agent.id), { name: 'WorkspaceActiveSessionError' });
  assert.equal(app.database.getTask(app.task.id).archived, false);
  await registry.archiveSession(instance.agent.id, { stopActivity: true });
  await archive.tick();
  assert.equal(app.database.getTask(app.task.id).archived, false);
  app.offline(false);
  await app.archive().tick();
  assert.equal(app.database.getTask(app.task.id).archived, true);
  const receipt = app.database.getTask(app.task.id).cleanup;
  await app.archive().tick();
  assert.deepEqual(app.database.getTask(app.task.id).cleanup, receipt);
});

test('a delayed archive on an older requirement does not archive the revised task', async t => {
  const app = await fixture(t), instance = app.official.instances[0], registry = app.official.services.workspaceRegistry;
  await instance.step(); await app.tick();
  const oldWorker = app.archive().describeTask(app.task.id);
  await registry.archiveSession(instance.agent.id, { stopActivity: true });
  app.revise(2);
  const archive = app.archive();
  await archive.tick();
  assert.equal(app.database.getTask(app.task.id).archived, false);
  await assert.rejects(archive.archiveTask({ taskId: app.task.id, worker: oldWorker, requestId: 'old-worker' }), { code: 'CLEANUP_CONFLICT' });
});

test('replaying the same archive command after restore will not rearchive the Worker or task', async t => {
  const app = await fixture(t), instance = app.official.instances[0], registry = app.official.services.workspaceRegistry;
  await instance.step(); await app.tick();
  const archive = app.archive(), worker = archive.describeTask(app.task.id);
  const input = { taskId: app.task.id, worker, requestId: 'same-archive' };
  assert.deepEqual(await archive.archiveTask(input), { archived: true });
  await waitFor(() => instance.disposed); await app.tick();
  const previous = app.taskCleanup.cleanupHistory({ taskId: app.task.id })[0];
  const scope = { owner: 'desktop-owner', mode: 'global' }, ids = [app.task.id];
  const preview = app.taskCleanup.previewRestore({ scope, receiptId: previous.receiptId, ids });
  const confirmedBy = app.taskCleanup.createConfirmation({ previewId: preview.previewId, manifestHash: preview.manifestHash,
    ids, actorId: scope.owner, source: { sessionId: 'owner-session', callId: 'restore' } });
  app.taskCleanup.restoreCleanup({ previewId: preview.previewId, ids, confirmedBy, requestId: 'restore' });
  await registry.unarchiveSession(worker.sessionId);
  assert.deepEqual(await archive.archiveTask(input), { archived: false });
  assert.equal(registry.archivedSessionIds.includes(worker.sessionId), false);
  assert.deepEqual(await archive.archiveTask({ ...input, requestId: 'new-archive' }), { archived: true });
  assert.equal(registry.archivedSessionIds.includes(worker.sessionId), true);
  assert.notEqual(app.taskCleanup.cleanupHistory({ taskId: app.task.id })[0].receiptId, previous.receiptId);
});

for (const completedOffline of [false, true]) test(`offline stop and archive settles the local Task when the peer ${completedOffline ? 'completes offline' : 'is still running'}`, async t => {
  const app = await fixture(t);
  const instance = app.official.instances[0];
  await instance.step();
  await app.tick();
  app.offline(true);
  await app.tick();
  const cleanup = app.cleanup();
  const operation = cleanup.start({ ids: [app.task.id] }, {
    agent: { id: 'owner-session' },
    instruction: { message: { id: 'archive-offline', source: { kind: 'user' },
      content: [{ type: 'text', text: '停止并归档。' }] } },
  });
  await cleanup.tick();
  assert.equal(cleanup.pending({ operationId: operation.operationId }).items[0].status, 'completed');
  const archived = app.database.getTask(app.task.id);
  assert.equal(archived.archived, true);
  assert.equal(archived.executionControl.stopped, true);
  assert.equal(app.database.runs(app.assignment.id)[0].state, 'cancelled');
  const cancel = app.database.remoteControlCommand(app.assignment.id);
  assert.equal(cancel.state, 'pending');
  await app.tick();
  assert.equal(app.database.remoteControlCommand(app.assignment.id).state, 'pending');
  if (completedOffline) {
    await instance.finish();
    await waitFor(() => instance.disposed);
  }
  await app.restartOwner();
  app.offline(false);
  await app.tick();
  await waitFor(() => instance.disposed);
  const sent = app.calls.filter(row => row.operation === 'control' && row.control === 'cancel');
  assert.deepEqual(sent.map(row => row.requestId), [cancel.requestId, cancel.requestId]);
  assert.equal(app.database.remoteControlCommand(app.assignment.id).state, 'receipted');
  if (completedOffline) assert.equal(app.database.remoteControlCommand(app.assignment.id).receipt.code, 'EXECUTION_INACTIVE');
  assert.equal(app.database.getTask(app.task.id).archived, true);
  assert.equal(app.database.results(app.task.id).length, 0);
});

for (const first of ['revision', 'question']) test(`official ${first} first does not hold a pending revision behind an old question`, async t => {
  const app = await fixture(t), instance = app.official.instances[0];
  await instance.step();
  await app.tick();
  let rejected;
  if (first === 'question') {
    rejected = assert.rejects(instance.question(), { code: 'EXECUTION_QUESTION_SUPERSEDED' });
    await app.tick();
    assert.equal(app.database.attentions(app.task.id)[0].state, 'waiting');
  }
  app.revise(2);
  await app.tick();
  if (first === 'revision') rejected = assert.rejects(instance.question(), { code: 'EXECUTION_QUESTION_SUPERSEDED' });
  await rejected;
  await instance.step();
  await app.tick();
  assert.equal(app.database.getAssignment(app.assignment.id).instructionRevision, 2);
  assert(app.database.attentions(app.task.id).every(row => row.state === 'superseded'));
  await instance.finish();
  await waitFor(() => instance.disposed);
  await app.tick();
  assert.equal(app.database.getTask(app.task.id).status, 'completed');
});
