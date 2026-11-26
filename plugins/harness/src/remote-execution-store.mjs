import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export const executionError = (code, message, status = 409) => Object.assign(new Error(message), { code, status });
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])])) : value;
export const executionFingerprint = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const commandFingerprint = ({ after, limit, ...command }) => executionFingerprint(command);
export const executionTerminal = phase => ['completed', 'stopped', 'failed', 'uncertain'].includes(phase);

/** Execution transport journal only. Business Tasks and scheduling belong to the owner host. */
export function openRemoteExecutionStore(directory) {
  mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(join(directory, 'executions.db'));
  const tx = fn => { db.exec('BEGIN IMMEDIATE'); try { const value = fn(); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; } };
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
    tx(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS execution_owners(principal TEXT PRIMARY KEY, owner_host_id TEXT NOT NULL, verified_source_host_id TEXT);`);
      if (!db.prepare("SELECT 1 FROM pragma_table_info('execution_owners') WHERE name='verified_source_host_id'").get()) {
        db.exec(`ALTER TABLE execution_owners RENAME TO execution_owners_legacy;
          CREATE TABLE execution_owners(principal TEXT PRIMARY KEY, owner_host_id TEXT NOT NULL, verified_source_host_id TEXT);
          INSERT INTO execution_owners(principal,owner_host_id) SELECT principal,owner_host_id FROM execution_owners_legacy;
          DROP TABLE execution_owners_legacy;`);
      }
      db.exec(`CREATE INDEX IF NOT EXISTS execution_owner_host ON execution_owners(owner_host_id);
        CREATE TABLE IF NOT EXISTS executions(id TEXT PRIMARY KEY, principal TEXT NOT NULL, owner_host_id TEXT NOT NULL,
          task_id TEXT NOT NULL, assignment_id TEXT NOT NULL, run_id TEXT NOT NULL, fence INTEGER NOT NULL,
          session_id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL, UNIQUE(owner_host_id,task_id,assignment_id,run_id,fence));
        CREATE INDEX IF NOT EXISTS execution_assignment ON executions(owner_host_id,task_id,assignment_id,fence);
        CREATE TABLE IF NOT EXISTS execution_commands(principal TEXT NOT NULL, request_id TEXT NOT NULL,
          fingerprint TEXT NOT NULL, execution_id TEXT NOT NULL REFERENCES executions(id), payload TEXT NOT NULL,
          PRIMARY KEY(principal,request_id));
        CREATE TABLE IF NOT EXISTS execution_events(execution_id TEXT NOT NULL REFERENCES executions(id), seq INTEGER NOT NULL,
          kind TEXT NOT NULL, data TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY(execution_id,seq));
        CREATE INDEX IF NOT EXISTS execution_progress ON execution_events(execution_id, seq) WHERE kind='execution.progress';`);
      db.exec(`CREATE TABLE IF NOT EXISTS execution_session_archives(
        id INTEGER PRIMARY KEY, execution_id TEXT NOT NULL REFERENCES executions(id),
        principal TEXT NOT NULL, at TEXT NOT NULL, instruction_revision INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS execution_session_archive_principal ON execution_session_archives(principal,id);`);
    });
  } catch (error) { db.close(); throw error; }
  const decode = row => row && JSON.parse(row.payload);
  const get = id => decode(db.prepare('SELECT payload FROM executions WHERE id=?').get(id));
  const save = row => { row.updatedAt = new Date().toISOString(); db.prepare('UPDATE executions SET payload=? WHERE id=?').run(JSON.stringify(row), row.id); return row; };
  const event = (id, kind, data) => {
    const seq = db.prepare('SELECT coalesce(max(seq),0)+1 AS seq FROM execution_events WHERE execution_id=?').get(id).seq;
    const at = new Date().toISOString();
    db.prepare('INSERT INTO execution_events VALUES(?,?,?,?,?)').run(id, seq, kind, JSON.stringify(data), at);
    return { seq, kind, data, at };
  };
  const latestProgress = db.prepare("SELECT data FROM execution_events WHERE execution_id=? AND kind='execution.progress' ORDER BY seq DESC LIMIT 1");
  const receipt = (principal, requestId, input) => {
    const prior = db.prepare('SELECT * FROM execution_commands WHERE principal=? AND request_id=?').get(principal, requestId);
    if (prior && input !== undefined && prior.fingerprint !== commandFingerprint(input)) throw executionError('EXECUTION_COMMAND_CONFLICT', '同一请求 ID 不能改变执行命令');
    return prior && { ...JSON.parse(prior.payload), executionId: prior.execution_id };
  };
  const recordCommand = (principal, input, id, result = {}) => {
    db.prepare('INSERT INTO execution_commands VALUES(?,?,?,?,?)').run(principal, input.requestId, commandFingerprint(input), id, JSON.stringify(result));
    return result;
  };
  const bindOwner = (principal, ownerHostId, verifiedSourceHostId) => {
    const existing = db.prepare('SELECT owner_host_id,verified_source_host_id FROM execution_owners WHERE principal=?').get(principal);
    if (existing) {
      if (existing.owner_host_id !== ownerHostId || existing.verified_source_host_id && verifiedSourceHostId && existing.verified_source_host_id !== verifiedSourceHostId)
        throw executionError('EXECUTION_OWNER_CHANGED', '认证设备已绑定其他来源或业务宿主，拒绝改变工单归属', 403);
      if (verifiedSourceHostId && !existing.verified_source_host_id) db.prepare('UPDATE execution_owners SET verified_source_host_id=? WHERE principal=?').run(verifiedSourceHostId, principal);
      return;
    }
    const owners = db.prepare(`SELECT count(*) AS total,count(verified_source_host_id) AS verified,
      count(CASE WHEN verified_source_host_id=? THEN 1 END) AS matching FROM execution_owners WHERE owner_host_id=?`).get(verifiedSourceHostId, ownerHostId);
    if (owners.total && (!verifiedSourceHostId || owners.verified && !owners.matching))
      throw executionError('EXECUTION_OWNER_CHANGED', '业务宿主已绑定其他设备授权，需要核验同一来源宿主', 403);
    db.prepare('INSERT INTO execution_owners VALUES(?,?,?)').run(principal, ownerHostId, verifiedSourceHostId);
  };
  return {
    tx, get, save, event, receipt, recordCommand, bindOwner,
    progress(id) { const row = latestProgress.get(id); return row ? JSON.parse(row.data) : null; },
    publishProgress(id, snapshot) {
      if (snapshot && JSON.stringify(snapshot) !== latestProgress.get(id)?.data) event(id, 'execution.progress', snapshot);
    },
    updateCommand(principal, requestId, result) { db.prepare('UPDATE execution_commands SET payload=? WHERE principal=? AND request_id=?').run(JSON.stringify(result), principal, requestId); },
    latest: id => db.prepare('SELECT coalesce(max(seq),0) AS seq FROM execution_events WHERE execution_id=?').get(id).seq,
    bySession: sessionId => decode(db.prepare('SELECT payload FROM executions WHERE session_id=?').get(sessionId)),
    rows: () => db.prepare('SELECT payload FROM executions').all().map(decode),
    archiveSession(row, archived) {
      if (Boolean(row.sessionArchived) === archived) return;
      row.sessionArchived = archived;
      row.sessionArchiveInstructionRevision = row.receivedInstructionRevision;
      row.sessionArchiveCursor = Number(db.prepare('INSERT INTO execution_session_archives(execution_id,principal,at,instruction_revision) VALUES(?,?,?,?)')
        .run(row.id, row.principal, new Date().toISOString(), row.sessionArchiveInstructionRevision).lastInsertRowid);
      save(row);
    },
    sessionArchives(principal, after, limit) {
      return db.prepare(`SELECT a.id AS cursor,a.at,a.instruction_revision,e.payload FROM execution_session_archives a JOIN executions e ON e.id=a.execution_id
        WHERE a.principal=? AND a.id>? ORDER BY a.id LIMIT ?`).all(principal, after, limit).map(item => {
        const row = JSON.parse(item.payload);
        return { cursor: item.cursor, at: item.at, executionId: row.id, sessionId: row.sessionId, identity: row.identity, instructionRevision: item.instruction_revision,
          state: { archived: Boolean(row.sessionArchived), cursor: row.sessionArchiveCursor, instructionRevision: row.sessionArchiveInstructionRevision } };
      });
    },
    owned(id, principal) { const row = get(id); if (!row || row.principal !== principal) throw executionError('EXECUTION_NOT_FOUND', '执行实例不存在或不属于当前认证设备', 404); return row; },
    create(principal, input, extra, verifiedSourceHostId = null) {
      const i = input.identity;
      bindOwner(principal, i.ownerHostId, verifiedSourceHostId);
      if (db.prepare('SELECT 1 FROM executions WHERE owner_host_id=? AND task_id=? AND principal<>? LIMIT 1').get(i.ownerHostId, i.taskId, principal))
        throw executionError('EXECUTION_OWNER_CHANGED', '原工单仍归原设备授权，重新配对后可派发新工单', 403);
      const prior = db.prepare('SELECT id,fence,payload FROM executions WHERE owner_host_id=? AND task_id=? AND assignment_id=? ORDER BY fence DESC LIMIT 1').get(i.ownerHostId, i.taskId, i.assignmentId);
      if (prior && prior.fence >= i.fence) throw executionError('EXECUTION_FENCE_CONFLICT', '执行租约已存在或已过期');
      const previous = prior && JSON.parse(prior.payload);
      if (previous && (!previous.writerReleasedAt || !['completed', 'stopped', 'failed'].includes(previous.phase)
        || previous.phase === 'completed' && (previous.evidence?.completion?.kind !== 'completed' || previous.evidence?.executionEffects?.effectsVerified !== true)
        || previous.phase === 'failed' && previous.submittedAt)) throw executionError('EXECUTION_STILL_ACTIVE', '前一执行尚未停止或副作用未核实，拒绝并行重放');
      const row = { id: input.executionId, principal, identity: structuredClone(i), sessionId: input.sessionId, submitRequestId: input.requestId,
        config: structuredClone(input.config), requirements: structuredClone(input.requirements), text: input.text,
        receivedInstructionRevision: input.requirements.instructionRevision, appliedInstructionRevision: 0,
        phase: 'accepted', sessionOwned: false, ackThrough: 0, messages: [], pendingInputs: [], pendingCommands: [{ requestId: input.requestId, kind: 'submit' }], createdAt: new Date().toISOString(), ...extra };
      row.updatedAt = row.createdAt;
      db.prepare('INSERT INTO executions VALUES(?,?,?,?,?,?,?,?,?)').run(row.id, principal, i.ownerHostId, i.taskId, i.assignmentId, i.runId, i.fence, row.sessionId, JSON.stringify(row));
      recordCommand(principal, input, row.id, { requestId: input.requestId, accepted: true, state: 'received', instructionRevision: null, receivedInstructionRevision: row.receivedInstructionRevision });
      event(row.id, 'execution.phase', { phase: row.phase });
      event(row.id, 'instruction.received', { instructionRevision: row.receivedInstructionRevision });
      return row;
    },
    assertFence(row) {
      const latest = db.prepare('SELECT max(fence) AS fence FROM executions WHERE owner_host_id=? AND task_id=? AND assignment_id=?').get(row.identity.ownerHostId, row.identity.taskId, row.identity.assignmentId);
      if (latest.fence !== row.identity.fence) throw executionError('EXECUTION_FENCE_CONFLICT', '执行租约已过期');
    },
    page(id, after = 0, limit = 100) {
      if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw executionError('INVALID_EXECUTION_CURSOR', '执行事件游标无效', 400);
      const events = db.prepare('SELECT * FROM execution_events WHERE execution_id=? AND seq>? ORDER BY seq LIMIT ?').all(id, after, limit + 1);
      const hasMore = events.length > limit;
      return { events: events.slice(0, limit).map(({ seq, kind, data, at }) => ({ seq, kind, data: JSON.parse(data), at })), cursor: events.slice(0, limit).at(-1)?.seq ?? after, hasMore };
    },
    close() { db.close(); },
  };
}
