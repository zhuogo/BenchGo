import { createHash, randomUUID } from 'node:crypto';
import { validateDelivery } from './result-delivery.mjs';
import { validateAttentionDecisions } from './attention-triage.mjs';

const attentionChannels = new Set(['desktop', 'feishu', 'wecom', 'qq', 'weixin', 'telegram', 'discord', 'whatsapp', 'email', 'webhook', 'api']);
const attentionText = (source, attentionId, text) => source.channel === 'desktop' ? text
  : `${text}\n\n问题编号：${attentionId}\n可引用这条消息回答，或发送 /answer ${attentionId} 你的回答`;

export function attentionReplyText(attentionId, content) {
  const command = /^\/answer ([0-9a-f-]{36})\s+(\S[\s\S]*)$/iu.exec(content.trim());
  return command?.[1].toLowerCase() === attentionId ? command[2] : content;
}

/** Shares the orchestration transaction and outbox; no independent delivery queue. */
export function installAttentionStore({ db, tx, api, ownedAssignment }) {
  db.exec(`CREATE TABLE IF NOT EXISTS sa_attentions(
    id TEXT PRIMARY KEY, assignment_id TEXT NOT NULL REFERENCES sa_assignments(id),
    ticket_id TEXT NOT NULL REFERENCES sa_tickets(id), session_id TEXT NOT NULL,
    question_key TEXT NOT NULL UNIQUE, question TEXT NOT NULL, outbox_id TEXT NOT NULL REFERENCES sa_outbox(id),
    answer_trigger_id TEXT REFERENCES sa_triggers(id), created_at TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS sa_attention_answer ON sa_attentions(answer_trigger_id) WHERE answer_trigger_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS sa_receipt_message ON sa_delivery_receipts(json_extract(payload,'$.messageId'));`);
  db.exec(`CREATE TABLE IF NOT EXISTS sa_attention_resolutions(
    question_key TEXT PRIMARY KEY, assignment_id TEXT NOT NULL REFERENCES sa_assignments(id),
    ticket_id TEXT NOT NULL REFERENCES sa_tickets(id), session_id TEXT NOT NULL, call_id TEXT NOT NULL,
    instruction_revision INTEGER NOT NULL, question TEXT NOT NULL, resolution TEXT NOT NULL, created_at TEXT NOT NULL);`);
  const resolutionValue = row => ({ assignmentId: row.assignment_id, ticketId: row.ticket_id, sessionId: row.session_id,
    callId: row.call_id, instructionRevision: row.instruction_revision, question: JSON.parse(row.question),
    ...JSON.parse(row.resolution), createdAt: row.created_at });
  // Extra key components are host-owned metadata; an official question's arbitrary
  // JSON fields never decide whether it is a Router review or an executing tool.
  const reviewKey = row => {
    const key = JSON.parse(row.question_key);
    return key[3] === 'review' ? { instructionRevision: key[4], resultVersion: key[5], runId: key[6], kind: key[7] } : null;
  };
  const value = row => {
    if (!row) return row;
    const review = reviewKey(row);
    return { id: row.id, assignmentId: row.assignment_id, ticketId: row.ticket_id,
      sessionId: row.session_id, callId: JSON.parse(row.question_key)[1], question: JSON.parse(row.question), outboxId: row.outbox_id,
      answerTriggerId: row.answer_trigger_id, state: row.answer_trigger_id ? 'answered' : 'waiting', createdAt: row.created_at,
      origin: review ? 'review' : 'worker', ...(review || {}) };
  };
  const currentRevision = (row, ticket) => {
    if (!ticket || (api.getAssignment(row.assignment_id)?.instructionRevision ?? 1) !== ticket.instructionRevision) return false;
    const review = reviewKey(row);
    if (!review) return true;
    const result = api.results(ticket.id).at(-1);
    return review.instructionRevision === ticket.instructionRevision && review.resultVersion === ticket.resultVersion
      && result?.version === review.resultVersion && result.runId === review.runId && result.sessionId === row.session_id;
  };
  const queueAnsweredReviewContinuation = (ticketId, { sourceResultVersion, validateMandate, ownerRetry = false,
    additionalExecutionMs = 0, now = Date.now() } = {}) => {
    if (typeof validateMandate !== 'function') throw new Error('Attention requires current authorization');
    if (!Number.isSafeInteger(additionalExecutionMs) || additionalExecutionMs < 0
      || (additionalExecutionMs > 0 && ownerRetry !== true)) throw new Error('Additional execution budget requires an explicit owner retry');
    const ticket = api.getTicket(ticketId);
    if (!ticket) throw new Error('Attention ticket not found');
    if (!Number.isSafeInteger(sourceResultVersion) || sourceResultVersion < 1 || sourceResultVersion !== ticket.resultVersion) {
      throw Object.assign(new Error('Continuation result version changed'), { code: 'REVIEW_CONFLICT' });
    }
    const rows = db.prepare('SELECT * FROM sa_attentions WHERE ticket_id=? AND answer_trigger_id IS NOT NULL').all(ticket.id);
    const answered = rows.find(row => reviewKey(row) && currentRevision(row, ticket));
    if (!answered) return { queued: false, code: 'USER_ANSWER_REQUIRED', ticket };
    const entry = value(answered), trigger = api.getTrigger(entry.answerTriggerId);
    if (!trigger || !db.prepare('SELECT 1 FROM sa_ticket_triggers WHERE ticket_id=? AND trigger_id=?').get(ticket.id, trigger.id)) {
      return { queued: false, code: 'USER_ANSWER_REQUIRED', ticket };
    }
    const answer = trigger.source?.channel === 'desktop' && trigger.source.answer
      ? trigger.source.answer : { selected: [], custom: attentionReplyText(entry.id, trigger.content) };
    return api.queueReviewContinuation(ticket.id, { assignmentId: entry.assignmentId, runId: entry.runId,
      sourceResultVersion, instruction: entry.question.question, reason: api.results(ticket.id).at(-1)?.review?.reason,
      reviewAnswer: { attentionId: entry.id, question: entry.question, kind: entry.kind,
        triggerId: entry.answerTriggerId, source: trigger.source, actor: trigger.actor, text: trigger.content, answer },
      validateMandate, ownerRetry: ownerRetry === true, additionalExecutionMs, now, inTransaction: true });
  };
  return {
    attentionResolutions(ticketId, { sessionId, callId } = {}) {
      return db.prepare('SELECT * FROM sa_attention_resolutions WHERE ticket_id=? ORDER BY created_at,rowid').all(ticketId)
        .filter(row => (sessionId === undefined || row.session_id === sessionId) && (callId === undefined || row.call_id === callId)).map(resolutionValue);
    },
    saveAttentionResolutions(assignmentId, { owner, fence, sessionId, callId, questions, decisions, now = Date.now() }) {
      if (!sessionId || !callId || !Array.isArray(questions) || !questions.length || new Set(questions.map(row => row.id)).size !== questions.length) throw new Error('Invalid Attention triage batch');
      return tx(() => {
        const assignment = ownedAssignment(assignmentId, owner, fence, now), ticket = api.getTicket(assignment.ticket_id);
        if ((JSON.parse(assignment.payload).instructionRevision ?? 1) !== ticket.instructionRevision
          || !api.runs(assignmentId).some(run => run.fence === fence && run.sessionId === sessionId && ['submitted', 'running'].includes(run.state))) throw new Error('Attention triage execution changed');
        const normalized = validateAttentionDecisions({ decisions }, { questions, instruction: ticket.mandate?.instruction || '' }).map(row => {
          const state = decisions.find(input => input.questionId === row.questionId)?.systemState;
          return row.route === 'user' && ['mandate-unavailable', 'model-unavailable', 'timeout', 'budget-exhausted', 'triage-unavailable'].includes(state) ? { ...row, systemState: state } : row;
        });
        return questions.map(question => {
          const key = JSON.stringify([sessionId, callId, question.id]), resolution = normalized.find(row => row.questionId === question.id);
          const existing = db.prepare('SELECT * FROM sa_attention_resolutions WHERE question_key=?').get(key);
          if (existing) {
            if (existing.assignment_id !== assignmentId || existing.question !== JSON.stringify(question)
              || existing.instruction_revision !== ticket.instructionRevision || existing.resolution !== JSON.stringify(resolution)) throw new Error('Attention triage identity conflict');
            return resolutionValue(existing);
          }
          db.prepare('INSERT INTO sa_attention_resolutions VALUES (?,?,?,?,?,?,?,?,?)').run(key, assignmentId, ticket.id, sessionId, callId,
            ticket.instructionRevision, JSON.stringify(question), JSON.stringify(resolution), new Date(now).toISOString());
          return resolutionValue(db.prepare('SELECT * FROM sa_attention_resolutions WHERE question_key=?').get(key));
        });
      });
    },
    queueAnsweredReviewContinuation(ticketId, options) {
      return tx(() => queueAnsweredReviewContinuation(ticketId, options));
    },
    parkAttention(assignmentId, { owner, fence, result, now = Date.now() }) {
      return tx(() => {
        const assignment = ownedAssignment(assignmentId, owner, fence, now);
        const ticket = api.getTicket(assignment.ticket_id);
        if ((JSON.parse(assignment.payload).instructionRevision ?? 1) !== ticket.instructionRevision) throw new Error('Attention requirements changed');
        const run = api.runs(assignmentId).find(item => item.id === result.runId && item.fence === fence);
        if (!run || run.state !== 'verifying' || !result.waitingAttention?.attentionIds?.length || !result.checkpoint || !result.transcript) throw new Error('Attention pause requires saved execution evidence');
        if (JSON.stringify(run.evidence) !== JSON.stringify(result)) throw new Error('Attention pause differs from saved evidence');
        const entries = api.attentions(ticket.id);
        if (!result.waitingAttention.attentionIds.every(id => entries.some(entry => entry.id === id && entry.sessionId === run.sessionId && entry.assignmentId === assignmentId))) throw new Error('Attention pause identity mismatch');
        const at = new Date(now).toISOString();
        db.prepare("UPDATE sa_runs SET state='waiting',updated_at=? WHERE id=?").run(at, run.id);
        db.prepare("UPDATE sa_assignments SET state='waiting',owner=NULL,lease_until=NULL,updated_at=? WHERE id=?").run(at, assignmentId);
        const pending = api.assignments(ticket.id).some(item => ['claimed', 'uncertain'].includes(item.state));
        const status = ticket.status === 'pausing' ? (pending ? 'pausing' : 'paused') : 'waiting';
        db.prepare('UPDATE sa_tickets SET status=?,updated_at=? WHERE id=?').run(status, at, ticket.id);
        return api.getAssignment(assignmentId);
      });
    },
    queueAnsweredAttention({ validateMandate, now = Date.now() }) {
      if (typeof validateMandate !== 'function') throw new Error('Attention requires current authorization');
      return tx(() => {
        let queued = 0;
        const rows = db.prepare("SELECT * FROM sa_assignments WHERE state='waiting'").all();
        for (const row of rows) {
          const ticket = api.getTicket(row.ticket_id), payload = JSON.parse(row.payload);
          if (ticket.status !== 'waiting' || (payload.instructionRevision ?? 1) !== ticket.instructionRevision || !validateMandate(ticket.mandate)) continue;
          const run = api.runs(row.id).find(item => item.fence === row.fence && item.state === 'waiting');
          const ids = run?.evidence?.waitingAttention?.attentionIds;
          if (!ids?.length) continue;
          const entries = api.attentions(ticket.id);
          if (!ids.every(id => entries.some(entry => entry.id === id && entry.answerTriggerId))) continue;
          payload.attentionContinuation = { runId: run.id };
          delete payload.contextContinuation;
          delete payload.pauseContinuation;
          delete payload.verificationOnly;
          const at = new Date(now).toISOString();
          db.prepare("UPDATE sa_assignments SET state='queued',payload=?,updated_at=? WHERE id=?").run(JSON.stringify(payload), at, row.id);
          db.prepare("UPDATE sa_tickets SET status='open',updated_at=? WHERE id=?").run(at, ticket.id);
          queued++;
        }
        // Router review questions have no pending official ask-user call. Resume
        // the saved result's session with the real question and answer instead.
        if (typeof api.queueReviewContinuation === 'function') {
          for (const ticket of api.listTickets({ status: 'waiting', limit: 1000 })) {
            if (!validateMandate(ticket.mandate)) continue;
            if (ticket.resultVersion < 1) continue;
            const continuation = queueAnsweredReviewContinuation(ticket.id, { sourceResultVersion: ticket.resultVersion, validateMandate, now });
            if (continuation.queued) queued++;
          }
        }
        return queued;
      });
    },
    openReviewAttention(ticketId, { assignmentId, runId, sessionId, instructionRevision, resultVersion, userDecision, delivery, now = Date.now(), inTransaction = false } = {}) {
      if (!['permission', 'information', 'scope'].includes(userDecision?.kind)
        || typeof userDecision.question !== 'string' || !userDecision.question.trim() || userDecision.question.length > 2000) throw new Error('Review Attention requires a real user decision');
      const publication = validateDelivery(delivery);
      if (publication.action !== 'ask' || !Number.isSafeInteger(resultVersion) || resultVersion < 1) throw new Error('Review Attention requires an ask publication and result version');
      const open = () => {
        const ticket = api.getTicket(ticketId), assignment = api.getAssignment(assignmentId);
        const result = api.results(ticketId).at(-1);
        const run = api.runs(assignmentId).find(item => item.id === runId);
        if (!ticket || !assignment || assignment.ticketId !== ticketId || !['open', 'waiting'].includes(ticket.status)
          || instructionRevision !== ticket.instructionRevision || (assignment.instructionRevision ?? 1) !== instructionRevision
          || ticket.resultVersion !== resultVersion || result?.version !== resultVersion
          || result.instructionRevision !== instructionRevision || result.runId !== runId || result.sessionId !== sessionId
          || !run || run.sessionId !== sessionId || !['verifying', 'waiting', 'completed'].includes(run.state)) throw new Error('Review Attention result changed');
        if (result.review?.verdict !== 'wait' || result.review?.waitKind !== 'blocked'
          || JSON.stringify(result.review.userDecision) !== JSON.stringify(userDecision)) throw new Error('Review Attention does not match the saved user decision');
        if (!attentionChannels.has(ticket.mandate.source?.channel) || !ticket.mandate.actorId) throw new Error('Review Attention source unavailable');
        const question = { id: `review:${ticketId}:${resultVersion}`, question: userDecision.question.trim(),
          ...(publication.options?.length ? { options: publication.options.map(label => ({ label })) } : {}) };
        const key = JSON.stringify([sessionId, `review:${resultVersion}`, question.id, 'review', instructionRevision, resultVersion, runId, userDecision.kind]);
        const previous = db.prepare('SELECT * FROM sa_attentions WHERE question_key=?').get(key);
        if (previous) {
          if (previous.assignment_id !== assignmentId || previous.question !== JSON.stringify(question)) throw new Error('Review Attention identity conflict');
          return value(previous);
        }
        const attentionId = randomUUID(), outboxId = randomUUID(), at = new Date(now).toISOString();
        const body = publication.text.includes(question.question) ? publication.text : `${publication.text}\n${question.question}`;
        const text = attentionText(ticket.mandate.source, attentionId, [body, ...(publication.options || [])].join('\n'));
        const payload = { type: 'ticket.attention', attentionId, ticketId, source: ticket.mandate.source,
          instructionRevision, resultVersion, text, ...(publication.options ? { options: publication.options } : {}) };
        db.prepare("INSERT INTO sa_outbox(id,unique_key,ticket_id,payload,state,attempts,next_at,created_at,updated_at) VALUES (?,?,?,?,'queued',0,?,?,?)")
          .run(outboxId, `attention:${attentionId}`, ticketId, JSON.stringify(payload), now, at, at);
        db.prepare('INSERT INTO sa_attentions VALUES (?,?,?,?,?,?,?,?,?)')
          .run(attentionId, assignmentId, ticketId, sessionId, key, JSON.stringify(question), outboxId, null, at);
        return value(db.prepare('SELECT * FROM sa_attentions WHERE id=?').get(attentionId));
      };
      return inTransaction ? open() : tx(open);
    },
    openAttention(assignmentId, { owner, fence, sessionId, callId, questions, now = Date.now() }) {
      if (typeof callId !== 'string' || !callId || !Array.isArray(questions) || !questions.length
        || questions.some(q => typeof q.id !== 'string' || !q.id || typeof q.question !== 'string' || !q.question)
        || new Set(questions.map(q => q.id)).size !== questions.length) throw new Error('Invalid Attention questions');
      return tx(() => {
        const assignment = ownedAssignment(assignmentId, owner, fence, now);
        const ticket = api.getTicket(assignment.ticket_id);
        if ((JSON.parse(assignment.payload).instructionRevision ?? 1) !== ticket.instructionRevision) throw new Error('Attention requirements changed');
        const run = api.runs(assignmentId).find(item => item.fence === fence && item.sessionId === sessionId);
        if (!run || !['submitted', 'running'].includes(run.state)) throw new Error('Attention requires the executing session');
        if (!attentionChannels.has(ticket.mandate.source?.channel) || !ticket.mandate.actorId) throw new Error('Attention source unavailable');
        return questions.map(question => {
          const key = JSON.stringify([sessionId, callId, question.id]);
          const previous = db.prepare('SELECT * FROM sa_attentions WHERE question_key=?').get(key);
          if (previous) {
            if (previous.assignment_id !== assignmentId || previous.question !== JSON.stringify(question)) throw new Error('Attention identity conflict');
            return value(previous);
          }
          const attentionId = randomUUID(), outboxId = randomUUID(), at = new Date(now).toISOString();
          const triageRow = db.prepare('SELECT * FROM sa_attention_resolutions WHERE question_key=?').get(key);
          const triage = triageRow ? JSON.parse(triageRow.resolution) : null;
          if (triage && triage.route !== 'user') throw new Error('Automatically resolved Attention cannot open a human question');
          // Preserve wording, detail and labels; no model rephrases the question.
          const text = attentionText(ticket.mandate.source, attentionId, [triage?.systemState ? triage.basis : undefined, question.question, question.detail, ...(question.options || []).map(option =>
            option.label + (option.description ? `：${option.description}` : ''))].filter(part => part !== undefined).join('\n'));
          const payload = { type: 'ticket.attention', attentionId, ticketId: ticket.id, source: ticket.mandate.source,
            instructionRevision: ticket.instructionRevision, resultVersion: ticket.resultVersion, text,
            ...(triage ? { triage } : {}),
            ...(question.options?.length ? { options: question.options.map(option => option.label) } : {}) };
          db.prepare("INSERT INTO sa_outbox(id,unique_key,ticket_id,payload,state,attempts,next_at,created_at,updated_at) VALUES (?,?,?,?,'queued',0,?,?,?)")
            .run(outboxId, `attention:${attentionId}`, ticket.id, JSON.stringify(payload), now, at, at);
          db.prepare('INSERT INTO sa_attentions VALUES (?,?,?,?,?,?,?,?,?)')
            .run(attentionId, assignmentId, ticket.id, sessionId, key, JSON.stringify(question), outboxId, null, at);
          return value(db.prepare('SELECT * FROM sa_attentions WHERE id=?').get(attentionId));
        });
      });
    },
    attentions(ticketId) { return db.prepare('SELECT * FROM sa_attentions WHERE ticket_id=? ORDER BY created_at,rowid').all(ticketId).map(value); },
    answeredAttentionForReview(ticketId, { instructionRevision, runId, sessionId } = {}) {
      const ticket = api.getTicket(ticketId);
      if (!ticket || ticket.instructionRevision !== instructionRevision || !runId || !sessionId) return [];
      const rows = db.prepare(`SELECT a.* FROM sa_attentions a
        JOIN sa_ticket_triggers tt ON tt.ticket_id=a.ticket_id AND tt.trigger_id=a.answer_trigger_id
        WHERE a.ticket_id=? AND a.session_id=? AND a.answer_trigger_id IS NOT NULL ORDER BY a.created_at,a.rowid`).all(ticketId, sessionId);
      return rows.flatMap(row => {
        const entry = value(row), assignment = api.getAssignment(entry.assignmentId);
        const run = assignment && api.runs(entry.assignmentId).find(item => item.id === runId && item.sessionId === sessionId);
        const trigger = api.getTrigger(entry.answerTriggerId);
        if (!assignment || assignment.ticketId !== ticketId || (assignment.instructionRevision ?? 1) !== instructionRevision
          || !run || (entry.origin === 'review' && (entry.instructionRevision !== instructionRevision || entry.runId !== runId))
          || !trigger || trigger.actor?.kind !== 'human') return [];
        const answer = trigger.source?.channel === 'desktop' && trigger.source.answer
          ? trigger.source.answer : { selected: [], custom: attentionReplyText(entry.id, trigger.content) };
        return [{ attentionId: entry.id, question: entry.question, answer }];
      });
    },
    // Only the authenticated local desktop dispatcher may call this method.
    answerDesktopAttention({ ticketId, attentionId, instructionRevision, requestId, answer }) {
      if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 512) throw new Error('Invalid Attention request id');
      return tx(() => {
        const row = db.prepare('SELECT * FROM sa_attentions WHERE id=? AND ticket_id=?').get(attentionId, ticketId);
        if (!row) throw new Error('Attention not found');
        const ticket = api.getTicket(ticketId), origin = ticket.mandate.source;
        if (origin?.channel !== 'desktop' || ticket.mandate.actorId !== 'desktop-owner' || !origin.sessionId) throw new Error('Attention desktop owner mismatch');
        if (instructionRevision !== ticket.instructionRevision || !currentRevision(row, ticket)) throw new Error('Attention requirements changed');
        const question = JSON.parse(row.question), labels = (question.options || []).map(option => option.label);
        if (!answer || !Array.isArray(answer.selected) || answer.selected.some(label => typeof label !== 'string' || !labels.includes(label))
          || new Set(answer.selected).size !== answer.selected.length || (!question.multiSelect && answer.selected.length > 1)
          || (answer.custom !== undefined && (typeof answer.custom !== 'string' || answer.custom.length > 100000))
          || (!answer.selected.length && !answer.custom?.trim())) throw new Error('Invalid Attention answer');
        const structured = { selected: answer.selected, ...(answer.custom !== undefined ? { custom: answer.custom } : {}) };
        const key = JSON.stringify(['desktop-attention', origin.sessionId, requestId]);
        const previous = db.prepare('SELECT * FROM sa_triggers WHERE dedupe_key=?').get(key);
        if (previous) {
          const source = JSON.parse(previous.source);
          if (source.attentionId !== attentionId || JSON.stringify(source.answer) !== JSON.stringify(structured) || row.answer_trigger_id !== previous.id) throw new Error('Attention request conflict');
          return { ...value(row), duplicate: true };
        }
        if (['cancelling', 'cancelled', 'closed', 'completed', 'failed'].includes(ticket.status)) throw new Error('Attention ticket is terminal');
        if (row.answer_trigger_id) throw new Error('Attention already answered');
        const triggerId = randomUUID(), content = [...answer.selected, answer.custom].filter(text => text !== undefined).join('\n');
        const source = { ...origin, messageId: requestId, attentionId, answer: structured };
        db.prepare('INSERT INTO sa_triggers(id,dedupe_key,thread_id,source,actor,content,content_hash,created_at) VALUES (?,?,?,?,?,?,?,?)')
          .run(triggerId, key, ticket.threadId, JSON.stringify(source), JSON.stringify({ kind: 'human', id: 'desktop-owner' }), content,
            createHash('sha256').update(content).digest('hex'), new Date().toISOString());
        db.prepare('UPDATE sa_attentions SET answer_trigger_id=? WHERE id=?').run(triggerId, attentionId);
        db.prepare('INSERT INTO sa_ticket_triggers VALUES (?,?)').run(ticketId, triggerId);
        return { ...value({ ...row, answer_trigger_id: triggerId }), duplicate: false };
      });
    },
    answerAttention(triggerId, { ownerAllowed = false } = {}) {
      if (!ownerAllowed) return null;
      return tx(() => {
        const trigger = api.getTrigger(triggerId), source = trigger?.source;
        if (!source || trigger.actor.kind !== 'human') return null;
        const explicitId = /^\/answer ([0-9a-f-]{36})\s+\S[\s\S]*$/iu.exec(trigger.content.trim())?.[1]?.toLowerCase();
        if (!source.parentMessageId && !explicitId) return null;
        // Old Telegram receipts used the provider-local integer; compare only
        // after the same account/chat check below, never across namespaces.
        const parentIds = [source.parentMessageId];
        if (source.channel === 'telegram' && source.parentMessageId?.startsWith(`${source.chatId}:`)) parentIds.push(source.parentMessageId.slice(source.chatId.length + 1));
        const rows = explicitId
          ? db.prepare('SELECT * FROM sa_attentions WHERE id=?').all(explicitId)
          : db.prepare(`SELECT a.*,r.payload AS receipt FROM sa_attentions a JOIN sa_delivery_receipts r ON r.outbox_id=a.outbox_id
              WHERE json_extract(r.payload,'$.messageId') IN (?,?) OR EXISTS(
                SELECT 1 FROM json_each(r.payload,'$.parts') p WHERE json_extract(p.value,'$.messageId') IN (?,?))`).all(parentIds[0], parentIds[1] ?? null, parentIds[0], parentIds[1] ?? null);
        const matches = rows.filter(row => {
          const ticket = api.getTicket(row.ticket_id), origin = ticket?.mandate.source;
          if (!currentRevision(row, ticket)) return false;
          return source.channel === origin.channel && source.appId === origin.appId && source.accountId === origin.accountId && source.connectionRevision === origin.connectionRevision && source.chatId === origin.chatId && source.topicId === origin.topicId
            && (trigger.actor.id === ticket.mandate.actorId || (ticket.mandate.admission === 'enabled-rules' && ticket.mandate.actorKind === 'machine')) && !['cancelling', 'cancelled', 'closed', 'completed', 'failed'].includes(ticket.status);
        });
        if (matches.length !== 1) return null;
        const row = matches[0];
        if (row.answer_trigger_id && row.answer_trigger_id !== triggerId) return null;
        db.prepare('UPDATE sa_attentions SET answer_trigger_id=? WHERE id=?').run(triggerId, row.id);
        db.prepare("UPDATE sa_candidates SET status='held',updated_at=? WHERE trigger_id=? AND status='queued'").run(new Date().toISOString(), triggerId);
        db.prepare('INSERT OR IGNORE INTO sa_ticket_triggers VALUES (?,?)').run(row.ticket_id, triggerId);
        return { ...value({ ...row, answer_trigger_id: triggerId }), duplicate: row.answer_trigger_id === triggerId };
      });
    },
  };
}
