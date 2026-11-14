import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { migrateTaskState, migrateTaskStorage, migrateTaskLedger, migrateTaskMemoryDocument } from '../src/task-storage-migration.mjs';

const json = JSON.stringify;
const digest = value => createHash('sha256').update(json(value)).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const row = (db, table) => ({ ...db.prepare(`SELECT * FROM ${table}`).get() });
function oldStore(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE sa_tickets(id TEXT PRIMARY KEY,mandate TEXT NOT NULL,adjustment_of_ticket_id TEXT REFERENCES sa_tickets(id));
    CREATE TABLE sa_ticket_triggers(ticket_id TEXT REFERENCES sa_tickets(id),trigger_id TEXT,PRIMARY KEY(ticket_id,trigger_id));
    CREATE TABLE sa_assignments(id TEXT PRIMARY KEY,ticket_id TEXT REFERENCES sa_tickets(id),payload TEXT);
    CREATE TABLE sa_results(ticket_id TEXT REFERENCES sa_tickets(id),version INTEGER,payload TEXT,PRIMARY KEY(ticket_id,version));
    CREATE TABLE sa_outbox(id TEXT PRIMARY KEY,unique_key TEXT UNIQUE,ticket_id TEXT REFERENCES sa_tickets(id),payload TEXT,state TEXT);
    CREATE TABLE sa_session_roles(session_id TEXT PRIMARY KEY,identity TEXT,expected TEXT,actual TEXT,reason TEXT);
    CREATE TABLE task_meta(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE task_events(seq INTEGER PRIMARY KEY,id TEXT UNIQUE,unique_key TEXT UNIQUE,task_id TEXT,payload TEXT);
    CREATE TABLE task_outbox(event_id TEXT PRIMARY KEY,delivered_at TEXT);
    CREATE TABLE sa_execution_facts(seq INTEGER PRIMARY KEY,ticket_id TEXT,kind TEXT,data TEXT);
    CREATE INDEX sa_assignments_ticket ON sa_assignments(ticket_id);
    CREATE INDEX sa_results_ticket_json ON sa_results(json_extract(payload,'$.ticketId'));
    CREATE TRIGGER sa_execution_fact_task_meta_insert AFTER INSERT ON task_meta
      WHEN NEW.key LIKE 'task-presentation:ticket:%'
      BEGIN INSERT INTO sa_execution_facts(ticket_id,kind,data) VALUES(substr(NEW.key,26),'ticket','{}'); END;`);
  db.prepare('INSERT INTO sa_tickets VALUES (?,?,NULL)').run('ticket-literal-id', json({ instruction: 'keep ticket 工单 verbatim', source: { eventId: 'ticket:source', channel: 'desktop' } }));
  db.prepare('INSERT INTO sa_ticket_triggers VALUES (?,?)').run('ticket-literal-id', 'trigger-ticket-id');
  return db;
}

test('one atomic migration moves relations, payloads, presentation and pending delivery without editing content or identities', t => {
  const db = oldStore(t);
  db.prepare('INSERT INTO sa_assignments VALUES (?,?,?)').run('assignment', 'ticket-literal-id', json({ wholeTicketScope: true,
    model: { modelId: 'ticket', ticketId: 'vendor-extension' }, text: '工单 ticket', appliedSnapshot: { ticketId: 'ticket-literal-id' },
    arguments: { ticketId: 'external-object', content: 'unchanged' } }));
  db.prepare('INSERT INTO sa_results VALUES (?,?,?)').run('ticket-literal-id', 1, json({ ticketId: 'ticket-literal-id', summary: 'original 工单 result' }));
  db.prepare('INSERT INTO sa_outbox VALUES (?,?,?,?,?)').run('outbox', 'ticket-accepted:ticket-literal-id', 'ticket-literal-id',
    json({ type: 'ticket.accepted', ticketId: 'ticket-literal-id', text: '工单 old notification' }), 'queued');
  db.prepare('INSERT INTO task_events VALUES (?,?,?,?,?)').run(4, 'event', 'ticket-delivery:ticket-accepted:ticket-literal-id', 'ticket-literal-id',
    json({ type: 'ticket.result', taskId: 'ticket-literal-id', ticketId: 'ticket-literal-id', ticketStateEventKey: 'ticket-accepted:ticket-literal-id', text: '工单 original' }));
  db.prepare('INSERT INTO task_outbox VALUES (?,NULL)').run('event');
  db.prepare('INSERT INTO task_meta VALUES (?,?)').run('task-presentation:ticket:ticket-literal-id', json({ archived: true, title: '工单 original title' }));
  db.prepare('INSERT INTO sa_session_roles VALUES (?,?,?,?,?)').run('session', json({ role: 'worker', ticketId: 'ticket-literal-id' }),
    json({ permissionPreset: 'workspace-write' }), json({ tools: ['assistant_tickets', 'vendor_ticket_tool'], requestModel: { model: 'ticket' } }), null);
  const factCount = db.prepare('SELECT COUNT(*) AS total FROM sa_execution_facts').get().total;

  assert.deepEqual(migrateTaskStorage(db), { migrated: true });
  assert.equal(db.prepare("SELECT COUNT(*) AS total FROM sqlite_master WHERE name LIKE '%ticket%'").get().total, 0);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(row(db, 'sa_task_triggers').task_id, 'ticket-literal-id');
  assert.equal(row(db, 'sa_tasks').id, 'ticket-literal-id');
  assert.equal(JSON.parse(row(db, 'sa_tasks').mandate).instruction, 'keep ticket 工单 verbatim');
  const assignment = JSON.parse(row(db, 'sa_assignments').payload);
  assert.equal(assignment.wholeTaskScope, true);
  assert.deepEqual(assignment.model, { modelId: 'ticket', ticketId: 'vendor-extension' });
  assert.deepEqual(assignment.arguments, { ticketId: 'external-object', content: 'unchanged' });
  assert.equal(assignment.appliedSnapshot.taskId, 'ticket-literal-id');
  assert.equal(JSON.parse(row(db, 'sa_outbox').payload).type, 'task.accepted');
  assert.equal(row(db, 'sa_outbox').unique_key, 'ticket-accepted:ticket-literal-id');
  assert.equal(row(db, 'sa_outbox').state, 'queued');
  assert.equal(row(db, 'task_outbox').delivered_at, null);
  const event = row(db, 'task_events');
  assert.equal(event.unique_key, 'task-delivery:ticket-accepted:ticket-literal-id');
  assert.deepEqual(JSON.parse(event.payload), { type: 'task.result', taskId: 'ticket-literal-id', taskStateEventKey: 'ticket-accepted:ticket-literal-id', text: '工单 original' });
  assert.equal(row(db, 'task_meta').key, 'task-presentation:task:ticket-literal-id');
  assert.deepEqual(JSON.parse(row(db, 'sa_session_roles').actual).tools, ['assistant_tasks', 'vendor_ticket_tool']);
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM sa_execution_facts').get().total, factCount, 'conversion does not emit execution events');
  db.prepare('INSERT INTO task_meta VALUES (?,?)').run('task-presentation:task:second', '{}');
  assert.equal(db.prepare('SELECT task_id FROM sa_execution_facts ORDER BY seq DESC LIMIT 1').get().task_id, 'second');
  assert.deepEqual(migrateTaskStorage(db), { migrated: false });
});

test('conversion refuses conflicting keys and rolls back the entire schema and data conversion', t => {
  const db = oldStore(t);
  db.prepare('INSERT INTO sa_results VALUES (?,?,?)').run('ticket-literal-id', 1, json({ ticketId: 'one', taskId: 'two' }));
  assert.throws(() => migrateTaskStorage(db), /conflicting fields/);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='sa_tickets'").get());
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='sa_tasks'").get(), undefined);
  assert.deepEqual(JSON.parse(row(db, 'sa_results').payload), { ticketId: 'one', taskId: 'two' });
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='sa_assignments_ticket'").get());
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('new stores need no migration and conflicting destination tables are never overwritten', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  assert.deepEqual(migrateTaskStorage(db), { migrated: false });
  db.exec('CREATE TABLE sa_tickets(id TEXT PRIMARY KEY); CREATE TABLE sa_tasks(id TEXT PRIMARY KEY)');
  assert.throws(() => migrateTaskStorage(db), /both source and destination/);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name IN ('sa_tasks','sa_tickets')").get().count, 2);
});

test('task input idempotency and frozen external-action bindings are converted with matching hashes', t => {
  const db = oldStore(t);
  db.exec(`CREATE TABLE sa_ticket_inputs(id TEXT PRIMARY KEY,ticket_id TEXT,trigger_id TEXT,idempotency_key TEXT UNIQUE,
    fingerprint TEXT,kind TEXT,instruction_revision INTEGER,authorization_version INTEGER,snapshot TEXT,application TEXT);
    CREATE TABLE sa_external_actions(id TEXT PRIMARY KEY,payload TEXT,fingerprint TEXT);
    CREATE TABLE sa_action_audit(id TEXT PRIMARY KEY,payload TEXT);`);
  const snapshot = { mandate: { adjustment: { ticketId: 'old-parent' }, instruction: 'ticket' }, instructionRevision: 2 };
  db.prepare('INSERT INTO sa_ticket_inputs VALUES (?,?,?,?,?,?,?,?,?,NULL)').run('input', 'ticket-literal-id', 'trigger-ticket-id',
    'trigger:trigger-ticket-id:ticket:ticket-literal-id', digest(['ticket-literal-id', 'trigger-ticket-id', 'revision', 2, 1, snapshot]), 'revision', 2, 1, json(snapshot));
  const payload = { adapterId: 'vendor-ticket', category: 'external-send', origin: null,
    target: { ticketId: 'vendor-target' }, content: { ticket: 'external payload 工单' }, submission: { type: 'ticket' },
    binding: { ticketId: 'ticket-literal-id', assignmentId: 'assignment', actorId: 'owner' } };
  const fingerprint = digest(canonical(payload));
  const action = { ...canonical(payload), id: 'action', fingerprint, createdAt: 'unchanged' };
  db.prepare('INSERT INTO sa_external_actions VALUES (?,?,?)').run('action', json(action), fingerprint);
  db.prepare('INSERT INTO sa_action_audit VALUES (?,?)').run('audit', json({ actionId: 'action', fingerprint, phase: 'approved' }));
  migrateTaskStorage(db);
  const input = row(db, 'sa_task_inputs'), migratedSnapshot = JSON.parse(input.snapshot);
  assert.equal(input.idempotency_key, 'trigger:trigger-ticket-id:task:ticket-literal-id');
  assert.equal(migratedSnapshot.mandate.adjustment.taskId, 'old-parent');
  assert.equal(input.fingerprint, digest(['ticket-literal-id', 'trigger-ticket-id', 'revision', 2, 1, migratedSnapshot]));
  const stored = row(db, 'sa_external_actions'), migratedAction = JSON.parse(stored.payload);
  const expected = { ...payload, binding: { taskId: 'ticket-literal-id', assignmentId: 'assignment', actorId: 'owner' } };
  assert.equal(stored.fingerprint, digest(canonical(expected)));
  assert.equal(migratedAction.fingerprint, stored.fingerprint);
  assert.deepEqual(migratedAction.content, payload.content);
  assert.deepEqual(migratedAction.target, payload.target);
  assert.deepEqual(migratedAction.submission, payload.submission);
  assert.equal(JSON.parse(row(db, 'sa_action_audit').payload).fingerprint, stored.fingerprint);
});

test('inbox migration keeps original message/event identities and source prose while normalizing queued task signals', () => {
  const signal = { kind: 'result', ticketId: 'ticket-id', eventKey: 'ticket:event', summary: '工单 result', source: { messageId: 'original-source' } };
  const state = { schemaVersion: 1, revision: 4, requests: [{ requestId: 'ticket-reply:ticket:event', threadId: 'main',
    messageId: 'ticket-message-id', sessionId: 'ticket-session', ticketReply: signal, fingerprint: digest(['main', signal]),
    message: { id: 'ticket-message-id', source: { kind: 'benchgo-ticket-reply', ticketId: 'ticket-id', eventKey: 'ticket:event' },
      content: [{ type: 'text', text: '工单 historical prompt' }] }, status: 'queued' }] };
  const original = structuredClone(state);
  const { value, changed } = migrateTaskState(state);
  assert.equal(changed, true);
  assert.deepEqual(state, original);
  const request = value.requests[0];
  assert.equal(request.requestId, 'task-reply:ticket:event');
  assert.equal(request.messageId, 'ticket-message-id');
  assert.equal(request.sessionId, 'ticket-session');
  assert.equal(request.message.id, 'ticket-message-id');
  assert.equal(request.message.source.eventKey, 'ticket:event');
  assert.equal(request.message.source.kind, 'benchgo-task-reply');
  assert.equal(request.message.content[0].text, '工单 historical prompt');
  assert.equal(request.taskReply.taskId, 'ticket-id');
  assert.equal(request.fingerprint, digest(['main', request.taskReply]));
  assert.equal(migrateTaskState(value).changed, false);
});

test('independent ledger conversion changes source metadata once without touching FTS source text or record identity', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec('CREATE TABLE ledger_records(id TEXT PRIMARY KEY,source_key TEXT,content TEXT,metadata TEXT)');
  const metadata = { source: { ticketId: 'ticket-original-id', eventId: 'ticket-event' }, text: '工单 citation' };
  db.prepare('INSERT INTO ledger_records VALUES (?,?,?,?)').run('ticket-record', 'ticket-source-key', '工单 ticket content', json(metadata));
  assert.deepEqual(migrateTaskLedger(db), { migrated: true });
  assert.deepEqual(row(db, 'ledger_records'), { id: 'ticket-record', source_key: 'ticket-source-key', content: '工单 ticket content',
    metadata: json({ source: { taskId: 'ticket-original-id', eventId: 'ticket-event' }, text: '工单 citation' }) });
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
  assert.deepEqual(migrateTaskLedger(db), { migrated: false });
});

test('owned memory markers migrate provenance only, preserving prose, exact identity values and unrelated comments', () => {
  for (const marker of ['memory', 'curation', 'derived', 'learning', 'dream-batch']) {
    const metadata = { id: 'ticket-memory-id', source: { ticketId: 'ticket-task-id', eventId: 'ticket-event', excerpt: '工单 原文 <tag> -->' },
      references: [{ ticketId: 'parent' }], title: '工单 记录', vendor: { ticketId: 'vendor-opaque' } };
    const prose = '\r\n用户正文 ticket 工单\r\n<!-- other {"ticketId":"unrelated"} -->\r\n';
    const content = `<!-- benchgo-${marker} ${json(metadata).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')} -->${prose}`;
    const result = migrateTaskMemoryDocument(content);
    assert.equal(result.changed, true);
    assert.equal(result.content.slice(result.content.indexOf('-->') + 3), prose);
    const saved = JSON.parse(result.content.match(/ (\{[^\r\n]*\}) -->/)[1]);
    assert.equal(saved.id, metadata.id);
    assert.deepEqual(saved.source, { taskId: 'ticket-task-id', eventId: 'ticket-event', excerpt: '工单 原文 <tag> -->' });
    assert.equal(result.content.slice(4, result.content.indexOf('-->')).includes('<tag>'), false);
    assert.deepEqual(saved.references, [{ taskId: 'parent' }]);
    assert.deepEqual(saved.vendor, metadata.vendor);
    assert.equal(saved.title, metadata.title);
    assert.equal(migrateTaskMemoryDocument(result.content).changed, false);
  }
});

test('authorization migration verifies sealed proof and finds adjustment approval on its derived task', t => {
  const db = oldStore(t);
  db.exec(`CREATE TABLE sa_triggers(id TEXT PRIMARY KEY,source TEXT,actor TEXT,dedupe_key TEXT);
    CREATE TABLE sa_ticket_revisions(ticket_id TEXT,revision INTEGER,snapshot TEXT);
    CREATE TABLE sa_ticket_authorization_approvals(approval_id TEXT PRIMARY KEY,ticket_id TEXT,fingerprint TEXT,payload TEXT);`);
  const source = { channel: 'desktop', ticketId: 'ticket-literal-id', messageId: 'ticket-original-message' };
  const actor = { kind: 'human', id: 'owner' };
  const difference = { previous: [null, null, ['assistant_tickets']], requested: [null, null, ['assistant_tickets', 'assistant_ticket_control']] };
  const payload = { triggerId: 'trigger', actorId: 'owner', source, difference };
  const originalFingerprint = digest(['ticket-literal-id', 1, 'trigger', source, actor, difference]);
  db.prepare('INSERT INTO sa_triggers VALUES (?,?,?,NULL)').run('trigger', json(source), json(actor));
  db.prepare('INSERT INTO sa_ticket_revisions VALUES (?,?,?)').run('derived-task', 1,
    json({ mandate: { authorizationVersion: 2, authorizationApproval: { id: 'approval', difference } } }));
  db.prepare('INSERT INTO sa_ticket_authorization_approvals VALUES (?,?,?,?)').run('approval', 'ticket-literal-id', 'invalid', json(payload));
  assert.throws(() => migrateTaskStorage(db), /authorization receipt fingerprint/);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='sa_tickets'").get());
  db.prepare('UPDATE sa_ticket_authorization_approvals SET fingerprint=?').run(originalFingerprint);
  migrateTaskStorage(db);
  const approval = row(db, 'sa_task_authorization_approvals'), next = JSON.parse(approval.payload);
  assert.equal(next.source.taskId, 'ticket-literal-id');
  assert.equal(next.source.messageId, source.messageId);
  assert.deepEqual(next.difference.requested[2], ['assistant_tasks', 'assistant_task_control']);
  assert.equal(approval.fingerprint, digest(['ticket-literal-id', 1, 'trigger', next.source, actor, next.difference]));
});

test('cleanup preserves frozen state proof while converting verified manifests and receipt bindings', t => {
  const db = oldStore(t);
  db.exec(`CREATE TABLE task_cleanup_previews(id TEXT PRIMARY KEY,manifest_hash TEXT,payload TEXT,consumed_by TEXT);
    CREATE TABLE task_cleanup_receipts(id TEXT PRIMARY KEY,binding TEXT,payload TEXT);`);
  const manifest = { type: 'archive', scope: { mode: 'global' },
    items: [{ id: 'ticket-literal-id', executionHash: 'sealed-execution', stateHash: 'sealed-state' }],
    excluded: [{ id: 'missing', code: 'TICKET_NOT_FOUND', reason: '工单 original reason' }], includeUnsettled: false };
  const preview = { previewId: 'preview', createdAt: 'unchanged', ...manifest, manifestHash: digest(canonical(manifest)) };
  const confirmedBy = { actorId: 'owner', ids: ['ticket-literal-id'], source: { sessionId: 'session', messageId: 'message', ticketId: 'ticket-literal-id' } };
  const receipt = { receiptId: 'receipt', operation: 'archive', previewId: 'preview', manifestHash: preview.manifestHash, confirmedBy };
  const originalBinding = digest(canonical(['archive', 'preview', confirmedBy.ids, confirmedBy.actorId, confirmedBy.source]));
  db.prepare('INSERT INTO task_cleanup_previews VALUES (?,?,?,?)').run('preview', 'invalid', json(preview), 'receipt');
  db.prepare('INSERT INTO task_cleanup_receipts VALUES (?,?,?)').run('receipt', originalBinding, json(receipt));
  assert.throws(() => migrateTaskStorage(db), /cleanup manifest fingerprint/);
  db.prepare('UPDATE task_cleanup_previews SET manifest_hash=?').run(preview.manifestHash);
  db.prepare("UPDATE task_cleanup_receipts SET binding='invalid'").run();
  assert.throws(() => migrateTaskStorage(db), /cleanup receipt fingerprint/);
  db.prepare('UPDATE task_cleanup_receipts SET binding=?').run(originalBinding);
  migrateTaskStorage(db);
  const saved = row(db, 'task_cleanup_previews'), value = JSON.parse(saved.payload);
  assert.equal(saved.consumed_by, 'receipt');
  assert.deepEqual(value.items, manifest.items);
  assert.equal(value.excluded[0].code, 'TASK_NOT_FOUND');
  assert.equal(value.excluded[0].reason, '工单 original reason');
  assert.equal(saved.manifest_hash, digest(canonical({ ...manifest, excluded: value.excluded })));
  const storedReceipt = row(db, 'task_cleanup_receipts'), nextReceipt = JSON.parse(storedReceipt.payload);
  assert.equal(nextReceipt.manifestHash, saved.manifest_hash);
  assert.equal(storedReceipt.binding, digest(canonical(['archive', 'preview', confirmedBy.ids, confirmedBy.actorId, nextReceipt.confirmedBy.source])));
});

test('watchdog migration preserves incident, delivery and execution digest identity', () => {
  const execution = { ticketId: 'ticket-id', assignmentId: 'assignment', runId: 'run', sessionId: 'session', fence: 4, instructionRevision: 2 };
  const executionKey = digest(Object.values(execution));
  const state = { checks: [{ id: 'check', executionKey, execution }],
    incidents: [{ incidentKey: 'incident', conditionKey: `stalled:${executionKey}`, execution }],
    signals: [{ id: 'signal', incidentKey: 'incident', state: 'pending', execution }],
    candidates: { [executionKey]: { execution } } };
  const { value, changed } = migrateTaskState(state);
  assert.equal(changed, true);
  assert.equal(value.checks[0].executionKey, executionKey);
  assert.equal(value.incidents[0].conditionKey, state.incidents[0].conditionKey);
  assert.equal(value.signals[0].id, 'signal');
  assert.equal(value.signals[0].state, 'pending');
  assert.equal(value.candidates[executionKey].execution.taskId, 'ticket-id');
  assert.equal(digest(Object.values(value.checks[0].execution)), executionKey);
  assert.equal(migrateTaskState(value).changed, false);
});

test('source tombstones follow task provenance without changing unrelated aliases', t => {
  const db = oldStore(t);
  db.exec('CREATE TABLE sa_idea_tombstones(alias TEXT PRIMARY KEY); CREATE TABLE sa_skill_source_tombstones(alias TEXT PRIMARY KEY);');
  for (const table of ['sa_idea_tombstones', 'sa_skill_source_tombstones']) {
    db.prepare(`INSERT INTO ${table} VALUES (?)`).run('ticket:ticket-literal-id');
    db.prepare(`INSERT INTO ${table} VALUES (?)`).run('vendor:ticket');
  }
  db.prepare('INSERT INTO sa_skill_source_tombstones VALUES (?)').run(digest(['ticket', 'ticket-literal-id']));
  migrateTaskStorage(db);
  for (const table of ['sa_idea_tombstones', 'sa_skill_source_tombstones']) {
    assert.ok(db.prepare(`SELECT 1 FROM ${table} WHERE alias=?`).get('task:ticket-literal-id'));
    assert.ok(db.prepare(`SELECT 1 FROM ${table} WHERE alias=?`).get('vendor:ticket'));
    assert.equal(db.prepare(`SELECT 1 FROM ${table} WHERE alias=?`).get('ticket:ticket-literal-id'), undefined);
  }
  assert.ok(db.prepare('SELECT 1 FROM sa_skill_source_tombstones WHERE alias=?').get(digest(['task', 'ticket-literal-id'])));
  assert.equal(db.prepare('SELECT 1 FROM sa_skill_source_tombstones WHERE alias=?').get(digest(['ticket', 'ticket-literal-id'])), undefined);
});

test('full production orchestration schema reopens migrated queued assignments and keeps all foreign keys valid', async t => {
  const { createAssistantOrchestrationStore } = await import('../src/orchestration-store.mjs');
  const directory = mkdtempSync(join(tmpdir(), 'benchgo-task-schema-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const baseline = join(directory, 'baseline.db'), filename = join(directory, 'previous.db');
  const store = createAssistantOrchestrationStore({ filename: baseline });
  let task;
  try {
    store.createThread({ id: 'thread', source: { type: 'desktop', id: 'owner' } });
    task = store.createTask({ threadId: 'thread', target: 'preserve original 工单 requirement', mandate: { source: { channel: 'desktop', sessionId: 'owner' }, instruction: 'user ticket prose' } });
    store.createAssignment(task.id, { executor: 'harness', text: task.target });
  } finally { store.close(); }
  const current = new DatabaseSync(baseline, { readOnly: true }), previous = new DatabaseSync(filename);
  const oldSql = sql => sql.replace(/sa_learning_closed_tasks/g, 'sa_learning_closed_tickets').replace(/sa_tasks/g, 'sa_tickets')
    .replace(/sa_task_/g, 'sa_ticket_').replace(/\btask_id\b/g, 'ticket_id').replace(/_task_id\b/g, '_ticket_id')
    .replace(/\$\.taskId/g, '$.ticketId');
  try {
    const schema = current.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%'").all();
    for (const table of schema) previous.exec(oldSql(table.sql));
    for (const table of schema) {
      const columns = current.prepare(`PRAGMA table_info("${table.name}")`).all().map(column => column.name);
      const insert = previous.prepare(`INSERT INTO "${oldSql(table.name)}" VALUES (${columns.map(() => '?').join(',')})`);
      for (const value of current.prepare(`SELECT * FROM "${table.name}"`).all()) insert.run(...columns.map(column => {
        const item = value[column];
        return typeof item === 'string' && (column === 'payload' || column === 'identity') ? item.replace(/"taskId":/g, '"ticketId":').replace(/"wholeTaskScope":/g, '"wholeTicketScope":') : item;
      }));
    }
    assert.equal(migrateTaskStorage(previous).migrated, true);
    assert.deepEqual(previous.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { current.close(); previous.close(); }
  const reopened = createAssistantOrchestrationStore({ filename });
  try {
    assert.equal(reopened.getTask(task.id).target, 'preserve original 工单 requirement');
    assert.equal(reopened.assignments(task.id)[0].state, 'queued');
    assert.equal(reopened.assignments(task.id)[0].taskId, task.id);
  } finally { reopened.close(); }
});
