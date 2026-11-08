import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identifier = (value, label) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 500) throw new Error(`learning ${label} 无效`);
  return value;
};

/** Durable event counters and outbox; all three learning entries use kind=learning.
 * Event identities only schedule work. Material and consumption cursor belong
 * exclusively to the global closed-ticket store, never these Router event ranges.
 */
export function createLearningCounters({ directory, review, promptThreshold = 10, toolThreshold = 10 } = {}) {
  if (!review?.enqueue || !review?.get) throw new Error('learning 缺少 review 队列');
  for (const value of [promptThreshold, toolThreshold]) if (!Number.isSafeInteger(value) || value < 1 || value > 1000) throw new Error('learning 阈值无效');
  const db = new DatabaseSync(join(directory, 'assistant.db'));
  db.exec(`PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS assistant_learning_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, kind TEXT NOT NULL,
      event_id TEXT NOT NULL, turn_id TEXT NOT NULL, source TEXT NOT NULL,
      UNIQUE(scope,kind,event_id)
    );
    CREATE INDEX IF NOT EXISTS assistant_learning_event_scope ON assistant_learning_events(scope,kind,turn_id,seq);
    CREATE TABLE IF NOT EXISTS assistant_learning_triggers (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, payload TEXT NOT NULL, source TEXT NOT NULL,
      review_id TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS assistant_learning_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
  // Retire the old session-message ranges while preserving counts, deduplication
  // keys and pending review identities. There was no reusable closed-ticket cursor.
  if (!db.prepare("SELECT 1 FROM assistant_learning_meta WHERE key='closed-ticket-material-v1'").get()) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const migrate = value => { const { eventIds, turnIds, ...rest } = JSON.parse(value); return JSON.stringify({ ...rest, material: 'closed-tickets-v1',
        ...(rest.trigger === 'explicit' && eventIds?.[0] ? { requestEventId: eventIds[0] } : {}) }); };
      for (const row of db.prepare('SELECT id,payload FROM assistant_learning_triggers').all()) db.prepare('UPDATE assistant_learning_triggers SET payload=? WHERE id=?').run(migrate(row.payload), row.id);
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='assistant_review_queue'").get()) {
        for (const row of db.prepare("SELECT id,payload FROM assistant_review_queue WHERE kind='learning'").all()) db.prepare('UPDATE assistant_review_queue SET payload=? WHERE id=?').run(migrate(row.payload), row.id);
      }
      db.prepare("INSERT INTO assistant_learning_meta VALUES ('closed-ticket-material-v1','retired-session-ranges')").run();
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
  }
  db.exec("CREATE INDEX IF NOT EXISTS assistant_learning_request_event ON assistant_learning_triggers(scope,json_extract(payload,'$.requestEventId')) WHERE json_extract(payload,'$.trigger')='explicit'");
  let closed = false;
  const tx = fn => {
    if (closed) throw new Error('Learning counters are closed');
    db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); db.exec('COMMIT'); return value; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const trigger = (scope, payload, source) => {
    const id = digest([scope, payload]);
    db.prepare('INSERT OR IGNORE INTO assistant_learning_triggers(id,scope,payload,source,created_at) VALUES (?,?,?,?,?)')
      .run(id, scope, JSON.stringify(payload), JSON.stringify(source), new Date().toISOString());
    return id;
  };
  // The queue key survives terminal completion. A crash after enqueue and
  // before outbox acknowledgement therefore cannot run a range twice.
  const flush = () => {
    if (closed) throw new Error('Learning counters are closed');
    const rows = db.prepare("SELECT * FROM assistant_learning_triggers WHERE status IN ('pending','running') ORDER BY created_at,id").all();
    const results = [];
    for (const row of rows) {
      const item = row.review_id ? review.get(row.review_id) : review.enqueue({
        kind: 'learning', payload: JSON.parse(row.payload), source: JSON.parse(row.source),
        idempotencyKey: `learning:${row.id}`,
      });
      if (!item) throw new Error(`learning review 不存在: ${row.review_id}`);
      db.prepare('UPDATE assistant_learning_triggers SET review_id=?,status=? WHERE id=?').run(item.id, item.status, row.id);
      results.push({ triggerId: row.id, reviewId: item.id, status: item.status });
    }
    return results;
  };
  const record = ({ scope, eventId, turnId = '', source = {}, role = 'user' } = {}, kind) => {
    identifier(scope, 'scope'); identifier(eventId, 'eventId');
    if (kind === 'tool') identifier(turnId, 'turnId');
    // Review output must never recursively count as a new user prompt.
    if (kind === 'prompt' && role !== 'user') return { ignored: true, reason: 'not-user' };
    const sourceText = JSON.stringify(source);
    if (!source || typeof source !== 'object' || Array.isArray(source) || sourceText.length > 10000) throw new Error('learning 来源无效');
    const result = tx(() => {
      const inserted = db.prepare('INSERT OR IGNORE INTO assistant_learning_events(scope,kind,event_id,turn_id,source) VALUES (?,?,?,?,?)').run(scope, kind, eventId, turnId, sourceText);
      const count = db.prepare('SELECT count(*) AS count FROM assistant_learning_events WHERE scope=? AND kind=? AND (?=\'prompt\' OR turn_id=?)').get(scope, kind, kind, turnId).count;
      if (!inserted.changes) return { deduplicated: true, count };
      const threshold = kind === 'prompt' ? promptThreshold : toolThreshold;
      // Memory is periodic; a tool-heavy turn requests one joint review.
      if (kind === 'prompt' ? count % threshold !== 0 : count !== threshold) return { count };
      const payload = { scope, trigger: kind, material: 'closed-tickets-v1', counter: { kind, count, ...(kind === 'tool' ? { turnId } : {}) } };
      return { count, triggerId: trigger(scope, payload, source) };
    });
    return { ...result, reviews: flush() };
  };
  return {
    recordPrompt: input => record(input, 'prompt'),
    recordToolIteration: input => record(input, 'tool'),
    request({ scope, eventId, turnId = '', source = {}, entry = 'command' } = {}) {
      identifier(scope, 'scope'); identifier(eventId, 'eventId');
      if (!['command', 'natural-language'].includes(entry)) throw new Error('learning 入口无效');
      if (!source || typeof source !== 'object' || Array.isArray(source) || JSON.stringify(source).length > 10000) throw new Error('learning 来源无效');
      // entry is informational, excluded from identity: command + detected
      // natural language for the same original message are one request.
      const payload = { scope, trigger: 'explicit', material: 'closed-tickets-v1', requestEventId: eventId };
      const triggerId = tx(() => db.prepare("SELECT id FROM assistant_learning_triggers WHERE scope=? AND json_extract(payload,'$.trigger')='explicit' AND json_extract(payload,'$.requestEventId')=? LIMIT 1").get(scope, eventId)?.id || trigger(scope, payload, source));
      return { triggerId, entry, reviews: flush() };
    },
    flush,
    snapshot({ scope } = {}) {
      if (scope !== undefined) identifier(scope, 'scope');
      flush();
      const events = db.prepare(`SELECT scope,kind,turn_id AS turnId,count(*) AS count FROM assistant_learning_events ${scope ? 'WHERE scope=?' : ''} GROUP BY scope,kind,turn_id`).all(...(scope ? [scope] : []));
      const triggers = db.prepare(`SELECT id,scope,review_id AS reviewId,status,payload FROM assistant_learning_triggers ${scope ? 'WHERE scope=?' : ''} ORDER BY created_at,id`).all(...(scope ? [scope] : []));
      return { promptThreshold, toolThreshold, events, triggers: triggers.map(row => ({ ...row, payload: JSON.parse(row.payload) })), completed: triggers.filter(row => row.status === 'completed').length };
    },
    close() { if (!closed) { closed = true; db.close(); } },
  };
}
