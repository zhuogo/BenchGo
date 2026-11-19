import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { createRemoteAssignmentExecutor } from '../src/remote-assignment-executor.mjs';
import { commitWorkerResult } from '../src/result-commit.mjs';

const execution = { deviceId: 'B-device', hostId: 'B-host', authorizationId: 'B-auth', protocolVersion: 2,
  config: { harness: 'official', models: [{ providerId: 'opaque provider', modelId: 'opaque/model' }] } };
function fixture(t, { lostSubmit = false, lostInput = false, pageSize = 100 } = {}) {
  const database = createAssistantOrchestrationStore({ filename: ':memory:', ownerHostId: 'A-host' });
  let clock = Date.now(), offline = false, rejectIdentity = false, peer, submits = 0, commits = 0;
  const calls = [], inputKeys = new Map();
  const source = { channel: 'desktop', sessionId: 'A-owner-session', threadId: 'main', messageId: 'origin' };
  const { trigger } = database.ingest({ dedupeKey: 'origin', thread: { id: 'A-thread', source: { type: 'desktop', id: 'A-owner-session' } },
    source, actor: { kind: 'human', id: 'desktop-owner' }, content: 'Run the selected task on B.', mode: 'direct' });
  const mandate = { source, triggerId: trigger.id, instruction: trigger.content, actorId: 'desktop-owner', admission: 'desktop-approved-delegation', policyVersion: 'policy',
    controlledActions: 'require-current-policy-and-harness-approval', execution };
  const task = database.createTask({ threadId: 'A-thread', target: 'execute in B', acceptance: 'real evidence', mandate, sourceTriggerIds: [trigger.id] });
  database.createAssignment(task.id, { executor: 'remote', execution, text: task.target });
  const [assignment] = database.claimAssignments('A-worker', { validateMandate: () => true });
  const event = (kind, data) => { const value = { seq: peer.events.length + 1, kind, data }; peer.events.push(value); return value; };
  const response = input => { const events = peer.events.filter(row => row.seq > (input.after || 0)).slice(0, Math.min(pageSize, input.limit || 100));
    return { version: 2, execution: structuredClone(peer.execution), events: structuredClone(events), cursor: events.at(-1)?.seq ?? input.after ?? 0,
      hasMore: peer.events.some(row => row.seq > (events.at(-1)?.seq ?? input.after ?? 0)) }; };
  const ctx = { logger: { warn() {} }, get: name => name === 'benchgoLink' ? { callDevice: async call => {
    calls.push(structuredClone({ ...call, signal: undefined }));
    assert.equal(call.deviceId, execution.deviceId);
    assert.equal(call.expectedHostId, execution.hostId);
    assert.equal(call.expectedAuthorizationId, execution.authorizationId);
    if (offline) throw Object.assign(new Error('offline'), { code: 'DEVICE_OFFLINE' });
    if (rejectIdentity) throw Object.assign(new Error('repaired'), { code: 'IDENTITY_CHANGED' });
    const input = call.input;
    if (input.operation === 'submit') {
      submits++;
      if (!peer) {
        peer = { execution: { id: input.executionId, identity: input.identity, sessionId: input.sessionId,
          phase: 'running', receivedInstructionRevision: 1, appliedInstructionRevision: 1 }, events: [] };
        event('execution.phase', { phase: 'accepted' }); event('instruction.applied', { instructionRevision: 1 }); event('execution.phase', { phase: 'running' });
      }
      if (lostSubmit) { lostSubmit = false; throw Object.assign(new Error('lost response'), { code: 'NETWORK_LOST' }); }
      return response(input);
    }
    if (!peer) throw Object.assign(new Error('absent'), { code: 'EXECUTION_NOT_FOUND' });
    assert.equal(input.executionId, peer.execution.id);
    if (input.operation === 'ack') { peer.ack = input.through; return response(input); }
    if (input.operation === 'control') {
      peer.execution.phase = { cancel: 'stopped', pause: 'paused', resume: 'running' }[input.control];
      if (input.control === 'pause') peer.execution.evidence = { completion: { kind: 'blocked' }, transcript: { lastSeq: 10, hash: 'official-pause' } };
      event('control', { control: input.control, state: 'accepted' }); event('execution.phase', { phase: peer.execution.phase });
    }
    if (input.operation === 'input' && !inputKeys.has(input.requestId)) {
      inputKeys.set(input.requestId, input);
      if (input.kind === 'revision') peer.execution.receivedInstructionRevision = peer.execution.appliedInstructionRevision = input.instructionRevision;
      if (input.kind === 'answer') {
        assert.deepEqual(input.answers.map(row => row.id), ['q1', 'q2']);
        peer.execution.phase = 'running'; event('execution.phase', { phase: 'running' });
      }
      event('instruction.applied', { kind: input.kind, requestId: input.requestId, instructionRevision: peer.execution.appliedInstructionRevision });
      if (lostInput) { lostInput = false; throw Object.assign(new Error('input response lost'), { code: 'NETWORK_LOST' }); }
    }
    return response(input);
  } } : undefined };
  const create = () => createRemoteAssignmentExecutor({ ctx, database, now: () => clock, pollMs: 10,
    readPolicy: async () => ({ desktopVersion: 'policy' }),
    commitResult: async (result, { assignment, task }) => { commits++; return commitWorkerResult({ database, result, assignment, task,
      uniqueKey: `assignment-result:${assignment.id}:${result.runId}:${assignment.fence}` }); } });
  let executor = create();
  t.after(async () => { await executor.stop(); database.close(); });
  return { database, task, assignment, calls, event,
    get peer() { return peer; }, get executor() { return executor; },
    get submits() { return submits; }, get commits() { return commits; },
    get inputKeys() { return inputKeys; },
    async start() { return executor.execute(assignment, { task: database.getTask(task.id) }); },
    async tick() { clock += 100000; await executor.tick(); },
    offline(value) { offline = value; }, rejectIdentity() { rejectIdentity = true; },
    async restart() { await executor.stop(); executor = create(); },
    human(text, key, kind = 'context') {
      const { trigger } = database.ingest({ dedupeKey: key, thread: { id: 'A-thread', source: { type: 'desktop', id: 'A-owner-session' } },
        source: { ...source, messageId: key }, actor: { kind: 'human', id: 'desktop-owner' }, content: text, mode: 'direct' });
      if (kind === 'context') database.recordTaskInput({ taskId: task.id, triggerId: trigger.id, kind, idempotencyKey: key });
      return trigger;
    },
    complete(summary = '真实远端成果') {
      const result = { summary, sessionId: peer.execution.sessionId, instructionRevision: peer.execution.appliedInstructionRevision,
        transcript: { lastSeq: 42, hash: 'official-result' }, completion: { kind: 'completed' }, executionEffects: { effectsVerified: true, unknownCallIds: [] } };
      peer.execution.phase = 'completed'; peer.execution.evidence = result;
      event('execution.phase', { phase: 'completed' }); event('result', result);
    },
  };
}

test('A keeps the only Task, exact configuration and one Run while B returns a factual result', async t => {
  const app = fixture(t);
  assert.deepEqual(await app.start(), { remotePending: true });
  assert.equal(app.database.getAssignment(app.assignment.id).state, 'uncertain');
  assert.equal(app.database.results(app.task.id).length, 0);
  const submit = app.calls.find(row => row.input.operation === 'submit').input;
  assert.deepEqual(submit.config, execution.config);
  assert.equal(submit.identity.ownerHostId, 'A-host');
  assert.equal(submit.identity.taskId, app.task.id);
  const original = app.database.getTrigger(app.task.mandate.triggerId);
  assert.equal(submit.requirements.mandate.triggerId, original.id);
  assert.deepEqual(submit.requirements.mandate.source, original.source);
  assert.equal(submit.requirements.mandate.instruction, original.content);
  app.complete(); await app.tick();
  assert.equal(app.database.getTask(app.task.id).status, 'completed');
  assert.equal(app.database.results(app.task.id)[0].summary, '真实远端成果');
  assert.equal(app.database.runs(app.assignment.id).length, 1);
  assert.equal(app.database.listTasks().length, 1);
  assert.equal(app.submits, 1);
  assert.equal(app.commits, 1);
});

test('lost submit response and owner restart reconcile the original peer execution without re-submitting', async t => {
  const app = fixture(t, { lostSubmit: true });
  await app.start();
  const before = app.database.remoteExecution(app.assignment.id);
  await app.restart(); await app.tick();
  const after = app.database.remoteExecution(app.assignment.id);
  assert.equal(app.submits, 1);
  assert.equal(after.executionId, before.executionId);
  assert.equal(after.runId, before.runId);
  assert.equal(after.sessionId, before.sessionId);
  assert.equal(after.available, true);
  assert.equal(app.calls.some(row => row.input.operation === 'control'), false, 'closing A does not cancel B');
});

test('offline cancellation remains unconfirmed until the original execution reports stopped', async t => {
  const app = fixture(t); await app.start();
  app.offline(true); app.database.cancelTask(app.task.id); await app.tick();
  assert.equal(app.database.getTask(app.task.id).executionControl.stopped, false);
  assert.equal(app.database.remoteExecution(app.assignment.id).available, false);
  app.offline(false); await app.tick();
  assert.equal(app.database.getTask(app.task.id).executionControl.stopped, true);
  assert.equal(app.database.getAssignment(app.assignment.id).state, 'cancelled');
  assert.equal(app.submits, 1);
});

test('pause and resume require official pause evidence and keep the same Run and fence', async t => {
  const app = fixture(t); await app.start();
  const original = app.database.remoteExecution(app.assignment.id);
  app.database.pauseTask(app.task.id); await app.tick();
  assert.equal(app.database.getTask(app.task.id).executionControl.paused, true);
  assert.equal(app.database.getAssignment(app.assignment.id).state, 'paused');
  app.database.resumeTask(app.task.id); await app.tick();
  assert.equal(app.database.remoteExecution(app.assignment.id).phase, 'running');
  assert.equal(app.database.remoteExecution(app.assignment.id).runId, original.runId);
  assert.equal(app.database.getAssignment(app.assignment.id).fence, original.fence);
});

test('context receipt loss is reconciled once and input is applied only from an explicit event', async t => {
  const app = fixture(t, { lostInput: true }); await app.start();
  const trigger = app.human('可信的补充背景', 'context-one');
  await app.tick();
  assert.equal(app.database.taskInputs(app.task.id).find(row => row.triggerId === trigger.id).state, 'pending');
  await app.restart(); await app.tick();
  assert.equal(app.database.taskInputs(app.task.id).find(row => row.triggerId === trigger.id).state, 'applied');
  assert.equal(app.inputKeys.size, 1);
  assert.equal(app.submits, 1);
});

test('remote question batch becomes A Attentions and answers preserve each question identity', async t => {
  const app = fixture(t); await app.start();
  app.peer.execution.phase = 'waiting';
  app.event('execution.phase', { phase: 'waiting' });
  app.event('question', { questionId: 'question-batch', callId: 'official-call', version: 1, instructionRevision: 1,
    questions: [{ id: 'q1', question: '选哪个？' }, { id: 'q2', question: '什么时候？' }] });
  await app.tick();
  const questions = app.database.attentions(app.task.id);
  assert.equal(questions.length, 2);
  for (const [index, question] of questions.entries()) app.database.answerDesktopAttention({ taskId: app.task.id,
    attentionId: question.id, instructionRevision: 1, requestId: `answer-${index}`, answer: { selected: [], custom: `answer for ${question.question.id}` } });
  await app.tick();
  const answer = [...app.inputKeys.values()].find(row => row.kind === 'answer');
  assert.deepEqual(answer.answers.map(row => row.custom), ['answer for q1', 'answer for q2']);
  assert.equal(app.database.taskInputs(app.task.id).filter(row => row.kind === 'answer').every(row => row.state === 'applied'), true);
  assert.equal(app.database.runs(app.assignment.id).length, 1);
});

test('a changed pairing identity cannot read, control or complete the existing Task', async t => {
  const app = fixture(t); await app.start(); app.rejectIdentity(); app.complete(); await app.tick();
  const remote = app.database.remoteExecution(app.assignment.id);
  assert.equal(remote.available, false);
  assert.equal(remote.code, 'IDENTITY_CHANGED');
  assert.equal(app.database.getTask(app.task.id).status, 'running');
  assert.equal(app.database.results(app.task.id).length, 0);
});

test('bounded event pages are persisted before terminal state and result are published', async t => {
  const app = fixture(t, { pageSize: 2 }); await app.start(); app.complete();
  await app.tick();
  assert.equal(app.database.getTask(app.task.id).status, 'running');
  await app.tick();
  assert.equal(app.database.getTask(app.task.id).status, 'completed');
  assert.equal(app.database.remoteExecution(app.assignment.id).cursor, app.peer.events.length);
});

test('explicit original-execution verification bypasses offline backoff without creating a new Run', async t => {
  const app = fixture(t); await app.start();
  app.offline(true); await app.tick(); app.offline(false); app.complete();
  const reply = await app.executor.manageExecution({ taskId: app.task.id, assignmentId: app.assignment.id,
    fence: app.assignment.fence, instructionRevision: 1, operation: 'resume' });
  assert.equal(reply.status, 'observed');
  assert.equal(app.database.getTask(app.task.id).status, 'completed');
  assert.equal(app.database.runs(app.assignment.id).length, 1);
  assert.equal(app.submits, 1);
});

test('a question on a later page opens against the exact observed waiting Run', async t => {
  const app = fixture(t, { pageSize: 1 }); await app.start(); await app.tick(); await app.tick();
  app.peer.execution.phase = 'waiting';
  app.event('execution.phase', { phase: 'waiting' });
  app.event('question', { questionId: 'later-question', callId: 'later-call', version: 1, instructionRevision: 1,
    questions: [{ id: 'later', question: 'Later page?' }] });
  await app.tick(); await app.tick();
  assert.equal(app.database.attentions(app.task.id).length, 1);
  assert.equal(app.database.remoteExecution(app.assignment.id).available, true);
});
