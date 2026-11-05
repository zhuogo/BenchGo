import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { commitReviewedResult } from '../src/review-result-commit.mjs';

function fixture(t, { remainingExecutionMs = 60000 } = {}) {
  const database = createAssistantOrchestrationStore({ filename: ':memory:' });
  t.after(() => database.close());
  database.createThread({ id: 'thread', source: { type: 'desktop', id: 'chat' } });
  const ticket = database.createTicket({ threadId: 'thread', target: 'Return 6–10 verified headlines', acceptance: '6–10 items with source and date',
    mandate: { source: { channel: 'desktop', sessionId: 'chat' }, actorId: 'desktop-owner' } });
  database.createAssignment(ticket.id, { id: 'work', model: { providerId: 'provider', modelId: 'Opaque/Model' } });
  let assignment = database.claimAssignments('worker', { validateMandate: () => true })[0];
  const ownership = { owner: assignment.owner, fence: assignment.fence };
  const run = database.prepareRun(assignment.id, { ...ownership, sessionId: 'original-session', directory: 'original-workspace' });
  let generation = 0;
  const submit = (text = '14 original items', { stopped = true, executionEffects } = {}) => {
    const own = { owner: assignment.owner, fence: assignment.fence };
    database.updateRun(run.id, { ...own, state: 'submitted' });
    const result = { runId: run.id, sessionId: run.sessionId, summary: text, finalSummary: text,
      transcript: { hash: `transcript-${++generation}`, lastSeq: generation },
      checkpoint: { manifestHash: 'empty-directory', files: [], count: 0 }, remainingExecutionMs,
      toolEvidence: { entries: [], total: 0 }, ...(executionEffects ? { executionEffects } : {}) };
    database.updateRun(run.id, { ...own, state: 'verifying', evidence: result });
    if (stopped) database.confirmExecutionStopped(assignment.id, own);
    return result;
  };
  return { database, ticket, run, submit,
    assignment: () => assignment,
    claim: () => { assignment = database.claimAssignments('next-worker', { validateMandate: () => true })[0]; return assignment; },
    commit: (result, verdict = { verdict: 'failed', reason: 'There are 14 items', instruction: 'Condense to 8 headlines.',
      delivery: { action: 'deliver', text: 'The draft has 14 items; I am condensing it to the requested range.' } }) => commitReviewedResult({
        database, ticket: database.getTicket(ticket.id), result, verdict, assignment, uniqueKey: `review-${generation}`,
      }),
  };
}

test('failed result reports why and resumes the same assignment/run with no required files', t => {
  const f = fixture(t), original = f.assignment(), result = f.submit();
  const saved = f.commit(result);
  assert.equal(saved.ticket.status, 'open');
  assert.equal(saved.assignment.id, original.id);
  assert.equal(saved.assignment.reviewContinuation.runId, f.run.id);
  assert.equal(saved.assignment.reviewContinuation.sourceSessionId, f.run.sessionId);
  assert.match(saved.outbox.payload.text, /14 items/);
  assert.equal(f.database.assignments(f.ticket.id).length, 1);
  const continued = f.claim();
  assert.equal(continued.fence, original.fence + 1);
  assert.equal(f.database.runs(continued.id).length, 1);
  assert.equal(f.database.runs(continued.id)[0].state, 'prepared');
  assert.equal(f.database.runs(continued.id)[0].directory, 'original-workspace');
  const final = f.commit(f.submit('8 verified items'), { verdict: 'passed', reason: '8 items meet the mandate', delivery: { action: 'deliver', text: '8 verified items' } });
  assert.equal(final.ticket.status, 'completed');
  assert.equal(final.result.checkpoint.count, 0);
  assert.equal(final.outbox.payload.source.sessionId, 'chat');
  assert.equal(final.ticket.mandate.target, final.ticket.target);
  assert.equal(final.ticket.mandate.acceptance, final.ticket.acceptance);
});

test('loop guard waits only on unchanged progress and explicit recovery reuses the same work', t => {
  const f = fixture(t);
  let saved;
  for (let index = 0; index < 4; index++) {
    saved = f.commit(f.submit('unchanged draft'));
    if (index < 3) { assert.equal(saved.ticket.status, 'open'); assert.ok(f.claim()); }
  }
  assert.equal(saved.ticket.status, 'waiting');
  assert.equal(saved.result.review.waitKind, 'continuation_wait');
  assert.equal(saved.result.review.continuationWait.code, 'NO_PROGRESS');
  assert.equal(saved.outbox.payload.publication.origin, 'system');
  const recovery = f.database.queueReviewContinuation(f.ticket.id, { sourceResultVersion: saved.result.version,
    ownerRetry: true, validateMandate: () => true });
  assert.equal(recovery.queued, true);
  assert.ok(f.claim());
  assert.equal(f.database.assignments(f.ticket.id).length, 1);
  assert.equal(f.database.runs(f.assignment().id).length, 1);
});

test('execution budget exhaustion preserves results and requires budget before resume', t => {
  const f = fixture(t, { remainingExecutionMs: 0 });
  const saved = f.commit(f.submit());
  assert.equal(saved.ticket.status, 'waiting');
  assert.equal(saved.result.review.continuationWait.code, 'EXECUTION_BUDGET_EXHAUSTED');
  assert.equal(f.database.queueReviewContinuation(f.ticket.id, { sourceResultVersion: saved.result.version, validateMandate: () => true }).queued, false);
  const resumed = f.database.queueReviewContinuation(f.ticket.id, { sourceResultVersion: saved.result.version,
    additionalExecutionMs: 1000, validateMandate: () => true });
  assert.equal(resumed.queued, true);
  assert.equal(f.claim().reviewContinuation.additionalExecutionMs, 1000);
});

test('stop confirmation and current authority take priority over automatic correction', t => {
  const f = fixture(t);
  const saved = f.commit(f.submit('draft', { stopped: false }));
  assert.equal(saved.ticket.status, 'waiting');
  assert.equal(saved.result.review.continuationWait.code, 'EXECUTION_STOP_UNCONFIRMED');
  assert.equal(f.database.queueReviewContinuation(f.ticket.id, { sourceResultVersion: saved.result.version,
    validateMandate: () => false }).code, 'MANDATE_REVOKED');
  f.database.cancelTicket(f.ticket.id);
  assert.equal(f.database.queueReviewContinuation(f.ticket.id, { sourceResultVersion: saved.result.version,
    validateMandate: () => true }).code, 'TICKET_STOPPED');
});

test('review retry scheduling persists without creating a new result and clears at next commit', t => {
  const f = fixture(t);
  const saved = f.commit(f.submit(), { verdict: 'wait', reason: 'Review provider unavailable', waitKind: 'review_wait', retryable: true,
    delivery: { action: 'deliver', text: 'The result is retained while source verification recovers.' } });
  const nextAttemptAt = Date.now() + 60000;
  const first = f.database.deferReview(f.ticket.id, { expectedResultVersion: saved.result.version, nextAttemptAt, diagnostic: { code: 'RATE_LIMIT' } });
  assert.equal(first.attempts, 1);
  assert.equal(f.database.getTicket(f.ticket.id).reviewRetry.nextAttemptAt, nextAttemptAt);
  assert.equal(f.database.results(f.ticket.id).length, 1);
  assert.equal(f.database.deferReview(f.ticket.id, { expectedResultVersion: 999, nextAttemptAt }), false);
  f.database.commitResult(f.ticket.id, { result: { ...saved.result, review: { verdict: 'passed' } }, status: 'completed',
    uniqueKey: 'review-completed', instructionRevision: 1, reviewContinuation: { expectedResultVersion: saved.result.version } });
  assert.equal(f.database.getTicket(f.ticket.id).reviewRetry, null);
});

test('missing Router publication is recoverable review_wait rather than terminal completion', t => {
  const f = fixture(t);
  const saved = f.commit(f.submit('Worker text'), { verdict: 'passed', reason: 'no publication generated' });
  assert.equal(saved.ticket.status, 'waiting');
  assert.equal(saved.result.review.waitKind, 'review_wait');
  assert.equal(saved.outbox.payload.publication.origin, 'system');
  assert.notEqual(saved.outbox.payload.text, 'Worker text');
});

test('review user decision creates one Attention and resumes the exact task after the answer', t => {
  const f = fixture(t);
  const saved = f.commit(f.submit(), { verdict: 'wait', reason: 'Private source access requires the owner', waitKind: 'blocked',
    userDecision: { kind: 'permission', question: 'Can this report include the private source?' },
    delivery: { action: 'ask', text: 'The private source needs your scope decision. Can this report include the private source?' } });
  assert.equal(saved.ticket.status, 'waiting');
  assert.equal(saved.outbox.payload.type, 'ticket.attention');
  assert.equal(f.database.deliveries(f.ticket.id).length, 1);
  assert.equal(f.database.attentions(f.ticket.id).length, 1);
  const question = f.database.attentions(f.ticket.id)[0];
  f.database.answerDesktopAttention({ ticketId: f.ticket.id, attentionId: question.id, instructionRevision: 1,
    requestId: 'owner-answer', answer: { selected: [], custom: 'Use only public sources.' } });
  assert.equal(f.database.queueAnsweredAttention({ validateMandate: () => true }), 1);
  const continued = f.claim();
  assert.equal(continued.id, f.assignment().id);
  assert.equal(continued.reviewContinuation.runId, f.run.id);
  assert.equal(continued.reviewContinuation.reviewAnswer.answer.custom, 'Use only public sources.');
  assert.equal(f.database.runs(continued.id).length, 1);
});

for (const kind of ['passed', 'failed', 'blocked']) test(`pause during review preserves ${kind} result and resumes without another result version`, t => {
  const f = fixture(t), result = f.submit();
  assert.equal(f.database.pauseTicket(f.ticket.id).status, 'pausing');
  const verdict = kind === 'passed'
    ? { verdict: 'passed', reason: 'The requested summary is complete', delivery: { action: 'deliver', text: '8 verified items' } }
    : kind === 'blocked'
    ? { verdict: 'wait', reason: 'Scope decision required', waitKind: 'blocked', userDecision: { kind: 'scope', question: 'Which geographic scope?' },
      delivery: { action: 'ask', text: 'Which geographic scope?' } }
    : undefined;
  const saved = f.commit(result, verdict);
  assert.equal(saved.ticket.status, 'paused');
  assert.equal(saved.result.reviewPaused, true);
  assert.deepEqual(f.database.claimOutbox('sender'), [], 'paused results remain queued for their original channel');
  const resumed = f.database.resumeTicket(f.ticket.id);
  assert.equal(f.database.results(f.ticket.id).length, 1);
  assert.equal(resumed.status, kind === 'passed' ? 'completed' : kind === 'failed' ? 'open' : 'waiting');
  if (kind === 'failed') assert.equal(f.claim().reviewContinuation.runId, f.run.id);
  if (kind === 'blocked') {
    assert.equal(f.database.attentions(f.ticket.id).length, 1);
    assert.equal(f.database.claimOutbox('sender')[0].payload.type, 'ticket.attention');
  }
  if (kind === 'passed') assert.equal(f.database.claimOutbox('sender')[0].payload.text, '8 verified items');
});

test('execution failure creates one explicit system notification without changing saved results', t => {
  const f = fixture(t), assignment = f.assignment();
  f.database.recordAssignmentFailure(assignment.id, { owner: assignment.owner, fence: assignment.fence,
    stage: 'execution', code: 'NETWORK', now: Date.now() });
  f.database.recordAssignmentFailure(assignment.id, { owner: assignment.owner, fence: assignment.fence,
    stage: 'execution', code: 'SECRET_RAW_PROVIDER_TEXT', now: Date.now() });
  const rows = f.database.deliveries(f.ticket.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].payload.publication.origin, 'system');
  assert.equal(rows[0].payload.publication.systemState.code, 'NETWORK');
  assert.equal(rows[0].payload.source.sessionId, 'chat');
  assert.doesNotMatch(JSON.stringify(rows), /SECRET_RAW_PROVIDER_TEXT/);
  assert.deepEqual(f.database.results(f.ticket.id), []);
});

test('review continuation waits on unknown host-observed effects instead of queuing changed side effects', t => {
  const f = fixture(t), original = f.assignment();
  const result = f.submit('The send request timed out', { executionEffects: { effectsVerified: false, unknownCallIds: ['old-send'] } });
  const saved = f.commit(result);
  assert.equal(saved.ticket.status, 'waiting');
  assert.equal(saved.ticket.continuationWait.code, 'EXECUTION_EFFECTS_UNKNOWN');
  assert.equal(saved.result.executionEffects.effectsVerified, false);
  assert.equal(f.database.results(f.ticket.id).length, 1);
  assert.equal(f.database.getAssignment(original.id).state, 'completed');
  assert.deepEqual(f.database.claimAssignments('unsafe-retry', { validateMandate: () => true }), []);
  const resumed = f.database.queueReviewContinuation(f.ticket.id, { sourceResultVersion: saved.result.version,
    instruction: 'Send a changed message using a different recipient.', ownerRetry: true, validateMandate: () => true });
  assert.equal(resumed.queued, false);
  assert.equal(resumed.code, 'EXECUTION_EFFECTS_UNKNOWN');
  assert.equal(f.database.results(f.ticket.id).length, 1, 'the host gate does not invent a task result');
});
