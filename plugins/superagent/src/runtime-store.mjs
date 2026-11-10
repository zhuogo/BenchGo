import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { notificationPublication } from './notification-publication.mjs';
import { installTaskCleanupStore } from './task-cleanup-store.mjs';

const encode = value => JSON.stringify(value);
const decode = row => row ? { ...JSON.parse(row.payload), ...(row.unique_key?.startsWith('ticket-delivery:')
  ? { ticketStateEventKey: row.unique_key.slice('ticket-delivery:'.length) } : {}) } : null;

/** Durable notification and Goal storage for the current SuperAgent baseline. */
export function createAssistantRuntimeStore({ directory, filename, afterCommit } = {}) {
  if (!directory && !filename) throw new Error('Task store requires a database path');
  if (directory) mkdirSync(directory, { recursive: true });
  const path = filename || join(directory, 'assistant.db');
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS task_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS task_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, unique_key TEXT UNIQUE NOT NULL, task_id TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS task_outbox (event_id TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, delivered_at TEXT, last_error TEXT);
    CREATE TABLE IF NOT EXISTS task_outbox_targets (event_id TEXT NOT NULL, device_id TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, delivered_at TEXT, last_error TEXT, PRIMARY KEY(event_id,device_id));
    CREATE INDEX IF NOT EXISTS task_outbox_targets_ready ON task_outbox_targets(delivered_at,next_at);
    CREATE TABLE IF NOT EXISTS task_read_state (event_id TEXT PRIMARY KEY, read_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS task_delivery_receipts (event_id TEXT NOT NULL, device_id TEXT NOT NULL, received_at TEXT NOT NULL, PRIMARY KEY(event_id,device_id));
    CREATE TABLE IF NOT EXISTS assistant_goals (id TEXT PRIMARY KEY, request_id TEXT UNIQUE, status TEXT NOT NULL, row_version INTEGER NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS assistant_message_reactions (scope TEXT NOT NULL, message_key TEXT NOT NULL, emoji TEXT NOT NULL, PRIMARY KEY(scope,message_key));
`);
  let closed = false, inTransaction = false;
  const committed = () => { if (!inTransaction) { try { afterCommit?.(); } catch { /* Observation cannot undo a committed domain write. */ } } };
  const transaction = fn => {
    db.exec('BEGIN IMMEDIATE');
    inTransaction = true;
    try { const result = fn(); db.exec('COMMIT'); inTransaction = false; committed(); return result; }
    catch (error) { db.exec('ROLLBACK'); inTransaction = false; throw error; }
  };
  const publishPending = row => {
    const event = notificationPublication({ ...decode(row), seq: row.seq });
    if (event) return event;
    // Settle unsupported historical rows without delivery. Retain their records
    // for audit, but do not let old progress/raw-result events retry forever.
    const id = row.event_id || row.eventId, at = new Date().toISOString();
    db.prepare('UPDATE task_outbox SET delivered_at=?,last_error=? WHERE event_id=? AND delivered_at IS NULL').run(at, 'publication-suppressed', id);
    db.prepare('UPDATE task_outbox_targets SET delivered_at=?,last_error=? WHERE event_id=? AND delivered_at IS NULL').run(at, 'publication-suppressed', id);
    return null;
  };
  const api = {
    path,
    transaction,
    messageReactions(scope) {
      return Object.fromEntries(db.prepare('SELECT message_key,emoji FROM assistant_message_reactions WHERE scope=?').all(scope).map(row => [row.message_key, row.emoji]));
    },
    setMessageReaction(scope, messageKey, emoji) {
      if (emoji !== null && !['👍', '❤️', '😂', '🎉', '🤔', '👎'].includes(emoji)) throw new Error('Invalid message reaction');
      if (emoji === null) db.prepare('DELETE FROM assistant_message_reactions WHERE scope=? AND message_key=?').run(scope, messageKey);
      else db.prepare('INSERT INTO assistant_message_reactions VALUES (?,?,?) ON CONFLICT(scope,message_key) DO UPDATE SET emoji=excluded.emoji').run(scope, messageKey, emoji);
      return { messageKey, emoji };
    },
    meta(key) { const row = db.prepare('SELECT value FROM task_meta WHERE key=?').get(key); return row ? JSON.parse(row.value) : null; },
    setMeta(key, value) { db.prepare('INSERT INTO task_meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, encode(value)); },
    clearMainChatNotifications() {
      const seq = Number(db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM task_events').get().seq);
      api.setMeta('mainChatNotificationBoundary', seq);
      return seq;
    },
    chatNotifications(threadId, { after = 0, limit = 100 } = {}) {
      const boundary = threadId === 'main' ? api.meta('mainChatNotificationBoundary') || 0 : 0;
      return api.notifications({ after: Math.max(after, boundary), limit, threadId });
    },
    event(source, type, payload, uniqueKey) {
      const existing = db.prepare('SELECT payload,seq FROM task_events WHERE unique_key=?').get(uniqueKey);
      if (existing) {
        const published = notificationPublication({ ...decode(existing), seq: existing.seq });
        if (!published) throw new Error('Historical notification is not publishable');
        return published;
      }
      const eventId = randomUUID();
      const value = notificationPublication({ ...payload, id: eventId, eventId, type, taskId: source.id, threadId: source.threadId || 'main', createdAt: new Date().toISOString() });
      if (!value) throw new Error('通知必须通过正式交付或 attention 发布入口');
      const inserted = db.prepare('INSERT INTO task_events (id,unique_key,task_id,payload) VALUES (?,?,?,?)').run(eventId, uniqueKey, source.id, encode(value));
      db.prepare('INSERT INTO task_outbox(event_id) VALUES (?)').run(eventId);
      return { ...value, seq: Number(inserted.lastInsertRowid) };
    },
    notify(source, type, payload, key) { return transaction(() => api.event(source, type, payload, key)); },
    notifications({ after = 0, limit = 100, threadId, unread = false } = {}) {
      if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('Invalid notification cursor or limit');
      const latest = Number(db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM task_events').get().seq);
      if (after > latest) return { events: [], cursor: latest, resyncRequired: true, hasMore: false };
      const rows = db.prepare(`SELECT e.*,r.read_at FROM task_events e LEFT JOIN task_read_state r ON e.id=r.event_id WHERE e.seq>?${threadId ? " AND json_extract(e.payload,'$.threadId')=?" : ''}${unread ? ' AND r.read_at IS NULL' : ''} ORDER BY e.seq LIMIT ?`).all(after, ...(threadId ? [threadId] : []), limit);
      const events = rows.map(row => notificationPublication({ ...decode(row), seq: row.seq, readAt: row.read_at || null })).filter(event => event && (!threadId || event.threadId === threadId) && (!unread || !event.readAt));
      const cursor = rows.length < limit ? latest : rows.at(-1)?.seq ?? after;
      return { events, cursor, hasMore: cursor < latest, resyncRequired: false };
    },
    markRead(eventIds) {
      if (!Array.isArray(eventIds) || eventIds.length > 500) throw new Error('Invalid event list');
      return transaction(() => {
        const readAt = new Date().toISOString();
        for (const id of eventIds) {
          if (!db.prepare('SELECT id FROM task_events WHERE id=?').get(id)) throw new Error('Notification does not exist');
          db.prepare('INSERT INTO task_read_state VALUES (?,?) ON CONFLICT(event_id) DO NOTHING').run(id, readAt);
        }
        return { eventIds, readAt };
      });
    },
    ackDelivery(eventId, deviceId) {
      if (typeof deviceId !== 'string' || !deviceId || deviceId.length > 200 || !db.prepare('SELECT id FROM task_events WHERE id=?').get(eventId)) throw new Error('Invalid delivery receipt');
      return transaction(() => {
        const receivedAt = new Date().toISOString();
        db.prepare('INSERT INTO task_delivery_receipts VALUES (?,?,?) ON CONFLICT(event_id,device_id) DO NOTHING').run(eventId, deviceId, receivedAt);
        return { eventId, deviceId, receivedAt };
      });
    },
    ackDeliveries(eventIds, deviceId) {
      if (!Array.isArray(eventIds) || eventIds.length > 500 || typeof deviceId !== 'string' || !deviceId || deviceId.length > 200) throw new Error('Invalid delivery receipt');
      return transaction(() => {
        const receivedAt = new Date().toISOString();
        for (const eventId of eventIds) {
          if (typeof eventId !== 'string' || !db.prepare('SELECT id FROM task_events WHERE id=?').get(eventId)) throw new Error('Notification does not exist');
          db.prepare('INSERT INTO task_delivery_receipts VALUES (?,?,?) ON CONFLICT(event_id,device_id) DO NOTHING').run(eventId, deviceId, receivedAt);
        }
        return { eventIds, deviceId, receivedAt };
      });
    },
    deliveryReceipts(eventId) {
      if (typeof eventId !== 'string' || !eventId) throw new Error('Invalid notification event');
      return db.prepare('SELECT event_id AS eventId, device_id AS deviceId, received_at AS receivedAt FROM task_delivery_receipts WHERE event_id=? ORDER BY received_at').all(eventId);
    },
    pendingOutbox(now = Date.now()) { return transaction(() => db.prepare('SELECT o.*,e.payload,e.seq FROM task_outbox o JOIN task_events e ON o.event_id=e.id WHERE o.delivered_at IS NULL AND o.attempts<8 AND o.next_at<=? ORDER BY e.seq LIMIT 50').all(now).flatMap(row => {
      const event = publishPending(row);
      return event ? [{ eventId: row.event_id, attempts: row.attempts, nextAt: row.next_at, deliveredAt: row.delivered_at, lastError: row.last_error, event }] : [];
    })); },
    registerDeliveryTargets(eventId, deviceIds = []) {
      if (typeof eventId !== 'string' || !eventId || !Array.isArray(deviceIds) || deviceIds.length > 500) throw new Error('Invalid delivery targets');
      return transaction(() => {
        if (!db.prepare('SELECT id FROM task_events WHERE id=?').get(eventId)) throw new Error('Notification does not exist');
        const ids = [...new Set(deviceIds.map(value => String(value || '').trim()).filter(value => value && value.length <= 200))];
        for (const deviceId of ids) db.prepare('INSERT INTO task_outbox_targets(event_id,device_id) VALUES (?,?) ON CONFLICT(event_id,device_id) DO NOTHING').run(eventId, deviceId);
        return api.deliveryTargets(eventId);
      });
    },
    deliveryTargets(eventId) {
      if (typeof eventId !== 'string' || !eventId) throw new Error('Invalid notification event');
      return db.prepare('SELECT event_id AS eventId,device_id AS deviceId,attempts,next_at AS nextAt,delivered_at AS deliveredAt,last_error AS lastError FROM task_outbox_targets WHERE event_id=? ORDER BY device_id').all(eventId);
    },
    pendingDeliveries(now = Date.now(), limit = 100) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('Invalid delivery limit');
      return transaction(() => db.prepare('SELECT t.event_id AS eventId,t.device_id AS deviceId,t.attempts,t.next_at AS nextAt,t.delivered_at AS deliveredAt,t.last_error AS lastError,e.payload,e.seq FROM task_outbox_targets t JOIN task_events e ON e.id=t.event_id WHERE t.delivered_at IS NULL AND t.attempts<8 AND t.next_at<=? ORDER BY e.seq,t.device_id LIMIT ?').all(now, limit).flatMap(row => {
        const event = publishPending(row);
        const { payload, seq, ...target } = row;
        return event ? [{ ...target, event }] : [];
      }));
    },
    deliveryTargetAttempt(eventId, deviceId, { error, delivered = false } = {}) {
      if (typeof eventId !== 'string' || !eventId || typeof deviceId !== 'string' || !deviceId) throw new Error('Invalid delivery target');
      return transaction(() => {
        const current = db.prepare('SELECT * FROM task_outbox_targets WHERE event_id=? AND device_id=?').get(eventId, deviceId);
        if (!current) throw new Error('Delivery target does not exist');
        const attempts = current.attempts + 1;
        const deliveredAt = delivered ? new Date().toISOString() : null;
        const nextAt = delivered ? 0 : Date.now() + Math.min(300000, 1000 * 2 ** current.attempts);
        db.prepare('UPDATE task_outbox_targets SET attempts=?,next_at=?,delivered_at=?,last_error=? WHERE event_id=? AND device_id=?').run(attempts, nextAt, deliveredAt, error || null, eventId, deviceId);
        const remaining = Number(db.prepare('SELECT COUNT(*) AS n FROM task_outbox_targets WHERE event_id=? AND delivered_at IS NULL').get(eventId).n);
        if (remaining === 0) db.prepare('UPDATE task_outbox SET delivered_at=?,last_error=NULL WHERE event_id=? AND delivered_at IS NULL').run(new Date().toISOString(), eventId);
        return { eventId, deviceId, attempts, deliveredAt, remaining };
      });
    },
    outboxStatus(eventId) {
      const row = db.prepare('SELECT * FROM task_outbox WHERE event_id=?').get(eventId);
      if (!row) throw new Error('Notification does not exist');
      return { eventId, attempts: row.attempts, nextAt: row.next_at, deliveredAt: row.delivered_at, lastError: row.last_error, targets: api.deliveryTargets(eventId) };
    },
    deliveryAttempt(id, { error, delivered = false } = {}) {
      const current = db.prepare('SELECT * FROM task_outbox WHERE event_id=?').get(id);
      if (!current) throw new Error('Notification does not exist');
      db.prepare('UPDATE task_outbox SET attempts=attempts+1,next_at=?,delivered_at=?,last_error=? WHERE event_id=?').run(Date.now() + Math.min(300000, 1000 * 2 ** current.attempts), delivered ? new Date().toISOString() : null, error || null, id);
    },
    retryDelivery(id) { db.prepare('UPDATE task_outbox SET attempts=0,next_at=0,last_error=NULL WHERE event_id=? AND delivered_at IS NULL').run(id); },
    goal(id) { return decode(db.prepare('SELECT payload FROM assistant_goals WHERE id=?').get(id)); },
    goalByRequest(requestId) { return decode(db.prepare('SELECT payload FROM assistant_goals WHERE request_id=?').get(requestId)); },
    goals() { return db.prepare('SELECT payload FROM assistant_goals ORDER BY rowid').all().map(decode); },
    insertGoal(value) {
      const goal = { ...value, rowVersion: value.rowVersion || 1, createdAt: value.createdAt || new Date().toISOString(), updatedAt: value.updatedAt || new Date().toISOString() };
      db.prepare('INSERT INTO assistant_goals VALUES (?,?,?,?,?)').run(goal.id, goal.requestId || null, goal.status, goal.rowVersion, encode(goal));
      return goal;
    },
    updateGoal(id, patch, { rowVersion } = {}) {
      const current = api.goal(id); if (!current) throw new Error('Goal does not exist');
      if (rowVersion !== undefined && rowVersion !== current.rowVersion) throw Object.assign(new Error('Goal changed'), { code: 'ROW_CONFLICT', goal: current });
      const value = { ...current, ...patch, id: current.id, rowVersion: current.rowVersion + 1, updatedAt: new Date().toISOString() };
      const changed = db.prepare('UPDATE assistant_goals SET status=?,row_version=?,payload=? WHERE id=? AND row_version=?').run(value.status, value.rowVersion, encode(value), id, current.rowVersion);
      if (!changed.changes) throw Object.assign(new Error('Goal changed'), { code: 'ROW_CONFLICT' });
      return value;
    },
    lease(owner, now = Date.now(), duration = 30000) {
      return transaction(() => {
        const current = api.meta('scheduler');
        if (current && current.owner !== owner && current.until > now) return null;
        const lease = { owner, until: now + duration, token: current?.owner === owner ? current.token : (current?.token || 0) + 1 };
        api.setMeta('scheduler', lease); return lease;
      });
    },
    releaseLease(owner) { transaction(() => { const current = api.meta('scheduler'); if (current?.owner === owner) api.setMeta('scheduler', { ...current, until: 0 }); }); },
    close() { if (!closed) { closed = true; db.close(); } },
  };
  // Standalone SQLite writes autocommit. Inside a transaction the outer commit
  // emits once; rollback never wakes execution-fact consumers.
  for (const name of ['setMessageReaction', 'setMeta', 'event', 'delivered', 'retryDelivery', 'insertGoal', 'updateGoal']) {
    if (typeof api[name] !== 'function') continue;
    const write = api[name];
    api[name] = (...args) => { const result = write(...args); committed(); return result; };
  }
  api.taskCleanup = installTaskCleanupStore({ db, transaction });
  return api;
}
