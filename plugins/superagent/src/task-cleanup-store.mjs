import { createHash, randomUUID } from 'node:crypto';
import { normalizeTicketTitle } from './ticket-title.mjs';
import { ticketExecutionExitedSql, ticketPresentationKey, ticketIsArchived } from './ticket-archive.mjs';

const fail = (code, message) => Object.assign(new Error(message), { code });
const copy = value => structuredClone(value);
const hash = value => createHash('sha256').update(JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item) ?? 'null').digest('hex');
const identity = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 512;
const idsOf = values => {
  if (!Array.isArray(values) || !values.length || values.length > 1000 || values.some(value => !identity(value)) || new Set(values).size !== values.length)
    throw fail('CLEANUP_INPUT_INVALID', '工单清单须为 1 至 1000 个不重复的明确 ID');
  return [...values].sort();
};
const globalOwner = scope => {
  if (scope?.owner !== 'desktop-owner' || scope?.mode !== 'global' || Object.keys(scope).some(key => !['owner', 'mode'].includes(key)))
    throw fail('CLEANUP_SCOPE_DENIED', '工单整理需要主人主聊天的全局授权范围');
  return { owner: 'desktop-owner', mode: 'global' };
};
const archiveFields = ['archived', 'archivedAt', 'cleanupReceiptId', 'archiveRevision'];
const archiveSlice = value => Object.fromEntries(archiveFields.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));

function initializeSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS task_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS task_cleanup_previews(id TEXT PRIMARY KEY, manifest_hash TEXT NOT NULL, payload TEXT NOT NULL, consumed_by TEXT);
    CREATE TABLE IF NOT EXISTS task_cleanup_receipts(id TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL, binding TEXT NOT NULL, payload TEXT NOT NULL);`);
}

/** Run on the authoritative orchestration connection before any Ticket reads. */
export function initializeTicketCleanup({ db, transaction }) {
  initializeSchema(db);
  transaction(() => {
    const rows = db.prepare("SELECT key,value FROM task_meta WHERE key LIKE 'task-presentation:ticket:%' AND json_type(value,'$.deleted') IS NOT NULL").all();
    for (const row of rows) {
      const id = row.key.slice('task-presentation:ticket:'.length), old = JSON.parse(row.value), next = { ...old };
      delete next.deleted;
      const ticket = db.prepare('SELECT id,status,instruction_revision,execution_control FROM sa_tickets WHERE id=?').get(id);
      const at = new Date().toISOString();
      next.version = (old.version ?? 0) + 1; next.updatedAt = at;
      if (old.deleted) {
        const exited = db.prepare(`SELECT ${ticketExecutionExitedSql()} AS exited FROM sa_tickets WHERE id=?`).get(id)?.exited === 1;
        const archived = !!ticket && exited && old.executionRevision === ticket.instruction_revision;
        const receiptId = randomUUID();
        for (const key of archiveFields) delete next[key];
        if (archived) Object.assign(next, { archived: true, archivedAt: old.updatedAt || at, archiveRevision: ticket.instruction_revision, cleanupReceiptId: receiptId });
        if (!Object.hasOwn(old, 'completed')) delete next.executionRevision;
        const value = { receiptId, requestId: `legacy-ticket-cleanup:${id}`, operation: 'legacy-migration', createdAt: at,
          confirmedBy: { actorId: 'system-migration', source: { kind: 'legacy-presentation' } },
          items: [{ id, instructionRevision: ticket?.instruction_revision ?? old.executionRevision, before: archiveSlice(old), after: archiveSlice(next),
            beforeVersion: old.version ?? 0, afterVersion: next.version, legacyDeleted: true }] };
        db.prepare('INSERT INTO task_cleanup_receipts(id,request_id,binding,payload) VALUES (?,?,?,?)')
          .run(receiptId, value.requestId, hash(['legacy-migration', id]), JSON.stringify(value));
      }
      db.prepare('UPDATE task_meta SET value=? WHERE key=?').run(JSON.stringify(next), row.key);
    }
  });
}

/** Same SQLite connection for manifest reads, CAS writes and durable receipts. No filesystem operations. */
export function installTaskCleanupStore({ db, transaction }) {
  initializeSchema(db);
  const confirmations = new WeakSet();
  const hasTickets = () => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sa_tickets'").get();
  const metadata = id => {
    const row = db.prepare('SELECT value FROM task_meta WHERE key=?').get(ticketPresentationKey(id));
    return row ? JSON.parse(row.value) : { version: 0 };
  };
  const putMetadata = (id, value) => db.prepare('INSERT INTO task_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(ticketPresentationKey(id), JSON.stringify(value));
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
  const readTicket = id => {
    const row = hasTickets() && db.prepare('SELECT * FROM sa_tickets WHERE id=?').get(id);
    if (!row) return null;
    const meta = metadata(id);
    const assignments = db.prepare('SELECT id,state,fence,updated_at,payload FROM sa_assignments WHERE ticket_id=? ORDER BY id').all(id);
    const runs = db.prepare('SELECT r.id,r.state,r.fence,r.updated_at,r.payload FROM sa_runs r JOIN sa_assignments a ON a.id=r.assignment_id WHERE a.ticket_id=? ORDER BY r.id').all(id);
    const executionExited = db.prepare(`SELECT ${ticketExecutionExitedSql()} AS exited FROM sa_tickets WHERE id=?`).get(id).exited === 1;
    const executionUncertain = [...assignments, ...runs].some(item => item.state === 'uncertain');
    return { id, title: normalizeTicketTitle(meta.title || row.title, row.target), status: row.status,
      instructionRevision: row.instruction_revision, resultVersion: row.result_version, updatedAt: row.updated_at,
      metaVersion: meta.version ?? 0, metaHash: hash(meta), executionHash: hash([assignments, runs]),
      archiveBefore: archiveSlice(meta), archived: ticketIsArchived({ status: row.status, instructionRevision: row.instruction_revision, executionExited }, meta),
      eligible: executionExited, executionUncertain };
  };
  const readPreview = id => {
    if (!identity(id)) throw fail('CLEANUP_INPUT_INVALID', '需要明确清单 ID');
    const row = db.prepare('SELECT payload,consumed_by FROM task_cleanup_previews WHERE id=?').get(id);
    if (!row) throw fail('CLEANUP_PREVIEW_NOT_FOUND', '清理清单不存在，请重新预览');
    return { ...JSON.parse(row.payload), consumedBy: row.consumed_by };
  };
  function previewCleanup({ scope, ids, includeUnsettled = false } = {}) {
    scope = globalOwner(scope);
    if (typeof includeUnsettled !== 'boolean') throw fail('CLEANUP_INPUT_INVALID', 'includeUnsettled 必须为布尔值');
    return transaction(() => {
      const selected = ids === undefined ? (hasTickets() ? db.prepare('SELECT id FROM sa_tickets ORDER BY created_at,id').all().map(row => row.id) : []) : idsOf(ids);
      if (selected.length > 1000) throw fail('CLEANUP_SCOPE_TOO_LARGE', '请缩小清理范围，每批最多 1000 项');
      const items = [], excluded = [];
      for (const id of selected) {
        const row = readTicket(id);
        if (!row) { excluded.push({ id, code: 'TICKET_NOT_FOUND', reason: '工单不存在' }); continue; }
        if (!row.eligible) {
          excluded.push({ id, title: row.title, status: row.status, code: 'EXECUTION_PENDING',
            reason: row.executionUncertain ? '执行退出尚未确认，请先核实原执行已退出，再重新预览'
              : '工单仍在执行或等待执行，请先停止并确认执行退出，再重新预览', requiresStopConfirmation: true,
            ...(includeUnsettled ? { snapshot: row } : {}) });
          continue;
        }
        items.push(row);
      }
      const manifest = { type: 'archive', scope, items, excluded, includeUnsettled };
      const value = { previewId: randomUUID(), createdAt: new Date().toISOString(), ...manifest, manifestHash: hash(manifest) };
      db.prepare('INSERT INTO task_cleanup_previews(id,manifest_hash,payload) VALUES (?,?,?)').run(value.previewId, value.manifestHash, JSON.stringify(value));
      return copy(value);
    });
  }
  /** Host-only capability: never expose this factory or its confirmedBy argument as model tool inputs. */
  function createConfirmation({ previewId, manifestHash, ids, actorId, source } = {}) {
    ids = idsOf(ids);
    if (actorId !== 'desktop-owner' || !source || !identity(source.sessionId) || !identity(source.messageId || source.callId)
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
        const saved = latest.items.find(row => row.id === id), current = readTicket(id);
        if (!saved || !current || !current.eligible || hash(saved) !== hash(current)) throw fail('CLEANUP_CONFLICT', '清单或工单已变化，请重新预览并确认');
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
        const frozen = latest.items.find(row => row.id === id), saved = original.items.find(row => row.id === id), current = metadata(id), ticket = readTicket(id);
        if (!frozen || !saved || !ticket || hash(ticket) !== frozen.stateHash || current.version !== latest.versions[id]
          || current.cleanupReceiptId !== original.receiptId || ticket.instructionRevision !== saved.instructionRevision)
          throw fail('CLEANUP_CONFLICT', '归档记录已变化，请重新核对恢复范围');
        return { saved, current, ticket };
      });
      const nextReceiptId = randomUUID(), createdAt = new Date().toISOString();
      const items = selected.map(({ saved, current, ticket }) => {
        const next = { ...current };
        for (const key of archiveFields) delete next[key];
        Object.assign(next, saved.before, { version: current.version + 1, updatedAt: createdAt });
        putMetadata(saved.id, next);
        return { id: saved.id, status: ticket.status, before: archiveSlice(current), after: archiveSlice(next), beforeVersion: current.version, afterVersion: next.version };
      });
      const value = saveReceipt({ receiptId: nextReceiptId, previewId, restores: original.receiptId, operation: 'restore', requestId,
        manifestHash: latest.manifestHash, scope: latest.scope, createdAt,
        confirmedBy: { actorId: confirmedBy.actorId, source: confirmedBy.source, ids }, items }, binding);
      db.prepare('UPDATE task_cleanup_previews SET consumed_by=? WHERE id=? AND consumed_by IS NULL').run(nextReceiptId, previewId);
      return value;
    });
  }
  function previewRestore({ scope, receiptId, ids } = {}) {
    scope = globalOwner(scope);
    return transaction(() => {
      const original = receipt(receiptId);
      if (!original || !['archive', 'legacy-migration'].includes(original.operation)) throw fail('CLEANUP_RECEIPT_NOT_FOUND', '归档回执不存在');
      ids = idsOf(ids ?? original.items.map(row => row.id));
      const items = ids.map(id => {
        const saved = original.items.find(row => row.id === id), current = metadata(id), ticket = readTicket(id);
        if (!saved || !ticket || current.cleanupReceiptId !== receiptId || ticket.instructionRevision !== saved.instructionRevision)
          throw fail('CLEANUP_CONFLICT', '归档记录已变化，请重新核对恢复范围');
        return { id, title: ticket.title, status: ticket.status, metaVersion: current.version,
          stateHash: hash(ticket) };
      });
      const versions = Object.fromEntries(items.map(row => [row.id, row.metaVersion]));
      const manifest = { type: 'restore', receiptId, ids, scope, versions, items };
      const value = { previewId: randomUUID(), createdAt: new Date().toISOString(), ...manifest, manifestHash: hash(manifest) };
      db.prepare('INSERT INTO task_cleanup_previews(id,manifest_hash,payload) VALUES (?,?,?)').run(value.previewId, value.manifestHash, JSON.stringify(value));
      return value;
    });
  }
  return { previewCleanup, getCleanupPreview: readPreview, commitCleanup, previewRestore, restoreCleanup, createConfirmation,
    cleanupHistory({ ticketId, limit = 100 } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000 || ticketId !== undefined && !identity(ticketId))
        throw fail('CLEANUP_INPUT_INVALID', '无效清理历史查询');
      const where = ticketId === undefined ? '' : " WHERE EXISTS (SELECT 1 FROM json_each(task_cleanup_receipts.payload,'$.items') item WHERE json_extract(item.value,'$.id')=?)";
      return db.prepare(`SELECT payload FROM task_cleanup_receipts${where} ORDER BY rowid DESC LIMIT ?`)
        .all(...(ticketId === undefined ? [] : [ticketId]), limit).map(row => JSON.parse(row.payload));
    } };
}
