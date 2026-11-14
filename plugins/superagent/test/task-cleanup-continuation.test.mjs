import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantRuntimeStore } from '../src/runtime-store.mjs';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { createTaskManagement } from '../src/task-management.mjs';
import { createTaskCleanupContinuation } from '../src/task-cleanup-continuation.mjs';
import { recordDesktopTrigger } from '../src/desktop-trigger.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-cleanup-continuation-'));
  let orchestration = createAssistantOrchestrationStore({ directory });
  let database = createAssistantRuntimeStore({ directory });
  let taskManagement = createTaskManagement({ database, orchestration });
  const notices = [];
  let onUpdate = async update => { notices.push(update); };
  const makeWorker = () => createTaskCleanupContinuation({ database, orchestration, taskManagement,
    onUpdate: update => onUpdate(update) });
  let worker = makeWorker();
  const agent = { id: 'owner-router' };
  const instruction = { message: { id: 'stop-and-archive', source: { kind: 'user' },
    content: [{ type: 'text', text: '停止这几项任务，再从列表归档；保留成果和执行记录。' }] } };
  orchestration.createThread({ id: 'desktop:original-router', source: { type: 'desktop', id: 'original-router' } });
  t.after(async () => { database.close(); orchestration.close(); await rm(directory, { recursive: true, force: true }); });
  const task = (id, status = 'running') => {
    const created = orchestration.createTask({ id, threadId: 'desktop:original-router', target: `Complete ${id}`,
      mandate: { source: { channel: 'desktop', sessionId: 'original-router', threadId: 'main' } } });
    return status === 'running' ? created : orchestration.updateTask(id, { status });
  };
  const executor = taskId => {
    const queued = orchestration.createAssignment(taskId, { text: `Complete ${taskId}` });
    const [assignment] = orchestration.claimAssignments(`worker:${taskId}`, { assignmentId: queued.id, validateMandate: () => true });
    assert.ok(assignment);
    const run = orchestration.prepareRun(assignment.id, { owner: assignment.owner, fence: assignment.fence,
      sessionId: `session:${taskId}`, directory });
    return { assignment, run };
  };
  return { directory, agent, instruction, notices, task, executor,
    get orchestration() { return orchestration; },
    get database() { return database; }, get taskManagement() { return taskManagement; }, get worker() { return worker; },
    start: ids => worker.start({ ids }, { agent, threadId: 'main', instruction }),
    setOnUpdate: handler => { onUpdate = handler; },
    reopen() {
      database.close(); orchestration.close();
      orchestration = createAssistantOrchestrationStore({ directory });
      database = createAssistantRuntimeStore({ directory });
      taskManagement = createTaskManagement({ database, orchestration }); worker = makeWorker();
    } };
}

test('stop-and-archive admission records intent only and replays the original completed operation', async t => {
  const f = await fixture(t); const before = f.task('one');
  const admitted = f.start(['one']);
  assert.equal(admitted.items[0].status, 'pending');
  assert.deepEqual(f.orchestration.getTask('one'), before, 'admission cannot claim stop or archival completion');
  assert.equal(f.taskManagement.cleanupHistory({ taskId: 'one' }).length, 0);
  assert.equal(f.start(['one']).operationId, admitted.operationId);
  assert.equal(f.database.taskCleanupContinuations.list().items.length, 1);
  await f.worker.tick();
  assert.equal(f.orchestration.getTask('one').archived, true);
  const completed = f.worker.pending({ operationId: admitted.operationId }).items[0];
  assert.equal(completed.status, 'completed'); assert.ok(completed.receiptId);
  assert.equal(f.start(['one']).operationId, admitted.operationId, 'replay does not revalidate against its own archive write');
  f.reopen();
  await f.worker.tick();
  assert.equal(f.taskManagement.cleanupHistory({ taskId: 'one' }).length, 1);
  assert.equal(f.notices.length, 1);
  assert.equal(f.notices[0].items[0].receiptId, completed.receiptId);
  assert.equal(f.notices[0].items[0].source.messageId, f.instruction.message.id);
});

test('a claimed executor is archived only after its exact owner and fence confirm real exit', async t => {
  const f = await fixture(t); f.task('active');
  const { assignment, run } = f.executor('active');
  const admitted = f.start(['active']);
  await f.worker.tick();
  let task = f.orchestration.getTask('active');
  assert.equal(task.executionControl.stopRequested, true);
  assert.equal(task.executionExited, false); assert.equal(task.archived, false);
  assert.equal(f.worker.pending({ operationId: admitted.operationId }).items[0].status, 'pending');
  assert.equal(f.taskManagement.cleanupHistory({ taskId: 'active' }).length, 0);
  assert.equal(f.notices.length, 0);
  assert.throws(() => f.orchestration.confirmExecutionStopped(assignment.id, { owner: 'other-worker', fence: assignment.fence }), { code: 'FENCING_CONFLICT' });
  assert.throws(() => f.orchestration.confirmExecutionStopped(assignment.id, { owner: assignment.owner, fence: assignment.fence + 1 }), { code: 'FENCING_CONFLICT' });
  f.orchestration.confirmExecutionStopped(assignment.id, { owner: assignment.owner, fence: assignment.fence });
  await f.worker.tick();
  task = f.orchestration.getTask('active');
  assert.equal(task.executionExited, true); assert.equal(task.executionControl.stopped, true); assert.equal(task.archived, true);
  assert.equal(task.status, 'waiting', 'archival does not invent successful execution');
  assert.equal(f.orchestration.runs(assignment.id)[0].id, run.id);
  assert.equal(f.worker.pending({ operationId: admitted.operationId }).items[0].status, 'completed');
});

test('service and runtime-store reopen recover authorized pending archival without another human turn', async t => {
  const f = await fixture(t); f.task('active'); const { assignment } = f.executor('active');
  const admitted = f.start(['active']); await f.worker.tick();
  f.reopen();
  assert.equal(f.worker.pending({ operationId: admitted.operationId }).items[0].source.messageId, f.instruction.message.id);
  f.orchestration.confirmExecutionStopped(assignment.id, assignment);
  await f.worker.tick();
  const done = f.worker.pending({ operationId: admitted.operationId }).items[0];
  assert.equal(done.status, 'completed'); assert.equal(f.orchestration.getTask('active').archived, true);
  assert.equal(f.notices.length, 1);
});

test('explicit cancellation narrows the pending subset and never resumes already stopped work', async t => {
  const f = await fixture(t); f.task('one'); f.task('two');
  const first = f.executor('one'), second = f.executor('two');
  const admitted = f.start(['one', 'two']); await f.worker.tick();
  const cancelled = f.worker.cancel({ operationId: admitted.operationId, ids: ['one'] });
  assert.equal(cancelled.cancelledCount, 1);
  f.reopen();
  assert.equal(f.worker.cancel({ operationId: admitted.operationId, ids: ['one'] }).cancelledCount, 0,
    'an explicit cancellation remains terminal after both stores reopen');
  f.orchestration.confirmExecutionStopped(first.assignment.id, first.assignment);
  f.orchestration.confirmExecutionStopped(second.assignment.id, second.assignment);
  await f.worker.tick();
  assert.equal(f.orchestration.getTask('one').archived, false);
  assert.equal(f.orchestration.getTask('one').executionControl.stopped, true);
  assert.equal(f.orchestration.getTask('two').archived, true);
  assert.equal(f.worker.pending({ operationId: admitted.operationId, taskId: 'one' }).items[0].status, 'cancelled');
  assert.equal(f.taskManagement.cleanupHistory({ taskId: 'one' }).length, 0);
  assert.deepEqual(f.notices.flatMap(notice => notice.items.map(row => row.taskId)), ['two']);
});

test('changed requirements or presentation versions conflict without stopping the changed work', async t => {
  for (const change of [
    f => f.orchestration.updateTask('one', { target: 'A new explicit requirement' }),
    f => f.taskManagement.update({ kind: 'task', id: 'one', operation: 'rename', title: 'New name', version: 0 }),
  ]) {
    const f = await fixture(t); f.task('one'); const admitted = f.start(['one']); change(f);
    await f.worker.tick();
    const row = f.worker.pending({ operationId: admitted.operationId }).items[0];
    assert.equal(row.status, 'conflict'); assert.equal(row.code, 'CLEANUP_CONTINUATION_STALE');
    const task = f.orchestration.getTask('one');
    assert.equal(task.archived, false); assert.equal(task.executionControl.stopRequested, undefined);
    assert.equal(task.executionControl.stopped, undefined);
  }
});

test('new assignment or newly claimed fence invalidates the old cleanup without stopping that executor', async t => {
  for (const existingAssignment of [false, true]) {
    const f = await fixture(t); f.task('one');
    const queued = existingAssignment ? f.orchestration.createAssignment('one', { text: 'old queue' }) : null;
    const admitted = f.start(['one']);
    const active = queued || f.orchestration.createAssignment('one', { text: 'new work' });
    const [assignment] = f.orchestration.claimAssignments('new-worker', { assignmentId: active.id, validateMandate: () => true });
    f.orchestration.prepareRun(assignment.id, { ...assignment, sessionId: 'new-execution-session', directory: f.directory });
    await f.worker.tick();
    assert.equal(f.worker.pending({ operationId: admitted.operationId }).items[0].status, 'conflict');
    assert.equal(f.orchestration.getAssignment(assignment.id).state, 'claimed');
    assert.equal(f.orchestration.getTask('one').executionControl.stopRequested, undefined);
    assert.equal(f.orchestration.getTask('one').archived, false);
  }
});

test('a result committed after admission invalidates the old cleanup without hiding that result', async t => {
  const f = await fixture(t); f.task('one'); const { assignment, run } = f.executor('one');
  const admitted = f.start(['one']);
  f.orchestration.commitResult('one', { assignment, uniqueKey: 'new-result-after-cleanup-request',
    result: { runId: run.id, sessionId: run.sessionId, outcome: 'failed', summary: 'A newly retained result',
      completion: { kind: 'completed' } } });
  const before = f.orchestration.getTask('one');
  assert.equal(before.resultVersion, 1);
  await f.worker.tick();
  const row = f.worker.pending({ operationId: admitted.operationId }).items[0];
  assert.equal(row.status, 'conflict'); assert.equal(row.code, 'CLEANUP_CONTINUATION_STALE');
  assert.deepEqual(f.orchestration.getTask('one'), before);
  assert.equal(f.taskManagement.cleanupHistory({ taskId: 'one' }).length, 0);
});

test('a later human input invalidates the admitted execution identity without consuming that input', async t => {
  const f = await fixture(t); f.task('one'); f.executor('one'); const admitted = f.start(['one']);
  const { trigger } = recordDesktopTrigger(f.orchestration, { sessionId: f.agent.id,
    message: { id: 'later-supplement', source: { kind: 'user' }, content: [{ type: 'text', text: '还有新的补充。' }] } });
  const input = f.orchestration.recordTaskInput({ taskId: 'one', triggerId: trigger.id, kind: 'context',
    idempotencyKey: `later-context:${trigger.id}` });
  await f.worker.tick();
  const row = f.worker.pending({ operationId: admitted.operationId }).items[0];
  assert.equal(row.status, 'conflict'); assert.equal(row.code, 'CLEANUP_CONTINUATION_STALE');
  assert.equal(f.orchestration.getTask('one').executionControl.stopRequested, undefined);
  assert.equal(f.orchestration.getTask('one').archived, false);
  assert.deepEqual(f.orchestration.taskInputs('one'), [input]);
});

test('a crash after archive commit recovers its exact request receipt before finishing intent', async t => {
  const f = await fixture(t); f.task('one'); const admitted = f.start(['one']);
  f.database.taskCleanupContinuations.finish = () => { throw new Error('simulate crash after archive transaction'); };
  await assert.rejects(f.worker.tick(), /simulate crash/);
  assert.equal(f.orchestration.getTask('one').archived, true);
  const [receipt] = f.taskManagement.cleanupHistory({ taskId: 'one' });
  assert.ok(receipt); assert.equal(f.notices.length, 0);
  assert.equal(f.worker.pending({ operationId: admitted.operationId }).items[0].status, 'pending');
  f.reopen(); await f.worker.tick();
  const done = f.worker.pending({ operationId: admitted.operationId }).items[0];
  assert.equal(done.status, 'completed'); assert.equal(done.receiptId, receipt.receiptId);
  assert.deepEqual(f.taskManagement.cleanupHistory({ taskId: 'one' }), [receipt], 'recovery cannot create a second archive receipt');
  assert.equal(f.notices.length, 1);
});

test('notification failures retry a frozen batch before newer outcomes and never resend successful delivery', async t => {
  const f = await fixture(t); f.task('one'); f.task('two'); const { assignment } = f.executor('two');
  const admitted = f.start(['one', 'two']);
  const attempts = [];
  f.setOnUpdate(async notice => { attempts.push(structuredClone(notice));
    if (attempts.length === 1) throw new Error('Router inbox temporarily unavailable'); f.notices.push(notice); });
  await assert.rejects(f.worker.tick(), /temporarily unavailable/);
  assert.equal(f.worker.pending({ operationId: admitted.operationId, taskId: 'one' }).items[0].status, 'completed');
  assert.equal(f.worker.pending({ operationId: admitted.operationId, taskId: 'two' }).items[0].status, 'pending');
  assert.equal(f.worker.pending({ operationId: admitted.operationId, taskId: 'one' }).items[0].notifiedAt, undefined);
  f.reopen(); f.orchestration.confirmExecutionStopped(assignment.id, assignment);
  await f.worker.tick(); await f.worker.tick();
  assert.deepEqual(attempts.map(notice => notice.items.map(row => row.taskId).sort()), [['one'], ['one'], ['two']]);
  assert.deepEqual(attempts[1], attempts[0], 'retry identity and exact outcome list remain frozen after another Task finishes');
  assert.equal(f.notices.length, 2);
  assert.ok(f.worker.pending({ operationId: admitted.operationId }).items.every(row => row.notifiedAt));
  assert.equal(f.taskManagement.cleanupHistory({ taskId: 'one' }).length, 1);
  assert.equal(f.taskManagement.cleanupHistory({ taskId: 'two' }).length, 1);
});

test('unknown or internal source cannot admit an intent, and missing original evidence cannot stop work', async t => {
  const f = await fixture(t); f.task('one');
  for (const message of [
    { ...f.instruction.message, source: { kind: 'task-reply' } },
    { ...f.instruction.message, source: undefined },
    { ...f.instruction.message, content: [{ type: 'text', text: ' ' }] },
  ]) assert.throws(() => f.worker.start({ ids: ['one'] }, { agent: f.agent, instruction: { message } }), { code: 'MANAGEMENT_OWNER_REQUIRED' });
  assert.equal(f.database.taskCleanupContinuations.pending().length, 0);
  const prepared = f.database.taskCleanupContinuations.prepare({ requestId: 'unverified-input', triggerId: 'no-such-trigger',
    source: { sessionId: f.agent.id, threadId: 'main', messageId: 'not-in-history', excerpt: 'Stop and archive' },
    items: [{ id: 'one', instructionRevision: 1, resultVersion: 0, metaVersion: 0,
      executionStamp: f.orchestration.taskCleanupExecutionStamp('one') }] });
  await f.worker.tick();
  const row = f.worker.pending({ operationId: prepared.operationId }).items[0];
  assert.equal(row.status, 'conflict'); assert.equal(row.code, 'CLEANUP_CONTINUATION_SOURCE');
  assert.equal(f.orchestration.getTask('one').executionControl.stopped, undefined);
  assert.equal(f.orchestration.getTask('one').archived, false);
});

test('pending continuation source must exactly match its original session, thread and message', async t => {
  for (const changedSource of [{ sessionId: 'different-router' }, { threadId: 'different-thread' }, { messageId: 'different-message' }]) {
    const f = await fixture(t); f.task('one');
    const { trigger } = recordDesktopTrigger(f.orchestration, { sessionId: f.agent.id, message: f.instruction.message });
    const prepared = f.database.taskCleanupContinuations.prepare({ requestId: 'mismatched-human-origin', triggerId: trigger.id,
      source: { sessionId: f.agent.id, threadId: 'main', messageId: f.instruction.message.id,
        excerpt: '停止并归档', ...changedSource },
      items: [{ id: 'one', instructionRevision: 1, resultVersion: 0, metaVersion: 0,
        executionStamp: f.orchestration.taskCleanupExecutionStamp('one', { excludeTriggerId: trigger.id }) }] });
    await f.worker.tick();
    const row = f.worker.pending({ operationId: prepared.operationId }).items[0];
    assert.equal(row.status, 'conflict'); assert.equal(row.code, 'CLEANUP_CONTINUATION_SOURCE');
    assert.equal(f.orchestration.getTask('one').executionControl.stopped, undefined);
    assert.equal(f.orchestration.getTask('one').archived, false);
    assert.equal(f.taskManagement.cleanupHistory({ taskId: 'one' }).length, 0);
  }
});

test('an already applied context can refine to stop while retaining its original consumption evidence', async t => {
  const f = await fixture(t); f.task('one'); const { assignment, run } = f.executor('one');
  const { trigger } = recordDesktopTrigger(f.orchestration, { sessionId: f.agent.id, message: f.instruction.message });
  f.orchestration.recordTaskInput({ taskId: 'one', triggerId: trigger.id, kind: 'context', idempotencyKey: `source-context:${trigger.id}`,
    snapshot: { executionInput: { kind: 'context', reason: 'originally consumed as context' } } });
  f.orchestration.applyTaskInput(trigger.id, { assignmentId: assignment.id, owner: assignment.owner, fence: assignment.fence,
    runId: run.id, sessionId: run.sessionId, boundaryId: 'context-already-applied' });
  const before = f.orchestration.taskInputs('one')[0];
  assert.equal(before.kind, 'context'); assert.equal(before.state, 'applied');
  const admitted = f.start(['one']);
  await f.worker.tick();
  assert.equal(f.orchestration.getTask('one').executionControl.stopRequested, true);
  const [refined] = f.orchestration.taskInputs('one');
  assert.equal(refined.id, before.id); assert.equal(refined.triggerId, before.triggerId);
  assert.equal(refined.kind, 'stop'); assert.equal(refined.state, 'applied');
  assert.equal(refined.snapshot.contextReceipt.kind, before.kind);
  assert.equal(refined.snapshot.contextReceipt.state, before.state);
  assert.deepEqual(refined.snapshot.contextReceipt.snapshot, before.snapshot);
  assert.deepEqual(refined.snapshot.contextReceipt.application, before.application);
  assert.match(refined.snapshot.contextReceipt.fingerprint, /^[a-f0-9]{64}$/u);
  assert.equal(refined.application.kind, 'stop-request');
  f.orchestration.confirmExecutionStopped(assignment.id, assignment); await f.worker.tick();
  assert.equal(f.worker.pending({ operationId: admitted.operationId }).items[0].status, 'completed');
  assert.equal(f.orchestration.getTask('one').archived, true);
});
