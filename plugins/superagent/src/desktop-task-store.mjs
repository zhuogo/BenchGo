import { taskStopped } from './task-lifecycle.mjs';
import { createHash, randomUUID } from 'node:crypto';

/** Router decisions admit directly; the host preserves source and idempotency boundaries. */
export function installDesktopTaskStore({ db, tx, api, insertTask }) {
  db.exec('CREATE TABLE IF NOT EXISTS sa_desktop_requests(request_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES sa_tasks(id), trigger_id TEXT REFERENCES sa_triggers(id))');
  return {
    desktopRequest(requestKey) {
      const row = db.prepare('SELECT * FROM sa_desktop_requests WHERE request_key=?').get(requestKey);
      if (!row) return undefined;
      const task = api.getTask(row.task_id);
      return { fingerprint: row.fingerprint, task, source: row.trigger_id ? api.getTrigger(row.trigger_id)?.source : task?.mandate.source };
    },
    acceptDesktop({ triggerId, requestKey, fingerprint, target, title, acceptance = '', mandate, model, duplicateOfTaskId }) {
      if (!requestKey || !fingerprint || !target?.trim() || (model !== undefined && (!model?.providerId || !model?.modelId))) throw new Error('桌面任务缺少请求、目标或有效模型');
      return tx(() => {
        const prior = api.desktopRequest(requestKey);
        if (prior) {
          if (prior.fingerprint !== fingerprint) throw new Error('请求标识已用于不同任务');
          return prior.task;
        }
        const trigger = api.getTrigger(triggerId);
        const device = trigger?.source.channel === 'link' && trigger.source.deviceId
          && trigger.actor.id === `device:${trigger.source.deviceId}` && mandate.admission === 'link-device-delegation';
        if (!trigger || !(trigger.source.channel === 'desktop' || device) || trigger.actor.kind !== 'human' || !trigger.actor.id
          || mandate.actorId !== trigger.actor.id || JSON.stringify(mandate.source) !== JSON.stringify(trigger.source)
          || mandate.instruction !== trigger.content || !(mandate.admission === 'desktop-approved-delegation' || device)) throw new Error('任务缺少可信原始指令');
        const linked = db.prepare('SELECT task_id FROM sa_task_triggers WHERE trigger_id=?').all(triggerId);
        if (duplicateOfTaskId) {
          const existing = api.getTask(duplicateOfTaskId), source = existing?.mandate.source;
          if (!existing || (existing.status === 'completed' || taskStopped(existing))
            || source?.channel !== 'desktop' || source.sessionId !== trigger.source.sessionId || (source.threadId || 'main') !== (trigger.source.threadId || 'main')
            || existing.mandate.actorId !== mandate.actorId || existing.mandate.policyVersion !== mandate.policyVersion
            || JSON.stringify(existing.mandate.project) !== JSON.stringify(mandate.project)
            || existing.target !== target || existing.acceptance !== acceptance) {
            throw Object.assign(new Error('重复任务合并未通过来源、范围或当前授权复核；已结束任务请新建关联的调整任务'), { code: 'TASK_MERGE_REJECTED' });
          }
          db.prepare('INSERT OR IGNORE INTO sa_task_triggers VALUES (?,?)').run(existing.id, triggerId);
          db.prepare('INSERT INTO sa_desktop_requests(request_key,fingerprint,task_id,trigger_id) VALUES (?,?,?,?)').run(requestKey, fingerprint, existing.id, triggerId);
          const at = new Date().toISOString(), candidateId = randomUUID();
          db.prepare("INSERT INTO sa_candidates(id,trigger_id,thread_id,policy_version,gate,status,created_at,updated_at) VALUES (?,?,?,?,?,'decided',?,?)")
            .run(candidateId, triggerId, trigger.threadId, mandate.policyVersion, JSON.stringify({ strength: 'explicit', reason: 'router-duplicate-verified' }), at, at);
          db.prepare('INSERT INTO sa_decisions VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(), candidateId, trigger.threadId, 'attach', JSON.stringify({ reason: 'router-duplicate-verified', taskId: existing.id, contextOnly: true }), mandate.policyVersion, existing.id, at);
          return existing;
        }
        // Several explicit tasks may share one real input. Only identical task
        // contracts are aliases; do not invent source message IDs for sub-tasks.
        for (const row of linked) {
          const existing = api.getTask(row.task_id);
          const priorModel = api.assignments(existing.id).at(-1)?.model;
          if (existing.target !== target || existing.acceptance !== acceptance || JSON.stringify(existing.mandate.project) !== JSON.stringify(mandate.project)
            || JSON.stringify(priorModel) !== JSON.stringify(model)) continue;
          db.prepare('INSERT INTO sa_desktop_requests(request_key,fingerprint,task_id,trigger_id) VALUES (?,?,?,?)').run(requestKey, fingerprint, existing.id, triggerId);
          return existing;
        }
        const candidateId = randomUUID(), decisionId = randomUUID(), taskId = randomUUID(), now = new Date().toISOString();
        db.prepare("INSERT INTO sa_candidates(id,trigger_id,thread_id,policy_version,gate,status,created_at,updated_at) VALUES (?,?,?,?,?,'decided',?,?)")
          .run(candidateId, triggerId, trigger.threadId, mandate.policyVersion, JSON.stringify({ strength: 'explicit', reason: 'approved-desktop-instruction' }), now, now);
        db.prepare('INSERT INTO sa_decisions VALUES (?,?,?,?,?,?,?,?)').run(decisionId, candidateId, trigger.threadId, 'accept', JSON.stringify({ reason: 'approved-desktop-instruction', target, acceptance }), mandate.policyVersion, taskId, now);
        const task = insertTask({ id: taskId, threadId: trigger.threadId, target, title, acceptance, mandate, sourceTriggerIds: [triggerId], allowSharedDesktopSource: true }, decisionId);
        const assignmentId = `desktop:${createHash('sha256').update(requestKey).digest('hex')}`;
        const payload = { executor: 'harness', ...(model ? { model } : {}), text: target, acceptance, instructionRevision: task.instructionRevision };
        db.prepare("INSERT INTO sa_assignments(id,task_id,payload,state,priority,created_at,updated_at) VALUES (?,?,?,'queued',0,?,?)").run(assignmentId, task.id, JSON.stringify(payload), now, now);
        db.prepare('INSERT INTO sa_desktop_requests(request_key,fingerprint,task_id,trigger_id) VALUES (?,?,?,?)').run(requestKey, fingerprint, task.id, triggerId);
        return task;
      });
    },
  };
}
