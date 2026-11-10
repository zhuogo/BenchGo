import { ticketExecutionBlocked } from './ticket-lifecycle.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { installTicketInputStore } from './ticket-input-store.mjs';

const fail = (code, message) => Object.assign(new Error(message), { code });
const names = value => value.scope?.toolNames ?? value.toolScope;
const scope = value => JSON.stringify([value.project ?? null, value.scope ?? null, value.toolScope ?? null]);
export function ticketMandateDifference(previous, requested) {
  return scope(previous) === scope(requested) ? null : { previous: JSON.parse(scope(previous)), requested: JSON.parse(scope(requested)) };
}
export function isTicketMandateNarrowing(previous, requested) {
  const withoutNames = value => { const result = structuredClone(value.scope ?? null); if (result) delete result.toolNames; return JSON.stringify([value.project ?? null, result && Object.keys(result).length ? result : null]); };
  const oldNames = names(previous), nextNames = names(requested);
  return withoutNames(requested) === withoutNames(previous) && Array.isArray(nextNames)
    && nextNames.every(name => typeof name === 'string' && (!Array.isArray(oldNames) || oldNames.includes(name)));
}

/** Immutable authorization snapshots; the original Ticket Mandate is never overwritten. */
export function installTicketRevisions({ db, tx, api, insertTicket }) {
  db.exec(`CREATE TABLE IF NOT EXISTS sa_ticket_revisions(
    ticket_id TEXT NOT NULL REFERENCES sa_tickets(id), revision INTEGER NOT NULL,
    operation TEXT NOT NULL, snapshot TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY(ticket_id,revision));
    CREATE TABLE IF NOT EXISTS sa_ticket_revision_requests(
    request_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, ticket_id TEXT NOT NULL REFERENCES sa_tickets(id), revision INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sa_ticket_authorization_approvals(
    approval_id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES sa_tickets(id), fingerprint TEXT NOT NULL, payload TEXT NOT NULL);`);
  if (!db.prepare('PRAGMA table_info(sa_ticket_revision_requests)').all().some(row => row.name === 'request_payload')) db.exec('ALTER TABLE sa_ticket_revision_requests ADD COLUMN request_payload TEXT');
  const history = ticketId => db.prepare('SELECT * FROM sa_ticket_revisions WHERE ticket_id=? ORDER BY revision').all(ticketId)
    .map(row => ({ ...JSON.parse(row.snapshot), instructionRevision: row.revision, operation: row.operation, createdAt: row.created_at }));
  return {
    ...installTicketInputStore({ db, tx, api }),
    ticketRevisionRequest(requestKey) {
      const row = db.prepare('SELECT * FROM sa_ticket_revision_requests WHERE request_key=?').get(requestKey);
      return row && { ticket: api.getTicket(row.ticket_id), requestPayload: row.request_payload ? JSON.parse(row.request_payload) : null };
    },
    ticketRevisions: history,
    currentTicketMandate(ticketId, fallback) {
      const row = db.prepare('SELECT snapshot FROM sa_ticket_revisions WHERE ticket_id=? ORDER BY revision DESC LIMIT 1').get(ticketId);
      return row ? JSON.parse(row.snapshot).mandate : fallback;
    },
    changeTicket(ticketId, input) { return tx(() => api.changeTicketInTransaction(ticketId, input)); },
    changeTicketInTransaction(ticketId, { operation, expectedInstructionRevision, target, acceptance, reason, requestKey, mandate, triggerId, model, validateMandate, authorizeExpansion, requestPayload }) {
      if (!['revise', 'adjustment'].includes(operation) || !Number.isSafeInteger(expectedInstructionRevision) || expectedInstructionRevision < 1
        || typeof requestKey !== 'string' || !requestKey || requestKey.length > 1024
        || typeof target !== 'string' || !target.trim() || target.length > 100000
        || typeof acceptance !== 'string' || acceptance.length > 100000
        || typeof reason !== 'string' || !reason.trim() || reason.length > 10000
        || !model?.providerId || !model?.modelId || typeof validateMandate !== 'function') throw fail('INVALID_TICKET_CHANGE', '工单变更缺少版本、原因、要求或明确模型');
      const fingerprint = createHash('sha256').update(JSON.stringify([ticketId, operation, expectedInstructionRevision, target, acceptance, reason, model, triggerId, mandate])).digest('hex');
        const previous = db.prepare('SELECT * FROM sa_ticket_revision_requests WHERE request_key=?').get(requestKey);
        if (previous) {
          if (previous.fingerprint !== fingerprint) throw fail('IDEMPOTENCY_CONFLICT', '请求标识已用于其他工单变更');
          return api.getTicket(previous.ticket_id);
        }
        const ticket = api.getTicket(ticketId);
        if (!ticket) throw fail('TICKET_NOT_FOUND', '工单不存在');
        if (ticket.instructionRevision !== expectedInstructionRevision) throw Object.assign(fail('INSTRUCTION_REVISION_CONFLICT', '工单要求已变化，请刷新后重试'), { revision: ticket.instructionRevision });
        const adjustment = ticket.status === 'completed' || ticket.executionControl?.stopped === true;
        if (!adjustment && operation !== 'revise') throw fail('TICKET_STATE_CONFLICT', '进行中的工单请修订；关联调整只用于已结束工单');
        if (ticket.executionControl?.stopRequested === true) throw fail('TICKET_STOPPED', '工单正在停止，不能追加执行要求');
        const trigger = api.getTrigger(triggerId);
        if (!trigger || trigger.actor.kind !== 'human' || trigger.actor.id !== mandate?.actorId
          || JSON.stringify(trigger.source) !== JSON.stringify(mandate.source) || trigger.content !== mandate.instruction
          || validateMandate(mandate) !== true) throw fail('MANDATE_REVOKED', '工单变更需要当前有效的主人原始授权');
        const bound = db.prepare('SELECT ticket_id FROM sa_ticket_triggers WHERE trigger_id=? AND ticket_id<>? LIMIT 1').get(triggerId, ticketId);
        if (bound) throw fail('TRIGGER_ALREADY_ASSIGNED', '当前指令已归属另一工单，请挂靠或使用新的调整指令');
        if (!adjustment && JSON.stringify(mandate.project ?? null) !== JSON.stringify(ticket.mandate.project ?? null)
          && api.assignments(ticketId).some(row => api.runs(row.id).length)) throw fail('PROJECT_REQUIRES_ADJUSTMENT', '已有真实执行会话不能原地切换工作区；请停止原工单后创建关联调整');
        // A follow-up is not a new grant. Natural-language text never changes the
        // immutable source Mandate; structured authority changes require a host receipt.
        let appliedMandate = { ...(adjustment ? mandate : api.currentTicketMandate(ticket.id, ticket.mandate)) };
        if (ticketMandateDifference(ticket.mandate, mandate)) {
          if (isTicketMandateNarrowing(ticket.mandate, mandate)) appliedMandate = { ...appliedMandate, ...(mandate.scope ? { scope: mandate.scope } : {}), ...(mandate.toolScope ? { toolScope: mandate.toolScope } : {}) };
          else {
            const difference = ticketMandateDifference(ticket.mandate, mandate);
            const approval = typeof authorizeExpansion === 'function' && authorizeExpansion({ ticket, trigger, mandate, difference });
            if (!approval || approval.approved !== true || approval.triggerId !== trigger.id || approval.actorId !== trigger.actor.id
              || typeof approval.id !== 'string' || !approval.id) throw fail('MANDATE_EXPANSION_REQUIRED', '结构化授权范围发生变化，需要真实用户确认具体差异');
            const approvalFingerprint = createHash('sha256').update(JSON.stringify([ticketId, ticket.mandate.authorizationVersion ?? 1, trigger.id, trigger.source, trigger.actor, difference])).digest('hex');
            const prior = db.prepare('SELECT fingerprint FROM sa_ticket_authorization_approvals WHERE approval_id=?').get(approval.id);
            if (prior && prior.fingerprint !== approvalFingerprint) throw fail('AUTHORIZATION_APPROVAL_CONFLICT', '授权回执已经绑定另一份范围差异');
            db.prepare('INSERT OR IGNORE INTO sa_ticket_authorization_approvals VALUES (?,?,?,?)').run(approval.id, ticketId, approvalFingerprint,
              JSON.stringify({ triggerId: trigger.id, actorId: trigger.actor.id, source: trigger.source, difference }));
            appliedMandate = { ...mandate, authorizationVersion: (ticket.mandate.authorizationVersion ?? 1) + 1,
              authorizationApproval: { id: approval.id, triggerId: trigger.id, actorId: trigger.actor.id, difference } };
          }
        }
        if (adjustment) {
          if (db.prepare('SELECT 1 FROM sa_ticket_triggers WHERE ticket_id=? AND trigger_id=?').get(ticketId, triggerId)) throw fail('TRIGGER_ALREADY_ASSIGNED', '关联调整需要新的用户指令');
          const next = insertTicket({ threadId: trigger.threadId, target, acceptance,
            title: `调整：${ticket.title}`, adjustmentOfTicketId: ticketId,
            mandate: { ...appliedMandate, adjustment: { ticketId, resultVersion: ticket.resultVersion, instructionRevision: ticket.instructionRevision, reason } }, sourceTriggerIds: [triggerId] });
          const at = new Date().toISOString();
          db.prepare('INSERT INTO sa_ticket_revisions VALUES (?,?,?,?,?)').run(next.id, 1, 'adjustment', JSON.stringify({ target, acceptance, mandate: next.mandate, reason, triggerId, adjustmentOfTicketId: ticketId }), at);
          db.prepare("INSERT INTO sa_assignments(id,ticket_id,payload,state,priority,created_at,updated_at) VALUES (?,?,?,'queued',0,?,?)").run(randomUUID(), next.id,
            JSON.stringify({ executor: 'harness', model, text: target, acceptance, instructionRevision: 1, adjustmentOfTicketId: ticketId, sourceResultVersion: ticket.resultVersion }), at, at);
          db.prepare('INSERT INTO sa_ticket_revision_requests(request_key,fingerprint,ticket_id,revision,request_payload) VALUES (?,?,?,?,?)').run(requestKey, fingerprint, next.id, 1, requestPayload ? JSON.stringify(requestPayload) : null);
          return api.getTicket(next.id);
        }
        const at = new Date().toISOString(), revision = ticket.instructionRevision + 1;
        const snapshot = row => JSON.stringify({ target: row.target, acceptance: row.acceptance, mandate: row.mandate });
        db.prepare('INSERT OR IGNORE INTO sa_ticket_revisions VALUES (?,?,?,?,?)').run(ticketId, ticket.instructionRevision, 'original', snapshot(ticket), ticket.updatedAt);
        const priorSnapshot = JSON.parse(db.prepare('SELECT snapshot FROM sa_ticket_revisions WHERE ticket_id=? ORDER BY revision DESC LIMIT 1').get(ticketId).snapshot);
        const completeSnapshot = { target, acceptance, mandate: appliedMandate, reason, triggerId,
          authorizationVersion: appliedMandate.authorizationVersion ?? 1,
          context: [...(priorSnapshot.context || []), { triggerId, source: trigger.source, actor: trigger.actor, text: trigger.content }],
          toolScope: appliedMandate.scope?.toolNames ?? appliedMandate.toolScope ?? null };
        db.prepare('INSERT INTO sa_ticket_revisions VALUES (?,?,?,?,?)').run(ticketId, revision, operation,
          JSON.stringify(completeSnapshot), at);
        db.prepare('UPDATE sa_tickets SET target=?,acceptance=?,instruction_revision=?,updated_at=? WHERE id=?').run(target, acceptance, revision, at, ticketId);
        db.prepare('INSERT OR IGNORE INTO sa_ticket_triggers VALUES (?,?)').run(ticketId, triggerId);
        api.recordTicketInputInTransaction({ ticketId, triggerId, kind: 'revision', idempotencyKey: `trigger:${triggerId}`,
          instructionRevision: revision, authorizationVersion: appliedMandate.authorizationVersion ?? 1,
          snapshot: { ...completeSnapshot, instructionRevision: revision, operation, createdAt: at } });
        db.prepare('INSERT INTO sa_ticket_revision_requests(request_key,fingerprint,ticket_id,revision,request_payload) VALUES (?,?,?,?,?)').run(requestKey, fingerprint, ticketId, revision, requestPayload ? JSON.stringify(requestPayload) : null);
        if (ticket.continuationWait?.code === 'EXECUTION_FAILED' && !ticketExecutionBlocked(ticket)) {
          api.queueFailureContinuationInTransaction(ticketId, { expectedResultVersion: ticket.resultVersion,
            expectedInstructionRevision: revision, triggerId, validateMandate });
        }
        return api.getTicket(ticketId);
    },
  };
}
