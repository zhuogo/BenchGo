import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { createAssistantAssignmentWorker } from '../src/assignment-worker.mjs';

function fixture(t, callbacks = {}) {
  const database = createAssistantOrchestrationStore({ filename: ':memory:' });
  t.after(() => database.close());
  database.createThread({ id: 'thread', source: { type: 'desktop', id: 'thread' } });
  const ticket = database.createTicket({ threadId: 'thread', target: 'work', mandate: { scope: ['read'] } });
  database.createAssignment(ticket.id, { executor: 'harness' });
  const worker = createAssistantAssignmentWorker({ database, readPolicy: async () => ({ version: 1 }), validateMandate: () => true, execute: async () => ({ text: 'done' }), onResult: async result => database.commitResult(ticket.id, { result, uniqueKey: 'result' }), ...callbacks });
  t.after(() => worker.stop());
  return { database, ticket, worker };
}

test('claims an assignment once and commits execution before completing its lease', async t => {
  let executions = 0;
  const { database, ticket, worker } = fixture(t, { execute: async () => { executions++; return { text: 'done' }; } });
  const [first, concurrent] = await Promise.all([worker.runOnce(), worker.runOnce()]);
  assert.equal(first.results[0].status, 'completed');
  assert.deepEqual(first, concurrent);
  assert.equal(executions, 1);
  assert.equal(database.assignments(ticket.id)[0].state, 'completed');
  assert.equal(database.results(ticket.id)[0].text, 'done');
  assert.equal((await worker.runOnce()).claimed, 0);
});

test('execution failure is uncertain and never blindly retried', async t => {
  const { database, ticket, worker } = fixture(t, { execute: async () => { throw new Error('connection lost after action'); } });
  assert.equal((await worker.runOnce()).results[0].status, 'uncertain');
  assert.equal(database.assignments(ticket.id)[0].state, 'uncertain');
  assert.equal((await worker.runOnce()).claimed, 0);
  assert.equal(database.results(ticket.id).length, 0);
});

test('a parked Attention releases its single slot without being marked completed', async t => {
  const database = createAssistantOrchestrationStore({ filename: ':memory:' });
  t.after(() => database.close());
  database.createThread({ id: 'thread', source: { type: 'feishu', id: 'thread' } });
  const first = database.createTicket({ threadId: 'thread', target: 'question', mandate: { actorId: 'owner', source: { channel: 'feishu' } } });
  database.createAssignment(first.id, {});
  let executions = 0;
  const worker = createAssistantAssignmentWorker({ database, readPolicy: async () => ({}), validateMandate: () => true,
    execute: async assignment => {
      executions++;
      if (assignment.ticketId !== first.id) return { summary: 'independent done' };
      const ownership = { owner: assignment.owner, fence: assignment.fence };
      const run = database.prepareRun(assignment.id, { ...ownership, sessionId: 'session', directory: 'directory' });
      database.updateRun(run.id, { ...ownership, state: 'submitted' });
      const [attention] = database.openAttention(assignment.id, { ...ownership, sessionId: 'session', callId: 'call', questions: [{ id: 'q', question: 'Question?' }] });
      const result = { runId: run.id, transcript: {}, checkpoint: {}, waitingAttention: { attentionIds: [attention.id], callIds: ['call'] } };
      database.updateRun(run.id, { ...ownership, state: 'verifying', evidence: result });
      return result;
    },
    onResult: async (result, { assignment, beforeCommit }) => {
      await beforeCommit();
      if (result.waitingAttention) database.parkAttention(assignment.id, { owner: assignment.owner, fence: assignment.fence, result });
      else database.commitResult(assignment.ticketId, { assignment, result, uniqueKey: 'independent-result' });
    },
  });
  t.after(() => worker.stop());
  assert.equal((await worker.runOnce()).results[0].status, 'waiting');
  const other = database.createTicket({ threadId: 'thread', target: 'independent', mandate: {} });
  database.createAssignment(other.id, {});
  assert.equal((await worker.runOnce()).results[0].status, 'completed');
  assert.equal(executions, 2);
  assert.equal(database.getTicket(first.id).status, 'waiting');
  assert.equal(database.results(first.id).length, 0);
  database.cancelTicket(first.id);
  const paused = database.assignments(first.id)[0];
  assert.equal(paused.state, 'cancelled');
  assert.equal(database.runs(paused.id)[0].state, 'cancelled');
  assert.equal(database.deliveries(first.id)[0].state, 'cancelled');
  assert.equal(database.queueAnsweredAttention({ validateMandate: () => true }), 0);
});

test('policy narrowing after execution prevents result delivery', async t => {
  let permitted = true, delivered = false;
  const { database, ticket, worker } = fixture(t, {
    validateMandate: () => permitted,
    execute: async () => { permitted = false; return { text: 'done' }; },
    onResult: async () => { delivered = true; },
  });
  await worker.runOnce();
  assert.equal(delivered, false);
  assert.equal(database.assignments(ticket.id)[0].state, 'uncertain');
});

test('shutdown aborts active execution and preserves uncertainty', async t => {
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  const { database, ticket, worker } = fixture(t, {
    execute: async (_assignment, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      ready();
    }),
  });
  const pending = worker.runOnce();
  await started;
  await worker.stop();
  await pending;
  assert.equal(database.assignments(ticket.id)[0].state, 'uncertain');
  assert.equal((await worker.runOnce()).skipped, true);
});

test('a free slot starts new work while another execution remains busy', async t => {
  let release, firstStarted;
  const began = new Promise(resolve => { firstStarted = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  let count = 0;
  const { database, worker } = fixture(t, { concurrency: 2,
    execute: async () => { if (++count === 1) { firstStarted(); await held; } return { text: 'done' }; },
    onResult: async () => {},
  });
  const first = worker.runOnce();
  await began;
  const ticket2 = database.createTicket({ threadId: 'thread', target: 'independent', mandate: {} });
  database.createAssignment(ticket2.id, {});
  const second = await worker.runOnce();
  assert.equal(second.claimed, 1);
  assert.equal(second.results[0].status, 'completed');
  assert.equal(count, 2);
  release(); await first;
});
