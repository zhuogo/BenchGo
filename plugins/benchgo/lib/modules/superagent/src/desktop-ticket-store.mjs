import { ticketStopped } from './ticket-lifecycle.mjs';
import { createHash, randomUUID } from 'node:crypto';

/** Direct owner instructions skip candidate Eval; new model proposals have a scoped audit. */
export function installDesktopTicketStore({ db, tx, api, insertTicket }) {
  db.exec('CREATE TABLE IF NOT EXISTS sa_desktop_requests(request_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, ticket_id TEXT NOT NULL REFERENCES sa_tickets(id))');
  if (!db.prepare('PRAGMA table_info(sa_desktop_requests)').all().some(row => row.name === 'trigger_id')) db.exec('ALTER TABLE sa_desktop_requests ADD COLUMN trigger_id TEXT REFERENCES sa_triggers(id)');
  db.exec(`CREATE TABLE IF NOT EXISTS sa_desktop_scope_checks(
    request_key TEXT NOT NULL, binding_hash TEXT NOT NULL, request_hash TEXT NOT NULL,
    trigger_id TEXT NOT NULL REFERENCES sa_triggers(id), attempt INTEGER NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY(request_key,binding_hash,attempt))`);
  const scopeRequest = (requestKey, requestHash) => {
    const prior = db.prepare('SELECT request_hash FROM sa_desktop_scope_checks WHERE request_key=? LIMIT 1').get(requestKey);
    if (prior && prior.request_hash !== requestHash) throw Object.assign(new Error('请求标识已用于不同用户指令或拟派任务'), { code: 'IDEMPOTENCY_CONFLICT' });
  };
  return {
    desktopRequest(requestKey) {
      const row = db.prepare('SELECT * FROM sa_desktop_requests WHERE request_key=?').get(requestKey);
      if (!row) return undefined;
      const ticket = api.getTicket(row.ticket_id);
      return { fingerprint: row.fingerprint, ticket, source: row.trigger_id ? api.getTrigger(row.trigger_id)?.source : ticket?.mandate.source };
    },
    desktopTriggerTicket(triggerId) {
      const row = db.prepare('SELECT ticket_id FROM sa_ticket_triggers WHERE trigger_id=? LIMIT 1').get(triggerId);
      return row && api.getTicket(row.ticket_id);
    },
    desktopScopeCheck(requestKey, bindingHash, requestHash) {
      scopeRequest(requestKey, requestHash);
      const row = db.prepare('SELECT payload FROM sa_desktop_scope_checks WHERE request_key=? AND binding_hash=? ORDER BY attempt DESC LIMIT 1').get(requestKey, bindingHash);
      return row && JSON.parse(row.payload);
    },
    desktopScopeAttempts(requestKey, bindingHash) {
      return db.prepare('SELECT payload FROM sa_desktop_scope_checks WHERE request_key=? AND binding_hash=? ORDER BY attempt').all(requestKey, bindingHash).map(row => JSON.parse(row.payload));
    },
    recordDesktopScopeCheck(record) {
      return tx(() => {
        const { requestKey, bindingHash, requestHash, triggerId, binding, decision } = record;
        if (!requestKey || !bindingHash || !requestHash || !triggerId || !binding || !['delegate', 'direct', 'unconfirmed'].includes(decision?.outcome)) throw new Error('范围校验缺少绑定或判定');
        const trigger = api.getTrigger(triggerId);
        if (!trigger || trigger.actor.id !== 'desktop-owner' || trigger.actor.kind !== 'human'
          || trigger.source.channel !== 'desktop' || trigger.source.sessionId !== binding.sessionId
          || trigger.source.messageId !== binding.messageId || (trigger.source.threadId || 'main') !== binding.threadId) throw new Error('范围校验缺少可信当前来源');
        scopeRequest(requestKey, requestHash);
        const prior = api.desktopScopeCheck(requestKey, bindingHash, requestHash);
        if (prior && !prior.failureCode) return prior;
        const saved = { ...record, attempt: (prior?.attempt ?? 0) + 1, checkedAt: new Date().toISOString() };
        db.prepare('INSERT INTO sa_desktop_scope_checks VALUES (?,?,?,?,?,?,?)').run(requestKey, bindingHash, requestHash, triggerId, saved.attempt, JSON.stringify(saved), saved.checkedAt);
        return saved;
      });
    },
    acceptDesktop({ triggerId, requestKey, fingerprint, target, title, acceptance = '', mandate, model, budgetGoalId, duplicateOfTicketId }) {
      if (!requestKey || !fingerprint || !target?.trim() || (model !== undefined && (!model?.providerId || !model?.modelId))) throw new Error('桌面工单缺少请求、目标或有效模型');
      return tx(() => {
        const prior = api.desktopRequest(requestKey);
        if (prior) {
          if (prior.fingerprint !== fingerprint) throw new Error('请求标识已用于不同任务');
          if ((api.ticketGoalBudget(prior.ticket.id)?.goalId ?? null) !== (budgetGoalId ?? null)) throw new Error('工单预算绑定与原请求不一致');
          return prior.ticket;
        }
        const trigger = api.getTrigger(triggerId);
        if (!trigger || trigger.source.channel !== 'desktop' || trigger.actor.kind !== 'human' || trigger.actor.id !== 'desktop-owner'
          || mandate.actorId !== trigger.actor.id || JSON.stringify(mandate.source) !== JSON.stringify(trigger.source)
          || mandate.instruction !== trigger.content || mandate.admission !== 'desktop-approved-delegation') throw new Error('桌面工单缺少可信原始指令');
        const owned = db.prepare('SELECT ticket_id FROM sa_ticket_triggers WHERE trigger_id=? LIMIT 1').get(triggerId);
        if (duplicateOfTicketId && owned?.ticket_id !== duplicateOfTicketId) {
          const existing = api.getTicket(duplicateOfTicketId), source = existing?.mandate.source;
          if (owned || !existing || (existing.status === 'completed' || ticketStopped(existing))
            || source?.channel !== 'desktop' || source.sessionId !== trigger.source.sessionId || (source.threadId || 'main') !== (trigger.source.threadId || 'main')
            || existing.mandate.actorId !== mandate.actorId || existing.mandate.policyVersion !== mandate.policyVersion
            || JSON.stringify(existing.mandate.project) !== JSON.stringify(mandate.project)
            || existing.target !== target || existing.acceptance !== acceptance
            || (api.ticketGoalBudget(existing.id)?.goalId ?? null) !== (budgetGoalId ?? null)) {
            throw Object.assign(new Error('重复工单合并未通过来源、范围或当前授权复核；已结束任务请新建关联调整单'), { code: 'TICKET_MERGE_REJECTED' });
          }
          db.prepare('INSERT INTO sa_ticket_triggers VALUES (?,?)').run(existing.id, triggerId);
          db.prepare('INSERT INTO sa_desktop_requests(request_key,fingerprint,ticket_id,trigger_id) VALUES (?,?,?,?)').run(requestKey, fingerprint, existing.id, triggerId);
          const at = new Date().toISOString(), candidateId = randomUUID();
          db.prepare("INSERT INTO sa_candidates(id,trigger_id,thread_id,policy_version,gate,status,created_at,updated_at) VALUES (?,?,?,?,?,'decided',?,?)")
            .run(candidateId, triggerId, trigger.threadId, mandate.policyVersion, JSON.stringify({ strength: 'explicit', reason: 'router-duplicate-verified' }), at, at);
          db.prepare('INSERT INTO sa_decisions VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(), candidateId, trigger.threadId, 'attach', JSON.stringify({ reason: 'router-duplicate-verified', ticketId: existing.id, contextOnly: true }), mandate.policyVersion, existing.id, at);
          return existing;
        }
        if (owned) {
          const existing = api.getTicket(owned.ticket_id);
          const priorModel = api.assignments(existing.id).at(-1)?.model;
          if (existing.target !== target || existing.acceptance !== acceptance || JSON.stringify(existing.mandate.project) !== JSON.stringify(mandate.project)
            || JSON.stringify(priorModel) !== JSON.stringify(model)
            || (api.ticketGoalBudget(existing.id)?.goalId ?? null) !== (budgetGoalId ?? null)) {
            throw Object.assign(new Error('当前用户指令已创建工单，请先读取并挂靠已有工单'), { code: 'TRIGGER_ALREADY_ASSIGNED', ticketId: existing.id });
          }
          db.prepare('INSERT INTO sa_desktop_requests(request_key,fingerprint,ticket_id,trigger_id) VALUES (?,?,?,?)').run(requestKey, fingerprint, existing.id, triggerId);
          return existing;
        }
        const candidateId = randomUUID(), decisionId = randomUUID(), ticketId = randomUUID(), now = new Date().toISOString();
        db.prepare("INSERT INTO sa_candidates(id,trigger_id,thread_id,policy_version,gate,status,created_at,updated_at) VALUES (?,?,?,?,?,'decided',?,?)")
          .run(candidateId, triggerId, trigger.threadId, mandate.policyVersion, JSON.stringify({ strength: 'explicit', reason: 'approved-desktop-instruction' }), now, now);
        db.prepare('INSERT INTO sa_decisions VALUES (?,?,?,?,?,?,?,?)').run(decisionId, candidateId, trigger.threadId, 'accept', JSON.stringify({ reason: 'approved-desktop-instruction', target, acceptance }), mandate.policyVersion, ticketId, now);
        const ticket = insertTicket({ id: ticketId, threadId: trigger.threadId, target, title, acceptance, mandate, sourceTriggerIds: [triggerId] }, decisionId);
        if (budgetGoalId != null) api.bindTicketGoalInTransaction({ ticketId: ticket.id, goalId: budgetGoalId });
        const assignmentId = `desktop:${createHash('sha256').update(requestKey).digest('hex')}`;
        const payload = { executor: 'harness', ...(model ? { model } : {}), text: target, acceptance, instructionRevision: ticket.instructionRevision };
        db.prepare("INSERT INTO sa_assignments(id,ticket_id,payload,state,priority,created_at,updated_at) VALUES (?,?,?,'queued',0,?,?)").run(assignmentId, ticket.id, JSON.stringify(payload), now, now);
        db.prepare('INSERT INTO sa_desktop_requests(request_key,fingerprint,ticket_id,trigger_id) VALUES (?,?,?,?)').run(requestKey, fingerprint, ticket.id, triggerId);
        return ticket;
      });
    },
  };
}
