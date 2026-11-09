import { createHash, randomUUID } from 'node:crypto';

const fail = (code, message) => Object.assign(new Error(message), { code });
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stopped = new Set(['closed', 'cancelled', 'cancelling', 'completed', 'failed', 'paused', 'pausing']);

/** One durable input ledger shared by source adapters, revisions and execution sessions. */
export function installTicketInputStore({ db, tx, api }) {
  db.exec(`CREATE TABLE IF NOT EXISTS sa_ticket_inputs(
    id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES sa_tickets(id), trigger_id TEXT NOT NULL REFERENCES sa_triggers(id),
    idempotency_key TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL, kind TEXT NOT NULL,
    instruction_revision INTEGER NOT NULL, authorization_version INTEGER NOT NULL, snapshot TEXT,
    state TEXT NOT NULL, received_at TEXT NOT NULL, application TEXT,
    UNIQUE(ticket_id,trigger_id));
    CREATE INDEX IF NOT EXISTS sa_ticket_inputs_pending ON sa_ticket_inputs(ticket_id,state);
    CREATE TABLE IF NOT EXISTS sa_ticket_boundaries(
    assignment_id TEXT NOT NULL REFERENCES sa_assignments(id), boundary_id TEXT NOT NULL,
    run_id TEXT NOT NULL REFERENCES sa_runs(id), snapshot TEXT NOT NULL, applied_at TEXT NOT NULL,
    PRIMARY KEY(assignment_id,boundary_id));`);
  const value = row => row && ({ id: row.id, ticketId: row.ticket_id, triggerId: row.trigger_id,
    idempotencyKey: row.idempotency_key, kind: row.kind, instructionRevision: row.instruction_revision,
    authorizationVersion: row.authorization_version, snapshot: row.snapshot ? JSON.parse(row.snapshot) : null,
    state: row.state, receivedAt: row.received_at, application: row.application ? JSON.parse(row.application) : null,
    source: api.getTrigger(row.trigger_id)?.source, actor: api.getTrigger(row.trigger_id)?.actor });
  const snapshot = (ticket, revision = ticket.instructionRevision) => {
    const savedRow = db.prepare('SELECT snapshot FROM sa_ticket_revisions WHERE ticket_id=? AND revision=?').get(ticket.id, revision);
    const saved = savedRow && JSON.parse(savedRow.snapshot);
    if (!saved && revision !== ticket.instructionRevision) throw fail('REVISION_SNAPSHOT_MISSING', '原执行要求快照缺失，须核实后继续');
    const row = saved || ticket, mandate = structuredClone(row.mandate);
    return { instructionRevision: revision, authorizationVersion: row.authorizationVersion ?? mandate.authorizationVersion ?? 1,
      target: row.target, acceptance: row.acceptance, mandate,
      context: structuredClone(row.context || []), toolScope: structuredClone(row.toolScope ?? mandate.scope?.toolNames ?? mandate.toolScope ?? null) };
  };
  function record(input) {
    const ticket = db.prepare('SELECT * FROM sa_tickets WHERE id=?').get(input.ticketId), trigger = api.getTrigger(input.triggerId);
    if (!ticket || !trigger || !['context', 'revision', 'answer', 'stop', 'pause', 'authorization'].includes(input.kind)
      || typeof input.idempotencyKey !== 'string' || !input.idempotencyKey || input.idempotencyKey.length > 2048) throw fail('INVALID_TICKET_INPUT', '工单输入缺少可信来源或幂等键');
    const revision = input.instructionRevision ?? ticket.instruction_revision;
    const current = db.prepare('SELECT snapshot FROM sa_ticket_revisions WHERE ticket_id=? ORDER BY revision DESC LIMIT 1').get(input.ticketId);
    const authorizationVersion = input.authorizationVersion ?? (current ? JSON.parse(current.snapshot).mandate.authorizationVersion : JSON.parse(ticket.mandate).authorizationVersion) ?? 1;
    const fingerprint = digest([input.ticketId, input.triggerId, input.kind, input.kind === 'context' ? null : revision, input.kind === 'context' ? null : authorizationVersion, input.snapshot ?? null]);
    const keyed = db.prepare('SELECT * FROM sa_ticket_inputs WHERE idempotency_key=?').get(input.idempotencyKey);
    const sourced = db.prepare('SELECT * FROM sa_ticket_inputs WHERE ticket_id=? AND trigger_id=?').get(input.ticketId, input.triggerId);
    if (keyed && sourced && keyed.id !== sourced.id) throw fail('IDEMPOTENCY_CONFLICT', '幂等键已用于另一条输入');
    const old = keyed || sourced;
    if (old) {
      // A stable source message is one input even when it reaches another entry.
      if (old.ticket_id === input.ticketId && old.trigger_id === input.triggerId && input.kind === 'context') return value(old);
      if (old.ticket_id === input.ticketId && old.trigger_id === input.triggerId && old.kind === 'context' && ['revision', 'stop', 'pause'].includes(input.kind) && old.state === 'pending') {
        db.prepare('UPDATE sa_ticket_inputs SET kind=?,fingerprint=?,instruction_revision=?,authorization_version=?,snapshot=? WHERE id=?')
          .run(input.kind, fingerprint, revision, authorizationVersion, input.snapshot ? JSON.stringify(input.snapshot) : null, old.id);
        return value(db.prepare('SELECT * FROM sa_ticket_inputs WHERE id=?').get(old.id));
      }
      if (old.ticket_id !== input.ticketId || old.trigger_id !== input.triggerId || old.kind !== input.kind
        || (old.idempotency_key === input.idempotencyKey && old.fingerprint !== fingerprint)) throw fail('IDEMPOTENCY_CONFLICT', '同一输入已登记为不同工单或内容');
      return value(old);
    }
    const id = randomUUID(), at = new Date().toISOString();
    db.prepare('INSERT INTO sa_ticket_inputs VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(id, input.ticketId, input.triggerId,
      input.idempotencyKey, fingerprint, input.kind, revision, authorizationVersion,
      input.snapshot ? JSON.stringify(input.snapshot) : null, 'pending', at, null);
    return value(db.prepare('SELECT * FROM sa_ticket_inputs WHERE id=?').get(id));
  }
  function applyInput(triggerId, application) {
    const row = db.prepare('SELECT * FROM sa_ticket_inputs WHERE trigger_id=? AND ticket_id=(SELECT ticket_id FROM sa_assignments WHERE id=?)').get(triggerId, application.assignmentId);
    if (!row) throw fail('TICKET_INPUT_NOT_FOUND', '输入未登记到此工单');
    if (row.state === 'applied') return value(row);
    const assignment = api.getAssignment(application.assignmentId), run = api.runs(assignment.id).find(row => row.id === application.runId);
    if (assignment.owner !== application.owner || assignment.fence !== application.fence || assignment.state !== 'claimed' || assignment.leaseUntil <= Date.now()
      || !run || run.owner !== application.owner || run.fence !== application.fence || (application.sessionId && run.sessionId !== application.sessionId)) throw fail('FENCING_CONFLICT', '输入应用不属于当前真实执行');
    db.prepare("UPDATE sa_ticket_inputs SET state='applied',application=? WHERE id=?").run(JSON.stringify({ ...application, at: new Date().toISOString() }), row.id);
    return value(db.prepare('SELECT * FROM sa_ticket_inputs WHERE id=?').get(row.id));
  }
  function updatePayload(row, current, at) {
    const prior = JSON.parse(row.payload);
    const originalRow = db.prepare('SELECT snapshot FROM sa_ticket_revisions WHERE ticket_id=? AND revision=?').get(row.ticket_id, prior.instructionRevision ?? 1);
    const original = originalRow && JSON.parse(originalRow.snapshot);
    const wholeTicket = prior.wholeTicketScope ?? (!prior.text?.trim() || prior.text === (prior.appliedSnapshot?.target ?? original?.target ?? current.target));
    const executionScope = wholeTicket ? current.target : prior.text;
    current = { ...current, executionScope };
    const payload = { ...prior, instructionRevision: current.instructionRevision,
      authorizationVersion: current.authorizationVersion, wholeTicketScope: wholeTicket, text: executionScope, acceptance: current.acceptance, appliedSnapshot: current };
    db.prepare('UPDATE sa_assignments SET payload=?,updated_at=? WHERE id=?').run(JSON.stringify(payload), at, row.id);
    return current;
  }
  function controlApplied(ticketId, triggerId, kind = 'stop') {
    const row = db.prepare('SELECT * FROM sa_ticket_inputs WHERE ticket_id=? AND trigger_id=? AND kind=?').get(ticketId, triggerId, kind);
    const ticket = api.getTicket(ticketId);
    const paused = kind === 'pause';
    if (!row || !(paused ? ['pausing', 'paused'] : ['cancelling', 'cancelled']).includes(ticket?.status)) throw fail('TICKET_CONTROL_NOT_APPLIED', paused ? '暂停请求尚未应用到工单' : '停止请求尚未应用到工单');
    if (row.state !== 'applied') db.prepare("UPDATE sa_ticket_inputs SET state='applied',application=? WHERE id=?").run(JSON.stringify({
      kind: `${kind}-request`, boundaryId: `control:${kind}:${triggerId}`, runId: null, ticketStatus: ticket.status,
      // The request is applied; actual executor stop remains its separate fact.
      ...(paused ? { executionPaused: ticket.status === 'paused' } : { executionStopped: ticket.status === 'cancelled' }), at: new Date().toISOString(),
    }), row.id);
    return value(db.prepare('SELECT * FROM sa_ticket_inputs WHERE id=?').get(row.id));
  }
  // Additive migration of the existing source inbox into the single input ledger.
  for (const row of db.prepare('SELECT o.* FROM sa_message_ownership o LEFT JOIN sa_ticket_inputs i ON i.ticket_id=o.ticket_id AND i.trigger_id=o.trigger_id WHERE i.id IS NULL').all()) {
    const prior = db.prepare('SELECT * FROM sa_subscription_applied WHERE trigger_id=?').get(row.trigger_id);
    const payload = prior && db.prepare('SELECT payload FROM sa_assignments WHERE id=?').get(prior.assignment_id);
    const original = payload && JSON.parse(payload.payload);
    const receipt = record({ ticketId: row.ticket_id, triggerId: row.trigger_id, kind: 'context', idempotencyKey: `trigger:${row.trigger_id}`,
      ...(original ? { instructionRevision: original.instructionRevision ?? 1, authorizationVersion: original.authorizationVersion ?? 1 } : {}) });
    db.prepare('UPDATE sa_ticket_inputs SET received_at=? WHERE id=?').run(row.delivered_at, receipt.id);
    if (prior && receipt.state !== 'applied') {
      const run = api.runs(prior.assignment_id).find(run => run.sessionId === prior.session_id);
      db.prepare("UPDATE sa_ticket_inputs SET state='applied',application=? WHERE id=?").run(JSON.stringify({ assignmentId: prior.assignment_id,
        runId: run?.id ?? null, sessionId: prior.session_id, messageId: prior.message_id, boundaryId: `message:${prior.message_id}`, at: prior.applied_at, migrated: true }), receipt.id);
    }
  }
  return {
    recordTicketInput: input => tx(() => record(input)),
    recordTicketInputInTransaction: record,
    ticketInputs: ticketId => db.prepare('SELECT * FROM sa_ticket_inputs WHERE ticket_id=? ORDER BY rowid').all(ticketId).map(value),
    pendingTicketInputs: ticketId => db.prepare("SELECT * FROM sa_ticket_inputs WHERE ticket_id=? AND state='pending' ORDER BY rowid").all(ticketId).map(value),
    applyTicketInputInTransaction: applyInput,
    applyTicketInput: (triggerId, application) => tx(() => applyInput(triggerId, application)),
    applyTicketStopInputInTransaction: controlApplied,
    applyTicketStopInput: (ticketId, triggerId) => tx(() => controlApplied(ticketId, triggerId)),
    applyTicketPauseInputInTransaction: (ticketId, triggerId) => controlApplied(ticketId, triggerId, 'pause'),
    saveExecutionInputDisposition(triggerId, { assignmentId, owner, fence, runId, sessionId, disposition }) {
      return tx(() => {
        const assignment = api.getAssignment(assignmentId), run = assignment && api.runs(assignmentId).find(row => row.id === runId);
        const input = assignment && db.prepare('SELECT * FROM sa_ticket_inputs WHERE ticket_id=? AND trigger_id=?').get(assignment.ticketId, triggerId);
        if (!assignment || assignment.state !== 'claimed' || assignment.owner !== owner || assignment.fence !== fence || assignment.leaseUntil <= Date.now()
          || !run || run.owner !== owner || run.fence !== fence || run.sessionId !== sessionId || !input) throw fail('FENCING_CONFLICT', '执行输入分诊不属于当前真实执行');
        if (input.kind !== 'context') return value(input);
        // A context receipt has no requirement snapshot. Reuse that existing JSON
        // slot for its host disposition; no parallel input or lifecycle ledger.
        db.prepare('UPDATE sa_ticket_inputs SET snapshot=? WHERE id=?').run(JSON.stringify({ executionInput: disposition }), input.id);
        return value(db.prepare('SELECT * FROM sa_ticket_inputs WHERE id=?').get(input.id));
      });
    },
    appliedTicketSnapshot(assignmentId) {
      const assignment = api.getAssignment(assignmentId);
      if (!assignment) throw fail('ASSIGNMENT_NOT_FOUND', '执行安排不存在');
      return structuredClone(assignment.appliedSnapshot || { ...snapshot(api.getTicket(assignment.ticketId), assignment.instructionRevision ?? 1), executionScope: assignment.text?.trim() || api.getTicket(assignment.ticketId).target });
    },
    applyQueuedTicketRevisionInTransaction(assignmentId, { now = Date.now() } = {}) {
      const row = db.prepare('SELECT * FROM sa_assignments WHERE id=?').get(assignmentId);
      if (!row || row.state !== 'queued') return;
      const ticket = api.getTicket(row.ticket_id);
      if (stopped.has(ticket.status)) return;
      updatePayload(row, snapshot(ticket), new Date(now).toISOString());
    },
    applyTicketRevision(assignmentId, { owner, fence, runId, boundaryId, now = Date.now() }) {
      return tx(() => {
        const row = db.prepare('SELECT * FROM sa_assignments WHERE id=?').get(assignmentId), run = row && api.runs(assignmentId).find(row => row.id === runId);
        if (!row || row.state !== 'claimed' || row.owner !== owner || row.fence !== fence || row.lease_until <= now
          || !run || run.owner !== owner || run.fence !== fence) throw fail('FENCING_CONFLICT', '要求切换不属于当前真实执行');
        const ticket = api.getTicket(row.ticket_id);
        if (stopped.has(ticket.status)) throw fail(['paused', 'pausing'].includes(ticket.status) ? 'TICKET_PAUSED' : 'TICKET_STOPPED', '工单暂停或停止，输入仅保留不执行');
        if (typeof boundaryId !== 'string' || !boundaryId || boundaryId.length > 1024) throw fail('INVALID_EXECUTION_BOUNDARY', '要求切换缺少工具批次边界');
        const old = db.prepare('SELECT * FROM sa_ticket_boundaries WHERE assignment_id=? AND boundary_id=?').get(assignmentId, boundaryId);
        if (old) {
          if (old.run_id !== runId) throw fail('RUN_CONFLICT', '工具边界已归属另一执行');
          return JSON.parse(old.snapshot);
        }
        const at = new Date(now).toISOString(), current = updatePayload(row, snapshot(ticket), at);
        const savedRun = db.prepare('SELECT payload FROM sa_runs WHERE id=?').get(runId);
        db.prepare('UPDATE sa_runs SET payload=?,updated_at=? WHERE id=?').run(JSON.stringify({ ...JSON.parse(savedRun.payload), appliedSnapshot: current, instructionRevision: current.instructionRevision, authorizationVersion: current.authorizationVersion }), at, runId);
        db.prepare('INSERT INTO sa_ticket_boundaries VALUES (?,?,?,?,?)').run(assignmentId, boundaryId, runId, JSON.stringify(current), at);
        for (const input of db.prepare("SELECT trigger_id FROM sa_ticket_inputs WHERE ticket_id=? AND state='pending' AND kind IN ('revision','authorization') AND instruction_revision<=?").all(ticket.id, current.instructionRevision)) {
          applyInput(input.trigger_id, { assignmentId, owner, fence, runId, boundaryId, sessionId: run.sessionId });
        }
        return current;
      });
    },
  };
}
