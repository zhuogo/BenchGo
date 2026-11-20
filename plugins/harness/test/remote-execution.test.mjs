import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { openRemoteExecutionStore } from '../src/remote-execution-store.mjs';
import { createRemoteExecutionService, remoteExecutionEvidence } from '../src/remote-execution.mjs';
import { remoteExecutionFixture as fixture } from './fixtures/remote-execution.mjs';

const principal = { kind: 'device', deviceId: 'paired-owner-A' };
const verifiedSourceHostId = 'sha256:' + 'a'.repeat(64);
const otherSourceHostId = 'sha256:' + 'b'.repeat(64);
const request = (extra = {}) => ({ action: 'execution', version: 2, operation: 'submit', requestId: randomUUID(), executionId: randomUUID(), sessionId: randomUUID(),
  identity: { ownerHostId: 'owner-A', taskId: 'task-A', assignmentId: 'assignment-A', runId: 'run-A', fence: 1 },
  config: { harness: 'official', models: [{ providerId: 'exact-provider', modelId: 'opaque-model/1', params: { temperature: 0.3 } }] },
  text: 'Inspect the assigned workspace', requirements: { instructionRevision: 1, target: 'Inspect', acceptance: 'Evidence', mandate: { instruction: 'Inspect only', toolScope: ['read', 'ask_user_question'] } }, ...extra });
const waitFor = async predicate => { for (let i = 0; i < 100; i++) { const value = predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('Timed out waiting for execution boundary'); };
async function temp(t) { const directory = await mkdtemp(join(tmpdir(), 'benchgo-execution-')); return directory; }

test('execution journal binds authenticated subjects, immutable commands, session identity and fences', async t => {
  const directory = await temp(t), db = openRemoteExecutionStore(directory), input = request();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const row = db.tx(() => db.create(principal.deviceId, input, {}));
  assert.equal(row.id, input.executionId); assert.equal(row.sessionId, input.sessionId);
  assert.equal(db.receipt(principal.deviceId, input.requestId, { ...input, after: 15, limit: 1 }).state, 'received');
  assert.throws(() => db.receipt(principal.deviceId, input.requestId, { ...input, text: 'Changed' }), { code: 'EXECUTION_COMMAND_CONFLICT' });
  assert.throws(() => db.owned(row.id, 'different-device'), { code: 'EXECUTION_NOT_FOUND' });
  assert.throws(() => db.tx(() => db.create(principal.deviceId, request({ identity: { ...input.identity, ownerHostId: 'spoofed' } }), {})), { code: 'EXECUTION_OWNER_CHANGED' });
  assert.throws(() => db.tx(() => db.create('another-pair', request({ identity: { ...input.identity, fence: 2 } }), {})), { code: 'EXECUTION_OWNER_CHANGED' });
  assert.throws(() => db.tx(() => db.create(principal.deviceId, request({ identity: { ...input.identity, fence: 2 } }), {})), { code: 'EXECUTION_STILL_ACTIVE' });
  row.phase = 'uncertain'; row.writerReleasedAt = new Date().toISOString(); db.save(row);
  assert.throws(() => db.tx(() => db.create(principal.deviceId, request({ identity: { ...input.identity, fence: 2 } }), {})), { code: 'EXECUTION_STILL_ACTIVE' });
  row.phase = 'stopped'; db.save(row);
  const next = db.tx(() => db.create(principal.deviceId, request({ identity: { ...input.identity, runId: 'run-next', fence: 2 } }), {}));
  assert.throws(() => db.assertFence(row), { code: 'EXECUTION_FENCE_CONFLICT' });
  assert.equal(next.identity.fence, 2);
  assert.deepEqual(db.page(row.id, 0, 1).events.map(event => event.seq), [1]);
  assert.equal(db.page(row.id, 0, 1).hasMore, true);
  db.close();
  const reopened = openRemoteExecutionStore(directory);
  assert.equal(reopened.get(row.id).phase, 'stopped'); assert.equal(reopened.receipt(principal.deviceId, input.requestId).executionId, row.id);
  reopened.close();
});

test('execution journal upgrades legacy owner bindings without moving executions or receipts', async t => {
  const directory = await temp(t), input = request(), db = openRemoteExecutionStore(directory);
  t.after(() => rm(directory, { recursive: true, force: true }));
  db.tx(() => db.create(principal.deviceId, input, {}));
  db.close();
  const legacy = new DatabaseSync(join(directory, 'executions.db'));
  legacy.exec(`CREATE TABLE legacy_owners(principal TEXT PRIMARY KEY, owner_host_id TEXT NOT NULL UNIQUE);
    INSERT INTO legacy_owners SELECT principal,owner_host_id FROM execution_owners;
    DROP TABLE execution_owners;
    ALTER TABLE legacy_owners RENAME TO execution_owners;`);
  legacy.close();

  const migrated = openRemoteExecutionStore(directory);
  try {
    assert.equal(migrated.owned(input.executionId, principal.deviceId).id, input.executionId);
    assert.equal(migrated.receipt(principal.deviceId, input.requestId).executionId, input.executionId);
    const newTask = request({ identity: { ...input.identity, taskId: 'new-task' } });
    const oldTaskNewAssignment = request({ identity: { ...input.identity, assignmentId: 'other-assignment' } });
    assert.throws(() => migrated.tx(() => migrated.create('new-pair', newTask, {})), { code: 'EXECUTION_OWNER_CHANGED' });
    assert.throws(() => migrated.tx(() => migrated.create('new-pair', oldTaskNewAssignment, {}, verifiedSourceHostId)), { code: 'EXECUTION_OWNER_CHANGED' });
    const row = migrated.tx(() => migrated.create('new-pair', newTask, {}, verifiedSourceHostId));
    assert.equal(row.principal, 'new-pair');
    assert.equal(migrated.receipt('new-pair', input.requestId), undefined);
    assert.throws(() => migrated.owned(input.executionId, 'new-pair'), { code: 'EXECUTION_NOT_FOUND' });
    assert.equal(migrated.page(input.executionId).cursor, 2);
    assert.equal(migrated.owned(input.executionId, principal.deviceId).identity.taskId, 'task-A');
  } finally { migrated.close(); }
});


async function running(t, fixtureValue = fixture()) {
  const directory = await temp(t), service = await createRemoteExecutionService({ ctx: fixtureValue.ctx, directory });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  const input = request(), access = { principal }, call = value => service.dispatch({ action: 'execution', version: 2, ...value }, access);
  const accepted = await service.dispatch(input, access);
  await waitFor(() => fixtureValue.instances[0]?.pending.length);
  return { directory, service, input, access, call, accepted, execution: fixtureValue.instances[0], fixture: fixtureValue };
}

test('verified same-source pairing can dispatch a new task while commands and receipts remain principal scoped', async t => {
  const { service, input, call } = await running(t);
  const dispatch = (deviceId, value, sourceId) => service.dispatch({ action: 'execution', version: 2, ...value }, {
    principal: { kind: 'device', deviceId }, verifiedSourceHostId: sourceId,
  });
  assert.equal((await dispatch(principal.deviceId, input, verifiedSourceHostId)).execution.id, input.executionId);
  await assert.rejects(dispatch(principal.deviceId, input, otherSourceHostId), { code: 'EXECUTION_OWNER_CHANGED' });
  const newTask = request({ requestId: input.requestId, identity: { ...input.identity, taskId: 'new-task' } });
  await assert.rejects(dispatch('different-source', newTask, otherSourceHostId), { code: 'EXECUTION_OWNER_CHANGED' });
  await assert.rejects(dispatch('unverified-pair', { ...newTask, verifiedSourceHostId }), { code: 'EXECUTION_OWNER_CHANGED' });
  const oldTaskNewAssignment = request({ identity: { ...input.identity, assignmentId: 'other-assignment' } });
  await assert.rejects(dispatch('new-pair', oldTaskNewAssignment, verifiedSourceHostId), { code: 'EXECUTION_OWNER_CHANGED' });
  const accepted = await dispatch('new-pair', newTask, verifiedSourceHostId);
  assert.equal(accepted.execution.id, newTask.executionId);
  const receiptLookup = { operation: 'get', requestId: input.requestId };
  assert.equal((await dispatch('new-pair', receiptLookup)).execution.id, newTask.executionId);
  assert.equal((await call(receiptLookup)).execution.id, input.executionId);
  for (const operation of ['get', 'input', 'control', 'ack']) {
    await assert.rejects(dispatch('new-pair', { operation, executionId: input.executionId }, verifiedSourceHostId), { code: 'EXECUTION_NOT_FOUND' });
  }
  assert.equal((await call({ operation: 'ack', executionId: input.executionId, through: 1 })).execution.ackThrough, 1);
});

function nativeFixture() {
  const sessions = new Map(), handlers = new Map(), prepared = [], submitted = [];
  let terminal;
  const commander = {
    providers: new Map([['codex', {}], ['claude', {}]]),
    pickerCatalog: { list: async () => ({ routes: [
      { tool: 'deepseek', providerId: 'exact-provider', nativeModelId: 'opaque-model/1', name: 'Official' },
      { tool: 'codex', providerId: 'b-responses', nativeModelId: 'opaque/model:codex', name: 'Codex' },
      { tool: 'claude', providerId: 'b-messages', nativeModelId: 'opaque/model:claude', name: 'Claude' },
    ] }) },
    routeService: { capture: async route => ({ ...route, fingerprint: 'B-owned-binding' }) },
    async advancedConfig() { return { contextWindow: 2048 }; },
    async prepareExecution(input) {
      prepared.push(input);
      sessions.set(input.sessionId, { id: input.sessionId, executionId: input.executionId, status: 'idle', turnId: null, events: [] });
      return this.snapshot(input.sessionId);
    },
    executionSession(id) { return [...sessions.values()].find(session => session.executionId === id); },
    snapshot(id) { const { events, ...session } = sessions.get(id); return { ...session, cursor: events.length }; },
    registerExecutionHandler(id, handler) { handlers.set(id, handler); return () => handlers.delete(id); },
    async submit(id, prompt, { requestId }) {
      submitted.push({ id, prompt, requestId });
      const session = sessions.get(id);
      session.status = 'running'; session.turnId = randomUUID();
      event(id, 'input.accepted', { requestId });
      return { status: 'accepted', turnId: session.turnId };
    },
    events(id, after, limit) { const { events } = sessions.get(id); return { events: events.slice(after, after + limit), cursor: Math.min(after + limit, events.length), latest: events.length }; },
    async wait(id, { signal }) { await delay(5, undefined, { signal }); return this.snapshot(id); },
    async persist() {},
    async stopExecution(id) { await terminal; event(id, 'turn.completed', { status: 'interrupted' }); sessions.get(id).status = 'idle'; return this.snapshot(id); },
    async disconnect(id) { sessions.get(id).status = 'closed'; },
  };
  function event(id, type, data) {
    const session = sessions.get(id);
    session.events.push({ seq: session.events.length + 1, turnId: session.turnId, type, data, time: new Date().toISOString() });
  }
  return { commander, prepared, submitted,
    finish(id) { event(id, 'text.delta', { text: 'Done on B' }); event(id, 'turn.completed', { status: 'completed' }); sessions.get(id).status = 'idle'; },
    ask(id) { return handlers.get(id)({ kind: 'question', nativeRequestId: 'native-request', details: { questions: [{ id: 'native-q', question: 'Which file?' }] } }); },
    setStopBarrier(value) { terminal = value; },
  };
}

async function runNative(t, harness) {
  const native = nativeFixture(), f = fixture(), directory = await temp(t);
  const service = await createRemoteExecutionService({ ctx: f.ctx, directory, commander: native.commander });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  const config = { harness, models: [{ providerId: harness === 'codex' ? 'b-responses' : 'b-messages', modelId: 'opaque/model:' + harness }] };
  const input = request({ config, requirements: { instructionRevision: 1, target: 'Inspect', mandate: { instruction: 'Inspect' } } });
  const call = value => service.dispatch({ action: 'execution', version: 2, ...value }, { principal });
  await call(input);
  await waitFor(() => native.submitted.length);
  return { native, f, input, call, service };
}

test('B runs a frozen external API binding, returns native questions, and deduplicates A submission', async t => {
  const { native, f, input, call, service } = await runNative(t, 'codex');
  assert.deepEqual((await call({ operation: 'catalog' })).models.map(row => row.harness), ['official', 'codex', 'claude']);
  assert.equal(native.prepared[0].route.providerId, 'b-responses');
  assert.deepEqual(native.prepared[0].route.advancedConfig, { contextWindow: 2048 });
  const pending = native.ask(input.sessionId);
  const get = () => call({ operation: 'get', executionId: input.executionId });
  const waiting = await get();
  assert.equal(waiting.execution.phase, 'waiting');
  assert.equal(waiting.execution.binding, undefined);
  const { questionId } = waiting.events.find(event => event.kind === 'question').data;
  await call({ operation: 'input', executionId: input.executionId, requestId: randomUUID(), kind: 'answer',
    questionId, instructionRevision: 1, text: 'answer', answers: [{ id: 'native-q', selected: [], custom: 'file.txt' }] });
  assert.deepEqual(await pending, { allow: false, answers: { 'native-q': { answers: ['file.txt'] } } });
  assert.equal((await call(input)).receipt.state, 'applied');
  native.finish(input.sessionId);
  for (let i = 0; i < 100 && (await get()).execution.phase !== 'completed'; i++) await delay(5);
  const result = await get();
  assert.equal(result.execution.phase, 'completed');
  assert.equal(result.events.find(event => event.kind === 'result').data.summary, 'Done on B');
  assert.equal(native.submitted.length, 1);
  assert.equal(service.ownerOfSession(input.sessionId).promptable, false);
  assert.equal(f.instances.length, 0);
});

test('B accepts Claude cancellation before stop and acknowledges only actual native shutdown', async t => {
  const { native, input, call } = await runNative(t, 'claude');
  let stop;
  native.setStopBarrier(new Promise(resolve => { stop = resolve; }));
  const get = () => call({ operation: 'get', executionId: input.executionId });
  const command = { operation: 'control', executionId: input.executionId, requestId: randomUUID() };
  try {
    await assert.rejects(call({ ...command, control: 'pause' }), { code: 'NATIVE_WORKER_CONTROL_UNSUPPORTED' });
    await assert.rejects(call({ ...command, version: 1, control: 'cancel' }), { code: 'UNSUPPORTED_EXECUTION_PROTOCOL' });
    const accepted = await call({ ...command, control: 'cancel' });
    assert.equal(accepted.receipt.accepted, true);
    assert.notEqual((await get()).execution.phase, 'stopped');
  } finally { stop(); }
  for (let i = 0; i < 100 && (await get()).execution.phase !== 'stopped'; i++) await delay(5);
  assert.equal((await get()).execution.phase, 'stopped');
  assert.equal(native.commander.snapshot(input.sessionId).status, 'closed');
});

test('B recovers the completed native binding after restart without resubmitting', async t => {
  const native = nativeFixture(), f = fixture(), directory = await temp(t);
  const config = { harness: 'codex', models: [{ providerId: 'b-responses', modelId: 'opaque/model:codex' }] };
  const input = request({ config, requirements: { instructionRevision: 1, mandate: { instruction: 'Inspect' } } });
  const db = openRemoteExecutionStore(directory);
  const row = db.tx(() => db.create(principal.deviceId, input, {}));
  await native.commander.prepareExecution({ executionId: input.executionId, sessionId: input.sessionId });
  await native.commander.submit(input.sessionId, input.text, { requestId: input.requestId });
  native.finish(input.sessionId);
  await native.commander.disconnect(input.sessionId);
  row.phase = 'running'; row.sessionOwned = true; row.nativeStartCursor = 0; row.submittedAt = new Date().toISOString(); db.save(row); db.close();
  const service = await createRemoteExecutionService({ ctx: f.ctx, directory, commander: native.commander });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  const result = await service.dispatch({ action: 'execution', version: 2, operation: 'get', executionId: input.executionId }, { principal });
  assert.equal(result.execution.phase, 'completed');
  assert.equal(result.events.find(event => event.kind === 'result').data.summary, 'Done on B');
  assert.equal(native.prepared.length, 1);
  assert.equal(native.submitted.length, 1);
});

test('official execution works without SuperAgent, freezes exact config, and requires transcript completion', async t => {
  const { service, call, input, execution, accepted, fixture: f } = await running(t);
  assert.equal(accepted.execution.sessionId, input.sessionId); assert.equal(accepted.receipt.state, 'received');
  assert.equal((await call({ operation: 'catalog' })).models[0].modelId, 'opaque-model/1');
  await execution.step();
  assert.deepEqual(f.modelCalls[0], { provider: 'exact-provider', model: 'opaque-model/1' });
  assert.deepEqual(await execution.requestModel(), { provider: 'exact-provider', model: 'opaque-model/1', temperature: 0.3, tools: [] });
  assert.equal((await execution.tool('read')).kind, 'allow'); assert.equal((await execution.tool('write')).kind, 'deny');
  assert.equal((await execution.tool('assistant_task_start')).kind, 'deny');
  await execution.finish();
  const result = await waitFor(() => execution.disposed && true);
  assert.equal(result, true);
  const observed = await call({ operation: 'get', executionId: input.executionId });
  assert.equal(observed.execution.phase, 'completed');
  const event = observed.events.find(event => event.kind === 'result');
  assert.equal(event.data.completion.kind, 'completed'); assert.equal(event.data.instructionRevision, 1); assert.equal(event.data.sessionId, input.sessionId);
  assert.match(event.data.transcript.hash, /^[a-f0-9]{64}$/);
  const repeated = await service.dispatch({ ...input, after: 2, limit: 20 }, { principal });
  assert.equal(repeated.receipt.state, 'applied'); assert.equal(f.instances.length, 1);
  assert.equal(service.ownerOfSession(input.sessionId).ownerHostId, 'owner-A');
  await assert.rejects(f.rawStep({ id: input.sessionId }, []), { code: 'EXECUTION_INPUT_REQUIRES_OWNER' });
  await assert.rejects(call({ operation: 'ack', executionId: input.executionId, through: 999 }), { code: 'INVALID_EXECUTION_ACK' });
  await call({ operation: 'ack', executionId: input.executionId, through: observed.cursor });
});

test('target Worker preference reads current settings and preserves options in the execution request', async t => {
  const f = fixture(), directory = await temp(t);
  const service = await createRemoteExecutionService({ ctx: f.ctx, directory });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  const catalog = () => service.dispatch({ action: 'execution', version: 2, operation: 'catalog' }, { principal });
  assert.equal((await catalog()).workerPreference, undefined);
  const unusable = { providerId: 'exact-provider', modelId: 'missing' };
  const selected = { providerId: 'exact-provider', modelId: 'opaque-model/1', params: { maxTokens: 432 } };
  let models = [unusable, selected];
  f.services.assistant = { readWorkerModels: async () => ({ harness: 'official', models }) };
  const { config } = (await catalog()).workerPreference;
  assert.deepEqual(config, { harness: 'official', models: [selected] });
  await service.dispatch(request({ config }), { principal });
  await waitFor(() => f.instances[0]?.pending.length);
  await f.instances[0].step();
  assert.deepEqual(await f.instances[0].requestModel(), { provider: selected.providerId, model: selected.modelId, maxTokens: 432, tools: [] });
  models = [unusable];
  assert.equal((await catalog()).workerPreference.error.code, 'EXECUTION_WORKER_UNAVAILABLE');
  models = [];
  assert.equal((await catalog()).workerPreference, undefined);
  await f.instances[0].finish();
  await waitFor(() => f.instances[0].disposed);
});

test('revisions and context have durable received/applied receipts and reject native bypass', async t => {
  const { call, input, execution } = await running(t);
  await execution.step();
  const revisionInput = { operation: 'input', executionId: input.executionId, requestId: randomUUID(), kind: 'revision', instructionRevision: 2,
    text: 'Revised', requirements: { instructionRevision: 2, target: 'Revised', mandate: { instruction: 'Revised only', toolScope: ['read'] } } };
  const received = await call(revisionInput); assert.equal(received.receipt.state, 'received'); assert.equal(received.execution.appliedInstructionRevision, 1);
  const context = { operation: 'input', executionId: input.executionId, requestId: randomUUID(), kind: 'context', instructionRevision: 1, text: 'Earlier authorized context' };
  assert.equal((await call(context)).receipt.state, 'received');
  await execution.step();
  assert.equal((await call(revisionInput)).receipt.instructionRevision, 2); assert.equal((await call(context)).receipt.instructionRevision, 2);
  execution.pending.push({ id: 'not-authorized', source: { kind: 'user' } });
  await assert.rejects(execution.step(), { code: 'EXECUTION_INPUT_REQUIRES_OWNER' }); execution.pending.pop();
  await execution.finish();
});

test('questions route through owner answers by real ids and superseded questions release revision boundary', async t => {
  const { call, input, execution } = await running(t); await execution.step();
  const pending = execution.question([{ id: 'q-one', question: 'Which file?' }, { id: 'q-two', question: 'Which branch?' }]);
  pending.catch(() => {});
  const snapshot = await call({ operation: 'get', executionId: input.executionId });
  const question = snapshot.events.findLast(event => event.kind === 'question').data;
  assert.equal(question.callId, 'official-call'); assert.equal(question.instructionRevision, 1);
  const answerInput = { operation: 'input', executionId: input.executionId, requestId: randomUUID(), instructionRevision: 1, kind: 'answer', text: 'Answers', questionId: question.questionId,
    answers: [{ id: 'q-one', selected: [], custom: 'file.txt' }, { id: 'q-two', selected: [], custom: 'main' }] };
  await assert.rejects(call({ ...answerInput, answers: [{ id: 'q-one', selected: [], custom: 'Incomplete' }] }), { code: 'INVALID_EXECUTION_ANSWER' });
  const answer = await call(answerInput); assert.equal(answer.receipt.state, 'applied'); assert.equal(answer.receipt.requestId, answerInput.requestId);
  assert.deepEqual(await pending, { answers: answerInput.answers });
  const stale = execution.question(); stale.catch(() => {});
  const change = { operation: 'input', executionId: input.executionId, requestId: randomUUID(), instructionRevision: 2, kind: 'revision', text: 'Changed', requirements: { instructionRevision: 2, mandate: { instruction: 'Changed' } } };
  await call(change); await assert.rejects(stale, { code: 'EXECUTION_QUESTION_SUPERSEDED' });
  await execution.step(); assert.equal((await call(change)).receipt.instructionRevision, 2);
  await execution.finish();
});

test('pause resumes only original verified session and cancellation confirms disposal before stopped', async t => {
  const f = fixture(), { call, input, execution } = await running(t, f); await execution.step();
  await call({ operation: 'control', executionId: input.executionId, requestId: randomUUID(), control: 'pause' });
  assert.equal((await execution.step()).kind, 'reject'); await waitFor(() => execution.disposed);
  assert.equal((await call({ operation: 'get', executionId: input.executionId })).execution.phase, 'paused');
  await call({ operation: 'control', executionId: input.executionId, requestId: randomUUID(), control: 'resume' });
  const resumed = await waitFor(() => f.instances[1]?.pending.length && f.instances[1]); assert.equal(resumed.agent.id, execution.agent.id); await resumed.step();
  let unblock; f.setStopBarrier(new Promise(resolve => { unblock = resolve; }));
  const command = { operation: 'control', executionId: input.executionId, requestId: randomUUID(), control: 'cancel' };
  await call(command);
  assert.notEqual((await call({ operation: 'get', executionId: input.executionId })).execution.phase, 'stopped');
  unblock(); await waitFor(() => resumed.disposed);
  assert.equal((await call({ operation: 'get', executionId: input.executionId })).execution.phase, 'stopped');
});

test('restart inspects official evidence without replaying uncertain submission and preserves read-only ownership', async t => {
  const f = fixture(), directory = await temp(t), db = openRemoteExecutionStore(directory), input = request();
  const row = db.tx(() => db.create(principal.deviceId, input, { directory, workingDirectory: directory }));
  row.phase = 'running'; row.sessionOwned = true; row.submittedAt = new Date().toISOString(); db.save(row); db.close();
  const service = await createRemoteExecutionService({ ctx: f.ctx, directory }); t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  const observed = await service.dispatch({ action: 'execution', version: 2, operation: 'get', executionId: input.executionId }, { principal });
  assert.equal(observed.execution.phase, 'uncertain'); assert.equal(f.instances.length, 0);
  assert.equal(service.ownerOfSession(input.sessionId).taskId, input.identity.taskId);
  await assert.rejects(service.dispatch({ ...input, text: 'Changed command' }, { principal }), { code: 'EXECUTION_COMMAND_CONFLICT' });
  await assert.rejects(service.dispatch({ action: 'execution', version: 2, operation: 'get', executionId: input.executionId }, { principal: { kind: 'device', deviceId: 'other' } }), { code: 'EXECUTION_NOT_FOUND' });
});

test('an idle or interrupted transcript is never reported as successful completion', () => {
  const row = { sessionId: 'session', appliedInstructionRevision: 1 };
  assert.equal(remoteExecutionEvidence({ events: [{ seq: 1, type: 'turn/end', data: { reason: { kind: 'completed' } } }, { seq: 2, type: 'user/message', data: {} }] }, row).completion, undefined);
  const evidence = remoteExecutionEvidence({ events: [{ seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: 'effect', name: 'write' }] } } }] }, row);
  assert.equal(evidence.executionEffects.effectsVerified, false); assert.deepEqual(evidence.executionEffects.unknownCallIds, ['effect']);
});

test('pre-step async admission preserves concurrent inputs and acknowledges only messages actually claimed', async t => {
  const { call, input, execution } = await running(t); await execution.step();
  let release, entered;
  const enteredBoundary = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const oldStep = execution.step(async () => { entered(); await gate; }); await enteredBoundary;
  const change = { operation: 'input', executionId: input.executionId, requestId: randomUUID(), instructionRevision: 2, kind: 'revision', text: 'New complete instruction', requirements: { instructionRevision: 2, target: 'New', mandate: { instruction: 'New complete instruction' } } };
  const context = { operation: 'input', executionId: input.executionId, requestId: randomUUID(), instructionRevision: 1, kind: 'context', text: 'Context concurrent with pre-step' };
  await call(change); await call(context); release(); await oldStep;
  const pending = await call({ operation: 'get', executionId: input.executionId });
  assert.equal(pending.execution.receivedInstructionRevision, 2); assert.equal(pending.execution.appliedInstructionRevision, 1);
  assert.equal((await call(change)).receipt.state, 'received'); assert.equal((await call(context)).receipt.state, 'received');
  await execution.step();
  assert.equal((await call(change)).receipt.state, 'applied'); assert.equal((await call(context)).receipt.instructionRevision, 2);
  await execution.finish();
});

test('late context prevents a completed claim until the original session has actually applied it', async t => {
  const { call, input, execution } = await running(t); await execution.step();
  const context = { operation: 'input', executionId: input.executionId, requestId: randomUUID(), instructionRevision: 1, kind: 'context', text: 'Late input after last model step' };
  await call(context); await execution.finish(); await waitFor(() => execution.disposed);
  const observed = await call({ operation: 'get', executionId: input.executionId });
  assert.equal(observed.execution.phase, 'uncertain'); assert.equal(observed.events.some(event => event.kind === 'result'), false);
  assert.equal((await call(context)).receipt.state, 'received');
  await assert.rejects(call({ ...request({ identity: { ...input.identity, fence: 2, runId: 'run-replay' } }) }), { code: 'EXECUTION_STILL_ACTIVE' });
});

test('uncertain storage recovery converges through original official evidence without creating another agent', async t => {
  const f = fixture(), directory = await temp(t), db = openRemoteExecutionStore(directory), input = request();
  const row = db.tx(() => db.create(principal.deviceId, input, { directory, workingDirectory: directory }));
  row.phase = 'uncertain'; row.sessionOwned = true; row.submittedAt = new Date().toISOString(); row.appliedInstructionRevision = 1; row.pendingCommands = []; db.save(row); db.close();
  const service = await createRemoteExecutionService({ ctx: f.ctx, directory });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  f.logs.set(input.sessionId, [{ seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Stored real result' }] } } }, { seq: 2, type: 'turn/end', data: { reason: { kind: 'completed' } } }]);
  const observed = await service.dispatch({ action: 'execution', version: 2, operation: 'get', executionId: input.executionId }, { principal });
  assert.equal(observed.execution.phase, 'completed'); assert.equal(observed.events.find(event => event.kind === 'result').data.summary, 'Stored real result');
  assert.equal(f.instances.length, 0);
});

test('submit rejects workspace identity/path drift and real executor host mismatch', async t => {
  const f = fixture(), directory = await temp(t);
  f.services.workspaceRegistry.list = () => [{ id: 'project-B', path: directory, title: 'B workspace' }];
  const service = await createRemoteExecutionService({ ctx: f.ctx, directory });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  const initial = request({ projectId: 'project-B' });
  const changed = { ...initial, requirements: { ...initial.requirements, mandate: { project: { id: 'project-B', path: directory + '-moved' } } } };
  await assert.rejects(service.dispatch(changed, { principal }), { code: 'EXECUTION_PROJECT_CHANGED' });
  await assert.rejects(service.dispatch(initial, { principal, hostId: 'real-B-host' }), { code: 'EXECUTION_HOST_CHANGED' });
  assert.equal(f.instances.length, 0);
});

test('existing official session collisions never acquire execution ownership or block native input', async t => {
  const f = fixture(), directory = await temp(t), input = request();
  const original = [{ seq: 1, type: 'user/message', data: { id: 'original-user-input' } }]; f.logs.set(input.sessionId, structuredClone(original));
  const service = await createRemoteExecutionService({ ctx: f.ctx, directory });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  await assert.rejects(service.dispatch(input, { principal }), { code: 'EXECUTION_SESSION_CONFLICT' });
  assert.equal(service.ownerOfSession(input.sessionId), null); assert.equal(f.instances.length, 0); assert.deepEqual(f.logs.get(input.sessionId), original);
  assert.equal((await f.rawStep({ id: input.sessionId }, [{ id: 'native-user-message' }])).kind, 'enter');
  // Also protect the interval between the absence probe and official create.
  const realCreate = f.services.agents.create;
  f.services.agents.create = async options => { f.logs.set(options.sessionId, structuredClone(original)); throw Object.assign(new Error('Session already exists'), { name: 'SessionAlreadyExistsError' }); };
  const raced = request({ identity: { ...input.identity, taskId: 'race-task' }, sessionId: randomUUID() });
  await service.dispatch(raced, { principal });
  await waitFor(() => f.logs.has(raced.sessionId));
  assert.equal(service.ownerOfSession(raced.sessionId), null);
  assert.equal((await f.rawStep({ id: raced.sessionId }, [{ id: 'native-after-race' }])).kind, 'enter');
  f.services.agents.create = realCreate;
});

test('crash before publication records uncertainty and cancellation stops only an unpublished unsubmitted record', async t => {
  const f = fixture(), directory = await temp(t), db = openRemoteExecutionStore(directory), input = request();
  db.tx(() => db.create(principal.deviceId, input, { directory, workingDirectory: directory }));
  const unknown = request({ identity: { ...input.identity, taskId: 'unknown-submission' } });
  const unknownRow = db.tx(() => db.create(principal.deviceId, unknown, { directory, workingDirectory: directory }));
  unknownRow.submittedAt = new Date().toISOString(); db.save(unknownRow); db.close();
  const original = [{ seq: 1, type: 'user/message', data: { id: 'unrelated-native-session' } }];
  f.logs.set(input.sessionId, structuredClone(original)); f.logs.set(unknown.sessionId, structuredClone(original));
  let persistenceOpens = 0;
  const open = f.services.sessionPersistence.open;
  f.services.sessionPersistence.open = async (...args) => { persistenceOpens++; return open(...args); };
  const service = await createRemoteExecutionService({ ctx: f.ctx, directory });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  const call = value => service.dispatch({ action: 'execution', version: 2, ...value }, { principal });
  const observed = await call({ operation: 'get', executionId: input.executionId });
  assert.equal(observed.execution.phase, 'uncertain'); assert.match(observed.execution.reason, /归属尚未发布/);
  assert.equal(service.ownerOfSession(input.sessionId), null);
  const stopped = await call({ operation: 'control', executionId: input.executionId, requestId: randomUUID(), control: 'cancel' });
  assert.equal(stopped.execution.phase, 'stopped');
  const stillUnknown = await call({ operation: 'control', executionId: unknown.executionId, requestId: randomUUID(), control: 'cancel' });
  assert.equal(stillUnknown.execution.phase, 'uncertain');
  assert.equal(service.ownerOfSession(unknown.sessionId), null); assert.equal(persistenceOpens, 0); assert.equal(f.instances.length, 0);
  assert.deepEqual(f.logs.get(input.sessionId), original); assert.deepEqual(f.logs.get(unknown.sessionId), original);
  assert.equal((await f.rawStep({ id: input.sessionId }, [{ id: 'native-still-writable' }])).kind, 'enter');
});
