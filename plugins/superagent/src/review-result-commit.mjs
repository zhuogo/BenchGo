import { resultDelivery, previouslyDelivered, resultOutbox, systemStateDelivery } from './result-delivery.mjs';

/** Review is one step of the original Ticket, never a new execution or terminal failure. */
export function commitReviewedResult({ database, ticket, result, verdict, assignment, model, uniqueKey, reviewContinuation }) {
  if (!['passed', 'failed', 'wait', 'rework'].includes(verdict?.verdict)) throw new Error('Invalid review verdict');
  const base = { assignment, uniqueKey, instructionRevision: ticket.instructionRevision, reviewContinuation };
  const previous = database.results(ticket.id).at(-1);
  let delivery = resultDelivery({ ticket, result, verdict, previous, previousDelivered: previouslyDelivered(database, ticket) });
  // Missing/invalid model output is an explicit recoverable host state. It must
  // not complete the task or publish raw Worker prose as a Router report.
  if (delivery.origin === 'system' && delivery.systemState.state === 'delivery_wait') {
    verdict = { ...verdict, verdict: 'wait', waitKind: 'review_wait', retryable: true,
      diagnostic: { code: delivery.systemState.code, at: new Date().toISOString() }, delivery };
  }
  const repair = ['rework', 'failed'].includes(verdict.verdict);
  if (repair && (typeof verdict.instruction !== 'string' || !verdict.instruction.trim())) {
    delivery = systemStateDelivery({ state: 'review_wait', code: 'CORRECTION_INSTRUCTION_MISSING' });
    verdict = { ...verdict, verdict: 'wait', waitKind: 'review_wait', retryable: true,
      diagnostic: { code: 'CORRECTION_INSTRUCTION_MISSING', at: new Date().toISOString() }, delivery };
  }
  const rework = ['rework', 'failed'].includes(verdict.verdict) ? { instruction: verdict.instruction, model } : undefined;
  const blocked = verdict.verdict === 'wait' && verdict.waitKind === 'blocked'
    ? { userDecision: verdict.userDecision, delivery } : undefined;
  return database.commitResult(ticket.id, { ...base, status: verdict.verdict === 'passed' ? 'completed' : 'waiting',
    result: { ...result, review: verdict, delivery }, rework, blocked,
    outboxPayload: resultOutbox({ ticket, result, delivery }) });
}
