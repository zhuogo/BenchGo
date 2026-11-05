import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { commitReviewedResult } from '../src/review-result-commit.mjs';
import { installWorkerPermissionGate } from '../src/worker-permissions.mjs';
import { createAssignmentExecutor } from '../src/assignment-executor.mjs';

async function fixture(t, { project } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-repair-'));
  let database = createAssistantOrchestrationStore({ directory });
  t.after(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
  database.createThread({ id: 'thread', source: { type: 'desktop', id: 'source' } });
  const ticket = database.createTicket({ threadId: 'thread', target: 'Write a sourced summary', mandate: {
    source: { channel: 'desktop', sessionId: 'source' }, ...(project ? { project } : {}),
  } });
  const model = { providerId: 'p', modelId: 'exact/model' }, submissions = new Map();
  database.createAssignment(ticket.id, { id: 'initial', executor: 'harness', model });
  const rework = { verdict: 'rework', reason: 'source not verified', instruction: 'Fetch the source and correct unsupported claims.',
    delivery: { action: 'deliver', text: 'The cited source needs verification; I am checking it in the original task.' } };
  return { get db() { return database; }, ticket, model,
    restart() { database.close(); database = createAssistantOrchestrationStore({ directory }); },
    claim() { return database.claimAssignments('worker', { validateMandate: () => true })[0]; },
    commit(assignment, verdict = rework) {
      const key = `${assignment.id}:${assignment.fence}`;
      let saved = submissions.get(key);
      if (!saved) {
        const ownership = { owner: assignment.owner, fence: assignment.fence };
        const run = database.runs(assignment.id)[0] || database.prepareRun(assignment.id, { ...ownership, sessionId: 'original-session', directory });
        database.updateRun(run.id, { ...ownership, state: 'submitted' });
        const result = { runId: run.id, sessionId: run.sessionId, summary: 'unverified', finalSummary: 'unverified',
          transcript: { hash: `hash-${key}`, lastSeq: assignment.fence }, checkpoint: { manifestHash: 'original-checkpoint', count: 0 },
          remainingExecutionMs: 60000, toolEvidence: { entries: [], total: 0 } };
        database.updateRun(run.id, { ...ownership, state: 'verifying', evidence: result });
        database.confirmExecutionStopped(assignment.id, ownership);
        saved = { result, ticket: database.getTicket(ticket.id) };
        submissions.set(key, saved);
      }
      return commitReviewedResult({ database, ticket: saved.ticket, assignment, verdict, result: saved.result, uniqueKey: `result-${key}` });
    } };
}

test('repair persists atomically, survives restart, deduplicates and reports continuation and final result', async t => {
  const f = await fixture(t), original = f.claim();
  const first = f.commit(original);
  assert.equal(first.ticket.status, 'open');
  assert.equal(f.db.results(f.ticket.id).length, 1);
  assert.equal(f.db.deliveries(f.ticket.id).length, 1);
  assert.deepEqual(first.assignment.model, f.model);
  assert.equal(first.assignment.id, original.id);
  f.restart();
  assert.equal(f.commit(original).duplicate, true);
  assert.equal(f.db.assignments(f.ticket.id).length, 1);
  const repair = f.claim();
  assert.equal(repair.reviewContinuation.sourceSessionId, 'original-session');
  f.commit(repair, { verdict: 'passed', reason: 'verified', delivery: { action: 'deliver', text: 'Verified answer.' } });
  assert.equal(f.db.getTicket(f.ticket.id).status, 'completed');
  assert.equal(f.db.deliveries(f.ticket.id).length, 2);
  assert.equal(f.db.runs(original.id).length, 1);
  assert.deepEqual(f.db.getTicket(f.ticket.id).mandate, f.ticket.mandate);
});

test('unchanged repair waits recoverably instead of terminating after an attempt count', async t => {
  const f = await fixture(t), original = f.claim();
  f.commit(original); f.commit(f.claim());
  assert.equal(f.commit(original).duplicate, true);
  f.commit(f.claim());
  const waiting = f.commit(f.claim());
  assert.equal(f.db.assignments(f.ticket.id).length, 1);
  assert.equal(f.db.getTicket(f.ticket.id).status, 'waiting');
  assert.equal(waiting.result.review.continuationWait.code, 'NO_PROGRESS');
  assert.equal(waiting.outbox.payload.publication.origin, 'system');
});

test('stale fences and cancellation cannot enqueue repair', async t => {
  const f = await fixture(t), assignment = f.claim();
  assert.throws(() => f.commit({ ...assignment, fence: assignment.fence + 1 }), /lease/);
  assert.equal(f.db.results(f.ticket.id).length, 0);
  f.db.cancelTicket(f.ticket.id);
  assert.throws(() => f.commit(assignment), /lease/);
  assert.equal(f.db.assignments(f.ticket.id).length, 1);
});

test('legacy repair lookup gate remains read-only and checks current authorization', async () => {
  let handler, calls = 0, allowed = true;
  installWorkerPermissionGate({ on: (_event, callback) => { handler = callback; } }, {
    assignment: { id: 'repair', ticketId: 't', owner: 'worker', fence: 1, reviewRepair: {} },
    database: { getTicket: () => ({ mandate: {} }), renewAssignment: (_id, input) => ({ allowed: input.validateMandate() }) },
    readPolicy: async () => ({ version: 'v1' }), authorizeAction: async () => ({ allowed }),
  });
  const signal = new AbortController().signal;
  await assert.rejects(handler({ name: 'bash', signal }, () => calls++), /read-only/);
  await handler({ name: 'web_fetch', signal }, () => calls++);
  allowed = false;
  await assert.rejects(handler({ name: 'web_search', signal }, () => calls++));
  assert.equal(calls, 1);
});

test('project repair retains original checkpoint and queues the original execution', async t => {
  const f = await fixture(t, { project: { id: 'repo', path: 'original' } }), assignment = f.claim();
  const committed = f.commit(assignment);
  assert.equal(committed.ticket.status, 'open');
  assert.equal(f.db.assignments(f.ticket.id).length, 1);
  assert.equal(committed.result.checkpoint.manifestHash, 'original-checkpoint');
  assert.equal(committed.assignment.reviewContinuation.sourceSessionId, 'original-session');
});

test('legacy repair cannot create a new execution instead of original continuation', async () => {
  let created = 0;
  const execute = createAssignmentExecutor({
    ctx: { agents: { create: async () => { created++; } }, sessionQuery: { readSession: async () => ({ events: [] }) } },
    database: {}, workspaceRoot: tmpdir(), readPolicy: async () => ({}), authorizeAction: async () => ({ allowed: true }),
  });
  await assert.rejects(execute({ reviewRepair: { sourceResultVersion: 1, sourceRunId: 'old-run', sourceSessionId: 'old-session' } },
    { ticket: { id: 'ticket', instructionRevision: 1, mandate: {} }, signal: new AbortController().signal }), /original artifact continuation/);
  assert.equal(created, 0);
});

for (const hadRun of [false, true]) test(`legacy queued repair migrates only when never executed (hadRun=${hadRun})`, async t => {
  const f = await fixture(t), original = f.claim(), first = f.commit(original);
  const raw = new DatabaseSync(f.db.path);
  try {
    raw.prepare("UPDATE sa_assignments SET state='completed' WHERE id=?").run(original.id);
    raw.prepare("UPDATE sa_tickets SET status='open' WHERE id=?").run(f.ticket.id);
    f.db.createAssignment(f.ticket.id, { id: 'legacy', model: f.model, reviewRepair: {
      sourceRunId: first.result.runId, sourceSessionId: first.result.sessionId, sourceResultVersion: first.result.version,
      instruction: 'Verify the original source.', reason: 'Source not verified',
    } });
    if (hadRun) raw.prepare('INSERT INTO sa_runs VALUES (?,?,?,?,?,?,?,?)').run('legacy-run', 'legacy', 0, 'old-worker', 'uncertain',
      JSON.stringify({ sessionId: 'legacy-session', directory: 'legacy-workspace' }), new Date().toISOString(), new Date().toISOString());
    assert.deepEqual(f.db.claimAssignments('replacement', { validateMandate: () => true }), []);
    assert.equal(f.db.getAssignment('legacy').state, hadRun ? 'uncertain' : 'cancelled');
    if (hadRun) {
      assert.equal(f.db.getTicket(f.ticket.id).continuationWait.code, 'LEGACY_REPAIR_EXECUTION_UNKNOWN');
      assert.equal(f.db.getAssignment(original.id).state, 'completed');
    } else {
      const resumed = f.claim();
      assert.equal(resumed.id, original.id);
      assert.equal(resumed.reviewContinuation.runId, first.result.runId);
      assert.equal(f.db.runs(original.id).length, 1);
    }
  } finally { raw.close(); }
});
