import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { createDesktopTaskControl } from '../src/desktop-task-control.mjs';
import { recordDesktopTrigger } from '../src/desktop-trigger.mjs';
import { desktopTaskManagementScope } from '../src/desktop-task-management-authority.mjs';
import { createDesktopTaskAccess } from '../src/desktop-task-access.mjs';

function fixture(t) {
  const database = createAssistantOrchestrationStore({ filename: ':memory:' });
  t.after(() => database.close());
  const events = [{ type: 'turn/start' }, { type: 'user/message', data: { id: 'followup', source: { kind: 'user' }, content: [{ type: 'text', text: '补充：请附上原文链接' }] } }];
  const ownerAgent = { id: 'owner', status: 'running', session: { header: {}, snapshotEvents: () => events } };
  const ctx = { agents: { get: () => ownerAgent, currentInitiator: () => ownerAgent, turnBoundaryOf: () => ({ openTurnStartSeq: 0 }) } };
  const initial = recordDesktopTrigger(database, { sessionId: 'owner', message: { id: 'initial', source: { kind: 'user' }, content: [{ type: 'text', text: '调查网站' }] } }).trigger;
  function task(source = { channel: 'desktop', sessionId: 'owner', threadId: 'main' }) {
    const row = database.createTask({ threadId: initial.threadId, target: '调查网站', mandate: { source, actorId: 'desktop-owner' } });
    database.subscribe(row.id, initial.threadId, { cursorTriggerId: initial.id });
    return row;
  }
  const service = createDesktopTaskControl({ ctx, database });
  return { database, events, ctx, ownerAgent, task, control: (id, operation = 'supplement', options = {}) => service.control({ id, operation }, { agent: ownerAgent }, { ownerAgent, ...options }) };
}

test('supplement selects one task, retains original text and mandate, and deduplicates', t => {
  const f = fixture(t), a = f.task(), b = f.task();
  const result = f.control(a.id);
  assert.equal(result.taskId, a.id);
  assert.equal(f.control(a.id).duplicate, true);
  assert.equal(f.database.pendingSubscriptionMessages(a.id).length, 1);
  assert.equal(f.database.pendingSubscriptionMessages(a.id)[0].content, '补充：请附上原文链接');
  assert.equal(f.database.taskInputs(a.id).length, 1);
  assert.equal(f.database.taskInputs(a.id)[0].state, 'pending');
  assert.equal(f.database.pendingSubscriptionMessages(b.id).length, 0);
  assert.deepEqual(f.database.getTask(a.id).mandate, a.mandate);
  assert.throws(() => f.control(b.id), /already belongs/);
});

test('after model session clear a trusted logical owner can supplement the old task without changing its mandate', t => {
  const f = fixture(t), task = f.task(); f.ownerAgent.id = 'replacement';
  const result = f.control(task.id, 'supplement', { ownerScope: { threadId: 'main', sessionIds: ['owner', 'replacement'] } });
  assert.equal(result.taskId, task.id);
  assert.equal(f.database.pendingSubscriptionMessages(task.id)[0].source.sessionId, 'replacement');
  assert.deepEqual(f.database.getTask(task.id).mandate, task.mandate);
  assert.equal(f.database.getTask(task.id).threadId, 'desktop:owner');
});

test('a chat Attention answer uses the exact current human text on the original task, including after clear', t => {
  const f = fixture(t), task = f.task();
  f.database.createAssignment(task.id, {});
  const [assignment] = f.database.claimAssignments('worker', { validateMandate: () => true });
  const ownership = { owner: assignment.owner, fence: assignment.fence };
  const run = f.database.prepareRun(assignment.id, { ...ownership, sessionId: 'worker-session', directory: process.cwd() });
  f.database.updateRun(run.id, { ...ownership, state: 'submitted' });
  const [attention] = f.database.openAttention(assignment.id, { ...ownership, sessionId: run.sessionId, callId: 'ask', questions: [{ id: 'timezone', question: '采用什么时区？' }] });
  const service = createDesktopTaskControl({ ctx: f.ctx, database: f.database });
  const request = { id: task.id, operation: 'answer', attentionId: attention.id };
  f.ownerAgent.id = 'replacement'; f.events[1].data.content[0].text = '  使用北京时间\n保留原文  ';
  const options = { ownerAgent: f.ownerAgent, ownerScope: { threadId: 'main', sessionIds: ['owner', 'replacement'] } };
  assert.throws(() => service.control({ ...request, attentionId: undefined }, { agent: f.ownerAgent }, options), /明确选择/);
  assert.throws(() => service.control(request, { agent: f.ownerAgent }, { ...options, threadId: 'side' }), /当前会话/);
  const result = service.control(request, { agent: f.ownerAgent }, options);
  const answer = f.database.getTrigger(result.attention.answerTriggerId);
  assert.equal(answer.content, '  使用北京时间\n保留原文  ');
  assert.deepEqual(answer.source.answer, { selected: [], custom: answer.content });
  assert.equal(result.taskId, task.id); assert.equal(f.database.getTask(task.id).instructionRevision, 1);
  assert.equal(service.control(request, { agent: f.ownerAgent }, options).attention.duplicate, true);
});

test('a supplement cannot implicitly answer an Attention even when it contains an attention id', t => {
  const f = fixture(t), task = f.task(); let answers = 0;
  const actual = f.database.answerDesktopAttention; f.database.answerDesktopAttention = () => { answers++; };
  const service = createDesktopTaskControl({ ctx: f.ctx, database: f.database });
  service.control({ id: task.id, operation: 'supplement', attentionId: 'question' }, { agent: f.ownerAgent }, { ownerAgent: f.ownerAgent });
  assert.equal(answers, 0); f.database.answerDesktopAttention = actual;
});

test('control rejects different sessions, channels and threads', t => {
  const f = fixture(t);
  for (const source of [{ channel: 'feishu', sessionId: 'owner' }, { channel: 'desktop', sessionId: 'another' }, { channel: 'desktop', sessionId: 'owner', threadId: 'side' }]) {
    const task = f.task(source);
    assert.throws(() => f.control(task.id, 'cancel'), /不属于当前会话/);
    assert.notEqual(f.database.getTask(task.id).executionControl?.stopped, true);
  }
});

for (const threadId of ['main', 'side']) test(`trusted local ${threadId} manages channel and other desktop tasks without changing their mandates`, async t => {
  const f = fixture(t);
  const state = { mainSessionId: 'owner', threads: [{ id: 'side', sessionId: 'owner' }] };
  const managementScope = await desktopTaskManagementScope({ ctx: f.ctx, store: { getState: async () => state }, agent: f.ownerAgent, threadId });
  assert.ok(managementScope);
  const foreign = [{ channel: 'desktop', sessionId: 'another', threadId: 'other-side' }, { channel: 'feishu', sourceType: 'group', conversationId: 'group' }];
  const access = createDesktopTaskAccess(f.database);
  for (const [index, source] of foreign.entries()) {
    const row = f.task(source);
    f.events[1].data.id = `manage-${index}`;
    const args = { threadId, managementScope };
    assert.equal(access.read(row.id, managementScope).id, row.id);
    assert.ok(access.query(managementScope).tasks.some(item => item.id === row.id));
    assert.throws(() => f.control(row.id, 'supplement', args), /不属于当前会话/);
    const paused = f.control(row.id, 'pause', args);
    assert.equal(paused.task.executionControl.paused, true);
    const resumed = f.control(row.id, 'resume', args);
    assert.deepEqual(resumed.task.executionControl, {});
    f.events[1].data.id = `cancel-${index}`;
    assert.equal(f.control(row.id, 'cancel', args).task.executionControl.stopped, true);
    assert.deepEqual(f.database.getTask(row.id).mandate, row.mandate);
    assert.throws(() => f.control(row.id, 'resume', args), { code: 'TASK_STOPPED' });
  }
});

test('model-shaped global scope cannot bypass task ownership', t => {
  const f = fixture(t), row = f.task({ channel: 'feishu', sourceType: 'group', conversationId: 'group' });
  const managementScope = { owner: 'desktop-owner', mode: 'global' };
  assert.throws(() => f.control(row.id, 'cancel', { managementScope }), /不属于当前会话/);
  assert.throws(() => createDesktopTaskAccess(f.database).read(row.id, managementScope), /无效任务归属范围/);
});

for (const operation of ['pause', 'cancel']) test(`one explicit owner message can ${operation} multiple selected tasks without input collisions`, async t => {
  const f = fixture(t), a = f.task(), b = f.task({ channel: 'feishu', sourceType: 'group', conversationId: 'group' });
  const managementScope = await desktopTaskManagementScope({ ctx: f.ctx, store: { getState: async () => ({ mainSessionId: f.ownerAgent.id }) }, agent: f.ownerAgent });
  const options = { managementScope };
  for (const row of [a, b]) {
    const first = f.control(row.id, operation, options);
    const second = f.control(row.id, operation, options);
    assert.equal(first.triggerId, second.triggerId);
    assert.equal(f.database.taskInputs(row.id).length, 1);
    const input = f.database.taskInputs(row.id)[0];
    assert.equal(input.state, 'applied');
    assert.equal(input.source.messageId, 'followup');
    assert.equal(input.actor.id, 'desktop-owner');
  }
});

for (const operation of ['pause', 'cancel']) test(`conversation-scoped ${operation} handles multiple selected tasks and retries without global capability`, t => {
  const f = fixture(t), tasks = [f.task(), f.task()];
  for (const row of tasks) {
    const first = f.control(row.id, operation);
    const again = f.control(row.id, operation);
    assert.equal(first.triggerId, again.triggerId);
    const [input] = f.database.taskInputs(row.id);
    assert.equal(f.database.taskInputs(row.id).length, 1);
    assert.equal(input.state, 'applied');
    assert.equal(input.idempotencyKey, `trigger:${first.triggerId}:task:${row.id}`);
    assert.equal(input.source.messageId, 'followup');
  }
});

test('internal notifications and non-root callers cannot control tasks', t => {
  const f = fixture(t), task = f.task();
  f.events[1].data.source.kind = 'benchgo-subscription';
  assert.throws(() => f.control(task.id), /原始用户/);
  f.events[1].data.source.kind = 'user';
  f.ownerAgent.session.header.origin = 'subagent';
  assert.throws(() => f.control(task.id, 'cancel'), /原始用户/);
});

test('cancellation is idempotent and stopped tasks cannot receive supplements', t => {
  const f = fixture(t), task = f.task();
  assert.equal(f.control(task.id, 'cancel').task.status, 'waiting');
  assert.equal(f.database.getTask(task.id).executionControl.stopped, true);
  assert.equal(f.control(task.id, 'cancel').task.status, 'waiting');
  assert.equal(f.database.getTask(task.id).executionControl.stopped, true);
  const receipt = f.database.taskInputs(task.id)[0];
  assert.equal(receipt.kind, 'stop'); assert.equal(receipt.state, 'applied');
  assert.equal(receipt.application.kind, 'stop-request'); assert.equal(receipt.application.executionStopped, true);
  assert.throws(() => f.control(task.id), /已完成或停止/);
});

test('an explicit pause is saved once with original instruction and an applied receipt', t => {
  const f = fixture(t), task = f.task();
  f.events[1].data.content[0].text = '暂停刚才的调查，保留原任务，不要再核查续跑';
  const assignment = f.database.createAssignment(task.id, { interruptedContinuationRequest: { automatic: true, operation: 'resume-interrupted', nextAt: Date.now() + 1000 } });
  const first = f.control(task.id, 'pause');
  assert.equal(first.task.status, 'waiting');
  assert.equal(first.task.executionControl.paused, true);
  assert.equal(first.input.kind, 'pause'); assert.equal(first.input.state, 'applied');
  assert.equal(first.input.application.kind, 'pause-request'); assert.equal(first.input.application.executionPaused, true);
  assert.equal(f.database.getTrigger(first.triggerId).content, f.events[1].data.content[0].text);
  assert.equal(f.control(task.id, 'pause').input.id, first.input.id);
  assert.equal(f.database.taskInputs(task.id).length, 1);
  assert.deepEqual(f.database.getTask(task.id).mandate, task.mandate);
  assert.deepEqual(f.database.pendingSubscriptionMessages(task.id), []);
  assert.equal(f.database.getAssignment(assignment.id).interruptedContinuationRequest, undefined);
  assert.deepEqual(f.database.claimAssignments('worker', { validateMandate: () => true }), []);
});

for (const uncertain of [false, true]) test(`pause blocks ${uncertain ? 'uncertain' : 'claimed'} work without claiming the executor has paused`, t => {
  const f = fixture(t), task = f.task();
  f.database.createAssignment(task.id, {});
  const [assignment] = f.database.claimAssignments('worker', { validateMandate: () => true });
  const ownership = { owner: assignment.owner, fence: assignment.fence };
  if (uncertain) {
    const run = f.database.prepareRun(assignment.id, { ...ownership, sessionId: 'interrupted', directory: process.cwd() });
    f.database.updateRun(run.id, { ...ownership, state: 'submitted' });
    f.database.updateRun(run.id, { ...ownership, state: 'uncertain' });
    f.database.renewAssignment(assignment.id, { ...ownership, validateMandate: () => false });
  }
  const result = f.control(task.id, 'pause');
  assert.equal(result.task.status, 'waiting');
  assert.equal(result.task.executionControl.pauseRequested, true);
  assert.equal(result.input.application.executionPaused, false);
  assert.equal(result.input.application.taskStatus, 'waiting');
  assert.equal(f.database.getAssignment(assignment.id).state, uncertain ? 'uncertain' : 'claimed');
  assert.throws(() => f.database.resumeTask(task.id), { code: 'PAUSE_PENDING' });
  assert.deepEqual(f.database.claimAssignments('other-worker', { validateMandate: () => true }), []);
});

test('pause promotes the original pending source receipt instead of creating a second ledger entry', t => {
  const f = fixture(t), task = f.task();
  f.control(task.id);
  const before = f.database.taskInputs(task.id)[0];
  const paused = f.control(task.id, 'pause');
  assert.equal(paused.input.id, before.id); assert.equal(paused.input.kind, 'pause');
  assert.equal(f.database.taskInputs(task.id).length, 1);
});

for (const operation of ['pause', 'cancel']) test(`${operation} refines already consumed context without losing its execution receipt`, t => {
  const f = fixture(t), task = f.task();
  f.database.createAssignment(task.id, {});
  const [assignment] = f.database.claimAssignments('worker', { validateMandate: () => true });
  const run = f.database.prepareRun(assignment.id, { ...assignment, sessionId: 'worker-session', directory: process.cwd() });
  const { triggerId } = f.control(task.id);
  f.database.applyTaskInput(triggerId, { assignmentId: assignment.id, owner: assignment.owner, fence: assignment.fence,
    runId: run.id, sessionId: run.sessionId, boundaryId: 'already-consumed' });
  const [before] = f.database.taskInputs(task.id);
  const result = f.control(task.id, operation), [after] = f.database.taskInputs(task.id);
  assert.equal(after.id, before.id);
  assert.equal(after.kind, operation === 'cancel' ? 'stop' : 'pause');
  assert.equal(after.state, 'applied');
  assert.deepEqual(after.snapshot.contextReceipt.application, before.application);
  assert.deepEqual(after.snapshot.contextReceipt.snapshot, before.snapshot);
  assert.equal(after.snapshot.contextReceipt.kind, 'context');
  assert.equal(after.snapshot.contextReceipt.state, 'applied');
  assert.equal(after.application.kind, operation === 'cancel' ? 'stop-request' : 'pause-request');
  assert.deepEqual(f.control(task.id, operation).input, result.input, 'same source retry never reapplies consumed context');
});

test('pause and its receipt are atomic if application fails', t => {
  const f = fixture(t), task = f.task();
  f.database.applyTaskPauseInputInTransaction = () => { throw Error('receipt failed'); };
  assert.throws(() => f.control(task.id, 'pause'), /receipt failed/);
  assert.equal(f.database.getTask(task.id).status, task.status);
  assert.deepEqual(f.database.taskInputs(task.id), []);
});

test('pause rejects unrelated owners, internal notifications, child agents and terminal work', t => {
  const f = fixture(t), task = f.task({ channel: 'desktop', sessionId: 'another' });
  assert.throws(() => f.control(task.id, 'pause'), /不属于当前会话/);
  const owned = f.task(); f.events[1].data.source.kind = 'benchgo-subscription';
  assert.throws(() => f.control(owned.id, 'pause'), /原始用户/);
  f.events[1].data.source.kind = 'user'; f.ownerAgent.session.header.origin = 'subagent';
  assert.throws(() => f.control(owned.id, 'pause'), /原始用户/);
  delete f.ownerAgent.session.header.origin;
  f.database.cancelTask(owned.id);
  assert.throws(() => f.control(owned.id, 'pause'), /不能暂停/);
  assert.deepEqual(f.database.taskInputs(owned.id), []);
});
