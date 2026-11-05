import { validateTicketMandate } from './assessment-policy.mjs';
import { withRecoveredEvidence, verifyExecutionArtifacts } from './execution-evidence.mjs';
import { reviewInputHash } from './review-input.mjs';
import { createReviewEvidenceReader } from './review-evidence-reader.mjs';
import { commitReviewedResult } from './review-result-commit.mjs';
import { recoverableReview } from './ticket-review.mjs';

/** Recheck saved evidence; execution corrections are queued separately in the same task. */
export function createReviewContinuation({ ctx, database, readPolicy, review, signal }) {
  return async (ticketId, { expectedResultVersion } = {}) => {
    signal.throwIfAborted();
    const ticket = database.getTicket(ticketId);
    const previous = database.results(ticketId).at(-1);
    if (!Number.isSafeInteger(expectedResultVersion) || ticket?.status !== 'waiting'
      || ticket.resultVersion !== expectedResultVersion || previous?.review?.verdict !== 'wait'
      || previous.instructionRevision !== ticket.instructionRevision) throw new Error('工单待验收状态已变化，请刷新');
    if (previous.review.waitKind === 'blocked' || previous.review.userDecision || previous.delivery?.action === 'ask') {
      throw Object.assign(new Error('该工单正在等待原问题的回答，请通过对应问题继续'), { code: 'ATTENTION_PENDING' });
    }
    const assignment = database.assignments(ticketId).find(item => database.runs(item.id).some(run => run.id === previous.runId));
    const run = assignment && database.runs(assignment.id).find(item => item.id === previous.runId);
    if (!run || assignment.state !== 'completed') throw new Error('原执行证据不可用');
    const policy = await readPolicy();
    if (!validateTicketMandate(ticket.mandate, { policy })) throw new Error('工单授权已变化');
    const reviewSignal = AbortSignal.any([signal, AbortSignal.timeout(120000)]);
    return withRecoveredEvidence({ ctx, run, signal }, async saved => {
      const answeredAttentions = database.answeredAttentionForReview(ticket.id, { instructionRevision: ticket.instructionRevision,
        runId: saved.runId, sessionId: saved.sessionId });
      const input = { llm: ctx.llm, database, model: ticket.mandate.source?.channel === 'desktop' ? assignment.model : policy.model,
        ticket, result: saved, rules: policy.rules, signal: reviewSignal, routingConfig: policy.routingConfig,
        answeredAttentions,
        ...(ctx.sessionQuery?.readSession ? { readEvidence: createReviewEvidenceReader({ ctx, result: saved }) } : {}) };
      const inputHash = reviewInputHash(input);
      if (!previous.review.budgetWait && !previous.review.retryable && previous.review.inputHash === inputHash) {
        const latest = database.getTicket(ticketId);
        if (latest.status !== 'waiting' || latest.resultVersion !== expectedResultVersion || latest.instructionRevision !== ticket.instructionRevision) throw new Error('工单待验收状态已变化，请刷新');
        return { ticket: latest, result: previous, unchanged: true, waitKind: 'review_wait' };
      }
      const verdict = { ...await recoverableReview(review, input, signal), inputHash };
      if (verdict.retryable) verdict.retryAttempts = (previous.review.retryAttempts || 0) + 1;
      signal.throwIfAborted();
      if (!['passed', 'failed', 'wait', 'rework'].includes(verdict?.verdict) || typeof verdict.reason !== 'string' || !verdict.reason.trim()) throw new Error('验收返回无效结论');
      if (run.environment) await verifyExecutionArtifacts(run, saved, signal);
      const current = await readPolicy();
      signal.throwIfAborted();
      const versionKey = ticket.mandate.source?.channel === 'desktop' ? 'desktopVersion' : 'version';
      if (current[versionKey] !== policy[versionKey] || !validateTicketMandate(ticket.mandate, { policy: current })) throw new Error('工单授权在验收期间变化');
      return commitReviewedResult({ database, ticket, result: { ...saved, reviewedFromVersion: expectedResultVersion }, verdict,
        model: assignment.model || policy.model,
        reviewContinuation: { expectedResultVersion }, uniqueKey: `review-continuation:${ticketId}:${expectedResultVersion}` });
    });
  };
}
