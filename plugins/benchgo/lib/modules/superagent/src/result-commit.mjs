/** Preserve the original Worker draft; association only governs lifecycle updates. */
export function commitWorkerResult({ database, task, result, assignment, uniqueKey }) {
  const saved = database.commitResult(task.id, { assignment, uniqueKey,
    instructionRevision: result.instructionRevision ?? assignment?.instructionRevision ?? task.instructionRevision,
    status: result.outcome === 'failed' ? 'waiting' : 'completed', result: { ...result, completionPending: result.completionPending === true } });
  if (saved.pending) throw Object.assign(new Error('Draft retained; lifecycle or notification persistence is pending'), { code: 'RESULT_FINALIZE_PENDING', result: saved.result });
  return saved;
}
