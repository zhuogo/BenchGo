import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { installOwnedSkillStore } from './owned-skill-store.mjs';
import { applySettingsOps, assertSettingsExpected, settingsSnapshot } from '../../benchgo/shared/settings-adapter-utils.mjs';
import { SKILLS_POLICY_SCHEMA } from './settings-schema.mjs';

const sections = ['When to Use', 'Procedure', 'Pitfalls', 'Verification'];
export function validateOwnedSkill({ name, description, content }) {
  if (typeof name !== 'string' || name.length > 100 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error('技能名称须为小写英文与连字符');
  if (typeof description !== 'string' || !description.trim() || description.length > 1000) throw new Error('技能说明无效');
  if (typeof content !== 'string' || content.length > 16000) throw new Error('技能正文无效');
  const headings = [...content.matchAll(/^## (When to Use|Procedure|Pitfalls|Verification)\s*$/gm)];
  if (headings.length !== 4 || headings.some((match, index) => match[1] !== sections[index]
    || !content.slice(match.index + match[0].length, headings[index + 1]?.index ?? content.length).trim())) throw new Error('技能必须包含四个非空标准章节');
}

/** Candidate approval and official-provider projection around durable Curator metadata. */
export function createOwnedSkills({ directory }) {
  const db = new DatabaseSync(join(directory, 'assistant.db'));
  db.exec('PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;');
  let inTransaction = false;
  const tx = action => {
    if (inTransaction) return action();
    db.exec('BEGIN IMMEDIATE'); inTransaction = true;
    try { const result = action(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
    finally { inTransaction = false; }
  };
  const core = installOwnedSkillStore({ db, tx });
  db.exec(`CREATE TABLE IF NOT EXISTS sa_skill_candidates(id TEXT PRIMARY KEY, unique_key TEXT UNIQUE NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL, revision INTEGER NOT NULL, created_at INTEGER NOT NULL);`);
  const listeners = new Set();
  const changed = () => { for (const listener of listeners) listener(); };
  const project = row => row && ({ ...row, name: row.source.skillName, description: row.source.description, content: row.body, status: row.state, revision: row.version, pinned: row.fixed });
  const candidate = row => row && ({ ...JSON.parse(row.payload), id: row.id, status: row.state, revision: row.revision, createdAt: row.created_at, pinned: false });
  const getCandidate = id => db.prepare('SELECT * FROM sa_skill_candidates WHERE id=?').get(id);
  let closed = false;
  return {
    providerDatabase: core,
    propose(input) {
      validateOwnedSkill(input);
      if (!input.source || typeof input.source !== 'object' || !input.idempotencyKey || typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length > 500) throw new Error('技能候选缺少来源或去重标识');
      const payload = JSON.stringify({ name: input.name, description: input.description, content: input.content, source: input.source });
      if (payload.length > 24000) throw new Error('技能候选过大');
      return tx(() => {
        const previous = db.prepare('SELECT * FROM sa_skill_candidates WHERE unique_key=?').get(input.idempotencyKey);
        if (previous) return candidate(previous);
        const id = randomUUID();
        db.prepare("INSERT INTO sa_skill_candidates VALUES(?,?,?,'candidate',1,?)").run(id, input.idempotencyKey, payload, Date.now());
        return candidate(getCandidate(id));
      });
    },
    list() { return [...db.prepare("SELECT * FROM sa_skill_candidates WHERE state='candidate' ORDER BY created_at DESC").all().map(candidate), ...core.listOwnedSkills().map(project)]; },
    get(id) { return project(core.getOwnedSkill(id)) || candidate(getCandidate(id)); },
    approve(id, { revision } = {}) {
      const saved = tx(() => {
        const row = getCandidate(id), value = candidate(row);
        if (!row || row.state !== 'candidate' || row.revision !== revision) throw new Error('技能候选版本已变化');
        if (core.listOwnedSkills().some(skill => skill.source.skillName === value.name)) throw new Error('已有同名自建技能，请先检查已有版本');
        const saved = core.saveOwnedSkill({ id, body: value.content, source: { ...value.source, skillName: value.name, description: value.description } });
        db.prepare("UPDATE sa_skill_candidates SET state='approved',revision=revision+1 WHERE id=?").run(id);
        return saved;
      });
      changed(); return project(saved);
    },
    reject(id, { revision } = {}) {
      const result = db.prepare("UPDATE sa_skill_candidates SET state='rejected',revision=revision+1 WHERE id=? AND state='candidate' AND revision=?").run(id, revision);
      if (!result.changes) throw new Error('技能候选版本已变化');
      return candidate(getCandidate(id));
    },
    pin(id, { revision, pinned }) { const result = core.setOwnedSkillFixed(id, { expectedVersion: revision, fixed: pinned }); changed(); return project(result); },
    restore(id, { revision, snapshotSeq } = {}) { const result = core.restoreOwnedSkill(id, { expectedVersion: revision, snapshotSeq }); changed(); return project(result); },
    recordUse({ id, eventId, at }) { const result = core.recordOwnedSkillUse(id, { eventId, ...(at === undefined ? {} : { now: at }) }); changed(); return project(result); },
    curate(options) { const result = core.curateOwnedSkills(options); if (result.length) changed(); return result.map(project); },
    audit(id) { return core.ownedSkillAudit(id); },
    policy: () => core.curatorPolicy(),
    configurePolicy(patch, { ops, expected, signal } = {}) {
      const result = tx(() => {
        const current = core.curatorPolicy();
        if (expected || ops) assertSettingsExpected(settingsSnapshot(current), expected, signal);
        const next = ops ? applySettingsOps(current, ops, { blockedPaths: [['llmMerge']] }) : { ...current, ...patch };
        if (Object.keys(next).some(key => !Object.hasOwn(SKILLS_POLICY_SCHEMA.properties, key)) || next.llmMerge !== undefined && next.llmMerge !== false) throw new Error('技能整理策略无效');
        return core.configureCurator({ staleDays: next.staleDays ?? 14, archiveDays: next.archiveDays ?? 30 });
      });
      changed(); return result;
    },
    onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    close() { if (!closed) { closed = true; listeners.clear(); db.close(); } },
  };
}
