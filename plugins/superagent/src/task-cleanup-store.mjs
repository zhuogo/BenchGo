import { createHash, randomUUID } from 'node:crypto';
import { normalizeTaskTitle } from './task-title.mjs';
import { taskPresentationKey, taskArchiveSql } from './task-archive.mjs';

const fail = (code, message) => Object.assign(new Error(message), { code });
const copy = value => structuredClone(value);
const hash = value => createHash('sha256').update(JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item) ?? 'null').digest('hex');
const identity = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 512;
const successfulItem = "(item.value->>'$.outcome'='succeeded' OR (item.value->>'$.outcome' IS NULL AND COALESCE(item.value->>'$.archived',1)=1))";
const workerIdentity = ['sessionId', 'assignmentId', 'runId', 'fence', 'instructionRevision'];
const idsOf = values => {
  if (!Array.isArray(values) || !values.length || values.length > 1000 || values.some(value => !identity(value)) || new Set(values).size !== values.length)
    throw fail('CLEANUP_INPUT_INVALID', '任务清单须为 1 至 1000 个不重复的明确 ID');
  return [...values].sort();
};
const globalScope = scope => {
  if (scope?.mode !== 'global' || Object.keys(scope).some(key => !['owner', 'mode'].includes(key)))
    throw fail('CLEANUP_SCOPE_DENIED', '任务整理需要明确的全局清单范围');
  return { mode: 'global' };
};
export const CLEANUP_PREVIEW_TTL_MS = 24 * 60 * 60 * 1000;

// Keep expiry lookup indexed without migrating or duplicating the frozen payload.
function pruneExpiredPreviews(db, now) {
  return db.prepare(`DELETE FROM task_cleanup_previews WHERE consumed_by IS NULL
    AND json_extract(payload,'$.createdAt')<=?`).run(new Date(now - CLEANUP_PREVIEW_TTL_MS).toISOString()).changes;
}

function initializeSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS task_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS task_cleanup_previews(id TEXT PRIMARY KEY, manifest_hash TEXT NOT NULL, payload TEXT NOT NULL, consumed_by TEXT);
    CREATE TABLE IF NOT EXISTS task_cleanup_receipts(id TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL, binding TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS task_cleanup_preview_expiry ON task_cleanup_previews(json_extract(payload,'$.createdAt')) WHERE consumed_by IS NULL;`);
}

/** Run on the authoritative orchestration connection before any Task reads. */
export function initializeTaskCleanup({ db, now = Date.now }) {
  initializeSchema(db);
  pruneExpiredPreviews(db, now());
}

/**
 * Same SQLite connection for manifest reads, CAS writes and durable receipts.
 * Archival itself is delegated to the official Workspace registry; this store
 * only freezes the user's list, guards it against change and records receipts.
 */
export function installTaskCleanupStore({ db, transaction, now = Date.now, archive, unarchive }) {
  initializeSchema(db);
  pruneExpiredPreviews(db, now());
  const confirmations = new WeakSet();
  const pendingRequests = new Map(), pendingTasks = new Set();
  const hasTasks = () => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sa_tasks'").get();
  const metadata = id => {
    const row = db.prepare('SELECT value FROM task_meta WHERE key=?').get(taskPresentationKey(id));
    return row ? JSON.parse(row.value) : { version: 0 };
  };
  const receipt = id => {
    if (!identity(id)) throw fail('CLEANUP_INPUT_INVALID', '需要明确归档回执 ID');
    const row = db.prepare('SELECT payload FROM task_cleanup_receipts WHERE id=?').get(id);
    return row ? JSON.parse(row.payload) : null;
  };
  const saveReceipt = (value, binding) => {
    db.prepare('INSERT INTO task_cleanup_receipts(id,request_id,binding,payload) VALUES (?,?,?,?)')
      .run(value.receiptId, value.requestId, binding, JSON.stringify(value));
    return value;
  };
  const readTask = id => {
    const row = hasTasks() && db.prepare(`SELECT sa_tasks.*, ${taskArchiveSql()} AS archived FROM sa_tasks WHERE id=?`).get(id);
    if (!row) return null;
    const meta = metadata(id);
    const assignments = db.prepare('SELECT id,state,fence,updated_at,payload FROM sa_assignments WHERE task_id=? ORDER BY id').all(id);
    const runs = db.prepare('SELECT r.id,r.state,r.fence,r.updated_at,r.payload FROM sa_runs r JOIN sa_assignments a ON a.id=r.assignment_id WHERE a.task_id=? ORDER BY r.id').all(id);
    const executionUncertain = [...assignments, ...runs].some(item => item.state === 'uncertain');
    const latest = db.prepare(`SELECT json_extract(r.payload,'$.sessionId') AS sessionId, a.id AS assignmentId, r.id AS runId, r.fence
      FROM sa_runs r
      JOIN sa_assignments a ON a.id=r.assignment_id WHERE a.task_id=? AND r.fence=a.fence
      AND a.id=(SELECT id FROM sa_assignments WHERE task_id=a.task_id ORDER BY created_at DESC,rowid DESC LIMIT 1)
      ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1`).get(id);
    return { id, title: normalizeTaskTitle(meta.title || row.title, row.target), status: row.status,
      instructionRevision: row.instruction_revision, resultVersion: row.result_version, updatedAt: row.updated_at,
      metaVersion: meta.version ?? 0, metaHash: hash(meta), executionHash: hash([assignments, runs]),
      sessionId: latest?.sessionId || null, ...(latest ? { assignmentId: latest.assignmentId, runId: latest.runId, fence: latest.fence } : {}),
      archived: row.archived === 1, executionUncertain };
  };
  const readPreview = id => {
    if (!identity(id)) throw fail('CLEANUP_INPUT_INVALID', '需要明确清单 ID');
    const row = db.prepare('SELECT payload,consumed_by FROM task_cleanup_previews WHERE id=?').get(id);
    if (!row) throw fail('CLEANUP_PREVIEW_NOT_FOUND', '清理清单不存在，请重新预览');
    const preview = JSON.parse(row.payload);
    const expiresAt = new Date(Date.parse(preview.createdAt) + CLEANUP_PREVIEW_TTL_MS).toISOString();
    if (!row.consumed_by && Date.parse(expiresAt) <= now()) throw fail('CLEANUP_PREVIEW_EXPIRED', '清理清单已过期，请重新预览');
    return { ...preview, expiresAt, consumedBy: row.consumed_by };
  };
  /**
   * A Task with its own execution session can be archived through the official
   * registry before the executor exits.
   */
  function previewCleanup({ scope, ids } = {}) {
    scope = globalScope(scope);
    return transaction(() => {
      const selected = ids === undefined ? (hasTasks() ? db.prepare(`SELECT id FROM sa_tasks WHERE NOT ${taskArchiveSql()} ORDER BY created_at,id LIMIT 1001`).all().map(row => row.id) : []) : idsOf(ids);
      if (selected.length > 1000) throw fail('CLEANUP_SCOPE_TOO_LARGE', '请缩小清理范围，每批最多 1000 项');
      const items = [], excluded = [];
      for (const id of selected) {
        const row = readTask(id);
        if (!row) { excluded.push({ id, code: 'TASK_NOT_FOUND', reason: '任务不存在' }); continue; }
        if (row.archived) { excluded.push({ id, title: row.title, status: row.status, code: 'TASK_ALREADY_ARCHIVED', reason: '任务已归档，无需重复整理' }); continue; }
        if (!row.sessionId) {
          excluded.push({ id, title: row.title, status: row.status, code: 'NO_EXECUTION_SESSION', reason: '任务没有独立的执行会话' });
          continue;
        }
        items.push(row);
      }
      const manifest = { type: 'archive', scope, items, excluded };
      const at = now();
      pruneExpiredPreviews(db, at);
      const value = { previewId: randomUUID(), createdAt: new Date(at).toISOString(), expiresAt: new Date(at + CLEANUP_PREVIEW_TTL_MS).toISOString(), ...manifest, manifestHash: hash(manifest) };
      db.prepare('INSERT INTO task_cleanup_previews(id,manifest_hash,payload) VALUES (?,?,?)').run(value.previewId, value.manifestHash, JSON.stringify(value));
      return copy(value);
    });
  }
  /** Host-only capability: never expose this factory or its confirmedBy argument as model tool inputs. */
  function createConfirmation({ previewId, manifestHash, ids, actorId, source } = {}) {
    ids = idsOf(ids);
    if (!identity(actorId) || !source || !identity(source.sessionId) || !identity(source.messageId || source.callId)
      || !identity(manifestHash) || !identity(previewId))
      throw fail('CLEANUP_CONFIRMATION_REQUIRED', '需要绑定具体清单与来源的本次真人确认');
    const preview = readPreview(previewId);
    if (preview.manifestHash !== manifestHash || ids.some(id => !preview.items.some(row => row.id === id)))
      throw fail('CLEANUP_CONFIRMATION_REQUIRED', '确认范围超出冻结清单');
    const versions = Object.fromEntries(ids.map(id => [id, preview.items.find(row => row.id === id).metaVersion]));
    const selectionHash = hash({ previewId, manifestHash, ids, versions });
    const value = Object.freeze({ previewId, manifestHash, ids: Object.freeze(ids), selectionHash,
      actorId, source: Object.freeze(copy(source)) });
    confirmations.add(value); return value;
  }
  const requireConfirmation = (value, expected) => {
    if (!value || !confirmations.has(value) || Object.entries(expected).some(([key, next]) => hash(value[key]) !== hash(next)))
      throw fail('CLEANUP_CONFIRMATION_REQUIRED', '确认不属于本次清单或最终子集');
  };
  const previousRequest = (requestId, binding) => {
    if (!identity(requestId)) throw fail('CLEANUP_INPUT_INVALID', '清理需要稳定 requestId');
    const old = db.prepare('SELECT binding,payload FROM task_cleanup_receipts WHERE request_id=?').get(requestId);
    if (!old) return null;
    if (old.binding !== binding) throw fail('IDEMPOTENCY_CONFLICT', '清理请求标识已用于不同范围');
    return JSON.parse(old.payload);
  };
  async function executeCleanup(operation, { previewId, ids, confirmedBy, requestId } = {}) {
    ids = idsOf(ids);
    const preview = readPreview(previewId);
    if (preview.type !== operation) throw fail('CLEANUP_INPUT_INVALID', '清单类型不属于本次操作');
    requireConfirmation(confirmedBy, { previewId, manifestHash: preview.manifestHash, ids });
    const binding = hash([operation, previewId, ids, confirmedBy.actorId, confirmedBy.source]);
    const archived = operation === 'archive';
    const frozenById = new Map(preview.items.map(item => [item.id, item]));
    const conflict = () => fail('CLEANUP_CONFLICT', '清单或任务已变化，请重新预览并确认');
    const targetMatches = (frozen, current) => current?.sessionId && current.archived !== archived
      && hash(current) === (archived ? hash(frozen) : frozen.stateHash);
    const value = transaction(() => {
      const previous = previousRequest(requestId, binding);
      if (previous) return previous;
      if (preview.consumedBy) throw fail('CLEANUP_PREVIEW_CONSUMED', '清理清单已使用，请重新预览');
      const items = ids.map(id => {
        const current = readTask(id);
        if (!targetMatches(frozenById.get(id), current)) throw conflict();
        return { id, status: current.status, instructionRevision: current.instructionRevision,
          before: {}, after: {}, beforeVersion: current.metaVersion, afterVersion: current.metaVersion, outcome: 'pending' };
      });
      const receiptId = randomUUID();
      const saved = saveReceipt({ receiptId, previewId, requestId, operation, status: 'partial',
        ...(!archived ? { restores: preview.receiptId } : {}), manifestHash: preview.manifestHash, scope: preview.scope,
        createdAt: new Date(now()).toISOString(), confirmedBy: { actorId: confirmedBy.actorId, source: confirmedBy.source, ids }, items }, binding);
      db.prepare('UPDATE task_cleanup_previews SET consumed_by=? WHERE id=? AND consumed_by IS NULL').run(receiptId, previewId);
      return saved;
    });
    // Receipts written before per-item progress already represent a finished request.
    if (value.status !== 'partial') return value;
    if (pendingRequests.has(requestId)) return pendingRequests.get(requestId);
    const work = applyItems(value, frozenById, { archived, targetMatches, conflict });
    pendingRequests.set(requestId, work);
    try { return await work; }
    finally { pendingRequests.delete(requestId); }
  }

  async function applyItems(value, frozenById, { archived, targetMatches, conflict }) {
    const saveItem = (index, item) => {
      db.prepare("UPDATE task_cleanup_receipts SET payload=json_set(payload,?,json(?)) WHERE id=?")
        .run(`$.items[${index}]`, JSON.stringify(item), value.receiptId);
      value.items[index] = item;
    };
    const newerAction = db.prepare(`SELECT 1 FROM task_cleanup_receipts r, json_each(r.payload,'$.items') item
      WHERE r.rowid>(SELECT rowid FROM task_cleanup_receipts WHERE id=?)
        AND item.value->>'$.id'=? AND ${successfulItem} LIMIT 1`);
    for (const [index, item] of value.items.entries()) {
      if (item.outcome === 'succeeded') continue;
      const { id, worker: previouslyAttempted, code, reason, ...itemFields } = item;
      const current = readTask(id);
      let worker = previouslyAttempted;
      const desired = row => worker && row?.archived === archived && workerIdentity.every(key => row[key] === worker[key]);
      if (pendingTasks.has(id)) {
        saveItem(index, { ...item, outcome: 'failed', code: 'CLEANUP_BUSY', reason: '此任务的整理正在处理，请稍后重试' });
        continue;
      }
      pendingTasks.add(id);
      try {
        if (newerAction.get(value.receiptId, id)) throw conflict();
        // An official mutation may have landed before its local receipt was written.
        if (!desired(current)) {
          if (!targetMatches(frozenById.get(id), current)) throw conflict();
          worker = Object.fromEntries(workerIdentity.map(key => [key, current[key]]));
          saveItem(index, { ...itemFields, id, worker, outcome: 'pending' });
          const itemRequestId = hash([value.requestId, id]);
          await (archived ? archive : unarchive)(worker.sessionId, { ...worker, taskId: id, requestId: itemRequestId });
          if (!desired(readTask(id))) throw fail('CLEANUP_UNCONFIRMED', '尚未确认会话状态已更新，请重试');
        }
        saveItem(index, { ...itemFields, id, outcome: 'succeeded', ...(archived ? { archived: true } : { restored: true }) });
      } catch (error) {
        saveItem(index, { ...itemFields, id, ...(worker ? { worker } : {}), outcome: 'failed',
          code: error.code || 'CLEANUP_FAILED', reason: error.message || '会话整理失败' });
      } finally {
        pendingTasks.delete(id);
      }
    }
    if (value.items.every(item => item.outcome === 'succeeded')) {
      db.prepare("UPDATE task_cleanup_receipts SET payload=json_set(payload,'$.status','completed') WHERE id=?").run(value.receiptId);
      value.status = 'completed';
    }
    return value;
  }
  function previewRestore({ scope, receiptId, ids } = {}) {
    scope = globalScope(scope);
    return transaction(() => {
      const original = receipt(receiptId);
      if (original?.operation !== 'archive') throw fail('CLEANUP_RECEIPT_NOT_FOUND', '归档回执不存在');
      const archivedItems = original.items.filter(row => row.outcome === 'succeeded' || row.outcome === undefined && row.archived !== false);
      ids = idsOf(ids ?? archivedItems.map(row => row.id));
      const items = ids.map(id => {
        const saved = archivedItems.find(row => row.id === id), task = readTask(id);
        if (!saved || !task || !task.archived) throw fail('CLEANUP_CONFLICT', '归档记录已变化，请重新核对恢复范围');
        return { id, title: task.title, status: task.status, metaVersion: task.metaVersion, stateHash: hash(task) };
      });
      const versions = Object.fromEntries(items.map(row => [row.id, row.metaVersion]));
      const manifest = { type: 'restore', receiptId, ids, scope, versions, items };
      const at = now();
      pruneExpiredPreviews(db, at);
      const value = { previewId: randomUUID(), createdAt: new Date(at).toISOString(), expiresAt: new Date(at + CLEANUP_PREVIEW_TTL_MS).toISOString(), ...manifest, manifestHash: hash(manifest) };
      db.prepare('INSERT INTO task_cleanup_previews(id,manifest_hash,payload) VALUES (?,?,?)').run(value.previewId, value.manifestHash, JSON.stringify(value));
      return value;
    });
  }
  return { previewCleanup, getCleanupPreview: readPreview, previewRestore, createConfirmation,
    commitCleanup: input => executeCleanup('archive', input), restoreCleanup: input => executeCleanup('restore', input),
    receiptForRequest(requestId) {
      if (!identity(requestId)) throw fail('CLEANUP_INPUT_INVALID', '需要明确清理请求标识');
      const row = db.prepare('SELECT payload FROM task_cleanup_receipts WHERE request_id=?').get(requestId);
      return row ? JSON.parse(row.payload) : null;
    },
    /** The latest durable archive receipt for one Task: the archive pointer. */
    /** Batch form of latestArchiveReceipt for one page of Tasks. */
    archivePointers(taskIds) {
      const ids = [...new Set((Array.isArray(taskIds) ? taskIds : []).filter(identity))];
      if (!ids.length) return new Map();
      const placeholders = ids.map(() => '?').join(',');
      // One pass over archive receipts, then one pass over later restores.
      const archived = db.prepare(`SELECT item.value->>'$.id' AS taskId, r.payload AS payload, r.rowid AS seq
        FROM task_cleanup_receipts r, json_each(r.payload,'$.items') item
        WHERE json_extract(r.payload,'$.operation')='archive'
          AND ${successfulItem} AND item.value->>'$.id' IN (${placeholders}) ORDER BY r.rowid`).all(...ids);
      const restored = db.prepare(`SELECT item.value->>'$.id' AS taskId, r.rowid AS seq
        FROM task_cleanup_receipts r, json_each(r.payload,'$.items') item
        WHERE json_extract(r.payload,'$.operation')='restore'
          AND ${successfulItem} AND item.value->>'$.id' IN (${placeholders}) ORDER BY r.rowid`).all(...ids);
      const lastRestore = new Map();
      for (const row of restored) lastRestore.set(row.taskId, row.seq);
      const pointers = new Map();
      // Later rows win; the newest archive after the newest restore is current.
      for (const row of archived) {
        const restoredAt = lastRestore.get(row.taskId);
        if (restoredAt !== undefined && restoredAt > row.seq) continue;
        pointers.set(row.taskId, JSON.parse(row.payload));
      }
      return pointers;
    },
    latestArchiveReceipt(taskId) {
      if (!identity(taskId)) return null;
      const row = db.prepare(`SELECT payload FROM task_cleanup_receipts
        WHERE json_extract(payload,'$.operation')='archive'
          AND EXISTS (SELECT 1 FROM json_each(task_cleanup_receipts.payload,'$.items') item WHERE json_extract(item.value,'$.id')=? AND ${successfulItem})
        ORDER BY rowid DESC LIMIT 1`).get(taskId);
      if (!row) return null;
      const value = JSON.parse(row.payload);
      // A later restore for this Task retires its archive pointer.
      const restored = db.prepare(`SELECT 1 FROM task_cleanup_receipts
        WHERE json_extract(payload,'$.operation')='restore' AND rowid > (SELECT rowid FROM task_cleanup_receipts WHERE id=?)
          AND EXISTS (SELECT 1 FROM json_each(task_cleanup_receipts.payload,'$.items') item WHERE json_extract(item.value,'$.id')=? AND ${successfulItem}) LIMIT 1`).get(value.receiptId, taskId);
      return restored ? null : value;
    },
    cleanupHistory({ taskId, receiptId, limit = 100 } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000 || taskId !== undefined && !identity(taskId)
        || receiptId !== undefined && !identity(receiptId)) throw fail('CLEANUP_INPUT_INVALID', 'Invalid cleanup history query');
      const filters = [], args = [];
      if (receiptId !== undefined) { filters.push('id=?'); args.push(receiptId); }
      if (taskId !== undefined) {
        filters.push("EXISTS (SELECT 1 FROM json_each(task_cleanup_receipts.payload,'$.items') item WHERE json_extract(item.value,'$.id')=?)");
        args.push(taskId);
      }
      const where = filters.length ? ` WHERE ${filters.join(' AND ')}` : '';
      return db.prepare(`SELECT payload FROM task_cleanup_receipts${where} ORDER BY rowid DESC LIMIT ?`)
        .all(...args, limit).map(row => JSON.parse(row.payload));
    } };
}
