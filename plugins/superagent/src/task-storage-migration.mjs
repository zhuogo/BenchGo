import { createHash } from 'node:crypto';

// This is an on-open data conversion, not an alternate runtime protocol.
const rename = value => value.replace(/ticket/g, 'task').replace(/Ticket/g, 'Task').replace(/TICKET/g, 'TASK');
const quote = value => '"' + value.replaceAll('"', '""') + '"';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const keys = new Set(['ticket', 'tickets', 'ticketId', 'ticketIds', 'ticketStatus', 'ticketStateEventKey',
  'ticketReplyEventKey', 'ticketReply', 'ticketReplySignal', 'ticketStateSignal', 'ticketInputs', 'ticketLimit',
  'wholeTicketScope', 'adjustmentOfTicketId', 'duplicateOfTicketId', 'handbackTicketId', 'ticket_id', 'ticket_status']);
const opaque = new Set(['arguments', 'args', 'toolArguments', 'toolResults', 'toolReceipts', 'receipt', 'readback',
  'output', 'raw', 'headers', 'content', 'text', 'body', 'target', 'title', 'summary', 'description', 'instruction',
  'acceptance', 'question', 'answers', 'submission', 'model', 'models', 'requestModel', 'proposedModel', 'options']);
const tools = new Map([['assistant_tickets', 'assistant_tasks'], ['assistant_ticket_control', 'assistant_task_control'],
  ['assistant_ticket_change', 'assistant_task_change']]);
const toolFields = new Set(['toolName', 'tools', 'requestTools', 'toolNames', 'toolScope']);
const tagFields = new Set(['type', 'kind', 'operation', 'code', 'action']);
const tags = new Set(['ticket', 'tickets', 'ticket-reply', 'ticket-change', 'benchgo-ticket-reply',
  'benchgo-ticket-reply-reference', 'benchgo-ticket-revision', 'ticketAnswer', 'ticketChange', 'ticketPause',
  'ticketResume', 'ticketStop', 'applyTicketRevision', 'recordTicketInput']);

function convert(value, field = '', taskIds) {
  if (typeof value === 'string') {
    if (toolFields.has(field)) return tools.get(value) || value;
    if (tagFields.has(field) && (tags.has(value) || /^ticket\./.test(value) || /^(?:[A-Z]+_)*TICKET(?:_[A-Z]+)*$/.test(value))) return rename(value);
    return value;
  }
  if (Array.isArray(value)) return value.map(item => convert(item, field, taskIds));
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'ticketId' && typeof item === 'string') taskIds?.add(item);
    if (key === 'ticketIds' && Array.isArray(item)) for (const id of item) if (typeof id === 'string') taskIds?.add(id);
    const nextKey = keys.has(key) ? rename(key) : key;
    const next = field === 'difference' && ['previous', 'requested'].includes(key) && Array.isArray(item) && item.length === 3
      ? item.map((entry, index) => convert(entry, index === 2 ? 'toolScope' : '', taskIds))
      : opaque.has(key) ? item : convert(item, key, taskIds);
    if (Object.hasOwn(result, nextKey) && JSON.stringify(result[nextKey]) !== JSON.stringify(next)) {
      throw new Error(`Task migration has conflicting fields: ${key} and ${nextKey}`);
    }
    Object.defineProperty(result, nextKey, { value: next, enumerable: true, writable: true, configurable: true });
  }
  return result;
}

/** Convert the owned inbox once at startup; original transcript and delivery identities stay unchanged. */
export function migrateTaskState(state) {
  const value = convert(state);
  for (const [index, request] of (value.requests || []).entries()) {
    const before = state.requests[index];
    if (before.ticketReply) {
      if (request.requestId?.startsWith('ticket-reply:')) request.requestId = 'task-reply:' + request.requestId.slice('ticket-reply:'.length);
      request.fingerprint = digest([request.threadId, request.taskReply]);
    } else if ((request.message && JSON.stringify(before.message.source) !== JSON.stringify(request.message.source))
      || (before.executionInput && JSON.stringify(before.executionInput) !== JSON.stringify(request.executionInput))) {
      const context = request.executionInput ? { executionInput: request.executionInput } : request.message?.source?.replyContext;
      const text = (request.message?.content || []).filter(block => block.type === 'text').map(block => block.text || '').join('');
      if (context !== undefined) request.fingerprint = digest([request.threadId, text, context]);
    }
  }
  return { value, changed: JSON.stringify(value) !== JSON.stringify(state) };
}

/** Convert only provenance in owned Markdown markers; user prose and content hashes are not rewritten here. */
export function migrateTaskMemoryDocument(content) {
  const next = content.replace(/<!-- (benchgo-(?:memory|curation|derived|learning|dream-batch)) (\{[^\r\n]*\}) -->/g, (comment, marker, data) => {
    let metadata;
    try { metadata = JSON.parse(data); } catch { return comment; }
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return comment;
    const value = { ...metadata };
    if (metadata.source && typeof metadata.source === 'object') value.source = convert(metadata.source);
    if (Array.isArray(metadata.references)) value.references = convert(metadata.references);
    const serialized = JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
    return JSON.stringify(value) === JSON.stringify(metadata) ? comment : `<!-- ${marker} ${serialized} -->`;
  });
  return { content: next, changed: next !== content };
}

const jsonColumns = {
  sa_threads: ['metadata'], sa_triggers: ['source'], sa_trigger_admissions: ['gate'], sa_candidates: ['gate'],
  sa_decisions: ['assessment'], sa_tasks: ['mandate', 'pause_reason', 'continuation_wait', 'execution_control'],
  sa_assignments: ['payload'], sa_results: ['payload'], sa_outbox: ['payload'], sa_runs: ['payload'],
  sa_outbox_reconciliations: ['payload'], sa_direct_replies: ['source', 'gate'],
  sa_task_revisions: ['snapshot'], sa_task_revision_requests: ['request_payload'],
  sa_task_authorization_approvals: ['payload'], sa_task_inputs: ['snapshot', 'application'], sa_task_boundaries: ['snapshot'],
  sa_execution_projection: ['payload'], sa_execution_summaries: ['payload'], sa_auxiliary_activity: ['payload'],
  sa_execution_facts: ['data'], sa_session_roles: ['identity', 'expected', 'actual', 'reason'],
  sa_worker_execution_state: ['fallback_plan'], sa_router_question_bindings: ['payload'],
  sa_owned_skills: ['source'], sa_skill_feedback: ['source'], sa_skill_candidates: ['payload'], sa_ideas: ['payload'],
  task_meta: ['value'], task_events: ['payload'], task_cleanup_previews: ['payload'], task_cleanup_receipts: ['payload'],
  assistant_goals: ['payload'], assistant_review_queue: ['payload', 'source', 'result'],
  assistant_learning_triggers: ['payload', 'source'], assistant_maintenance_activity: ['source'],
  assistant_maintenance_batches: ['references_json'], ledger_records: ['metadata'],
  memory_candidates: ['payload'], memory_derived: ['dependencies', 'source'], memory_index_sources: ['source'],
  document_current: ['source'], document_versions: ['source'], session_context_snapshots: ['context'],
};

function updateJson(db, table, column, transform = convert) {
  const rows = db.prepare(`SELECT rowid AS migration_rowid,${quote(column)} AS value FROM ${quote(table)} WHERE ${quote(column)} IS NOT NULL`).all();
  const update = db.prepare(`UPDATE ${quote(table)} SET ${quote(column)}=? WHERE rowid=?`);
  for (const row of rows) {
    let value;
    try { value = JSON.parse(row.value); } catch { throw new Error(`Task migration found invalid JSON in ${table}.${column}`); }
    const next = transform(value, row);
    if (JSON.stringify(value) !== JSON.stringify(next)) update.run(JSON.stringify(next), row.migration_rowid);
  }
}

function updateLookup(db, table, column, transform) {
  const update = db.prepare(`UPDATE ${quote(table)} SET ${quote(column)}=? WHERE rowid=?`);
  for (const row of db.prepare(`SELECT rowid AS migration_rowid,${quote(column)} AS value FROM ${quote(table)} WHERE ${quote(column)} IS NOT NULL`).all()) {
    const next = transform(row.value);
    if (next !== row.value) update.run(next, row.migration_rowid);
  }
}

/** The independent ledger has no other schema versions; version 1 canonicalizes owned provenance once. */
export function migrateTaskLedger(db) {
  db.exec('PRAGMA busy_timeout=5000');
  if (db.prepare('PRAGMA user_version').get().user_version >= 1) return { migrated: false };
  db.exec('BEGIN IMMEDIATE');
  try {
    if (db.prepare('PRAGMA user_version').get().user_version >= 1) { db.exec('COMMIT'); return { migrated: false }; }
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ledger_records'").get();
    if (exists) updateJson(db, 'ledger_records', 'metadata');
    db.exec('PRAGMA user_version=1; COMMIT');
    return { migrated: Boolean(exists) };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

function authorizationHashes(db, tables) {
  if (!tables.has('sa_ticket_authorization_approvals')) return [];
  return db.prepare('SELECT * FROM sa_ticket_authorization_approvals').all().flatMap(row => {
    const payload = JSON.parse(row.payload), next = convert(payload);
    if (JSON.stringify(next) === JSON.stringify(payload)) return [];
    const revision = tables.has('sa_ticket_revisions') && db.prepare('SELECT snapshot FROM sa_ticket_revisions').all()
      .map(item => JSON.parse(item.snapshot)).find(item => item.mandate?.authorizationApproval?.id === row.approval_id);
    const trigger = tables.has('sa_triggers') && db.prepare('SELECT source,actor FROM sa_triggers WHERE id=?').get(payload.triggerId);
    if (!revision || !trigger) throw new Error('Task migration cannot verify a changed authorization receipt');
    const values = [row.ticket_id, revision.mandate.authorizationVersion - 1, payload.triggerId,
      JSON.parse(trigger.source), JSON.parse(trigger.actor), payload.difference];
    if (digest(values) !== row.fingerprint) throw new Error('Task migration authorization receipt fingerprint does not match its evidence');
    return [{ id: row.approval_id, fingerprint: digest([values[0], values[1], values[2],
      convert(values[3]), values[4], next.difference]) }];
  });
}

function cleanupHashes(db, tables) {
  const previews = [], receipts = [];
  if (tables.has('task_cleanup_previews')) for (const row of db.prepare('SELECT id,payload,manifest_hash FROM task_cleanup_previews').all()) {
    const value = JSON.parse(row.payload), next = convert(value);
    if (JSON.stringify(value) === JSON.stringify(next)) continue;
    const manifestOf = ({ previewId, createdAt, manifestHash, consumedBy, ...manifest }) => manifest;
    if (digest(canonical(manifestOf(value))) !== value.manifestHash || value.manifestHash !== row.manifest_hash)
      throw new Error('Task migration cleanup manifest fingerprint does not match its evidence');
    // Frozen item execution/state hashes stay sealed. If the underlying snapshot
    // changes, the existing CAS requires a new preview and a new confirmation.
    previews.push({ id: row.id, fingerprint: digest(canonical(manifestOf(next))) });
  }
  if (tables.has('task_cleanup_receipts')) for (const row of db.prepare('SELECT id,payload,binding FROM task_cleanup_receipts').all()) {
    const value = JSON.parse(row.payload), next = convert(value);
    const bindingOf = receipt => [receipt.operation, receipt.previewId, receipt.confirmedBy.ids,
      receipt.confirmedBy.actorId, receipt.confirmedBy.source];
    if (!value.confirmedBy || !Array.isArray(value.confirmedBy.ids)) continue;
    if (JSON.stringify(bindingOf(value)) === JSON.stringify(bindingOf(next))) continue;
    if (digest(canonical(bindingOf(value))) !== row.binding)
      throw new Error('Task migration cleanup receipt fingerprint does not match its evidence');
    receipts.push({ id: row.id, fingerprint: digest(canonical(bindingOf(next))) });
  }
  return { previews, receipts };
}

function repairHashes(db, tables, authorizations, cleanup) {
  for (const row of authorizations) db.prepare('UPDATE sa_task_authorization_approvals SET fingerprint=? WHERE approval_id=?').run(row.fingerprint, row.id);
  if (tables.has('sa_task_inputs')) {
    const update = db.prepare('UPDATE sa_task_inputs SET fingerprint=? WHERE id=?');
    for (const row of db.prepare('SELECT * FROM sa_task_inputs').all()) {
      update.run(digest([row.task_id, row.trigger_id, row.kind, row.kind === 'context' ? null : row.instruction_revision,
        row.kind === 'context' ? null : row.authorization_version, row.snapshot ? JSON.parse(row.snapshot) : null]), row.id);
    }
  }
  if (tables.has('sa_external_actions')) {
    const update = db.prepare('UPDATE sa_external_actions SET payload=?,fingerprint=? WHERE id=?');
    const fingerprints = new Map();
    for (const row of db.prepare('SELECT id,payload FROM sa_external_actions').all()) {
      const action = JSON.parse(row.payload), binding = convert(action.binding);
      if (JSON.stringify(binding) === JSON.stringify(action.binding)) continue;
      const payload = { adapterId: action.adapterId, category: action.category, origin: action.origin,
        target: action.target, content: action.content, submission: action.submission, binding };
      const fingerprint = digest(canonical(payload));
      update.run(JSON.stringify({ ...action, binding, fingerprint }), fingerprint, row.id);
      fingerprints.set(row.id, fingerprint);
    }
    if (tables.has('sa_action_audit') && fingerprints.size) updateJson(db, 'sa_action_audit', 'payload', value =>
      value.fingerprint && fingerprints.has(value.actionId) ? { ...value, fingerprint: fingerprints.get(value.actionId) } : value);
  }
  if (cleanup.previews.length) {
    const update = db.prepare('UPDATE task_cleanup_previews SET payload=?,manifest_hash=? WHERE id=?');
    for (const { id, fingerprint } of cleanup.previews) {
      const value = JSON.parse(db.prepare('SELECT payload FROM task_cleanup_previews WHERE id=?').get(id).payload);
      update.run(JSON.stringify({ ...value, manifestHash: fingerprint }), fingerprint, id);
    }
  }
  if (tables.has('task_cleanup_receipts') && (cleanup.receipts.length || cleanup.previews.length)) {
    const update = db.prepare('UPDATE task_cleanup_receipts SET payload=?,binding=? WHERE id=?');
    for (const row of db.prepare('SELECT id,payload,binding FROM task_cleanup_receipts').all()) {
      const value = JSON.parse(row.payload);
      const fingerprint = cleanup.receipts.find(item => item.id === row.id)?.fingerprint ?? row.binding;
      const preview = cleanup.previews.find(item => item.id === value.previewId);
      const next = preview ? { ...value, manifestHash: preview.fingerprint } : value;
      if (fingerprint !== row.binding || JSON.stringify(next) !== row.payload) update.run(JSON.stringify(next), fingerprint, row.id);
    }
  }
}

/**
 * Atomically move the previous owned SQL/JSON schema to canonical task names.
 * Run after opening assistant.db, before any store prepares statements. No
 * compatibility tables or aliases survive; opaque IDs, prose and receipts are retained.
 */
export function migrateTaskStorage(db) {
  db.exec('PRAGMA busy_timeout=5000');
  const tableNames = () => new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
  if (!tableNames().has('sa_tickets')) return { migrated: false };
  db.exec('BEGIN IMMEDIATE');
  try {
    // Another connection may have finished the conversion while this one waited.
    const before = tableNames();
    if (!before.has('sa_tickets')) { db.exec('COMMIT'); return { migrated: false }; }
    if (before.has('sa_tasks')) throw new Error('Task migration found both source and destination tables');
    const authorizations = authorizationHashes(db, before), cleanup = cleanupHashes(db, before);
    const schema = db.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND type IN ('index','trigger') AND (name LIKE 'sa_%' OR name LIKE 'task_%')").all();
    const dropped = schema.filter(row => row.type === 'trigger' || /ticket/i.test(row.sql));
    for (const row of dropped) db.exec(`DROP ${row.type.toUpperCase()} ${quote(row.name)}`);
    for (const name of before) if (name.startsWith('sa_') && name.includes('ticket')) {
      const next = rename(name);
      if (before.has(next)) throw new Error(`Task migration destination already exists: ${next}`);
      db.exec(`ALTER TABLE ${quote(name)} RENAME TO ${quote(next)}`);
    }
    const tables = tableNames(), taskIds = new Set(db.prepare('SELECT id FROM sa_tasks').all().map(row => row.id));
    for (const table of tables) if (table.startsWith('sa_')) {
      const columns = db.prepare(`PRAGMA table_info(${quote(table)})`).all().map(row => row.name);
      for (const name of columns) if (name.includes('ticket')) {
        const next = rename(name);
        if (columns.includes(next)) throw new Error(`Task migration destination column already exists: ${table}.${next}`);
        db.exec(`ALTER TABLE ${quote(table)} RENAME COLUMN ${quote(name)} TO ${quote(next)}`);
      }
    }
    for (const [table, names] of Object.entries(jsonColumns)) if (tables.has(table)) {
      const columns = new Set(db.prepare(`PRAGMA table_info(${quote(table)})`).all().map(row => row.name));
      for (const name of names) if (columns.has(name)) updateJson(db, table, name, value => convert(value, '', taskIds));
    }
    if (tables.has('task_meta')) updateLookup(db, 'task_meta', 'key', value => value.startsWith('task-presentation:ticket:')
      ? 'task-presentation:task:' + value.slice('task-presentation:ticket:'.length) : value);
    if (tables.has('task_events')) updateLookup(db, 'task_events', 'unique_key', value => value.startsWith('ticket-delivery:')
      ? 'task-delivery:' + value.slice('ticket-delivery:'.length) : value);
    if (tables.has('sa_task_revision_requests')) updateLookup(db, 'sa_task_revision_requests', 'request_key', value => {
      let key; try { key = JSON.parse(value); } catch { return value; }
      if (!Array.isArray(key) || key[0] !== 'ticket-change') return value;
      key[0] = 'task-change'; return JSON.stringify(key);
    });
    if (tables.has('sa_triggers')) updateLookup(db, 'sa_triggers', 'dedupe_key', value => /^ticket-change:[a-f0-9]{64}$/.test(value)
      ? 'task-change:' + value.slice('ticket-change:'.length) : value);
    if (tables.has('sa_task_inputs')) {
      const update = db.prepare('UPDATE sa_task_inputs SET idempotency_key=? WHERE id=?');
      for (const row of db.prepare('SELECT id,task_id,trigger_id,idempotency_key FROM sa_task_inputs').all()) {
        if (row.idempotency_key === `trigger:${row.trigger_id}:ticket:${row.task_id}`)
          update.run(`trigger:${row.trigger_id}:task:${row.task_id}`, row.id);
      }
    }
    if (tables.has('sa_execution_facts')) db.exec("UPDATE sa_execution_facts SET kind='task' WHERE kind='ticket'");
    for (const table of ['sa_idea_tombstones', 'sa_skill_source_tombstones']) if (tables.has(table)) {
      const rows = db.prepare(`SELECT alias FROM ${quote(table)} WHERE alias LIKE 'ticket:%'`).all();
      const add = db.prepare(`INSERT OR IGNORE INTO ${quote(table)}(alias) VALUES (?)`), remove = db.prepare(`DELETE FROM ${quote(table)} WHERE alias=?`);
      for (const row of rows) { add.run('task:' + row.alias.slice('ticket:'.length)); remove.run(row.alias); }
    }
    if (tables.has('sa_skill_source_tombstones')) {
      const find = db.prepare('SELECT 1 FROM sa_skill_source_tombstones WHERE alias=?');
      const add = db.prepare('INSERT OR IGNORE INTO sa_skill_source_tombstones(alias) VALUES (?)');
      const remove = db.prepare('DELETE FROM sa_skill_source_tombstones WHERE alias=?');
      for (const id of taskIds) {
        const old = digest(['ticket', id]);
        if (find.get(old)) { add.run(digest(['task', id])); remove.run(old); }
      }
    }
    repairHashes(db, tables, authorizations, cleanup);
    for (const row of dropped) {
      let sql = rename(row.sql);
      if (row.sql.includes('task-presentation:ticket:')) sql = sql.replace(/substr\(((?:NEW|OLD)\.key),26\)/gi, 'substr($1,24)');
      db.exec(sql);
    }
    const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
    if (foreignKeys.length) throw new Error('Task migration failed foreign-key validation');
    db.exec('COMMIT');
    return { migrated: true };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
