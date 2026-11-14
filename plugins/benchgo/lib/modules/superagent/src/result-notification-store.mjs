import { taskPaused, taskStopped } from './task-lifecycle.mjs';

export function resultReplyDelivered(result, source) {
  const reply = result?.reply;
  return Boolean(reply?.sessionId && reply.requestId && reply.messageIds?.length
    && JSON.stringify(reply.source) === JSON.stringify(source)
    && (source.channel === 'desktop' || reply.receipt?.status === 'accepted' && typeof reply.receipt.messageId === 'string' && reply.receipt.messageId.trim()));
}

/** Result identity is durable; inbox acceptance and public delivery are separate facts. */
export function installResultNotificationStore({ db, tx, api }) {
  db.exec("CREATE INDEX IF NOT EXISTS sa_results_pending_notification ON sa_results(COALESCE(json_extract(payload,'$.notification.nextAt'),0),created_at,task_id) WHERE json_extract(payload,'$.notification.state')='pending'");
  db.exec("CREATE INDEX IF NOT EXISTS sa_outbox_result_notice_migration ON sa_outbox(state,lease_until) WHERE json_extract(payload,'$.type')='task.result'");
  const parse = JSON.parse;
  const save = result => db.prepare('UPDATE sa_results SET payload=? WHERE task_id=? AND version=?').run(JSON.stringify(result), result.taskId, result.version);
  const notice = (task, result) => ({ uniqueKey: result.deliveryKey, taskId: task.id, payload: {
    type: 'task.result', taskId: task.id, source: task.mandate.source,
    instructionRevision: result.instructionRevision, resultVersion: result.version, outcome: result.outcome } });
  const current = (task, result) => task && result && task.instructionRevision === result.instructionRevision
    && task.resultVersion === result.version && !taskStopped(task) && !taskPaused(task);
  // Only known-unsent legacy rows can become inbox notifications. Uncertain and
  // already-sent transport history remains readable and is never replayed.
  function migrate(now = Date.now()) { return tx(() => {
    for (const row of db.prepare("SELECT * FROM sa_outbox WHERE json_extract(payload,'$.type')='task.result' AND (state='queued' OR state='claimed' AND lease_until<=? AND json_extract(payload,'$.replyState')='pending') AND json_extract(payload,'$.stateSignal') IS NULL AND COALESCE(json_extract(payload,'$.publication.origin'),'')<>'system' AND COALESCE(json_extract(payload,'$.replyState'),'')<>'suppressed'").all(now)) {
      const payload = parse(row.payload);
      const entry = db.prepare('SELECT payload FROM sa_results WHERE task_id=? AND version=?').get(row.task_id, payload.resultVersion);
      if (!entry) continue;
      const result = parse(entry.payload), task = api.getTask(row.task_id);
      if (!current(task, result) || JSON.stringify(payload.source) !== JSON.stringify(task.mandate.source)) continue;
      if (!result.notification) { result.deliveryKey ||= row.unique_key; result.notification = { state: 'pending', nextAt: 0 }; save(result); }
      db.prepare("UPDATE sa_outbox SET state='cancelled',owner=NULL,lease_until=NULL,last_error='migrated-to-router-inbox' WHERE id=?").run(row.id);
    }
  }); }
  migrate();
  return {
    migrateResultNotifications: migrate,
    resultNotification(taskId, eventKey) {
      const task = api.getTask(taskId);
      const entry = db.prepare("SELECT payload FROM sa_results WHERE task_id=? AND json_extract(payload,'$.deliveryKey')=? ORDER BY version DESC LIMIT 1").get(taskId, eventKey);
      const result = entry && parse(entry.payload);
      return current(task, result) && result.notification && result.notification.state !== 'suppressed' ? notice(task, result) : null;
    },
    pendingResultNotifications({ now = Date.now(), limit = 20 } = {}) {
      const rows = db.prepare("SELECT r.payload FROM sa_results r JOIN sa_tasks t ON t.id=r.task_id AND t.result_version=r.version AND t.instruction_revision=json_extract(r.payload,'$.instructionRevision') WHERE json_extract(r.payload,'$.notification.state')='pending' AND COALESCE(json_extract(r.payload,'$.notification.nextAt'),0)<=? AND COALESCE(json_extract(t.execution_control,'$.paused'),0)<>1 AND COALESCE(json_extract(t.execution_control,'$.pauseRequested'),0)<>1 AND COALESCE(json_extract(t.execution_control,'$.stopped'),0)<>1 AND COALESCE(json_extract(t.execution_control,'$.stopRequested'),0)<>1 ORDER BY r.created_at,r.task_id LIMIT ?")
        .all(now, Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20);
      return rows.map(row => { const result = parse(row.payload), task = api.getTask(result.taskId); return current(task, result) ? notice(task, result) : null; }).filter(Boolean);
    },
    finishResultNotification(taskId, eventKey, { status, messageId, reason, error, now = Date.now() } = {}) {
      return tx(() => {
        const entry = db.prepare("SELECT payload FROM sa_results WHERE task_id=? AND json_extract(payload,'$.deliveryKey')=? ORDER BY version DESC LIMIT 1").get(taskId, eventKey);
        if (!entry) return null;
        const result = parse(entry.payload);
        if (!result.notification || result.notification.state !== 'pending') return result;
        result.notification = status === 'accepted' ? { state: 'notified', messageId, at: new Date(now).toISOString() }
          : status === 'suppressed' ? { state: 'suppressed', reason, at: new Date(now).toISOString() }
          : { state: 'pending', nextAt: now + 30000, error: String(error || 'ROUTER_INBOX_UNAVAILABLE').slice(0, 100) };
        save(result); return result;
      });
    },
    confirmResultReply({ signal, sessionId, requestId, messages, receipt, now = Date.now() }, { inTransaction = false } = {}) {
      const confirm = () => {
        const expected = api.resultNotification(signal.taskId, signal.eventKey);
        if (!expected || JSON.stringify(expected.payload.source) !== JSON.stringify(signal.source)
          || expected.payload.instructionRevision !== signal.instructionRevision || expected.payload.resultVersion !== signal.resultVersion) return null;
        if (!sessionId || !requestId || !messages?.some(row => typeof row.id === 'string' && typeof row.text === 'string' && row.text.trim())) return null;
        const row = db.prepare('SELECT payload FROM sa_results WHERE task_id=? AND version=?').get(signal.taskId, signal.resultVersion), result = parse(row.payload);
        const fact = { sessionId, requestId, source: signal.source, messageIds: messages.map(row => row.id), at: new Date(now).toISOString(), ...(receipt ? { receipt } : {}) };
        if (result.reply?.requestId === requestId && JSON.stringify(result.reply.messageIds) !== JSON.stringify(fact.messageIds)) throw new Error('Router reply identity changed');
        result.reply = result.reply || fact;
        if (receipt) result.reply.receipt = receipt;
        save(result);
        if (signal.source.channel === 'desktop' || receipt?.status === 'accepted') api.recordClosedTask(signal.taskId, { closedAt: fact.at, inTransaction: true });
        return result;
      };
      return inTransaction ? confirm() : tx(confirm);
    },
  };
}
