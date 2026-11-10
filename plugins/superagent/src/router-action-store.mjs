import { resultOutbox, systemStateDelivery } from './result-delivery.mjs';
import { createHash, randomUUID } from 'node:crypto';

const fail = (code, message) => Object.assign(new Error(message), { code });
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const json = value => JSON.stringify(value);
const parse = value => JSON.parse(value);
const required = (value, name) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) throw new Error(`Router action requires ${name}`);
  return value;
};

/** Atomic, non-replayable reservations for synchronous root-Router mutations. */
export function installRouterActionStore({ db, tx, api, insertTicket }) {
  db.exec(`CREATE TABLE IF NOT EXISTS sa_router_actions(
    action_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, ticket_id TEXT NOT NULL UNIQUE REFERENCES sa_tickets(id),
    assignment_id TEXT NOT NULL UNIQUE REFERENCES sa_assignments(id), run_id TEXT NOT NULL UNIQUE REFERENCES sa_runs(id),
    session_id TEXT NOT NULL, call_id TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(session_id,call_id));`);
  const rowFor = (sessionId, callId) => db.prepare('SELECT * FROM sa_router_actions WHERE session_id=? AND call_id=?').get(sessionId, callId);
  const actionValue = row => {
    if (!row) return null;
    const assignment = api.getAssignment(row.assignment_id), run = api.runs(row.assignment_id).find(item => item.id === row.run_id);
    const evidence = run?.evidence || {};
    const state = assignment?.state || 'missing', receipt = evidence.receipt ?? null, readback = evidence.readback ?? null;
    return { actionKey: row.action_key, sessionId: row.session_id, callId: row.call_id,
      ticket: api.getTicket(row.ticket_id), assignment, run,
      state, receipt, readback, error: evidence.error ?? null, createdAt: row.created_at,
      action: { actionKey: row.action_key, sessionId: row.session_id, callId: row.call_id,
        toolName: run?.routerAction?.toolName, argsHash: run?.routerAction?.argsHash,
        threadId: run?.routerAction?.threadId, state, receipt, readback, error: evidence.error ?? null } };
  };
  const validateOwner = (trigger, { sessionId, messageId, mandate, validateMandate }) => {
    if (!trigger || trigger.source.channel !== 'desktop' || trigger.source.sessionId !== sessionId
      || trigger.source.messageId !== messageId || trigger.actor.kind !== 'human' || trigger.actor.id !== 'desktop-owner'
      || mandate?.actorId !== 'desktop-owner' || mandate.source?.channel !== 'desktop'
      || mandate.source?.sessionId !== sessionId || mandate.source?.messageId !== messageId
      || mandate.instruction !== trigger.content || mandate.admission !== 'desktop-model-action'
      || mandate.controlledActions !== 'model-persistent-action' || typeof validateMandate !== 'function'
      || validateMandate(mandate) !== true) throw fail('MANDATE_REVOKED', 'Router action requires a current authenticated owner Mandate');
  };
  return {
    getRouterAction(sessionId, callId) { return actionValue(rowFor(required(sessionId, 'sessionId'), required(callId, 'callId'))); },
    reserveRouterAction(input = {}) {
      const { sessionId, messageId, callId, toolName, argsHash, triggerId, mandate, target, acceptance, owner, leaseMs = 120000, now = Date.now(), validateMandate } = input;
      for (const [value, name] of [[sessionId, 'sessionId'], [messageId, 'messageId'], [callId, 'callId'], [toolName, 'toolName'], [argsHash, 'argsHash'], [triggerId, 'triggerId'], [owner, 'owner']]) required(value, name);
      if (!/^[a-f0-9]{64}$/.test(argsHash) || !Number.isSafeInteger(now) || !Number.isSafeInteger(leaseMs) || leaseMs < 1000
        || typeof target !== 'string' || !target.trim() || typeof acceptance !== 'string' || !record(mandate)) throw fail('INVALID_ROUTER_ACTION', 'Invalid Router action reservation');
      const actionKey = JSON.stringify([sessionId, callId]);
      const fingerprint = digest({ sessionId, messageId, callId, toolName, argsHash, triggerId, mandate, target, acceptance });
      return tx(() => {
        const prior = rowFor(sessionId, callId);
        if (prior) {
          if (prior.fingerprint !== fingerprint) throw fail('IDEMPOTENCY_CONFLICT', 'Router action identity already has different inputs');
          return { ...actionValue(prior), duplicate: true };
        }
        const trigger = api.getTrigger(triggerId);
        validateOwner(trigger, { sessionId, messageId, mandate, validateMandate });
        if (mandate.action?.toolName !== toolName || mandate.action?.callId !== callId || mandate.action?.argsHash !== argsHash
          || mandate.action?.threadId !== mandate.source.threadId) throw fail('MANDATE_ACTION_MISMATCH', 'Router action Mandate does not bind the frozen tool input');
        const at = new Date(now).toISOString();
        const ticket = insertTicket({ id: `router-action:${digest(actionKey)}`, threadId: trigger.threadId,
          target, acceptance, mandate, status: 'running', sourceTriggerIds: [triggerId] });
        const assignmentId = `router-action:${digest(actionKey)}`;
        const payload = { executor: 'router-action', action: { sessionId, messageId, callId, toolName, argsHash, triggerId }, instructionRevision: ticket.instructionRevision };
        db.prepare("INSERT INTO sa_assignments(id,ticket_id,payload,state,priority,owner,lease_until,fence,attempts,created_at,updated_at) VALUES (?,?,?,'claimed',?,?,?,?,?,?,?)")
          .run(assignmentId, ticket.id, json(payload), Number.MAX_SAFE_INTEGER, owner, now + leaseMs, 1, 1, at, at);
        const runId = randomUUID(), directory = `router-action:${digest(actionKey)}`;
        db.prepare('INSERT INTO sa_runs VALUES (?,?,?,?,?,?,?,?)').run(runId, assignmentId, 1, owner, 'prepared', json({ sessionId, directory,
          routerAction: { sessionId, messageId, callId, toolName, argsHash, triggerId, threadId: mandate.source.threadId } }), at, at);
        db.prepare('INSERT INTO sa_router_actions VALUES (?,?,?,?,?,?,?,?)').run(actionKey, fingerprint, ticket.id, assignmentId, runId, sessionId, callId, at);
        const action = actionValue(rowFor(sessionId, callId));
        return { ...action, duplicate: false };
      });
    },
    settleRouterAction(input = {}) {
      const { sessionId, callId, owner, fence = 1, argsHash, receipt, readback, verified = false, summary = 'Router action completed', uncertain = false, error = null, now = Date.now(), validateMandate } = input;
      for (const [value, name] of [[sessionId, 'sessionId'], [callId, 'callId'], [owner, 'owner'], [argsHash, 'argsHash']]) required(value, name);
      if (!Number.isSafeInteger(now) || (receipt != null && !record(receipt)) || (readback != null && !record(readback))) throw fail('INVALID_ROUTER_ACTION_RECEIPT', 'Router action evidence must use canonical objects');
      return tx(() => {
        const actionRow = rowFor(sessionId, callId);
        if (!actionRow) throw fail('ROUTER_ACTION_NOT_FOUND', 'Router action reservation does not exist');
        const action = actionValue(actionRow), assignment = action.assignment, run = action.run;
        const binding = run?.routerAction;
        if (!binding || binding.sessionId !== sessionId || binding.callId !== callId || binding.argsHash !== argsHash) throw fail('IDEMPOTENCY_CONFLICT', 'Router action arguments do not match reservation');
        const priorReceipt = run?.evidence?.receipt;
        if (assignment.state === 'completed') {
          if (json(priorReceipt) !== json(receipt) || json(run.evidence.readback) !== json(readback)) throw fail('ROUTER_ACTION_RECEIPT_CONFLICT', 'Router action already settled with another receipt');
          return { ...action, duplicate: true };
        }
        if (assignment.state === 'uncertain' || uncertain || !verified || !receipt || !readback) {
          if (assignment.state !== 'uncertain') {
            if (assignment.state !== 'claimed' || assignment.owner !== owner || assignment.fence !== fence || assignment.leaseUntil <= now)
              throw fail('FENCING_CONFLICT', 'Only the live Router action owner can record an uncertain outcome');
            const payload = { ...parse(db.prepare('SELECT payload FROM sa_runs WHERE id=?').get(actionRow.run_id).payload), evidence: { receipt, readback, verified: false, error: String(error || 'Action outcome is uncertain') } };
            db.prepare("UPDATE sa_runs SET state='uncertain',payload=?,updated_at=? WHERE id=? AND state IN ('prepared','submitted','running','verifying')").run(json(payload), new Date(now).toISOString(), actionRow.run_id);
            db.prepare("UPDATE sa_assignments SET state='uncertain',owner=NULL,lease_until=NULL,updated_at=? WHERE id=? AND state='claimed' AND owner=? AND fence=?").run(new Date(now).toISOString(), actionRow.assignment_id, owner, fence);
          }
          db.prepare("UPDATE sa_tickets SET status='waiting',updated_at=? WHERE id=? AND status<>'completed'").run(new Date(now).toISOString(), actionRow.ticket_id);
          return { ...actionValue(actionRow), duplicate: false };
        }
        if (assignment.state !== 'claimed' || assignment.owner !== owner || assignment.fence !== fence || assignment.leaseUntil <= now)
          throw fail('FENCING_CONFLICT', 'Only the live Router action owner can settle verified evidence');
        const trigger = api.getTrigger(run.routerAction.triggerId);
        try { validateOwner(trigger, { sessionId, messageId: run.routerAction.messageId, mandate: action.ticket.mandate, validateMandate }); }
        catch (authorizationError) {
          const payload = { ...parse(db.prepare('SELECT payload FROM sa_runs WHERE id=?').get(actionRow.run_id).payload), evidence: { receipt, readback, verified: false, error: authorizationError.message } };
          db.prepare("UPDATE sa_runs SET state='uncertain',payload=?,updated_at=? WHERE id=?").run(json(payload), new Date(now).toISOString(), actionRow.run_id);
          db.prepare("UPDATE sa_assignments SET state='uncertain',owner=NULL,lease_until=NULL,updated_at=? WHERE id=?").run(new Date(now).toISOString(), actionRow.assignment_id);
          db.prepare("UPDATE sa_tickets SET status='waiting',updated_at=? WHERE id=? AND status<>'completed'").run(new Date(now).toISOString(), actionRow.ticket_id);
          return { ...actionValue(actionRow), duplicate: false };
        }
        const at = new Date(now).toISOString();
        const evidence = { kind: 'router-action', toolName: run.routerAction.toolName, callId, argsHash,
          receipt: JSON.parse(json(receipt)), readback: JSON.parse(json(readback)), verified: true };
        const runPayload = { ...parse(db.prepare('SELECT payload FROM sa_runs WHERE id=?').get(actionRow.run_id).payload), evidence };
        db.prepare("UPDATE sa_runs SET state='verifying',payload=?,updated_at=? WHERE id=? AND state IN ('prepared','submitted','running')").run(json(runPayload), at, actionRow.run_id);
        const ticket = action.ticket, version = ticket.resultVersion + 1;
        const delivery = systemStateDelivery({ state: 'action_verified', code: 'ACTION_VERIFIED', stage: 'action' });
        const result = { delivery, actionReceipt: evidence.receipt, readback: evidence.readback, action: { kind: evidence.kind, toolName: evidence.toolName, callId, argsHash, verified: true },
          summary, ticketId: ticket.id, instructionRevision: ticket.instructionRevision, version, committedAt: at, runId: actionRow.run_id, sessionId: run.sessionId };
        db.prepare('INSERT INTO sa_results VALUES (?,?,?,?)').run(ticket.id, version, json(result), at);
        db.prepare("UPDATE sa_tickets SET status='completed',result_version=?,updated_at=? WHERE id=? AND result_version=? AND status IN ('running','waiting')").run(version, at, ticket.id, ticket.resultVersion);
        db.prepare("UPDATE sa_assignments SET state='completed',owner=NULL,lease_until=NULL,updated_at=? WHERE id=? AND state='claimed' AND owner=? AND fence=?").run(at, actionRow.assignment_id, owner, fence);
        db.prepare("UPDATE sa_runs SET state='completed',updated_at=? WHERE id=? AND state='verifying'").run(at, actionRow.run_id);
        const uniqueKey = `router-action-result:${actionRow.action_key}`;
        const outboxId = randomUUID(), outboxPayload = resultOutbox({ ticket, result: { evidenceRefs: [{ runId: actionRow.run_id, callId, argsHash }] }, delivery });
        db.prepare("INSERT INTO sa_outbox(id,unique_key,ticket_id,payload,state,attempts,next_at,created_at,updated_at) VALUES (?,?,?,?,'queued',0,?,?,?)")
          .run(outboxId, uniqueKey, ticket.id, json(outboxPayload), now, at, at);
        return { ...actionValue(actionRow), result, outbox: api.deliveries(ticket.id).at(-1), duplicate: false };
      });
    },
  };
}
