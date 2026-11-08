import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { installAttentionStore } from './attention-store.mjs';
import { installDesktopTicketStore } from './desktop-ticket-store.mjs';
import { installGoalBudgetStore } from './goal-budget-store.mjs';
import { installEvalDispositionStore } from './eval-disposition-store.mjs';
import { installTicketRevisions } from './ticket-revisions.mjs';
import { installRouterActionStore } from './router-action-store.mjs';
import { installDirectReplyStore } from './direct-reply-store.mjs';
import { enqueueTicketAck } from './ticket-ack.mjs';
import { systemStateDelivery } from './result-delivery.mjs';
import { retireContentReview } from './retire-content-review.mjs';
import { installLearningSourceStore } from './learning-source-store.mjs';
import { installWorkerExecutionStore } from './worker-execution-store.mjs';
import { installRouterQuestionStore } from './router-question-store.mjs';
import { normalizeTicketTitle } from './ticket-title.mjs';

const json = value => JSON.stringify(value);
const parse = value => JSON.parse(value);
const id = (value, name = 'id') => { if (typeof value !== 'string' || !value.trim() || value.length > 512) throw new Error(`Invalid ${name}`); return value; };
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message) => Object.assign(new Error(message), { code });
const copy = value => structuredClone(value);
const uuid = () => randomUUID();
const timestamp = n => new Date(n).toISOString();
const safeLimit = (value, fallback, max) => Number.isSafeInteger(value) && value > 0 ? Math.min(value, max) : fallback;

/**
 * Durable single-machine SuperAgent orchestration control plane.
 * Uses a separate SQLite connection to assistant.db; all multi-record transitions are transactional.
 * Gate results and current-policy validation are supplied by the trusted host, never inferred here.
 */
export function createAssistantOrchestrationStore({ directory, filename } = {}) {
  if (!directory && !filename) throw new Error('Orchestration store requires a data directory');
  if (directory) mkdirSync(directory, { recursive: true });
  const path = filename || join(directory, 'assistant.db');
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS sa_threads(
      id TEXT PRIMARY KEY, source_type TEXT NOT NULL, source_id TEXT NOT NULL, metadata TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(source_type,source_id));
    CREATE TABLE IF NOT EXISTS sa_triggers(
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, dedupe_key TEXT NOT NULL UNIQUE,
      thread_id TEXT NOT NULL REFERENCES sa_threads(id), source TEXT NOT NULL, actor TEXT NOT NULL, content TEXT NOT NULL,
      content_hash TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS sa_triggers_thread_seq ON sa_triggers(thread_id,seq);
    CREATE INDEX IF NOT EXISTS sa_triggers_feishu_context ON sa_triggers(json_extract(source,'$.channel'),json_extract(source,'$.appId'),json_extract(source,'$.chatId'),seq);
    CREATE TABLE IF NOT EXISTS sa_trigger_admissions(trigger_id TEXT PRIMARY KEY REFERENCES sa_triggers(id), policy_version TEXT, gate TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sa_candidates(
      id TEXT PRIMARY KEY, trigger_id TEXT NOT NULL REFERENCES sa_triggers(id), thread_id TEXT NOT NULL REFERENCES sa_threads(id),
      policy_version TEXT NOT NULL, gate TEXT NOT NULL, status TEXT NOT NULL, eval_id TEXT, retry_count INTEGER NOT NULL DEFAULT 0,
      handback_ticket_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS sa_candidates_queue ON sa_candidates(thread_id,status,created_at);
    CREATE INDEX IF NOT EXISTS sa_candidates_trigger ON sa_candidates(trigger_id);
    CREATE TABLE IF NOT EXISTS sa_evals(
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES sa_threads(id), policy_version TEXT NOT NULL,
      candidate_ids TEXT NOT NULL, owner TEXT NOT NULL, attempt INTEGER NOT NULL, status TEXT NOT NULL,
      deadline INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS sa_eval_one_active_per_thread ON sa_evals(thread_id) WHERE status='running';
    CREATE INDEX IF NOT EXISTS sa_evals_deadline ON sa_evals(status,deadline);
    CREATE TABLE IF NOT EXISTS sa_decisions(
      id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL UNIQUE REFERENCES sa_candidates(id), thread_id TEXT NOT NULL,
      outcome TEXT NOT NULL, assessment TEXT NOT NULL, policy_version TEXT NOT NULL, ticket_id TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sa_tickets(
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES sa_threads(id), target TEXT NOT NULL, status TEXT NOT NULL,
      mandate TEXT NOT NULL, created_by_decision TEXT REFERENCES sa_decisions(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      result_version INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS sa_ticket_triggers(
      ticket_id TEXT NOT NULL REFERENCES sa_tickets(id), trigger_id TEXT NOT NULL REFERENCES sa_triggers(id),
      PRIMARY KEY(ticket_id,trigger_id));
    CREATE INDEX IF NOT EXISTS sa_ticket_triggers_trigger ON sa_ticket_triggers(trigger_id);
    CREATE TABLE IF NOT EXISTS sa_assignments(
      id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES sa_tickets(id), payload TEXT NOT NULL, state TEXT NOT NULL,
      priority INTEGER NOT NULL, owner TEXT, lease_until INTEGER, fence INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS sa_assignments_ready ON sa_assignments(state,priority DESC,created_at);
    CREATE TABLE IF NOT EXISTS sa_subscriptions(
      id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES sa_tickets(id), thread_id TEXT NOT NULL REFERENCES sa_threads(id),
      state TEXT NOT NULL, cursor_seq INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(ticket_id,thread_id));
    CREATE INDEX IF NOT EXISTS sa_subscriptions_thread ON sa_subscriptions(thread_id,state);
    CREATE TABLE IF NOT EXISTS sa_message_ownership(
      trigger_id TEXT PRIMARY KEY REFERENCES sa_triggers(id), subscription_id TEXT NOT NULL REFERENCES sa_subscriptions(id),
      ticket_id TEXT NOT NULL REFERENCES sa_tickets(id), cursor_seq INTEGER NOT NULL, delivered_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sa_handbacks(
      ticket_id TEXT NOT NULL REFERENCES sa_tickets(id), trigger_id TEXT NOT NULL REFERENCES sa_triggers(id),
      candidate_id TEXT NOT NULL REFERENCES sa_candidates(id), created_at TEXT NOT NULL, PRIMARY KEY(ticket_id,trigger_id));
    CREATE TABLE IF NOT EXISTS sa_results(
      ticket_id TEXT NOT NULL REFERENCES sa_tickets(id), version INTEGER NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(ticket_id,version));
    CREATE TABLE IF NOT EXISTS sa_outbox(
      id TEXT PRIMARY KEY, unique_key TEXT NOT NULL UNIQUE, ticket_id TEXT NOT NULL REFERENCES sa_tickets(id),
      payload TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
      owner TEXT, lease_until INTEGER, sent_at TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS sa_outbox_ready ON sa_outbox(state,next_at,created_at);
    CREATE TABLE IF NOT EXISTS sa_runs(
      id TEXT PRIMARY KEY, assignment_id TEXT NOT NULL REFERENCES sa_assignments(id),
      fence INTEGER NOT NULL, owner TEXT NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(assignment_id,fence));
    CREATE TABLE IF NOT EXISTS sa_delivery_receipts(outbox_id TEXT PRIMARY KEY REFERENCES sa_outbox(id), payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sa_outbox_reconciliations(
      seq INTEGER PRIMARY KEY AUTOINCREMENT, outbox_id TEXT NOT NULL REFERENCES sa_outbox(id), payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sa_subscription_applied(
      trigger_id TEXT PRIMARY KEY REFERENCES sa_triggers(id), assignment_id TEXT NOT NULL REFERENCES sa_assignments(id),
      session_id TEXT NOT NULL, message_id TEXT NOT NULL, applied_at TEXT NOT NULL);`);
  // Additive migration preserves existing Tickets and their original work version.
  const triggerColumns = new Set(db.prepare('PRAGMA table_info(sa_triggers)').all().map(row => row.name));
  if (!triggerColumns.has('subscription_eligible')) db.exec('ALTER TABLE sa_triggers ADD COLUMN subscription_eligible INTEGER NOT NULL DEFAULT 0');
  if (!triggerColumns.has('intake_stage')) db.exec("ALTER TABLE sa_triggers ADD COLUMN intake_stage TEXT NOT NULL DEFAULT 'admitted'");
  const ticketColumns = new Set(db.prepare('PRAGMA table_info(sa_tickets)').all().map(row => row.name));
  if (!ticketColumns.has('pause_reason')) db.exec('ALTER TABLE sa_tickets ADD COLUMN pause_reason TEXT');
  // Legacy review state is removed; historical result payloads remain immutable.
  if (!ticketColumns.has('continuation_wait')) db.exec('ALTER TABLE sa_tickets ADD COLUMN continuation_wait TEXT');
  if (!ticketColumns.has('title')) db.exec("ALTER TABLE sa_tickets ADD COLUMN title TEXT NOT NULL DEFAULT ''");
  if (!ticketColumns.has('instruction_revision')) db.exec('ALTER TABLE sa_tickets ADD COLUMN instruction_revision INTEGER NOT NULL DEFAULT 1');
  if (!ticketColumns.has('adjustment_of_ticket_id')) db.exec('ALTER TABLE sa_tickets ADD COLUMN adjustment_of_ticket_id TEXT REFERENCES sa_tickets(id)');
  if (!ticketColumns.has('acceptance')) db.exec(`ALTER TABLE sa_tickets ADD COLUMN acceptance TEXT NOT NULL DEFAULT '';
    UPDATE sa_tickets SET acceptance=json_extract(mandate,'$.acceptance') WHERE json_type(mandate,'$.acceptance')='text';`);
  let closed = false;
  const tx = fn => {
    if (closed) throw new Error('Orchestration store is closed');
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const threadRow = threadId => db.prepare('SELECT * FROM sa_threads WHERE id=?').get(threadId);
  const triggerRow = triggerId => db.prepare('SELECT * FROM sa_triggers WHERE id=?').get(triggerId);
  const threadValue = row => row && ({ id: row.id, source: { type: row.source_type, id: row.source_id }, metadata: parse(row.metadata), createdAt: row.created_at });
  const triggerValue = row => row && ({ id: row.id, seq: row.seq, dedupeKey: row.dedupe_key, threadId: row.thread_id, source: parse(row.source), actor: parse(row.actor), content: row.content, contentHash: row.content_hash, intakeStage: row.intake_stage, createdAt: row.created_at });
  const candidateValue = row => row && ({ id: row.id, triggerId: row.trigger_id, threadId: row.thread_id, policyVersion: row.policy_version, gate: parse(row.gate), status: row.status, evalId: row.eval_id, retryCount: row.retry_count, handbackTicketId: row.handback_ticket_id, createdAt: row.created_at, updatedAt: row.updated_at });
  const evalValue = row => row && ({ id: row.id, threadId: row.thread_id, policyVersion: row.policy_version, candidateIds: parse(row.candidate_ids), owner: row.owner, attempt: row.attempt, status: row.status, deadline: row.deadline, createdAt: row.created_at, updatedAt: row.updated_at });
  const decisionValue = row => row && ({ id: row.id, candidateId: row.candidate_id, threadId: row.thread_id, outcome: row.outcome, assessment: parse(row.assessment), policyVersion: row.policy_version, ticketId: row.ticket_id, createdAt: row.created_at });
  const ticketValue = row => row && ({ id: row.id, threadId: row.thread_id, title: normalizeTicketTitle(row.title, row.target), target: row.target, acceptance: row.acceptance, instructionRevision: row.instruction_revision, adjustmentOfTicketId: row.adjustment_of_ticket_id || null, liveSummary: ticketLiveSummary(row), status: row.status, pauseReason: row.pause_reason ? parse(row.pause_reason) : null, continuationWait: row.continuation_wait ? parse(row.continuation_wait) : null, mandate: { ...api.currentTicketMandate(row.id, parse(row.mandate)), target: row.target, acceptance: row.acceptance }, createdByDecision: row.created_by_decision, createdAt: row.created_at, updatedAt: row.updated_at, resultVersion: row.result_version });
  function ticketLiveSummary(row) {
    const result = db.prepare('SELECT payload FROM sa_results WHERE ticket_id=? ORDER BY version DESC LIMIT 1').get(row.id);
    const saved = result ? parse(result.payload) : null;
    const latest = saved?.instructionRevision === row.instruction_revision ? saved : null;
    const execution = db.prepare("SELECT state FROM sa_assignments WHERE ticket_id=? AND COALESCE(json_extract(payload,'$.instructionRevision'),1)=? AND state IN ('claimed','uncertain','queued','waiting') ORDER BY CASE state WHEN 'uncertain' THEN 0 WHEN 'claimed' THEN 1 WHEN 'waiting' THEN 2 ELSE 3 END LIMIT 1").get(row.id, row.instruction_revision);
    const pause = row.pause_reason ? parse(row.pause_reason) : null;
    const wait = row.continuation_wait ? parse(row.continuation_wait) : null;
    const progress = ({ open: '等待分派', assigned: '已分派', running: '执行中', waiting: '等待交付或答复', completed: '已完成', paused: '已暂停', pausing: '正在暂停', cancelled: '已取消', cancelling: '正在取消', failed: '执行失败', closed: '已关闭' })[row.status] || row.status;
    const active = ['open', 'assigned', 'running', 'waiting'].includes(row.status);
    const executionProgress = active ? ({ claimed: '执行中', uncertain: '等待核实执行状态', queued: '等待执行', waiting: '等待继续条件' })[execution?.state] : null;
    return { goal: row.target, progress: executionProgress || (typeof latest?.summary === 'string' ? latest.summary.slice(0, 600) : '') || progress,
      blocker: wait?.reason || wait?.code || pause?.reason || pause?.kind || (execution?.state === 'uncertain' ? '上次执行效果尚待核实' : '') || '', status: row.status, updatedAt: row.updated_at };
  }
  const assignmentValue = row => row && ({ id: row.id, ticketId: row.ticket_id, ...parse(row.payload), state: row.state, priority: row.priority, owner: row.owner, leaseUntil: row.lease_until, fence: row.fence, attempts: row.attempts, createdAt: row.created_at, updatedAt: row.updated_at });
  const subscriptionValue = row => row && ({ id: row.id, ticketId: row.ticket_id, threadId: row.thread_id, state: row.state, cursorSeq: row.cursor_seq, createdAt: row.created_at, updatedAt: row.updated_at });
  function createThread(input) {
    if (!record(input) || !record(input.source)) throw new Error('Thread requires a source');
    const sourceType = id(input.source.type, 'thread source type'), sourceId = id(input.source.id, 'thread source id');
    const existing = db.prepare('SELECT * FROM sa_threads WHERE source_type=? AND source_id=?').get(sourceType, sourceId);
    const threadId = input.id || createHash('sha256').update(json([sourceType, sourceId])).digest('hex');
    if (existing) {
      if (existing.id !== threadId) throw fail('THREAD_CONFLICT', 'Thread source is already bound to another id');
      return threadValue(existing);
    }
    const createdAt = input.createdAt || new Date().toISOString();
    db.prepare('INSERT INTO sa_threads VALUES (?,?,?,?,?)').run(threadId, sourceType, sourceId, json(input.metadata ?? {}), createdAt);
    return threadValue(threadRow(threadId));
  }
  function insertTicket(input, decisionId = null) {
    if (!record(input) || !record(input.mandate)) throw new Error('Ticket requires an immutable Mandate');
    const threadId = id(input.threadId, 'ticket threadId');
    if (!threadRow(threadId)) throw fail('THREAD_NOT_FOUND', 'Ticket thread does not exist');
    const ticketId = input.id || uuid(), now = input.createdAt || new Date().toISOString();
    const sourceTriggerIds = [...new Set(input.sourceTriggerIds || [])];
    for (const triggerId of sourceTriggerIds) {
      const row = triggerRow(id(triggerId, 'source trigger id'));
      if (!row || row.thread_id !== threadId) throw fail('TRIGGER_THREAD_MISMATCH', 'Ticket source trigger must belong to its thread');
      const existing = db.prepare('SELECT ticket_id FROM sa_ticket_triggers WHERE trigger_id=? LIMIT 1').get(triggerId);
      if (existing) throw Object.assign(fail('TRIGGER_ALREADY_ASSIGNED', 'A Trigger can open only one Ticket'), { ticketId: existing.ticket_id });
    }
    const target = String(input.target || ''), acceptance = input.acceptance ?? input.mandate.acceptance ?? target;
    if (typeof acceptance !== 'string') throw new Error('Ticket acceptance must be text');
    const mandate = { ...input.mandate, target, acceptance };
    db.prepare('INSERT INTO sa_tickets(id,thread_id,title,target,acceptance,status,mandate,created_by_decision,created_at,updated_at,result_version) VALUES (?,?,?,?,?,?,?,?,?,?,0)')
      .run(ticketId, threadId, normalizeTicketTitle(input.title, target), target, acceptance, input.status || 'open', json(mandate), decisionId, now, now);
    for (const triggerId of sourceTriggerIds) db.prepare('INSERT INTO sa_ticket_triggers VALUES (?,?)').run(ticketId, triggerId);
    if (input.adjustmentOfTicketId) db.prepare('UPDATE sa_tickets SET adjustment_of_ticket_id=? WHERE id=?').run(input.adjustmentOfTicketId, ticketId);
    return ticketValue(db.prepare('SELECT * FROM sa_tickets WHERE id=?').get(ticketId));
  }
  function expireEval(row, now) {
    const current = evalValue(row);
    db.prepare("UPDATE sa_evals SET status='timed_out',updated_at=? WHERE id=? AND status='running'").run(timestamp(now), current.id);
    for (const candidateId of current.candidateIds) {
      const candidate = db.prepare('SELECT * FROM sa_candidates WHERE id=?').get(candidateId);
      if (!candidate || candidate.status !== 'evaluating' || candidate.eval_id !== current.id) continue;
      if (candidate.retry_count < 2) db.prepare("UPDATE sa_candidates SET status='queued',eval_id=NULL,retry_count=retry_count+1,updated_at=? WHERE id=?").run(timestamp(now), candidateId);
      else db.prepare("UPDATE sa_candidates SET status='unavailable',eval_id=NULL,updated_at=? WHERE id=?").run(timestamp(now), candidateId);
    }
  }

  const api = {
    path,
    hasActiveExecution: () => !!db.prepare("SELECT 1 FROM sa_assignments WHERE state IN ('claimed','uncertain') LIMIT 1").get(),
    transaction: tx,
    createThread(input) { return tx(() => createThread(input)); },
    getThread(threadId) { return threadValue(threadRow(id(threadId, 'threadId'))); },
    ingest(input) {
      if (!record(input) || !record(input.thread) || !record(input.source) || !record(input.actor) || typeof input.content !== 'string') throw new Error('Trigger requires thread, source, actor and original content');
      id(input.dedupeKey, 'dedupeKey');
      const source = json(input.source), actor = json(input.actor);
      const contentHash = createHash('sha256').update(input.content).digest('hex');
      return tx(() => {
        const thread = createThread(input.thread);
        const existing = db.prepare('SELECT * FROM sa_triggers WHERE dedupe_key=?').get(input.dedupeKey);
        if (existing) {
          const previous = triggerValue(existing);
          if (previous.threadId !== thread.id || json(previous.source) !== source || json(previous.actor) !== actor || previous.content !== input.content) throw fail('TRIGGER_CONFLICT', 'An idempotency key cannot identify different trigger content');
          const candidate = db.prepare('SELECT * FROM sa_candidates WHERE trigger_id=? AND handback_ticket_id IS NULL ORDER BY rowid LIMIT 1').get(previous.id);
          return { trigger: previous, candidate: candidateValue(candidate), duplicate: true, requiresEval: Boolean(candidate) };
        }
        const triggerId = input.id || uuid(), createdAt = input.createdAt || new Date().toISOString();
        db.prepare('INSERT INTO sa_triggers(id,dedupe_key,thread_id,source,actor,content,content_hash,created_at) VALUES (?,?,?,?,?,?,?,?)')
          .run(triggerId, input.dedupeKey, thread.id, source, actor, input.content, contentHash, createdAt);
        if (input.intakeStage !== undefined && !['pending', 'admitted', 'rejected'].includes(input.intakeStage)) throw new Error('Invalid intake stage');
        if (input.intakeStage) db.prepare('UPDATE sa_triggers SET intake_stage=? WHERE id=?').run(input.intakeStage === 'pending' && input.gate?.allowed === false ? 'rejected' : input.intakeStage, triggerId);
        if (input.subscriptionEligible === true) db.prepare('UPDATE sa_triggers SET subscription_eligible=1 WHERE id=?').run(triggerId);
        db.prepare('INSERT INTO sa_trigger_admissions VALUES (?,?,?)').run(triggerId, input.policyVersion || null, json(input.gate || { allowed: false, strength: 'ignore' }));
        const trigger = triggerValue(triggerRow(triggerId));
        let candidate = null;
        const mode = input.mode || 'group';
        const subscribed = db.prepare("SELECT 1 FROM sa_subscriptions s JOIN sa_tickets t ON t.id=s.ticket_id WHERE s.thread_id=? AND s.state='active' AND t.status NOT IN ('completed','failed','closed','cancelled') LIMIT 1").get(thread.id);
        if (mode === 'group' && input.gate?.allowed === true && (!subscribed || input.gate.strength === 'explicit')) {
          id(input.policyVersion, 'policyVersion');
          const gate = { strength: input.gate.strength || 'ignore', reason: input.gate.reason || null, evidence: copy(input.gate.evidence ?? null) };
          const candidateId = uuid();
          db.prepare('INSERT INTO sa_candidates(id,trigger_id,thread_id,policy_version,gate,status,created_at,updated_at) VALUES (?,?,?,?,? ,\'queued\',?,?)')
            .run(candidateId, triggerId, thread.id, input.policyVersion, json(gate), createdAt, createdAt);
          candidate = candidateValue(db.prepare('SELECT * FROM sa_candidates WHERE id=?').get(candidateId));
        }
        return { trigger, candidate, duplicate: false, requiresEval: Boolean(candidate), direct: mode === 'direct' };
      });
    },
    getTrigger(triggerId) { const row = triggerRow(id(triggerId, 'triggerId')); return row?.intake_stage === 'admitted' ? triggerValue(row) : undefined; },
    readIntakeEvent(eventId) { return triggerValue(triggerRow(id(eventId, 'eventId'))); },
    sourceMessageSuperseded({ source, actor, createdAt }) {
      if (source?.channel !== 'feishu' || !source.appId || !source.chatId || actor?.kind !== 'human' || !actor.id) return false;
      const time = Date.parse(createdAt);
      if (!Number.isFinite(time)) return false;
      return !!db.prepare("SELECT 1 FROM sa_triggers WHERE json_extract(source,'$.channel')='feishu' AND json_extract(source,'$.appId')=? AND json_extract(source,'$.chatId')=? AND json_extract(actor,'$.kind')='human' AND json_extract(actor,'$.id')=? AND julianday(created_at)>julianday(?) LIMIT 1")
        .get(source.appId, source.chatId, actor.id, new Date(time + 300000).toISOString());
    },
    feishuContext(source) {
      if (source?.channel !== 'feishu') return [];
      const args = [id(source.appId), id(source.chatId)];
      const anchor = db.prepare("SELECT seq FROM sa_triggers WHERE json_extract(source,'$.channel')='feishu' AND json_extract(source,'$.appId')=? AND json_extract(source,'$.chatId')=? AND json_extract(source,'$.messageId')=? ORDER BY seq LIMIT 1").get(...args, id(source.messageId));
      if (!anchor) return [];
      return db.prepare("SELECT * FROM sa_triggers WHERE json_extract(source,'$.channel')='feishu' AND json_extract(source,'$.appId')=? AND json_extract(source,'$.chatId')=? AND seq<=? ORDER BY seq DESC LIMIT 20").all(...args, anchor.seq).reverse().map(row => {
        const trigger = triggerValue(row);
        return { messageId: trigger.source.messageId, text: trigger.content.slice(0, 4000), actor: trigger.actor, createdAt: trigger.createdAt };
      });
    },
    assessmentContext(triggerId) {
      const target = db.prepare('SELECT id,thread_id,seq FROM sa_triggers WHERE id=?').get(id(triggerId, 'triggerId'));
      if (!target) throw new Error('Assessment trigger is missing');
      const rows = new Map();
      for (const row of db.prepare('SELECT * FROM sa_triggers WHERE thread_id=? ORDER BY seq LIMIT 5').all(target.thread_id)) rows.set(row.id, row);
      for (const row of db.prepare('SELECT * FROM sa_triggers WHERE thread_id=? AND seq<=? ORDER BY seq DESC LIMIT 6').all(target.thread_id, target.seq)) rows.set(row.id, row);
      for (const row of db.prepare('SELECT * FROM sa_triggers WHERE thread_id=? AND seq>? ORDER BY seq LIMIT 5').all(target.thread_id, target.seq)) rows.set(row.id, row);
      const total = Number(db.prepare('SELECT COUNT(*) AS count FROM sa_triggers WHERE thread_id=?').get(target.thread_id).count);
      return { total, triggers: [...rows.values()].sort((a, b) => a.seq - b.seq).map(row => ({
        ...triggerValue(row),
        number: Number(db.prepare('SELECT COUNT(*) AS count FROM sa_triggers WHERE thread_id=? AND seq<=?').get(target.thread_id, row.seq).count),
      })) };
    },
    candidates({ threadId, status, limit = 100 } = {}) {
      const where = [], args = [];
      if (threadId) { where.push('thread_id=?'); args.push(id(threadId, 'threadId')); }
      if (status) { where.push('status=?'); args.push(id(status, 'candidate status')); }
      return db.prepare(`SELECT * FROM sa_candidates${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY created_at,rowid LIMIT ?`).all(...args, safeLimit(limit, 100, 1000)).map(candidateValue);
    },
    claimEval(threadId, { owner, policyVersion, now = Date.now(), timeoutMs = 120000, limit = 50 } = {}) {
      id(owner, 'eval owner'); id(policyVersion, 'policyVersion');
      if (!Number.isSafeInteger(now) || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid evaluation deadline');
      return tx(() => {
        const active = db.prepare("SELECT * FROM sa_evals WHERE thread_id=? AND status='running'").get(id(threadId, 'threadId'));
        if (active) {
          if (active.deadline > now) return active.owner === owner ? evalValue(active) : null;
          expireEval(active, now);
        }
        // Expired or policy-stale queued work is always re-evaluated under the requested current version.
        db.prepare("UPDATE sa_candidates SET policy_version=?,updated_at=? WHERE thread_id=? AND status='queued' AND policy_version<>?").run(policyVersion, timestamp(now), threadId, policyVersion);
        const candidates = db.prepare("SELECT * FROM sa_candidates WHERE thread_id=? AND status='queued' AND policy_version=? ORDER BY created_at,rowid LIMIT ?").all(threadId, policyVersion, safeLimit(limit, 50, 500));
        if (!candidates.length) return null;
        const evalId = uuid(), ids = candidates.map(row => row.id), attempt = 1 + Math.max(...candidates.map(row => row.retry_count));
        const deadline = now + timeoutMs, createdAt = timestamp(now);
        db.prepare('INSERT INTO sa_evals VALUES (?,?,?,?,?,?,?,?,?,?)').run(evalId, threadId, policyVersion, json(ids), owner, attempt, 'running', deadline, createdAt, createdAt);
        for (const candidateId of ids) db.prepare("UPDATE sa_candidates SET status='evaluating',eval_id=?,updated_at=? WHERE id=? AND status='queued'").run(evalId, createdAt, candidateId);
        return evalValue(db.prepare('SELECT * FROM sa_evals WHERE id=?').get(evalId));
      });
    },
    requeueExpiredEvals(now = Date.now()) {
      if (!Number.isSafeInteger(now)) throw new Error('Invalid clock');
      return tx(() => { const rows = db.prepare("SELECT * FROM sa_evals WHERE status='running' AND deadline<=? ORDER BY deadline").all(now); for (const row of rows) expireEval(row, now); return rows.length; });
    },
    invalidatePolicy(policyVersion, now = Date.now()) {
      id(policyVersion, 'policyVersion');
      return tx(() => {
        const rows = db.prepare("SELECT * FROM sa_evals WHERE status='running' AND policy_version<>?").all(policyVersion);
        for (const row of rows) {
          db.prepare("UPDATE sa_evals SET status='invalidated',updated_at=? WHERE id=?").run(timestamp(now), row.id);
          for (const candidateId of parse(row.candidate_ids)) db.prepare("UPDATE sa_candidates SET status='queued',eval_id=NULL,policy_version=?,updated_at=? WHERE id=? AND status='evaluating'").run(policyVersion, timestamp(now), candidateId);
        }
        db.prepare("UPDATE sa_candidates SET policy_version=?,updated_at=? WHERE status='queued' AND policy_version<>?").run(policyVersion, timestamp(now), policyVersion);
        return rows.length;
      });
    },
    getEval(evalId) { return evalValue(db.prepare('SELECT * FROM sa_evals WHERE id=?').get(id(evalId, 'evalId'))); },
    decide(candidateId, input) {
      id(candidateId, 'candidateId');
      const outcomes = new Set(['accept', 'attach', 'stop', 'ignore', 'notExplicit', 'revise', 'adjustment', 'answer', 'ask']);
      if (!record(input) || !outcomes.has(input.outcome) || !record(input.assessment)) throw new Error('Invalid Decision');
      id(input.policyVersion, 'policyVersion');
      id(input.evalId, 'evalId'); id(input.owner, 'eval owner');
      return tx(() => {
        const candidate = db.prepare('SELECT * FROM sa_candidates WHERE id=?').get(candidateId);
        if (!candidate) throw fail('CANDIDATE_NOT_FOUND', 'Candidate does not exist');
        if (candidate.status !== 'evaluating') throw fail('CANDIDATE_NOT_ACTIVE', 'Candidate is not in an active evaluation');
        if (candidate.policy_version !== input.policyVersion) throw fail('POLICY_STALE', 'Candidate must be re-evaluated under the current policy');
        const activeEval = db.prepare('SELECT * FROM sa_evals WHERE id=?').get(candidate.eval_id);
        if (candidate.eval_id !== input.evalId || activeEval?.owner !== input.owner) throw fail('EVAL_FENCING_CONFLICT', 'Decision belongs to a superseded evaluation or another owner');
        if (!activeEval || activeEval.status !== 'running' || activeEval.deadline <= (input.now ?? Date.now())) throw fail('EVAL_EXPIRED', 'Evaluation is no longer active');
        const gate = parse(candidate.gate);
        if (['attach', 'stop', 'revise', 'adjustment'].includes(input.outcome) && gate.strength !== 'explicit') throw fail('NOT_EXPLICIT', 'Controlling an existing Ticket requires an explicit owner instruction');
        if (input.outcome === 'accept' && gate.strength !== 'explicit' && (input.mode !== 'auto' || !Array.isArray(input.enabledRuleIds) || !Array.isArray(input.assessment.ruleIds) || !input.assessment.ruleIds.length || !input.assessment.ruleIds.every(rule => input.enabledRuleIds.includes(rule)))) throw fail('NOT_EXPLICIT', 'Inferred acceptance requires enabled rules in auto mode');
        if (db.prepare('SELECT id FROM sa_decisions WHERE candidate_id=?').get(candidateId)) throw fail('DECISION_EXISTS', 'Candidate already has a Decision');
        db.prepare('UPDATE sa_triggers SET intake_stage=? WHERE id=?').run(['ignore', 'notExplicit'].includes(input.outcome) ? 'rejected' : 'admitted', candidate.trigger_id);
        let ticket = null;
        if (input.outcome === 'accept') {
          if (!record(input.ticket) || !record(input.ticket.mandate)) throw new Error('Accepted Decision must atomically create a Ticket with Mandate');
          const decisionId = input.id || uuid();
          db.prepare('INSERT INTO sa_decisions VALUES (?,?,?,?,?,?,?,?)').run(decisionId, candidateId, candidate.thread_id, input.outcome, json(input.assessment), input.policyVersion, input.ticket.id || null, input.createdAt || new Date().toISOString());
          ticket = insertTicket({ ...input.ticket, threadId: candidate.thread_id, sourceTriggerIds: [...new Set([...(input.ticket.sourceTriggerIds || []), candidate.trigger_id])] }, decisionId);
          if (gate.strength === 'explicit') enqueueTicketAck({ db, ticket, trigger: triggerValue(db.prepare('SELECT * FROM sa_triggers WHERE id=?').get(candidate.trigger_id)), text: input.replyText, now: input.now ?? Date.now() });
          db.prepare('UPDATE sa_decisions SET ticket_id=? WHERE id=?').run(ticket.id, decisionId);
          db.prepare("UPDATE sa_candidates SET status='decided',updated_at=? WHERE id=?").run(new Date().toISOString(), candidateId);
          const evalRow = db.prepare('SELECT * FROM sa_evals WHERE id=?').get(candidate.eval_id);
          if (input.subscribe !== false) subscribeInternal(ticket.id, candidate.thread_id, candidate.trigger_id);
          thisFinishEval(evalRow);
          return { decision: decisionValue(db.prepare('SELECT * FROM sa_decisions WHERE id=?').get(decisionId)), ticket, candidate: candidateValue(db.prepare('SELECT * FROM sa_candidates WHERE id=?').get(candidateId)) };
        }
        let ticketId = null;
        if (['attach', 'stop', 'revise', 'adjustment'].includes(input.outcome)) {
          ticketId = id(input.ticketId, 'ticketId');
          const existingTicket = db.prepare('SELECT * FROM sa_tickets WHERE id=?').get(ticketId);
          if (!existingTicket) throw fail('TICKET_NOT_FOUND', 'Attached Ticket does not exist');
          if (existingTicket.thread_id !== candidate.thread_id) throw fail('TICKET_THREAD_MISMATCH', 'Decision cannot control a Ticket from another thread');
          const triggerOwner = db.prepare('SELECT ticket_id FROM sa_ticket_triggers WHERE trigger_id=? AND ticket_id<>? LIMIT 1').get(candidate.trigger_id, ticketId);
          if (triggerOwner) throw fail('TRIGGER_ALREADY_ASSIGNED', 'Decision cannot reassign another Ticket source Trigger');
          if (input.outcome === 'stop') {
            api.recordTicketInputInTransaction?.({ ticketId, triggerId: candidate.trigger_id, kind: 'stop', idempotencyKey: `trigger:${candidate.trigger_id}` });
            cancelTicketInternal(ticketId);
            api.applyTicketStopInputInTransaction?.(ticketId, candidate.trigger_id);
          }
          if (['revise', 'adjustment'].includes(input.outcome)) {
            const original = api.getTicket(ticketId), change = input.change;
            if (!record(change) || !record(change.mandate) || change.mandate.policyVersion !== input.policyVersion) throw fail('MANDATE_REVOKED', 'Changed Ticket requires current authorization');
            const mandate = { ...change.mandate, ...(change.mandate.project ? {} : original.mandate.project ? { project: original.mandate.project } : {}) };
            ticket = api.changeTicketInTransaction(ticketId, { operation: input.outcome, expectedInstructionRevision: change.expectedInstructionRevision,
              target: change.target ?? original.target, acceptance: change.acceptance ?? original.acceptance, reason: input.assessment.reason,
              requestKey: `decision-change:${candidateId}`, triggerId: candidate.trigger_id, mandate, model: change.model,
              validateMandate: value => value.policyVersion === input.policyVersion });
            ticketId = ticket.id;
            subscribeInternal(ticketId, candidate.thread_id, candidate.trigger_id);
            // The change Trigger is the new authorization, not a second inbox message.
            // Existing owned, unapplied context remains recorded for the new Worker.
            db.prepare('UPDATE sa_subscriptions SET cursor_seq=MAX(cursor_seq,?) WHERE ticket_id=? AND thread_id=?').run(triggerRow(candidate.trigger_id).seq, ticketId, candidate.thread_id);
          }
          db.prepare('INSERT OR IGNORE INTO sa_ticket_triggers VALUES (?,?)').run(ticketId, candidate.trigger_id);
          if (input.outcome === 'attach') subscribeInternal(ticketId, candidate.thread_id, candidate.trigger_id);
        }
        const decisionId = input.id || uuid();
        if (['answer', 'ask'].includes(input.outcome)) directReplyStore.enqueue(candidate, triggerRow(candidate.trigger_id), input);
        db.prepare('INSERT INTO sa_decisions VALUES (?,?,?,?,?,?,?,?)').run(decisionId, candidateId, candidate.thread_id, input.outcome, json(input.assessment), input.policyVersion, ticketId, input.createdAt || new Date().toISOString());
        db.prepare("UPDATE sa_candidates SET status='decided',updated_at=? WHERE id=?").run(new Date().toISOString(), candidateId);
        thisFinishEval(db.prepare('SELECT * FROM sa_evals WHERE id=?').get(candidate.eval_id));
        return { decision: decisionValue(db.prepare('SELECT * FROM sa_decisions WHERE id=?').get(decisionId)), ticket, candidate: candidateValue(db.prepare('SELECT * FROM sa_candidates WHERE id=?').get(candidateId)) };
      });
    },
    createTicket(input) { return tx(() => insertTicket(input)); },
    getTicket(ticketId) { return ticketValue(db.prepare('SELECT * FROM sa_tickets WHERE id=?').get(id(ticketId, 'ticketId'))); },
    cancelTicket(ticketId) {
      return tx(() => cancelTicketInternal(ticketId));
    },
    pauseTicket(ticketId, { reason = { kind: 'manual' } } = {}) {
      if (!record(reason) || reason.kind !== 'manual') throw fail('INVALID_PAUSE_REASON', 'Invalid pause reason');
      return tx(() => {
        const ticket = api.getTicket(ticketId);
        if (!ticket) throw fail('TICKET_NOT_FOUND', 'Ticket does not exist');
        if (['completed', 'failed', 'closed', 'cancelled', 'cancelling', 'paused'].includes(ticket.status)) return ticket;
        const pending = api.assignments(ticketId).some(row => ['claimed', 'uncertain'].includes(row.state));
        db.prepare('UPDATE sa_tickets SET status=?,pause_reason=?,updated_at=? WHERE id=?').run(pending ? 'pausing' : 'paused', json(reason), new Date().toISOString(), ticketId);
        return api.getTicket(ticketId);
      });
    },
    resumeTicket(ticketId) {
      return tx(() => {
        const ticket = api.getTicket(ticketId);
        if (!ticket) throw fail('TICKET_NOT_FOUND', 'Ticket does not exist');
        if (ticket.status === 'pausing') throw fail('PAUSE_PENDING', 'Execution has not reached its pause checkpoint');
        if (ticket.status !== 'paused') return ticket;
        const at = new Date().toISOString();
        for (const row of db.prepare("SELECT * FROM sa_assignments WHERE ticket_id=? AND state='paused'").all(ticketId)) {
          const run = api.runs(row.id).find(item => item.fence === row.fence && item.state === 'waiting' && item.evidence?.waitingPause);
          if (!run) throw fail('RUN_CONFLICT', 'Paused execution checkpoint is missing');
          const payload = { ...parse(row.payload), pauseContinuation: { runId: run.id } };
          delete payload.attentionContinuation;
          delete payload.contextContinuation;
          delete payload.verificationOnly;
          db.prepare("UPDATE sa_assignments SET state='queued',payload=?,updated_at=? WHERE id=?").run(json(payload), at, row.id);
        }
        const waiting = api.assignments(ticketId).some(row => row.state === 'waiting');
        db.prepare('UPDATE sa_tickets SET status=?,pause_reason=NULL,updated_at=? WHERE id=?').run(waiting ? 'waiting' : 'open', at, ticketId);
        return api.getTicket(ticketId);
      });
    },
    parkPause(assignmentId, { owner, fence, result, now = Date.now() }) {
      return tx(() => {
        const assignment = ownedAssignment(assignmentId, owner, fence, now), ticket = api.getTicket(assignment.ticket_id);
        if (ticket.status !== 'pausing') throw fail('PAUSE_CONFLICT', 'Ticket is not awaiting this pause');
        const run = api.runs(assignmentId).find(item => item.id === result.runId && item.fence === fence);
        if (!run || run.state !== 'verifying' || !result.waitingPause || !result.checkpoint || !result.transcript || JSON.stringify(run.evidence) !== JSON.stringify(result)) throw fail('RUN_CONFLICT', 'Pause requires saved execution evidence');
        const stopped = parse(assignment.payload).executionStopped;
        if (stopped?.owner !== owner || stopped?.fence !== fence) throw fail('PAUSE_PENDING', 'Execution cleanup is not confirmed');
        if (result.waitingExecutionBudget || result.waitingBudget) throw fail('PAUSE_CONFLICT', 'Budget pauses were removed on 2026-11-06');
        const at = timestamp(now);
        db.prepare("UPDATE sa_runs SET state='waiting',updated_at=? WHERE id=?").run(at, run.id);
        db.prepare("UPDATE sa_assignments SET state='paused',owner=NULL,lease_until=NULL,updated_at=? WHERE id=?").run(at, assignmentId);
        const pending = api.assignments(ticket.id).some(row => ['claimed', 'uncertain'].includes(row.state));
        db.prepare('UPDATE sa_tickets SET status=?,updated_at=? WHERE id=?').run(pending ? 'pausing' : 'paused', at, ticket.id);
        return api.getAssignment(assignmentId);
      });
    },
    /** Resumes a Ticket parked by the execution-time gate removed on 2026-11-06; no added time is required. */
    queueBudgetContinuation(ticketId, { expectedResultVersion, validateMandate, now = Date.now() } = {}) {
      if (typeof validateMandate !== 'function') throw new Error('Execution budget continuation requires current authorization');
      return tx(() => {
        const ticket = api.getTicket(ticketId), continuation = ticket?.continuationWait;
        if (!ticket || !Number.isSafeInteger(expectedResultVersion) || ticket.resultVersion !== expectedResultVersion
          || continuation?.sourceResultVersion !== expectedResultVersion) throw fail('REVIEW_CONFLICT', 'Execution budget wait version changed');
        const unavailable = code => ({ queued: false, code, ticket: api.getTicket(ticketId) });
        if (ticket.status !== 'waiting' || ticket.pauseReason?.kind !== 'execution-budget') return unavailable('TICKET_STOPPED');
        if (validateMandate(ticket.mandate, { ticketId, assignmentId: continuation.assignmentId }) !== true) return unavailable('MANDATE_REVOKED');
        const row = db.prepare('SELECT * FROM sa_assignments WHERE id=? AND ticket_id=?').get(continuation.assignmentId, ticketId);
        const run = row && api.runs(row.id).find(item => item.id === continuation.runId && item.fence === row.fence);
        const saved = run?.evidence, payload = row && parse(row.payload);
        if (!row || row.state !== 'waiting' || run?.state !== 'waiting' || run.sessionId !== continuation.sessionId
          || saved?.runId !== run.id || saved.sessionId !== run.sessionId || !saved.checkpoint || !saved.transcript
          || !saved.waitingPause || saved.waitingAttention || (payload.instructionRevision ?? 1) !== ticket.instructionRevision
          || saved.waitingExecutionBudget?.kind !== 'execution-time'
          || saved.waitingExecutionBudget.terminal?.kind !== 'aborted' || saved.waitingExecutionBudget.terminal.reason?.kind !== 'hook'
          || saved.waitingExecutionBudget.terminal.reason.reason !== 'benchgo-execution-budget-exhausted'
          || payload.stopRequest) return unavailable('EXECUTION_NOT_VERIFIED');
        if (payload.executionStopped?.owner !== run.owner || payload.executionStopped?.fence !== row.fence) return unavailable('EXECUTION_STOP_UNCONFIRMED');
        if (saved.waitingExecutionBudget.effectsVerified !== true || saved.executionEffects?.effectsVerified === false) return unavailable('EXECUTION_EFFECTS_UNKNOWN');
        payload.pauseContinuation = { runId: run.id, kind: 'execution-budget' };
        for (const key of ['attentionContinuation', 'contextContinuation', 'verificationOnly']) delete payload[key];
        db.prepare("UPDATE sa_assignments SET state='queued',owner=NULL,lease_until=NULL,payload=?,updated_at=? WHERE id=?")
          .run(json(payload), timestamp(now), row.id);
        db.prepare("UPDATE sa_tickets SET status='open',pause_reason=NULL,continuation_wait=NULL,updated_at=? WHERE id=?").run(timestamp(now), ticketId);
        return { queued: true, ticket: api.getTicket(ticketId), assignment: api.getAssignment(row.id) };
      });
    },
    confirmExecutionStopped(assignmentId, { owner, fence }) {
      return tx(() => {
        const row = db.prepare('SELECT * FROM sa_assignments WHERE id=?').get(assignmentId);
        if (!row) throw fail('ASSIGNMENT_NOT_FOUND', 'Assignment does not exist');
        const payload = parse(row.payload), request = payload.stopRequest;
        if (row.fence !== fence || (row.owner !== owner && request?.owner !== owner)) throw fail('FENCING_CONFLICT', 'Execution ownership changed');
        payload.executionStopped = { owner, fence, at: new Date().toISOString() };
        db.prepare('UPDATE sa_assignments SET payload=? WHERE id=?').run(json(payload), assignmentId);
        if (api.getTicket(row.ticket_id).status === 'cancelling') return cancelTicketInternal(row.ticket_id);
        return api.getTicket(row.ticket_id);
      });
    },
    listTickets({ threadId, status, projectId, ownerSessionId, ownerSessionIds, ownerThreadId, limit = 100, offset = 0, newestFirst = false } = {}) {
      const where = [], args = [];
      if (threadId) { where.push('thread_id=?'); args.push(id(threadId, 'threadId')); }
      if (status) { where.push('status=?'); args.push(id(status, 'ticket status')); }
      if (ownerSessionId !== undefined) { where.push("json_extract(mandate, '$.source.channel')='desktop' AND json_extract(mandate, '$.source.sessionId')=?"); args.push(id(ownerSessionId, 'ownerSessionId')); }
      if (ownerSessionIds !== undefined) {
        if (!Array.isArray(ownerSessionIds) || !ownerSessionIds.length || ownerSessionIds.length > 1000) throw new Error('Invalid owner session scope');
        const sessions = [...new Set(ownerSessionIds.map(value => id(value, 'ownerSessionIds')))];
        where.push(`json_extract(mandate, '$.source.channel')='desktop' AND json_extract(mandate, '$.source.sessionId') IN (${sessions.map(() => '?').join(',')})`);
        args.push(...sessions);
      }
      if (ownerThreadId !== undefined) { where.push("json_extract(mandate, '$.source.channel')='desktop' AND COALESCE(json_extract(mandate, '$.source.threadId'),'main')=?"); args.push(id(ownerThreadId, 'ownerThreadId')); }
      if (projectId) { where.push("json_extract(mandate, '$.project.id')=?"); args.push(id(projectId, 'projectId')); }
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid ticket offset');
      const order = newestFirst ? 'updated_at DESC,rowid DESC' : 'created_at,rowid';
      return db.prepare(`SELECT * FROM sa_tickets${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args, safeLimit(limit, 100, 1000), offset).map(ticketValue);
    },
    updateTicket(ticketId, patch, { expectedInstructionRevision } = {}) {
      if (!record(patch) || 'mandate' in patch || 'threadId' in patch || 'id' in patch) throw fail('MANDATE_IMMUTABLE', 'Mandate and Ticket identity are immutable');
      return tx(() => {
        const current = db.prepare('SELECT * FROM sa_tickets WHERE id=?').get(id(ticketId, 'ticketId'));
        if (!current) throw fail('TICKET_NOT_FOUND', 'Ticket does not exist');
        if (expectedInstructionRevision !== undefined && expectedInstructionRevision !== current.instruction_revision) throw fail('INSTRUCTION_REVISION_CONFLICT', 'Ticket requirements changed');
        const allowed = ['target', 'status', 'acceptance', 'title'];
        if (Object.keys(patch).some(key => !allowed.includes(key))) throw new Error('Unsupported Ticket field');
        for (const key of ['target', 'acceptance']) if (key in patch && typeof patch[key] !== 'string') throw new Error(`Ticket ${key} must be text`);
        const value = { ...ticketValue(current), ...copy(patch), updatedAt: new Date().toISOString() };
        const changed = value.target !== current.target || value.acceptance !== current.acceptance;
        db.prepare('UPDATE sa_tickets SET target=?,acceptance=?,instruction_revision=?,status=?,updated_at=? WHERE id=?').run(value.target, value.acceptance, current.instruction_revision + Number(changed), value.status, value.updatedAt, ticketId);
        if ('title' in patch) db.prepare('UPDATE sa_tickets SET title=? WHERE id=?').run(normalizeTicketTitle(patch.title, value.target), ticketId);
        return ticketValue(db.prepare('SELECT * FROM sa_tickets WHERE id=?').get(ticketId));
      });
    },
    getDecision(candidateId) { return decisionValue(db.prepare('SELECT * FROM sa_decisions WHERE candidate_id=?').get(id(candidateId, 'candidateId'))); },
    createAssignment(ticketId, input) {
      if (!record(input)) throw new Error('Assignment payload is required');
      return tx(() => {
        const ticket = db.prepare('SELECT * FROM sa_tickets WHERE id=?').get(id(ticketId, 'ticketId'));
        if (!ticket) throw fail('TICKET_NOT_FOUND', 'Assignment Ticket does not exist');
        const assignmentId = input.id || uuid(), now = new Date().toISOString(), priority = Number.isSafeInteger(input.priority) ? input.priority : 0;
        const payload = { ...copy(input), instructionRevision: input.instructionRevision ?? ticket.instruction_revision }; delete payload.id; delete payload.priority; delete payload.executionStopped; delete payload.stopRequest;
        const existing = db.prepare('SELECT * FROM sa_assignments WHERE id=?').get(assignmentId);
        if (existing) {
          if (existing.ticket_id !== ticketId || existing.payload !== json(payload) || existing.priority !== priority) throw fail('ASSIGNMENT_CONFLICT', 'Assignment identity already describes different work');
          return assignmentValue(existing);
        }
        if (['closed', 'cancelling', 'cancelled', 'completed', 'failed'].includes(ticket.status)) throw fail('TICKET_CLOSED', 'Closed Ticket cannot be assigned');
        if (payload.instructionRevision !== ticket.instruction_revision) throw fail('INSTRUCTION_REVISION_CONFLICT', 'Assignment requirements are stale');
        db.prepare('INSERT INTO sa_assignments(id,ticket_id,payload,state,priority,created_at,updated_at) VALUES (?,?,?,\'queued\',?,?,?)').run(assignmentId, ticketId, json(payload), priority, now, now);
        return assignmentValue(db.prepare('SELECT * FROM sa_assignments WHERE id=?').get(assignmentId));
      });
    },
    claimAssignments(owner, { limit = 1, leaseMs = 60000, now = Date.now(), validateMandate, assignmentId, includeReserved = false } = {}) {
      id(owner, 'assignment owner');
      if (typeof validateMandate !== 'function') throw new Error('Mechanical claim requires current Mandate validation');
      if (!Number.isSafeInteger(now) || !Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new Error('Invalid assignment lease');
      return tx(() => {
        const expired = db.prepare("SELECT * FROM sa_assignments WHERE state='claimed' AND lease_until<=?").all(now);
        // A missing heartbeat does not prove that an external action did not happen.
        for (const row of expired) {
          db.prepare("UPDATE sa_assignments SET state='uncertain',owner=NULL,lease_until=NULL,updated_at=? WHERE id=?").run(timestamp(now), row.id);
          db.prepare("UPDATE sa_runs SET state='uncertain',updated_at=? WHERE assignment_id=? AND fence=? AND state IN ('prepared','submitted','running','verifying')").run(timestamp(now), row.id, row.fence);
        }
        const filters = ["a.state='queued'", "t.status NOT IN ('closed','cancelling','cancelled','completed','failed','pausing','paused')"];
        const queryArgs = [];
        if (!includeReserved) filters.push("COALESCE(json_extract(a.payload,'$.executor'),'') NOT IN ('model-action','router-action')");
        if (assignmentId !== undefined) { filters.push('a.id=?'); queryArgs.push(id(assignmentId, 'assignmentId')); }
        const rows = db.prepare(`SELECT a.*,t.mandate FROM sa_assignments a JOIN sa_tickets t ON t.id=a.ticket_id WHERE ${filters.join(' AND ')} ORDER BY a.priority DESC,a.created_at,a.id LIMIT ?`).all(...queryArgs, safeLimit(limit, 1, 100));
        const claimed = [];
        for (let row of rows) {
          api.applyQueuedTicketRevisionInTransaction?.(row.id, { now });
          row = { ...row, ...db.prepare('SELECT * FROM sa_assignments WHERE id=?').get(row.id) };
          if (parse(row.payload).retiredExecution) continue;
          const mandate = api.getTicket(row.ticket_id).mandate;
          if ((parse(row.payload).instructionRevision ?? 1) !== api.getTicket(row.ticket_id).instructionRevision || validateMandate(copy(mandate), { ticketId: row.ticket_id, assignmentId: row.id }) !== true) {
            db.prepare("UPDATE sa_assignments SET state='blocked',updated_at=? WHERE id=?").run(timestamp(now), row.id);
            continue;
          }
          const fence = row.fence + 1;
          const payload = parse(row.payload);
          if (payload.attentionContinuation || payload.pauseContinuation || payload.contextContinuation) {
            const continuation = payload.contextContinuation || payload.pauseContinuation || payload.attentionContinuation;
            const run = db.prepare('SELECT * FROM sa_runs WHERE id=? AND assignment_id=? AND fence=?').get(continuation.runId, row.id, row.fence);
            const saved = run && parse(run.payload).evidence;
            const currentTicket = api.getTicket(row.ticket_id);
            const ready = payload.contextContinuation
              ? ['verifying', 'uncertain'].includes(run?.state) && saved?.checkpoint && !saved.waitingPause && !saved.waitingAttention
              : run?.state === 'waiting' && (payload.pauseContinuation ? saved?.waitingPause : saved?.waitingAttention)
                && (!payload.pauseContinuation || !saved?.waitingExecutionBudget || saved.waitingExecutionBudget.effectsVerified === true);
            if (!ready) {
              db.prepare('UPDATE sa_assignments SET state=?,updated_at=? WHERE id=?').run('blocked', timestamp(now), row.id);
              continue;
            }
            db.prepare("UPDATE sa_runs SET fence=?,owner=?,state='prepared',updated_at=? WHERE id=?").run(fence, owner, timestamp(now), run.id);
          }
          if (payload.verificationOnly) {
            const run = db.prepare('SELECT * FROM sa_runs WHERE id=? AND assignment_id=? AND fence=?').get(payload.verificationOnly.runId, row.id, row.fence);
            if (!run || !['verifying', 'uncertain'].includes(run.state) || !parse(run.payload).evidence) {
              db.prepare("UPDATE sa_assignments SET state='blocked',updated_at=? WHERE id=?").run(timestamp(now), row.id);
              continue;
            }
            const runPayload = parse(run.payload);
            // Transfer verification ownership, retaining the original execution identity.
            runPayload.executionFence ??= run.fence;
            runPayload.executionOwner ??= run.owner;
            db.prepare("UPDATE sa_runs SET fence=?,owner=?,state='verifying',payload=?,updated_at=? WHERE id=?").run(fence, owner, json(runPayload), timestamp(now), run.id);
          }
          db.prepare("UPDATE sa_assignments SET state='claimed',owner=?,lease_until=?,fence=?,attempts=attempts+1,updated_at=? WHERE id=? AND state='queued'").run(owner, now + leaseMs, fence, timestamp(now), row.id);
          claimed.push(assignmentValue(db.prepare('SELECT * FROM sa_assignments WHERE id=?').get(row.id)));
        }
        return claimed;
      });
    },
    reconcileAssignment(assignmentId, { fence, outcome, evidence, now = Date.now() } = {}) {
      if (!['notExecuted', 'completed', 'cancelled'].includes(outcome) || typeof evidence !== 'string' || !evidence.trim()) throw new Error('Reconciliation requires an observed outcome and evidence');
      return tx(() => {
        const row = db.prepare('SELECT * FROM sa_assignments WHERE id=?').get(id(assignmentId, 'assignmentId'));
        if (!row || row.state !== 'uncertain' || row.fence !== fence) throw fail('FENCING_CONFLICT', 'Assignment is not awaiting this reconciliation');
        const payload = parse(row.payload);
        payload.reconciliations = [...(payload.reconciliations || []), { fence, outcome, evidence, at: timestamp(now) }];
        db.prepare('UPDATE sa_assignments SET state=?,payload=?,updated_at=? WHERE id=?').run(outcome === 'notExecuted' ? 'queued' : outcome, json(payload), timestamp(now), assignmentId);
        if (api.getTicket(row.ticket_id).status === 'cancelling') cancelTicketInternal(row.ticket_id);
        return assignmentValue(db.prepare('SELECT * FROM sa_assignments WHERE id=?').get(assignmentId));
      });
    },
    pauseRecoveryCandidates({ now = Date.now(), limit = 20 } = {}) {
      return db.prepare(`SELECT a.id FROM sa_assignments a JOIN sa_runs r ON r.assignment_id=a.id AND r.fence=a.fence
        JOIN sa_tickets t ON t.id=a.ticket_id
        WHERE t.status='pausing' AND (a.state='uncertain' OR (a.state='claimed' AND a.lease_until<=?))
        AND r.state IN ('verifying','uncertain') AND json_extract(r.payload,'$.evidence.waitingPause')=1
        AND COALESCE(json_extract(a.payload,'$.pauseRecoveryAfter'),0)<=?
        ORDER BY a.updated_at,a.id LIMIT ?`).all(now, now, safeLimit(limit, 20, 100)).map(row => {
          const assignment = api.getAssignment(row.id);
          return { assignment, run: api.runs(row.id).find(run => run.fence === assignment.fence) };
        });
    },
    deferPauseRecovery(assignmentId, { fence, now = Date.now() }) {
      return tx(() => {
        const row = db.prepare('SELECT * FROM sa_assignments WHERE id=?').get(assignmentId);
        if (!row || row.fence !== fence) return;
        const payload = parse(row.payload);
        payload.pauseRecoveryAttempts = (payload.pauseRecoveryAttempts || 0) + 1;
        payload.pauseRecoveryAfter = now + Math.min(300000, 5000 * 2 ** Math.min(payload.pauseRecoveryAttempts, 6));
        db.prepare('UPDATE sa_assignments SET payload=? WHERE id=?').run(json(payload), assignmentId);
      });
    },
    recoverParkPause(assignmentId, { fence, runId, observation, now = Date.now() }) {
      return tx(() => {
        const row = db.prepare('SELECT * FROM sa_assignments WHERE id=?').get(assignmentId);
        if (!row || row.fence !== fence || !['claimed', 'uncertain'].includes(row.state) || (row.state === 'claimed' && row.lease_until > now)) throw fail('FENCING_CONFLICT', 'Pause ownership is not expired');
        const ticket = api.getTicket(row.ticket_id), payload = parse(row.payload);
        const run = api.runs(row.id).find(item => item.id === runId && item.fence === fence);
        if (ticket.status !== 'pausing' || !run?.evidence?.waitingPause
          || !['verifying', 'uncertain'].includes(run.state) || observation?.paused !== true || observation.sessionId !== run.sessionId
          || observation.hash !== run.evidence.transcript?.hash || observation.lastSeq !== run.evidence.transcript?.lastSeq) throw fail('PAUSE_CONFLICT', 'Saved pause evidence changed');
        const at = timestamp(now);
        payload.executionStopped = { owner: run.owner, fence, at, recovered: true };
        db.prepare("UPDATE sa_assignments SET state='paused',owner=NULL,lease_until=NULL,payload=?,updated_at=? WHERE id=?").run(json(payload), at, row.id);
        db.prepare("UPDATE sa_runs SET state='waiting',updated_at=? WHERE id=?").run(at, run.id);
        const pending = api.assignments(ticket.id).some(item => ['claimed','uncertain'].includes(item.state));
        db.prepare('UPDATE sa_tickets SET status=?,updated_at=? WHERE id=?').run(pending ? 'pausing' : 'paused', at, ticket.id);
        return api.getAssignment(row.id);
      });
    },
    verificationCandidates({ limit = 20, now = Date.now() } = {}) {
      return db.prepare(`SELECT a.id FROM sa_assignments a JOIN sa_runs r ON r.assignment_id=a.id AND r.fence=a.fence
        JOIN sa_tickets t ON t.id=a.ticket_id
        WHERE a.state='uncertain' AND r.state IN ('verifying','uncertain') AND t.status='open'
        AND json_extract(r.payload,'$.evidence.summary') IS NOT NULL
        AND json_type(r.payload,'$.evidence.transcript.hash')='text'
        AND (json_type(r.payload,'$.environment') IS NULL OR json_type(r.payload,'$.evidence.checkpoint.manifestHash')='text')
        AND json_type(a.payload,'$.retiredExecution') IS NULL
        AND COALESCE(json_extract(a.payload,'$.verificationAfter'),0)<=?
        ORDER BY a.updated_at,a.id LIMIT ?`).all(now, safeLimit(limit, 20, 100)).map(row => {
          const assignment = api.getAssignment(row.id);
          return { assignment, ticket: api.getTicket(assignment.ticketId), run: api.runs(row.id).find(run => run.fence === assignment.fence) };
        });
    },
    deferVerification(assignmentId, { fence, reason = 'EVIDENCE_UNVERIFIED', now = Date.now() } = {}) {
      return tx(() => {
        const row = db.prepare("SELECT * FROM sa_assignments WHERE id=? AND fence=? AND state='uncertain'").get(id(assignmentId), fence);
        if (!row) return false;
        const payload = parse(row.payload);
        payload.verificationInspectionAttempts = (payload.verificationInspectionAttempts || 0) + 1;
        payload.verificationAfter = now + Math.min(900000, 30000 * 2 ** Math.min(payload.verificationInspectionAttempts - 1, 5));
        payload.verificationError = String(reason).slice(0, 160);
        db.prepare('UPDATE sa_assignments SET payload=?,updated_at=? WHERE id=?').run(json(payload), timestamp(now), assignmentId);
        return true;
      });
    },
    recordAssignmentFailure(assignmentId, { owner, fence, stage, code, phase, now = Date.now() } = {}) {
      return tx(() => {
        const row = db.prepare("SELECT * FROM sa_assignments WHERE id=? AND fence=? AND state IN ('claimed','uncertain')").get(id(assignmentId), fence);
        if (!row) return false;
        const previous = parse(row.payload);
        const runOwner = db.prepare('SELECT owner FROM sa_runs WHERE assignment_id=? AND fence=?').get(assignmentId, fence)?.owner;
        if (row.owner !== owner && previous.revokedOwner !== owner && runOwner !== owner) return false;
        const safeCodes = ['AUXILIARY_QUALITY', 'NO_ADAPTER', 'RATE_LIMIT', 'HTTP', 'NETWORK', 'TIMEOUT', 'ABORTED', 'FENCING_CONFLICT', 'MANDATE_REVOKED', 'EXECUTION_PAUSE_UNVERIFIED', 'EXECUTION_EFFECTS_UNKNOWN', 'WORKER_SELF_CHECK', 'WORKER_TURN_INCOMPLETE'];
        const safePhases = ['setup', 'resume', 'create', 'submit', 'attention-answer', 'completion', 'evidence'];
        const payload = { ...parse(row.payload), lastFailure: { stage: stage === 'result' ? 'result' : 'execution',
          code: safeCodes.includes(code) ? code : 'UNAVAILABLE', ...(stage !== 'result' && safePhases.includes(phase) ? { phase } : {}), at: timestamp(now) } };
        db.prepare('UPDATE sa_assignments SET payload=?,updated_at=? WHERE id=?').run(json(payload), timestamp(now), assignmentId);
        const ticket = api.getTicket(row.ticket_id), uniqueKey = `assignment-system-state:${assignmentId}:${fence}:${payload.lastFailure.stage}`;
        const publication = systemStateDelivery({ state: 'continuation_wait',
          code: payload.lastFailure.code, stage: payload.lastFailure.stage });
        db.prepare("INSERT OR IGNORE INTO sa_outbox(id,unique_key,ticket_id,payload,state,attempts,next_at,created_at,updated_at) VALUES (?,?,?,?,'queued',0,?,?,?)")
          .run(uuid(), uniqueKey, ticket.id, json({ type: 'ticket.result', ticketId: ticket.id, source: ticket.mandate.source,
            instructionRevision: ticket.instructionRevision, resultVersion: ticket.resultVersion,
            publication, text: publication.text }), now, timestamp(now), timestamp(now));
        return true;
      });
    },
    queueVerification(assignmentId, { fence, runId, observation, validateMandate, ownerRetry = false, now = Date.now() } = {}) {
      if (typeof validateMandate !== 'function' || !record(observation) || observation.sessionId === undefined || observation.completed !== true) throw new Error('Verification requires observed completion and current authorization');
      return tx(() => {
        const row = db.prepare('SELECT * FROM sa_assignments WHERE id=?').get(id(assignmentId));
        const run = db.prepare('SELECT * FROM sa_runs WHERE id=? AND assignment_id=? AND fence=?').get(id(runId), assignmentId, fence);
        if (!row || row.fence !== fence || row.state !== 'uncertain' || !run || !['verifying', 'uncertain'].includes(run.state)) throw fail('FENCING_CONFLICT', 'Execution is not awaiting verification recovery');
        const ticket = api.getTicket(row.ticket_id), payload = parse(row.payload), saved = parse(run.payload);
        if ((payload.instructionRevision ?? 1) !== ticket.instructionRevision) throw fail('INSTRUCTION_REVISION_CONFLICT', 'Verification requirements are stale');
        if (ticket.status !== 'open' || validateMandate(ticket.mandate) !== true) throw fail('MANDATE_REVOKED', 'Current Ticket authority does not permit verification');
        if (!ownerRetry && (payload.verificationAfter || 0) > now) throw fail('RECOVERY_LIMIT', 'Automatic verification recovery is backing off');
        if (!saved.evidence || saved.sessionId !== observation.sessionId || saved.evidence.runId !== runId || saved.evidence.sessionId !== saved.sessionId
          || saved.evidence.transcript?.hash !== observation.hash || saved.evidence.transcript?.lastSeq !== observation.lastSeq) throw fail('RUN_CONFLICT', 'Observation does not match persisted execution evidence');
        if (api.pendingSubscriptionMessages(ticket.id, { limit: 1 }).length) {
          if (ownerRetry) throw fail('UNAPPLIED_CONTEXT', 'Evidence-only recovery cannot execute pending context');
          if (!saved.evidence.checkpoint || saved.evidence.waitingPause || saved.evidence.waitingAttention) throw fail('UNAPPLIED_CONTEXT', 'Safe context continuation evidence is unavailable');
          payload.contextContinuation = { runId, observation: copy(observation) };
          delete payload.verificationOnly;
        } else {
          payload.verificationOnly = { runId, observation: copy(observation) };
          delete payload.contextContinuation;
        }
        delete payload.attentionContinuation;
        delete payload.pauseContinuation;
        payload.verificationAttempts = (payload.verificationAttempts || 0) + 1;
        payload.verificationAfter = now + Math.min(900000, 30000 * 2 ** Math.min(payload.verificationAttempts - 1, 5));
        db.prepare("UPDATE sa_assignments SET state='queued',payload=?,updated_at=? WHERE id=?").run(json(payload), timestamp(now), assignmentId);
        return api.getAssignment(assignmentId);
      });
    },
    renewAssignment(assignmentId, { owner, fence, validateMandate, leaseMs = 60000, now = Date.now() } = {}) {
      if (typeof validateMandate !== 'function' || !Number.isSafeInteger(leaseMs) || leaseMs <= 0 || !Number.isSafeInteger(now)) throw new Error('Renewal requires current Mandate validation and a valid lease');
      return tx(() => {
        const row = db.prepare('SELECT a.*,t.mandate,t.status AS ticket_status FROM sa_assignments a JOIN sa_tickets t ON t.id=a.ticket_id WHERE a.id=?').get(id(assignmentId, 'assignmentId'));
        if (!row || row.state !== 'claimed' || row.owner !== owner || row.fence !== fence || row.lease_until <= now) throw fail('FENCING_CONFLICT', 'Assignment lease is no longer owned');
        const permitted = !['closed', 'cancelling', 'cancelled', 'completed', 'failed'].includes(row.ticket_status) && validateMandate(api.getTicket(row.ticket_id).mandate, { ticketId: row.ticket_id, assignmentId }) === true;
        if (!permitted) {
          const payload = { ...parse(row.payload), revokedOwner: owner };
          db.prepare("UPDATE sa_assignments SET state='uncertain',owner=NULL,lease_until=NULL,payload=?,updated_at=? WHERE id=?").run(json(payload), timestamp(now), assignmentId);
          return { allowed: false, assignment: assignmentValue(db.prepare('SELECT * FROM sa_assignments WHERE id=?').get(assignmentId)) };
        }
        db.prepare('UPDATE sa_assignments SET lease_until=?,updated_at=? WHERE id=?').run(now + leaseMs, timestamp(now), assignmentId);
        return { allowed: true, assignment: assignmentValue(db.prepare('SELECT * FROM sa_assignments WHERE id=?').get(assignmentId)) };
      });
    },
    finishAssignment(assignmentId, { owner, fence, status = 'completed', now = Date.now() } = {}) {
      if (!['completed', 'failed', 'cancelled', 'queued'].includes(status)) throw new Error('Invalid Assignment terminal state');
      return tx(() => {
        const row = db.prepare('SELECT * FROM sa_assignments WHERE id=?').get(id(assignmentId, 'assignmentId'));
        if (!row) throw fail('ASSIGNMENT_NOT_FOUND', 'Assignment does not exist');
        if (row.state !== 'claimed' || row.owner !== owner || row.fence !== fence || row.lease_until <= now) throw fail('FENCING_CONFLICT', 'Assignment lease is no longer owned');
        db.prepare('UPDATE sa_assignments SET state=?,owner=NULL,lease_until=NULL,updated_at=? WHERE id=?').run(status === 'queued' ? 'queued' : status, new Date().toISOString(), assignmentId);
        return assignmentValue(db.prepare('SELECT * FROM sa_assignments WHERE id=?').get(assignmentId));
      });
    },
    assignments(ticketId) { return db.prepare('SELECT * FROM sa_assignments WHERE ticket_id=? ORDER BY created_at,rowid').all(id(ticketId, 'ticketId')).map(assignmentValue); },
    getAssignment(assignmentId) { return assignmentValue(db.prepare('SELECT * FROM sa_assignments WHERE id=?').get(id(assignmentId))); },
    runs(assignmentId) {
      return db.prepare('SELECT * FROM sa_runs WHERE assignment_id=? ORDER BY created_at,rowid').all(id(assignmentId)).map(runValue);
    },
    prepareRun(assignmentId, { owner, fence, sessionId, directory, now = Date.now() } = {}) {
      id(sessionId, 'run session'); id(directory, 'run directory');
      return tx(() => {
        ownedAssignment(assignmentId, owner, fence, now);
        const previous = db.prepare('SELECT * FROM sa_runs WHERE assignment_id=? AND fence=?').get(assignmentId, fence);
        if (previous) {
          const value = runValue(previous);
          if (value.sessionId !== sessionId || value.directory !== directory) throw fail('RUN_CONFLICT', 'Run identity cannot change');
          return value;
        }
        const runId = uuid(), at = timestamp(now);
        db.prepare('INSERT INTO sa_runs VALUES (?,?,?,?,?,?,?,?)').run(runId, assignmentId, fence, owner, 'prepared', json({ sessionId, directory }), at, at);
        return runValue(db.prepare('SELECT * FROM sa_runs WHERE id=?').get(runId));
      });
    },
    setRunEnvironment(runId, { owner, fence, environment, now = Date.now() } = {}) {
      if (!record(environment) || !environment.path || !environment.branch || !environment.baseCommit || !environment.repositoryRoot) throw new Error('Complete worktree environment is required');
      return tx(() => {
        const row = db.prepare('SELECT * FROM sa_runs WHERE id=?').get(id(runId));
        if (!row) throw fail('RUN_NOT_FOUND', 'Run does not exist');
        ownedAssignment(row.assignment_id, owner, fence, now);
        if (row.owner !== owner || row.fence !== fence) throw fail('FENCING_CONFLICT', 'Run belongs to another execution');
        const payload = parse(row.payload);
        if (row.state !== 'prepared' || payload.environment) throw fail('RUN_CONFLICT', 'Execution environment cannot change');
        payload.environment = copy(environment);
        payload.directory = environment.path;
        db.prepare('UPDATE sa_runs SET payload=?,updated_at=? WHERE id=?').run(json(payload), timestamp(now), runId);
        return runValue(db.prepare('SELECT * FROM sa_runs WHERE id=?').get(runId));
      });
    },
    updateRun(runId, { owner, fence, state, evidence, now = Date.now() } = {}) {
      const transitions = { prepared: ['submitted', 'cancelled'], submitted: ['running', 'verifying', 'uncertain'], running: ['verifying', 'uncertain'], verifying: ['completed', 'failed', 'uncertain'], uncertain: [], completed: [], failed: [], cancelled: [] };
      return tx(() => {
        const row = db.prepare('SELECT * FROM sa_runs WHERE id=?').get(id(runId));
        if (!row) throw fail('RUN_NOT_FOUND', 'Run does not exist');
        ownedAssignment(row.assignment_id, owner, fence, now);
        if (row.owner !== owner || row.fence !== fence) throw fail('FENCING_CONFLICT', 'Run belongs to another execution');
        if (!transitions[row.state]?.includes(state)) throw fail('RUN_TRANSITION', 'Invalid execution transition');
        if (['verifying', 'completed', 'failed'].includes(state) && !record(evidence)) throw new Error('Observed execution evidence is required');
        const payload = { ...parse(row.payload), ...(evidence ? { evidence: copy(evidence) } : {}) };
        db.prepare('UPDATE sa_runs SET state=?,payload=?,updated_at=? WHERE id=?').run(state, json(payload), timestamp(now), runId);
        return runValue(db.prepare('SELECT * FROM sa_runs WHERE id=?').get(runId));
      });
    },
    subscribe(ticketId, threadId, { cursorTriggerId, beforeTriggerId } = {}) { return tx(() => subscribeInternal(id(ticketId, 'ticketId'), id(threadId, 'threadId'), cursorTriggerId, beforeTriggerId)); },
    subscriptions({ ticketId, threadId, state = 'active' } = {}) {
      const where = [], args = [];
      if (ticketId) { where.push('ticket_id=?'); args.push(id(ticketId, 'ticketId')); }
      if (threadId) { where.push('thread_id=?'); args.push(id(threadId, 'threadId')); }
      if (state) { where.push('state=?'); args.push(state); }
      return db.prepare(`SELECT * FROM sa_subscriptions${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY created_at,id`).all(...args).map(subscriptionValue);
    },
    deliverSubscribedMessage(triggerId, { ticketId } = {}) {
      return tx(() => {
        const trigger = triggerRow(id(triggerId, 'triggerId'));
        if (!trigger) throw fail('TRIGGER_NOT_FOUND', 'Trigger does not exist');
        const existing = db.prepare('SELECT * FROM sa_message_ownership WHERE trigger_id=?').get(triggerId);
        if (existing) {
          if (ticketId && existing.ticket_id !== ticketId) throw fail('MESSAGE_OWNERSHIP_CONFLICT', 'Trigger already belongs to another Ticket');
          return { triggerId, ticketId: existing.ticket_id, subscriptionId: existing.subscription_id, cursor: existing.cursor_seq, duplicate: true, contextOnly: true };
        }
        let rows = db.prepare("SELECT * FROM sa_subscriptions WHERE thread_id=? AND state='active' ORDER BY created_at,id").all(trigger.thread_id);
        if (ticketId) rows = rows.filter(row => row.ticket_id === ticketId);
        if (!rows.length) return null;
        if (rows.length !== 1) throw fail('AMBIGUOUS_SUBSCRIPTION', 'Select the Ticket that owns this thread message');
        const subscription = rows[0];
        if (trigger.seq <= subscription.cursor_seq) throw fail('SUBSCRIPTION_CURSOR', 'Trigger is not newer than the subscription cursor');
        db.prepare("UPDATE sa_triggers SET intake_stage='admitted' WHERE id=?").run(triggerId);
        const now = new Date().toISOString();
        db.prepare('INSERT INTO sa_message_ownership VALUES (?,?,?,?,?)').run(triggerId, subscription.id, subscription.ticket_id, trigger.seq, now);
        api.recordTicketInputInTransaction?.({ ticketId: subscription.ticket_id, triggerId, kind: 'context', idempotencyKey: `trigger:${triggerId}` });
        db.prepare('UPDATE sa_subscriptions SET cursor_seq=?,updated_at=? WHERE id=?').run(trigger.seq, now, subscription.id);
        db.prepare('INSERT OR IGNORE INTO sa_ticket_triggers VALUES (?,?)').run(subscription.ticket_id, triggerId);
        return { triggerId, ticketId: subscription.ticket_id, subscriptionId: subscription.id, cursor: trigger.seq, deliveredAt: now, duplicate: false, contextOnly: true };
      });
    },
    subscriptionMessages(subscriptionId, { afterCursor = 0, limit = 100 } = {}) {
      id(subscriptionId, 'subscriptionId');
      const sub = db.prepare('SELECT * FROM sa_subscriptions WHERE id=?').get(subscriptionId);
      if (!sub) throw fail('SUBSCRIPTION_NOT_FOUND', 'Subscription does not exist');
      const cursor = Number.isSafeInteger(afterCursor) && afterCursor >= 0 ? afterCursor : sub.cursor_seq;
      return db.prepare('SELECT t.* FROM sa_message_ownership o JOIN sa_triggers t ON t.id=o.trigger_id WHERE o.subscription_id=? AND o.cursor_seq>? ORDER BY o.cursor_seq LIMIT ?').all(subscriptionId, cursor, safeLimit(limit, 100, 1000)).map(triggerValue);
    },
    pendingSubscriptionMessages(ticketId, { limit = 100 } = {}) {
      return db.prepare(`SELECT t.* FROM sa_message_ownership o JOIN sa_triggers t ON t.id=o.trigger_id
        LEFT JOIN sa_subscription_applied a ON a.trigger_id=o.trigger_id
        LEFT JOIN sa_handbacks h ON h.trigger_id=o.trigger_id AND h.ticket_id=o.ticket_id
        WHERE o.ticket_id=? AND a.trigger_id IS NULL AND h.trigger_id IS NULL ORDER BY t.seq LIMIT ?`)
        .all(id(ticketId), safeLimit(limit, 100, 1000)).map(triggerValue);
    },
    acknowledgeSubscriptionMessage(assignmentId, { owner, fence, triggerId, sessionId, messageId, now = Date.now() } = {}) {
      id(triggerId); id(sessionId); id(messageId);
      return tx(() => {
        const assignment = ownedAssignment(assignmentId, owner, fence, now);
        const ownership = db.prepare('SELECT * FROM sa_message_ownership WHERE trigger_id=? AND ticket_id=?').get(triggerId, assignment.ticket_id);
        if (!ownership) throw fail('MESSAGE_OWNERSHIP_CONFLICT', 'Message does not belong to the executing Ticket');
        const run = db.prepare('SELECT * FROM sa_runs WHERE assignment_id=? AND fence=?').get(assignmentId, fence);
        if (!run || parse(run.payload).sessionId !== sessionId) throw fail('RUN_CONFLICT', 'Message receipt belongs to another session');
        const old = db.prepare('SELECT * FROM sa_subscription_applied WHERE trigger_id=?').get(triggerId);
        if (old && (old.session_id !== sessionId || old.message_id !== messageId)) throw fail('MESSAGE_RECEIPT_CONFLICT', 'Message already has another application receipt');
        db.prepare('INSERT OR IGNORE INTO sa_subscription_applied VALUES (?,?,?,?,?)').run(triggerId, assignmentId, sessionId, messageId, timestamp(now));
        api.applyTicketInputInTransaction?.(triggerId, { assignmentId, owner, fence, runId: run.id, boundaryId: `message:${messageId}`, sessionId, messageId });
        return { triggerId, applied: true, sessionId, messageId };
      });
    },
    handback(ticketId, triggerId, { policyVersion, reason } = {}) {
      id(policyVersion, 'policyVersion');
      return tx(() => {
        const ticket = db.prepare('SELECT * FROM sa_tickets WHERE id=?').get(id(ticketId, 'ticketId'));
        const trigger = triggerRow(id(triggerId, 'triggerId'));
        if (!ticket || !trigger) throw fail('HAND_BACK_SOURCE_NOT_FOUND', 'Ticket or Trigger does not exist');
        const known = db.prepare('SELECT 1 FROM sa_ticket_triggers WHERE ticket_id=? AND trigger_id=?').get(ticketId, triggerId)
          || db.prepare('SELECT 1 FROM sa_message_ownership WHERE ticket_id=? AND trigger_id=?').get(ticketId, triggerId);
        if (!known) throw fail('HAND_BACK_UNRELATED', 'Trigger is not part of this Ticket context');
        const prior = db.prepare('SELECT * FROM sa_handbacks WHERE ticket_id=? AND trigger_id=?').get(ticketId, triggerId);
        if (prior) return candidateValue(db.prepare('SELECT * FROM sa_candidates WHERE id=?').get(prior.candidate_id));
        const admission = db.prepare('SELECT gate FROM sa_trigger_admissions WHERE trigger_id=?').get(triggerId)
          || db.prepare('SELECT gate FROM sa_candidates WHERE trigger_id=? AND handback_ticket_id IS NULL ORDER BY rowid LIMIT 1').get(triggerId);
        const originalGate = admission ? parse(admission.gate) : { allowed: false, strength: 'ignore', reason: 'historical-admission-unverified' };
        const candidateId = uuid(), now = new Date().toISOString();
        db.prepare("INSERT INTO sa_candidates(id,trigger_id,thread_id,policy_version,gate,status,handback_ticket_id,created_at,updated_at) VALUES (?,?,?,?,?,'queued',?,?,?)")
          .run(candidateId, triggerId, ticket.thread_id, policyVersion, json({ ...originalGate, strength: originalGate.allowed === false ? 'ignore' : originalGate.strength || 'ignore', originalReason: originalGate.reason, reason: 'worker-handback', detail: reason || null }), ticketId, now, now);
        db.prepare('INSERT INTO sa_handbacks VALUES (?,?,?,?)').run(ticketId, triggerId, candidateId, now);
        return candidateValue(db.prepare('SELECT * FROM sa_candidates WHERE id=?').get(candidateId));
      });
    },
    commitResult(ticketId, { result, status = 'waiting', uniqueKey, outboxPayload, assignment, instructionRevision, now = Date.now() } = {}) {
      id(uniqueKey, 'result uniqueKey');
      if (!record(result) || !['completed', 'waiting', 'failed'].includes(status)) throw new Error('Invalid result commit');
      return tx(() => {
        const ticket = api.getTicket(ticketId);
        if (!ticket) throw fail('TICKET_NOT_FOUND', 'Ticket does not exist');
        const fingerprint = createHash('sha256').update(json({ result, status, outboxPayload })).digest('hex');
        const prior = db.prepare("SELECT payload FROM sa_results WHERE ticket_id=? AND json_extract(payload,'$.commitKey')=? ORDER BY version DESC LIMIT 1").get(ticketId, uniqueKey);
        if (prior) {
          const saved = parse(prior.payload);
          if (saved.commitFingerprint !== fingerprint) throw fail('OUTBOX_CONFLICT', 'Result idempotency key has different content');
          return { ticket, result: saved, outbox: parseOutbox(db.prepare('SELECT * FROM sa_outbox WHERE unique_key=?').get(uniqueKey)), duplicate: true };
        }
        const resultRevision = result.instructionRevision ?? instructionRevision ?? assignment?.instructionRevision ?? 1;
        if (resultRevision !== ticket.instructionRevision) throw fail('INSTRUCTION_REVISION_CONFLICT', 'Result requirements are stale');
        if (api.pendingSubscriptionMessages(ticketId, { limit: 1 }).length) throw fail('UNAPPLIED_CONTEXT', 'Ticket still has unapplied source messages');
        if (['cancelling', 'cancelled', 'closed', 'completed', 'failed'].includes(ticket.status)) throw fail('TICKET_CLOSED', 'Ticket no longer accepts results');
        const at = timestamp(now), version = ticket.resultVersion + 1;
        if (assignment) {
          const claimed = ownedAssignment(assignment.id, assignment.owner, assignment.fence, now);
          if (claimed.ticket_id !== ticketId || (parse(claimed.payload).instructionRevision ?? 1) !== ticket.instructionRevision) throw fail('ASSIGNMENT_CONFLICT', 'Result assignment changed');
          if (result.runId) {
            const run = api.runs(assignment.id).find(row => row.id === result.runId && row.fence === assignment.fence);
            if (!run || run.sessionId !== result.sessionId || run.state !== 'verifying') throw fail('RUN_CONFLICT', 'Result execution identity changed');
          }
          db.prepare("UPDATE sa_assignments SET state='completed',owner=NULL,lease_until=NULL,updated_at=? WHERE id=?").run(at, assignment.id);
          db.prepare("UPDATE sa_runs SET state='completed',updated_at=? WHERE assignment_id=? AND fence=? AND state='verifying'").run(at, assignment.id, assignment.fence);
        }
        const committed = { ...copy(result), outcome: result.outcome || (status === 'failed' ? 'failed' : 'completed'), ticketId, instructionRevision: resultRevision, version, committedAt: at, commitKey: uniqueKey, commitFingerprint: fingerprint };
        db.prepare('INSERT INTO sa_results VALUES (?,?,?,?)').run(ticketId, version, json(committed), at);
        // Execution completion and source receipt are distinct facts.
        db.prepare("UPDATE sa_tickets SET status=?,result_version=?,continuation_wait=NULL,updated_at=? WHERE id=?")
          .run(['pausing', 'paused'].includes(ticket.status) ? 'paused' : 'waiting', version, at, ticketId);
        const payload = outboxPayload ?? { type: 'ticket.result', ticketId, source: ticket.mandate.source, instructionRevision: resultRevision, resultVersion: version,
          outcome: result.outcome || (status === 'failed' ? 'failed' : 'completed'), text: result.finalSummary ?? result.summary,
          publication: result.delivery || { action: 'deliver', origin: 'worker', text: result.finalSummary ?? result.summary } };
        const outboxId = uuid();
        db.prepare("INSERT INTO sa_outbox(id,unique_key,ticket_id,payload,state,attempts,next_at,created_at,updated_at) VALUES (?,?,?,?,'queued',0,?,?,?)")
          .run(outboxId, uniqueKey, ticketId, json(payload), now, at, at);
        return { ticket: api.getTicket(ticketId), result: committed, outbox: parseOutbox(db.prepare('SELECT * FROM sa_outbox WHERE id=?').get(outboxId)), duplicate: false };
      });
    },
    results(ticketId) { return db.prepare('SELECT payload FROM sa_results WHERE ticket_id=? ORDER BY version').all(id(ticketId, 'ticketId')).map(row => parse(row.payload)); },
    claimOutbox(owner, { limit = 20, leaseMs = 30000, now = Date.now() } = {}) {
      id(owner, 'outbox owner');
      return tx(() => {
        db.prepare("UPDATE sa_outbox SET state='uncertain',owner=NULL,lease_until=NULL,updated_at=? WHERE state='claimed' AND lease_until<=?").run(timestamp(now), now);
        const rows = db.prepare("SELECT * FROM sa_outbox WHERE state='queued' AND next_at<=? AND (ticket_id NOT IN (SELECT id FROM sa_tickets WHERE status IN ('pausing','paused')) OR (json_extract(payload,'$.publication.origin')='system' AND json_extract(payload,'$.publication.systemState.stage')='execution')) ORDER BY created_at,id LIMIT ?").all(now, safeLimit(limit, 20, 200));
        for (const row of rows) db.prepare("UPDATE sa_outbox SET state='claimed',owner=?,lease_until=?,attempts=attempts+1,updated_at=? WHERE id=?").run(owner, now + leaseMs, timestamp(now), row.id);
        return rows.map(row => parseOutbox(db.prepare('SELECT * FROM sa_outbox WHERE id=?').get(row.id)));
      });
    },
    finishOutbox(outboxId, { owner, sent = false, uncertain = false, receipt, error = null, retryMs = 5000, now = Date.now() } = {}) {
      return tx(() => {
        const row = db.prepare('SELECT * FROM sa_outbox WHERE id=?').get(id(outboxId, 'outboxId'));
        if (!row) throw fail('OUTBOX_NOT_FOUND', 'Outbox entry does not exist');
        if (row.state !== 'claimed' || row.owner !== owner || row.lease_until <= now) throw fail('OUTBOX_LEASE_CONFLICT', 'Outbox lease is no longer owned');
        const sentAt = sent ? timestamp(now) : null;
        db.prepare('UPDATE sa_outbox SET state=?,owner=NULL,lease_until=NULL,sent_at=?,last_error=?,next_at=?,updated_at=? WHERE id=?')
          .run(sent ? 'sent' : uncertain ? 'uncertain' : 'queued', sentAt, sent ? null : String(error || 'delivery-failed').slice(0, 1000), sent ? row.next_at : now + Math.max(0, retryMs), timestamp(now), outboxId);
        if (receipt !== undefined) {
          if (!record(receipt)) throw new Error('Delivery receipt must be an object');
          db.prepare('INSERT OR REPLACE INTO sa_delivery_receipts VALUES (?,?)').run(outboxId, json(receipt));
        }
        if (sent) closeDeliveredTicket(row, receipt, now);
        return parseOutbox(db.prepare('SELECT * FROM sa_outbox WHERE id=?').get(outboxId));
      });
    },
    reconcileOutbox(outboxId, { attempts, outcome, evidence, receipt, now = Date.now() } = {}) {
      if (!Number.isSafeInteger(attempts) || attempts < 1 || !['sent', 'not_sent', 'unknown'].includes(outcome)
        || typeof evidence !== 'string' || !evidence.trim() || evidence.length > 2000) throw fail('INVALID_RECONCILIATION', '核实需要当前发送次数、结论与证据');
      if (outcome === 'sent' ? !record(receipt) || receipt.status !== 'accepted' || typeof receipt.messageId !== 'string'
        || !receipt.messageId.trim() || receipt.messageId.length > 512 : receipt !== undefined) throw fail('INVALID_RECONCILIATION', '已发送结论需要确定消息回执');
      return tx(() => {
        const row = db.prepare('SELECT * FROM sa_outbox WHERE id=?').get(id(outboxId, 'outboxId'));
        if (!row) throw fail('OUTBOX_NOT_FOUND', 'Outbox entry does not exist');
        if (row.state !== 'uncertain' || row.attempts !== attempts) throw fail('OUTBOX_RECONCILIATION_CONFLICT', '发送状态已变化，请刷新后核实');
        const previous = db.prepare('SELECT payload FROM sa_delivery_receipts WHERE outbox_id=?').get(outboxId);
        const priorReceipt = previous ? parse(previous.payload) : null;
        if (outcome === 'not_sent' && priorReceipt?.parts?.length) throw fail('OUTBOX_RECONCILIATION_CONFLICT', '已有成功分片，不能重投整条消息');
        const at = timestamp(now);
        const reconciliation = { attempts, outcome, evidence: evidence.trim(), at };
        db.prepare('INSERT INTO sa_outbox_reconciliations(outbox_id,payload) VALUES (?,?)').run(outboxId, json(reconciliation));
        db.prepare('UPDATE sa_outbox SET state=?,owner=NULL,lease_until=NULL,sent_at=?,last_error=?,next_at=?,updated_at=? WHERE id=?')
          .run(outcome === 'sent' ? 'sent' : outcome === 'not_sent' ? 'queued' : 'uncertain', outcome === 'sent' ? at : null,
            outcome === 'sent' ? null : outcome === 'not_sent' ? 'confirmed-not-sent' : 'delivery-outcome-unknown',
            outcome === 'not_sent' ? now : row.next_at, at, outboxId);
        if (receipt) db.prepare('INSERT OR REPLACE INTO sa_delivery_receipts VALUES (?,?)')
          .run(outboxId, json({ ...receipt, ...(priorReceipt?.parts ? { parts: priorReceipt.parts } : {}), reconciliation }));
        if (outcome === 'sent') closeDeliveredTicket(row, receipt, now);
        return parseOutbox(db.prepare('SELECT * FROM sa_outbox WHERE id=?').get(outboxId));
      });
    },
    pendingOutbox(now = Date.now(), limit = 100) { return db.prepare("SELECT * FROM sa_outbox WHERE state='queued' AND next_at<=? ORDER BY created_at,id LIMIT ?").all(now, safeLimit(limit, 100, 1000)).map(parseOutbox); },
    deliveries(ticketId) { return db.prepare('SELECT * FROM sa_outbox WHERE ticket_id=? ORDER BY created_at,id').all(id(ticketId)).map(parseOutbox); },
    close() { if (!closed) { closed = true; db.close(); } },
  };

  function closeDeliveredTicket(row, receipt, now) {
    const payload = parse(row.payload), ticket = api.getTicket(row.ticket_id);
    if (receipt?.status !== 'accepted' || typeof receipt.messageId !== 'string' || !receipt.messageId.trim()
      || payload.type !== 'ticket.result' || payload.publication?.origin !== 'worker'
      || !['completed', 'failed'].includes(payload.outcome) || !ticket || ticket.status !== 'waiting'
      || payload.resultVersion !== ticket.resultVersion || payload.instructionRevision !== ticket.instructionRevision
      || json(payload.source) !== json(ticket.mandate.source)) return;
    const result = api.results(ticket.id).at(-1);
    if (result?.outcome !== payload.outcome || result.version !== payload.resultVersion) return;
    db.prepare('UPDATE sa_tickets SET status=?,updated_at=? WHERE id=?').run(payload.outcome, timestamp(now), ticket.id);
    db.prepare("UPDATE sa_subscriptions SET state='closed',updated_at=? WHERE ticket_id=?").run(timestamp(now), ticket.id);
    api.recordClosedTicket?.(ticket.id, { closedAt: timestamp(now), inTransaction: true });
  }

  function thisFinishEval(row) {
    if (!row || row.status !== 'running') return;
    const candidateIds = parse(row.candidate_ids);
    const stillActive = candidateIds.some(candidateId => db.prepare("SELECT 1 FROM sa_candidates WHERE id=? AND status='evaluating'").get(candidateId));
    if (!stillActive) {
      db.prepare("UPDATE sa_evals SET status='completed',updated_at=? WHERE id=? AND status='running'").run(new Date().toISOString(), row.id);
      const subscriptions = db.prepare("SELECT * FROM sa_subscriptions WHERE thread_id=? AND state='active'").all(row.thread_id);
      if (subscriptions.length === 1) {
        const source = db.prepare(`SELECT MIN(t.seq) AS seq FROM sa_decisions d
          JOIN sa_candidates c ON c.id=d.candidate_id JOIN sa_triggers t ON t.id=c.trigger_id
          WHERE c.eval_id=? AND d.ticket_id=? AND d.outcome IN ('accept','attach')`).get(row.id, subscriptions[0].ticket_id);
        if (source.seq !== null) reconcileSubscription(subscriptions[0].id, row.thread_id, source.seq);
      }
    }
  }
  function ownedAssignment(assignmentId, owner, fence, now) {
    const row = db.prepare('SELECT * FROM sa_assignments WHERE id=?').get(id(assignmentId));
    if (!row || row.state !== 'claimed' || row.owner !== owner || row.fence !== fence || row.lease_until <= now) throw fail('FENCING_CONFLICT', 'Assignment lease is no longer owned');
    return row;
  }
  function cancelTicketInternal(ticketId) {
    const ticket = db.prepare('SELECT * FROM sa_tickets WHERE id=?').get(id(ticketId));
    if (!ticket) throw fail('TICKET_NOT_FOUND', 'Ticket does not exist');
    if (['completed', 'failed', 'closed', 'cancelled'].includes(ticket.status)) return ticketValue(ticket);
    const at = new Date().toISOString();
    let pending = false;
    for (const row of db.prepare('SELECT * FROM sa_assignments WHERE ticket_id=?').all(ticketId)) {
      if (['completed', 'failed', 'cancelled'].includes(row.state)) continue;
      const payload = parse(row.payload);
      const unknown = ['claimed', 'uncertain'].includes(row.state);
      const verification = payload.verificationOnly;
      const verifyRun = verification && db.prepare('SELECT * FROM sa_runs WHERE id=? AND assignment_id=? AND fence=?').get(verification.runId, row.id, row.fence);
      const saved = verifyRun && parse(verifyRun.payload), observation = verification?.observation;
      // A verification lease cannot restart the original executor. Its saved
      // observation and release must both identify that exact original run.
      const verificationStopped = saved && Number.isSafeInteger(saved.executionFence) && typeof saved.executionOwner === 'string'
        && typeof saved.evidence?.transcript?.hash === 'string' && Number.isSafeInteger(saved.evidence?.transcript?.lastSeq)
        && observation?.completed === true && observation.sessionId === saved.sessionId
        && observation.hash === saved.evidence?.transcript?.hash && observation.lastSeq === saved.evidence?.transcript?.lastSeq
        && payload.executionStopped?.fence === saved.executionFence && payload.executionStopped?.owner === saved.executionOwner;
      const stopped = payload.executionStopped?.fence === row.fence || verificationStopped;
      const waiting = unknown && !stopped;
      if (waiting) {
        pending = true;
        payload.stopRequest ||= { owner: row.owner || db.prepare('SELECT owner FROM sa_runs WHERE assignment_id=? AND fence=? ORDER BY rowid DESC LIMIT 1').get(row.id, row.fence)?.owner || null, fence: row.fence, at };
      }
      if (verificationStopped) payload.verificationCancelled = { runId: verifyRun.id, fence: row.fence, at };
      db.prepare('UPDATE sa_assignments SET state=?,owner=NULL,lease_until=NULL,payload=?,updated_at=? WHERE id=?')
        .run(waiting ? 'uncertain' : 'cancelled', json(payload), at, row.id);
    }
    db.prepare('UPDATE sa_tickets SET status=?,updated_at=? WHERE id=?').run(pending ? 'cancelling' : 'cancelled', at, ticketId);
    cancelWaitingAttention(ticketId, at);
    db.prepare("UPDATE sa_runs SET state='uncertain',updated_at=? WHERE assignment_id IN (SELECT id FROM sa_assignments WHERE ticket_id=?) AND state IN ('prepared','submitted','running','verifying')").run(at, ticketId);
    // Cancellation becomes final only for the executor whose release was confirmed.
    db.prepare(`UPDATE sa_runs SET state='cancelled',updated_at=? WHERE state='uncertain'
      AND EXISTS (SELECT 1 FROM sa_assignments a WHERE a.id=sa_runs.assignment_id AND a.ticket_id=?
        AND a.fence=sa_runs.fence AND ((json_extract(a.payload,'$.executionStopped.fence')=sa_runs.fence
        AND json_extract(a.payload,'$.executionStopped.owner')=sa_runs.owner)
        OR (json_extract(a.payload,'$.verificationCancelled.runId')=sa_runs.id
        AND json_extract(a.payload,'$.verificationCancelled.fence')=sa_runs.fence)))`).run(at, ticketId);
    db.prepare("UPDATE sa_subscriptions SET state='closed',updated_at=? WHERE ticket_id=?").run(at, ticketId);
    return ticketValue(db.prepare('SELECT * FROM sa_tickets WHERE id=?').get(ticketId));
  }
  function cancelWaitingAttention(ticketId, at) {
    db.prepare("UPDATE sa_runs SET state='cancelled',updated_at=? WHERE assignment_id IN (SELECT id FROM sa_assignments WHERE ticket_id=?) AND state='waiting'").run(at, ticketId);
    db.prepare("UPDATE sa_outbox SET state='cancelled',updated_at=? WHERE ticket_id=? AND state='queued' AND json_extract(payload,'$.type')='ticket.attention'").run(at, ticketId);
  }
  function runValue(row) {
    return row && { ...parse(row.payload), id: row.id, assignmentId: row.assignment_id, fence: row.fence, owner: row.owner, state: row.state, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  function subscribeInternal(ticketId, threadId, cursorTriggerId, beforeTriggerId) {
    const ticket = db.prepare('SELECT * FROM sa_tickets WHERE id=?').get(ticketId);
    if (!ticket) throw fail('TICKET_NOT_FOUND', 'Subscription Ticket does not exist');
    const thread = threadRow(threadId);
    if (!thread) throw fail('THREAD_NOT_FOUND', 'Subscription Thread does not exist');
    if (cursorTriggerId && beforeTriggerId) throw fail('SUBSCRIPTION_CURSOR', 'Subscription requires one cursor boundary');
    const boundary = cursorTriggerId || beforeTriggerId;
    const trigger = boundary ? triggerRow(id(boundary, 'cursor triggerId')) : undefined;
    const cursor = boundary ? trigger?.seq - Number(Boolean(beforeTriggerId)) : Number(db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM sa_triggers WHERE thread_id=?').get(threadId).seq);
    if (!Number.isSafeInteger(cursor) || cursor < 0 || (boundary && trigger?.thread_id !== threadId)) throw fail('SUBSCRIPTION_CURSOR', 'Subscription cursor Trigger must belong to the Thread');
    const now = new Date().toISOString(), existing = db.prepare('SELECT * FROM sa_subscriptions WHERE ticket_id=? AND thread_id=?').get(ticketId, threadId);
    if (existing) {
      if (existing.state === 'active') return subscriptionValue(existing);
      const nextCursor = Math.max(cursor, existing.cursor_seq);
      db.prepare("UPDATE sa_subscriptions SET state='active',cursor_seq=?,updated_at=? WHERE id=?").run(nextCursor, now, existing.id);
      reconcileSubscription(existing.id, threadId, nextCursor);
      return subscriptionValue(db.prepare('SELECT * FROM sa_subscriptions WHERE id=?').get(existing.id));
    }
    const subscriptionId = uuid();
    db.prepare('INSERT INTO sa_subscriptions VALUES (?,?,?,\'active\',?,?,?)').run(subscriptionId, ticketId, threadId, cursor, now, now);
    reconcileSubscription(subscriptionId, threadId, cursor);
    return subscriptionValue(db.prepare('SELECT * FROM sa_subscriptions WHERE id=?').get(subscriptionId));
  }
  function reconcileSubscription(subscriptionId, threadId, cursor) {
    // Only an unambiguous subscription may collect context received while Eval ran.
    // Existing Candidates retain their decision path; context never grants authority.
    const active = db.prepare("SELECT * FROM sa_subscriptions WHERE thread_id=? AND state='active'").all(threadId);
    if (active.length !== 1 || active[0].id !== subscriptionId) return;
    if (db.prepare("SELECT 1 FROM sa_candidates WHERE thread_id=? AND status='evaluating' LIMIT 1").get(threadId)) return;
    const subscription = active[0], now = new Date().toISOString();
    const messages = db.prepare(`SELECT t.id,t.seq FROM sa_triggers t WHERE t.thread_id=? AND t.seq>? AND t.subscription_eligible=1
      AND NOT EXISTS (SELECT 1 FROM sa_candidates c WHERE c.trigger_id=t.id)
      AND NOT EXISTS (SELECT 1 FROM sa_ticket_triggers tt WHERE tt.trigger_id=t.id)
      AND NOT EXISTS (SELECT 1 FROM sa_message_ownership o WHERE o.trigger_id=t.id)
      ORDER BY t.seq`).all(threadId, cursor);
    for (const message of messages) {
      db.prepare("UPDATE sa_triggers SET intake_stage='admitted' WHERE id=?").run(message.id);
      db.prepare('INSERT INTO sa_message_ownership VALUES (?,?,?,?,?)').run(message.id, subscriptionId, subscription.ticket_id, message.seq, now);
      api.recordTicketInputInTransaction?.({ ticketId: subscription.ticket_id, triggerId: message.id, kind: 'context', idempotencyKey: `trigger:${message.id}` });
      db.prepare('INSERT INTO sa_ticket_triggers VALUES (?,?)').run(subscription.ticket_id, message.id);
    }
    if (messages.length) db.prepare('UPDATE sa_subscriptions SET cursor_seq=MAX(cursor_seq,?),updated_at=? WHERE id=?').run(messages.at(-1).seq, now, subscriptionId);
  }
  function parseOutbox(row) { return row && ({ receipt: parse(db.prepare('SELECT payload FROM sa_delivery_receipts WHERE outbox_id=?').get(row.id)?.payload || 'null'), reconciliations: db.prepare('SELECT payload FROM sa_outbox_reconciliations WHERE outbox_id=? ORDER BY seq').all(row.id).map(entry => parse(entry.payload)), id: row.id, uniqueKey: row.unique_key, ticketId: row.ticket_id, payload: parse(row.payload), state: row.state, attempts: row.attempts, nextAt: row.next_at, owner: row.owner, leaseUntil: row.lease_until, sentAt: row.sent_at, lastError: row.last_error, createdAt: row.created_at }); }

  Object.assign(api, installAttentionStore({ db, tx, api, ownedAssignment }));
  Object.assign(api, installGoalBudgetStore({ db, tx }));
  Object.assign(api, installEvalDispositionStore({ db, tx, api }));
  Object.assign(api, installDesktopTicketStore({ db, tx, api, insertTicket }));
  Object.assign(api, installTicketRevisions({ db, tx, api, insertTicket }));
  Object.assign(api, installRouterActionStore({ db, tx, api, insertTicket }));
  const directReplyStore = installDirectReplyStore({ db, tx });
  Object.assign(api, directReplyStore.api);
  Object.assign(api, installWorkerExecutionStore({ db, tx, api }));
  Object.assign(api, installRouterQuestionStore({ db, tx, api }));
  retireContentReview({ db, tx });
  Object.assign(api, installLearningSourceStore({ db, tx, api }));
  return api;
}
