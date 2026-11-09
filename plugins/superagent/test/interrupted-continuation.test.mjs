import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { interruptedTurnClosers } from '@deepseek-ai/dsh-session';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { requestInterruptedContinuation, assertInterruptedToolsSettled, verifyInterruptedTranscript } from '../src/interrupted-continuation.mjs';
import { executionEvidence } from '../src/execution-evidence.mjs';
import { executionEffects } from '../src/execution-effects.mjs';
import { createAssignmentExecutor } from '../src/assignment-executor.mjs';
import { executionUncertainty, executionRecoverySignal } from '../src/execution-uncertainty.mjs';
import { installRoleHost, loadRolePackage } from './role-host-fixture.mjs';

const loadHost = name => loadRolePackage('core/agent-loop', name);
const { Context } = await loadHost('@deepseek-ai/cordis');
const { createScope } = await loadHost('@deepseek-ai/dsh-scope');
// Preserve the controlled recovery transcript while composing real upstream role services.
async function installContinuationRoleHost(t, ctx) {
  const host = new Context();
  t.after(() => host.fiber.dispose());
  for (const name of ['session', 'session-projection', 'system-prompt', 'tools', 'agent'])
    await host.plugin((await loadHost(`@deepseek-ai/dsh-${name}`)).default);
  await installRoleHost(host);
  for (const name of ['agentPresets', 'permissionPresets', 'sandboxPolicy', 'approval']) ctx[name] = host[name];
  ctx.agents.turnBoundaryOf = session => host.agents.turnBoundaryOf(session);
  const resume = ctx.agents.resume;
  ctx.agents.resume = input => resume({ ...input, setup: async (fixture, agent) => {
    const scope = createScope(host, {});
    t.after(() => scope.dispose());
    const snapshotEvents = agent.session.snapshotEvents;
    agent.id ??= input.resumeSessionId;
    agent.session = host.sessions.create(agent.id, { meta: input.meta });
    agent.session.snapshotEvents = snapshotEvents;
    agent.model ??= { current: () => null, select() {} };
    fixture.tools.schemas = value => host.get('tools').schemas(value);
    agent.ctx = scope.ctx.extend({ ...fixture, get: name => fixture.get?.(name) ?? scope.ctx.get(name) });
    await input.setup(agent.ctx, agent);
  } });
}

const call = (id = 'read-1', name = 'read', args = { path: 'saved.txt' }) => ({ type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'tool-call', id, name, arguments: args }] } } });
const result = (id = 'read-1', text = 'saved') => ({ type: 'tool/result', surfaceOp: 'append', data: { turn: 1, step: 1, message: { toolCallId: id, source: { kind: 'tool', callId: id }, content: [{ type: 'text', text }] } } });
const events = () => [
  { type: 'turn/start', data: { turn: 1 } }, { type: 'step/start', data: { turn: 1, step: 1 } }, call(), result(),
].map((event, seq) => ({ ...event, seq, time: 1000 }));

async function fixture(t, { persistent = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-interrupted-'));
  const filename = persistent ? join(directory, 'ledger.sqlite') : ':memory:';
  const database = createAssistantOrchestrationStore({ filename });
  t.after(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
  const work = join(directory, 'original'); await mkdir(work); await writeFile(join(work, 'saved.txt'), 'saved');
  database.createThread({ id: 'thread', source: { type: 'desktop', id: 'main' } });
  const mandate = { policyVersion: 'd1', actorId: 'desktop-owner', admission: 'desktop-approved-delegation',
    source: { channel: 'desktop', sessionId: 'main', messageId: 'original' }, controlledActions: 'require-current-policy-and-harness-approval' };
  const ticket = database.createTicket({ threadId: 'thread', target: 'produce result', mandate });
  const initial = database.createAssignment(ticket.id, {});
  const [assignment] = database.claimAssignments('original-owner', { assignmentId: initial.id, validateMandate: () => true });
  const run = database.prepareRun(assignment.id, { owner: assignment.owner, fence: assignment.fence, sessionId: 'original-session', directory: work });
  const models = [{ providerId: 'ExactProvider', modelId: 'Exact/Original', options: { maxTokens: 111 } }];
  database.freezeWorkerModelRoute({ assignmentId: assignment.id, runId: run.id, owner: assignment.owner, fence: assignment.fence, models, index: 0 });
  database.updateRun(run.id, { owner: assignment.owner, fence: assignment.fence, state: 'submitted' });
  database.updateRun(run.id, { owner: assignment.owner, fence: assignment.fence, state: 'uncertain' });
  database.renewAssignment(assignment.id, { owner: assignment.owner, fence: assignment.fence, validateMandate: () => false });
  let locked = false, closed = 0, reads = 0;
  const log = { events: events() };
  const ctx = { agents: { get: () => undefined, resume() {} }, sessionPersistence: { open: async (id, access) => {
    assert.equal(locked, false); locked = true;
    return { id, access, read: async () => { reads++; return log; }, close: async () => { locked = false; closed++; } };
  } } };
  const policy = { desktopVersion: 'd1', workerModels: [{ providerId: 'ChangedProvider', modelId: 'Changed/New' }] };
  const input = { ctx, database, assignmentId: assignment.id, fence: assignment.fence, instructionRevision: 1,
    readPolicy: async () => policy, signal: new AbortController().signal };
  return { directory, work, filename, database, ticket, assignment, run, models, log, ctx, policy, input, locked: () => locked, closed: () => closed, reads: () => reads };
}

test('official writer inspection queues the original run and freezes its identity, fence and model', async t => {
  const f = await fixture(t);
  const out = await requestInterruptedContinuation(f.input);
  assert.equal(out.state, 'queued'); assert.equal(f.closed(), 1); assert.equal(f.locked(), false);
  const [claimed] = f.database.claimAssignments('new-owner', { validateMandate: () => true });
  const [run] = f.database.runs(f.assignment.id);
  assert.equal(claimed.id, f.assignment.id); assert.equal(claimed.fence, f.assignment.fence + 1);
  assert.equal(run.id, f.run.id); assert.equal(run.sessionId, 'original-session'); assert.equal(run.state, 'prepared');
  assert.deepEqual(run.interruptedRecoveries, [{ fromFence: f.assignment.fence, instructionRevision: 1,
    sessionId: 'original-session', observation: executionEvidence(f.log).transcript, automatic: true, at: run.interruptedRecoveries[0].at }]);
  assert.deepEqual(f.database.getWorkerExecutionState(run.id).models, f.models);
  assert.equal(f.database.getTicket(f.ticket.id).resultVersion, 0);
  const repaired = [...f.log.events, ...interruptedTurnClosers(f.log.events)];
  verifyInterruptedTranscript(repaired, run.evidence);
  assert.throws(() => verifyInterruptedTranscript([...repaired, { type: 'user/message', seq: repaired.length, data: {} }], run.evidence), { code: 'EVIDENCE_MISMATCH' });
});

for (const problem of ['live', 'pending-read', 'unknown-send', 'pending-ptc', 'checkpoint', 'revoked', 'paused', 'stopped', 'completed', 'user-aborted', 'revision']) {
  test(`interrupted continuation refuses ${problem} without dispatch or a new run`, async t => {
    const f = await fixture(t);
    if (problem === 'live') f.ctx.agents.get = () => ({});
    if (problem === 'pending-read') f.log.events.pop();
    if (problem === 'pending-ptc') f.log.events.push({ seq: 4, type: 'tool/ptc-dispatch-start', data: { subCallId: 'nested', name: 'read', arguments: {} } });
    if (problem === 'unknown-send') f.log.events.push({ ...call('send', 'assistant_external_action', { operation: 'submit' }), seq: 4 }, { ...result('send', '{"state":"submitted"}'), seq: 5 });
    if (problem === 'checkpoint') f.input.checkpoints = { list: async () => [{ state: 'pending' }] };
    if (problem === 'revoked') f.policy.desktopVersion = 'd2';
    if (problem === 'paused') f.database.pauseTicket(f.ticket.id);
    if (problem === 'stopped') f.database.cancelTicket(f.ticket.id);
    if (problem === 'completed' || problem === 'user-aborted') {
      const closing = interruptedTurnClosers(f.log.events); closing.at(-1).data.reason = problem === 'completed' ? { kind: 'completed' } : { kind: 'aborted', reason: { kind: 'user' } };
      f.log.events.push(...closing);
    }
    if (problem === 'revision') f.input.instructionRevision = 2;
    await assert.rejects(requestInterruptedContinuation(f.input));
    assert.equal(f.database.runs(f.assignment.id).length, 1);
    assert.equal(f.locked(), false);
    assert.notEqual(f.database.getAssignment(f.assignment.id).state, 'queued');
  });
}

test('authorization is rechecked after the filesystem inspection and before queuing', async t => {
  const f = await fixture(t);
  f.input.readPolicy = async () => { f.database.pauseTicket(f.ticket.id); return f.policy; };
  await assert.rejects(requestInterruptedContinuation(f.input), { code: 'MANDATE_REVOKED' });
  assert.equal(f.closed(), 1);
});

test('tool evidence rejects orphan receipts, duplicate identities and unknown nested effects', () => {
  assert.throws(() => assertInterruptedToolsSettled([{ ...result(), seq: 0 }]), { code: 'EXECUTION_EFFECTS_UNKNOWN' });
  assert.throws(() => assertInterruptedToolsSettled([call(), result(), call()]), { code: 'EXECUTION_EFFECTS_UNKNOWN' });
  assert.throws(() => assertInterruptedToolsSettled([{ type: 'tool/ptc-dispatch-start', data: { subCallId: '1', name: 'send' } }, { type: 'tool/ptc-dispatch', data: { subCallId: '1', name: 'send', isError: true } }]), { code: 'EXECUTION_EFFECTS_UNKNOWN' });
});

test('a changed transcript cannot borrow the inspected continuation boundary', () => {
  const prefix = events(), saved = { ...executionEvidence({ events: prefix }), executionEffects: executionEffects({ events: prefix }) };
  const changed = structuredClone(prefix); changed[3].data.message.content[0].text = 'changed';
  assert.throws(() => verifyInterruptedTranscript([...changed, ...interruptedTurnClosers(changed)], saved), { code: 'EVIDENCE_MISMATCH' });
});

test('executor uses official resume and followup in the original session with its original model', async t => {
  const f = await fixture(t);
  await requestInterruptedContinuation(f.input);
  const [assignment] = f.database.claimAssignments('continued-owner', { validateMandate: () => true });
  const transcript = [...f.log.events, ...interruptedTurnClosers(f.log.events)];
  const hooks = new Map(), tools = new Map(), selected = []; let message, disposed = false;
  f.ctx.on = () => () => {};
  f.ctx.sessionQuery = { readSession: async () => ({ events: transcript }) };
  f.ctx.agents.create = () => assert.fail('must not create a different execution session');
  f.ctx.agents.resume = async input => {
    assert.equal(input.resumeSessionId, 'original-session');
    const agent = { id: 'original-session', session: { snapshotEvents: () => structuredClone(transcript) }, model: { select: model => selected.push(model), current: () => selected.at(-1) }, inject() {}, followup(value) {
      message = value;
      queueMicrotask(async () => {
        try {
          hooks.get('agent/status')({ status: 'running' });
          await tools.get('assistant_task_result').execute({ selfCheck: { summary: 'Verified saved file' } }, { agent, signal: f.input.signal, callId: 'self-check' });
          transcript.push({ seq: transcript.length, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'continued result' }] } } }, { seq: transcript.length + 1, type: 'turn/end', data: { reason: { kind: 'completed' } } });
          hooks.get('agent/status')({ status: 'idle' });
        } catch (error) { hooks.get('agent/error')({ error }); }
      });
    } };
    await input.setup({ tools: { register: tool => tools.set(tool.name, tool) }, effect: fn => fn(), get: () => undefined, systemPrompt: { section() {}, context() {} }, on: (name, fn) => hooks.set(name, fn) }, agent);
    return { agent, dispose: async () => { disposed = true; } };
  };
  await installContinuationRoleHost(t, f.ctx);
  const execute = createAssignmentExecutor({ ctx: f.ctx, database: f.database, workspaceRoot: f.directory, readPolicy: f.input.readPolicy, authorizeAction: async () => ({ allowed: true }) });
  const result = await execute(assignment, { ticket: f.database.getTicket(f.ticket.id), signal: f.input.signal, renew: async () => {} });
  assert.equal(message.source.kind, 'benchgo-interrupted-continuation');
  assert.equal(selected[0].provider, 'ExactProvider'); assert.equal(selected[0].model, 'Exact/Original');
  assert.equal(result.runId, f.run.id); assert.equal(result.sessionId, 'original-session'); assert.equal(result.summary, 'continued result'); assert.equal(disposed, true);
  assert.equal(f.database.getAssignment(assignment.id).interruptedContinuation, undefined, 'dispatch consumes only the queued continuation marker');
  assert.equal(f.database.runs(assignment.id)[0].interruptedRecoveries[0].fromFence, f.assignment.fence, 'the observed continuation receipt survives execution updates');
});

test('filesystem changes after queueing prevent official continuation from dispatching', async t => {
  const f = await fixture(t);
  await requestInterruptedContinuation(f.input);
  const [assignment] = f.database.claimAssignments('continued-owner', { validateMandate: () => true });
  await writeFile(join(f.work, 'saved.txt'), 'changed after inspection');
  f.ctx.on = () => () => {};
  f.ctx.sessionQuery = { readSession: async () => ({ events: f.log.events }) };
  f.ctx.agents.create = () => assert.fail('create');
  f.ctx.agents.resume = async input => {
    await input.setup({ tools: {}, systemPrompt: {}, on() {}, provide() {} }, { session: { snapshotEvents: () => [...f.log.events, ...interruptedTurnClosers(f.log.events)] } });
    assert.fail('changed artifact must never start followup');
  };
  await installContinuationRoleHost(t, f.ctx);
  const execute = createAssignmentExecutor({ ctx: f.ctx, database: f.database, workspaceRoot: f.directory, readPolicy: f.input.readPolicy, authorizeAction: async () => ({ allowed: true }) });
  await assert.rejects(execute(assignment, { ticket: f.database.getTicket(f.ticket.id), signal: f.input.signal, renew: async () => {} }), /checkpoint no longer matches/);
  assert.equal(f.database.runs(assignment.id)[0].state, 'uncertain');
});

test('pause or authorization changes between queuing and claim cannot resume work', async t => {
  const f = await fixture(t);
  await requestInterruptedContinuation(f.input);
  f.database.pauseTicket(f.ticket.id);
  assert.equal(f.database.claimAssignments('other', { validateMandate: () => true }).length, 0);
  f.database.resumeTicket(f.ticket.id);
  assert.equal(f.database.claimAssignments('other', { validateMandate: () => false }).length, 0);
});

test('inspectOnly reads official evidence and artifacts without queueing, storing evidence or creating a run', async t => {
  const f = await fixture(t), before = f.database.getAssignment(f.assignment.id), runBefore = f.database.runs(f.assignment.id)[0];
  const observed = await requestInterruptedContinuation({ ...f.input, inspectOnly: true });
  assert.equal(observed.state, 'verified-interrupted'); assert.equal(observed.runId, f.run.id);
  assert.deepEqual(observed.observation, { sessionId: 'original-session', ...executionEvidence(f.log).transcript });
  assert.deepEqual(f.database.getAssignment(f.assignment.id), before);
  assert.deepEqual(f.database.runs(f.assignment.id), [runBefore]);
  assert.equal(f.closed(), 1); assert.equal(f.locked(), false);
});

for (const invalid of ['pending', 'revoked', 'paused-during-read']) test(`inspectOnly does not accept ${invalid} and never queues execution`, async t => {
  const f = await fixture(t);
  if (invalid === 'pending') f.log.events.pop();
  if (invalid === 'revoked') f.policy.desktopVersion = 'd2';
  if (invalid === 'paused-during-read') f.input.readPolicy = async () => { f.database.pauseTicket(f.ticket.id); return f.policy; };
  await assert.rejects(requestInterruptedContinuation({ ...f.input, inspectOnly: true }));
  assert.equal(f.database.runs(f.assignment.id).length, 1);
  assert.equal(f.database.runs(f.assignment.id)[0].interruptedRecoveries, undefined);
  assert.notEqual(f.database.getAssignment(f.assignment.id).state, 'queued');
});

test('inspection audit persists a bounded idempotent receipt without changing execution ownership', async t => {
  const f = await fixture(t);
  const observed = await requestInterruptedContinuation({ ...f.input, inspectOnly: true });
  const input = { fence: f.assignment.fence, runId: f.run.id, instructionRevision: 1, id: 'manual-check-1',
    status: 'verified', code: 'VERIFIED_INTERRUPTED', observation: observed.observation };
  const receipt = f.database.recordExecutionInspection(f.assignment.id, input);
  assert.equal(receipt.attempts, 1); assert.equal(receipt.runId, f.run.id); assert.equal(receipt.fence, f.assignment.fence);
  assert.deepEqual(f.database.recordExecutionInspection(f.assignment.id, input), receipt);
  const blocked = f.database.recordExecutionInspection(f.assignment.id, { ...input, id: 'manual-check-2', status: 'blocked', code: 'private raw failure text', observation: undefined });
  assert.equal(blocked.attempts, 2); assert.equal(blocked.code, 'EVIDENCE_UNVERIFIED'); assert.equal(blocked.observation, undefined);
  assert.equal(f.database.getAssignment(f.assignment.id).state, 'uncertain');
  assert.equal(f.database.getAssignment(f.assignment.id).verificationError, undefined);
  assert.equal(f.database.runs(f.assignment.id)[0].evidence, undefined);
  assert.throws(() => f.database.recordExecutionInspection(f.assignment.id, { ...input, id: 'manual-check-2' }), { code: 'INSPECTION_CONFLICT' });
});

test('inspection audit requires the original run/fence/version and can observe pausing without resuming', async t => {
  const f = await fixture(t), observation = { sessionId: 'original-session', ...executionEvidence(f.log).transcript };
  const input = { fence: f.assignment.fence, runId: f.run.id, instructionRevision: 1, id: 'manual-check', status: 'verified', code: 'VERIFIED_PAUSED', observation };
  assert.throws(() => f.database.recordExecutionInspection(f.assignment.id, { ...input, fence: input.fence + 1 }), { code: 'FENCING_CONFLICT' });
  assert.throws(() => f.database.recordExecutionInspection(f.assignment.id, { ...input, runId: 'another' }), { code: 'FENCING_CONFLICT' });
  assert.throws(() => f.database.recordExecutionInspection(f.assignment.id, { ...input, instructionRevision: 2 }), { code: 'INSTRUCTION_REVISION_CONFLICT' });
  assert.throws(() => f.database.recordExecutionInspection(f.assignment.id, { ...input, observation: { ...observation, sessionId: 'another' } }), { code: 'EVIDENCE_MISMATCH' });
  f.database.pauseTicket(f.ticket.id);
  assert.equal(f.database.recordExecutionInspection(f.assignment.id, input).code, 'VERIFIED_PAUSED');
  assert.equal(f.database.getTicket(f.ticket.id).status, 'pausing'); assert.equal(f.database.getAssignment(f.assignment.id).state, 'uncertain');
  f.database.cancelTicket(f.ticket.id);
  assert.throws(() => f.database.recordExecutionInspection(f.assignment.id, { ...input, id: 'after-stop' }), { code: 'FENCING_CONFLICT' });
});

test('automatic continuation is bounded across fences and durable reopen, and human continuation never resets its budget', async t => {
  const f = await fixture(t, { persistent: true }), start = Date.now() + 100;
  const failAgain = at => {
    const [claimed] = f.database.claimAssignments('retry-owner', { assignmentId: f.assignment.id, now: at, validateMandate: () => true });
    assert.ok(claimed);
    f.database.updateRun(f.run.id, { owner: claimed.owner, fence: claimed.fence, state: 'submitted', now: at });
    f.database.updateRun(f.run.id, { owner: claimed.owner, fence: claimed.fence, state: 'uncertain', now: at + 100 });
    f.database.renewAssignment(claimed.id, { owner: claimed.owner, fence: claimed.fence, now: at + 100, validateMandate: () => false });
    f.input.fence = claimed.fence;
    return claimed;
  };
  await requestInterruptedContinuation({ ...f.input, now: start });
  failAgain(start);
  const pending = executionUncertainty(f.database, f.database.getTicket(f.ticket.id), { now: start + 101 });
  assert.equal(pending.continuationRetry.attempts, 1); assert.equal(pending.continuationRetry.exhausted, false);
  assert.equal(pending.continuationRetry.nextAttemptAt, new Date(start + 30100).toISOString());
  await assert.rejects(requestInterruptedContinuation({ ...f.input, now: start + 30099 }), { code: 'CONTINUATION_BACKOFF' });
  const request = f.database.deferInterruptedContinuation(f.assignment.id, { fence: f.input.fence, instructionRevision: 1, now: start + 101 });
  assert.equal(request.nextAt, start + 30100);
  const reopened = createAssistantOrchestrationStore({ filename: f.filename });
  try {
  assert.equal(reopened.takeInterruptedContinuationRequests({ now: start + 30099 }).length, 0);
  assert.equal(reopened.takeInterruptedContinuationRequests({ now: start + 30100 }).length, 1);
  assert.equal(reopened.takeInterruptedContinuationRequests({ now: start + 30100 }).length, 0, 'a deferred request is consumed once');
  await requestInterruptedContinuation({ ...f.input, database: reopened, now: start + 30100 });
  failAgain(start + 30100);
  const signal = executionRecoverySignal(reopened, reopened.getTicket(f.ticket.id), { now: start + 30201 });
  assert.equal(signal.phase, 'escalated'); assert.equal(signal.continuationRetry.exhausted, true);
  assert.match(signal.recoveryBlocked, /自动续接已达上限/);
  assert.equal(signal.continuationRetry.nextAttemptAt, null);
  await assert.rejects(requestInterruptedContinuation({ ...f.input, database: reopened, now: start + 999999 }), { code: 'CONTINUATION_LIMIT' });
  assert.equal(reopened.getAssignment(f.assignment.id).state, 'uncertain');
  await requestInterruptedContinuation({ ...f.input, database: reopened, inspectOnly: true, now: start + 30201 });
  assert.equal(reopened.getAssignment(f.assignment.id).state, 'uncertain', 'inspection does not dispatch');
  await requestInterruptedContinuation({ ...f.input, database: reopened, automatic: false, now: start + 30201 });
  const run = reopened.runs(f.assignment.id)[0];
  assert.equal(run.interruptedRecoveries.filter(row => row.automatic !== false).length, 2);
  assert.equal(run.interruptedRecoveries.at(-1).automatic, false);
  assert.equal(run.id, f.run.id); assert.equal(run.sessionId, f.run.sessionId);
  assert.deepEqual(reopened.getWorkerExecutionState(run.id).models, f.models);
  } finally { reopened.close(); }
});

test('pending delayed continuation is discarded by a pause instead of resuming after reopening', async t => {
  const f = await fixture(t), at = Date.now() + 100;
  await requestInterruptedContinuation({ ...f.input, now: at });
  const [claimed] = f.database.claimAssignments('retry-owner', { assignmentId: f.assignment.id, now: at, validateMandate: () => true });
  f.database.updateRun(f.run.id, { owner: claimed.owner, fence: claimed.fence, state: 'submitted', now: at });
  f.database.updateRun(f.run.id, { owner: claimed.owner, fence: claimed.fence, state: 'uncertain', now: at + 100 });
  f.database.renewAssignment(claimed.id, { owner: claimed.owner, fence: claimed.fence, now: at + 100, validateMandate: () => false });
  f.database.deferInterruptedContinuation(claimed.id, { fence: claimed.fence, instructionRevision: 1, now: at + 101 });
  f.database.pauseTicket(f.ticket.id, { now: at + 102 });
  assert.equal(f.database.takeInterruptedContinuationRequests({ now: at + 999999 }).length, 0);
  assert.equal(f.database.getAssignment(claimed.id).interruptedContinuationRequest, undefined);
});

test('a consumed deferred continuation with an unavailable official writer leaves bounded failure receipts and retry progress', async t => {
  const f = await fixture(t), at = Date.now() + 100;
  f.ctx.sessionPersistence.open = async () => { throw Object.assign(new Error('private writer-lock failure'), { code: 'SESSION_UNAVAILABLE' }); };
  await assert.rejects(requestInterruptedContinuation({ ...f.input, now: at }), { code: 'SESSION_UNAVAILABLE' });
  const originalUpdatedAt = f.database.runs(f.assignment.id)[0].updatedAt;
  let fact = executionUncertainty(f.database, f.database.getTicket(f.ticket.id), { now: at });
  assert.equal(fact.continuationRetry.attempts, 1); assert.equal(fact.continuationRetry.nextAttemptAt, new Date(at + 30000).toISOString());
  f.database.deferInterruptedContinuation(f.assignment.id, { fence: f.input.fence, instructionRevision: 1, now: at + 1 });
  // Read-only checks do not mutate the original execution time or retry deadline.
  f.database.recordExecutionInspection(f.assignment.id, { fence: f.input.fence, runId: f.run.id, instructionRevision: 1,
    id: 'lock-inspection', status: 'blocked', code: 'SESSION_UNAVAILABLE', now: at + 1000 });
  assert.equal(f.database.runs(f.assignment.id)[0].updatedAt, originalUpdatedAt);
  fact = executionUncertainty(f.database, f.database.getTicket(f.ticket.id), { now: at + 1000 });
  assert.equal(fact.continuationRetry.nextAttemptAt, new Date(at + 30000).toISOString());
  const [request] = f.database.takeInterruptedContinuationRequests({ now: at + 30000 });
  assert.ok(request);
  await assert.rejects(requestInterruptedContinuation({ ...f.input, ...request, now: at + 30000 }), { code: 'SESSION_UNAVAILABLE' });
  const run = f.database.runs(f.assignment.id)[0];
  assert.equal(run.interruptedRecoveries.length, 2); assert.ok(run.interruptedRecoveries.every(row => row.queued === false));
  assert.equal(executionRecoverySignal(f.database, f.database.getTicket(f.ticket.id)).phase, 'escalated');
  await assert.rejects(requestInterruptedContinuation({ ...f.input, now: at + 999999 }), { code: 'CONTINUATION_LIMIT' });
  assert.equal(f.database.getAssignment(f.assignment.id).state, 'uncertain');
});

for (const intervention of ['revoked', 'revision', 'paused', 'stopped']) test(`user intervention ${intervention} does not consume automatic continuation budget`, async t => {
  const f = await fixture(t);
  f.input.readPolicy = async () => {
    if (intervention === 'revoked') f.policy.desktopVersion = 'new-policy';
    if (intervention === 'revision') f.database.updateTicket(f.ticket.id, { target: 'new version' }, { expectedInstructionRevision: 1 });
    if (intervention === 'paused') f.database.pauseTicket(f.ticket.id);
    if (intervention === 'stopped') f.database.cancelTicket(f.ticket.id);
    return f.policy;
  };
  await assert.rejects(requestInterruptedContinuation(f.input));
  assert.equal(f.database.runs(f.assignment.id)[0].interruptedRecoveries, undefined);
});

test('automatic inspection timeouts consume the same bounded budget while shutdown abort does not', async t => {
  const f = await fixture(t), at = Date.now() + 100;
  const open = f.ctx.sessionPersistence.open;
  f.ctx.sessionPersistence.open = async (...args) => {
    const handle = await open(...args), signal = args[2].signal;
    return { ...handle, async read() { await new Promise(resolve => setTimeout(resolve, 15)); signal.throwIfAborted(); } };
  };
  for (const now of [at, at + 30000]) {
    await assert.rejects(requestInterruptedContinuation({ ...f.input, now, signal: AbortSignal.timeout(5) }), { name: 'TimeoutError' });
  }
  const run = f.database.runs(f.assignment.id)[0];
  assert.equal(run.interruptedRecoveries.length, 2);
  assert.ok(run.interruptedRecoveries.every(row => row.queued === false && row.code === 'TIMEOUT'));
  assert.equal(executionRecoverySignal(f.database, f.database.getTicket(f.ticket.id)).phase, 'escalated');
  assert.equal(f.database.getAssignment(f.assignment.id).state, 'uncertain');
  await assert.rejects(requestInterruptedContinuation({ ...f.input, now: at + 60000 }), { code: 'CONTINUATION_LIMIT' });

  const shutdown = await fixture(t), controller = new AbortController();
  const shutdownOpen = shutdown.ctx.sessionPersistence.open;
  shutdown.ctx.sessionPersistence.open = async (...args) => {
    const handle = await shutdownOpen(...args);
    return { ...handle, async read() { controller.abort(); controller.signal.throwIfAborted(); } };
  };
  await assert.rejects(requestInterruptedContinuation({ ...shutdown.input, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(shutdown.database.runs(shutdown.assignment.id)[0].interruptedRecoveries, undefined);
});
