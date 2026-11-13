import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const maintenanceTasks = ['memory-upkeep', 'relationships', 'dreaming', 'skill-review', 'idea-curation'];
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const id = (value, label) => { if (typeof value !== 'string' || !value.trim() || value.length > 500) throw new Error(`learning ${label} 无效`); return value; };
const bounded = (value, name, min, max) => { if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`maintenance ${name} 无效`); return value; };
const taskOf = value => { if (!maintenanceTasks.includes(value)) throw new Error('maintenance task 无效'); return value; };
// Host identities only: never persist prompt text, tool output or model claims.
function reference(source, scope, eventId) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('learning 来源无效');
  const ref = { sessionId: source.sessionId || scope, messageId: source.messageId || eventId, role: 'user' };
  for (const key of ['sessionId', 'messageId', 'threadId', 'eventId']) if (source[key] !== undefined) ref[key] = id(source[key], key);
  if (source.seq !== undefined) ref.seq = bounded(source.seq, 'seq', 0, Number.MAX_SAFE_INTEGER);
  return ref;
}

/** Durable scheduling outbox; quiet and periodic work share per-task cursors.
 * Official history is the sole owner of conversation text. */
export function createLearningCounters({ directory, review, quietMs = 120_000, periodMs = 21_600_000, now = Date.now } = {}) {
  if (!review?.enqueue || !review?.get) throw new Error('learning 缺少 review 队列');
  bounded(quietMs, 'quietMs', 0, 86_400_000); bounded(periodMs, 'periodMs', 1000, 31_536_000_000);
  const db = new DatabaseSync(join(directory, 'assistant.db'));
  db.exec(`PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS assistant_learning_triggers (id TEXT PRIMARY KEY,scope TEXT NOT NULL,payload TEXT NOT NULL,source TEXT NOT NULL,review_id TEXT,status TEXT NOT NULL DEFAULT 'pending',created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS assistant_learning_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS assistant_maintenance_activity (seq INTEGER PRIMARY KEY AUTOINCREMENT,scope TEXT NOT NULL,event_id TEXT NOT NULL,source TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(scope,event_id));
    CREATE TABLE IF NOT EXISTS assistant_maintenance_batches (id TEXT PRIMARY KEY,task TEXT NOT NULL,after_seq INTEGER NOT NULL,next_seq INTEGER NOT NULL,references_json TEXT NOT NULL,completed INTEGER NOT NULL DEFAULT 0);
    CREATE UNIQUE INDEX IF NOT EXISTS assistant_maintenance_one_batch ON assistant_maintenance_batches(task) WHERE completed=0;`);
  let closed = false;
  const listeners = new Set();
  const meta = key => db.prepare('SELECT value FROM assistant_learning_meta WHERE key=?').get(key)?.value;
  const put = (key, value) => db.prepare('INSERT INTO assistant_learning_meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
  for (const task of maintenanceTasks) if (meta(`period:${task}`) === undefined) put(`period:${task}`, now());
  const tx = fn => { if (closed) throw new Error('Learning counters are closed'); db.exec('BEGIN IMMEDIATE'); try { const value = fn(); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; } };
  const cursor = task => Number(meta(`cursor:${task}`) || 0);
  const latest = () => db.prepare('SELECT MAX(seq) AS seq,MAX(created_at) AS time FROM assistant_maintenance_activity').get();
  const trigger = (scope, payload, source) => {
    const key = digest([scope, payload]);
    db.prepare('INSERT OR IGNORE INTO assistant_learning_triggers(id,scope,payload,source,created_at) VALUES (?,?,?,?,?)').run(key, scope, JSON.stringify(payload), JSON.stringify(source), new Date(now()).toISOString());
    return key;
  };
  const flush = () => {
    if (closed) throw new Error('Learning counters are closed');
    return db.prepare("SELECT * FROM assistant_learning_triggers WHERE status IN ('pending','running') ORDER BY created_at,id").all().map(row => {
      const payload = JSON.parse(row.payload);
      const item = row.review_id ? review.get(row.review_id) : review.enqueue({ kind: !payload.task || payload.task === 'memory-upkeep' ? 'learning' : 'maintenance', payload,
        source: JSON.parse(row.source), priority: payload.trigger === 'explicit' ? 10 : -10, idempotencyKey: `learning:${row.id}` });
      if (!item) throw new Error(`learning review 不存在: ${row.review_id}`);
      db.prepare('UPDATE assistant_learning_triggers SET review_id=?,status=? WHERE id=?').run(item.id, item.status, row.id);
      return { triggerId: row.id, reviewId: item.id, status: item.status };
    });
  };
  const recordActivity = ({ scope, eventId, source = {}, role = 'user', origin = 'user' } = {}) => {
    id(scope, 'scope'); id(eventId, 'eventId');
    if (role !== 'user' || origin !== 'user' || source?.role && source.role !== 'user' || ['machine', 'maintenance', 'review', 'watchdog'].includes(source?.kind)) return { ignored: true, reason: 'not-user' };
    const ref = reference(source, scope, eventId), timestamp = now();
    const result = tx(() => {
      const inserted = db.prepare('INSERT OR IGNORE INTO assistant_maintenance_activity(scope,event_id,source,created_at) VALUES (?,?,?,?)').run(scope, eventId, JSON.stringify(ref), timestamp);
      return { deduplicated: !inserted.changes, seq: db.prepare('SELECT seq FROM assistant_maintenance_activity WHERE scope=? AND event_id=?').get(scope, eventId).seq,
        count: db.prepare('SELECT count(*) AS count FROM assistant_maintenance_activity WHERE scope=?').get(scope).count };
    });
    if (!result.deduplicated) for (const listener of listeners) listener({ scope, eventId, source: ref, time: timestamp });
    return result;
  };
  const isQuiet = () => { const row = latest(); return row.time === null || now() - row.time >= quietMs; };
  return {
    recordActivity, recordPrompt: recordActivity,
    request({ scope, eventId, source = {}, entry = 'command' } = {}) {
      id(scope, 'scope'); id(eventId, 'eventId');
      if (!['command', 'natural-language'].includes(entry)) throw new Error('learning 入口无效');
      const ref = reference(source, scope, eventId), payload = { scope, task: 'memory-upkeep', trigger: 'explicit', material: 'trusted-sources-v1', requestEventId: eventId };
      const triggerId = tx(() => trigger(scope, payload, ref));
      return { triggerId, entry, reviews: flush() };
    },
    scheduleDue({ enabled = true } = {}) {
      flush();
      if (!enabled || !isQuiet()) return { scheduled: [], quiet: isQuiet(), reviews: [] };
      const timestamp = now(), row = latest();
      const scheduled = tx(() => maintenanceTasks.flatMap(task => {
        if (db.prepare("SELECT id FROM assistant_learning_triggers WHERE status IN ('pending','running') AND json_extract(payload,'$.task')=? LIMIT 1").get(task)) return [];
        const periodic = timestamp - Number(meta(`period:${task}`) || 0) >= periodMs;
        const quiet = row.seq > cursor(task);
        if (!periodic && !quiet) return [];
        const payload = { scope: 'global', task, trigger: periodic ? 'periodic' : 'quiet', material: 'trusted-sources-v1', afterSeq: cursor(task), ...(periodic ? { slot: Math.floor(timestamp / periodMs) } : { throughSeq: row.seq }) };
        const triggerId = trigger('global', payload, {});
        if (periodic) put(`period:${task}`, timestamp);
        return [{ task, triggerId }];
      }));
      return { scheduled, quiet: true, reviews: flush() };
    },
    async takeSources({ task = 'memory-upkeep', limit = 20, maxChars = 32000, signal, readSources, batchKey = '' } = {}) {
      taskOf(task); bounded(limit, 'limit', 1, 100); bounded(maxChars, 'maxChars', 1000, 100000);
      if (typeof readSources !== 'function') throw new Error('maintenance 缺少可信原文读取器');
      signal?.throwIfAborted();
      const batch = tx(() => {
        const active = db.prepare('SELECT * FROM assistant_maintenance_batches WHERE task=? AND completed=0').get(task);
        if (active) return active;
        const after = cursor(task), rows = db.prepare('SELECT * FROM assistant_maintenance_activity WHERE seq>? ORDER BY seq LIMIT ?').all(after, limit), next = rows.at(-1)?.seq || after;
        const refs = rows.map(row => ({ ...JSON.parse(row.source), scope: row.scope, eventId: row.event_id, activitySeq: row.seq, createdAt: row.created_at }));
        const key = digest(['maintenance', task, after, next, batchKey]);
        db.prepare('INSERT OR IGNORE INTO assistant_maintenance_batches VALUES (?,?,?,?,?,0)').run(key, task, after, next, JSON.stringify(refs));
        return db.prepare('SELECT * FROM assistant_maintenance_batches WHERE id=?').get(key);
      });
      const references = JSON.parse(batch.references_json), loaded = await readSources({ task, references, limit, maxChars, signal });
      signal?.throwIfAborted();
      const items = Array.isArray(loaded) ? loaded : loaded?.items;
      if (!Array.isArray(items) || items.length > limit || JSON.stringify(items).length > maxChars) throw new Error('maintenance 原文读取器超出材料预算');
      // An adapter which stops at a character/item boundary must report the
      // covered prefix, otherwise omitted references would be consumed unseen.
      const consumed = loaded?.consumedReferences === undefined ? references.length : bounded(loaded.consumedReferences, 'consumedReferences', 0, references.length);
      if (references.length && !consumed) throw new Error('maintenance 原文尚未就绪');
      const covered = references.slice(0, consumed), next = covered.at(-1)?.activitySeq || batch.after_seq;
      if (consumed < references.length) tx(() => db.prepare('UPDATE assistant_maintenance_batches SET next_seq=?,references_json=? WHERE id=? AND completed=0').run(next, JSON.stringify(covered), batch.id));
      return { batchId: batch.id, items, references: covered, hasMore: !!loaded?.hasMore || latest().seq > next };
    },
    completeSources(batchId) {
      id(batchId, 'batchId');
      return tx(() => {
        const row = db.prepare('SELECT * FROM assistant_maintenance_batches WHERE id=?').get(batchId);
        if (!row) throw new Error('maintenance 材料批次不存在');
        if (!row.completed) { put(`cursor:${row.task}`, Math.max(cursor(row.task), row.next_seq)); db.prepare('UPDATE assistant_maintenance_batches SET completed=1 WHERE id=?').run(batchId); }
        return { task: row.task, nextSeq: cursor(row.task), idempotent: !!row.completed };
      });
    },
    isQuiet,
    canRun(item) { return item?.payload?.trigger === 'explicit' || isQuiet(); },
    getTaskFingerprint(task) { return meta(`fingerprint:${taskOf(task)}`) || null; },
    setTaskFingerprint(task, fingerprint) {
      taskOf(task);
      if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(fingerprint)) throw new Error('maintenance 材料指纹无效');
      return tx(() => { put(`fingerprint:${task}`, fingerprint); return fingerprint; });
    },
    onActivity(listener) { if (typeof listener !== 'function') throw new Error('maintenance listener 无效'); listeners.add(listener); return () => listeners.delete(listener); },
    configure(input = {}) { if (input.quietMs !== undefined) quietMs = bounded(input.quietMs, 'quietMs', 0, 86_400_000); if (input.periodMs !== undefined) periodMs = bounded(input.periodMs, 'periodMs', 1000, 31_536_000_000); },
    flush,
    status() { const row = latest(); return { quiet: isQuiet(), lastActivityAt: row.time, latestSeq: row.seq || 0, cursors: Object.fromEntries(maintenanceTasks.map(task => [task, cursor(task)])), quietMs, periodMs }; },
    snapshot({ scope } = {}) {
      if (scope !== undefined) id(scope, 'scope');
      flush();
      const triggers = db.prepare(`SELECT id,scope,review_id AS reviewId,status,payload FROM assistant_learning_triggers ${scope ? 'WHERE scope=?' : ''} ORDER BY created_at,id`).all(...(scope ? [scope] : []));
      return { quietMs, periodMs, events: db.prepare(`SELECT scope,'prompt' AS kind,count(*) AS count FROM assistant_maintenance_activity ${scope ? 'WHERE scope=?' : ''} GROUP BY scope`).all(...(scope ? [scope] : [])), triggers: triggers.map(row => ({ ...row, payload: JSON.parse(row.payload) })), completed: triggers.filter(row => row.status === 'completed').length };
    },
    close() { if (!closed) { closed = true; listeners.clear(); db.close(); } },
  };
}
