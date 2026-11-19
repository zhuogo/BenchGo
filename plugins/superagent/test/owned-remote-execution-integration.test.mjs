import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { createRemoteAssignmentExecutor } from '../src/remote-assignment-executor.mjs';
import { commitWorkerResult } from '../src/result-commit.mjs';
import { createRemoteExecutionService } from '../../harness/src/remote-execution.mjs';
import { remoteExecutionFixture } from '../../harness/test/fixtures/remote-execution.mjs';
import { Commander } from '../../harness/src/runtime.mjs';
import { fixtureRouteService } from '../../harness/test/fixtures/api-route.mjs';
import { readNativeWorkerSession } from '../src/execution-session.mjs';

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
  const database = createAssistantOrchestrationStore({ filename: ':memory:', ownerHostId: 'host-A' });
  let clock = Date.now();
  const calls = [], execution = { deviceId: 'device-B', hostId: 'host-B', authorizationId: 'A-B-grant', protocolVersion: 2, config };
  const ctx = { logger: { warn() {} }, get: name => name === 'benchgoLink' ? { callDevice: async input => {
    assert.equal(input.expectedHostId, execution.hostId); assert.equal(input.expectedAuthorizationId, execution.authorizationId);
    calls.push(structuredClone(input.input));
    return peer.dispatch(input.input, { principal: { kind: 'device', deviceId: 'B-sees-A' }, signal: input.signal, hostId: execution.hostId });
  } } : undefined };
  const source = { channel: 'desktop', sessionId: 'owner-session', threadId: 'main', messageId: 'initial' };
  const mandate = { source, actorId: 'desktop-owner', admission: 'desktop-approved-delegation', instruction: 'do the work',
    controlledActions: 'require-current-policy-and-harness-approval', policyVersion: 'policy', execution };
  database.createThread({ id: 'desktop:owner-session', source: { type: 'desktop', id: source.sessionId } });
  const task = database.createTask({ threadId: 'desktop:owner-session', target: 'do the work', acceptance: 'verified result', mandate });
  database.createAssignment(task.id, { executor: 'remote', execution, text: task.target });
  const [assignment] = database.claimAssignments('initial-worker', { validateMandate: () => true });
  const create = () => createRemoteAssignmentExecutor({ ctx, database, now: () => clock, pollMs: 10,
    readPolicy: async () => ({ desktopVersion: 'policy' }), commitResult: async (result, { assignment, task }) => commitWorkerResult({
      database, result, assignment, task, uniqueKey: `assignment-result:${assignment.id}:${result.runId}:${assignment.fence}` }) });
  let owner = create();
  t.after(async () => { await owner.stop(); await peer.close(); await commander?.close(); database.close(); await rm(directory, { recursive: true, force: true }); });
  const human = (text, key) => database.ingest({ dedupeKey: key, thread: { id: 'desktop:owner-session', source: { type: 'desktop', id: source.sessionId } },
    source: { ...source, messageId: key }, actor: { kind: 'human', id: 'desktop-owner' }, content: text, mode: 'direct' }).trigger;
  await owner.execute(assignment, { task });
  if (!external) await waitFor(() => official.instances[0]?.pending.length);
  return { ctx, commander, database, peer, official, task, assignment, calls, human,
    get owner() { return owner; },
    async tick() { clock += 100000; await owner.tick(); },
    async restartOwner() { await owner.stop(); owner = create(); },
    revise(revision) {
      const trigger = human(`owner revision ${revision}`, `revision-${revision}`);
      database.changeTask(task.id, { operation: 'revise', expectedInstructionRevision: revision - 1,
        target: `do the work version ${revision}`, acceptance: 'verified result', reason: 'owner instruction', requestKey: `revision-${revision}`,
        triggerId: trigger.id, mandate: { ...mandate, source: { ...source, messageId: `revision-${revision}` }, instruction: trigger.content },
        model: execution.config.models[0], validateMandate: () => true });
    },
  };
}

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

test('actual B context and question inputs are applied only at their official boundaries', async t => {
  const app = await fixture(t), instance = app.official.instances[0]; await instance.step(); await app.tick();
  const trigger = app.human('additional factual context', 'context');
  app.database.recordTaskInput({ taskId: app.task.id, triggerId: trigger.id, kind: 'context', idempotencyKey: 'context' });
  await app.tick();
  assert.equal(app.database.taskInputs(app.task.id).find(row => row.triggerId === trigger.id).state, 'pending');
  await instance.step(); await app.tick();
  assert.equal(app.database.taskInputs(app.task.id).find(row => row.triggerId === trigger.id).state, 'applied');
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
