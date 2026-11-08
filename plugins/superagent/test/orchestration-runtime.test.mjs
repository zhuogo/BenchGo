import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAssistantStore } from '../src/store.mjs';
import { readAssessmentPolicy } from '../src/assessment-policy.mjs';
import { createOrchestrationRuntime } from '../src/orchestration-runtime.mjs';

async function fixture(t, { send, execute, onDelivered, ctx = {}, now, result: patch = {} } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-direct-delivery-'));
  const store = await createAssistantStore({ dataDirectory: directory });
  const policy = await readAssessmentPolicy(store);
  const source = { channel: 'desktop', sessionId: 'owner-session', messageId: 'original', threadId: 'main' };
  const db = store.orchestration;
  db.createThread({ id: 'thread', source: { type: 'desktop', id: 'owner-session' } });
  const ticket = db.createTicket({ threadId: 'thread', title: '测试交付', target: '给出纯文本成果', mandate: { source, actorId: 'desktop-owner', admission: 'desktop-approved-delegation', policyVersion: policy.desktopVersion, controlledActions: 'require-current-policy-and-harness-approval' } });
  db.createAssignment(ticket.id, { id: 'work', executor: 'harness', model: { providerId: 'opaque provider', modelId: 'opaque/model' } });
  let executions = 0, sends = 0;
  const original = '  完整原文\n\n纯文本不要求产物文件。\n';
  const runtime = createOrchestrationRuntime({ ctx: { llm: { stream() { throw new Error('No content review model may be called'); } }, ...ctx }, store, onDelivered, ...(now ? { now } : {}),
    execute: async (assignment, context) => { executions++; return execute ? execute(assignment, context, db) : { summary: original, selfCheck: { summary: '已检查数量、格式与明确要求' }, evidenceRefs: [], ...patch }; },
    deliverDesktop: async delivery => { sends++; return send ? send(delivery, db) : { status: 'accepted', messageId: 'durable-message' }; },
  });
  t.after(async () => { await runtime.stop(); await store.close(); await rm(directory, { recursive: true, force: true }); });
  const advance = async () => { for (let i = 0; i < 30; i++) { await runtime.tick(); await new Promise(resolve => setTimeout(resolve, 2)); if (sends || db.getAssignment('work').state === 'uncertain') break; } };
  return { runtime, db, ticket, source, original, advance, counts: () => ({ executions, sends }) };
}

test('zero-file result goes directly to original conversation and closes only after durable receipt', async t => {
  const app = await fixture(t, { send(delivery, db) {
    assert.equal(db.getTicket(delivery.ticketId).status, 'waiting');
    assert.equal(delivery.payload.publication.origin, 'worker');
    assert.equal(delivery.payload.text, `【测试交付】\n\n${app.original}`);
    assert.deepEqual(delivery.payload.source, app.source);
    return { status: 'accepted', messageId: 'durable-message' };
  } });
  await app.advance();
  assert.equal(app.db.getTicket(app.ticket.id).status, 'completed');
  assert.equal(app.db.results(app.ticket.id).length, 1);
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
  let mirrors = 0, archives = 0, clock = Date.now();
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
