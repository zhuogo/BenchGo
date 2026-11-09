const fail = (code, message) => Object.assign(new Error(message), { code });
const inspectionCodes = new Set(['VERIFIED_INTERRUPTED', 'VERIFIED_COMPLETED', 'VERIFIED_PAUSED', 'EVIDENCE_MISMATCH', 'EXECUTION_EFFECTS_UNKNOWN',
  'SESSION_UNAVAILABLE', 'SESSION_STILL_LIVE', 'WORKER_MODEL_ROUTE', 'CHECKPOINT_UNCERTAIN', 'CHECKPOINT_RESTORED',
  'EXECUTION_PAUSE_UNVERIFIED', 'FENCING_CONFLICT', 'INSTRUCTION_REVISION_CONFLICT', 'MANDATE_REVOKED', 'EVIDENCE_UNVERIFIED']);

/** BenchGo ledger boundary only; official session ownership is verified by the caller. */
export function installInterruptedContinuationStore({ db, tx, api }) {
  return {
    queueInterruptedContinuation(assignmentId, { fence, runId, instructionRevision, evidence, mandate, validateMandate, now = Date.now() }) {
      return tx(() => {
        const assignment = api.getAssignment(assignmentId), ticket = assignment && api.getTicket(assignment.ticketId);
        const run = api.runs(assignmentId).find(item => item.id === runId && item.fence === fence);
        if (!assignment || assignment.state !== 'uncertain' || assignment.fence !== fence || !run || run.state !== 'uncertain'
          || assignment.stopRequest || assignment.retiredExecution) throw fail('FENCING_CONFLICT', 'Interrupted execution ownership changed');
        if (ticket?.status !== 'open' || typeof validateMandate !== 'function' || !validateMandate(ticket.mandate)
          || JSON.stringify(ticket.mandate) !== JSON.stringify(mandate)) throw fail('MANDATE_REVOKED', 'Original execution authorization changed');
        if (ticket.instructionRevision !== instructionRevision || assignment.instructionRevision !== instructionRevision) throw fail('INSTRUCTION_REVISION_CONFLICT', 'Interrupted execution requirements changed');
        if (!api.getWorkerExecutionState(runId)?.models?.length || evidence?.interrupted !== true
          || evidence.runId !== runId || evidence.sessionId !== run.sessionId || evidence.directory !== run.directory
          || !evidence.checkpoint?.manifestHash || !evidence.transcript?.hash || !Number.isSafeInteger(evidence.transcript.lastSeq)
          || evidence.executionEffects?.effectsVerified !== true) throw fail('EVIDENCE_MISMATCH', 'Safe interrupted execution evidence is unavailable');
        const row = db.prepare('SELECT payload FROM sa_assignments WHERE id=?').get(assignmentId), payload = JSON.parse(row.payload);
        for (const key of ['contextContinuation', 'attentionContinuation', 'pauseContinuation', 'verificationOnly']) delete payload[key];
        payload.interruptedContinuation = { runId, instructionRevision, observation: evidence.transcript, at: new Date(now).toISOString() };
        const runPayload = JSON.parse(db.prepare('SELECT payload FROM sa_runs WHERE id=?').get(runId).payload);
        runPayload.evidence = evidence;
        runPayload.interruptedRecoveries = [...(runPayload.interruptedRecoveries || []), {
          fromFence: fence, instructionRevision, sessionId: run.sessionId,
          observation: evidence.transcript, at: new Date(now).toISOString(),
        }];
        db.prepare('UPDATE sa_runs SET payload=?,updated_at=? WHERE id=?').run(JSON.stringify(runPayload), new Date(now).toISOString(), runId);
        db.prepare("UPDATE sa_assignments SET state='queued',owner=NULL,lease_until=NULL,payload=?,updated_at=? WHERE id=?").run(JSON.stringify(payload), new Date(now).toISOString(), assignmentId);
        return api.getAssignment(assignmentId);
      });
    },
    recordExecutionInspection(assignmentId, { fence, runId, instructionRevision, id, status, code, observation, now = Date.now() }) {
      if (typeof id !== 'string' || !id.trim() || id.length > 256 || !['verified', 'blocked'].includes(status)
        || !Number.isSafeInteger(now)) throw fail('INSPECTION_INVALID', 'Invalid execution inspection receipt');
      code = inspectionCodes.has(code) ? code : 'EVIDENCE_UNVERIFIED';
      return tx(() => {
        const assignment = api.getAssignment(assignmentId), ticket = assignment && api.getTicket(assignment.ticketId);
        const run = api.runs(assignmentId).find(item => item.id === runId && item.fence === fence);
        if (!assignment || assignment.state !== 'uncertain' || assignment.fence !== fence || !run
          || !['uncertain', 'verifying'].includes(run.state) || assignment.stopRequest || assignment.retiredExecution
          || !['open', 'pausing'].includes(ticket?.status)) throw fail('FENCING_CONFLICT', 'Execution inspection ownership changed');
        if (ticket.instructionRevision !== instructionRevision || assignment.instructionRevision !== instructionRevision) throw fail('INSTRUCTION_REVISION_CONFLICT', 'Execution inspection requirements changed');
        if (status === 'verified' && (!['VERIFIED_INTERRUPTED', 'VERIFIED_COMPLETED', 'VERIFIED_PAUSED'].includes(code)
          || observation?.sessionId !== run.sessionId || !Number.isSafeInteger(observation.lastSeq)
          || typeof observation.hash !== 'string' || !/^[a-f0-9]{64}$/.test(observation.hash))) throw fail('EVIDENCE_MISMATCH', 'Verified inspection requires observed official transcript identity');
        const row = db.prepare('SELECT payload FROM sa_assignments WHERE id=?').get(assignmentId), payload = JSON.parse(row.payload);
        const receipt = { id, at: new Date(now).toISOString(), status, code,
          attempts: (payload.lastInspection?.attempts || 0) + 1, runId, sessionId: run.sessionId, instructionRevision, fence,
          ...(status === 'verified' ? { observation: { sessionId: run.sessionId, lastSeq: observation.lastSeq, hash: observation.hash } } : {}) };
        if (payload.lastInspection?.id === id) {
          if (payload.lastInspection.status !== status || payload.lastInspection.code !== code
            || JSON.stringify(payload.lastInspection.observation) !== JSON.stringify(receipt.observation)) throw fail('INSPECTION_CONFLICT', 'Execution inspection id was reused for a different result');
          return payload.lastInspection;
        }
        payload.lastInspection = receipt;
        db.prepare('UPDATE sa_assignments SET payload=?,updated_at=? WHERE id=?').run(JSON.stringify(payload), new Date(now).toISOString(), assignmentId);
        return receipt;
      });
    },
  };
}
