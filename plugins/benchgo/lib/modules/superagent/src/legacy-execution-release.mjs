/** Old evidence-only leases advanced the fence without starting another executor. */
export function migrateLegacyExecutionRelease(db) {
  for (const row of db.prepare(`SELECT a.id,a.ticket_id,a.fence,a.payload,r.id AS run_id,r.payload AS run_payload
    FROM sa_assignments a JOIN sa_runs r ON r.assignment_id=a.id AND r.fence=a.fence
    WHERE json_type(r.payload,'$.executionFence')='integer' AND json_type(r.payload,'$.executionOwner')='text'`).all()) {
    const assignment = JSON.parse(row.payload), run = JSON.parse(row.run_payload), stopped = assignment.executionStopped;
    // These host-written fields identify the executor separately from its later
    // verification leases. Never promote an arbitrary older release receipt.
    if (run.executionFence >= row.fence || stopped?.fence !== run.executionFence || stopped?.owner !== run.executionOwner
      || !Number.isFinite(Date.parse(stopped.at))
      || assignment.verificationOnly?.runId !== row.run_id && assignment.lastFailure?.stage !== 'result') continue;
    assignment.executionStopped = { ...stopped, fence: row.fence, legacyExecution: { fence: run.executionFence, owner: run.executionOwner } };
    db.prepare('UPDATE sa_assignments SET payload=? WHERE id=?').run(JSON.stringify(assignment), row.id);
    run.legacyExecution = { fence: run.executionFence, owner: run.executionOwner };
    delete run.executionFence; delete run.executionOwner;
    db.prepare('UPDATE sa_runs SET payload=? WHERE id=?').run(JSON.stringify(run), row.run_id);
    const ticket = db.prepare('SELECT execution_control FROM sa_tickets WHERE id=?').get(row.ticket_id);
    if (!JSON.parse(ticket.execution_control || '{}').stopRequested) continue;
    db.prepare("UPDATE sa_assignments SET state='cancelled',owner=NULL,lease_until=NULL WHERE id=?").run(row.id);
    db.prepare("UPDATE sa_runs SET state='cancelled' WHERE id=? AND state IN ('prepared','submitted','running','verifying','uncertain')").run(row.run_id);
    if (!db.prepare("SELECT 1 FROM sa_assignments WHERE ticket_id=? AND state NOT IN ('completed','failed','cancelled')").get(row.ticket_id))
      db.prepare("UPDATE sa_tickets SET execution_control=? WHERE id=?").run(JSON.stringify({ stopRequested: false, stopped: true }), row.ticket_id);
  }
}
