import { resultDelivery, resultOutbox } from './result-delivery.mjs';

/** Deterministic identity and record checks, never content acceptance. */
export function commitWorkerResult({ database, ticket, result, assignment, uniqueKey }) {
  if (result?.review !== undefined) throw new Error('Content review is retired');
  if (!result?.selfCheck || typeof result.selfCheck.summary !== 'string' || !result.selfCheck.summary.trim()) throw Object.assign(new Error('Worker self-check record is required'), { code: 'SELF_CHECK_MISSING' });
  const outcome = result.outcome || 'completed';
  if (!['completed', 'failed'].includes(outcome)) throw new Error('Invalid result outcome');
  if (outcome === 'failed' && ['attempted', 'cause', 'resumeConditions'].some(key => typeof result.failure?.[key] !== 'string' || !result.failure[key].trim())) throw new Error('Structural failure requires attempts, cause and recovery conditions');
  if (result.executionEffects?.effectsVerified === false) throw Object.assign(new Error('Execution effects require reconciliation'), { code: 'EXECUTION_EFFECTS_UNKNOWN' });
  if (result.selfCheckRevision !== undefined && result.selfCheckRevision !== ticket.instructionRevision) throw Object.assign(new Error('Self-check requirements are stale'), { code: 'INSTRUCTION_REVISION_CONFLICT' });
  const saved = { ...result, outcome };
  const delivery = resultDelivery({ ticket, result: saved });
  return database.commitResult(ticket.id, { assignment, uniqueKey, instructionRevision: ticket.instructionRevision,
    status: 'waiting', result: { ...saved, delivery }, outboxPayload: resultOutbox({ ticket, result: saved, delivery }) });
}
