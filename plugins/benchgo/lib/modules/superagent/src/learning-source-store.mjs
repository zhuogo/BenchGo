const parse = value => JSON.parse(value);
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 500;

/** Persistent closed/delivered facts and a global, transactionally reserved learning range. */
export function installLearningSourceStore({ db, tx }) {
  db.exec(`CREATE TABLE IF NOT EXISTS sa_learning_closed_tickets (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id TEXT NOT NULL, result_version INTEGER NOT NULL,
    outbox_id TEXT NOT NULL, closed_at TEXT NOT NULL, UNIQUE(ticket_id,result_version)
  );
  CREATE TABLE IF NOT EXISTS sa_learning_source_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS sa_learning_source_batches (
    id TEXT PRIMARY KEY, after_seq INTEGER NOT NULL, next_seq INTEGER NOT NULL,
    source_seqs TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0
  );
  CREATE UNIQUE INDEX IF NOT EXISTS sa_learning_one_active_batch ON sa_learning_source_batches(completed) WHERE completed=0;`);
  const cursor = () => db.prepare("SELECT value FROM sa_learning_source_meta WHERE key='cursor'").get()?.value || 0;
  function record(ticketId, closedAt) {
    const ticket = db.prepare('SELECT * FROM sa_tickets WHERE id=?').get(ticketId);
    if (!ticket || !['completed', 'failed'].includes(ticket.status) || ticket.result_version < 1) return null;
    const existing = db.prepare('SELECT seq FROM sa_learning_closed_tickets WHERE ticket_id=? AND result_version=?').get(ticketId, ticket.result_version);
    if (existing) return existing;
    const resultRow = db.prepare('SELECT payload FROM sa_results WHERE ticket_id=? AND version=?').get(ticketId, ticket.result_version);
    if (!resultRow) return null;
    const result = parse(resultRow.payload);
    if (result.outcome !== ticket.status || result.instructionRevision !== ticket.instruction_revision) return null;
    const outbox = db.prepare(`SELECT o.* FROM sa_outbox o JOIN sa_delivery_receipts r ON r.outbox_id=o.id
      WHERE o.ticket_id=? AND o.state='sent' AND json_extract(o.payload,'$.type')='ticket.result'
      AND json_extract(o.payload,'$.publication.origin')='worker'
      AND json_extract(o.payload,'$.resultVersion')=? AND json_extract(o.payload,'$.instructionRevision')=?
      AND json_extract(o.payload,'$.outcome')=? AND json_extract(r.payload,'$.status')='accepted'
      AND length(trim(json_extract(r.payload,'$.messageId')))>0 ORDER BY o.sent_at,o.id LIMIT 1`)
      .get(ticketId, ticket.result_version, ticket.instruction_revision, ticket.status);
    if (!outbox?.sent_at || JSON.stringify(parse(outbox.payload).source) !== JSON.stringify(parse(ticket.mandate).source)) return null;
    db.prepare('INSERT OR IGNORE INTO sa_learning_closed_tickets(ticket_id,result_version,outbox_id,closed_at) VALUES (?,?,?,?)')
      .run(ticketId, ticket.result_version, outbox.id, closedAt || outbox.sent_at);
    return db.prepare('SELECT seq FROM sa_learning_closed_tickets WHERE ticket_id=? AND result_version=?').get(ticketId, ticket.result_version);
  }
  // Old source tombstones cannot reconstruct dropped call metadata. Retire old
  // terminal material rather than re-extracting forgotten facts during migration.
  tx(() => {
    db.prepare("INSERT OR IGNORE INTO sa_learning_source_meta VALUES ('legacy-closed-material-retired',1)").run();
  });
  function material(seq) {
    const row = db.prepare(`SELECT c.*,t.status,t.instruction_revision,r.payload FROM sa_learning_closed_tickets c
      JOIN sa_tickets t ON t.id=c.ticket_id JOIN sa_results r ON r.ticket_id=c.ticket_id AND r.version=c.result_version
      JOIN sa_outbox o ON o.id=c.outbox_id WHERE c.seq=? AND t.status IN ('completed','failed')
      AND t.result_version=c.result_version AND o.state='sent'`).get(seq);
    if (!row) return null;
    const instructions = db.prepare(`SELECT t.*,a.gate FROM sa_ticket_triggers tt JOIN sa_triggers t ON t.id=tt.trigger_id
      JOIN sa_trigger_admissions a ON a.trigger_id=t.id WHERE tt.ticket_id=? ORDER BY t.seq`).all(row.ticket_id)
      .filter(trigger => { const gate = parse(trigger.gate), actor = parse(trigger.actor); return gate.allowed === true && gate.strength === 'explicit' && actor.kind !== 'machine' && trigger.content.trim(); })
      .map(trigger => {
        const source = parse(trigger.source);
        return { id: trigger.id, text: trigger.content, source: { ...source, role: 'user',
          ...(!source.messageId && !source.eventId ? { eventId: trigger.id } : {}) } };
      });
    const result = parse(row.payload);
    if (result.outcome !== row.status || result.instructionRevision !== row.instruction_revision) return null;
    return { seq: row.seq, ticketId: row.ticket_id, resultVersion: row.result_version, status: row.status, closedAt: row.closed_at,
      instructions, result: { finalSummary: result.finalSummary ?? result.summary ?? '', failure: result.failure ?? null,
        toolEvidence: result.toolEvidence ?? null, transcript: result.transcript ?? null, checkpoint: result.checkpoint ?? null } };
  }
  return {
    recordClosedTicket(ticketId, { closedAt, inTransaction = false } = {}) {
      if (!validId(ticketId)) throw new Error('学习工单标识无效');
      return inTransaction ? record(ticketId, closedAt) : tx(() => record(ticketId, closedAt));
    },
    learningSources({ limit = 10 } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw new Error('学习材料请求无效');
      const batch = tx(() => {
        const active = db.prepare('SELECT * FROM sa_learning_source_batches WHERE completed=0').get();
        if (active) return active;
        const after = cursor(), seqs = db.prepare('SELECT seq FROM sa_learning_closed_tickets WHERE seq>? ORDER BY seq LIMIT ?').all(after, limit).map(row => row.seq);
        if (!seqs.length) return { id: null, after_seq: after, next_seq: after, source_seqs: '[]' };
        const next = seqs.at(-1), id = `closed:${after}:${next}`;
        db.prepare('INSERT INTO sa_learning_source_batches VALUES (?,?,?,?,0)').run(id, after, next, JSON.stringify(seqs));
        return { id, after_seq: after, next_seq: next, source_seqs: JSON.stringify(seqs) };
      });
      return { batchId: batch.id, items: parse(batch.source_seqs).map(material).filter(Boolean), afterSeq: batch.after_seq, nextSeq: batch.next_seq,
        hasMore: !!db.prepare('SELECT 1 FROM sa_learning_closed_tickets WHERE seq>? LIMIT 1').get(batch.next_seq) };
    },
    completeLearningSources(batchId) {
      if (batchId === null) return { nextSeq: cursor() };
      if (!validId(batchId)) throw new Error('学习材料批次无效');
      return tx(() => {
        const batch = db.prepare('SELECT * FROM sa_learning_source_batches WHERE id=?').get(batchId);
        if (!batch) throw new Error('学习材料批次不存在');
        if (!batch.completed && cursor() !== batch.after_seq) throw new Error('学习水位冲突');
        db.prepare("INSERT INTO sa_learning_source_meta VALUES ('cursor',?) ON CONFLICT(key) DO UPDATE SET value=MAX(value,excluded.value)").run(batch.next_seq);
        db.prepare('UPDATE sa_learning_source_batches SET completed=1 WHERE id=?').run(batchId);
        return { nextSeq: cursor() };
      });
    },
  };
}
