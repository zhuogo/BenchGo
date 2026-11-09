const fail = (code, message) => Object.assign(new Error(message), { code });

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
        db.prepare('UPDATE sa_runs SET payload=?,updated_at=? WHERE id=?').run(JSON.stringify(runPayload), new Date(now).toISOString(), runId);
        db.prepare("UPDATE sa_assignments SET state='queued',owner=NULL,lease_until=NULL,payload=?,updated_at=? WHERE id=?").run(JSON.stringify(payload), new Date(now).toISOString(), assignmentId);
        return api.getAssignment(assignmentId);
      });
    },
  };
}
