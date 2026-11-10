// Persisted Run receipts own the budget across claims, process restarts and checks.
export const automaticContinuationLimit = 2;
export function interruptedContinuationPolicy(run, { now = Date.now() } = {}) {
  // Receipts predating the explicit source flag came from the autonomous path.
  const attempts = (run?.interruptedRecoveries || []).filter(row => row.automatic !== false);
  const last = attempts.at(-1), exhausted = attempts.length >= automaticContinuationLimit;
  const queuedAt = last && Date.parse(last.at);
  const failedAt = last?.queued !== false && run?.state === 'uncertain' && run.fence > last?.fromFence ? Date.parse(run.updatedAt) : NaN;
  const at = Number.isFinite(failedAt) ? Math.max(queuedAt, failedAt) : queuedAt;
  const nextAttemptAt = !exhausted && Number.isFinite(at)
    ? at + Math.min(900_000, 30_000 * 2 ** Math.min(attempts.length - 1, 5)) : null;
  return { attempts: attempts.length, limit: automaticContinuationLimit, exhausted, nextAttemptAt,
    backingOff: !exhausted && nextAttemptAt !== null && now < nextAttemptAt };
}
