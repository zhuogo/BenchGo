import { createHash, randomUUID } from 'node:crypto';

const fail = (code, message) => Object.assign(new Error(message), { code });
const terminal = new Set(['completed', 'failed', 'closed', 'cancelled']);

/** Immutable authorization snapshots; the original Ticket Mandate is never overwritten. */
export function installTicketRevisions({ db, tx, api }) {
  db.exec(`CREATE TABLE IF NOT EXISTS sa_ticket_revisions(
    ticket_id TEXT NOT NULL REFERENCES sa_tickets(id), revision INTEGER NOT NULL,
    operation TEXT NOT NULL, snapshot TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY(ticket_id,revision));
    CREATE TABLE IF NOT EXISTS sa_ticket_revision_requests(
    request_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, ticket_id TEXT NOT NULL REFERENCES sa_tickets(id), revision INTEGER NOT NULL);`);
  const history = ticketId => db.prepare('SELECT * FROM sa_ticket_revisions WHERE ticket_id=? ORDER BY revision').all(ticketId)
    .map(row => ({ ...JSON.parse(row.snapshot), instructionRevision: row.revision, operation: row.operation, createdAt: row.created_at }));
  return {
    ticketRevisions: history,
    currentTicketMandate(ticketId, fallback) {
      const row = db.prepare('SELECT snapshot FROM sa_ticket_revisions WHERE ticket_id=? ORDER BY revision DESC LIMIT 1').get(ticketId);
      return row ? JSON.parse(row.snapshot).mandate : fallback;
    },
    changeTicket(ticketId, input) { return tx(() => api.changeTicketInTransaction(ticketId, input)); },
    changeTicketInTransaction(ticketId, { operation, expectedInstructionRevision, target, acceptance, reason, requestKey, mandate, triggerId, model, validateMandate }) {
      if (!['revise', 'reopen'].includes(operation) || !Number.isSafeInteger(expectedInstructionRevision) || expectedInstructionRevision < 1
        || typeof requestKey !== 'string' || !requestKey || requestKey.length > 1024
        || typeof target !== 'string' || !target.trim() || target.length > 100000
        || typeof acceptance !== 'string' || acceptance.length > 100000
        || typeof reason !== 'string' || !reason.trim() || reason.length > 10000
        || !model?.providerId || !model?.modelId || typeof validateMandate !== 'function') throw fail('INVALID_TICKET_CHANGE', '工单变更缺少版本、原因、要求或明确模型');
      const fingerprint = createHash('sha256').update(JSON.stringify([ticketId, operation, expectedInstructionRevision, target, acceptance, reason, model])).digest('hex');
        const previous = db.prepare('SELECT * FROM sa_ticket_revision_requests WHERE request_key=?').get(requestKey);
        if (previous) {
          if (previous.fingerprint !== fingerprint) throw fail('IDEMPOTENCY_CONFLICT', '请求标识已用于其他工单变更');
          if (previous.ticket_id !== ticketId) throw fail('IDEMPOTENCY_CONFLICT', '请求标识属于其他工单');
          return api.getTicket(ticketId);
        }
        const ticket = api.getTicket(ticketId);
        if (!ticket) throw fail('TICKET_NOT_FOUND', '工单不存在');
        if (ticket.instructionRevision !== expectedInstructionRevision) throw Object.assign(fail('INSTRUCTION_REVISION_CONFLICT', '工单要求已变化，请刷新后重试'), { revision: ticket.instructionRevision });
        if (terminal.has(ticket.status) !== (operation === 'reopen')) throw fail('TICKET_STATE_CONFLICT', '已结束工单请重开，进行中的工单请修订');
        if (['pausing', 'cancelling'].includes(ticket.status) || api.assignments(ticketId).some(row => ['claimed', 'uncertain'].includes(row.state))) throw fail('EXECUTION_PENDING', '请先暂停或停止工单，确认执行结束后再变更');
        const trigger = api.getTrigger(triggerId);
        if (!trigger || trigger.actor.kind !== 'human' || trigger.actor.id !== mandate?.actorId
          || JSON.stringify(trigger.source) !== JSON.stringify(mandate.source) || trigger.content !== mandate.instruction
          || validateMandate(mandate) !== true) throw fail('MANDATE_REVOKED', '工单变更需要当前有效的主人原始授权');
        const at = new Date().toISOString(), revision = ticket.instructionRevision + 1;
        const snapshot = row => JSON.stringify({ target: row.target, acceptance: row.acceptance, mandate: row.mandate });
        db.prepare('INSERT OR IGNORE INTO sa_ticket_revisions VALUES (?,?,?,?,?)').run(ticketId, ticket.instructionRevision, 'original', snapshot(ticket), ticket.updatedAt);
        db.prepare('INSERT INTO sa_ticket_revisions VALUES (?,?,?,?,?)').run(ticketId, revision, operation,
          JSON.stringify({ target, acceptance, mandate, reason, triggerId }), at);
        db.prepare("UPDATE sa_assignments SET state='cancelled',owner=NULL,lease_until=NULL,updated_at=? WHERE ticket_id=? AND state NOT IN ('completed','failed','cancelled')").run(at, ticketId);
        db.prepare("UPDATE sa_runs SET state='cancelled',updated_at=? WHERE assignment_id IN (SELECT id FROM sa_assignments WHERE ticket_id=?) AND state='waiting'").run(at, ticketId);
        db.prepare("UPDATE sa_outbox SET state='cancelled',updated_at=? WHERE ticket_id=? AND state='queued' AND json_extract(payload,'$.type')='ticket.attention'").run(at, ticketId);
        db.prepare("UPDATE sa_tickets SET target=?,acceptance=?,instruction_revision=?,status='open',pause_reason=NULL,updated_at=? WHERE id=?").run(target, acceptance, revision, at, ticketId);
        db.prepare('INSERT OR IGNORE INTO sa_ticket_triggers VALUES (?,?)').run(ticketId, triggerId);
        const assignmentId = randomUUID();
        db.prepare("INSERT INTO sa_assignments(id,ticket_id,payload,state,priority,created_at,updated_at) VALUES (?,?,?,'queued',0,?,?)").run(assignmentId, ticketId,
          JSON.stringify({ executor: 'harness', model, text: target, acceptance, instructionRevision: revision }), at, at);
        db.prepare('INSERT INTO sa_ticket_revision_requests VALUES (?,?,?,?)').run(requestKey, fingerprint, ticketId, revision);
        return api.getTicket(ticketId);
    },
  };
}
