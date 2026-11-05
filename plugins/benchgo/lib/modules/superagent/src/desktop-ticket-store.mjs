import { createHash, randomUUID } from 'node:crypto';

/** Direct, approved owner instructions skip model admission but retain a Decision. */
export function installDesktopTicketStore({ db, tx, api, insertTicket }) {
  db.exec('CREATE TABLE IF NOT EXISTS sa_desktop_requests(request_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, ticket_id TEXT NOT NULL REFERENCES sa_tickets(id))');
  return {
    desktopRequest(requestKey) {
      const row = db.prepare('SELECT * FROM sa_desktop_requests WHERE request_key=?').get(requestKey);
      return row && { fingerprint: row.fingerprint, ticket: api.getTicket(row.ticket_id) };
    },
    acceptDesktop({ triggerId, requestKey, fingerprint, target, title, acceptance = '', mandate, model, budgetGoalId }) {
      if (!requestKey || !fingerprint || !target?.trim() || !model?.providerId || !model?.modelId) throw new Error('桌面工单缺少请求、目标或明确模型');
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
          || mandate.admission !== 'desktop-approved-delegation') throw new Error('桌面工单缺少可信原始指令');
        const candidateId = randomUUID(), decisionId = randomUUID(), ticketId = randomUUID(), now = new Date().toISOString();
        db.prepare("INSERT INTO sa_candidates(id,trigger_id,thread_id,policy_version,gate,status,created_at,updated_at) VALUES (?,?,?,?,?,'decided',?,?)")
          .run(candidateId, triggerId, trigger.threadId, mandate.policyVersion, JSON.stringify({ strength: 'explicit', reason: 'approved-desktop-instruction' }), now, now);
        db.prepare('INSERT INTO sa_decisions VALUES (?,?,?,?,?,?,?,?)').run(decisionId, candidateId, trigger.threadId, 'accept', JSON.stringify({ reason: 'approved-desktop-instruction', target, acceptance }), mandate.policyVersion, ticketId, now);
        const ticket = insertTicket({ id: ticketId, threadId: trigger.threadId, target, title, acceptance, mandate, sourceTriggerIds: [triggerId] }, decisionId);
        if (budgetGoalId != null) api.bindTicketGoalInTransaction({ ticketId: ticket.id, goalId: budgetGoalId });
        const assignmentId = `desktop:${createHash('sha256').update(requestKey).digest('hex')}`;
        const payload = { executor: 'harness', model, text: target, acceptance, instructionRevision: ticket.instructionRevision };
        db.prepare("INSERT INTO sa_assignments(id,ticket_id,payload,state,priority,created_at,updated_at) VALUES (?,?,?,'queued',0,?,?)").run(assignmentId, ticket.id, JSON.stringify(payload), now, now);
        db.prepare('INSERT INTO sa_desktop_requests VALUES (?,?,?)').run(requestKey, fingerprint, ticket.id);
        return ticket;
      });
    },
  };
}
