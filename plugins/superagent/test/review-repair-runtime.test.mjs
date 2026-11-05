import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantStore } from '../src/store.mjs';
import { readAssessmentPolicy } from '../src/assessment-policy.mjs';
import { createOrchestrationRuntime } from '../src/orchestration-runtime.mjs';

for (const exhaust of [false, true]) test(`runtime repairs the original execution and reports state (noProgress=${exhaust})`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-repair-runtime-'));
  const store = await createAssistantStore({ dataDirectory: directory });
  let runtime;
  t.after(async () => { await runtime?.stop(); await store.close(); await rm(directory, { recursive: true, force: true }); });
  const policy = await readAssessmentPolicy(store), db = store.orchestration;
  const source = { channel: 'desktop', sessionId: 'owner', messageId: 'request', threadId: 'main' };
  db.createThread({ id: 'thread', source: { type: 'desktop', id: 'owner' } });
  const ticket = db.createTicket({ threadId: 'thread', target: 'search today news', mandate: { source, actorId: 'desktop-owner', admission: 'desktop-approved-delegation', policyVersion: policy.desktopVersion, controlledActions: 'require-current-policy-and-harness-approval' } });
  const model = { providerId: 'opaque', modelId: 'exact/model' };
  const original = db.createAssignment(ticket.id, { executor: 'harness', model });
  let executions = 0;
  const publications = [];
  runtime = createOrchestrationRuntime({ ctx: {}, store,
    execute: async assignment => {
      executions++;
      assert.deepEqual(assignment.model, model);
      assert.equal(assignment.id, original.id);
      if (executions > 1) assert.ok(assignment.reviewContinuation);
      const ownership = { owner: assignment.owner, fence: assignment.fence };
      const run = db.runs(assignment.id)[0] || db.prepareRun(assignment.id, { ...ownership, sessionId: 'original-session', directory });
      db.updateRun(run.id, { ...ownership, state: 'submitted' });
      const result = { summary: 'source result', finalSummary: 'source result', evidenceRefs: [], runId: run.id, sessionId: run.sessionId,
        transcript: { hash: `hash-${executions}`, lastSeq: executions }, checkpoint: { manifestHash: 'empty', count: 0 },
        remainingExecutionMs: 60000, toolEvidence: { entries: [], total: 0 } };
      db.updateRun(run.id, { ...ownership, state: 'verifying', evidence: result });
      db.confirmExecutionStopped(assignment.id, ownership);
      return result;
    },
    review: async () => exhaust || executions === 1
      ? { verdict: 'rework', reason: 'missing source', instruction: 'Fetch the cited source within the original request.',
        delivery: { action: 'deliver', text: 'The source needs verification; I am checking the existing draft.' } }
      : { verdict: 'passed', reason: 'source verified', delivery: { action: 'deliver', text: 'Verified result.' } },
    deliverDesktop: async row => {
      publications.push(row.payload.publication);
      assert.deepEqual(row.payload.source, source);
      assert.equal(row.payload.publication.action, 'deliver');
      return { status: 'accepted', messageId: `report-${publications.length}` };
    },
  });
  const done = () => db.getTicket(ticket.id).status === (exhaust ? 'waiting' : 'completed');
  for (let i = 0; i < 200 && (!done() || !publications.some(row => exhaust ? row.origin === 'system' : row.text === 'Verified result.')); i++) {
    await runtime.tick(); await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(executions, exhaust ? 4 : 2);
  assert.ok(publications.length >= 1);
  assert.equal(db.getTicket(ticket.id).status, exhaust ? 'waiting' : 'completed');
  assert.equal(db.assignments(ticket.id).length, 1);
  assert.equal(db.runs(original.id).length, 1);
  assert.equal(db.results(ticket.id).at(-1).review.waitKind, exhaust ? 'continuation_wait' : undefined);
});
