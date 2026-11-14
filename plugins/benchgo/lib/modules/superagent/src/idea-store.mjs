import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
const normalized = value => value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, ' ').trim();
const array = value => Array.isArray(value) && value.every(id => typeof id === 'string' && id.length > 0 && id.length <= 500);
const aliases = source => [source?.messageId && `message:${source.sessionId || ''}:${source.messageId}`, source?.eventId && `event:${source.channel || ''}:${source.eventId}`,
  source?.taskId && `task:${source.taskId}`, source?.callId && `call:${source.callId}`].filter(Boolean);
const references = source => [...new Set((source?.references || [source]).flatMap(aliases))];
const parse = row => row && ({ ...JSON.parse(row.payload), id: row.id, status: row.status, createdAt: row.created_at, expiresAt: row.expires_at });

/** Suggestions only: no task creation, scheduling, delivery or authorization lives here. */
export function createIdeaStore({ directory, now = () => Date.now() }) {
  const db = new DatabaseSync(join(directory, 'assistant.db'));
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;
    CREATE TABLE IF NOT EXISTS sa_ideas(id TEXT PRIMARY KEY, slot TEXT UNIQUE NOT NULL, fingerprint TEXT UNIQUE NOT NULL,
      payload TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,expires_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS sa_ideas_status ON sa_ideas(status,expires_at);
    CREATE TABLE IF NOT EXISTS sa_idea_tombstones(alias TEXT PRIMARY KEY);`);
  let closed = false;
  const date = () => new Date(now()).toISOString();
  const expire = () => db.prepare("UPDATE sa_ideas SET status='expired' WHERE status='pending' AND expires_at<=?").run(date());
  const denied = input => [...(input.memoryIds || []).map(id => `memory:${id}`), ...references(input.source)]
    .some(alias => db.prepare('SELECT 1 FROM sa_idea_tombstones WHERE alias=?').get(alias));
  return {
    propose(input) {
      if (!input || typeof input.title !== 'string' || !input.title.trim() || input.title.length > 120 || typeof input.content !== 'string'
        || !input.content.trim() || input.content.length > 1200 || !array(input.memoryIds || []) || (input.memoryIds || []).length > 40
        || typeof input.idempotencyKey !== 'string' || !input.idempotencyKey || input.idempotencyKey.length > 1000
        || !input.source || typeof input.source !== 'object' || JSON.stringify(input.source).length > 16000
        || !references(input.source).length && !input.memoryIds?.length) throw new Error('想法候选缺少内容或来源');
      const expiry = new Date(input.expiresAt).getTime(), clock = new Date(now()).getTime();
      if (!Number.isFinite(expiry) || expiry <= clock || expiry > clock + 31 * 86400000) throw new Error('想法有效期无效');
      expire();
      const fingerprint = hash(normalized(`${input.title}\n${input.content}`));
      const existing = db.prepare('SELECT * FROM sa_ideas WHERE slot=? OR fingerprint=? LIMIT 1').get(input.idempotencyKey, fingerprint);
      if (existing) return parse(existing);
      if (denied(input)) return { status: 'invalidated', reason: '想法来源已纠正或遗忘' };
      const id = randomUUID(), payload = JSON.stringify({ title: input.title.trim(), content: input.content.trim(), memoryIds: input.memoryIds || [], source: input.source });
      if (payload.length > 24000) throw new Error('想法候选过大');
      db.prepare("INSERT INTO sa_ideas VALUES(?,?,?,?,'pending',?,?)").run(id, input.idempotencyKey, fingerprint, payload, date(), new Date(expiry).toISOString());
      return parse(db.prepare('SELECT * FROM sa_ideas WHERE id=?').get(id));
    },
    list({ status = 'pending', limit = 20 } = {}) {
      if (!['pending', 'dismissed', 'expired', 'invalidated', 'all'].includes(status) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('想法查询无效');
      expire();
      return (status === 'all' ? db.prepare('SELECT * FROM sa_ideas ORDER BY created_at DESC LIMIT ?').all(limit)
        : db.prepare('SELECT * FROM sa_ideas WHERE status=? ORDER BY created_at DESC LIMIT ?').all(status, limit)).map(parse);
    },
    dismiss(id) {
      db.prepare("UPDATE sa_ideas SET status='dismissed' WHERE id=? AND status='pending'").run(id);
      return parse(db.prepare('SELECT * FROM sa_ideas WHERE id=?').get(id));
    },
    invalidate({ kind, memoryIds = [], references: sources = [] } = {}) {
      if (!array(memoryIds) || !Array.isArray(sources)) throw new Error('想法失效来源无效');
      const removed = new Set([...memoryIds.map(id => `memory:${id}`), ...sources.flatMap(aliases)]);
      db.exec('BEGIN IMMEDIATE');
      try {
        // Corrections retain the memory identity with a new revision/source;
        // invalidate old suggestions without banning the corrected fact forever.
        for (const alias of removed) if (kind !== 'corrected' || !alias.startsWith('memory:')) db.prepare('INSERT OR IGNORE INTO sa_idea_tombstones VALUES(?)').run(alias);
        const invalidated = [];
        for (const row of db.prepare("SELECT * FROM sa_ideas WHERE status!='invalidated'").all()) {
          const input = parse(row);
          if (![...input.memoryIds.map(id => `memory:${id}`), ...references(input.source)].some(alias => removed.has(alias))) continue;
          // Erase derived prose and citations too; a forgotten source cannot survive in history.
          db.prepare("UPDATE sa_ideas SET status='invalidated',payload=? WHERE id=?").run(JSON.stringify({ title: '', content: '', memoryIds: [], source: {} }), row.id);
          invalidated.push(row.id);
        }
        db.exec('COMMIT'); return { ids: invalidated };
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    close() { if (!closed) { closed = true; db.close(); } },
  };
}
