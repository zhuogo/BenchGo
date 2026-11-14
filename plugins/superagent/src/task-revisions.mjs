import { taskExecutionBlocked } from './task-lifecycle.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { installTaskInputStore } from './task-input-store.mjs';

const fail = (code, message) => Object.assign(new Error(message), { code });
const names = value => value.scope?.toolNames ?? value.toolScope;
const scope = value => JSON.stringify([value.project ?? null, value.scope ?? null, value.toolScope ?? null]);
export function taskMandateDifference(previous, requested) {
  return scope(previous) === scope(requested) ? null : { previous: JSON.parse(scope(previous)), requested: JSON.parse(scope(requested)) };
}
export function isTaskMandateNarrowing(previous, requested) {
  const withoutNames = value => { const result = structuredClone(value.scope ?? null); if (result) delete result.toolNames; return JSON.stringify([value.project ?? null, result && Object.keys(result).length ? result : null]); };
  const oldNames = names(previous), nextNames = names(requested);
  return withoutNames(requested) === withoutNames(previous) && Array.isArray(nextNames)
    && nextNames.every(name => typeof name === 'string' && (!Array.isArray(oldNames) || oldNames.includes(name)));
}

/** Immutable authorization snapshots; the original Task Mandate is never overwritten. */
export function installTaskRevisions({ db, tx, api, insertTask }) {
  db.exec(`CREATE TABLE IF NOT EXISTS sa_task_revisions(
    task_id TEXT NOT NULL REFERENCES sa_tasks(id), revision INTEGER NOT NULL,
    operation TEXT NOT NULL, snapshot TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY(task_id,revision));
    CREATE TABLE IF NOT EXISTS sa_task_revision_requests(
    request_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES sa_tasks(id), revision INTEGER NOT NULL, request_payload TEXT);
    CREATE TABLE IF NOT EXISTS sa_task_authorization_approvals(
    approval_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES sa_tasks(id), fingerprint TEXT NOT NULL, payload TEXT NOT NULL);`);
  const history = taskId => db.prepare('SELECT * FROM sa_task_revisions WHERE task_id=? ORDER BY revision').all(taskId)
    .map(row => ({ ...JSON.parse(row.snapshot), instructionRevision: row.revision, operation: row.operation, createdAt: row.created_at }));
  return {
    ...installTaskInputStore({ db, tx, api }),
    taskRevisionRequest(requestKey) {
      const row = db.prepare('SELECT * FROM sa_task_revision_requests WHERE request_key=?').get(requestKey);
      return row && { task: api.getTask(row.task_id), requestPayload: row.request_payload ? JSON.parse(row.request_payload) : null };
    },
    taskRevisions: history,
    currentTaskMandate(taskId, fallback) {
      const row = db.prepare('SELECT snapshot FROM sa_task_revisions WHERE task_id=? ORDER BY revision DESC LIMIT 1').get(taskId);
      return row ? JSON.parse(row.snapshot).mandate : fallback;
    },
    changeTask(taskId, input) { return tx(() => api.changeTaskInTransaction(taskId, input)); },
    changeTaskInTransaction(taskId, { operation, expectedInstructionRevision, target, acceptance, reason, requestKey, mandate, triggerId, model, validateMandate, authorizeExpansion, requestPayload }) {
      if (!['revise', 'adjustment'].includes(operation) || !Number.isSafeInteger(expectedInstructionRevision) || expectedInstructionRevision < 1
        || typeof requestKey !== 'string' || !requestKey || requestKey.length > 1024
        || typeof target !== 'string' || !target.trim() || target.length > 100000
        || typeof acceptance !== 'string' || acceptance.length > 100000
        || typeof reason !== 'string' || !reason.trim() || reason.length > 10000
        || !model?.providerId || !model?.modelId || typeof validateMandate !== 'function') throw fail('INVALID_TASK_CHANGE', '任务变更缺少版本、原因、要求或明确模型');
      const fingerprint = createHash('sha256').update(JSON.stringify([taskId, operation, expectedInstructionRevision, target, acceptance, reason, model, triggerId, mandate])).digest('hex');
        const previous = db.prepare('SELECT * FROM sa_task_revision_requests WHERE request_key=?').get(requestKey);
        if (previous) {
          if (previous.fingerprint !== fingerprint) throw fail('IDEMPOTENCY_CONFLICT', '请求标识已用于其他任务变更');
          return api.getTask(previous.task_id);
        }
        const task = api.getTask(taskId);
        if (!task) throw fail('TASK_NOT_FOUND', '任务不存在');
        if (task.instructionRevision !== expectedInstructionRevision) throw Object.assign(fail('INSTRUCTION_REVISION_CONFLICT', '任务要求已变化，请刷新后重试'), { revision: task.instructionRevision });
        const adjustment = task.status === 'completed' || task.executionControl?.stopped === true;
        if (!adjustment && operation !== 'revise') throw fail('TASK_STATE_CONFLICT', '进行中的任务请修订；关联调整只用于已结束任务');
        if (task.executionControl?.stopRequested === true) throw fail('TASK_STOPPED', '任务正在停止，不能追加执行要求');
        const trigger = api.getTrigger(triggerId);
        if (!trigger || trigger.actor.kind !== 'human' || trigger.actor.id !== mandate?.actorId
          || JSON.stringify(trigger.source) !== JSON.stringify(mandate.source) || trigger.content !== mandate.instruction
          || validateMandate(mandate) !== true) throw fail('MANDATE_REVOKED', '任务变更需要当前有效的主人原始授权');
        const bound = db.prepare('SELECT task_id FROM sa_task_triggers WHERE trigger_id=? AND task_id<>? LIMIT 1').get(triggerId, taskId);
        const repeatedAdjustment = adjustment && db.prepare('SELECT 1 FROM sa_task_triggers tt JOIN sa_tasks t ON t.id=tt.task_id WHERE tt.trigger_id=? AND t.adjustment_of_task_id=? LIMIT 1').get(triggerId, taskId);
        if (bound && trigger.source.channel !== 'desktop' || repeatedAdjustment) throw fail('TRIGGER_ALREADY_ASSIGNED', '当前指令已归属另一任务，请挂靠或使用新的调整指令');
        if (!adjustment && JSON.stringify(mandate.project ?? null) !== JSON.stringify(task.mandate.project ?? null)
          && api.assignments(taskId).some(row => api.runs(row.id).length)) throw fail('PROJECT_REQUIRES_ADJUSTMENT', '已有真实执行会话不能原地切换工作区；请停止原任务后创建关联调整');
        // A follow-up is not a new grant. Natural-language text never changes the
        // immutable source Mandate; structured authority changes require a host receipt.
        const currentMandate = api.currentTaskMandate(task.id, task.mandate);
        let appliedMandate = { ...(adjustment ? mandate : currentMandate) };
        if (taskMandateDifference(currentMandate, mandate)) {
          if (isTaskMandateNarrowing(currentMandate, mandate)) appliedMandate = { ...appliedMandate, ...(mandate.scope ? { scope: mandate.scope } : {}), ...(mandate.toolScope ? { toolScope: mandate.toolScope } : {}) };
          else {
            const difference = taskMandateDifference(currentMandate, mandate);
            const approval = typeof authorizeExpansion === 'function' && authorizeExpansion({ task, trigger, mandate, difference });
            if (!approval || approval.approved !== true || approval.triggerId !== trigger.id || approval.actorId !== trigger.actor.id
              || typeof approval.id !== 'string' || !approval.id) throw fail('MANDATE_EXPANSION_REQUIRED', '结构化授权范围发生变化，需要真实用户确认具体差异');
            const approvalFingerprint = createHash('sha256').update(JSON.stringify([taskId, currentMandate.authorizationVersion ?? 1, trigger.id, trigger.source, trigger.actor, difference])).digest('hex');
            const prior = db.prepare('SELECT fingerprint FROM sa_task_authorization_approvals WHERE approval_id=?').get(approval.id);
            if (prior && prior.fingerprint !== approvalFingerprint) throw fail('AUTHORIZATION_APPROVAL_CONFLICT', '授权回执已经绑定另一份范围差异');
            db.prepare('INSERT OR IGNORE INTO sa_task_authorization_approvals VALUES (?,?,?,?)').run(approval.id, taskId, approvalFingerprint,
              JSON.stringify({ triggerId: trigger.id, actorId: trigger.actor.id, source: trigger.source, difference }));
            appliedMandate = { ...mandate, authorizationVersion: (currentMandate.authorizationVersion ?? 1) + 1,
              authorizationApproval: { id: approval.id, triggerId: trigger.id, actorId: trigger.actor.id, difference } };
          }
        }
        if (adjustment) {
          if (db.prepare('SELECT 1 FROM sa_task_triggers WHERE task_id=? AND trigger_id=?').get(taskId, triggerId)) throw fail('TRIGGER_ALREADY_ASSIGNED', '关联调整需要新的用户指令');
          const next = insertTask({ threadId: trigger.threadId, target, acceptance,
            title: `调整：${task.title}`, adjustmentOfTaskId: taskId,
            mandate: { ...appliedMandate, adjustment: { taskId, resultVersion: task.resultVersion, instructionRevision: task.instructionRevision, reason } }, sourceTriggerIds: [triggerId], allowSharedDesktopSource: trigger.source.channel === 'desktop' });
          const at = new Date().toISOString();
          db.prepare('INSERT INTO sa_task_revisions VALUES (?,?,?,?,?)').run(next.id, 1, 'adjustment', JSON.stringify({ target, acceptance, mandate: next.mandate, reason, triggerId, adjustmentOfTaskId: taskId }), at);
          db.prepare("INSERT INTO sa_assignments(id,task_id,payload,state,priority,created_at,updated_at) VALUES (?,?,?,'queued',0,?,?)").run(randomUUID(), next.id,
            JSON.stringify({ executor: 'harness', model, text: target, acceptance, instructionRevision: 1, adjustmentOfTaskId: taskId, sourceResultVersion: task.resultVersion }), at, at);
          db.prepare('INSERT INTO sa_task_revision_requests(request_key,fingerprint,task_id,revision,request_payload) VALUES (?,?,?,?,?)').run(requestKey, fingerprint, next.id, 1, requestPayload ? JSON.stringify(requestPayload) : null);
          return api.getTask(next.id);
        }
        const at = new Date().toISOString(), revision = task.instructionRevision + 1;
        const snapshot = row => JSON.stringify({ target: row.target, acceptance: row.acceptance, mandate: row.mandate });
        db.prepare('INSERT OR IGNORE INTO sa_task_revisions VALUES (?,?,?,?,?)').run(taskId, task.instructionRevision, 'original', snapshot(task), task.updatedAt);
        const priorSnapshot = JSON.parse(db.prepare('SELECT snapshot FROM sa_task_revisions WHERE task_id=? ORDER BY revision DESC LIMIT 1').get(taskId).snapshot);
        const completeSnapshot = { target, acceptance, mandate: appliedMandate, reason, triggerId,
          authorizationVersion: appliedMandate.authorizationVersion ?? 1,
          context: [...(priorSnapshot.context || []), { triggerId, source: trigger.source, actor: trigger.actor, text: trigger.content }],
          toolScope: appliedMandate.scope?.toolNames ?? appliedMandate.toolScope ?? null };
        db.prepare('INSERT INTO sa_task_revisions VALUES (?,?,?,?,?)').run(taskId, revision, operation,
          JSON.stringify(completeSnapshot), at);
        db.prepare('UPDATE sa_tasks SET target=?,acceptance=?,instruction_revision=?,updated_at=? WHERE id=?').run(target, acceptance, revision, at, taskId);
        db.prepare('INSERT OR IGNORE INTO sa_task_triggers VALUES (?,?)').run(taskId, triggerId);
        api.recordTaskInputInTransaction({ taskId, triggerId, kind: 'revision', idempotencyKey: `trigger:${triggerId}:task:${taskId}`,
          instructionRevision: revision, authorizationVersion: appliedMandate.authorizationVersion ?? 1,
          snapshot: { ...completeSnapshot, instructionRevision: revision, operation, createdAt: at } });
        db.prepare('INSERT INTO sa_task_revision_requests(request_key,fingerprint,task_id,revision,request_payload) VALUES (?,?,?,?,?)').run(requestKey, fingerprint, taskId, revision, requestPayload ? JSON.stringify(requestPayload) : null);
        if (task.continuationWait?.code === 'EXECUTION_FAILED' && !taskExecutionBlocked(task)) {
          api.queueFailureContinuationInTransaction(taskId, { expectedResultVersion: task.resultVersion,
            expectedInstructionRevision: revision, triggerId, validateMandate });
        }
        return api.getTask(taskId);
    },
  };
}
