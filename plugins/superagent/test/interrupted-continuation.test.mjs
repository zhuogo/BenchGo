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
    agent.session = host.sessions.create(agent.id, { meta: input.meta || { cwd: agent.session.header?.cwd } });
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
    sessionId: 'original-session', observation: executionEvidence(f.log).transcript, at: run.interruptedRecoveries[0].at }]);
  assert.deepEqual(f.database.getWorkerExecutionState(run.id).models, f.models);
  assert.equal(f.database.getTicket(f.ticket.id).resultVersion, 0);
  const repaired = [...f.log.events, ...interruptedTurnClosers(f.log.events)];
  verifyInterruptedTranscript(repaired, run.evidence);
  assert.throws(() => verifyInterruptedTranscript([...repaired, { type: 'user/message', seq: repaired.length, data: {} }], run.evidence), { code: 'EVIDENCE_MISMATCH' });
});

for (const problem of ['live', 'pending-read', 'unknown-send', 'pending-ptc', 'revoked', 'paused', 'stopped', 'completed', 'user-aborted', 'revision']) {
  test(`interrupted continuation refuses ${problem} without dispatch or a new run`, async t => {
    const f = await fixture(t);
    if (problem === 'live') f.ctx.agents.get = () => ({});
    if (problem === 'pending-read') f.log.events.pop();
    if (problem === 'pending-ptc') f.log.events.push({ seq: 4, type: 'tool/ptc-dispatch-start', data: { subCallId: 'nested', name: 'read', arguments: {} } });
    if (problem === 'unknown-send') f.log.events.push({ ...call('send', 'assistant_external_action', { operation: 'submit' }), seq: 4 }, { ...result('send', '{"state":"submitted"}'), seq: 5 });
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

test('authorization is rechecked after session inspection and before queuing', async t => {
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
  // User edits and unrelated large files must not block the original session.
  await writeFile(join(f.work, 'saved.txt'), 'user changed after inspection');
  const { open } = await import('node:fs/promises');
  const large = await open(join(f.work, 'unrelated-build.tar'), 'w');
  try { await large.truncate(600 * 1024 * 1024); } finally { await large.close(); }
  const transcript = [...f.log.events, ...interruptedTurnClosers(f.log.events)];
  const hooks = new Map(), tools = new Map(), selected = []; let message, disposed = false;
  f.ctx.on = () => () => {};
  f.ctx.sessionQuery = { readSession: async () => ({ events: transcript }) };
  f.ctx.agents.create = () => assert.fail('must not create a different execution session');
  f.ctx.agents.resume = async input => {
    assert.equal(input.resumeSessionId, 'original-session');
    const agent = { id: 'original-session', session: { header: { cwd: f.work }, snapshotEvents: () => structuredClone(transcript) }, model: { select: model => selected.push(model), current: () => selected.at(-1) }, inject() {}, followup(value) {
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
  assert.equal(Object.hasOwn(result, 'checkpoint'), false);
  assert.equal(f.database.getAssignment(assignment.id).interruptedContinuation, undefined, 'dispatch consumes only the queued continuation marker');
  assert.equal(f.database.runs(assignment.id)[0].interruptedRecoveries[0].fromFence, f.assignment.fence, 'the observed continuation receipt survives execution updates');
});

test('working directory identity changes still prevent official continuation', async t => {
  const f = await fixture(t);
  await requestInterruptedContinuation(f.input);
  const [assignment] = f.database.claimAssignments('continued-owner', { validateMandate: () => true });
  f.ctx.on = () => () => {};
  f.ctx.sessionQuery = { readSession: async () => ({ events: f.log.events }) };
  f.ctx.agents.create = () => assert.fail('create');
  f.ctx.agents.resume = async input => {
    await input.setup({ tools: {}, systemPrompt: {}, on() {}, provide() {} }, { session: { header: { cwd: f.directory }, snapshotEvents: () => [...f.log.events, ...interruptedTurnClosers(f.log.events)] } });
    assert.fail('changed working directory must never start followup');
  };
  await installContinuationRoleHost(t, f.ctx);
  const execute = createAssignmentExecutor({ ctx: f.ctx, database: f.database, workspaceRoot: f.directory, readPolicy: f.input.readPolicy, authorizeAction: async () => ({ allowed: true }) });
  await assert.rejects(execute(assignment, { ticket: f.database.getTicket(f.ticket.id), signal: f.input.signal, renew: async () => {} }), /working directory changed/);
  assert.equal(f.database.runs(assignment.id)[0].state, 'prepared');
});

test('pause or authorization changes between queuing and claim cannot resume work', async t => {
  const f = await fixture(t);
  await requestInterruptedContinuation(f.input);
  f.database.pauseTicket(f.ticket.id);
  assert.equal(f.database.claimAssignments('other', { validateMandate: () => true }).length, 0);
  f.database.resumeTicket(f.ticket.id);
  assert.equal(f.database.claimAssignments('other', { validateMandate: () => false }).length, 0);
});
