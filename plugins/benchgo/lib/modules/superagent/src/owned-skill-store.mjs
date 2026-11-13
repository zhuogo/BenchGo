import { createHash } from 'node:crypto';

const DAY = 86400000;
const hash = text => createHash('sha256').update(text).digest('hex');
const validId = id => { if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(id)) throw new Error('Invalid owned skill id'); };
const validTime = now => { if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid skill time'); };
const sourceAliases = (source, { includeMemoryIds = true } = {}) => {
  const refs = [source, ...(Array.isArray(source?.references) ? source.references : [])];
  return [...new Set(refs.flatMap(ref => [
    ref?.messageId && ['message', ref.sessionId || '', ref.messageId], ref?.eventId && ['event', ref.channel || '', ref.eventId],
    ref?.ticketId && ['ticket', ref.ticketId], ref?.taskId && ['task', ref.taskId], ref?.callId && ['call', ref.sessionId || '', ref.callId],
    ...(includeMemoryIds && Array.isArray(ref?.memoryIds) ? ref.memoryIds.map(id => ['memory', id]) : []),
  ].filter(Boolean).map(value => hash(JSON.stringify(value)))))];
};
const sourceReferences = source => [source, ...(Array.isArray(source?.references) ? source.references : [])]
  .filter(value => value && typeof value === 'object').map(value => Object.fromEntries(['sessionId', 'messageId', 'eventId', 'channel', 'ticketId', 'taskId', 'callId', 'memoryIds']
    .filter(key => value[key] !== undefined).map(key => [key, value[key]]))).filter(value => Object.keys(value).length);

// Metadata and immutable snapshots share the assistant SQLite transaction. The
// caller projects active bodies into Harness skills; this is not an installer.
export function installOwnedSkillStore({ db, tx }) {
  db.exec(`CREATE TABLE IF NOT EXISTS sa_owned_skills(
    id TEXT PRIMARY KEY, body TEXT NOT NULL, hash TEXT NOT NULL, source TEXT NOT NULL,
    state TEXT NOT NULL, fixed INTEGER NOT NULL, version INTEGER NOT NULL,
    created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sa_skill_uses(event_id TEXT PRIMARY KEY, skill_id TEXT NOT NULL, used_at INTEGER NOT NULL, skill_hash TEXT);
    CREATE TABLE IF NOT EXISTS sa_skill_feedback(
      event_id TEXT PRIMARY KEY, skill_id TEXT NOT NULL, skill_hash TEXT NOT NULL,
      version INTEGER NOT NULL, text TEXT NOT NULL, source TEXT NOT NULL,
      outcome TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS sa_skill_feedback_review ON sa_skill_feedback(skill_id,skill_hash,at);
    CREATE TABLE IF NOT EXISTS sa_skill_source_tombstones(alias TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS sa_skill_audit(
      seq INTEGER PRIMARY KEY AUTOINCREMENT, skill_id TEXT NOT NULL, action TEXT NOT NULL,
      version INTEGER NOT NULL, body TEXT NOT NULL, hash TEXT NOT NULL, at INTEGER NOT NULL);`);
  if (!db.prepare('PRAGMA table_info(sa_skill_uses)').all().some(column => column.name === 'skill_hash')) db.exec('ALTER TABLE sa_skill_uses ADD COLUMN skill_hash TEXT');
  const decode = row => row && ({ id: row.id, body: row.body, hash: row.hash, source: JSON.parse(row.source), state: row.state,
    fixed: !!row.fixed, version: row.version, createdAt: row.created_at, lastUsedAt: row.last_used_at, updatedAt: row.updated_at });
  const get = id => decode(db.prepare('SELECT * FROM sa_owned_skills WHERE id=?').get(id));
  const audit = (id, action, now) => { const row = get(id); db.prepare('INSERT INTO sa_skill_audit(skill_id,action,version,body,hash,at) VALUES(?,?,?,?,?,?)').run(id, action, row.version, row.body, row.hash, now); };
  const expect = (id, version) => { const row = get(id); if (!row) throw new Error('Owned skill not found'); if (row.version !== version) throw new Error('Owned skill version conflict'); return row; };
  const feedback = row => ({ id: row.event_id, eventId: row.event_id, text: row.text, source: JSON.parse(row.source), outcome: row.outcome, at: row.at, hash: row.skill_hash, version: row.version });
  const sourceAllowed = source => !sourceAliases(source).some(alias => db.prepare('SELECT 1 FROM sa_skill_source_tombstones WHERE alias=?').get(alias));
  const sourceMatches = (source, { memoryIds = [], references = [] } = {}) => {
    const affected = new Set(sourceAliases({ memoryIds, references }));
    return sourceAliases(source).some(alias => affected.has(alias));
  };
  return {
    ownedSkillSourceAllowed: sourceAllowed,
    ownedSkillSourceMatches: sourceMatches,
    getOwnedSkill: get,
    listOwnedSkills() { return db.prepare('SELECT * FROM sa_owned_skills ORDER BY id').all().map(decode); },
    ownedSkillAudit(id) { return db.prepare('SELECT seq,action,version,body,hash,at FROM sa_skill_audit WHERE skill_id=? ORDER BY seq').all(id); },
    ownedSkillUsage(id) { const row = db.prepare('SELECT count(*) AS count,max(used_at) AS lastUsedAt FROM sa_skill_uses WHERE skill_id=?').get(id); return { count: row.count, lastUsedAt: row.lastUsedAt }; },
    saveOwnedSkill({ id, body, source, expectedVersion = 0, now = Date.now() }) {
      validId(id); validTime(now);
      if (typeof body !== 'string' || !body.trim() || body.length > 100000) throw new Error('Invalid skill body');
      if (!source || typeof source !== 'object' || Array.isArray(source) || !Object.keys(source).length) throw new Error('Skill source required');
      if (JSON.stringify(source).length > 16000) throw new Error('Skill source too large');
      return tx(() => {
        const previous = get(id);
        if ((previous?.version ?? 0) !== expectedVersion) throw new Error('Owned skill version conflict');
        if (previous?.fixed) throw new Error('Fixed skill cannot be rewritten');
        if (previous?.state === 'archived') throw new Error('Restore archived skill before editing');
        if (previous?.state === 'invalidated') throw new Error('Invalidated skill cannot be rewritten');
        const provenance = previous ? { ...source, references: [...new Map([...sourceReferences(previous.source), ...sourceReferences(source)].map(value => [JSON.stringify(value), value])).values()] } : source;
        if (!sourceAllowed(provenance)) throw new Error('Skill source was corrected or forgotten');
        const serialized = JSON.stringify(provenance);
        if (serialized.length > 16000) throw new Error('Skill source too large');
        if (previous) db.prepare('UPDATE sa_owned_skills SET body=?,hash=?,source=?,version=version+1,updated_at=? WHERE id=?').run(body, hash(body), serialized, now, id);
        else db.prepare("INSERT INTO sa_owned_skills VALUES(?,?,?,?,'active',0,1,?,?,?)").run(id, body, hash(body), serialized, now, now, now);
        audit(id, previous ? 'update' : 'create', now); return get(id);
      });
    },
    setOwnedSkillFixed(id, { fixed, expectedVersion, now = Date.now() }) {
      validTime(now); if (typeof fixed !== 'boolean') throw new Error('Invalid fixed flag');
      return tx(() => { expect(id, expectedVersion); db.prepare('UPDATE sa_owned_skills SET fixed=?,version=version+1,updated_at=? WHERE id=?').run(Number(fixed), now, id); audit(id, fixed ? 'pin' : 'unpin', now); return get(id); });
    },
    recordOwnedSkillUse(id, { eventId, now = Date.now() }) {
      validTime(now); if (typeof eventId !== 'string' || !eventId || eventId.length > 512) throw new Error('Skill use event required');
      return tx(() => {
        const row = get(id); if (!row) throw new Error('Owned skill not found');
        const previous = db.prepare('SELECT * FROM sa_skill_uses WHERE event_id=?').get(eventId);
        if (previous) { if (previous.skill_id !== id) throw new Error('Skill use event conflict'); return row; }
        if (['archived', 'invalidated'].includes(row.state)) throw new Error('Unavailable skill cannot be used');
        db.prepare('INSERT INTO sa_skill_uses(event_id,skill_id,used_at,skill_hash) VALUES(?,?,?,?)').run(eventId, id, now, row.hash);
        db.prepare("UPDATE sa_owned_skills SET last_used_at=max(last_used_at,?),state='active',version=version+1,updated_at=max(updated_at,?) WHERE id=?").run(now, now, id);
        audit(id, 'use', now); return get(id);
      });
    },
    // Host-confirmed user/task feedback is distinct from a successful skill load.
    // Bind evidence to the actual body so a later edit cannot inherit its result.
    recordOwnedSkillFeedback(id, { eventId, text, source, outcome = 'unknown', useEventId, now = Date.now() }) {
      validTime(now);
      if (typeof eventId !== 'string' || !eventId || eventId.length > 512) throw new Error('Skill feedback event required');
      if (typeof text !== 'string' || !text.trim() || text.length > 4000) throw new Error('Invalid skill feedback');
      if (!['success', 'failure', 'unknown'].includes(outcome)) throw new Error('Invalid skill feedback outcome');
      if (!source || typeof source !== 'object' || Array.isArray(source)
        || !['ticketId', 'messageId'].some(key => typeof source[key] === 'string' && source[key].trim())) throw new Error('Skill feedback durable source required');
      const serialized = JSON.stringify({ ...source, ...(useEventId === undefined ? {} : { useEventId }) });
      if (serialized.length > 16000) throw new Error('Skill feedback source too large');
      return tx(() => {
        const row = get(id); if (!row) throw new Error('Owned skill not found');
        if (row.state === 'invalidated' || !sourceAllowed(source)) throw new Error('Skill feedback source was corrected or forgotten');
        const previous = db.prepare('SELECT * FROM sa_skill_feedback WHERE event_id=?').get(eventId);
        if (previous) { if (previous.skill_id !== id) throw new Error('Skill feedback event conflict'); return feedback(previous); }
        if (useEventId !== undefined) {
          const use = typeof useEventId === 'string' && db.prepare('SELECT skill_id,skill_hash FROM sa_skill_uses WHERE event_id=?').get(useEventId);
          if (!use || use.skill_id !== id || use.skill_hash !== row.hash) throw new Error('Skill feedback use evidence not found for current body');
        }
        db.prepare('INSERT INTO sa_skill_feedback VALUES(?,?,?,?,?,?,?,?)').run(eventId, id, row.hash, row.version, text.trim(), serialized, outcome, now);
        return feedback(db.prepare('SELECT * FROM sa_skill_feedback WHERE event_id=?').get(eventId));
      });
    },
    ownedSkillReviewInputs({ limit = 8, now = Date.now() } = {}) {
      validTime(now);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('Invalid skill review limit');
      return db.prepare(`SELECT s.* FROM sa_owned_skills s WHERE fixed=0 AND state IN ('active','stale')
        AND EXISTS(SELECT 1 FROM sa_skill_feedback f WHERE f.skill_id=s.id AND f.skill_hash=s.hash)
        ORDER BY (SELECT max(f.at) FROM sa_skill_feedback f WHERE f.skill_id=s.id AND f.skill_hash=s.hash) DESC,s.id LIMIT ?`).all(limit)
        .map(row => ({ ...decode(row), idleDays: Math.max(0, Math.floor((now - row.last_used_at) / DAY)),
          feedback: db.prepare('SELECT * FROM sa_skill_feedback WHERE skill_id=? AND skill_hash=? ORDER BY at DESC,event_id LIMIT 8').all(row.id, row.hash).map(feedback) }));
    },
    invalidateOwnedSkillSources({ kind, memoryIds = [], references = [], now = Date.now() } = {}) {
      validTime(now);
      if (!Array.isArray(memoryIds) || memoryIds.some(id => typeof id !== 'string' || !id) || !Array.isArray(references)) throw new Error('Invalid skill source invalidation');
      return tx(() => {
        // A correction invalidates current dependencies on this memory revision,
        // while the same durable memory ID may later carry corrected evidence.
        const permanent = kind === 'corrected' ? sourceAliases({ references }, { includeMemoryIds: false }) : sourceAliases({ memoryIds, references });
        for (const alias of permanent) db.prepare('INSERT OR IGNORE INTO sa_skill_source_tombstones VALUES(?)').run(alias);
        const affected = source => !sourceAllowed(source) || sourceMatches(source, { memoryIds, references });
        const feedbackEventIds = [], skillIds = [];
        for (const row of db.prepare('SELECT event_id,source FROM sa_skill_feedback').all()) {
          if (!affected(JSON.parse(row.source))) continue;
          db.prepare('DELETE FROM sa_skill_feedback WHERE event_id=?').run(row.event_id); feedbackEventIds.push(row.event_id);
        }
        for (const row of this.listOwnedSkills()) {
          if (row.state === 'invalidated' || !affected(row.source)) continue;
          // Privacy invalidation removes exact dependencies and their snapshots;
          // unrelated generalized procedures are not selected by these aliases.
          db.prepare("UPDATE sa_owned_skills SET body='',hash=?,source='{}',state='invalidated',version=version+1,updated_at=? WHERE id=?").run(hash(''), now, row.id);
          db.prepare('DELETE FROM sa_skill_audit WHERE skill_id=?').run(row.id);
          db.prepare('DELETE FROM sa_skill_feedback WHERE skill_id=?').run(row.id);
          audit(row.id, 'invalidated', now); skillIds.push(row.id);
        }
        return { skillIds, feedbackEventIds };
      });
    },
    restoreOwnedSkill(id, { expectedVersion, snapshotSeq, now = Date.now() }) {
      validTime(now);
      return tx(() => {
        const row = expect(id, expectedVersion);
        if (row.state === 'invalidated') throw new Error('Invalidated skill cannot be restored');
        if (row.fixed && snapshotSeq !== undefined) throw new Error('Fixed skill cannot be rewritten');
        const snapshot = snapshotSeq === undefined ? row : db.prepare('SELECT body,hash FROM sa_skill_audit WHERE skill_id=? AND seq=?').get(id, snapshotSeq);
        if (!snapshot) throw new Error('Skill snapshot not found');
        db.prepare("UPDATE sa_owned_skills SET body=?,hash=?,state='active',last_used_at=max(last_used_at,?),version=version+1,updated_at=? WHERE id=?").run(snapshot.body, snapshot.hash, now, now, id);
        audit(id, snapshotSeq === undefined ? 'restore' : 'rollback', now); return get(id);
      });
    },
  };
}
