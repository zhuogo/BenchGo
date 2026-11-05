import { createHash } from 'node:crypto';

const DAY = 86400000;
const hash = text => createHash('sha256').update(text).digest('hex');
const validId = id => { if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(id)) throw new Error('Invalid owned skill id'); };
const validTime = now => { if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid skill time'); };

// Metadata and immutable snapshots share the assistant SQLite transaction. The
// caller projects active bodies into Harness skills; this is not an installer.
export function installOwnedSkillStore({ db, tx }) {
  db.exec(`CREATE TABLE IF NOT EXISTS sa_owned_skills(
    id TEXT PRIMARY KEY, body TEXT NOT NULL, hash TEXT NOT NULL, source TEXT NOT NULL,
    state TEXT NOT NULL, fixed INTEGER NOT NULL, version INTEGER NOT NULL,
    created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sa_skill_uses(event_id TEXT PRIMARY KEY, skill_id TEXT NOT NULL, used_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sa_skill_audit(
      seq INTEGER PRIMARY KEY AUTOINCREMENT, skill_id TEXT NOT NULL, action TEXT NOT NULL,
      version INTEGER NOT NULL, body TEXT NOT NULL, hash TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sa_curator_policy(id INTEGER PRIMARY KEY CHECK(id=1), stale_days INTEGER NOT NULL, archive_days INTEGER NOT NULL);
    INSERT OR IGNORE INTO sa_curator_policy VALUES(1,14,30);`);
  const decode = row => row && ({ id: row.id, body: row.body, hash: row.hash, source: JSON.parse(row.source), state: row.state,
    fixed: !!row.fixed, version: row.version, createdAt: row.created_at, lastUsedAt: row.last_used_at, updatedAt: row.updated_at });
  const get = id => decode(db.prepare('SELECT * FROM sa_owned_skills WHERE id=?').get(id));
  const audit = (id, action, now) => { const row = get(id); db.prepare('INSERT INTO sa_skill_audit(skill_id,action,version,body,hash,at) VALUES(?,?,?,?,?,?)').run(id, action, row.version, row.body, row.hash, now); };
  const expect = (id, version) => { const row = get(id); if (!row) throw new Error('Owned skill not found'); if (row.version !== version) throw new Error('Owned skill version conflict'); return row; };
  return {
    getOwnedSkill: get,
    listOwnedSkills() { return db.prepare('SELECT * FROM sa_owned_skills ORDER BY id').all().map(decode); },
    ownedSkillAudit(id) { return db.prepare('SELECT seq,action,version,body,hash,at FROM sa_skill_audit WHERE skill_id=? ORDER BY seq').all(id); },
    curatorPolicy() { const row = db.prepare('SELECT * FROM sa_curator_policy WHERE id=1').get(); return { staleDays: row.stale_days, archiveDays: row.archive_days, llmMerge: false }; },
    configureCurator({ staleDays, archiveDays }) {
      if (!Number.isSafeInteger(staleDays) || staleDays < 1 || !Number.isSafeInteger(archiveDays) || archiveDays <= staleDays || archiveDays > 36500) throw new Error('Invalid Curator thresholds');
      db.prepare('UPDATE sa_curator_policy SET stale_days=?,archive_days=? WHERE id=1').run(staleDays, archiveDays);
      return this.curatorPolicy();
    },
    saveOwnedSkill({ id, body, source, expectedVersion = 0, now = Date.now() }) {
      validId(id); validTime(now);
      if (typeof body !== 'string' || !body.trim() || body.length > 100000) throw new Error('Invalid skill body');
      if (!source || typeof source !== 'object' || Array.isArray(source) || !Object.keys(source).length) throw new Error('Skill source required');
      const serialized = JSON.stringify(source);
      if (serialized.length > 16000) throw new Error('Skill source too large');
      return tx(() => {
        const previous = get(id);
        if ((previous?.version ?? 0) !== expectedVersion) throw new Error('Owned skill version conflict');
        if (previous?.fixed) throw new Error('Fixed skill cannot be rewritten');
        if (previous?.state === 'archived') throw new Error('Restore archived skill before editing');
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
        if (row.state === 'archived') throw new Error('Archived skill cannot be used');
        db.prepare('INSERT INTO sa_skill_uses VALUES(?,?,?)').run(eventId, id, now);
        db.prepare("UPDATE sa_owned_skills SET last_used_at=max(last_used_at,?),state='active',version=version+1,updated_at=max(updated_at,?) WHERE id=?").run(now, now, id);
        audit(id, 'use', now); return get(id);
      });
    },
    curateOwnedSkills({ now = Date.now() } = {}) {
      validTime(now);
      return tx(() => {
        const policy = this.curatorPolicy(), changed = [];
        for (const row of this.listOwnedSkills()) {
          if (row.fixed || row.state === 'archived') continue;
          const age = now - row.lastUsedAt;
          const state = age >= policy.archiveDays * DAY ? 'archived' : age >= policy.staleDays * DAY ? 'stale' : row.state;
          if (state === row.state) continue;
          db.prepare('UPDATE sa_owned_skills SET state=?,version=version+1,updated_at=? WHERE id=?').run(state, now, row.id);
          audit(row.id, state, now); changed.push(get(row.id));
        }
        return changed;
      });
    },
    restoreOwnedSkill(id, { expectedVersion, snapshotSeq, now = Date.now() }) {
      validTime(now);
      return tx(() => {
        const row = expect(id, expectedVersion);
        if (row.fixed && snapshotSeq !== undefined) throw new Error('Fixed skill cannot be rewritten');
        const snapshot = snapshotSeq === undefined ? row : db.prepare('SELECT body,hash FROM sa_skill_audit WHERE skill_id=? AND seq=?').get(id, snapshotSeq);
        if (!snapshot) throw new Error('Skill snapshot not found');
        db.prepare("UPDATE sa_owned_skills SET body=?,hash=?,state='active',last_used_at=max(last_used_at,?),version=version+1,updated_at=? WHERE id=?").run(snapshot.body, snapshot.hash, now, now, id);
        audit(id, snapshotSeq === undefined ? 'restore' : 'rollback', now); return get(id);
      });
    },
  };
}
