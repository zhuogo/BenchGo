import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

// Tokenize CJK before general letters: a general \p{L} token would swallow mixed text.
function memorySearchTerms(text) {
  const terms = new Set();
  const normalized = text.normalize('NFKC').toLowerCase();
  const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
  for (const match of normalized.matchAll(cjk)) {
    const chars = [...match[0]];
    for (const char of chars) terms.add(char);
    for (let index = 1; index < chars.length; index++) terms.add(chars[index - 1] + chars[index]);
  }
  for (const match of normalized.replace(cjk, ' ').matchAll(/[\p{L}\p{N}_@./:-]+/gu)) terms.add(match[0]);
  return [...terms];
}

const bound = (n, fallback, max) => Number.isSafeInteger(n) && n > 0 ? Math.min(n, max) : fallback;
const required = (value, name) => { if (typeof value !== 'string' || !value || value.length > 2048) throw new Error(`Invalid ledger ${name}`); return value; };
const failure = (code, message) => Object.assign(new Error(message), { code });

// Harness owns its logs. Rows with sessionId/eventSeq are immutable, rebuildable projections.
export function createAssistantLedger({ directory } = {}) {
  required(directory, 'directory');
  mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(join(directory, 'ledger.db'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS ledger_records(id TEXT PRIMARY KEY, kind TEXT NOT NULL, source_key TEXT UNIQUE NOT NULL, content TEXT NOT NULL, metadata TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE VIRTUAL TABLE IF NOT EXISTS ledger_fts USING fts5(id UNINDEXED, terms);
    CREATE TABLE IF NOT EXISTS ledger_links(from_id TEXT NOT NULL REFERENCES ledger_records(id), to_id TEXT NOT NULL REFERENCES ledger_records(id), relation TEXT NOT NULL, PRIMARY KEY(from_id,to_id,relation));
    CREATE INDEX IF NOT EXISTS ledger_links_target ON ledger_links(to_id);
    CREATE TABLE IF NOT EXISTS ledger_watermarks(session_id TEXT PRIMARY KEY, event_seq INTEGER NOT NULL);`);
  const transaction = fn => { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } };
  const decode = row => row && ({ id: row.id, kind: row.kind, sourceKey: row.source_key, content: row.content, metadata: JSON.parse(row.metadata), createdAt: row.created_at });
  function insert(input) {
    required(input?.id, 'id'); required(input.kind, 'kind'); required(input.sourceKey, 'sourceKey');
    if (typeof input.content !== 'string') throw new Error('Ledger requires original content');
    const metadata = JSON.stringify(input.metadata ?? {});
    const existing = db.prepare('SELECT * FROM ledger_records WHERE id=? OR source_key=?').all(input.id, input.sourceKey);
    if (existing.length) {
      const row = existing[0];
      if (existing.length !== 1 || row.id !== input.id || row.source_key !== input.sourceKey || row.content !== input.content || row.kind !== input.kind || row.metadata !== metadata) throw failure('LEDGER_CONFLICT', 'Immutable ledger record conflicts with existing source');
      return { ...decode(row), duplicate: true };
    }
    const createdAt = input.createdAt ?? new Date().toISOString();
    db.prepare('INSERT INTO ledger_records VALUES (?,?,?,?,?,?)').run(input.id, input.kind, input.sourceKey, input.content, metadata, createdAt);
    db.prepare('INSERT INTO ledger_fts(id,terms) VALUES (?,?)').run(input.id, memorySearchTerms(input.content).join(' '));
    return { ...input, metadata: JSON.parse(metadata), createdAt, duplicate: false };
  }
  function get(id) {
    const row = decode(db.prepare('SELECT * FROM ledger_records WHERE id=?').get(required(id, 'id')));
    if (!row) throw failure('LEDGER_NOT_FOUND', `Ledger reference not found: ${id}`);
    return row;
  }
  function read(id, { cursor = 0, limit = 16000 } = {}) {
    const row = get(id), chars = [...row.content];
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > chars.length) throw new Error('Invalid ledger cursor');
    const end = Math.min(chars.length, cursor + bound(limit, 16000, 100000));
    return { ...row, content: chars.slice(cursor, end).join(''), fullLength: chars.length, cursor, nextCursor: end < chars.length ? end : null, complete: cursor === 0 && end === chars.length };
  }
  function link(fromId, toId, relation) {
    get(fromId); get(toId); required(relation, 'relation');
    db.prepare('INSERT OR IGNORE INTO ledger_links VALUES (?,?,?)').run(fromId, toId, relation);
    return { fromId, toId, relation };
  }
  return {
    append(input, links = []) { return transaction(() => { const record = insert(input); for (const target of links) link(input.id, target.id, target.relation); return record; }); },
    read,
    search(query, { limit = 20, kind, sessionId } = {}) {
      required(query, 'query');
      const terms = memorySearchTerms(query);
      if (!terms.length) return [];
      const match = terms.map(term => `"${term.replaceAll('"', '""')}"`).join(' AND ');
      const sql = `SELECT r.* FROM ledger_fts f JOIN ledger_records r ON r.id=f.id WHERE ledger_fts MATCH ?${kind ? ' AND r.kind=?' : ''}${sessionId ? " AND json_extract(r.metadata,'$.sessionId')=?" : ''} ORDER BY rank LIMIT ?`;
      return db.prepare(sql).all(...[match, ...(kind ? [required(kind, 'kind')] : []), ...(sessionId ? [required(sessionId, 'sessionId')] : []), bound(limit, 20, 100)]).map(decode);
    },
    link,
    related(id, { limit = 100 } = {}) {
      get(id);
      return db.prepare('SELECT from_id AS fromId,to_id AS toId,relation FROM ledger_links WHERE from_id=? OR to_id=? ORDER BY from_id,to_id,relation LIMIT ?').all(id, id, bound(limit, 100, 1000));
    },
    importSession(sessionId, events) {
      required(sessionId, 'sessionId');
      if (!Array.isArray(events)) throw new Error('Expected session events');
      return transaction(() => {
        let cursor = db.prepare('SELECT event_seq FROM ledger_watermarks WHERE session_id=?').get(sessionId)?.event_seq ?? -1;
        for (const event of events) {
          if (!Number.isSafeInteger(event.seq) || event.seq < 0 || typeof event.content !== 'string') throw new Error('Invalid session event projection');
          const sourceKey = JSON.stringify(['harness', sessionId, event.seq]);
          insert({ id: `harness:${createHash('sha256').update(sourceKey).digest('hex')}`, kind: 'session-event', sourceKey, content: event.content, metadata: { ...(event.metadata ?? {}), sessionId, eventSeq: event.seq }, createdAt: event.createdAt });
          cursor = Math.max(cursor, event.seq);
        }
        db.prepare('INSERT INTO ledger_watermarks VALUES (?,?) ON CONFLICT(session_id) DO UPDATE SET event_seq=excluded.event_seq').run(sessionId, cursor);
        return cursor;
      });
    },
    watermark(sessionId) { return db.prepare('SELECT event_seq FROM ledger_watermarks WHERE session_id=?').get(required(sessionId, 'sessionId'))?.event_seq ?? -1; },
    rebuildIndex() { return transaction(() => { db.exec('DELETE FROM ledger_fts'); for (const row of db.prepare('SELECT id,content FROM ledger_records').all()) db.prepare('INSERT INTO ledger_fts VALUES (?,?)').run(row.id, memorySearchTerms(row.content).join(' ')); }); },
    close() { db.close(); },
  };
}
