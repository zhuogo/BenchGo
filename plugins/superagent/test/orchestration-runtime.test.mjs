import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAssistantStore } from '../src/store.mjs';
import { readAssessmentPolicy } from '../src/assessment-policy.mjs';
import { createOrchestrationRuntime } from '../src/orchestration-runtime.mjs';

async function fixture(t, { send, execute, onDelivered, prepareTicketReply, notifyExecutionRecovery, channel = 'desktop', ctx = {}, now, result: patch = {} } = {}) {
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
  const runtime = createOrchestrationRuntime({ ctx: { llm: { stream() { throw new Error('No content review model may be called'); } }, ...ctx }, store, onDelivered, notifyExecutionRecovery, ...(now ? { now } : {}),
    prepareTicketReply: async delivery => prepareTicketReply ? prepareTicketReply(delivery, db, store) : { status: 'ready', text: '已完成，我整理好了结果。' },
    execute: async (assignment, context) => { executions++; return execute ? execute(assignment, context, db) : { summary: original, selfCheck: { summary: '已检查数量、格式与明确要求' }, evidenceRefs: [], ...patch }; },
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

test('Router state reporting leaves the outbox pending without emitting a fixed error block or rerunning work', async t => {
  let reports = 0;
  const app = await fixture(t, { execute() { throw Object.assign(new Error('not public'), { code: 'NETWORK' }); },
    prepareTicketReply: async () => { reports++; return { status: 'pending' }; } });
  await app.advance(); await app.runtime.tick();
  assert.equal(reports, 1);
  assert.deepEqual(app.counts(), { executions: 1, sends: 0 });
  assert.equal(app.db.deliveries(app.ticket.id)[0].state, 'queued');
  assert.equal(app.db.getTicket(app.ticket.id).status, 'open');
});

test('failed Router report stays pending without a fixed fallback or another Worker run', async t => {
  const app = await fixture(t, { execute() { throw Object.assign(new Error('not public'), { code: 'NETWORK' }); },
    prepareTicketReply: async () => ({ status: 'failed', reason: 'router-unavailable' }) });
  await app.advance(); await app.runtime.tick(); await app.runtime.tick();
  assert.deepEqual(app.counts(), { executions: 1, sends: 0 });
  const delivered = app.db.deliveries(app.ticket.id)[0];
  assert.equal(delivered.state, 'queued');
  assert.equal(delivered.receipt, null);
  assert.equal(app.db.getTicket(app.ticket.id).status, 'open');
  assert.equal(app.db.results(app.ticket.id).length, 0);
});

test('persisted Router report completes only its state delivery, never closes the task', async t => {
  const app = await fixture(t, { execute() { throw Object.assign(new Error('not public'), { code: 'NETWORK' }); },
    prepareTicketReply: async () => ({ status: 'ready', text: '执行记录已保留，我会等恢复条件具备后继续。', messageId: 'router-report:state' }) });
  await app.advance(); await app.runtime.tick();
  assert.deepEqual(app.counts(), { executions: 1, sends: 1 });
  assert.equal(app.db.deliveries(app.ticket.id)[0].state, 'sent');
  assert.equal(app.db.getTicket(app.ticket.id).status, 'open');
});

test('saved zero-file result is expressed by Router and closes only after original-source receipt', async t => {
  const app = await fixture(t, { send(delivery, db) {
    assert.equal(db.getTicket(delivery.ticketId).status, 'waiting');
    assert.equal(db.getTicket(delivery.ticketId).archived, false, 'saved results are not archived before a trusted delivery receipt');
    assert.equal(delivery.payload.publication.origin, 'router');
    assert.equal(delivery.payload.text, '已完成，我整理好了结果。');
    assert.deepEqual(delivery.payload.source, app.source);
    return { status: 'accepted', messageId: 'durable-message' };
  } });
  await app.advance();
  assert.equal(app.db.getTicket(app.ticket.id).status, 'completed');
  assert.equal(app.db.getTicket(app.ticket.id).archived, true);
  assert.equal(app.runtime.state({ archived: false }).length, 0);
  assert.equal(app.runtime.state({ archived: true })[0].id, app.ticket.id);
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
  assert.equal(app.db.getTicket(app.ticket.id).status, 'waiting');
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
  let clock = Date.now() + 10000, generations = 0;
  const app = await fixture(t, { now: () => clock, prepareTicketReply(delivery, db) {
    generations++;
    assert.equal(delivery.payload.text, undefined);
    assert.equal(delivery.payload.publication, undefined);
    assert.equal(db.results(delivery.ticketId)[0].summary, app.original);
    return { status: 'failed', reason: 'provider-unavailable' };
  } });
  await app.advance();
  const original = app.db.deliveries(app.ticket.id)[0];
  assert.equal(original.state, 'queued');
  assert.equal(app.db.getTicket(app.ticket.id).status, 'waiting');
  clock += 31000; await app.runtime.tick();
  assert.equal(app.db.deliveries(app.ticket.id)[0].id, original.id);
  assert.equal(generations, 2);
  assert.deepEqual(app.counts(), { executions: 1, sends: 0 });
});

test('transport retry uses durable Router text and never generates another reply or Worker result', async t => {
  let clock = Date.now() + 10000, generations = 0, sends = 0;
  const texts = [];
  const app = await fixture(t, { now: () => clock,
    prepareTicketReply() { generations++; return { status: 'ready', text: '整理好了：这是完整的自然回复。', messageId: 'router-result' }; },
    send(delivery) {
      texts.push(delivery.payload.text);
      if (++sends === 1) throw new Error('desktop store temporarily unavailable');
      return { status: 'accepted', messageId: 'finally-saved' };
    } });
  await app.advance();
  const saved = app.db.deliveries(app.ticket.id)[0];
  assert.equal(saved.state, 'queued');
  assert.equal(saved.payload.routerMessageId, 'router-result');
  clock += 31000; await app.runtime.tick();
  assert.equal(app.db.deliveries(app.ticket.id)[0].id, saved.id);
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

test('authorization revocation while Router generates a reply suppresses source send and cannot close Ticket', async t => {
  const app = await fixture(t, { channel: 'feishu', prepareTicketReply(_delivery, _db, store) {
    store.connections.update({ enabled: false }, { revision: store.connections.read().revision });
    return { status: 'ready', text: '已经整理好了。' };
  } });
  await app.advance();
  const row = app.db.deliveries(app.ticket.id)[0];
  assert.equal(row.receipt.status, 'suppressed');
  assert.equal(row.receipt.reason, 'authorization-changed');
  assert.equal(app.db.getTicket(app.ticket.id).status, 'waiting');
  assert.deepEqual(app.counts(), { executions: 1, sends: 0 });
});

test('structural failure report is saved and only closes failed after delivery', async t => {
  const failure = { attempted: '检查来源与已有备份', cause: '来源数据永久丢失', resumeConditions: '取得原数据后可继续' };
  const app = await fixture(t, { result: { outcome: 'failed', failure }, send(delivery, db) {
    assert.equal(db.getTicket(delivery.ticketId).status, 'waiting');
    assert.equal(delivery.payload.outcome, 'failed');
    return { status: 'accepted', messageId: 'failure-receipt' };
  } });
  await app.advance();
  assert.equal(app.db.getTicket(app.ticket.id).status, 'failed');
  assert.deepEqual(app.db.results(app.ticket.id)[0].failure, failure);
});

test('missing original Worker self-check cannot publish or claim completion', async t => {
  const app = await fixture(t, { result: { selfCheck: undefined } });
  await app.advance();
  assert.notEqual(app.db.getTicket(app.ticket.id).status, 'completed');
  assert.equal(app.db.results(app.ticket.id).length, 0);
  assert.equal(app.counts().executions, 1);
  assert.equal(app.db.getAssignment('work').state, 'uncertain');
});

test('external effect uncertainty cannot cause terminal delivery or automatic rerun', async t => {
  const app = await fixture(t, { result: { executionEffects: { effectsVerified: false, unknownCallIds: ['send'] } } });
  await app.advance(); await app.advance();
  assert.notEqual(app.db.getTicket(app.ticket.id).status, 'completed');
  assert.equal(app.db.results(app.ticket.id).length, 0);
  assert.equal(app.counts().executions, 1);
});

test('confirmed delivery stays closed when conversation mirror or official archival needs retry', async t => {
  let mirrors = 0, archives = 0, clock = Date.now() + 10000;
  const app = await fixture(t, { now: () => clock,
    ctx: { workspaceRegistry: { list: () => [], async archiveSession(sessionId) { assert.equal(sessionId, 'execution'); if (++archives === 1) throw new Error('official activity still releasing'); } } },
    onDelivered(row) { assert.equal(row.state, 'sent'); if (++mirrors === 1) throw new Error('conversation persistence unavailable'); },
    execute(assignment, _context, db) {
      const identity = { owner: assignment.owner, fence: assignment.fence };
      const run = db.prepareRun(assignment.id, { ...identity, sessionId: 'execution', directory: 'fixture' });
      db.updateRun(run.id, { ...identity, state: 'submitted' });
      const result = { runId: run.id, sessionId: 'execution', summary: 'original', selfCheck: { summary: 'checked' }, outcome: 'completed', evidenceRefs: [] };
      db.updateRun(run.id, { ...identity, state: 'verifying', evidence: result });
      return result;
    },
  });
  await app.advance(); await app.runtime.tick();
  assert.equal(app.db.getTicket(app.ticket.id).status, 'completed');
  assert.equal(app.db.deliveries(app.ticket.id)[0].state, 'sent');
  assert.equal(mirrors, 1); assert.equal(archives, 1);
  clock += 31000;
  await app.runtime.tick(); await app.runtime.tick();
  assert.equal(mirrors, 2); assert.equal(archives, 2);
  assert.deepEqual(app.counts(), { executions: 1, sends: 1 });
});

test('recovery coordination cannot rerun unknown external effects or invent structural failure evidence', async t => {
  const app = await fixture(t, { execute() { throw Object.assign(new Error('not public'), { code: 'EXECUTION_EFFECTS_UNKNOWN' }); } });
  await app.advance();
  const ticket = app.db.getTicket(app.ticket.id), assignment = app.db.getAssignment('work');
  const input = { ticketId: ticket.id, assignmentId: assignment.id, fence: assignment.fence, instructionRevision: ticket.instructionRevision };
  const state = app.runtime.state({ ticketId: ticket.id })[0];
  assert.equal(state.execution.uncertainty.reasonCode, 'external-effects-unknown');
  assert.equal(state.execution.instructionRevision, ticket.instructionRevision);
  assert.equal((await app.runtime.manageExecution({ ...input, operation: 'wait' })).status, 'waiting');
  assert.equal((await app.runtime.manageExecution({ ...input, operation: 'resume' })).status, 'blocked');
  assert.equal((await app.runtime.manageExecution({ ...input, operation: 'fail' })).status, 'blocked');
  await app.runtime.tick(); assert.equal(app.counts().executions, 1);
  assert.equal(app.db.results(ticket.id).length, 0);
  await assert.rejects(app.runtime.manageExecution({ ...input, instructionRevision: input.instructionRevision + 1, operation: 'check-now' }), /授权或要求已变化/);
  assert.equal((await app.runtime.manageExecution({ ...input, fence: assignment.fence + 1, operation: 'check-now' })).status, 'blocked');
});

test('notification work waits independently while delivery and Router-facing state keep progressing', async t => {
  let release, notifications = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const app = await fixture(t, { notifyExecutionRecovery: async () => { notifications++; await gate; } });
  try {
    await app.advance();
    assert.ok(notifications > 0); assert.equal(app.db.getTicket(app.ticket.id).status, 'completed');
    assert.deepEqual(app.counts(), { executions: 1, sends: 1 });
  } finally { release(); }
});

for (const externalUnknown of [false, true]) test(`check-now inspects an interrupted original session asynchronously without dispatch (${externalUnknown ? 'unknown external effect' : 'settled local work'})`, async t => {
  let release, reads = 0, app;
  const gate = new Promise(resolve => { release = resolve; });
  const log = { events: [{ seq: 0, type: 'turn/start', time: 1000, data: { turn: 1 } },
    { seq: 1, type: 'step/start', time: 1000, data: { turn: 1, step: 1 } }] };
  if (externalUnknown) log.events.push({ seq: 2, type: 'assistant/message', time: 1000, data: { turn: 1, step: 1,
    message: { content: [{ type: 'tool-call', id: 'send-unknown', name: 'assistant_external_action', arguments: { operation: 'submit' } }] } } });
  app = await fixture(t, { ctx: { agents: { get: () => undefined, resume() { throw new Error('inspection must not resume an Agent'); } },
    sessionPersistence: { async open(id, access) { return { id, access, async read() { reads++; await gate; return log; }, async close() {} }; } } },
    execute(assignment, _context, db) {
      const identity = { owner: assignment.owner, fence: assignment.fence };
      const run = db.prepareRun(assignment.id, { ...identity, sessionId: 'original-interrupted', directory: app.store.paths.workspace });
      db.freezeWorkerModelRoute({ ...identity, assignmentId: assignment.id, runId: run.id,
        models: [{ providerId: 'original', modelId: 'opaque/frozen' }], index: 0 });
      db.updateRun(run.id, { ...identity, state: 'submitted' }); db.updateRun(run.id, { ...identity, state: 'uncertain' });
      throw Object.assign(new Error('interrupted'), { code: 'WORKER_TURN_INCOMPLETE' });
    } });
  try {
    await app.advance();
    const ticket = app.db.getTicket(app.ticket.id), assignment = app.db.getAssignment('work');
    const accepted = await app.runtime.manageExecution({ ticketId: ticket.id, assignmentId: assignment.id, fence: assignment.fence,
      instructionRevision: ticket.instructionRevision, operation: 'check-now' });
    assert.equal(accepted.action, 'inspect-only'); assert.equal(accepted.status, 'scheduled');
    await app.runtime.tick(); assert.equal(app.db.getAssignment('work').lastInspection, undefined);
    release();
    for (let attempt = 0; attempt < 50 && !app.db.getAssignment('work').lastInspection; attempt++) {
      await app.runtime.tick(); await new Promise(resolve => setTimeout(resolve, 2));
    }
    const inspected = app.db.getAssignment('work').lastInspection;
    assert.ok(reads > 0); assert.equal(inspected.status, externalUnknown ? 'blocked' : 'verified');
    assert.equal(inspected.code, externalUnknown ? 'EXECUTION_EFFECTS_UNKNOWN' : 'VERIFIED_INTERRUPTED');
    assert.equal(app.runtime.state({ ticketId: ticket.id })[0].execution.uncertainty.lastInspection.id, inspected.id);
    const second = await app.runtime.manageExecution({ ticketId: ticket.id, assignmentId: assignment.id, fence: assignment.fence,
      instructionRevision: ticket.instructionRevision, operation: 'check-now' });
    assert.equal(second.status, 'waiting', 'a completed inspection must not trigger a tight internal notification loop');
    if (externalUnknown) assert.equal((await app.runtime.manageExecution({ ticketId: ticket.id, assignmentId: assignment.id,
      fence: assignment.fence, instructionRevision: ticket.instructionRevision, operation: 'resume' })).status, 'blocked');
    assert.equal(app.db.getAssignment('work').state, 'uncertain'); assert.equal(app.counts().executions, 1);
    assert.equal(app.db.results(ticket.id).length, 0); assert.equal(app.db.runs('work').length, 1);
  } finally { release(); }
});
