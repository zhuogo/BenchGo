import { createHash } from 'node:crypto';

const fail = (code, message) => Object.assign(new Error(message), { code });
const copy = value => structuredClone(value);
const identity = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 512;
const states = ['pending', 'completed', 'cancelled', 'conflict'];
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const only = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => fields.includes(key));
const requireId = (value, label) => {
  if (!identity(value)) throw fail('CLEANUP_CONTINUATION_INPUT', `需要明确${label}`);
  return value;
};
const idsOf = values => {
  if (!Array.isArray(values) || !values.length || values.length > 1000
    || values.some(value => !identity(value)) || new Set(values).size !== values.length)
    throw fail('CLEANUP_CONTINUATION_INPUT', '任务范围须为 1 至 1000 个不重复的明确 ID');
  return [...values].sort();
};
const decode = row => row ? { ...JSON.parse(row.payload), ...(row.notified_at ? { notifiedAt: row.notified_at } : {}) } : null;

/** Durable exact-target organization intent; no Task state or authorization is changed here. */
export function installTaskCleanupContinuationStore({ db, transaction }) {
  db.exec(`CREATE TABLE IF NOT EXISTS task_cleanup_continuations(
    id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, request_id TEXT NOT NULL,
    task_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','completed','cancelled','conflict')),
    payload TEXT NOT NULL, updated_at TEXT NOT NULL, notified_at TEXT, notice_batch_id TEXT, UNIQUE(request_id,task_id));`);
  const columns = db.prepare('PRAGMA table_info(task_cleanup_continuations)').all();
  if (!columns.some(column => column.name === 'notified_at'))
    db.exec('ALTER TABLE task_cleanup_continuations ADD COLUMN notified_at TEXT');
  if (!columns.some(column => column.name === 'notice_batch_id'))
    db.exec('ALTER TABLE task_cleanup_continuations ADD COLUMN notice_batch_id TEXT');
  db.exec(`CREATE INDEX IF NOT EXISTS task_cleanup_continuation_pending ON task_cleanup_continuations(id) WHERE status='pending';
    CREATE INDEX IF NOT EXISTS task_cleanup_continuation_notices ON task_cleanup_continuations(updated_at,id) WHERE status<>'pending' AND notified_at IS NULL;
    CREATE INDEX IF NOT EXISTS task_cleanup_continuation_notice_batch ON task_cleanup_continuations(notice_batch_id,id) WHERE notice_batch_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS task_cleanup_continuation_operation ON task_cleanup_continuations(operation_id,task_id);`);
  const get = id => decode(db.prepare('SELECT payload,notified_at FROM task_cleanup_continuations WHERE id=?').get(requireId(id, '待归档标识')));
  const rowsFor = operationId => db.prepare('SELECT payload,notified_at FROM task_cleanup_continuations WHERE operation_id=? ORDER BY task_id').all(operationId).map(decode);
  const save = value => db.prepare('UPDATE task_cleanup_continuations SET status=?,payload=?,updated_at=? WHERE id=? AND status=\'pending\'')
    .run(value.status, JSON.stringify(value), value.updatedAt, value.id).changes;
  const countsOf = operationId => Object.fromEntries(states.map(status => [status,
    db.prepare('SELECT COUNT(*) AS count FROM task_cleanup_continuations WHERE operation_id=? AND status=?').get(operationId, status).count]));

  function prepare({ requestId, source, triggerId, items } = {}) {
    requireId(requestId, '请求标识'); requireId(triggerId, '原始输入标识');
    if (!only(source, ['sessionId', 'threadId', 'messageId', 'excerpt'])
      || !identity(source.sessionId) || !identity(source.threadId) || !identity(source.messageId)
      || typeof source.excerpt !== 'string' || !source.excerpt.trim() || source.excerpt.length > 100000)
      throw fail('CLEANUP_CONTINUATION_INPUT', '待归档需要宿主绑定的真实用户输入来源');
    if (!Array.isArray(items) || !items.length || items.length > 1000
      || items.some(item => !only(item, ['id', 'instructionRevision', 'resultVersion', 'metaVersion', 'executionStamp'])
        || !identity(item.id) || !Number.isSafeInteger(item.instructionRevision) || item.instructionRevision < 1
        || !Number.isSafeInteger(item.resultVersion) || item.resultVersion < 0
        || !Number.isSafeInteger(item.metaVersion) || item.metaVersion < 0
        || item.executionStamp !== undefined && (typeof item.executionStamp !== 'string' || !/^[a-f0-9]{64}$/iu.test(item.executionStamp))))
      throw fail('CLEANUP_CONTINUATION_INPUT', '待归档需要明确任务和有效版本');
    idsOf(items.map(item => item.id));
    const sorted = items.map(item => ({ id: item.id, instructionRevision: item.instructionRevision,
      resultVersion: item.resultVersion, metaVersion: item.metaVersion,
      ...(item.executionStamp !== undefined ? { executionStamp: item.executionStamp } : {}) })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    source = { sessionId: source.sessionId, threadId: source.threadId, messageId: source.messageId, excerpt: source.excerpt };
    const binding = hash({ source, triggerId, items: sorted });
    const operationId = `cleanup:${hash(requestId)}`;
    return transaction(() => {
      const previous = rowsFor(operationId);
      if (previous.length) {
        if (previous.length !== sorted.length || previous.some(row => row.binding !== binding || row.requestId !== requestId))
          throw fail('IDEMPOTENCY_CONFLICT', '整理请求标识已用于不同的来源或任务范围');
        return { operationId, items: previous };
      }
      const at = new Date().toISOString();
      const rows = sorted.map(item => ({ id: `cleanup-item:${hash([requestId, item.id])}`, operationId, requestId,
        taskId: item.id, instructionRevision: item.instructionRevision, resultVersion: item.resultVersion, metaVersion: item.metaVersion,
        ...(item.executionStamp !== undefined ? { executionStamp: item.executionStamp } : {}),
        source: copy(source), triggerId, binding, status: 'pending', createdAt: at, updatedAt: at }));
      const insert = db.prepare('INSERT INTO task_cleanup_continuations(id,operation_id,request_id,task_id,status,payload,updated_at) VALUES (?,?,?,?,?,?,?)');
      for (const row of rows) insert.run(row.id, row.operationId, row.requestId, row.taskId, row.status, JSON.stringify(row), at);
      return { operationId, items: rows };
    });
  }
  function pending({ limit = 100, after } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw fail('CLEANUP_CONTINUATION_INPUT', '待归档读取 limit 须为 1 至 1000');
    if (after !== undefined) requireId(after, '待归档分页游标');
    return db.prepare("SELECT payload FROM task_cleanup_continuations WHERE status='pending' AND id>? ORDER BY id LIMIT ?").all(after ?? '', limit).map(decode);
  }
  function list({ operationId, taskId, status, offset = 0, limit = 50 } = {}) {
    if (operationId !== undefined) requireId(operationId, '整理操作标识');
    if (taskId !== undefined) requireId(taskId, '任务标识');
    if (status !== undefined && !states.includes(status)) throw fail('CLEANUP_CONTINUATION_INPUT', '无效待归档状态');
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw fail('CLEANUP_CONTINUATION_INPUT', '待归档读取需要非负 offset 和 1 至 1000 的 limit');
    const filters = [], args = [];
    for (const [column, value] of [['operation_id', operationId], ['task_id', taskId], ['status', status]]) {
      if (value !== undefined) { filters.push(`${column}=?`); args.push(value); }
    }
    const rows = db.prepare(`SELECT payload,notified_at FROM task_cleanup_continuations${filters.length ? ' WHERE ' + filters.join(' AND ') : ''} ORDER BY updated_at DESC,id LIMIT ? OFFSET ?`)
      .all(...args, limit + 1, offset).map(decode);
    return { items: rows.slice(0, limit), nextOffset: rows.length > limit ? offset + limit : null };
  }
  function finish(id, patch = {}) {
    requireId(id, '待归档标识');
    if (!only(patch, ['status', 'receiptId', 'code', 'reason']) || !['completed', 'cancelled', 'conflict'].includes(patch.status)
      || patch.receiptId !== undefined && !identity(patch.receiptId)
      || patch.code !== undefined && !identity(patch.code)
      || patch.reason !== undefined && (typeof patch.reason !== 'string' || patch.reason.length > 4000)
      || patch.status === 'completed' && !identity(patch.receiptId))
      throw fail('CLEANUP_CONTINUATION_INPUT', '终结待归档仅接受真实回执或明确取消、冲突事实');
    return transaction(() => {
      const row = get(id);
      if (!row) throw fail('CLEANUP_CONTINUATION_NOT_FOUND', '待归档记录不存在');
      if (row.status !== 'pending') {
        if (['status', 'receiptId', 'code', 'reason'].every(key => row[key] === patch[key])) return row;
        throw fail('CLEANUP_CONTINUATION_CONFLICT', '待归档记录已终结，不能覆盖原结果');
      }
      const next = { ...row, ...copy(patch), updatedAt: new Date().toISOString() };
      if (!save(next)) throw fail('CLEANUP_CONTINUATION_CONFLICT', '待归档状态已变化');
      return next;
    });
  }
  function cancel({ operationId, ids } = {}) {
    requireId(operationId, '整理操作标识');
    const selected = ids === undefined ? null : idsOf(ids);
    return transaction(() => {
      const rows = rowsFor(operationId);
      if (!rows.length) throw fail('CLEANUP_CONTINUATION_NOT_FOUND', '待归档操作不存在');
      if (selected?.some(id => !rows.some(row => row.taskId === id))) throw fail('CLEANUP_CONTINUATION_INPUT', '取消范围超出原整理清单');
      const at = new Date().toISOString();
      let cancelledCount = 0;
      for (const row of rows) {
        if (row.status !== 'pending' || selected && !selected.includes(row.taskId)) continue;
        const changed = save({ ...row, status: 'cancelled', code: 'CLEANUP_CONTINUATION_CANCELLED',
          reason: '待归档操作已取消；已有停止请求不因此恢复', updatedAt: at });
        cancelledCount += changed;
        // This caller returns the explicit cancellation receipt immediately.
        if (changed) db.prepare('UPDATE task_cleanup_continuations SET notified_at=? WHERE id=?').run(at, row.id);
      }
      return { operationId, cancelledCount, counts: countsOf(operationId), ...list({ operationId }) };
    });
  }
  function byRequest(requestId) {
    requireId(requestId, '请求标识');
    const rows = db.prepare('SELECT payload,notified_at FROM task_cleanup_continuations WHERE request_id=? ORDER BY task_id LIMIT 1000').all(requestId).map(decode);
    return rows.length ? { operationId: rows[0].operationId, items: rows } : null;
  }
  const noticeBatch = batchId => {
    // Immutable membership and ordering preserve a retry's event identity after
    // the receiving inbox admitted it but its response was lost.
    const rows = db.prepare('SELECT operation_id,payload FROM task_cleanup_continuations WHERE notice_batch_id=? ORDER BY id').all(batchId);
    return rows.length ? { batchId, operationId: rows[0].operation_id, items: rows.map(decode) } : null;
  };
  function pendingNoticeBatches({ limit = 50 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw fail('CLEANUP_CONTINUATION_INPUT', '整理通知读取 limit 须为 1 至 1000');
    return transaction(() => {
      const old = db.prepare(`SELECT notice_batch_id FROM task_cleanup_continuations
        WHERE status<>'pending' AND notified_at IS NULL AND notice_batch_id IS NOT NULL
        GROUP BY notice_batch_id ORDER BY MIN(updated_at),notice_batch_id LIMIT ?`).all(limit);
      if (old.length) {
        const batches = [];
        let count = 0;
        for (const row of old) {
          const batch = noticeBatch(row.notice_batch_id);
          // A persisted batch is never split when a retry lowers its budget.
          if (count && count + batch.items.length > limit) break;
          batches.push(batch); count += batch.items.length;
          if (count >= limit) break;
        }
        return batches;
      }
      const fresh = db.prepare(`SELECT id,operation_id FROM task_cleanup_continuations
        WHERE status<>'pending' AND notified_at IS NULL AND notice_batch_id IS NULL
        ORDER BY updated_at,id LIMIT ?`).all(limit);
      const operations = new Map();
      for (const row of fresh) {
        if (!operations.has(row.operation_id)) operations.set(row.operation_id, []);
        operations.get(row.operation_id).push(row.id);
      }
      const assign = db.prepare('UPDATE task_cleanup_continuations SET notice_batch_id=? WHERE id=? AND notice_batch_id IS NULL');
      const batches = [];
      for (const [operationId, ids] of operations) {
        for (let offset = 0; offset < ids.length; offset += 50) {
          const members = ids.slice(offset, offset + 50).sort();
          const batchId = `cleanup-notice:${hash([operationId, members])}`;
          for (const member of members) assign.run(batchId, member);
          batches.push(noticeBatch(batchId));
        }
      }
      return batches;
    });
  }
  function markNoticeBatchNotified(batchId) {
    requireId(batchId, '整理通知批次标识');
    return transaction(() => {
      const batch = noticeBatch(batchId);
      if (!batch) throw fail('CLEANUP_CONTINUATION_NOT_FOUND', '整理通知批次不存在');
      if (batch.items.some(item => item.status === 'pending')) throw fail('CLEANUP_CONTINUATION_CONFLICT', '整理通知批次包含未终结项');
      db.prepare('UPDATE task_cleanup_continuations SET notified_at=COALESCE(notified_at,?) WHERE notice_batch_id=?')
        .run(new Date().toISOString(), batchId);
      return batch;
    });
  }
  return { prepare, byRequest, get, pending, list, finish, cancel, pendingNoticeBatches, markNoticeBatchNotified };
}
