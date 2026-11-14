import { resultReplyDelivered } from './result-notification-store.mjs';
const parse = value => JSON.parse(value);
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 500;

/** Persistent closed/delivered facts and a global, transactionally reserved learning range. */
export function installLearningSourceStore({ db, tx }) {
  db.exec(`CREATE TABLE IF NOT EXISTS sa_learning_closed_tasks (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, result_version INTEGER NOT NULL,
    outbox_id TEXT NOT NULL, closed_at TEXT NOT NULL, UNIQUE(task_id,result_version)
  );
  CREATE TABLE IF NOT EXISTS sa_learning_source_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS sa_learning_source_batches (
    id TEXT PRIMARY KEY, after_seq INTEGER NOT NULL, next_seq INTEGER NOT NULL,
    source_seqs TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0
  );
  CREATE UNIQUE INDEX IF NOT EXISTS sa_learning_one_active_batch ON sa_learning_source_batches(completed) WHERE completed=0;`);
  const cursor = () => db.prepare("SELECT value FROM sa_learning_source_meta WHERE key='cursor'").get()?.value || 0;
  function record(taskId, closedAt) {
    const task = db.prepare('SELECT * FROM sa_tasks WHERE id=?').get(taskId);
    if (!task || task.status !== 'completed' || task.result_version < 1) return null;
    const existing = db.prepare('SELECT seq FROM sa_learning_closed_tasks WHERE task_id=? AND result_version=?').get(taskId, task.result_version);
    if (existing) return existing;
    const resultRow = db.prepare('SELECT payload FROM sa_results WHERE task_id=? AND version=?').get(taskId, task.result_version);
    if (!resultRow) return null;
    const result = parse(resultRow.payload);
    if (result.outcome !== task.status || result.instructionRevision !== task.instruction_revision) return null;
    const outbox = db.prepare(`SELECT o.* FROM sa_outbox o JOIN sa_delivery_receipts r ON r.outbox_id=o.id
      WHERE o.task_id=? AND o.state='sent' AND json_extract(o.payload,'$.type')='task.result'
      AND json_extract(o.payload,'$.publication.origin') IN ('router','worker')
      AND json_extract(o.payload,'$.resultVersion')=? AND json_extract(o.payload,'$.instructionRevision')=?
      AND json_extract(o.payload,'$.outcome')=? AND json_extract(r.payload,'$.status')='accepted'
      AND length(trim(json_extract(r.payload,'$.messageId')))>0 ORDER BY o.sent_at,o.id LIMIT 1`)
      .get(taskId, task.result_version, task.instruction_revision, task.status);
    const source = parse(task.mandate).source, reply = result.reply;
    const publiclyDelivered = resultReplyDelivered(result, source);
    if (!publiclyDelivered && (!outbox?.sent_at || JSON.stringify(parse(outbox.payload).source) !== JSON.stringify(source))) return null;
    db.prepare('INSERT OR IGNORE INTO sa_learning_closed_tasks(task_id,result_version,outbox_id,closed_at) VALUES (?,?,?,?)')
      .run(taskId, task.result_version, publiclyDelivered ? `reply:${reply.requestId}` : outbox.id, closedAt || (publiclyDelivered ? reply.at : outbox.sent_at));
    return db.prepare('SELECT seq FROM sa_learning_closed_tasks WHERE task_id=? AND result_version=?').get(taskId, task.result_version);
  }
  function material(seq) {
    const row = db.prepare(`SELECT c.*,t.status,t.instruction_revision,r.payload FROM sa_learning_closed_tasks c
      JOIN sa_tasks t ON t.id=c.task_id JOIN sa_results r ON r.task_id=c.task_id AND r.version=c.result_version
      LEFT JOIN sa_outbox o ON o.id=c.outbox_id WHERE c.seq=? AND t.status='completed'
      AND t.result_version=c.result_version AND (o.state='sent' OR json_extract(r.payload,'$.reply.requestId') IS NOT NULL)`).get(seq);
    if (!row) return null;
    const instructions = db.prepare(`SELECT t.*,a.gate FROM sa_task_triggers tt JOIN sa_triggers t ON t.id=tt.trigger_id
      JOIN sa_trigger_admissions a ON a.trigger_id=t.id WHERE tt.task_id=? ORDER BY t.seq`).all(row.task_id)
      .filter(trigger => { const gate = parse(trigger.gate), actor = parse(trigger.actor); return gate.allowed === true && gate.strength === 'explicit' && actor.kind !== 'machine' && trigger.content.trim(); })
      .map(trigger => {
        const source = parse(trigger.source);
        return { id: trigger.id, text: trigger.content, source: { ...source, role: 'user',
          ...(!source.messageId && !source.eventId ? { eventId: trigger.id } : {}) } };
      });
    const result = parse(row.payload);
    if (result.outcome !== row.status || result.instructionRevision !== row.instruction_revision) return null;
    return { seq: row.seq, taskId: row.task_id, resultVersion: row.result_version, status: row.status, closedAt: row.closed_at,
      instructions, result: { summary: result.summary ?? '' } };
  }
  return {
    recordClosedTask(taskId, { closedAt, inTransaction = false } = {}) {
      if (!validId(taskId)) throw new Error('学习任务标识无效');
      return inTransaction ? record(taskId, closedAt) : tx(() => record(taskId, closedAt));
    },
    learningSources({ limit = 10 } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw new Error('学习材料请求无效');
      const batch = tx(() => {
        const active = db.prepare('SELECT * FROM sa_learning_source_batches WHERE completed=0').get();
        if (active) return active;
        const after = cursor(), seqs = db.prepare('SELECT seq FROM sa_learning_closed_tasks WHERE seq>? ORDER BY seq LIMIT ?').all(after, limit).map(row => row.seq);
        if (!seqs.length) return { id: null, after_seq: after, next_seq: after, source_seqs: '[]' };
        const next = seqs.at(-1), id = `closed:${after}:${next}`;
        db.prepare('INSERT INTO sa_learning_source_batches VALUES (?,?,?,?,0)').run(id, after, next, JSON.stringify(seqs));
        return { id, after_seq: after, next_seq: next, source_seqs: JSON.stringify(seqs) };
      });
      return { batchId: batch.id, items: parse(batch.source_seqs).map(material).filter(Boolean), afterSeq: batch.after_seq, nextSeq: batch.next_seq,
        hasMore: !!db.prepare('SELECT 1 FROM sa_learning_closed_tasks WHERE seq>? LIMIT 1').get(batch.next_seq) };
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
