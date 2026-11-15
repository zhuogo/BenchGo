import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';

const quote = value => `"${value.replaceAll('"', '""')}"`;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (code, message) => Object.assign(new Error(message), { code });
const tableNames = (db, schema) => new Set(db.prepare(`SELECT name FROM ${schema}.sqlite_master WHERE type='table'`).all().map(row => row.name));
const columns = (db, schema, table) => db.prepare(`PRAGMA ${schema}.table_info(${quote(table)})`).all();
const parse = value => value ? JSON.parse(value) : null;
const safeIdentity = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const terminal = state => ['completed', 'failed', 'cancelled'].includes(state);

/** Capture rows, not reconstructed projections: opaque IDs and original evidence stay intact. */
function taskGraph(db, taskId) {
  const names = tableNames(db, 'peer'), tables = {};
  const task = db.prepare('SELECT * FROM peer.sa_tasks WHERE id=?').get(taskId);
  if (!task) return null;
  const assignments = db.prepare('SELECT * FROM peer.sa_assignments WHERE task_id=? ORDER BY id').all(taskId);
  const assignmentIds = assignments.map(row => row.id);
  const runs = db.prepare('SELECT r.* FROM peer.sa_runs r JOIN peer.sa_assignments a ON a.id=r.assignment_id WHERE a.task_id=? ORDER BY r.id').all(taskId);
  const runIds = runs.map(row => row.id), outboxIds = [];
  for (const table of names) {
    if (!table.startsWith('sa_') && table !== 'task_events') continue;
    const fields = columns(db, 'peer', table).map(row => row.name), where = [], args = [];
    for (const [field, values] of [['task_id', [taskId]], ['assignment_id', assignmentIds], ['run_id', runIds]]) {
      if (!fields.includes(field) || !values.length) continue;
      where.push(`${quote(field)} IN (${values.map(() => '?').join(',')})`); args.push(...values);
    }
    if (where.length) tables[table] = db.prepare(`SELECT * FROM peer.${quote(table)} WHERE ${where.join(' OR ')} ORDER BY rowid`).all(...args);
  }
  for (const row of tables.sa_outbox || []) outboxIds.push(row.id);
  for (const table of names) {
    const fields = columns(db, 'peer', table).map(row => row.name);
    if (fields.includes('outbox_id') && outboxIds.length) tables[table] = db.prepare(`SELECT * FROM peer.${quote(table)} WHERE outbox_id IN (${outboxIds.map(() => '?').join(',')}) ORDER BY rowid`).all(...outboxIds);
    const eventIds = (tables.task_events || []).map(row => row.id);
    if (fields.includes('event_id') && eventIds.length) tables[table] = db.prepare(`SELECT * FROM peer.${quote(table)} WHERE event_id IN (${eventIds.map(() => '?').join(',')}) ORDER BY rowid`).all(...eventIds);
  }
  tables.task_meta = db.prepare('SELECT * FROM peer.task_meta WHERE key=?').all(`task-presentation:task:${taskId}`);
  const triggerIds = new Set();
  const candidateIds = new Set((tables.sa_decisions || []).map(row => row.candidate_id));
  if (candidateIds.size) tables.sa_candidates = [...candidateIds].sort().map(id => db.prepare('SELECT * FROM peer.sa_candidates WHERE id=?').get(id)).filter(Boolean);
  for (const rows of Object.values(tables)) for (const row of rows) for (const [key, value] of Object.entries(row)) {
    if (key.endsWith('trigger_id') && value) triggerIds.add(value);
  }
  tables.sa_triggers = [...triggerIds].sort().map(id => db.prepare('SELECT * FROM peer.sa_triggers WHERE id=?').get(id)).filter(Boolean);
  const threadIds = new Set([task.thread_id, ...tables.sa_triggers.map(row => row.thread_id)]);
  tables.sa_threads = [...threadIds].sort().map(id => db.prepare('SELECT * FROM peer.sa_threads WHERE id=?').get(id)).filter(Boolean);
  if (names.has('sa_trigger_admissions') && triggerIds.size) tables.sa_trigger_admissions = db.prepare(`SELECT * FROM peer.sa_trigger_admissions WHERE trigger_id IN (${[...triggerIds].map(() => '?').join(',')})`).all(...triggerIds);
  const sessionIds = runs.map(row => parse(row.payload)?.sessionId).filter(Boolean);
  for (const table of ['sa_session_roles', 'sa_execution_projection']) if (names.has(table) && sessionIds.length)
    tables[table] = db.prepare(`SELECT * FROM peer.${quote(table)} WHERE session_id IN (${sessionIds.map(() => '?').join(',')}) ORDER BY session_id`).all(...sessionIds);
  const migration = names.has('sa_remote_execution_migrations') && db.prepare('SELECT payload FROM peer.sa_remote_execution_migrations WHERE id=?').get(`legacy-target:${taskId}`);
  return { task, assignments, runs, tables, initialSnapshot: parse(migration?.payload) };
}

function references(db) {
  const saved = db.prepare("SELECT payload FROM sa_remote_execution_migrations WHERE id='legacy-origin-references'").get();
  const original = db.prepare("SELECT value FROM task_meta WHERE key='remote-executions'").get();
  const rows = parse(saved?.payload ?? original?.value);
  if (!Array.isArray(rows)) throw fail('MIGRATION_ORIGIN_MISSING', '发起宿主缺少原始委派引用，拒绝猜测工单归属');
  return rows;
}

function requireSource(reference, graph, principalDeviceId) {
  const origin = reference.origin, source = parse(graph.task.mandate)?.source;
  if (!origin || !safeIdentity(origin.sessionId) || !safeIdentity(origin.messageId) || !safeIdentity(origin.threadId)
    || !origin.instruction?.trim() || source?.channel !== 'link' || source.deviceId !== principalDeviceId
    || ['sessionId', 'threadId'].some(key => source[key] !== origin[key])
    || parse(graph.task.mandate)?.admission !== 'link-device-delegation')
    throw fail('MIGRATION_SOURCE_MISMATCH', '旧工单与发起设备、原会话或原始委派证据不一致');
  // The target's original stable request receipt proves the selected A reference
  // actually admitted this B Task, rather than merely naming an arbitrary UUID.
  const requestKey = `link:${hash([principalDeviceId, reference.requestId])}`;
  if (!(graph.tables.sa_desktop_requests || []).some(row => row.request_key === requestKey && row.task_id === graph.task.id))
    throw fail('MIGRATION_REQUEST_MISMATCH', '目标工单缺少与原委派一致的幂等接收凭据');
}

function insert(db, table, row, { omit = [] } = {}) {
  const available = new Set(columns(db, 'main', table).map(item => item.name));
  if (Object.keys(row).some(key => !available.has(key))) throw fail('MIGRATION_SCHEMA_MISMATCH', `两端表结构不一致：${table}`);
  const keys = Object.keys(row).filter(key => !omit.includes(key));
  db.prepare(`INSERT INTO ${quote(table)} (${keys.map(quote).join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map(key => row[key]));
}

function importTask(db, item, destination) {
  const { graph, reference, transferId } = item, original = graph.initialSnapshot?.task ?? graph.task;
  const origin = reference.origin, source = { channel: 'desktop', sessionId: origin.sessionId, threadId: origin.threadId, messageId: origin.messageId };
  const at = new Date().toISOString(), threadId = `desktop:${origin.sessionId}`;
  const priorThread = db.prepare('SELECT * FROM sa_threads WHERE id=?').get(threadId);
  if (priorThread && (priorThread.source_type !== 'desktop' || priorThread.source_id !== origin.sessionId))
    throw fail('MIGRATION_SOURCE_MISMATCH', '原始会话线程已绑定其他来源');
  if (!priorThread) insert(db, 'sa_threads', { id: threadId, source_type: 'desktop', source_id: origin.sessionId, metadata: '{}', created_at: at });
  const originalMandate = parse(original.mandate), lastPayload = parse(graph.assignments.at(-1)?.payload);
  const model = lastPayload?.model, config = model?.providerId && model?.modelId ? { harness: 'official', models: [model] } : null;
  const execution = { ...destination, ...(config ? { config } : {}) };
  const mandate = { ...originalMandate, actorId: 'desktop-owner', source, instruction: origin.instruction,
    admission: 'migration-verification-required', execution,
    ...(originalMandate.project ? { project: { ...originalMandate.project, deviceId: destination.deviceId, hostId: destination.hostId } } : {}),
    ownershipMigration: { transferId, executorTaskId: original.id, verified: false } };
  const rewriteSnapshot = text => {
    const snapshot = parse(text);
    if (snapshot?.mandate) snapshot.mandate = { ...snapshot.mandate, ...mandate, instruction: snapshot.mandate.instruction };
    return JSON.stringify(snapshot);
  };
  const fullySettled = graph.assignments.every(row => terminal(row.state)) && graph.runs.every(row => terminal(row.state));
  const blocker = { stage: 'migration', code: 'REMOTE_MIGRATION_REQUIRES_VERIFICATION',
    reason: '旧执行证据已归入发起宿主；旧会话尚未由标准执行协议接管，须核实原执行与重新授权，禁止自动重派', transferId };
  insert(db, 'sa_tasks', { ...original, thread_id: threadId, created_by_decision: null, adjustment_of_task_id: null,
    mandate: JSON.stringify(mandate), status: fullySettled && original.status === 'completed' ? 'completed' : 'waiting',
    continuation_wait: JSON.stringify(blocker), updated_at: at });
  for (const trigger of graph.tables.sa_triggers || []) {
    const prior = db.prepare('SELECT * FROM sa_triggers WHERE id=?').get(trigger.id);
    if (prior) throw fail('MIGRATION_ID_CONFLICT', '原输入标识与宿主已有输入冲突');
    const oldSource = parse(trigger.source);
    insert(db, 'sa_triggers', { ...trigger, thread_id: threadId, dedupe_key: `ownership:${transferId}:${trigger.id}`,
      source: JSON.stringify({ ...oldSource, channel: 'desktop', sessionId: origin.sessionId, threadId: origin.threadId }),
      actor: JSON.stringify({ kind: 'human', id: 'desktop-owner' }) }, { omit: ['seq'] });
  }
  for (const assignment of graph.assignments) {
    const payload = parse(assignment.payload);
    insert(db, 'sa_assignments', { ...assignment, payload: JSON.stringify({ ...payload, executor: 'remote', execution,
      ...(payload.appliedSnapshot ? { appliedSnapshot: parse(rewriteSnapshot(JSON.stringify(payload.appliedSnapshot))) } : {}) }),
      state: terminal(assignment.state) ? assignment.state : 'blocked', owner: null, lease_until: null, updated_at: at });
  }
  for (const run of graph.runs) insert(db, 'sa_runs', { ...run, owner: `migration:${transferId}`,
    state: terminal(run.state) ? run.state : 'uncertain', updated_at: at });
  const ordinary = ['sa_task_triggers', 'sa_results', 'sa_task_revisions', 'sa_task_inputs', 'sa_task_boundaries', 'sa_worker_execution_state'];
  for (const table of ordinary) for (const raw of graph.tables[table] || []) {
    let row = { ...raw };
    if (table === 'sa_task_revisions') row.snapshot = rewriteSnapshot(row.snapshot);
    if (table === 'sa_results') {
      const result = parse(row.payload);
      row.payload = JSON.stringify({ ...result, notification: { ...(result.notification || {}), state: 'suppressed', reason: 'ownership-migration-history' } });
    }
    if (table === 'sa_task_inputs' && ['revision', 'authorization'].includes(row.kind) && row.snapshot) row.snapshot = rewriteSnapshot(row.snapshot);
    if (table === 'sa_task_inputs') row.fingerprint = hash([row.task_id, row.trigger_id, row.kind,
      row.kind === 'context' ? null : row.instruction_revision, row.kind === 'context' ? null : row.authorization_version, parse(row.snapshot)]);
    if (table === 'sa_task_boundaries') row.snapshot = rewriteSnapshot(row.snapshot);
    insert(db, table, row);
  }
  // Historical questions remain addressable, but no stale question is published
  // or resumed until its original execution has been explicitly reconciled.
  for (const row of graph.tables.sa_outbox || []) insert(db, 'sa_outbox', { ...row, state: 'sent', owner: null, lease_until: null,
    unique_key: `ownership:${transferId}:${row.unique_key}`, sent_at: row.sent_at || at,
    payload: JSON.stringify({ ...parse(row.payload), source }), updated_at: at });
  for (const table of ['sa_attentions', 'sa_attention_resolutions', 'sa_delivery_receipts', 'sa_outbox_reconciliations'])
    for (const row of graph.tables[table] || []) insert(db, table, row, { omit: table === 'sa_outbox_reconciliations' ? ['seq'] : [] });
  db.prepare('INSERT INTO sa_remote_execution_migrations VALUES (?,?,?,?)').run(transferId, 'owner-import',
    JSON.stringify({ version: 1, transferId, destination, reference, graph, blocker, fullySettled }), at);
}

function deleteExecutorTask(db, item) {
  const { graph, transferId } = item, taskId = graph.task.id;
  // Only task-owned descendants are removed. Original official sessions and
  // shared intake records stay intact; the receipt seals the complete snapshot.
  for (const [table, rows] of Object.entries(graph.tables).reverse()) {
    if (['sa_triggers', 'sa_threads', 'sa_candidates', 'sa_session_roles', 'sa_execution_projection', 'sa_trigger_admissions'].includes(table) || !rows.length) continue;
    const info = columns(db, 'peer', table), primary = info.filter(row => row.pk).sort((a, b) => a.pk - b.pk).map(row => row.name);
    if (!primary.length) throw fail('MIGRATION_SCHEMA_MISMATCH', `缺少可验证主键：${table}`);
    for (const row of rows) db.prepare(`DELETE FROM peer.${quote(table)} WHERE ${primary.map(key => `${quote(key)}=?`).join(' AND ')}`).run(...primary.map(key => row[key]));
  }
  const sessionIds = graph.runs.map(run => parse(run.payload)?.sessionId).filter(Boolean);
  for (const sessionId of sessionIds) for (const table of ['sa_session_roles', 'sa_execution_projection'])
    if (graph.tables[table]) db.prepare(`DELETE FROM peer.${quote(table)} WHERE session_id=?`).run(sessionId);
  db.prepare('DELETE FROM peer.sa_tasks WHERE id=?').run(taskId);
  // Intake is shared only when an actual remaining foreign key still refers to
  // it. Remove orphaned legacy intake; never erase another task's source.
  const peerTables = tableNames(db, 'peer');
  const inbound = new Map();
  for (const child of peerTables) for (const fk of db.prepare(`PRAGMA peer.foreign_key_list(${quote(child)})`).all()) {
    if (fk.to && fk.to !== 'id') continue;
    const list = inbound.get(fk.table) || []; list.push({ child, from: fk.from }); inbound.set(fk.table, list);
  }
  const referenced = (table, id, ignored = []) => (inbound.get(table) || []).some(({ child, from }) => !ignored.includes(child)
    && db.prepare(`SELECT 1 FROM peer.${quote(child)} WHERE ${quote(from)}=? LIMIT 1`).get(id));
  for (const row of graph.tables.sa_candidates || []) if (!referenced('sa_candidates', row.id)) db.prepare('DELETE FROM peer.sa_candidates WHERE id=?').run(row.id);
  for (const row of graph.tables.sa_triggers || []) {
    if (referenced('sa_triggers', row.id, ['sa_trigger_admissions'])) continue;
    if (peerTables.has('sa_trigger_admissions')) db.prepare('DELETE FROM peer.sa_trigger_admissions WHERE trigger_id=?').run(row.id);
    db.prepare('DELETE FROM peer.sa_triggers WHERE id=?').run(row.id);
  }
  for (const row of graph.tables.sa_threads || []) if (!referenced('sa_threads', row.id)) db.prepare('DELETE FROM peer.sa_threads WHERE id=?').run(row.id);
  // Deletion observers can append factual rows; remove the retired B business
  // projection after those observers, while retaining it in the sealed receipt.
  if (tableNames(db, 'peer').has('sa_execution_facts')) db.prepare('DELETE FROM peer.sa_execution_facts WHERE task_id=?').run(taskId);
  const at = new Date().toISOString();
  db.prepare("UPDATE peer.sa_remote_execution_migrations SET kind='executor-retired-snapshot',payload=? WHERE id=?")
    .run(JSON.stringify({ version: 1, transferId, ownerHostId: item.ownerHostId, taskId, evidenceHash: hash(graph) }), `legacy-target:${taskId}`);
  db.prepare('INSERT INTO peer.sa_remote_execution_migrations VALUES (?,?,?,?)').run(transferId, 'executor-retired',
    JSON.stringify({ version: 1, transferId, ownerHostId: item.ownerHostId, taskId, evidenceHash: hash(graph) }), at);
}

/** Offline, explicit, atomic two-database move. Dry-run never writes either file. */
export function transferLegacyTaskOwnership({ ownerFilename, executorFilename, deviceId, hostId, authorizationId, principalDeviceId, apply = false } = {}) {
  for (const value of [deviceId, hostId, authorizationId, principalDeviceId]) if (!safeIdentity(value)) throw fail('MIGRATION_IDENTITY_REQUIRED', '需要两端已核实的设备与授权标识');
  const ownerPath = realpathSync(ownerFilename), peerPath = realpathSync(executorFilename);
  if (ownerPath.toLowerCase() === peerPath.toLowerCase()) throw fail('MIGRATION_PATH_CONFLICT', '发起宿主与执行设备必须是两个不同数据库');
  const db = new DatabaseSync(ownerPath, { readOnly: !apply });
  db.function('benchgo_cleanup_snapshot_hash', { deterministic: true }, value => hash(value));
  let attached = false, transaction = false, modes;
  try {
    db.exec('PRAGMA busy_timeout=1000; PRAGMA foreign_keys=ON');
    db.prepare('ATTACH DATABASE ? AS peer').run(peerPath); attached = true;
    if (!apply) db.exec('PRAGMA query_only=ON'); // Covers attached databases as well as main.
    for (const schema of ['main', 'peer']) if (!tableNames(db, schema).has('sa_remote_execution_migrations'))
      throw fail('MIGRATION_UPGRADE_REQUIRED', '请先离线升级两端数据库至当前版本，再进行迁移');
    const ownerHostId = parse(db.prepare("SELECT value FROM task_meta WHERE key='owner-host-id'").get()?.value);
    if (!safeIdentity(ownerHostId)) throw fail('MIGRATION_OWNER_MISSING', '发起宿主缺少稳定的业务宿主标识');
    const destination = { deviceId, hostId, authorizationId }, items = [];
    const selected = references(db).filter(row => row.deviceId === deviceId && !['rejected'].includes(row.state));
    if (selected.some(row => !row.executionRef?.taskId)) throw fail('MIGRATION_ACCEPTANCE_UNKNOWN', '此设备存在接收结果未知的原始委派；须先核实目标工单标识，不能忽略或重派');
    const byTask = new Map();
    for (const reference of selected) {
      const list = byTask.get(reference.executionRef.taskId) || [];
      list.push(reference); byTask.set(reference.executionRef.taskId, list);
    }
    for (const [selectedTaskId, choices] of byTask) {
      const priorImport = db.prepare("SELECT id,payload FROM sa_remote_execution_migrations WHERE kind='owner-import' AND json_extract(payload,'$.graph.task.id')=? AND json_extract(payload,'$.destination.deviceId')=?")
        .get(selectedTaskId, deviceId);
      const prior = parse(priorImport?.payload);
      const graph = prior ? null : taskGraph(db, selectedTaskId);
      if (!prior && !graph) throw fail('MIGRATION_TASK_MISSING', '原委派引用的目标工单不存在，拒绝猜测接收结果');
      const matching = prior ? choices.filter(row => row.requestId === prior.reference.requestId)
        : choices.filter(row => (graph.tables.sa_desktop_requests || []).some(receipt => receipt.request_key === `link:${hash([principalDeviceId, row.requestId])}`));
      if (matching.length !== 1) throw fail('MIGRATION_REQUEST_MISMATCH', '原始委派凭据缺失或不唯一；跟进引用不能替代原委派');
      const reference = matching[0];
      const taskId = reference.executionRef.taskId, transferId = `ownership-transfer:${hash([ownerHostId, deviceId, reference.requestId, taskId])}`;
      const imported = db.prepare('SELECT kind,payload FROM sa_remote_execution_migrations WHERE id=?').get(transferId);
      const retired = db.prepare('SELECT kind FROM peer.sa_remote_execution_migrations WHERE id=?').get(transferId);
      if (imported || retired) {
        if (imported?.kind !== 'owner-import' || retired?.kind !== 'executor-retired') throw fail('MIGRATION_RECEIPT_CONFLICT', '两端迁移收据不完整或不一致，拒绝覆盖');
        if (JSON.stringify(parse(imported.payload).destination) !== JSON.stringify(destination)) throw fail('MIGRATION_RECEIPT_CONFLICT', '迁移回执已绑定其他执行设备身份或授权');
        requireSource(reference, parse(imported.payload).graph, principalDeviceId);
        items.push({ taskId, transferId, alreadyTransferred: true }); continue;
      }
      requireSource(reference, graph, principalDeviceId);
      if (graph.assignments.some(row => row.state === 'claimed' && row.lease_until > Date.now()))
        throw fail('MIGRATION_EXECUTION_ACTIVE', '目标仍有有效执行租约，请停止两端宿主并等待租约退出后重试');
      if (db.prepare('SELECT 1 FROM sa_tasks WHERE id=?').get(taskId)) throw fail('MIGRATION_ID_CONFLICT', '工单标识已存在于发起宿主');
      if (graph.task.adjustment_of_task_id) throw fail('MIGRATION_LINKED_TASK', '关联调整工单须连同原工单明确核实后迁移');
      items.push({ taskId, transferId, ownerHostId, reference, graph });
    }
    if (!items.length) throw fail('MIGRATION_ORIGIN_MISSING', '此执行设备没有可核实的旧委派引用；未知接收引用须先人工核实');
    const result = { applied: apply, items: items.map(item => ({ taskId: item.taskId, transferId: item.transferId,
      alreadyTransferred: item.alreadyTransferred === true, requiresVerification: !item.alreadyTransferred,
      sessions: item.graph?.runs.map(row => parse(row.payload)?.sessionId).filter(Boolean) || [] })) };
    if (!apply || items.every(item => item.alreadyTransferred)) return result;
    // SQLite's super-journal makes an attached-file commit atomic only outside
    // WAL. Switching both files fails if a running host still owns a WAL lock.
    modes = ['main', 'peer'].map(schema => db.prepare(`PRAGMA ${schema}.journal_mode`).get().journal_mode);
    for (const schema of ['main', 'peer']) if (db.prepare(`PRAGMA ${schema}.journal_mode=DELETE`).get().journal_mode !== 'delete')
      throw fail('MIGRATION_OFFLINE_REQUIRED', '请停止两端宿主后重试离线迁移');
    db.exec('BEGIN EXCLUSIVE; PRAGMA defer_foreign_keys=ON'); transaction = true;
    for (const item of items.filter(item => !item.alreadyTransferred)) {
      // Compare-and-swap the full evidence cut after acquiring both write locks.
      if (hash(taskGraph(db, item.taskId)) !== hash(item.graph)) throw fail('MIGRATION_CONCURRENT_CHANGE', '旧执行证据已变化，请重新预览');
      importTask(db, item, destination); deleteExecutorTask(db, item);
    }
    for (const schema of ['main', 'peer']) if (db.prepare(`PRAGMA ${schema}.foreign_key_check`).all().length)
      throw fail('MIGRATION_REFERENCE_CONFLICT', '存在未覆盖的业务引用，迁移已整体回滚');
    db.exec('COMMIT'); transaction = false;
    return result;
  } finally {
    if (transaction) db.exec('ROLLBACK');
    if (modes) for (const [index, schema] of ['main', 'peer'].entries()) {
      if (modes[index] === 'wal') { try { db.exec(`PRAGMA ${schema}.journal_mode=WAL`); } catch { /* Data commit is independent of journal preference. */ } }
    }
    if (attached) db.exec('DETACH DATABASE peer');
    db.close();
  }
}
