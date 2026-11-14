import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAssistantRuntimeStore } from '../src/runtime-store.mjs';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { createTaskManagement } from '../src/task-management.mjs';
import { CLEANUP_PREVIEW_TTL_MS } from '../src/task-cleanup-store.mjs';

const scope = { owner: 'desktop-owner', mode: 'global' };
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-cleanup-'));
  const orchestration = createAssistantOrchestrationStore({ directory });
  let database = createAssistantRuntimeStore({ directory });
  let tasks = createTaskManagement({ database, orchestration });
  t.after(async () => { database.close(); orchestration.close(); await rm(directory, { recursive: true, force: true }); });
  orchestration.createThread({ id: 'owner', source: { type: 'desktop', id: 'main' } });
  const task = (id, status = 'stopped') => {
    const value = orchestration.createTask({ id, threadId: 'owner', target: `Complete ${id}`, mandate: { source: { channel: 'desktop', sessionId: 'main' } } });
    return status === 'stopped' ? orchestration.cancelTask(value.id) : orchestration.updateTask(value.id, { status });
  };
  const confirm = (preview, ids = preview.items.map(row => row.id), source = { sessionId: 'main', messageId: 'human-approved-this-list' }) => tasks.createCleanupConfirmation({
    previewId: preview.previewId, manifestHash: preview.manifestHash, ids, actorId: 'desktop-owner', source });
  const restoreConfirm = (preview, ids = preview.ids) => tasks.createCleanupConfirmation({ previewId: preview.previewId, manifestHash: preview.manifestHash,
    ids, actorId: 'desktop-owner', source: { sessionId: 'main', callId: 'official-allowed-once' } });
  return { directory, orchestration, task, confirm, restoreConfirm,
    get database() { return database; }, get tasks() { return tasks; },
    reopen() { database.close(); database = createAssistantRuntimeStore({ directory }); tasks = createTaskManagement({ database, orchestration }); } };
}

test('cleanup freezes a persistent list, excludes unsettled work and archives only the human-approved subset', async t => {
  const f = await fixture(t);
  f.task('one'); f.task('two'); f.task('waiting', 'waiting'); f.task('completed', 'completed');
  const artifact = join(f.directory, 'result.txt'); await writeFile(artifact, 'keep result');
  const before = f.orchestration.getTask('one');
  const preview = f.tasks.previewCleanup({ scope, ids: ['one', 'two', 'waiting', 'missing'], includeUnsettled: true });
  assert.deepEqual(preview.items.map(row => row.id), ['one', 'two']);
  assert.deepEqual(preview.excluded.map(row => row.code), ['TASK_NOT_FOUND', 'EXECUTION_PENDING']);
  assert.equal(preview.excluded.find(row => row.id === 'waiting').snapshot.status, 'waiting');
  f.reopen(); assert.deepEqual(f.tasks.getCleanupPreview(preview.previewId).items, preview.items);
  const confirmedBy = f.confirm(preview, ['one']);
  for (const invalid of [true, { ...confirmedBy }, JSON.parse(JSON.stringify(confirmedBy))])
    assert.throws(() => f.tasks.commitCleanup({ previewId: preview.previewId, ids: ['one'], confirmedBy: invalid, requestId: 'archive-1' }), { code: 'CLEANUP_CONFIRMATION_REQUIRED' });
  assert.throws(() => f.tasks.commitCleanup({ previewId: preview.previewId, ids: ['one', 'two'], confirmedBy, requestId: 'archive-1' }), { code: 'CLEANUP_CONFIRMATION_REQUIRED' });
  const receipt = f.tasks.commitCleanup({ previewId: preview.previewId, ids: ['one'], confirmedBy, requestId: 'archive-1' });
  assert.deepEqual(receipt.items.map(row => row.id), ['one']);
  assert.deepEqual(f.tasks.commitCleanup({ previewId: preview.previewId, ids: ['one'], confirmedBy, requestId: 'archive-1' }), receipt);
  assert.throws(() => f.tasks.commitCleanup({ previewId: preview.previewId, ids: ['one'], confirmedBy, requestId: 'different-request' }), { code: 'CLEANUP_PREVIEW_CONSUMED' });
  assert.deepEqual({ ...f.orchestration.getTask('one'), archived: false }, before, 'archive only changes the presentation flag, never domain state or requirements');
  assert.equal(f.orchestration.getTask('one').archived, true);
  assert.equal(await readFile(artifact, 'utf8'), 'keep result');
  assert(f.orchestration.listTasks({ archived: true }).some(row => row.id === 'one'));
  assert(!f.orchestration.listTasks({ archived: false }).some(row => row.id === 'one'));
  assert.equal(Object.hasOwn(f.tasks.project('task', [before], { archived: true })[0].taskMeta, 'deleted'), false);
  assert.equal(f.tasks.cleanupHistory({ taskId: 'one' }).length, 1);
  assert.deepEqual(f.tasks.cleanupHistory({ receiptId: receipt.receiptId, limit: 10 }), [receipt]);
  assert.deepEqual(f.tasks.cleanupHistory({ receiptId: receipt.receiptId, taskId: 'two' }), []);
  assert.deepEqual(f.tasks.cleanupHistory({ receiptId: 'missing' }), []);
  assert.throws(() => f.tasks.cleanupHistory({ receiptId: '' }), { code: 'CLEANUP_INPUT_INVALID' });
  const next = f.tasks.previewCleanup({ scope, ids: ['two'] });
  assert.throws(() => f.tasks.commitCleanup({ previewId: next.previewId, ids: ['two'], confirmedBy: f.confirm(next), requestId: 'archive-1' }), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('already archived tasks are excluded from repeated cleanup and retain their original restore receipt', async t => {
  const f = await fixture(t); f.task('archived'); f.task('visible');
  const original = f.orchestration.getTask('archived');
  const preview = f.tasks.previewCleanup({ scope, ids: ['archived'] });
  const receipt = f.tasks.commitCleanup({ previewId: preview.previewId, ids: ['archived'], confirmedBy: f.confirm(preview), requestId: 'first-archive' });
  const metadata = f.database.meta('task-presentation:task:archived');
  const repeated = f.tasks.previewCleanup({ scope, ids: ['archived', 'visible'] });
  assert.deepEqual(repeated.items.map(row => row.id), ['visible']);
  assert.deepEqual(repeated.excluded.map(row => ({ id: row.id, code: row.code })), [{ id: 'archived', code: 'TASK_ALREADY_ARCHIVED' }]);
  assert.throws(() => f.confirm(repeated, ['archived']), { code: 'CLEANUP_CONFIRMATION_REQUIRED' });
  const global = f.tasks.previewCleanup({ scope });
  assert.deepEqual(global.items.map(row => row.id), ['visible']);
  assert.deepEqual(global.excluded, []);
  assert.deepEqual(f.database.meta('task-presentation:task:archived'), metadata);
  assert.equal(f.tasks.cleanupHistory({ taskId: 'archived' }).length, 1);
  f.reopen();
  const restore = f.tasks.previewRestore({ scope, receiptId: receipt.receiptId });
  f.tasks.restoreCleanup({ previewId: restore.previewId, ids: ['archived'], confirmedBy: f.restoreConfirm(restore), requestId: 'restore-original' });
  assert.deepEqual(f.orchestration.getTask('archived'), original);
  assert.deepEqual(f.tasks.previewCleanup({ scope }).items.map(row => row.id).sort(), ['archived', 'visible']);
});

test('expired unconsumed restore previews are collected while archived receipts remain replayable', async t => {
  const f = await fixture(t); f.task('one');
  const preview = f.tasks.previewCleanup({ scope, ids: ['one'] });
  const args = { previewId: preview.previewId, ids: ['one'], requestId: 'durable-archive' };
  const archived = f.tasks.commitCleanup({ ...args, confirmedBy: f.confirm(preview) });
  const restore = f.tasks.previewRestore({ scope, receiptId: archived.receiptId });
  const old = new Date(Date.now() - 2 * CLEANUP_PREVIEW_TTL_MS).toISOString();
  const raw = new DatabaseSync(join(f.directory, 'assistant.db'));
  try {
    raw.prepare("UPDATE task_cleanup_previews SET payload=json_set(payload,'$.createdAt',?) WHERE id IN (?,?)")
      .run(old, preview.previewId, restore.previewId);
  } finally { raw.close(); }
  assert.throws(() => f.tasks.getCleanupPreview(restore.previewId), { code: 'CLEANUP_PREVIEW_EXPIRED' });
  f.reopen();
  assert.throws(() => f.tasks.getCleanupPreview(restore.previewId), { code: 'CLEANUP_PREVIEW_NOT_FOUND' });
  assert.equal(f.tasks.getCleanupPreview(preview.previewId).consumedBy, archived.receiptId);
  assert.deepEqual(f.tasks.commitCleanup({ ...args, confirmedBy: f.confirm(preview) }), archived);
  assert.deepEqual(f.tasks.cleanupHistory({ receiptId: archived.receiptId }), [archived]);
  assert.equal(f.orchestration.getTask('one').archived, true);
});

test('cleanup confirmation is global-owner-only and all selected rows conflict atomically', async t => {
  const f = await fixture(t); f.task('one'); f.task('two');
  for (const badScope of [undefined, { owner: 'desktop-owner', mode: 'thread' }, { ...scope, sessionId: 'side' }])
    assert.throws(() => f.tasks.previewCleanup({ scope: badScope }), { code: 'CLEANUP_SCOPE_DENIED' });
  const preview = f.tasks.previewCleanup({ scope });
  const confirmedBy = f.confirm(preview);
  f.tasks.update({ kind: 'task', id: 'two', operation: 'rename', title: 'Changed', version: 0 });
  assert.throws(() => f.tasks.commitCleanup({ previewId: preview.previewId, ids: ['one', 'two'], confirmedBy, requestId: 'conflict' }), { code: 'CLEANUP_CONFLICT' });
  assert.equal(f.database.meta('task-presentation:task:one'), null, 'no first-row write survives a later conflict');
  assert.equal(f.tasks.cleanupHistory({}).length, 0);
  assert.equal(f.tasks.getCleanupPreview(preview.previewId).consumedBy, null);
  const next = f.tasks.previewCleanup({ scope });
  f.orchestration.updateTask('two', { status: 'running' });
  assert.throws(() => f.tasks.commitCleanup({ previewId: next.previewId, ids: ['one', 'two'], confirmedBy: f.confirm(next), requestId: 'status-conflict' }), { code: 'CLEANUP_CONFLICT' });
  assert.equal(f.database.meta('task-presentation:task:one'), null);
});

test('pending executor release cannot be hidden even when the task status is terminal', async t => {
  const f = await fixture(t); f.task('unsafe', 'running');
  f.orchestration.createAssignment('unsafe', {});
  const [assignment] = f.orchestration.claimAssignments('worker', { validateMandate: () => true });
  f.orchestration.prepareRun(assignment.id, { owner: assignment.owner, fence: assignment.fence, sessionId: 'worker-session', directory: '/unused' });
  f.orchestration.cancelTask('unsafe');
  const preview = f.tasks.previewCleanup({ scope, includeUnsettled: true });
  assert.equal(preview.items.length, 0); assert.equal(preview.excluded[0].code, 'EXECUTION_PENDING');
  assert.equal(f.database.meta('task-presentation:task:unsafe'), null);
});

test('a failed waiting task with ended execution can be archived without inventing stopped or completed', async t => {
  const f = await fixture(t);
  f.task('failed-wait', 'waiting');
  f.orchestration.createAssignment('failed-wait', {});
  const [assignment] = f.orchestration.claimAssignments('worker', { validateMandate: () => true });
  const run = f.orchestration.prepareRun(assignment.id, { ...assignment, sessionId: 'failed-session', directory: '/unused' });
  f.orchestration.updateRun(run.id, { ...assignment, state: 'submitted' });
  const result = { runId: run.id, sessionId: run.sessionId, outcome: 'failed', summary: '条件不足', completion: { kind: 'completed' } };
  f.orchestration.updateRun(run.id, { ...assignment, state: 'verifying', evidence: result });
  f.orchestration.confirmExecutionStopped(assignment.id, assignment);
  f.orchestration.commitResult('failed-wait', { result, assignment, uniqueKey: 'failed-result' });
  const before = f.orchestration.getTask('failed-wait');
  assert.equal(before.status, 'waiting'); assert.equal(before.executionControl.stopped, undefined);
  assert.equal(before.executionExited, true);
  const preview = f.tasks.previewCleanup({ scope, ids: ['failed-wait'] });
  assert.equal(preview.excluded.length, 0);
  f.tasks.commitCleanup({ previewId: preview.previewId, ids: ['failed-wait'], confirmedBy: f.confirm(preview), requestId: 'archive-failed' });
  assert.equal(f.orchestration.getTask('failed-wait').archived, true);
  assert.equal(f.orchestration.getTask('failed-wait').status, 'waiting');
  assert.equal(f.tasks.project('task', [f.orchestration.getTask('failed-wait')])[0].taskCanOrganize, true);
  assert.deepEqual(f.orchestration.listTasks({ archived: false }), []);
  assert.deepEqual(f.orchestration.listTasks({ archived: true, limit: 1 }).map(row => row.id), ['failed-wait']);
  f.orchestration.updateTask('failed-wait', { target: '新的明确要求' });
  assert.equal(f.orchestration.getTask('failed-wait').archived, false, 'a new instruction does not inherit archival');
});

test('waiting work with uncertain execution keeps a specific exclusion reason', async t => {
  const f = await fixture(t); f.task('unknown', 'waiting');
  f.orchestration.createAssignment('unknown', {});
  const [assignment] = f.orchestration.claimAssignments('worker', { validateMandate: () => true });
  const run = f.orchestration.prepareRun(assignment.id, { ...assignment, sessionId: 'unknown-session', directory: '/unused' });
  f.orchestration.updateRun(run.id, { ...assignment, state: 'uncertain' });
  const preview = f.tasks.previewCleanup({ scope, ids: ['unknown'] });
  assert.equal(preview.items.length, 0);
  assert.equal(preview.excluded[0].reason, '执行退出尚未确认，请先核实原执行已退出，再重新预览');
  assert.equal(f.orchestration.getTask('unknown').executionExited, false);
});

test('archive filtering happens before paging and metadata survives a reopen', async t => {
  const f = await fixture(t);
  for (const id of ['a', 'b', 'c']) f.task(id);
  const preview = f.tasks.previewCleanup({ scope, ids: ['a', 'b'] });
  f.tasks.commitCleanup({ previewId: preview.previewId, ids: ['a', 'b'], confirmedBy: f.confirm(preview), requestId: 'page' });
  assert.deepEqual(f.orchestration.listTasks({ archived: false, limit: 1 }).map(row => row.id), ['c']);
  assert.deepEqual(f.orchestration.listTasks({ archived: true, limit: 1, offset: 1 }).map(row => row.id), ['b']);
  f.reopen(); assert.equal(f.tasks.cleanupHistory({}).length, 1);
  assert.deepEqual(f.tasks.project('task', f.orchestration.listTasks(), { archived: true }).map(row => row.id).sort(), ['a', 'b']);
});

test('restore is a current-version inverse of archive fields and preserves later names and terminal state', async t => {
  const f = await fixture(t); f.task('cancelled'); f.task('completed', 'completed');
  const preview = f.tasks.previewCleanup({ scope });
  const archived = f.tasks.commitCleanup({ previewId: preview.previewId, ids: preview.items.map(row => row.id), confirmedBy: f.confirm(preview), requestId: 'archive' });
  let restore = f.tasks.previewRestore({ scope, receiptId: archived.receiptId });
  assert.equal(Object.hasOwn(restore.items.find(row => row.id === 'completed'), 'remainsAutomaticallyArchived'), false);
  f.tasks.update({ kind: 'task', id: 'cancelled', operation: 'rename', title: 'New name', version: 1 });
  assert.throws(() => f.tasks.restoreCleanup({ ...restore, confirmedBy: f.restoreConfirm(restore), requestId: 'stale-restore' }), { code: 'CLEANUP_CONFLICT' });
  restore = f.tasks.previewRestore({ scope, receiptId: archived.receiptId });
  f.reopen(); assert.equal(f.tasks.getCleanupPreview(restore.previewId).type, 'restore');
  assert.throws(() => f.tasks.update({ kind: 'task', id: 'cancelled', operation: 'complete', version: 2 }), { code: 'TASK_COMPLETION_MANAGED' });
  restore = f.tasks.previewRestore({ scope, receiptId: archived.receiptId });
  const confirmedBy = f.restoreConfirm(restore);
  const restored = f.tasks.restoreCleanup({ ...restore, confirmedBy, requestId: 'restore' });
  assert.deepEqual(f.tasks.restoreCleanup({ ...restore, confirmedBy, requestId: 'restore' }), restored);
  assert.equal(f.database.meta('task-presentation:task:cancelled').title, 'New name');
  assert.notEqual(f.tasks.project('task', [f.orchestration.getTask('cancelled')])[0].taskMeta.completed, true, 'stopped work is never marked successful');
  assert.equal(f.orchestration.getTask('cancelled').status, 'waiting');
  assert.equal(f.orchestration.getTask('cancelled').executionControl.stopped, true);
  assert.deepEqual(f.orchestration.listTasks({ archived: false }).map(row => row.id).sort(), ['cancelled', 'completed']);
  assert.deepEqual(f.orchestration.listTasks({ archived: true }).map(row => row.id), []);
  assert.equal(f.tasks.cleanupHistory({ taskId: 'cancelled' }).length, 2);
});

test('restore binds the approved subset and leaves the other archived items for a fresh preview', async t => {
  const f = await fixture(t); f.task('one'); f.task('two');
  const preview = f.tasks.previewCleanup({ scope });
  const archived = f.tasks.commitCleanup({ previewId: preview.previewId, ids: ['one', 'two'], confirmedBy: f.confirm(preview), requestId: 'archive-subset' });
  const restore = f.tasks.previewRestore({ scope, receiptId: archived.receiptId });
  const confirmedBy = f.restoreConfirm(restore, ['one']);
  assert.throws(() => f.tasks.restoreCleanup({ previewId: restore.previewId, ids: ['one', 'two'], confirmedBy, requestId: 'restore-subset' }), { code: 'CLEANUP_CONFIRMATION_REQUIRED' });
  const restored = f.tasks.restoreCleanup({ previewId: restore.previewId, ids: ['one'], confirmedBy, requestId: 'restore-subset' });
  assert.deepEqual(restored.items.map(row => row.id), ['one']);
  assert.deepEqual(f.orchestration.listTasks({ archived: false }).map(row => row.id), ['one']);
  assert.deepEqual(f.orchestration.listTasks({ archived: true }).map(row => row.id), ['two']);
  assert.throws(() => f.tasks.restoreCleanup({ previewId: restore.previewId, ids: ['two'], confirmedBy: f.restoreConfirm(restore, ['two']), requestId: 'restore-other' }), { code: 'CLEANUP_PREVIEW_CONSUMED' });
  const next = f.tasks.previewRestore({ scope, receiptId: archived.receiptId, ids: ['two'] });
  f.tasks.restoreCleanup({ previewId: next.previewId, ids: ['two'], confirmedBy: f.restoreConfirm(next), requestId: 'restore-other' });
  assert.deepEqual(f.orchestration.listTasks({ archived: true }), []);
});
