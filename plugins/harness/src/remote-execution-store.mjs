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
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS execution_owners(principal TEXT PRIMARY KEY, owner_host_id TEXT NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS executions(id TEXT PRIMARY KEY, principal TEXT NOT NULL, owner_host_id TEXT NOT NULL,
      task_id TEXT NOT NULL, assignment_id TEXT NOT NULL, run_id TEXT NOT NULL, fence INTEGER NOT NULL,
      session_id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL, UNIQUE(owner_host_id,task_id,assignment_id,run_id,fence));
    CREATE INDEX IF NOT EXISTS execution_assignment ON executions(owner_host_id,task_id,assignment_id,fence);
    CREATE TABLE IF NOT EXISTS execution_commands(principal TEXT NOT NULL, request_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL, execution_id TEXT NOT NULL REFERENCES executions(id), payload TEXT NOT NULL,
      PRIMARY KEY(principal,request_id));
    CREATE TABLE IF NOT EXISTS execution_events(execution_id TEXT NOT NULL REFERENCES executions(id), seq INTEGER NOT NULL,
      kind TEXT NOT NULL, data TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY(execution_id,seq));`);
  const tx = fn => { db.exec('BEGIN IMMEDIATE'); try { const value = fn(); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; } };
  const decode = row => row && JSON.parse(row.payload);
  const get = id => decode(db.prepare('SELECT payload FROM executions WHERE id=?').get(id));
  const save = row => { row.updatedAt = new Date().toISOString(); db.prepare('UPDATE executions SET payload=? WHERE id=?').run(JSON.stringify(row), row.id); return row; };
  const event = (id, kind, data) => {
    const seq = db.prepare('SELECT coalesce(max(seq),0)+1 AS seq FROM execution_events WHERE execution_id=?').get(id).seq;
    const at = new Date().toISOString();
    db.prepare('INSERT INTO execution_events VALUES(?,?,?,?,?)').run(id, seq, kind, JSON.stringify(data), at);
    return { seq, kind, data, at };
  };
  const receipt = (principal, requestId, input) => {
    const prior = db.prepare('SELECT * FROM execution_commands WHERE principal=? AND request_id=?').get(principal, requestId);
    if (prior && input !== undefined && prior.fingerprint !== commandFingerprint(input)) throw executionError('EXECUTION_COMMAND_CONFLICT', '同一请求 ID 不能改变执行命令');
    return prior && { ...JSON.parse(prior.payload), executionId: prior.execution_id };
  };
  const recordCommand = (principal, input, id, result = {}) => {
    db.prepare('INSERT INTO execution_commands VALUES(?,?,?,?,?)').run(principal, input.requestId, commandFingerprint(input), id, JSON.stringify(result));
    return result;
  };
  const bind = (principal, ownerHostId) => {
    const existing = db.prepare('SELECT owner_host_id FROM execution_owners WHERE principal=?').get(principal);
    if (existing && existing.owner_host_id !== ownerHostId) throw executionError('EXECUTION_OWNER_CHANGED', '认证设备已绑定其他业务宿主，拒绝改变工单归属', 403);
    const other = db.prepare('SELECT principal FROM execution_owners WHERE owner_host_id=?').get(ownerHostId);
    if (other && other.principal !== principal) throw executionError('EXECUTION_OWNER_CHANGED', '业务宿主已绑定其他设备授权，需显式迁移', 403);
    if (!existing) db.prepare('INSERT INTO execution_owners VALUES(?,?)').run(principal, ownerHostId);
  };
  return {
    tx, get, save, event, receipt, recordCommand,
    updateCommand(principal, requestId, result) { db.prepare('UPDATE execution_commands SET payload=? WHERE principal=? AND request_id=?').run(JSON.stringify(result), principal, requestId); },
    latest: id => db.prepare('SELECT coalesce(max(seq),0) AS seq FROM execution_events WHERE execution_id=?').get(id).seq,
    bySession: sessionId => decode(db.prepare('SELECT payload FROM executions WHERE session_id=?').get(sessionId)),
    rows: () => db.prepare('SELECT payload FROM executions').all().map(decode),
    owned(id, principal) { const row = get(id); if (!row || row.principal !== principal) throw executionError('EXECUTION_NOT_FOUND', '执行实例不存在或不属于当前认证设备', 404); return row; },
    create(principal, input, extra) {
      bind(principal, input.identity.ownerHostId);
      const i = input.identity;
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
