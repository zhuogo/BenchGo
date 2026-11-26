import { createHash } from 'node:crypto';

const fail = (code, message) => Object.assign(new Error(message), { code });
const json = JSON.stringify;
const digest = value => createHash('sha256').update(json(value)).digest('hex');
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const required = (value, name) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) throw new Error(`Router action requires ${name}`);
  return value;
};

function migrateActionTasks(db, tx) {
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='sa_router_actions'").get()) return;
  tx(() => {
    if (!db.prepare('SELECT 1 FROM sa_router_actions LIMIT 1').get()) return;
    db.exec(`
      INSERT INTO sa_router_action_receipts(session_id,call_id,payload,state,created_at)
      SELECT ra.session_id,ra.call_id,json_object(
        'actionKey',ra.action_key,'triggerId',json_extract(r.payload,'$.routerAction.triggerId'),
        'mandate',json(t.mandate),'receipt',json_extract(r.payload,'$.evidence.receipt'),
        'readback',json_extract(r.payload,'$.evidence.readback'),'error',json_extract(r.payload,'$.evidence.error')),
        CASE a.state WHEN 'completed' THEN 'completed' WHEN 'failed' THEN 'failed' ELSE 'uncertain' END,ra.created_at
      FROM sa_router_actions ra JOIN sa_tasks t ON t.id=ra.task_id
        JOIN sa_assignments a ON a.id=ra.assignment_id JOIN sa_runs r ON r.id=ra.run_id
      WHERE true ON CONFLICT(session_id,call_id) DO NOTHING;

      DELETE FROM sa_delivery_receipts WHERE outbox_id IN (SELECT id FROM sa_outbox WHERE task_id IN (SELECT task_id FROM sa_router_actions));
      DELETE FROM sa_outbox_reconciliations WHERE outbox_id IN (SELECT id FROM sa_outbox WHERE task_id IN (SELECT task_id FROM sa_router_actions));
      DELETE FROM sa_outbox WHERE task_id IN (SELECT task_id FROM sa_router_actions);
      DELETE FROM sa_results WHERE task_id IN (SELECT task_id FROM sa_router_actions);
      DELETE FROM sa_task_archive WHERE task_id IN (SELECT task_id FROM sa_router_actions);
      DELETE FROM sa_task_inputs WHERE task_id IN (SELECT task_id FROM sa_router_actions);
      DELETE FROM sa_task_triggers WHERE task_id IN (SELECT task_id FROM sa_router_actions);

      CREATE TEMP TABLE router_action_task_ids AS SELECT task_id,assignment_id,run_id FROM sa_router_actions;
      DELETE FROM sa_router_actions;
      DELETE FROM sa_runs WHERE id IN (SELECT run_id FROM router_action_task_ids);
      DELETE FROM sa_assignments WHERE id IN (SELECT assignment_id FROM router_action_task_ids);
      DELETE FROM sa_tasks WHERE id IN (SELECT task_id FROM router_action_task_ids);
      DROP TABLE router_action_task_ids;
    `);
  });
}

/** Reserve one tool call before side effects and save its receipt independently of Worker tasks. */
export function installRouterActionStore({ db, tx, api }) {
  db.exec(`CREATE TABLE IF NOT EXISTS sa_router_action_receipts(
    session_id TEXT NOT NULL, call_id TEXT NOT NULL, payload TEXT NOT NULL,
    state TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(session_id,call_id));`);
  migrateActionTasks(db, tx);
  const rowFor = db.prepare('SELECT * FROM sa_router_action_receipts WHERE session_id=? AND call_id=?');
  const actionValue = (row, now = Date.now()) => {
    if (!row) return null;
    const data = JSON.parse(row.payload);
    const state = row.state === 'reserved' && data.leaseUntil <= now ? 'uncertain' : row.state;
    return { actionKey: data.actionKey, state, receipt: data.receipt ?? null, readback: data.readback ?? null,
      error: data.error ?? null, createdAt: row.created_at,
      action: { sessionId: row.session_id, callId: row.call_id, messageId: data.mandate.source.messageId, ...data.mandate.action } };
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
    getRouterAction(sessionId, callId) { return actionValue(rowFor.get(required(sessionId, 'sessionId'), required(callId, 'callId'))); },
    reserveRouterAction(input = {}) {
      const { sessionId, messageId, callId, toolName, argsHash, triggerId, mandate, owner, leaseMs = 120000, now = Date.now(), validateMandate } = input;
      for (const [value, name] of [[sessionId, 'sessionId'], [messageId, 'messageId'], [callId, 'callId'], [toolName, 'toolName'], [argsHash, 'argsHash'], [triggerId, 'triggerId'], [owner, 'owner']]) required(value, name);
      if (!/^[a-f0-9]{64}$/.test(argsHash) || !Number.isSafeInteger(now) || !Number.isSafeInteger(leaseMs) || leaseMs < 1000 || !record(mandate))
        throw fail('INVALID_ROUTER_ACTION', 'Invalid Router action reservation');
      const fingerprint = digest({ sessionId, messageId, callId, toolName, argsHash, triggerId, mandate });
      return tx(() => {
        const prior = rowFor.get(sessionId, callId);
        if (prior) {
          const value = actionValue(prior, now);
          const stored = JSON.parse(prior.payload);
          if (value.action.toolName !== toolName || value.action.argsHash !== argsHash || value.action.messageId !== messageId
            || value.action.threadId !== mandate.source?.threadId || (stored.fingerprint && stored.fingerprint !== fingerprint))
            throw fail('IDEMPOTENCY_CONFLICT', 'Router action identity already has different inputs');
          return { ...value, duplicate: true };
        }
        validateOwner(api.getTrigger(triggerId), { sessionId, messageId, mandate, validateMandate });
        if (mandate.action?.toolName !== toolName || mandate.action?.callId !== callId || mandate.action?.argsHash !== argsHash
          || mandate.action?.threadId !== mandate.source.threadId) throw fail('MANDATE_ACTION_MISMATCH', 'Router action Mandate does not bind the frozen tool input');
        const payload = { actionKey: json([sessionId, callId]), fingerprint, triggerId, mandate, owner, leaseUntil: now + leaseMs };
        db.prepare("INSERT INTO sa_router_action_receipts VALUES (?,?,?,'reserved',?)")
          .run(sessionId, callId, json(payload), new Date(now).toISOString());
        return { ...actionValue(rowFor.get(sessionId, callId), now), duplicate: false };
      });
    },
    settleRouterAction(input = {}) {
      const { sessionId, callId, owner, argsHash, receipt, readback, verified = false, notSubmitted = false, now = Date.now(), validateMandate } = input;
      for (const [value, name] of [[sessionId, 'sessionId'], [callId, 'callId'], [owner, 'owner'], [argsHash, 'argsHash']]) required(value, name);
      if (!Number.isSafeInteger(now) || (receipt != null && !record(receipt)) || (readback != null && !record(readback)))
        throw fail('INVALID_ROUTER_ACTION_RECEIPT', 'Router action evidence must use canonical objects');
      return tx(() => {
        const row = rowFor.get(sessionId, callId);
        if (!row) throw fail('ROUTER_ACTION_NOT_FOUND', 'Router action reservation does not exist');
        const value = actionValue(row, now), data = JSON.parse(row.payload);
        if (value.action.argsHash !== argsHash) throw fail('IDEMPOTENCY_CONFLICT', 'Router action arguments do not match reservation');
        if (value.state === 'completed' && (json(value.receipt) !== json(receipt) || json(value.readback) !== json(readback)))
          throw fail('ROUTER_ACTION_RECEIPT_CONFLICT', 'Router action already settled with another receipt');
        if (value.state !== 'reserved') return { ...value, duplicate: true };
        if (data.owner !== owner) throw fail('FENCING_CONFLICT', 'Only the live Router action owner can record the receipt');
        let state = notSubmitted ? 'failed' : 'uncertain';
        let error = null;
        if (!notSubmitted && verified && receipt && readback) {
          try {
            validateOwner(api.getTrigger(data.triggerId), { sessionId, messageId: value.action.messageId, mandate: data.mandate, validateMandate });
            state = 'completed';
          } catch (cause) { error = cause.message; }
        }
        db.prepare('UPDATE sa_router_action_receipts SET state=?,payload=? WHERE session_id=? AND call_id=?')
          .run(state, json({ ...data, receipt, readback, error }), sessionId, callId);
        return { ...actionValue(rowFor.get(sessionId, callId), now), duplicate: false };
      });
    },
  };
}
