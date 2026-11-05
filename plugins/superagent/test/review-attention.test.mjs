import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { ingestAssistantEvent } from '../src/intake.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-review-attention-'));
  let database = createAssistantOrchestrationStore({ directory });
  t.after(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
  database.createThread({ id: 'thread', source: { type: 'desktop', id: 'source' } });
  return { get db() { return database; }, directory,
    restart() { database.close(); database = createAssistantOrchestrationStore({ directory }); } };
}

function blockedResult(f, { channel = 'desktop', key = 'initial', remainingExecutionMs = 30000 } = {}) {
  const db = f.db;
  const source = channel === 'desktop'
    ? { channel, sessionId: 'owner-session', threadId: 'main', messageId: key }
    : { channel, appId: 'app', chatId: 'chat', messageId: key };
  const ticket = db.createTicket({ threadId: 'thread', target: '整理新闻摘要', acceptance: '6–10 条新闻，附来源与时间',
    mandate: { actorId: channel === 'desktop' ? 'desktop-owner' : 'owner', source } });
  db.createAssignment(ticket.id, {});
  const [assignment] = db.claimAssignments('worker', { validateMandate: () => true });
  const ownership = { owner: assignment.owner, fence: assignment.fence };
  const run = db.prepareRun(assignment.id, { ...ownership, sessionId: `execution:${key}`, directory: f.directory });
  db.updateRun(run.id, { ...ownership, state: 'submitted' });
  const result = { runId: run.id, sessionId: run.sessionId, summary: '已保留抓取结果，待确定新闻日期。',
    checkpoint: { manifestHash: `saved:${key}`, files: [] }, transcript: { hash: `transcript:${key}`, lastSeq: 2 },
    evidenceRefs: ['tool:fetch'], remainingExecutionMs };
  db.updateRun(run.id, { ...ownership, state: 'verifying', evidence: result });
  db.confirmExecutionStopped(assignment.id, ownership);
  const userDecision = { kind: 'information', question: '以哪个时区的 11 月 4 日为准？' };
  const delivery = { action: 'ask', text: '来源页面跨越两个日期边界，需要你确定摘要的日期口径。', options: ['北京时间', '当地时间'] };
  const review = { verdict: 'wait', waitKind: 'blocked', reason: '原要求未确定时区，不能自行决定日期范围。', userDecision, delivery };
  const committed = db.commitResult(ticket.id, { assignment, result: { ...result, review }, status: 'waiting', uniqueKey: key,
    blocked: { userDecision, delivery } });
  return { ticket, assignment, run, result, review, ...committed };
}

const answer = (entry, requestId = 'answer') => ({ ticketId: entry.ticket.id, attentionId: entry.attention.id,
  instructionRevision: entry.ticket.instructionRevision, requestId, answer: { selected: ['北京时间'], custom: '来源日期也按此口径核对。' } });

test('review question is saved once with its original task, result and AI wording', async t => {
  const f = await fixture(t), saved = blockedResult(f);
  const entry = f.db.attentions(saved.ticket.id)[0];
  assert.equal(entry.origin, 'review');
  assert.equal(entry.runId, saved.run.id);
  assert.equal(entry.resultVersion, 1);
  assert.equal(entry.instructionRevision, 1);
  assert.equal(entry.kind, 'information');
  assert.equal(entry.question.question, saved.review.userDecision.question);
  assert.equal(f.db.deliveries(saved.ticket.id).length, 1, 'review question has no second result delivery');
  assert.equal(saved.outbox.payload.type, 'ticket.attention');
  assert.equal(saved.outbox.payload.attentionId, entry.id);
  assert.equal(saved.outbox.payload.text, `${saved.review.delivery.text}\n${entry.question.question}\n北京时间\n当地时间`);
  assert.deepEqual(f.db.openReviewAttention(saved.ticket.id, { assignmentId: saved.assignment.id, runId: saved.run.id,
    sessionId: saved.run.sessionId, instructionRevision: 1, resultVersion: 1,
    userDecision: saved.review.userDecision, delivery: saved.review.delivery }), entry);
  assert.equal(f.db.deliveries(saved.ticket.id).length, 1);
});

test('answer survives reopening and resumes the original assignment, run and session', async t => {
  const f = await fixture(t), saved = blockedResult(f);
  assert.equal(f.db.queueAnsweredAttention({ validateMandate: () => true }), 0);
  f.db.answerDesktopAttention(answer(saved));
  f.restart();
  assert.equal(f.db.answerDesktopAttention(answer(saved)).duplicate, true);
  assert.equal(f.db.queueAnsweredAttention({ validateMandate: () => true }), 1);
  assert.equal(f.db.queueAnsweredAttention({ validateMandate: () => true }), 0);
  assert.equal(f.db.getTicket(saved.ticket.id).status, 'open');
  const [resumed] = f.db.claimAssignments('next-worker', { validateMandate: () => true });
  assert.equal(resumed.id, saved.assignment.id);
  assert.equal(f.db.assignments(saved.ticket.id).length, 1);
  assert.equal(f.db.runs(resumed.id).length, 1);
  assert.equal(resumed.reviewContinuation.runId, saved.run.id);
  assert.equal(resumed.reviewContinuation.sourceSessionId, saved.run.sessionId);
  assert.equal(resumed.reviewContinuation.sourceResultVersion, 1);
  assert.equal(resumed.attentionContinuation, undefined, 'review answer is not an official pending tool call');
  const resumedAnswer = resumed.reviewContinuation.reviewAnswer;
  assert.equal(resumedAnswer.attentionId, saved.attention.id);
  assert.equal(resumedAnswer.question.question, saved.review.userDecision.question);
  assert.deepEqual(resumedAnswer.answer, answer(saved).answer);
  assert.equal(resumedAnswer.text, '北京时间\n来源日期也按此口径核对。');
  assert.equal(f.db.getTicket(saved.ticket.id).instructionRevision, 1, 'answer does not broaden the Mandate');
});

test('identical option labels still resume only the question actually answered', async t => {
  const f = await fixture(t), first = blockedResult(f), second = blockedResult(f, { key: 'second' });
  f.db.answerDesktopAttention(answer(second));
  assert.equal(f.db.queueAnsweredAttention({ validateMandate: () => true }), 1);
  assert.equal(f.db.getTicket(first.ticket.id).status, 'waiting');
  assert.equal(f.db.getTicket(second.ticket.id).status, 'open');
  assert.equal(f.db.attentions(first.ticket.id)[0].state, 'waiting');
  assert.equal(f.db.attentions(second.ticket.id)[0].state, 'answered');
});

test('stop and authorization gates precede recovery while exhausted execution budget keeps answers waiting', async t => {
  const f = await fixture(t), saved = blockedResult(f), exhausted = blockedResult(f, { key: 'exhausted', remainingExecutionMs: 0 });
  const stopped = blockedResult(f, { key: 'stopped' });
  f.db.answerDesktopAttention(answer(saved, 'first'));
  f.db.answerDesktopAttention(answer(exhausted, 'second'));
  f.db.answerDesktopAttention(answer(stopped, 'third'));
  f.db.cancelTicket(stopped.ticket.id);
  assert.equal(f.db.queueAnsweredAttention({ validateMandate: () => false }), 0);
  assert.equal(f.db.getTicket(saved.ticket.id).status, 'waiting');
  assert.equal(f.db.queueAnsweredAttention({ validateMandate: () => true }), 1);
  assert.equal(f.db.getTicket(exhausted.ticket.id).status, 'waiting');
  assert.equal(f.db.attentions(exhausted.ticket.id)[0].state, 'answered', 'the persisted answer is retained for later recovery');
  assert.equal(f.db.getTicket(stopped.ticket.id).status, 'cancelled');
  assert.equal(f.db.getAssignment(stopped.assignment.id).reviewContinuation, undefined, 'answer cannot bypass a stopped Ticket');
});

test('explicit owner budget resumes an answered review in its original Run without inventing an answer', async t => {
  const f = await fixture(t), unanswered = blockedResult(f, { key: 'unanswered', remainingExecutionMs: 0 });
  const saved = blockedResult(f, { key: 'answered', remainingExecutionMs: 0 });
  const request = { sourceResultVersion: 1, validateMandate: () => true, ownerRetry: true, additionalExecutionMs: 600000 };
  const before = f.db.getTicket(unanswered.ticket.id);
  assert.equal(f.db.queueAnsweredReviewContinuation(unanswered.ticket.id, request).code, 'USER_ANSWER_REQUIRED');
  assert.deepEqual(f.db.getTicket(unanswered.ticket.id), before, 'no answer leaves the ticket untouched');
  assert.equal(f.db.getAssignment(unanswered.assignment.id).reviewContinuation, undefined);
  f.db.answerDesktopAttention(answer(saved));
  assert.equal(f.db.queueAnsweredReviewContinuation(saved.ticket.id, { ...request, additionalExecutionMs: 0 }).code, 'EXECUTION_BUDGET_EXHAUSTED');
  assert.deepEqual(f.db.getTicket(saved.ticket.id).continuationWait, { code: 'EXECUTION_BUDGET_EXHAUSTED', sourceResultVersion: 1 });
  assert.throws(() => f.db.queueAnsweredReviewContinuation(saved.ticket.id, { ...request, ownerRetry: false }), /explicit owner retry/);
  assert.equal(f.db.queueAnsweredReviewContinuation(saved.ticket.id, { ...request, validateMandate: () => false }).code, 'MANDATE_REVOKED');
  f.restart();
  const resumed = f.db.queueAnsweredReviewContinuation(saved.ticket.id, request);
  assert.equal(resumed.queued, true);
  assert.equal(resumed.assignment.id, saved.assignment.id);
  assert.equal(resumed.assignment.reviewContinuation.runId, saved.run.id);
  assert.equal(resumed.assignment.reviewContinuation.sourceSessionId, saved.run.sessionId);
  assert.equal(resumed.assignment.reviewContinuation.additionalExecutionMs, 600000);
  assert.deepEqual(resumed.assignment.reviewContinuation.reviewAnswer.answer, answer(saved).answer);
  assert.equal(resumed.ticket.continuationWait, null);
  assert.equal(f.db.runs(saved.assignment.id).length, 1);
  assert.equal(f.db.assignments(saved.ticket.id).length, 1);
  assert.equal(f.db.getTicket(unanswered.ticket.id).status, 'waiting');
});

test('explicit review recovery still rejects stale versions and respects stop', async t => {
  const f = await fixture(t), saved = blockedResult(f);
  f.db.answerDesktopAttention(answer(saved));
  const request = { sourceResultVersion: 1, validateMandate: () => true, ownerRetry: true, additionalExecutionMs: 600000 };
  assert.throws(() => f.db.queueAnsweredReviewContinuation(saved.ticket.id, { ...request, sourceResultVersion: 2 }), { code: 'REVIEW_CONFLICT' });
  f.db.cancelTicket(saved.ticket.id);
  assert.equal(f.db.queueAnsweredReviewContinuation(saved.ticket.id, request).code, 'TICKET_STOPPED');
  assert.equal(f.db.getTicket(saved.ticket.id).status, 'cancelled');
  assert.equal(f.db.getAssignment(saved.assignment.id).reviewContinuation, undefined);
});

test('internal review_wait cannot create a user Attention', async t => {
  const f = await fixture(t), saved = blockedResult(f);
  const internal = { verdict: 'wait', waitKind: 'review_wait', retryable: true, reason: '证据服务暂不可用。' };
  f.db.commitResult(saved.ticket.id, { result: { ...saved.result, review: internal }, status: 'waiting',
    instructionRevision: 1, uniqueKey: 'internal', reviewContinuation: { expectedResultVersion: 1 } });
  assert.throws(() => f.db.openReviewAttention(saved.ticket.id, { assignmentId: saved.assignment.id, runId: saved.run.id,
    sessionId: saved.run.sessionId, instructionRevision: 1, resultVersion: 2,
    userDecision: saved.review.userDecision, delivery: saved.review.delivery }), /does not match/);
  assert.equal(f.db.attentions(saved.ticket.id).length, 1, 'internal wait adds no question');
  assert.throws(() => f.db.answerDesktopAttention(answer(saved)), /requirements changed/);
});

for (const channel of ['feishu', 'telegram', 'discord', 'whatsapp', 'weixin']) test(`${channel} reply to a review question resumes the same task`, async t => {
  const f = await fixture(t), saved = blockedResult(f, { channel });
  const [outbox] = f.db.claimOutbox('sender');
  f.db.finishOutbox(outbox.id, { owner: 'sender', sent: true, receipt: { messageId: 'published-question' } });
  f.restart();
  const text = channel === 'weixin' ? `/answer ${saved.attention.id} 按北京时间整理。` : '按北京时间整理。';
  const accepted = ingestAssistantEvent(f.db, { channel, sourceKey: 'reply', threadId: 'reply-thread',
    source: { ...saved.ticket.mandate.source, messageId: 'answer', ...(channel === 'weixin' ? {} : { parentMessageId: 'published-question' }) },
    actor: { kind: 'human', id: 'owner' }, text, kind: 'group', mentioned: true },
  { version: 'p1', ownerIds: ['owner'], threadIds: ['chat'] });
  assert.equal(accepted.attention.id, saved.attention.id);
  assert.equal(accepted.requiresEval, false);
  assert.equal(f.db.queueAnsweredAttention({ validateMandate: () => true }), 1);
  assert.equal(f.db.getAssignment(saved.assignment.id).reviewContinuation.reviewAnswer.text, text);
  assert.equal(f.db.getAssignment(saved.assignment.id).reviewContinuation.reviewAnswer.answer.custom, '按北京时间整理。');
});
