import { taskExecutionBlocked, taskStopped } from './task-lifecycle.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { validateAttentionDecisions } from './attention-triage.mjs';

const attentionChannels = new Set(['desktop', 'link', 'feishu', 'wecom', 'qq', 'weixin', 'telegram', 'discord', 'slack', 'dingtalk', 'whatsapp', 'email', 'webhook', 'api']);
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
    task_id TEXT NOT NULL REFERENCES sa_tasks(id), session_id TEXT NOT NULL,
    question_key TEXT NOT NULL UNIQUE, question TEXT NOT NULL, outbox_id TEXT NOT NULL REFERENCES sa_outbox(id),
    answer_trigger_id TEXT REFERENCES sa_triggers(id), created_at TEXT NOT NULL, instruction_revision INTEGER NOT NULL DEFAULT 1);
    CREATE UNIQUE INDEX IF NOT EXISTS sa_attention_answer ON sa_attentions(answer_trigger_id) WHERE answer_trigger_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS sa_receipt_message ON sa_delivery_receipts(json_extract(payload,'$.messageId'));`);
  db.exec(`CREATE TABLE IF NOT EXISTS sa_attention_resolutions(
    question_key TEXT PRIMARY KEY, assignment_id TEXT NOT NULL REFERENCES sa_assignments(id),
    task_id TEXT NOT NULL REFERENCES sa_tasks(id), session_id TEXT NOT NULL, call_id TEXT NOT NULL,
    instruction_revision INTEGER NOT NULL, question TEXT NOT NULL, resolution TEXT NOT NULL, created_at TEXT NOT NULL);`);
  const resolutionValue = row => ({ assignmentId: row.assignment_id, taskId: row.task_id, sessionId: row.session_id,
    callId: row.call_id, instructionRevision: row.instruction_revision, question: JSON.parse(row.question),
    ...JSON.parse(row.resolution), createdAt: row.created_at });
  const value = row => {
    if (!row) return row;
    return { id: row.id, assignmentId: row.assignment_id, taskId: row.task_id,
      sessionId: row.session_id, callId: JSON.parse(row.question_key)[1], question: JSON.parse(row.question), outboxId: row.outbox_id,
      answerTriggerId: row.answer_trigger_id, state: row.answer_trigger_id ? 'answered' : 'waiting', createdAt: row.created_at,
      origin: 'worker', instructionRevision: row.instruction_revision };
  };
  const currentRevision = (row, task) => !!task && api.getAssignment(row.assignment_id)?.taskId === task.id
    && row.instruction_revision === (api.getAssignment(row.assignment_id)?.appliedSnapshot?.instructionRevision ?? api.getAssignment(row.assignment_id)?.instructionRevision ?? 1)
    && api.runs(row.assignment_id).some(run => run.sessionId === row.session_id && !['cancelled', 'failed', 'completed'].includes(run.state));
  return {
    attentionResolutions(taskId, { sessionId, callId } = {}) {
      return db.prepare('SELECT * FROM sa_attention_resolutions WHERE task_id=? ORDER BY created_at,rowid').all(taskId)
        .filter(row => (sessionId === undefined || row.session_id === sessionId) && (callId === undefined || row.call_id === callId)).map(resolutionValue);
    },
    saveAttentionResolutions(assignmentId, { owner, fence, sessionId, callId, questions, decisions, now = Date.now() }) {
      if (!sessionId || !callId || !Array.isArray(questions) || !questions.length || new Set(questions.map(row => row.id)).size !== questions.length) throw new Error('Invalid Attention triage batch');
      return tx(() => {
        const assignment = ownedAssignment(assignmentId, owner, fence, now), task = api.getTask(assignment.task_id);
        if ((JSON.parse(assignment.payload).instructionRevision ?? 1) !== task.instructionRevision
          || !api.runs(assignmentId).some(run => run.fence === fence && run.sessionId === sessionId && ['submitted', 'running'].includes(run.state))) throw new Error('Attention triage execution changed');
        const normalized = validateAttentionDecisions({ decisions }, { questions, instruction: task.mandate?.instruction || '' }).map(row => {
          const state = decisions.find(input => input.questionId === row.questionId)?.systemState;
          return row.route === 'user' && ['mandate-unavailable', 'model-unavailable', 'timeout', 'triage-unavailable'].includes(state) ? { ...row, systemState: state } : row;
        });
        return questions.map(question => {
          const key = JSON.stringify([sessionId, callId, question.id]), resolution = normalized.find(row => row.questionId === question.id);
          const existing = db.prepare('SELECT * FROM sa_attention_resolutions WHERE question_key=?').get(key);
          if (existing) {
            if (existing.assignment_id !== assignmentId || existing.question !== JSON.stringify(question)
              || existing.instruction_revision !== task.instructionRevision || existing.resolution !== JSON.stringify(resolution)) throw new Error('Attention triage identity conflict');
            return resolutionValue(existing);
          }
          db.prepare('INSERT INTO sa_attention_resolutions VALUES (?,?,?,?,?,?,?,?,?)').run(key, assignmentId, task.id, sessionId, callId,
            task.instructionRevision, JSON.stringify(question), JSON.stringify(resolution), new Date(now).toISOString());
          return resolutionValue(db.prepare('SELECT * FROM sa_attention_resolutions WHERE question_key=?').get(key));
        });
      });
    },
    parkAttention(assignmentId, { owner, fence, result, now = Date.now() }) {
      return tx(() => {
        const assignment = ownedAssignment(assignmentId, owner, fence, now);
        const task = api.getTask(assignment.task_id);
        if ((JSON.parse(assignment.payload).instructionRevision ?? 1) !== task.instructionRevision) throw new Error('Attention requirements changed');
        const run = api.runs(assignmentId).find(item => item.id === result.runId && item.fence === fence);
        if (!run || run.state !== 'verifying' || !result.waitingAttention?.attentionIds?.length || !result.transcript) throw new Error('Attention pause requires saved execution evidence');
        if (JSON.stringify(run.evidence) !== JSON.stringify(result)) throw new Error('Attention pause differs from saved evidence');
        const entries = api.attentions(task.id);
        if (!result.waitingAttention.attentionIds.every(id => entries.some(entry => entry.id === id && entry.sessionId === run.sessionId && entry.assignmentId === assignmentId))) throw new Error('Attention pause identity mismatch');
        const at = new Date(now).toISOString();
        db.prepare("UPDATE sa_runs SET state='waiting',updated_at=? WHERE id=?").run(at, run.id);
        db.prepare("UPDATE sa_assignments SET state='waiting',owner=NULL,lease_until=NULL,updated_at=? WHERE id=?").run(at, assignmentId);
        const pending = api.assignments(task.id).some(item => ['claimed', 'uncertain'].includes(item.state));
        const control = task.executionControl?.pauseRequested ? { pauseRequested: pending, paused: !pending } : task.executionControl;
        db.prepare("UPDATE sa_tasks SET status='waiting',execution_control=?,updated_at=? WHERE id=?").run(JSON.stringify(control || {}), at, task.id);
        return api.getAssignment(assignmentId);
      });
    },
    queueAnsweredAttention({ validateMandate, now = Date.now() }) {
      if (typeof validateMandate !== 'function') throw new Error('Attention requires current authorization');
      return tx(() => {
        let queued = 0;
        const rows = db.prepare("SELECT * FROM sa_assignments WHERE state='waiting'").all();
        for (const row of rows) {
          const task = api.getTask(row.task_id), payload = JSON.parse(row.payload);
          if (taskExecutionBlocked(task) || (payload.instructionRevision ?? 1) !== task.instructionRevision || !validateMandate(task.mandate)) continue;
          const run = api.runs(row.id).find(item => item.fence === row.fence && item.state === 'waiting');
          const ids = run?.evidence?.waitingAttention?.attentionIds;
          if (!ids?.length) continue;
          const entries = api.attentions(task.id);
          if (!ids.every(id => entries.some(entry => entry.id === id && entry.answerTriggerId))) continue;
          payload.attentionContinuation = { runId: run.id };
          delete payload.contextContinuation;
          delete payload.pauseContinuation;
          const at = new Date(now).toISOString();
          db.prepare("UPDATE sa_assignments SET state='queued',payload=?,updated_at=? WHERE id=?").run(JSON.stringify(payload), at, row.id);
          db.prepare("UPDATE sa_tasks SET status='running',updated_at=? WHERE id=?").run(at, task.id);
          queued++;
        }
        return queued;
      });
    },
    openAttention(assignmentId, { owner, fence, sessionId, callId, questions, now = Date.now() }) {
      if (typeof callId !== 'string' || !callId || !Array.isArray(questions) || !questions.length
        || questions.some(q => typeof q.id !== 'string' || !q.id || typeof q.question !== 'string' || !q.question)
        || new Set(questions.map(q => q.id)).size !== questions.length) throw new Error('Invalid Attention questions');
      return tx(() => {
        const assignment = ownedAssignment(assignmentId, owner, fence, now);
        const task = api.getTask(assignment.task_id);
        if ((JSON.parse(assignment.payload).instructionRevision ?? 1) !== task.instructionRevision) throw new Error('Attention requirements changed');
        const run = api.runs(assignmentId).find(item => item.fence === fence && item.sessionId === sessionId);
        if (!run || !['submitted', 'running'].includes(run.state)) throw new Error('Attention requires the executing session');
        if (!attentionChannels.has(task.mandate.source?.channel) || !task.mandate.actorId) throw new Error('Attention source unavailable');
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
          const text = attentionText(task.mandate.source, attentionId, [question.question, question.detail, ...(question.options || []).map(option =>
            option.label + (option.description ? `：${option.description}` : ''))].filter(part => part !== undefined).join('\n'));
          const payload = { type: 'task.attention', attentionId, taskId: task.id, source: task.mandate.source,
            instructionRevision: task.instructionRevision, resultVersion: task.resultVersion, text,
            ...(triage ? { triage } : {}),
            ...(question.options?.length ? { options: question.options.map(option => option.label) } : {}) };
          db.prepare("INSERT INTO sa_outbox(id,unique_key,task_id,payload,state,attempts,next_at,created_at,updated_at) VALUES (?,?,?,?,'queued',0,?,?,?)")
            .run(outboxId, `attention:${attentionId}`, task.id, JSON.stringify(payload), now, at, at);
          db.prepare('INSERT INTO sa_attentions(id,assignment_id,task_id,session_id,question_key,question,outbox_id,answer_trigger_id,created_at,instruction_revision) VALUES (?,?,?,?,?,?,?,?,?,?)')
            .run(attentionId, assignmentId, task.id, sessionId, key, JSON.stringify(question), outboxId, null, at, JSON.parse(assignment.payload).instructionRevision ?? 1);
          return value(db.prepare('SELECT * FROM sa_attentions WHERE id=?').get(attentionId));
        });
      });
    },
    attentions(taskId) { return db.prepare('SELECT * FROM sa_attentions WHERE task_id=? ORDER BY created_at,rowid').all(taskId).map(value); },
    // Authenticated desktop or device adapters enforce their own source scope before calling.
    answerDesktopAttention({ taskId, attentionId, instructionRevision, requestId, answer, deviceSource }) {
      if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 512) throw new Error('Invalid Attention request id');
      return tx(() => {
        const row = db.prepare('SELECT * FROM sa_attentions WHERE id=? AND task_id=?').get(attentionId, taskId);
        if (!row) throw new Error('Attention not found');
        const task = api.getTask(taskId), origin = task.mandate.source;
        const device = origin?.channel === 'link' && deviceSource?.channel === 'link'
          && ['deviceId', 'sessionId', 'threadId'].every(key => origin[key] && origin[key] === deviceSource[key])
          && task.mandate.actorId === `device:${origin.deviceId}`;
        if (!device && (origin?.channel !== 'desktop' || task.mandate.actorId !== 'desktop-owner' || !origin.sessionId)) throw new Error('Attention source owner mismatch');
        if (instructionRevision !== value(row).instructionRevision || !currentRevision(row, task)) throw new Error('Attention requirements changed');
        const question = JSON.parse(row.question), labels = (question.options || []).map(option => option.label);
        if (!answer || !Array.isArray(answer.selected) || answer.selected.some(label => typeof label !== 'string' || !labels.includes(label))
          || new Set(answer.selected).size !== answer.selected.length || (!question.multiSelect && answer.selected.length > 1)
          || (answer.custom !== undefined && (typeof answer.custom !== 'string' || answer.custom.length > 100000))
          || (!answer.selected.length && !answer.custom?.trim())) throw new Error('Invalid Attention answer');
        const structured = { selected: answer.selected, ...(answer.custom !== undefined ? { custom: answer.custom } : {}) };
        const key = JSON.stringify(['desktop-attention', ...(device ? [origin.deviceId] : []), origin.sessionId, requestId]);
        const previous = db.prepare('SELECT * FROM sa_triggers WHERE dedupe_key=?').get(key);
        if (previous) {
          const source = JSON.parse(previous.source);
          if (source.attentionId !== attentionId || JSON.stringify(source.answer) !== JSON.stringify(structured) || row.answer_trigger_id !== previous.id) throw new Error('Attention request conflict');
          return { ...value(row), duplicate: true };
        }
        if ((task.status === 'completed' || taskStopped(task))) throw new Error('Attention task is terminal');
        if (row.answer_trigger_id) throw new Error('Attention already answered');
        const triggerId = randomUUID(), content = [...answer.selected, answer.custom].filter(text => text !== undefined).join('\n');
        const source = { ...origin, messageId: device ? deviceSource.messageId : requestId, attentionId, answer: structured };
        db.prepare('INSERT INTO sa_triggers(id,dedupe_key,thread_id,source,actor,content,content_hash,created_at) VALUES (?,?,?,?,?,?,?,?)')
          .run(triggerId, key, task.threadId, JSON.stringify(source), JSON.stringify({ kind: 'human', id: device ? task.mandate.actorId : 'desktop-owner' }), content,
            createHash('sha256').update(content).digest('hex'), new Date().toISOString());
        db.prepare('UPDATE sa_attentions SET answer_trigger_id=? WHERE id=?').run(triggerId, attentionId);
        db.prepare('INSERT INTO sa_task_triggers VALUES (?,?)').run(taskId, triggerId);
        api.recordTaskInputInTransaction({ taskId, triggerId, kind: 'answer', idempotencyKey: `trigger:${triggerId}` });
        return { ...value({ ...row, answer_trigger_id: triggerId }), duplicate: false };
      });
    },
    answerAttention(triggerId, { sourceAllowed = false } = {}) {
      if (!sourceAllowed) return null;
      return tx(() => {
        const trigger = api.readIntakeEvent(triggerId), source = trigger?.source;
        if (!source || !trigger.actor?.id) return null;
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
          const task = api.getTask(row.task_id), origin = task?.mandate.source;
          if (!currentRevision(row, task)) return false;
          return source.channel === origin.channel && source.connectionId === origin.connectionId && source.conversationId === origin.conversationId && source.sourceType === origin.sourceType && source.appId === origin.appId && source.accountId === origin.accountId && source.connectionRevision === origin.connectionRevision && source.chatId === origin.chatId && source.topicId === origin.topicId
            && trigger.actor.id === task.mandate.actorId && !(task.status === 'completed' || taskStopped(task));
        });
        if (matches.length !== 1) return null;
        const row = matches[0];
        if (row.answer_trigger_id && row.answer_trigger_id !== triggerId) return null;
        db.prepare("UPDATE sa_triggers SET intake_stage='admitted' WHERE id=?").run(triggerId);
        db.prepare('UPDATE sa_attentions SET answer_trigger_id=? WHERE id=?').run(triggerId, row.id);
        db.prepare("UPDATE sa_candidates SET status='held',updated_at=? WHERE trigger_id=? AND status='queued'").run(new Date().toISOString(), triggerId);
        db.prepare('INSERT OR IGNORE INTO sa_task_triggers VALUES (?,?)').run(row.task_id, triggerId);
        api.recordTaskInputInTransaction({ taskId: row.task_id, triggerId, kind: 'answer', idempotencyKey: `trigger:${triggerId}` });
        return { ...value({ ...row, answer_trigger_id: triggerId }), duplicate: row.answer_trigger_id === triggerId };
      });
    },
  };
}
