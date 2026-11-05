import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const now = () => new Date().toISOString();
const clone = value => structuredClone(value);
const day = () => new Date().toISOString().slice(0, 10);
const safePayload = value => {
  const payload = clone(value ?? {});
  const text = JSON.stringify(payload) ?? 'null';
  if (text.length > 100000) throw new Error('review 输入过大');
  return payload;
};

export function createAssistantReview({ directory, budget = 20 } = {}) {
  const db = new DatabaseSync(join(directory, 'assistant.db'));
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;
    CREATE TABLE IF NOT EXISTS assistant_review_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS assistant_review_queue (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, priority INTEGER NOT NULL,
      payload TEXT NOT NULL, source TEXT, attempts INTEGER NOT NULL, lease_owner TEXT,
      lease_until TEXT, result TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS assistant_review_queue_pick ON assistant_review_queue(status, priority, created_at);
    CREATE TABLE IF NOT EXISTS assistant_review_keys (key TEXT PRIMARY KEY, review_id TEXT NOT NULL);
  `);
  let closed = false;
  const tx = fn => { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } };
  const recoverRows = () => {
    const timestamp = now();
    db.prepare("UPDATE assistant_review_queue SET status='pending', lease_owner=NULL, lease_until=NULL, updated_at=? WHERE status='running' AND lease_until IS NOT NULL AND lease_until<?").run(timestamp, timestamp);
  };
  const recover = () => tx(() => recoverRows());
  recover();
  const budgetValue = () => {
    const row = db.prepare('SELECT value FROM assistant_review_meta WHERE key=?').get(`budget:${day()}`);
    return row ? JSON.parse(row.value) : { used: 0, limit: budget };
  };
  const saveBudget = value => db.prepare('INSERT INTO assistant_review_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`budget:${day()}`, JSON.stringify(value));
  return {
    enqueue({ kind = 'memory', payload, source, priority = 0, idempotencyKey } = {}) {
      if (closed) throw new Error('Review store is closed');
      if (typeof kind !== 'string' || !/^[a-z][a-z0-9_.-]{0,63}$/u.test(kind)) throw new Error('review 类型无效');
      if (!Number.isSafeInteger(priority) || priority < -100 || priority > 100) throw new Error('review 优先级无效');
      if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || !idempotencyKey || idempotencyKey.length > 500)) throw new Error('review 去重键无效');
      const body = safePayload(payload), sourceValue = source === undefined ? null : JSON.stringify(safePayload(source));
      return tx(() => {
        if (idempotencyKey) {
          const previous = db.prepare('SELECT q.* FROM assistant_review_keys k JOIN assistant_review_queue q ON q.id=k.review_id WHERE k.key=?').get(idempotencyKey);
          if (previous) return { id: previous.id, kind: previous.kind, status: previous.status, payload: JSON.parse(previous.payload), source: previous.source ? JSON.parse(previous.source) : null, deduplicated: true };
        }
        const existing = db.prepare("SELECT * FROM assistant_review_queue WHERE status IN ('pending','running') AND kind=? AND payload=? AND COALESCE(source,'')=COALESCE(?, '') LIMIT 1").get(kind, JSON.stringify(body), sourceValue);
        if (existing) {
          if (idempotencyKey) db.prepare('INSERT INTO assistant_review_keys VALUES (?,?)').run(idempotencyKey, existing.id);
          return { id: existing.id, kind: existing.kind, status: existing.status, priority: existing.priority, payload: JSON.parse(existing.payload), source: existing.source ? JSON.parse(existing.source) : null, deduplicated: true };
        }
        const id = randomUUID(), timestamp = now();
        db.prepare('INSERT INTO assistant_review_queue VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, kind, 'pending', priority, JSON.stringify(body), sourceValue, 0, null, null, null, null, timestamp, timestamp);
        if (idempotencyKey) db.prepare('INSERT INTO assistant_review_keys VALUES (?,?)').run(idempotencyKey, id);
        return { id, kind, status: 'pending', priority, payload: body, source: source ?? null, createdAt: timestamp };
      });
    },
    get(id) {
      const row = db.prepare('SELECT * FROM assistant_review_queue WHERE id=?').get(id);
      return row ? { id: row.id, kind: row.kind, status: row.status, payload: JSON.parse(row.payload), source: row.source ? JSON.parse(row.source) : null, attempts: row.attempts, result: row.result ? JSON.parse(row.result) : null, error: row.error } : null;
    },
    list({ status, limit = 100 } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('review 查询数量无效');
      if (status !== undefined && !['pending', 'running', 'completed', 'failed', 'rejected'].includes(status)) throw new Error('review 状态无效');
      recover();
      const rows = db.prepare(status ? 'SELECT * FROM assistant_review_queue WHERE status=? ORDER BY priority DESC,created_at LIMIT ?' : 'SELECT * FROM assistant_review_queue ORDER BY created_at DESC LIMIT ?').all(...(status ? [status, limit] : [limit]));
      return rows.map(row => ({ id: row.id, kind: row.kind, status: row.status, priority: row.priority, payload: JSON.parse(row.payload), source: row.source ? JSON.parse(row.source) : null, attempts: row.attempts, result: row.result ? JSON.parse(row.result) : null, error: row.error, createdAt: row.created_at, updatedAt: row.updated_at }));
    },
    budget() { return budgetValue(); },
    claim({ workerId = randomUUID(), limit = 1, leaseMs = 60000 } = {}) {
      if (closed) throw new Error('Review store is closed');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw new Error('review 批量数量无效');
      if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 3600000) throw new Error('review 租约无效');
      return tx(() => {
        recoverRows();
        const quota = budgetValue(), available = Math.max(0, quota.limit - quota.used), count = Math.min(limit, available);
        if (!count) return { workerId, items: [], budget: quota };
        const rows = db.prepare("SELECT * FROM assistant_review_queue WHERE status='pending' ORDER BY priority DESC,created_at LIMIT ?").all(count);
        const until = new Date(Date.now() + leaseMs).toISOString(), timestamp = now();
        for (const row of rows) db.prepare("UPDATE assistant_review_queue SET status='running',attempts=attempts+1,lease_owner=?,lease_until=?,updated_at=? WHERE id=? AND status='pending'").run(workerId, until, timestamp, row.id);
        const result = rows.map(row => ({ id: row.id, kind: row.kind, status: 'running', priority: row.priority, payload: JSON.parse(row.payload), source: row.source ? JSON.parse(row.source) : null, attempts: row.attempts + 1, leaseOwner: workerId, leaseUntil: until }));
        const next = { used: quota.used + result.length, limit: quota.limit }; saveBudget(next);
        return { workerId, items: result, budget: next };
      });
    },
    complete(id, { workerId, result, status = 'completed' } = {}) {
      if (typeof workerId !== 'string' || !workerId || workerId.length > 200) throw new Error('review 租约无效');
      if (!['completed', 'pending', 'rejected'].includes(status)) throw new Error('review 完成状态无效');
      return tx(() => {
        const row = db.prepare('SELECT * FROM assistant_review_queue WHERE id=?').get(id);
        if (!row) throw new Error('review 项不存在');
        if (row.status === 'completed' || row.status === 'rejected') return { id, status: row.status, idempotent: true };
        if (row.status !== 'running' || row.lease_owner !== workerId) throw new Error('review 租约无效');
        const timestamp = now(); db.prepare('UPDATE assistant_review_queue SET status=?,lease_owner=NULL,lease_until=NULL,result=?,updated_at=? WHERE id=?').run(status, result === undefined ? null : JSON.stringify(safePayload(result)), timestamp, id);
        return { id, status, result: result === undefined ? null : clone(result) };
      });
    },
    fail(id, { workerId, error } = {}) {
      if (typeof workerId !== 'string' || !workerId || workerId.length > 200) throw new Error('review 租约无效');
      return tx(() => {
        const row = db.prepare('SELECT * FROM assistant_review_queue WHERE id=?').get(id);
        if (!row) throw new Error('review 项不存在');
        if (row.status === 'failed') return { id, status: 'failed', idempotent: true };
        if (row.status !== 'running' || row.lease_owner !== workerId) throw new Error('review 租约无效');
        const timestamp = now(); db.prepare("UPDATE assistant_review_queue SET status='failed',lease_owner=NULL,lease_until=NULL,error=?,updated_at=? WHERE id=?").run(String(error || 'review failed').slice(0, 4000), timestamp, id);
        return { id, status: 'failed', error: String(error || 'review failed') };
      });
    },
    close() { if (!closed) { closed = true; db.close(); } },
  };
}

