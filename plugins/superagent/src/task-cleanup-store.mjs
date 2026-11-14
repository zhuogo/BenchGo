import { createHash, randomUUID } from 'node:crypto';
import { normalizeTaskTitle } from './task-title.mjs';
import { taskExecutionExitedSql, taskPresentationKey, taskIsArchived, taskArchiveSql } from './task-archive.mjs';

const fail = (code, message) => Object.assign(new Error(message), { code });
const copy = value => structuredClone(value);
const hash = value => createHash('sha256').update(JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item) ?? 'null').digest('hex');
const identity = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 512;
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
const archiveFields = ['archived', 'archivedAt', 'cleanupReceiptId', 'archiveRevision'];
const archiveSlice = value => Object.fromEntries(archiveFields.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
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

/** Same SQLite connection for manifest reads, CAS writes and durable receipts. No filesystem operations. */
export function installTaskCleanupStore({ db, transaction, now = Date.now }) {
  initializeSchema(db);
  pruneExpiredPreviews(db, now());
  const confirmations = new WeakSet();
  const hasTasks = () => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sa_tasks'").get();
  const metadata = id => {
    const row = db.prepare('SELECT value FROM task_meta WHERE key=?').get(taskPresentationKey(id));
    return row ? JSON.parse(row.value) : { version: 0 };
  };
  const putMetadata = (id, value) => db.prepare('INSERT INTO task_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(taskPresentationKey(id), JSON.stringify(value));
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
    const row = hasTasks() && db.prepare('SELECT * FROM sa_tasks WHERE id=?').get(id);
    if (!row) return null;
    const meta = metadata(id);
    const assignments = db.prepare('SELECT id,state,fence,updated_at,payload FROM sa_assignments WHERE task_id=? ORDER BY id').all(id);
    const runs = db.prepare('SELECT r.id,r.state,r.fence,r.updated_at,r.payload FROM sa_runs r JOIN sa_assignments a ON a.id=r.assignment_id WHERE a.task_id=? ORDER BY r.id').all(id);
    const executionExited = db.prepare(`SELECT ${taskExecutionExitedSql()} AS exited FROM sa_tasks WHERE id=?`).get(id).exited === 1;
    const executionUncertain = [...assignments, ...runs].some(item => item.state === 'uncertain');
    return { id, title: normalizeTaskTitle(meta.title || row.title, row.target), status: row.status,
      instructionRevision: row.instruction_revision, resultVersion: row.result_version, updatedAt: row.updated_at,
      metaVersion: meta.version ?? 0, metaHash: hash(meta), executionHash: hash([assignments, runs]),
      archiveBefore: archiveSlice(meta), archived: taskIsArchived({ status: row.status, instructionRevision: row.instruction_revision, executionExited }, meta),
      eligible: executionExited, executionUncertain };
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
  function previewCleanup({ scope, ids, includeUnsettled = false } = {}) {
    scope = globalScope(scope);
    if (typeof includeUnsettled !== 'boolean') throw fail('CLEANUP_INPUT_INVALID', 'includeUnsettled 必须为布尔值');
    return transaction(() => {
      const selected = ids === undefined ? (hasTasks() ? db.prepare(`SELECT id FROM sa_tasks WHERE NOT ${taskArchiveSql()} ORDER BY created_at,id LIMIT 1001`).all().map(row => row.id) : []) : idsOf(ids);
      if (selected.length > 1000) throw fail('CLEANUP_SCOPE_TOO_LARGE', '请缩小清理范围，每批最多 1000 项');
      const items = [], excluded = [];
      for (const id of selected) {
        const row = readTask(id);
        if (!row) { excluded.push({ id, code: 'TASK_NOT_FOUND', reason: '任务不存在' }); continue; }
        if (row.archived) { excluded.push({ id, title: row.title, status: row.status, code: 'TASK_ALREADY_ARCHIVED', reason: '任务已归档，无需重复整理' }); continue; }
        if (!row.eligible) {
          excluded.push({ id, title: row.title, status: row.status, code: 'EXECUTION_PENDING',
            reason: row.executionUncertain ? '执行退出尚未确认，请先核实原执行已退出，再重新预览'
              : '任务仍在执行或等待执行，请先停止并确认执行退出，再重新预览', requiresStopConfirmation: true,
            ...(includeUnsettled ? { snapshot: row } : {}) });
          continue;
        }
        items.push(row);
      }
      const manifest = { type: 'archive', scope, items, excluded, includeUnsettled };
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
  function commitCleanup({ previewId, ids, confirmedBy, requestId } = {}) {
    ids = idsOf(ids);
    const preview = readPreview(previewId);
    if (preview.type !== 'archive') throw fail('CLEANUP_INPUT_INVALID', '此清单不属于归档操作');
    requireConfirmation(confirmedBy, { previewId, manifestHash: preview.manifestHash, ids });
    const binding = hash(['archive', previewId, ids, confirmedBy.actorId, confirmedBy.source]);
    return transaction(() => {
      const previous = previousRequest(requestId, binding);
      if (previous) return previous;
      const latest = readPreview(previewId);
      if (latest.consumedBy) throw fail('CLEANUP_PREVIEW_CONSUMED', '清理清单已使用，请重新预览');
      const selected = ids.map(id => {
        const saved = latest.items.find(row => row.id === id), current = readTask(id);
        if (!saved || !current || !current.eligible || hash(saved) !== hash(current)) throw fail('CLEANUP_CONFLICT', '清单或任务已变化，请重新预览并确认');
        return current;
      });
      const receiptId = randomUUID(), createdAt = new Date().toISOString();
      const items = selected.map(row => {
        const before = metadata(row.id), next = { ...before, archived: true, archivedAt: createdAt,
          cleanupReceiptId: receiptId, archiveRevision: row.instructionRevision, version: row.metaVersion + 1, updatedAt: createdAt };
        putMetadata(row.id, next);
        return { id: row.id, status: row.status, instructionRevision: row.instructionRevision,
          before: archiveSlice(before), after: archiveSlice(next), beforeVersion: row.metaVersion, afterVersion: next.version };
      });
      const value = saveReceipt({ receiptId, previewId, requestId, operation: 'archive', manifestHash: preview.manifestHash,
        scope: preview.scope, createdAt, confirmedBy: { actorId: confirmedBy.actorId, source: confirmedBy.source, ids }, items }, binding);
      db.prepare('UPDATE task_cleanup_previews SET consumed_by=? WHERE id=? AND consumed_by IS NULL').run(receiptId, previewId);
      return copy(value);
    });
  }
  function restoreCleanup({ previewId, ids, confirmedBy, requestId } = {}) {
    const preview = readPreview(previewId);
    if (preview.type !== 'restore') throw fail('CLEANUP_INPUT_INVALID', '此清单不属于恢复操作');
    ids = idsOf(ids);
    requireConfirmation(confirmedBy, { previewId, manifestHash: preview.manifestHash, ids });
    const binding = hash(['restore', previewId, ids, confirmedBy.actorId, confirmedBy.source]);
    return transaction(() => {
      const previous = previousRequest(requestId, binding);
      if (previous) return previous;
      const latest = readPreview(previewId), original = receipt(latest.receiptId);
      if (latest.consumedBy) throw fail('CLEANUP_PREVIEW_CONSUMED', '恢复清单已使用，请重新预览');
      if (!original) throw fail('CLEANUP_RECEIPT_NOT_FOUND', '归档回执不存在');
      const selected = ids.map(id => {
        const frozen = latest.items.find(row => row.id === id), saved = original.items.find(row => row.id === id), current = metadata(id), task = readTask(id);
        if (!frozen || !saved || !task || hash(task) !== frozen.stateHash || current.version !== latest.versions[id]
          || current.cleanupReceiptId !== original.receiptId || task.instructionRevision !== saved.instructionRevision)
          throw fail('CLEANUP_CONFLICT', '归档记录已变化，请重新核对恢复范围');
        return { saved, current, task };
      });
      const nextReceiptId = randomUUID(), createdAt = new Date().toISOString();
      const items = selected.map(({ saved, current, task }) => {
        const next = { ...current };
        for (const key of archiveFields) delete next[key];
        Object.assign(next, saved.before, { version: current.version + 1, updatedAt: createdAt });
        putMetadata(saved.id, next);
        return { id: saved.id, status: task.status, before: archiveSlice(current), after: archiveSlice(next), beforeVersion: current.version, afterVersion: next.version };
      });
      const value = saveReceipt({ receiptId: nextReceiptId, previewId, restores: original.receiptId, operation: 'restore', requestId,
        manifestHash: latest.manifestHash, scope: latest.scope, createdAt,
        confirmedBy: { actorId: confirmedBy.actorId, source: confirmedBy.source, ids }, items }, binding);
      db.prepare('UPDATE task_cleanup_previews SET consumed_by=? WHERE id=? AND consumed_by IS NULL').run(nextReceiptId, previewId);
      return value;
    });
  }
  function previewRestore({ scope, receiptId, ids } = {}) {
    scope = globalScope(scope);
    return transaction(() => {
      const original = receipt(receiptId);
      if (original?.operation !== 'archive') throw fail('CLEANUP_RECEIPT_NOT_FOUND', '归档回执不存在');
      ids = idsOf(ids ?? original.items.map(row => row.id));
      const items = ids.map(id => {
        const saved = original.items.find(row => row.id === id), current = metadata(id), task = readTask(id);
        if (!saved || !task || current.cleanupReceiptId !== receiptId || task.instructionRevision !== saved.instructionRevision)
          throw fail('CLEANUP_CONFLICT', '归档记录已变化，请重新核对恢复范围');
        return { id, title: task.title, status: task.status, metaVersion: current.version,
          stateHash: hash(task) };
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
  return { previewCleanup, getCleanupPreview: readPreview, commitCleanup, previewRestore, restoreCleanup, createConfirmation,
    receiptForRequest(requestId) {
      if (!identity(requestId)) throw fail('CLEANUP_INPUT_INVALID', '需要明确清理请求标识');
      const row = db.prepare('SELECT payload FROM task_cleanup_receipts WHERE request_id=?').get(requestId);
      return row ? JSON.parse(row.payload) : null;
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
