import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAssistantStore } from '../src/store.mjs';
import { readAssessmentPolicy } from '../src/assessment-policy.mjs';
import { createOrchestrationRuntime } from '../src/orchestration-runtime.mjs';
import { executionEvidence } from '../src/execution-evidence.mjs';
import { createAssistantRuntimeStore } from '../src/runtime-store.mjs';
import { createTaskManagement } from '../src/task-management.mjs';
import { createTaskCleanupContinuation } from '../src/task-cleanup-continuation.mjs';

async function fixture(t, { send, execute, onDelivered, notifyTaskResult, maintainTasks, channel = 'desktop', ctx = {}, now, result: patch = {} } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-direct-delivery-'));
  const store = await createAssistantStore({ dataDirectory: directory });
  if (channel === 'feishu') store.connections.update({ enabled: true, appId: 'app', appSecretRef: 'env:SECRET', ownerOpenIds: ['owner'], chatIds: ['chat'] }, { revision: 0 });
  const policy = await readAssessmentPolicy(store);
  const source = channel === 'desktop' ? { channel, sessionId: 'owner-session', messageId: 'original', threadId: 'main' }
    : { channel, sourceType: 'direct', appId: 'app', chatId: 'chat', conversationId: 'chat', messageId: 'original' };
  const db = store.orchestration;
  db.createThread({ id: 'thread', source: { type: 'desktop', id: 'owner-session' } });
  const task = db.createTask({ threadId: 'thread', title: '测试交付', target: '给出纯文本成果', mandate: { source, actorId: channel === 'desktop' ? 'desktop-owner' : 'owner', ...(channel === 'desktop' ? { admission: 'desktop-approved-delegation' } : {}), policyVersion: channel === 'desktop' ? policy.desktopVersion : policy.version, controlledActions: 'require-current-policy-and-harness-approval' } });
  db.createAssignment(task.id, { id: 'work', executor: 'harness', model: { providerId: 'opaque provider', modelId: 'opaque/model' } });
  let executions = 0, sends = 0, notifications = 0;
  const original = '  完整原文\n\n纯文本不要求产物文件。\n';
  const deliver = async delivery => { sends++; return send ? send(delivery, db) : { status: 'accepted', messageId: 'durable-message' }; };
  const runtime = createOrchestrationRuntime({ ctx: { llm: { stream() { throw new Error('No content review model may be called'); } }, ...ctx }, store, onDelivered, maintainTasks, ...(now ? { now } : {}),
    notifyTaskResult: async notice => { notifications++; return notifyTaskResult ? notifyTaskResult(notice, db, store) : { status: 'accepted', messageId: 'router-inbox' }; },
    execute: async (assignment, context) => { executions++; return execute ? execute(assignment, context, db) : { summary: original, completion: { kind: 'completed' }, evidenceRefs: [], ...patch }; },
    deliverDesktop: deliver,
    ...(channel === 'feishu' ? { feishu: { send: async input => deliver({ payload: input, taskId: task.id }) } } : {}),
  });
  t.after(async () => { await runtime.stop(); await store.close(); await rm(directory, { recursive: true, force: true }); });
  const advance = async () => { for (let i = 0; i < 30; i++) { await runtime.tick(); await new Promise(resolve => setTimeout(resolve, 2)); if (notifications || sends || db.getAssignment('work').state === 'uncertain') break; } };
  return { runtime, db, store, task, source, original, advance, notifications: () => notifications, counts: () => ({ executions, sends }) };
}

test('execution evidence remains readable before a Task has an Assignment', async t => {
  const app = await fixture(t);
  const task = app.db.createTask({ threadId: 'thread', title: '等待安排', target: '尚未开始执行', mandate: app.task.mandate });
  const evidence = app.runtime.executionFacts.evidence({ taskId: task.id });
  assert.equal(evidence.runtime.assignment, null);
  assert.equal(evidence.runtime.run, null);
  assert.equal(evidence.runtime.stop.confirmedAt, null);
  assert.equal(app.runtime.executionFacts.evidenceSnapshot().executions.find(row => row.task.id === task.id).stop.confirmedAt, null);
});

test('authorized stop-and-archive maintenance runs before queued work can be claimed', async t => {
  let cleanup;
  const app = await fixture(t, { maintainTasks: () => cleanup.tick() });
  const database = createAssistantRuntimeStore({ filename: app.store.paths.database });
  try {
    const taskManagement = createTaskManagement({ database, orchestration: app.db });
    cleanup = createTaskCleanupContinuation({ database, orchestration: app.db, taskManagement });
    const admitted = cleanup.start({ ids: [app.task.id] }, { agent: { id: 'controller-session' }, instruction: {
      message: { id: 'stop-before-claim', source: { kind: 'user' }, content: [{ type: 'text', text: '停止并归档这项任务。' }] } } });
    await app.runtime.tick();
    assert.equal(app.db.getAssignment('work').state, 'cancelled');
    assert.equal(app.db.getAssignment('work').fence, 0);
    assert.equal(app.counts().executions, 0);
    assert.equal(app.db.getTask(app.task.id).archived, true);
    assert.equal(cleanup.pending({ operationId: admitted.operationId }).items[0].status, 'completed');
  } finally { database.close(); }
});

test('missing Worker configuration is a concrete scheduling blocker that clears after configuration returns', async t => {
  const app = await fixture(t);
  const task = app.db.createTask({ threadId: 'thread', target: '等待配置恢复后执行', mandate: app.task.mandate });
  const getConfig = app.store.getConfig, config = await getConfig();
  let models = [];
  app.store.getConfig = async () => ({ ...config, models: [], workerModels: models });
  await app.runtime.tick();
  assert.equal(app.db.getTask(task.id).status, 'waiting');
  assert.equal(app.db.getTask(task.id).continuationWait.code, 'WORKER_MODEL_ROUTE');
  assert.match(app.db.getTask(task.id).continuationWait.reason, /模型设置/);
  assert.equal(app.db.assignments(task.id).length, 0);
  models = [{ providerId: 'exact-provider', modelId: 'opaque/exact-model' }];
  await app.runtime.tick();
  assert.notEqual(app.db.getTask(task.id).status, 'waiting');
  assert.equal(app.db.getTask(task.id).continuationWait, null);
  assert.equal(app.db.assignments(task.id).length, 1);
  app.store.getConfig = getConfig;
});

test('scheduler heartbeat advances only after a real successful control cycle, never on reads or failed/hung cycles', async t => {
  let clock = Date.now();
  const app = await fixture(t, { now: () => clock });
  // Pending scheduling requires policy. An idle cycle no longer reads policy.
  app.db.createTask({ threadId: 'thread', target: '待模型配置恢复', mandate: app.task.mandate });
  const snapshot = () => app.runtime.executionFacts.evidenceSnapshot();
  assert.equal(snapshot().schedulerHeartbeat, null);
  await app.runtime.tick();
  const first = snapshot().schedulerHeartbeat;
  assert.deepEqual(first, { at: new Date(clock).toISOString(), bootId: snapshot().bootId });
  clock += 180000;
  first.at = 'mutated caller copy';
  assert.equal(snapshot().schedulerHeartbeat.at, new Date(clock - 180000).toISOString());

  const getConfig = app.store.getConfig;
  let release;
  const config = await getConfig();
  app.store.getConfig = () => new Promise(resolve => { release = () => resolve(config); });
  const pending = app.runtime.tick();
  await Promise.resolve();
  assert.equal(snapshot().schedulerHeartbeat.at, new Date(clock - 180000).toISOString());
  release(); await pending;
  assert.equal(snapshot().schedulerHeartbeat.at, new Date(clock).toISOString());

  clock += 180000;
  app.store.getConfig = async () => { throw new Error('policy unavailable'); };
  try {
    await app.runtime.tick();
    assert.equal(snapshot().schedulerHeartbeat.at, new Date(clock - 180000).toISOString());
  } finally { app.store.getConfig = getConfig; }
});

test('idle cycles avoid configuration reads and completed Task scans, then wake for new work', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-idle-runtime-'));
  const store = await createAssistantStore({ dataDirectory: directory });
  let reads = 0, scans = 0;
  const getConfig = store.getConfig.bind(store), listTasks = store.orchestration.listTasks.bind(store.orchestration);
  store.getConfig = (...args) => { reads++; return getConfig(...args); };
  store.orchestration.listTasks = (...args) => { scans++; return listTasks(...args); };
  const runtime = createOrchestrationRuntime({ ctx: {}, store, execute: async () => ({ summary: 'done' }) });
  t.after(async () => { await runtime.stop(); await store.close(); await rm(directory, { recursive: true, force: true }); });
  for (let i = 0; i < 3; i++) await runtime.tick();
  assert.equal(reads, 0);
  assert.equal(scans, 0);
  assert.equal(runtime.executionFacts.snapshot().publicChatNotifications, true);
  const scansBeforeWake = scans;
  store.orchestration.createThread({ id: 'thread', source: { type: 'desktop', id: 'owner' } });
  store.orchestration.createTask({ threadId: 'thread', target: '新任务', mandate: {} });
  await runtime.tick();
  assert.equal(reads, 1);
  assert.equal(scans, scansBeforeWake, 'new work does not scan completed Tasks');
});

test('saved result enters the Router inbox without a desktop result outbox or transport send', async t => {
  const app = await fixture(t, { notifyTaskResult(notice, db) {
    assert.equal(db.getTask(notice.taskId).status, 'completed');
    assert.equal(notice.payload.publication, undefined);
    assert.equal(notice.payload.text, undefined);
    assert.deepEqual(notice.payload.source, app.source);
    return { status: 'accepted', messageId: 'inbox-message' };
  } });
  await app.advance();
  assert.equal(app.notifications(), 1);
  assert.deepEqual(app.db.deliveries(app.task.id), []);
  assert.equal(app.db.results(app.task.id)[0].notification.state, 'notified');
  assert.equal(app.db.results(app.task.id)[0].reply, undefined, 'inbox acceptance is not public delivery');
  assert.deepEqual(app.counts(), { executions: 1, sends: 0 });
});

test('inbox persistence failures retry the same saved result and never rerun Worker', async t => {
  let clock;
  const app = await fixture(t, { now: () => clock ?? Date.now(), notifyTaskResult() {
    clock ??= Date.now(); throw Object.assign(new Error('PRIVATE PROVIDER CONTENT'), { code: 'INBOX_UNAVAILABLE' });
  } });
  await app.advance();
  const result = app.db.results(app.task.id)[0];
  assert.equal(result.notification.state, 'pending');
  assert.equal(result.notification.nextAt, clock + 30000);
  clock = result.notification.nextAt - 1; await app.runtime.tick();
  assert.equal(app.notifications(), 1);
  clock++; await app.runtime.tick();
  assert.equal(app.notifications(), 2);
  assert.equal(app.db.results(app.task.id).length, 1);
  assert.deepEqual(app.counts(), { executions: 1, sends: 0 });
});

test('state changes enqueue natural Router expression without a fixed desktop fallback', async t => {
  const app = await fixture(t, { execute() { throw Object.assign(new Error('configuration unavailable'), { code: 'ROLE_PRESET_UNAVAILABLE' }); } });
  await app.advance(); await app.runtime.tick();
  const delivery = app.db.deliveries(app.task.id)[0];
  assert.equal(delivery.state, 'sent');
  assert.equal(delivery.receipt.status, 'enqueued');
  assert.equal(app.db.getTask(app.task.id).status, 'waiting');
  assert.deepEqual(app.counts(), { executions: 1, sends: 0 });
});

test('external-source completion also enters its original Router inbox without using task outbox transport', async t => {
  const app = await fixture(t, { channel: 'feishu' });
  await app.advance();
  assert.equal(app.notifications(), 1);
  assert.deepEqual(app.db.deliveries(app.task.id), []);
  assert.deepEqual(app.counts(), { executions: 1, sends: 0 });
});

test('normal Worker completion retains effect diagnostics without blocking completion or rerunning', async t => {
  const app = await fixture(t, { result: { executionEffects: { effectsVerified: false, unknownCallIds: ['send'] } } });
  await app.advance(); await app.advance();
  assert.equal(app.db.getTask(app.task.id).status, 'completed');
  assert.equal(app.db.results(app.task.id).length, 1);
  assert.equal(app.db.results(app.task.id)[0].executionEffects.effectsVerified, false);
  assert.equal(app.counts().executions, 1);
});

test('recovery coordination cannot rerun unknown external effects or invent structural failure evidence', async t => {
  const app = await fixture(t, { execute(assignment, _context, db) {
    const identity = { owner: assignment.owner, fence: assignment.fence };
    const run = db.prepareRun(assignment.id, { ...identity, sessionId: 'unknown-effects', directory: 'directory' });
    db.updateRun(run.id, { ...identity, state: 'submitted' });
    throw Object.assign(new Error('source receipt unavailable'), { code: 'EXECUTION_EFFECTS_UNKNOWN',
      executionEffects: { effectsVerified: false, unknownCallIds: ['external-send'] } });
  } });
  await app.advance();
  const task = app.db.getTask(app.task.id), assignment = app.db.getAssignment('work');
  const input = { taskId: task.id, assignmentId: assignment.id, fence: assignment.fence, instructionRevision: task.instructionRevision };
  const state = app.runtime.state({ taskId: task.id })[0];
  assert.equal(state.execution.uncertainty.reasonCode, 'session-interrupted');
  assert.equal(state.execution.instructionRevision, task.instructionRevision);
  await assert.rejects(app.runtime.manageExecution({ ...input, operation: 'wait' }), /Only explicit/);
  await assert.rejects(app.runtime.manageExecution({ ...input, operation: 'resume' }));
  await assert.rejects(app.runtime.manageExecution({ ...input, operation: 'fail' }), /Only explicit/);
  await app.runtime.tick(); assert.equal(app.counts().executions, 1);
  assert.equal(app.db.results(task.id).length, 0);
  await assert.rejects(app.runtime.manageExecution({ ...input, instructionRevision: input.instructionRevision + 1, operation: 'check-now' }), /授权或要求已变化/);
  assert.equal((await app.runtime.manageExecution({ ...input, fence: assignment.fence + 1, operation: 'check-now' })).status, 'blocked');
});

test('explicit continuation checks the recovered official ending before reporting completion', async t => {
  for (const ending of ['completed', 'disposed', 'user']) await t.test(ending, async t => {
    const reason = ending === 'completed' ? { kind: 'completed' } : { kind: 'aborted', reason: { kind: ending } };
    const events = [
      { seq: 0, type: 'turn/start', data: { turn: 1 } },
      { seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Saved progress' }] } } },
      { seq: 2, type: 'turn/end', data: { turn: 1, reason } },
    ];
    const ctx = { agents: { get: () => undefined, resume() {} }, sessionPersistence: {
      open: async id => ({ id, access: 'write', read: async () => ({ events }), close: async () => {} }),
    } };
    const app = await fixture(t, { ctx, execute() { assert.fail('inspecting a continuation must not dispatch another execution'); } });
    const [assignment] = app.db.claimAssignments('old-worker', { validateMandate: () => true });
    const ownership = { owner: assignment.owner, fence: assignment.fence };
    const run = app.db.prepareRun(assignment.id, { ...ownership, sessionId: 'legacy-ending', directory: 'fixture' });
    app.db.freezeWorkerModelRoute({ assignmentId: assignment.id, runId: run.id, ...ownership,
      models: [{ providerId: 'ExactProvider', modelId: 'Exact/Original' }], index: 0 });
    app.db.updateRun(run.id, { ...ownership, state: 'submitted' });
    app.db.updateRun(run.id, { ...ownership, state: 'verifying', evidence: {
      ...executionEvidence({ events: events.slice(0, 2) }), runId: run.id, sessionId: run.sessionId, directory: run.directory,
    } });
    app.db.renewAssignment(assignment.id, { ...ownership, validateMandate: () => false });
    // Keep this test at the admission boundary; the executor has its own
    // original-session continuation coverage.
    app.db.claimAssignments = () => [];
    const input = { taskId: app.task.id, assignmentId: assignment.id, fence: assignment.fence, instructionRevision: 1, operation: 'resume' };
    if (ending === 'user') {
      await assert.rejects(app.runtime.manageExecution(input), { code: 'EXECUTION_PAUSE_UNVERIFIED' });
      assert.equal(app.db.getAssignment(assignment.id).state, 'uncertain');
    } else {
      const receipt = await app.runtime.manageExecution(input);
      if (ending === 'completed') {
        assert.equal(receipt.status, 'completed');
        assert.equal(app.db.getTask(app.task.id).status, 'completed');
      } else {
        assert.equal(receipt.state, 'queued');
        assert.equal(receipt.status, undefined);
        assert.equal(app.db.getAssignment(assignment.id).state, 'queued');
        assert.equal(app.db.getTask(app.task.id).continuationWait, null);
        assert.equal(app.db.runs(assignment.id)[0].id, run.id);
      }
    }
    assert.equal(app.db.results(app.task.id).at(-1).completion.kind, reason.kind);
    assert.equal(app.counts().executions, 0);
  });
});

test('ordinary setup failure stops with its cause instead of fabricating unresolved external effects', async t => {
  const app = await fixture(t, { execute() { throw Object.assign(new Error('required execution configuration unavailable'), { code: 'ROLE_PRESET_UNAVAILABLE' }); } });
  await app.advance();
  const assignment = app.db.getAssignment('work'), task = app.db.getTask(app.task.id);
  assert.equal(assignment.state, 'failed');
  assert.equal(assignment.firstFailure.message, 'required execution configuration unavailable');
  assert.equal(assignment.firstFailure.effects.effectsVerified, true);
  assert.equal(task.continuationWait.code, 'EXECUTION_FAILED');
  assert.equal(task.continuationWait.reason, assignment.firstFailure.message);
  const state = app.runtime.state({ taskId: task.id })[0];
  assert.equal(state.execution?.uncertainty ?? null, null);
  await app.advance();
  assert.equal(app.counts().executions, 1);
});

test('saved normal completion is accepted automatically without a Worker replay or repeated inspection', async t => {
  const events = [{ seq: 0, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Saved final result including a rejected write' }] } } },
    { seq: 1, type: 'turn/end', data: { reason: { kind: 'completed' } } }];
  let reads = 0;
  const ctx = { agents: { get: () => undefined }, sessionPersistence: { open: async id => ({ id, access: 'write', read: async () => { reads++; return { events }; }, close: async () => {} }) } };
  const app = await fixture(t, { ctx, execute() { assert.fail('completed Worker must not replay'); } });
  const [assignment] = app.db.claimAssignments('old-worker', { validateMandate: () => true });
  const run = app.db.prepareRun(assignment.id, { owner: assignment.owner, fence: assignment.fence, sessionId: 'saved-session', directory: 'fixture' });
  const ownership = { owner: assignment.owner, fence: assignment.fence };
  app.db.updateRun(run.id, { ...ownership, state: 'submitted' });
  const result = { ...executionEvidence({ events }), runId: run.id, sessionId: run.sessionId, directory: run.directory,
    executionEffects: { effectsVerified: false, unknownCallIds: ['legacy-denied-write'] } };
  app.db.updateRun(run.id, { ...ownership, state: 'verifying', evidence: result });
  app.db.renewAssignment(assignment.id, { ...ownership, validateMandate: () => false });
  assert.equal(app.db.getTask(app.task.id).status, 'running');
  await app.runtime.tick();
  assert.equal(app.db.getTask(app.task.id).status, 'completed');
  assert.equal(app.db.getTask(app.task.id).resultVersion, 1);
  for (let i = 0; i < 3; i++) await app.runtime.tick();
  assert.equal(reads, 1);
  assert.equal(app.counts().executions, 0);
});

const recoveryEvents = [{ seq: 0, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '真实完成的结果' }] } } },
  { seq: 1, type: 'turn/end', data: { reason: { kind: 'completed' } } }];
function saveExecution(db, assignment) {
  const ownership = { owner: assignment.owner, fence: assignment.fence };
  const run = db.prepareRun(assignment.id, { ...ownership, sessionId: 'recoverable-session', directory: 'fixture' });
  db.updateRun(run.id, { ...ownership, state: 'submitted' });
  const result = { ...executionEvidence({ events: recoveryEvents }), runId: run.id, sessionId: run.sessionId, directory: run.directory };
  db.updateRun(run.id, { ...ownership, state: 'verifying', evidence: result });
  return result;
}
function recoveryContext(read = () => ({ events: recoveryEvents })) {
  return { agents: { get: () => undefined }, sessionPersistence: { open: async id => ({ id, access: 'write', read, close: async () => {} }) } };
}
test('results saved during this process recover after commit or executor cleanup failure', async t => {
  for (const stage of ['commit', 'cleanup']) await t.test(stage, async t => {
    const app = await fixture(t, { ctx: recoveryContext(), execute(assignment, _context, db) {
      const result = saveExecution(db, assignment);
      if (stage === 'cleanup') throw new Error('executor cleanup unavailable');
      return result;
    } });
    const commit = app.db.commitResult;
    if (stage === 'commit') app.db.commitResult = () => { throw new Error('local result storage unavailable'); };
    await app.advance();
    app.db.commitResult = commit;
    assert.equal(app.db.getAssignment('work').state, 'uncertain');
    assert.equal(app.db.getTask(app.task.id).status, 'running');
    await app.runtime.tick();
    assert.equal(app.db.getTask(app.task.id).status, 'completed');
    assert.equal(app.db.results(app.task.id).length, stage === 'commit' ? 2 : 1, 'retain the provisional draft and its later known completion');
    assert.equal(app.db.results(app.task.id).at(-1).summary, '真实完成的结果');
    assert.equal(app.db.getAssignment('work').attempts, 1);
    assert.equal(app.counts().executions, 1);
  });
});

test('storage recovery retains raw drafts and retries without a permanent attempt cutoff', async t => {
  let clock = Date.now(), reads = 0, available = false;
  const app = await fixture(t, { now: () => clock, ctx: recoveryContext(() => { reads++; if (!available) throw new Error('PRIVATE STORAGE CONTENT'); return { events: recoveryEvents }; }) });
  const [assignment] = app.db.claimAssignments('old-worker', { validateMandate: () => true });
  saveExecution(app.db, assignment);
  app.db.renewAssignment(assignment.id, { owner: assignment.owner, fence: assignment.fence, validateMandate: () => false });
  for (let attempt = 1; attempt <= 5; attempt++) {
    await app.runtime.tick();
    const recovery = app.db.getAssignment('work').savedResultRecovery;
    assert.equal(recovery.attempts, attempt);
    assert.equal(recovery.state, 'retrying');
    assert.equal(app.db.getTask(app.task.id).status, 'running');
    assert.equal(app.db.results(app.task.id)[0].summary, recoveryEvents[0].data.message.content[0].text);
    await app.runtime.tick(); assert.equal(reads, attempt);
    clock = recovery.nextAttemptAt + 1;
  }
  available = true; await app.runtime.tick();
  assert.equal(app.db.getTask(app.task.id).status, 'completed');
  assert.equal(app.counts().executions, 0);
  assert.doesNotMatch(JSON.stringify(app.runtime.state()), /PRIVATE STORAGE CONTENT/);
});

test('official end seeds and changed evidence never reject an already produced normal result', async t => {
  const app = await fixture(t, { ctx: recoveryContext(() => ({ events: [...recoveryEvents, { seq: 2, type: 'session/end-seed' }] })) });
  const [assignment] = app.db.claimAssignments('old-worker', { validateMandate: () => true });
  saveExecution(app.db, assignment);
  app.db.renewAssignment(assignment.id, { owner: assignment.owner, fence: assignment.fence, validateMandate: () => false });
  await app.runtime.tick();
  assert.equal(app.db.getTask(app.task.id).status, 'completed');
  assert.deepEqual(app.db.results(app.task.id)[0].recoveryObservation.diagnostics, ['TRANSCRIPT_CHANGED']);
  assert.equal(app.counts().executions, 0);
});

test('saving an interrupted draft cannot turn a new unfinished turn into success', async t => {
  const app = await fixture(t, { ctx: recoveryContext(() => ({ events: [...recoveryEvents, { seq: 2, type: 'user/message' }] })) });
  const [assignment] = app.db.claimAssignments('old-worker', { validateMandate: () => true });
  saveExecution(app.db, assignment);
  app.db.renewAssignment(assignment.id, { owner: assignment.owner, fence: assignment.fence, validateMandate: () => false });
  await app.runtime.tick();
  assert.equal(app.db.getTask(app.task.id).status, 'waiting');
  assert.equal(app.db.results(app.task.id).length, 1);
  assert.equal(app.counts().executions, 0);
});

test('pause and stop retain existing drafts without inventing a successful task', async t => {
  for (const control of ['pauseTask', 'cancelTask']) await t.test(control, async t => {
    let reads = 0;
    const app = await fixture(t, { ctx: recoveryContext(() => { reads++; return { events: recoveryEvents }; }) });
    const [assignment] = app.db.claimAssignments('old-worker', { validateMandate: () => true });
    saveExecution(app.db, assignment);
    app.db.renewAssignment(assignment.id, { owner: assignment.owner, fence: assignment.fence, validateMandate: () => false });
    app.db[control](app.task.id);
    await app.runtime.tick();
    assert.equal(reads, 1);
    assert.equal(app.db.results(app.task.id).length, 1);
    assert.equal(app.db.getTask(app.task.id).status, 'waiting');
  });
});
