import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { transferLegacyTaskOwnership } from '../src/legacy-ownership-transfer.mjs';
import { migrateRemoteExecutionOwnership } from '../src/remote-execution-migration.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fixture(t, { activeLease = false, unresolved = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'benchgo-ownership-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const ownerFilename = join(directory, 'owner.db'), executorFilename = join(directory, 'executor.db');
  for (const filename of [ownerFilename, executorFilename]) createAssistantOrchestrationStore({ filename }).close();
  const a = new DatabaseSync(ownerFilename), b = new DatabaseSync(executorFilename);
  const at = new Date().toISOString(), requestId = 'opaque-request', taskId = 'old-peer-task';
  const origin = { sessionId: 'router-a', messageId: 'message-a', threadId: 'main', instruction: 'Inspect repository and report.' };
  const reference = { deviceId: 'device-b', requestId, origin, state: unresolved ? 'pending' : 'accepted',
    ...(!unresolved ? { executionRef: { taskId } } : {}) };
  a.prepare('INSERT INTO sa_remote_execution_migrations VALUES (?,?,?,?)').run('legacy-origin-references', 'origin-references', JSON.stringify([reference]), at);
  const source = { channel: 'link', deviceId: 'device-a', sessionId: origin.sessionId, messageId: origin.messageId, threadId: origin.threadId };
  const mandate = { actorId: 'device:device-a', source, instruction: origin.instruction, policyVersion: 'old-policy', admission: 'link-device-delegation' };
  b.prepare('INSERT INTO sa_threads VALUES (?,?,?,?,?)').run('thread-b', 'link', 'device-a', '{}', at);
  b.prepare('INSERT INTO sa_triggers(id,dedupe_key,thread_id,source,actor,content,content_hash,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('trigger-b', 'old-dedupe', 'thread-b', JSON.stringify(source), JSON.stringify({ kind: 'human', id: mandate.actorId }), origin.instruction, digest(origin.instruction), at);
  b.prepare('INSERT INTO sa_tasks(id,thread_id,target,status,mandate,created_at,updated_at,title,acceptance) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(taskId, 'thread-b', origin.instruction, 'running', JSON.stringify(mandate), at, at, 'Inspect repository', 'Report findings');
  b.prepare('INSERT INTO sa_task_triggers VALUES (?,?)').run(taskId, 'trigger-b');
  b.prepare('INSERT INTO sa_desktop_requests VALUES (?,?,?,?)').run(`link:${digest(['device-a', requestId])}`, 'original-fingerprint', taskId, 'trigger-b');
  b.prepare('INSERT INTO sa_assignments(id,task_id,payload,state,priority,owner,lease_until,fence,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run('assignment-b', taskId, JSON.stringify({ executor: 'harness', instructionRevision: 1, model: { providerId: 'opaque/provider', modelId: 'model:unchanged' } }),
      'claimed', 0, 'old-worker', activeLease ? Date.now() + 60000 : 1, 1, at, at);
  b.prepare('INSERT INTO sa_runs VALUES (?,?,?,?,?,?,?,?)').run('run-b', 'assignment-b', 1, 'old-worker', 'running', JSON.stringify({ sessionId: 'official-session-b', instructionRevision: 1, evidence: { effectsVerified: false } }), at, at);
  b.prepare('INSERT INTO sa_results VALUES (?,?,?,?)').run(taskId, 1, JSON.stringify({ taskId, version: 1, summary: 'Partial original text', instructionRevision: 1 }), at);
  b.prepare('INSERT INTO sa_outbox(id,unique_key,task_id,payload,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
    .run('outbox-b', 'attention:question-b', taskId, JSON.stringify({ source, type: 'task.attention', text: 'Proceed?' }), 'queued', at, at);
  b.prepare('INSERT INTO sa_attentions VALUES (?,?,?,?,?,?,?,?,?,?)').run('attention-b', 'assignment-b', taskId, 'official-session-b', JSON.stringify(['official-session-b', 'call-b', 'q-b']), JSON.stringify({ id: 'q-b', question: 'Proceed?' }), 'outbox-b', null, at, 1);
  a.close(); b.close();
  return { ownerFilename, executorFilename, deviceId: 'device-b', hostId: 'host-b', authorizationId: 'auth-a-b', principalDeviceId: 'device-a' };
}

test('dry-run is read-only; explicit transfer moves business history to A and retires B atomically', t => {
  const options = fixture(t);
  const beforeA = readFileSync(options.ownerFilename), beforeB = readFileSync(options.executorFilename);
  assert.equal(transferLegacyTaskOwnership(options).applied, false);
  assert.deepEqual(readFileSync(options.ownerFilename), beforeA);
  assert.deepEqual(readFileSync(options.executorFilename), beforeB);
  const result = transferLegacyTaskOwnership({ ...options, apply: true });
  assert.equal(result.items.length, 1);
  const a = new DatabaseSync(options.ownerFilename), b = new DatabaseSync(options.executorFilename);
  const task = a.prepare('SELECT * FROM sa_tasks WHERE id=?').get('old-peer-task');
  assert.equal(task.thread_id, 'desktop:router-a');
  assert.equal(JSON.parse(task.mandate).source.channel, 'desktop');
  assert.equal(JSON.parse(task.mandate).execution.config.models[0].modelId, 'model:unchanged');
  assert.equal(JSON.parse(task.continuation_wait).stage, 'migration');
  assert.equal(a.prepare('SELECT state FROM sa_assignments').get().state, 'blocked');
  assert.equal(a.prepare('SELECT state FROM sa_runs').get().state, 'uncertain');
  assert.equal(a.prepare('SELECT payload FROM sa_results').get().payload.includes('Partial original text'), true);
  assert.equal(a.prepare('SELECT question FROM sa_attentions').get().question.includes('Proceed?'), true);
  assert.equal(b.prepare('SELECT count(*) AS n FROM sa_tasks').get().n, 0);
  assert.equal(b.prepare('SELECT count(*) AS n FROM sa_assignments').get().n, 0);
  assert.equal(b.prepare('SELECT count(*) AS n FROM sa_triggers').get().n, 0);
  assert.equal(b.prepare('SELECT count(*) AS n FROM sa_threads').get().n, 0);
  assert.equal(b.prepare("SELECT count(*) AS n FROM sa_remote_execution_migrations WHERE kind='executor-retired'").get().n, 1);
  assert.deepEqual(a.prepare('PRAGMA foreign_key_check').all(), []);
  assert.deepEqual(b.prepare('PRAGMA foreign_key_check').all(), []);
  a.close(); b.close();
  assert.equal(transferLegacyTaskOwnership({ ...options, apply: true }).items[0].alreadyTransferred, true);
  assert.throws(() => transferLegacyTaskOwnership({ ...options, authorizationId: 'different-authorization', apply: true }), { code: 'MIGRATION_RECEIPT_CONFLICT' });
});

test('unknown acceptance, wrong principal and live leases are rejected without guessing', t => {
  const unresolved = fixture(t, { unresolved: true });
  assert.throws(() => transferLegacyTaskOwnership(unresolved), { code: 'MIGRATION_ACCEPTANCE_UNKNOWN' });
  const ordinary = fixture(t);
  assert.throws(() => transferLegacyTaskOwnership({ ...ordinary, principalDeviceId: 'other-device' }), { code: 'MIGRATION_REQUEST_MISMATCH' });
  const active = fixture(t, { activeLease: true });
  assert.throws(() => transferLegacyTaskOwnership({ ...active, apply: true }), { code: 'MIGRATION_EXECUTION_ACTIVE' });
});

test('schema/reference failure rolls back A import and B removal together', t => {
  const options = fixture(t);
  const b = new DatabaseSync(options.executorFilename);
  b.exec('CREATE TABLE custom_business_reference(id TEXT PRIMARY KEY, parent TEXT REFERENCES sa_tasks(id))');
  b.prepare('INSERT INTO custom_business_reference VALUES (?,?)').run('uncovered', 'old-peer-task'); b.close();
  assert.throws(() => transferLegacyTaskOwnership({ ...options, apply: true }), { code: 'MIGRATION_REFERENCE_CONFLICT' });
  const a = new DatabaseSync(options.ownerFilename), peer = new DatabaseSync(options.executorFilename);
  assert.equal(a.prepare('SELECT count(*) AS n FROM sa_tasks').get().n, 0);
  assert.equal(peer.prepare('SELECT count(*) AS n FROM sa_tasks').get().n, 1);
  a.close(); peer.close();
});

test('follow-up references use the original admission proof and never duplicate the migrated Task', t => {
  const options = fixture(t), a = new DatabaseSync(options.ownerFilename);
  const row = a.prepare("SELECT payload FROM sa_remote_execution_migrations WHERE id='legacy-origin-references'").get();
  const original = JSON.parse(row.payload)[0];
  a.prepare("UPDATE sa_remote_execution_migrations SET payload=? WHERE id='legacy-origin-references'")
    .run(JSON.stringify([original, { ...original, requestId: 'follow-up-request', origin: { ...original.origin, messageId: 'follow-up-message' } }])); a.close();
  assert.equal(transferLegacyTaskOwnership({ ...options, apply: true }).items.length, 1);
  assert.equal(transferLegacyTaskOwnership({ ...options, apply: true }).items[0].alreadyTransferred, true);
});

test('an independent B task keeps its exact requirements and remains on B', t => {
  const options = fixture(t), b = new DatabaseSync(options.executorFilename), at = new Date().toISOString();
  b.prepare('INSERT INTO sa_threads VALUES (?,?,?,?,?)').run('local-b', 'desktop', 'owner-b', '{}', at);
  b.prepare('INSERT INTO sa_tasks(id,thread_id,target,status,mandate,created_at,updated_at,title) VALUES (?,?,?,?,?,?,?,?)')
    .run('independent-b', 'local-b', 'Keep this task unchanged', 'waiting', JSON.stringify({ source: { channel: 'desktop', sessionId: 'owner-b' }, admission: 'desktop-approved-delegation' }), at, at, 'Local B task'); b.close();
  transferLegacyTaskOwnership({ ...options, apply: true });
  const peer = new DatabaseSync(options.executorFilename);
  assert.deepEqual(peer.prepare('SELECT id,target FROM sa_tasks').all().map(row => ({ ...row })), [{ id: 'independent-b', target: 'Keep this task unchanged' }]);
  assert.equal(peer.prepare('SELECT id FROM sa_threads').get().id, 'local-b'); peer.close();
});

test('automatic retirement suppresses old outbound notices and retains original evidence once', t => {
  const options = fixture(t), b = new DatabaseSync(options.executorFilename);
  b.prepare("DELETE FROM task_meta WHERE key='remote-execution-ownership-v1'").run();
  const tx = fn => { b.exec('BEGIN IMMEDIATE'); try { const result = fn(); b.exec('COMMIT'); return result; } catch (error) { b.exec('ROLLBACK'); throw error; } };
  migrateRemoteExecutionOwnership({ db: b, tx }); migrateRemoteExecutionOwnership({ db: b, tx });
  assert.equal(b.prepare('SELECT state FROM sa_outbox').get().state, 'sent');
  assert.equal(b.prepare('SELECT state FROM sa_assignments').get().state, 'blocked');
  const archive = JSON.parse(b.prepare("SELECT payload FROM sa_remote_execution_migrations WHERE kind='target-task'").get().payload);
  assert.equal(archive.tables.sa_outbox[0].state, 'queued');
  assert.equal(archive.tables.sa_attentions[0].question.includes('Proceed?'), true);
  assert.equal(b.prepare("SELECT count(*) AS n FROM sa_remote_execution_migrations WHERE kind='target-task'").get().n, 1);
  b.close();
});
