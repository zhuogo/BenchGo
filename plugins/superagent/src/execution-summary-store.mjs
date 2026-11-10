import { randomUUID } from 'node:crypto';
import { redactExecutionText } from './execution-summary-input.mjs';

const id = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const safeCode = value => typeof value === 'string' && /^[A-Z0-9_:-]{1,100}$/i.test(value) ? value : 'UNKNOWN';
const decode = row => row ? JSON.parse(row.payload) : null;
function binding(value) {
  if (!id(value.ticketId) || !id(value.runId) || !integer(value.instructionRevision) || !integer(value.watermark)) throw new Error('Invalid execution summary binding');
  return { ticketId: value.ticketId, runId: value.runId, instructionRevision: value.instructionRevision, watermark: value.watermark };
}
function safeRouting(value) {
  if (!value) return undefined;
  return { configRevision: integer(value.configRevision) ? value.configRevision : null,
    routePolicy: value.routePolicy === 'auxiliary-only' ? value.routePolicy : 'unknown',
    attempts: (value.attempts || []).slice(0, 30).map(row => ({ providerId: id(row.providerId) ? row.providerId : '', modelId: id(row.modelId) ? row.modelId : '',
      status: ['running', 'failed', 'completed'].includes(row.status) ? row.status : 'unknown', code: row.code ? safeCode(row.code) : undefined, retry: integer(row.retry) ? row.retry : 0 })) };
}

/** Additive derived projection/audit on the existing assistant.db connection. */
export function installExecutionSummaryStore({ db, tx = callback => callback() }) {
  db.exec(`CREATE TABLE IF NOT EXISTS sa_execution_summaries(ticket_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sa_auxiliary_activity(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,kind TEXT NOT NULL,
      ticket_id TEXT NOT NULL,run_id TEXT NOT NULL,instruction_revision INTEGER NOT NULL,payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS sa_auxiliary_activity_binding ON sa_auxiliary_activity(kind,ticket_id,run_id,instruction_revision,seq);
    CREATE TABLE IF NOT EXISTS sa_execution_summary_meta(key TEXT PRIMARY KEY,value INTEGER NOT NULL);`);
  const get = ticketId => decode(db.prepare('SELECT payload FROM sa_execution_summaries WHERE ticket_id=?').get(ticketId));
  const put = row => db.prepare('INSERT INTO sa_execution_summaries VALUES (?,?) ON CONFLICT(ticket_id) DO UPDATE SET payload=excluded.payload').run(row.ticketId, JSON.stringify(row));
  return {
    executionSummary: get,
    pendingExecutionSummaries: () => db.prepare("SELECT payload FROM sa_execution_summaries WHERE json_extract(payload,'$.pendingWatermark') IS NOT NULL").all().map(decode),
    markExecutionSummaryPending(ticketId, watermark) {
      const row = get(ticketId);
      if (row && integer(watermark)) put({ ...row, pendingWatermark: Math.max(row.pendingWatermark ?? 0, watermark) });
    },
    executionSummaryCursor: () => db.prepare("SELECT value FROM sa_execution_summary_meta WHERE key='cursor'").get()?.value || 0,
    advanceExecutionSummaryCursor(cursor) {
      if (!integer(cursor)) throw new Error('Invalid summary cursor');
      db.prepare("INSERT INTO sa_execution_summary_meta VALUES ('cursor',?) ON CONFLICT(key) DO UPDATE SET value=MAX(value,excluded.value)").run(cursor);
    },
    observeExecutionSummary(value) {
      const nextBinding = binding(value);
      return tx(() => {
        const previous = get(value.ticketId);
        if (previous && (previous.instructionRevision > value.instructionRevision || previous.watermark > value.watermark)) return previous;
        const compatible = previous?.runId === value.runId && previous.instructionRevision === value.instructionRevision && previous.phase === value.phase;
        const row = { ...nextBinding, phase: safeCode(value.phase), text: compatible ? previous.text : redactExecutionText(value.text, 80),
          source: compatible ? previous.source : 'deterministic', summaryWatermark: compatible ? previous.summaryWatermark : value.watermark,
          generatedAt: compatible ? previous.generatedAt : value.observedAt, degraded: compatible ? previous.degraded : false,
          pendingWatermark: previous?.pendingWatermark,
          code: compatible ? previous.code : undefined };
        put(row); return row;
      });
    },
    publishExecutionSummary(value) {
      binding(value);
      return tx(() => {
        const current = get(value.ticketId);
        if (!current || current.runId !== value.runId || current.instructionRevision !== value.instructionRevision || current.phase !== value.phase
          || value.watermark > current.watermark || value.watermark < current.summaryWatermark) return { published: false, reason: 'STALE_BINDING' };
        const row = { ...current, text: redactExecutionText(value.text, 80), source: value.source === 'model' ? 'model' : 'deterministic',
          summaryWatermark: value.watermark, generatedAt: value.generatedAt, degraded: value.degraded === true, code: value.code ? safeCode(value.code) : undefined,
          pendingWatermark: current.pendingWatermark > value.watermark ? current.pendingWatermark : undefined };
        put(row); return { published: true, summary: row };
      });
    },
    recordAuxiliaryActivity(value) {
      const b = binding(value);
      const result = value.result && { status: safeCode(value.result.status), code: value.result.code ? safeCode(value.result.code) : undefined,
        hits: integer(value.result.hits) ? value.result.hits : 0, signalEligible: value.result.signalEligible === true,
        classification: ['no-progress', 'off-target', 'waiting', 'insufficient-evidence'].includes(value.result.classification) ? value.result.classification : undefined,
        outputRelevance: ['relevant', 'irrelevant'].includes(value.result.outputRelevance) ? value.result.outputRelevance : 'unknown',
        reason: redactExecutionText(value.result.reason, 300), evidenceWatermark: value.result.evidenceWatermark,
        evidenceRefs: (value.result.evidenceRefs || []).filter(id).slice(0, 24), uncertainty: ['low', 'medium', 'high'].includes(value.result.uncertainty) ? value.result.uncertainty : 'high' };
      const tracking = value.tracking && { lastAttemptAt: value.tracking.lastAttemptAt, lastJudgedWatermark: value.tracking.lastJudgedWatermark,
        lastEvidenceFingerprint: /^[a-f0-9]{64}$/.test(value.tracking.lastEvidenceFingerprint || '') ? value.tracking.lastEvidenceFingerprint : undefined,
        classification: ['no-progress', 'off-target', 'waiting', 'insufficient-evidence'].includes(value.tracking.classification) ? value.tracking.classification : undefined,
        hits: integer(value.tracking.hits) ? value.tracking.hits : 0 };
      const record = { ...b, id: value.id || randomUUID(), kind: value.kind === 'judgement' ? 'judgement' : 'summary',
        status: safeCode(value.status), code: value.code ? safeCode(value.code) : undefined, startedAt: value.startedAt, completedAt: value.completedAt,
        inputCharacters: integer(value.inputCharacters) ? value.inputCharacters : undefined, published: value.published === true,
        result, tracking, routing: safeRouting(value.routing) };
      db.prepare('INSERT INTO sa_auxiliary_activity(id,kind,ticket_id,run_id,instruction_revision,payload) VALUES (?,?,?,?,?,?)')
        .run(record.id, record.kind, record.ticketId, record.runId, record.instructionRevision, JSON.stringify(record));
      return record;
    },
    latestAuxiliaryActivity({ kind, ticketId, runId, instructionRevision }) {
      return decode(db.prepare('SELECT payload FROM sa_auxiliary_activity WHERE kind=? AND ticket_id=? AND run_id=? AND instruction_revision=? ORDER BY seq DESC LIMIT 1')
        .get(kind, ticketId, runId, instructionRevision));
    },
    auxiliaryActivities({ ticketId, after = 0, limit = 50 } = {}) {
      const rows = db.prepare(`SELECT seq,payload FROM sa_auxiliary_activity WHERE seq>? ${ticketId ? 'AND ticket_id=?' : ''} ORDER BY seq LIMIT ?`)
        .all(...[integer(after) ? after : 0, ...(ticketId ? [ticketId] : []), Math.max(1, Math.min(200, limit))]);
      return { entries: rows.map(row => ({ seq: row.seq, ...decode(row) })), cursor: rows.at(-1)?.seq ?? after };
    },
  };
}
