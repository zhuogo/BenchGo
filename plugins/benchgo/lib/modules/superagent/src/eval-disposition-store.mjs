import { randomUUID } from 'node:crypto';

const fail = (code, message) => Object.assign(new Error(message), { code });

/** Human disposition shares the candidate transaction; it never grants execution authority. */
export function installEvalDispositionStore({ db, tx, api }) {
  db.exec(`CREATE TABLE IF NOT EXISTS sa_eval_dispositions(
    seq INTEGER PRIMARY KEY AUTOINCREMENT, candidate_id TEXT NOT NULL REFERENCES sa_candidates(id),
    action TEXT NOT NULL, actor TEXT NOT NULL, reason TEXT NOT NULL, policy_version TEXT NOT NULL,
    created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS sa_eval_dispositions_candidate ON sa_eval_dispositions(candidate_id,seq);`);
  const revision = candidateId => db.prepare('SELECT COALESCE(MAX(seq),0) AS version FROM sa_eval_dispositions WHERE candidate_id=?').get(candidateId).version;
  const value = row => row && ({ id: row.id, triggerId: row.trigger_id, threadId: row.thread_id,
    status: row.status, retryCount: row.retry_count, policyVersion: row.policy_version,
    updatedAt: row.updated_at, dispositionRevision: revision(row.id), trigger: api.getTrigger(row.trigger_id) });
  return {
    getEvaluation(candidateId) { return value(db.prepare('SELECT * FROM sa_candidates WHERE id=?').get(candidateId)); },
    unavailableEvaluations({ after = 0, limit = 50 } = {}) {
      if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('评估列表分页无效');
      const rows = db.prepare("SELECT rowid AS cursor,* FROM sa_candidates WHERE status='unavailable' AND rowid>? ORDER BY rowid LIMIT ?").all(after, limit + 1);
      return { candidates: rows.slice(0, limit).map(value), next: rows.length > limit ? rows[limit - 1].cursor : null };
    },
    evaluationDispositionHistory(candidateId) {
      return db.prepare('SELECT seq,action,actor,reason,policy_version AS policyVersion,created_at AS createdAt FROM sa_eval_dispositions WHERE candidate_id=? ORDER BY seq').all(candidateId);
    },
    disposeUnavailableEvaluation(candidateId, { action, expectedRevision, expectedUpdatedAt, policyVersion, actor, reason = '' } = {}) {
      if (!['retry', 'ignore'].includes(action)) throw new Error('仅支持重新评估或忽略');
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || typeof expectedUpdatedAt !== 'string') throw new Error('缺少评估版本');
      if (typeof policyVersion !== 'string' || !policyVersion || typeof actor !== 'string' || !actor) throw new Error('缺少现行规则或操作身份');
      if (typeof reason !== 'string' || reason.length > 2000) throw new Error('处置说明最多 2000 字');
      return tx(() => {
        const row = db.prepare('SELECT * FROM sa_candidates WHERE id=?').get(candidateId);
        if (!row) throw fail('CANDIDATE_NOT_FOUND', '候选不存在');
        if (row.status !== 'unavailable' || revision(candidateId) !== expectedRevision || row.updated_at !== expectedUpdatedAt) throw fail('REVISION_CONFLICT', '评估状态已变化，请刷新后操作');
        if (db.prepare('SELECT 1 FROM sa_decisions WHERE candidate_id=?').get(candidateId)) throw fail('DECISION_EXISTS', '候选已有处置');
        const at = new Date().toISOString();
        db.prepare('INSERT INTO sa_eval_dispositions(candidate_id,action,actor,reason,policy_version,created_at) VALUES (?,?,?,?,?,?)')
          .run(candidateId, action, actor, reason.trim(), policyVersion, at);
        if (action === 'retry') {
          db.prepare("UPDATE sa_candidates SET status='queued',eval_id=NULL,retry_count=0,policy_version=?,updated_at=? WHERE id=?").run(policyVersion, at, candidateId);
        } else {
          db.prepare('INSERT INTO sa_decisions VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(), candidateId, row.thread_id, 'ignore',
            JSON.stringify({ reason: reason.trim() || '人工忽略超时候选', source: 'human-disposition', actor }), policyVersion, null, at);
          db.prepare("UPDATE sa_candidates SET status='decided',eval_id=NULL,updated_at=? WHERE id=?").run(at, candidateId);
        }
        return value(db.prepare('SELECT * FROM sa_candidates WHERE id=?').get(candidateId));
      });
    },
  };
}
