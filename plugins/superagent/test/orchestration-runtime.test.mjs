import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAssistantStore } from '../src/store.mjs';
import { readAssessmentPolicy } from '../src/assessment-policy.mjs';
import { createOrchestrationRuntime } from '../src/orchestration-runtime.mjs';
import { executionEvidence } from '../src/execution-evidence.mjs';

async function fixture(t, { send, execute, onDelivered, prepareTicketReply, channel = 'desktop', ctx = {}, now, result: patch = {} } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-direct-delivery-'));
  const store = await createAssistantStore({ dataDirectory: directory });
  if (channel === 'feishu') store.connections.update({ enabled: true, appId: 'app', appSecretRef: 'env:SECRET', ownerOpenIds: ['owner'], chatIds: ['chat'] }, { revision: 0 });
  const policy = await readAssessmentPolicy(store);
  const source = channel === 'desktop' ? { channel, sessionId: 'owner-session', messageId: 'original', threadId: 'main' }
    : { channel, sourceType: 'direct', appId: 'app', chatId: 'chat', conversationId: 'chat', messageId: 'original' };
  const db = store.orchestration;
  db.createThread({ id: 'thread', source: { type: 'desktop', id: 'owner-session' } });
  const ticket = db.createTicket({ threadId: 'thread', title: '测试交付', target: '给出纯文本成果', mandate: { source, actorId: channel === 'desktop' ? 'desktop-owner' : 'owner', ...(channel === 'desktop' ? { admission: 'desktop-approved-delegation' } : {}), policyVersion: channel === 'desktop' ? policy.desktopVersion : policy.version, controlledActions: 'require-current-policy-and-harness-approval' } });
  db.createAssignment(ticket.id, { id: 'work', executor: 'harness', model: { providerId: 'opaque provider', modelId: 'opaque/model' } });
  let executions = 0, sends = 0;
  const original = '  完整原文\n\n纯文本不要求产物文件。\n';
  const deliver = async delivery => { sends++; return send ? send(delivery, db) : { status: 'accepted', messageId: 'durable-message' }; };
  const runtime = createOrchestrationRuntime({ ctx: { llm: { stream() { throw new Error('No content review model may be called'); } }, ...ctx }, store, onDelivered, ...(now ? { now } : {}),
    prepareTicketReply: async delivery => prepareTicketReply ? prepareTicketReply(delivery, db, store) : { status: 'ready', text: '已完成，我整理好了结果。' },
    execute: async (assignment, context) => { executions++; return execute ? execute(assignment, context, db) : { summary: original, completion: { kind: 'completed' }, evidenceRefs: [], ...patch }; },
    deliverDesktop: deliver,
    ...(channel === 'feishu' ? { feishu: { send: async input => deliver({ payload: input, ticketId: ticket.id }) } } : {}),
  });
  t.after(async () => { await runtime.stop(); await store.close(); await rm(directory, { recursive: true, force: true }); });
  const advance = async () => { for (let i = 0; i < 30; i++) { await runtime.tick(); await new Promise(resolve => setTimeout(resolve, 2)); if (sends || db.getAssignment('work').state === 'uncertain') break; } };
  return { runtime, db, store, ticket, source, original, advance, counts: () => ({ executions, sends }) };
}

test('execution evidence remains readable before a Ticket has an Assignment', async t => {
  const app = await fixture(t);
  const ticket = app.db.createTicket({ threadId: 'thread', title: '等待安排', target: '尚未开始执行', mandate: app.ticket.mandate });
  const evidence = app.runtime.executionFacts.evidence({ ticketId: ticket.id });
  assert.equal(evidence.runtime.assignment, null);
  assert.equal(evidence.runtime.run, null);
  assert.equal(evidence.runtime.stop.confirmedAt, null);
  assert.equal(app.runtime.executionFacts.evidenceSnapshot().executions.find(row => row.ticket.id === ticket.id).stop.confirmedAt, null);
});

test('missing Worker configuration is a concrete scheduling blocker that clears after configuration returns', async t => {
  const app = await fixture(t);
  const ticket = app.db.createTicket({ threadId: 'thread', target: '等待配置恢复后执行', mandate: app.ticket.mandate });
  const getConfig = app.store.getConfig, config = await getConfig();
  let models = [];
  app.store.getConfig = async () => ({ ...config, models: [], workerModels: models });
  await app.runtime.tick();
  assert.equal(app.db.getTicket(ticket.id).status, 'waiting');
  assert.equal(app.db.getTicket(ticket.id).continuationWait.code, 'WORKER_MODEL_ROUTE');
  assert.match(app.db.getTicket(ticket.id).continuationWait.reason, /模型设置/);
  assert.equal(app.db.assignments(ticket.id).length, 0);
  models = [{ providerId: 'exact-provider', modelId: 'opaque/exact-model' }];
  await app.runtime.tick();
  assert.notEqual(app.db.getTicket(ticket.id).status, 'waiting');
  assert.equal(app.db.getTicket(ticket.id).continuationWait, null);
  assert.equal(app.db.assignments(ticket.id).length, 1);
  app.store.getConfig = getConfig;
});

test('scheduler heartbeat advances only after a real successful control cycle, never on reads or failed/hung cycles', async t => {
  let clock = Date.now();
  const app = await fixture(t, { now: () => clock });
  // Pending scheduling requires policy. An idle cycle no longer reads policy.
  app.db.createTicket({ threadId: 'thread', target: '待模型配置恢复', mandate: app.ticket.mandate });
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

test('idle cycles avoid configuration reads and completed Ticket scans, then wake for new work', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-idle-runtime-'));
  const store = await createAssistantStore({ dataDirectory: directory });
  let reads = 0, scans = 0;
  const getConfig = store.getConfig.bind(store), listTickets = store.orchestration.listTickets.bind(store.orchestration);
  store.getConfig = (...args) => { reads++; return getConfig(...args); };
  store.orchestration.listTickets = (...args) => { scans++; return listTickets(...args); };
  const runtime = createOrchestrationRuntime({ ctx: {}, store, execute: async () => ({ summary: 'done' }) });
  t.after(async () => { await runtime.stop(); await store.close(); await rm(directory, { recursive: true, force: true }); });
  for (let i = 0; i < 3; i++) await runtime.tick();
  assert.equal(reads, 0);
  assert.equal(scans, 0);
  assert.equal(runtime.executionFacts.snapshot().publicChatNotifications, true);
  const scansBeforeWake = scans;
  store.orchestration.createThread({ id: 'thread', source: { type: 'desktop', id: 'owner' } });
  store.orchestration.createTicket({ threadId: 'thread', target: '新任务', mandate: {} });
  await runtime.tick();
  assert.equal(reads, 1);
  assert.equal(scans, scansBeforeWake, 'new work does not scan completed Tickets');
});

test('Router state reporting leaves the outbox pending without emitting a fixed error block or rerunning work', async t => {
  let reports = 0;
  const app = await fixture(t, { execute() { throw Object.assign(new Error('not public'), { code: 'NETWORK' }); },
    prepareTicketReply: async () => { reports++; return { status: 'pending' }; } });
  await app.advance(); await app.runtime.tick();
  assert.equal(reports, 1);
  assert.deepEqual(app.counts(), { executions: 1, sends: 0 });
  assert.equal(app.db.deliveries(app.ticket.id)[0].state, 'queued');
  assert.equal(app.db.getTicket(app.ticket.id).status, 'waiting');
});

test('failed Router report stays pending without a fixed fallback or another Worker run', async t => {
  const app = await fixture(t, { execute() { throw Object.assign(new Error('not public'), { code: 'NETWORK' }); },
    prepareTicketReply: async () => ({ status: 'failed', reason: 'router-unavailable' }) });
  await app.advance(); await app.runtime.tick(); await app.runtime.tick();
  assert.deepEqual(app.counts(), { executions: 1, sends: 0 });
  const delivered = app.db.deliveries(app.ticket.id)[0];
  assert.equal(delivered.state, 'queued');
  assert.equal(delivered.receipt, null);
  assert.equal(app.db.getTicket(app.ticket.id).status, 'waiting');
  assert.equal(app.db.results(app.ticket.id).length, 0);
});

test('persisted Router report completes only its state delivery, never closes the task', async t => {
  const app = await fixture(t, { execute() { throw Object.assign(new Error('not public'), { code: 'NETWORK' }); },
    prepareTicketReply: async () => ({ status: 'ready', text: '执行记录已保留，我会等恢复条件具备后继续。', messageId: 'router-report:state' }) });
  await app.advance(); await app.runtime.tick();
  assert.deepEqual(app.counts(), { executions: 1, sends: 1 });
  assert.equal(app.db.deliveries(app.ticket.id)[0].state, 'sent');
  assert.equal(app.db.getTicket(app.ticket.id).status, 'waiting');
});

test('saved zero-file result is expressed by Router and completes before original-source receipt', async t => {
  const app = await fixture(t, { send(delivery, db) {
    assert.equal(db.getTicket(delivery.ticketId).status, 'completed');
    assert.equal(db.getTicket(delivery.ticketId).archived, false, 'saved results are not archived before a trusted delivery receipt');
    assert.equal(delivery.payload.publication.origin, 'router');
    assert.equal(delivery.payload.text, '已完成，我整理好了结果。');
    assert.deepEqual(delivery.payload.source, app.source);
    return { status: 'accepted', messageId: 'durable-message' };
  } });
  await app.advance();
  assert.equal(app.db.getTicket(app.ticket.id).status, 'completed');
  assert.equal(app.db.getTicket(app.ticket.id).archived, false);
  assert.equal(app.runtime.state({ archived: false }).length, 1);
  assert.equal(app.runtime.state({ archived: true }).length, 0);
  assert.equal(app.runtime.state({ ticketId: app.ticket.id })[0].results[0].summary, app.original, 'archived detail reads the same result and ticket');
  assert.equal(app.runtime.state({ ticketId: 'missing-ticket' }).length, 0);
  assert.equal(app.db.results(app.ticket.id).length, 1);
  assert.equal(app.db.results(app.ticket.id)[0].summary, app.original);
  assert.deepEqual(app.counts(), { executions: 1, sends: 1 });
  assert.equal(app.runtime.retryReview, undefined);
  assert.equal(app.db.queueReviewContinuation, undefined);
});

test('known desktop persistence failure retries only saved result, never Worker', async t => {
  const app = await fixture(t, { send() { throw new Error('desktop persistent store unavailable'); } });
  await app.advance();
  assert.equal(app.db.getTicket(app.ticket.id).status, 'completed');
  assert.equal(app.db.deliveries(app.ticket.id)[0].state, 'queued');
  assert.deepEqual(app.counts(), { executions: 1, sends: 1 });
  // A transport retry is the same outbox record, not a new Assignment.
  const [retry] = app.db.claimOutbox('retry', { now: Date.now() + 31000 });
  app.db.finishOutbox(retry.id, { owner: 'retry', sent: true, receipt: { status: 'accepted', messageId: 'recovered' }, now: Date.now() + 31001 });
  await app.advance();
  assert.equal(app.db.getTicket(app.ticket.id).status, 'completed');
  assert.deepEqual(app.counts(), { executions: 1, sends: 1 });
});

test('Router model failure retains Worker result and same outbox without sending raw text', async t => {
  let clock, generations = 0;
  // Worker commits use wall time. Freeze only after its outbox is claimed,
  // so slow fixture setup cannot place the initial delivery in the future.
  const app = await fixture(t, { now: () => clock ?? Date.now(), prepareTicketReply(delivery, db) {
    clock ??= Date.now();
    generations++;
    assert.equal(delivery.payload.text, undefined);
    assert.equal(delivery.payload.publication, undefined);
    assert.equal(db.results(delivery.ticketId)[0].summary, app.original);
    return { status: 'failed', reason: 'provider-unavailable' };
  } });
  await app.advance();
  const original = app.db.deliveries(app.ticket.id)[0];
  assert.equal(original.state, 'queued');
  assert.equal(original.attempts, 1);
  assert.equal(generations, 1);
  assert.equal(original.nextAt, clock + 30000);
  assert.equal(app.db.getTicket(app.ticket.id).status, 'completed');
  clock = original.nextAt - 1; await app.runtime.tick();
  assert.equal(generations, 1);
  assert.equal(app.db.deliveries(app.ticket.id)[0].attempts, 1);
  clock = original.nextAt; await app.runtime.tick();
  assert.equal(app.db.deliveries(app.ticket.id)[0].id, original.id);
  assert.equal(app.db.deliveries(app.ticket.id)[0].attempts, 2);
  assert.equal(generations, 2);
  assert.deepEqual(app.counts(), { executions: 1, sends: 0 });
});

test('transport retry uses durable Router text and never generates another reply or Worker result', async t => {
  let clock, generations = 0, sends = 0;
  const texts = [];
  const app = await fixture(t, { now: () => clock ?? Date.now(),
    prepareTicketReply() { clock ??= Date.now(); generations++; return { status: 'ready', text: '整理好了：这是完整的自然回复。', messageId: 'router-result' }; },
    send(delivery) {
      texts.push(delivery.payload.text);
      if (++sends === 1) throw new Error('desktop store temporarily unavailable');
      return { status: 'accepted', messageId: 'finally-saved' };
    } });
  await app.advance();
  const saved = app.db.deliveries(app.ticket.id)[0];
  assert.equal(saved.state, 'queued');
  assert.equal(saved.attempts, 1);
  assert.equal(saved.nextAt, clock + 30000);
  assert.equal(saved.payload.routerMessageId, 'router-result');
  clock = saved.nextAt - 1; await app.runtime.tick();
  assert.equal(sends, 1);
  assert.equal(app.db.deliveries(app.ticket.id)[0].attempts, 1);
  clock = saved.nextAt; await app.runtime.tick();
  assert.equal(app.db.deliveries(app.ticket.id)[0].id, saved.id);
  assert.equal(app.db.deliveries(app.ticket.id)[0].attempts, 2);
  assert.equal(app.db.getTicket(app.ticket.id).status, 'completed');
  assert.deepEqual(texts, ['整理好了：这是完整的自然回复。', '整理好了：这是完整的自然回复。']);
  assert.equal(generations, 1);
  assert.deepEqual(app.counts(), { executions: 1, sends: 2 });
});

test('reply preparation exceptions retain bounded diagnostic identity without leaking content or rerunning Worker', async t => {
  const warnings = [];
  const app = await fixture(t, { ctx: { logger: { warn: text => warnings.push(text) } },
    prepareTicketReply() { throw Object.assign(new Error('PRIVATE PROVIDER CONTENT'), { code: 'SESSION_DEPENDENCY_MISSING' }); } });
  await app.advance();
  const row = app.db.deliveries(app.ticket.id)[0];
  assert.equal(row.state, 'queued');
  assert.match(row.lastError, /Router 回复准备失败.*SESSION_DEPENDENCY_MISSING/);
  assert.doesNotMatch(JSON.stringify({ row, warnings }), /PRIVATE PROVIDER CONTENT/);
  assert.deepEqual(warnings, ['SuperAgent ticket reply prepare failed: SESSION_DEPENDENCY_MISSING']);
  assert.deepEqual(app.counts(), { executions: 1, sends: 0 });
});

test('natural reply returns through authenticated source channel instead of desktop', async t => {
  const app = await fixture(t, { channel: 'feishu', send(delivery) {
    assert.deepEqual(delivery.payload.source, app.source);
    assert.equal(delivery.payload.text, '已完成，我整理好了结果。');
    assert.equal(typeof delivery.payload.idempotencyKey, 'string');
    return { status: 'accepted', messageId: 'feishu-confirmed' };
  } });
  await app.advance();
  assert.equal(app.db.getTicket(app.ticket.id).status, 'completed');
  assert.deepEqual(app.counts(), { executions: 1, sends: 1 });
});

test('completed result delivery does not rerun task admission when connection configuration changes', async t => {
  const app = await fixture(t, { channel: 'feishu', prepareTicketReply(_delivery, _db, store) {
    store.connections.update({ enabled: false }, { revision: store.connections.read().revision });
    return { status: 'ready', text: '已经整理好了。' };
  } });
  await app.advance();
  const row = app.db.deliveries(app.ticket.id)[0];
  // The original source adapter owns delivery availability; global execution
  // admission changes do not discard the already completed result.
  assert.equal(row.receipt.status, 'accepted');
  assert.equal(app.db.getTicket(app.ticket.id).status, 'completed');
  assert.deepEqual(app.counts(), { executions: 1, sends: 1 });
});

test('normal Worker completion retains effect diagnostics without blocking completion or rerunning', async t => {
  const app = await fixture(t, { result: { executionEffects: { effectsVerified: false, unknownCallIds: ['send'] } } });
  await app.advance(); await app.advance();
  assert.equal(app.db.getTicket(app.ticket.id).status, 'completed');
  assert.equal(app.db.results(app.ticket.id).length, 1);
  assert.equal(app.db.results(app.ticket.id)[0].executionEffects.effectsVerified, false);
  assert.equal(app.counts().executions, 1);
});

test('confirmed delivery stays completed while mirror retries and never archives automatically', async t => {
  let mirrors = 0, archives = 0, clock;
  const app = await fixture(t, { now: () => clock ?? Date.now(),
    ctx: { workspaceRegistry: { list: () => [], async archiveSession(sessionId) { assert.equal(sessionId, 'execution'); if (++archives === 1) throw new Error('official activity still releasing'); } } },
    onDelivered(row) { clock ??= Date.now(); assert.equal(row.state, 'sent'); if (++mirrors === 1) throw new Error('conversation persistence unavailable'); },
    execute(assignment, _context, db) {
      const identity = { owner: assignment.owner, fence: assignment.fence };
      const run = db.prepareRun(assignment.id, { ...identity, sessionId: 'execution', directory: 'fixture' });
      db.updateRun(run.id, { ...identity, state: 'submitted' });
      const result = { runId: run.id, sessionId: 'execution', summary: 'original', completion: { kind: 'completed' }, evidenceRefs: [] };
      db.updateRun(run.id, { ...identity, state: 'verifying', evidence: result });
      return result;
    },
  });
  await app.advance(); await app.runtime.tick();
  assert.equal(app.db.getTicket(app.ticket.id).status, 'completed');
  assert.equal(app.db.deliveries(app.ticket.id)[0].state, 'sent');
  assert.deepEqual(app.db.sentDeliveries(), app.db.listTickets({ limit: 1000 }).flatMap(ticket => app.db.deliveries(ticket.id))
    .filter(row => row.state === 'sent' && row.receipt?.status === 'accepted' && row.receipt.messageId));
  assert.equal(mirrors, 1); assert.equal(archives, 0);
  clock += 31000;
  await app.runtime.tick(); await app.runtime.tick();
  assert.equal(mirrors, 2); assert.equal(archives, 0);
  assert.deepEqual(app.counts(), { executions: 1, sends: 1 });
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
  const ticket = app.db.getTicket(app.ticket.id), assignment = app.db.getAssignment('work');
  const input = { ticketId: ticket.id, assignmentId: assignment.id, fence: assignment.fence, instructionRevision: ticket.instructionRevision };
  const state = app.runtime.state({ ticketId: ticket.id })[0];
  assert.equal(state.execution.uncertainty.reasonCode, 'session-interrupted');
  assert.equal(state.execution.instructionRevision, ticket.instructionRevision);
  await assert.rejects(app.runtime.manageExecution({ ...input, operation: 'wait' }), /Only explicit/);
  await assert.rejects(app.runtime.manageExecution({ ...input, operation: 'resume' }));
  await assert.rejects(app.runtime.manageExecution({ ...input, operation: 'fail' }), /Only explicit/);
  await app.runtime.tick(); assert.equal(app.counts().executions, 1);
  assert.equal(app.db.results(ticket.id).length, 0);
  await assert.rejects(app.runtime.manageExecution({ ...input, instructionRevision: input.instructionRevision + 1, operation: 'check-now' }), /授权或要求已变化/);
  assert.equal((await app.runtime.manageExecution({ ...input, fence: assignment.fence + 1, operation: 'check-now' })).status, 'blocked');
});

test('ordinary setup failure stops with its cause instead of fabricating unresolved external effects', async t => {
  const app = await fixture(t, { execute() { throw Object.assign(new Error('required execution configuration unavailable'), { code: 'ROLE_PRESET_UNAVAILABLE' }); } });
  await app.advance();
  const assignment = app.db.getAssignment('work'), ticket = app.db.getTicket(app.ticket.id);
  assert.equal(assignment.state, 'failed');
  assert.equal(assignment.firstFailure.message, 'required execution configuration unavailable');
  assert.equal(assignment.firstFailure.effects.effectsVerified, true);
  assert.equal(ticket.continuationWait.code, 'EXECUTION_FAILED');
  assert.equal(ticket.continuationWait.reason, assignment.firstFailure.message);
  const state = app.runtime.state({ ticketId: ticket.id })[0];
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
  assert.equal(app.db.getTicket(app.ticket.id).status, 'running');
  await app.runtime.tick();
  assert.equal(app.db.getTicket(app.ticket.id).status, 'completed');
  assert.equal(app.db.getTicket(app.ticket.id).resultVersion, 1);
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
    assert.equal(app.db.getTicket(app.ticket.id).status, 'running');
    await app.runtime.tick();
    assert.equal(app.db.getTicket(app.ticket.id).status, 'completed');
    assert.equal(app.db.results(app.ticket.id).length, stage === 'commit' ? 2 : 1, 'retain the provisional draft and its later known completion');
    assert.equal(app.db.results(app.ticket.id).at(-1).summary, '真实完成的结果');
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
    assert.equal(app.db.getTicket(app.ticket.id).status, 'running');
    assert.equal(app.db.results(app.ticket.id)[0].summary, recoveryEvents[0].data.message.content[0].text);
    await app.runtime.tick(); assert.equal(reads, attempt);
    clock = recovery.nextAttemptAt + 1;
  }
  available = true; await app.runtime.tick();
  assert.equal(app.db.getTicket(app.ticket.id).status, 'completed');
  assert.equal(app.counts().executions, 0);
  assert.doesNotMatch(JSON.stringify(app.runtime.state()), /PRIVATE STORAGE CONTENT/);
});

test('official end seeds and changed evidence never reject an already produced normal result', async t => {
  const app = await fixture(t, { ctx: recoveryContext(() => ({ events: [...recoveryEvents, { seq: 2, type: 'session/end-seed' }] })) });
  const [assignment] = app.db.claimAssignments('old-worker', { validateMandate: () => true });
  saveExecution(app.db, assignment);
  app.db.renewAssignment(assignment.id, { owner: assignment.owner, fence: assignment.fence, validateMandate: () => false });
  await app.runtime.tick();
  assert.equal(app.db.getTicket(app.ticket.id).status, 'completed');
  assert.deepEqual(app.db.results(app.ticket.id)[0].recoveryObservation.diagnostics, ['TRANSCRIPT_CHANGED']);
  assert.equal(app.counts().executions, 0);
});

test('saving an interrupted draft cannot turn a new unfinished turn into success', async t => {
  const app = await fixture(t, { ctx: recoveryContext(() => ({ events: [...recoveryEvents, { seq: 2, type: 'user/message' }] })) });
  const [assignment] = app.db.claimAssignments('old-worker', { validateMandate: () => true });
  saveExecution(app.db, assignment);
  app.db.renewAssignment(assignment.id, { owner: assignment.owner, fence: assignment.fence, validateMandate: () => false });
  await app.runtime.tick();
  assert.equal(app.db.getTicket(app.ticket.id).status, 'waiting');
  assert.equal(app.db.results(app.ticket.id).length, 1);
  assert.equal(app.counts().executions, 0);
});

test('pause and stop retain existing drafts without inventing a successful task', async t => {
  for (const control of ['pauseTicket', 'cancelTicket']) await t.test(control, async t => {
    let reads = 0;
    const app = await fixture(t, { ctx: recoveryContext(() => { reads++; return { events: recoveryEvents }; }) });
    const [assignment] = app.db.claimAssignments('old-worker', { validateMandate: () => true });
    saveExecution(app.db, assignment);
    app.db.renewAssignment(assignment.id, { owner: assignment.owner, fence: assignment.fence, validateMandate: () => false });
    app.db[control](app.ticket.id);
    await app.runtime.tick();
    assert.equal(reads, 1);
    assert.equal(app.db.results(app.ticket.id).length, 1);
    assert.equal(app.db.getTicket(app.ticket.id).status, 'waiting');
  });
});
