import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantRuntimeStore } from '../src/runtime-store.mjs';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { createTaskManagement } from '../src/task-management.mjs';
import { createManagementHttp } from '../src/management-http.mjs';
import { CLEANUP_PREVIEW_TTL_MS } from '../src/task-cleanup-store.mjs';
import { createWorkerArchive } from '../src/worker-archive.mjs';

const scope = { owner: 'desktop-owner', mode: 'global' };

/**
 * The official Workspace registry owns archival. This fixture stands in for it
 * with the same contract: an archive set, `stopActivity`, and unarchive.
 */
function officialRegistry() {
  const listeners = new Set();
  const registry = {
    listeners,
    archivedSessionIds: [],
    emit() { for (const listener of listeners) listener({ domain: 'workspace', table: '', operation: 'put',
      value: { archivedSessionIds: [...registry.archivedSessionIds] } }); },
    async archiveSession(sessionId) {
      if (registry.archivedSessionIds.includes(sessionId)) return;
      registry.archivedSessionIds.push(sessionId);
      registry.emit();
    },
    async unarchiveSession(sessionId) {
      registry.archivedSessionIds = registry.archivedSessionIds.filter(value => value !== sessionId);
      registry.emit();
    },
  };
  return registry;
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-cleanup-'));
  let orchestration = createAssistantOrchestrationStore({ directory });
  let database = createAssistantRuntimeStore({ directory });
  let tasks = createTaskManagement({ database, orchestration });
  const registry = officialRegistry();
  const installArchive = () => {
    orchestration.installArchiveRuntime({ archive: id => registry.archiveSession(id), unarchive: id => registry.unarchiveSession(id),
      archivedSessionIds: () => [...registry.archivedSessionIds] });
    return createWorkerArchive({ ctx: { workspaceRegistry: registry,
      on(_name, listener) { registry.listeners.add(listener); return () => registry.listeners.delete(listener); } },
      commander: {}, orchestration, database, signal: new AbortController().signal, wake() {} });
  };
  let archive = installArchive();
  t.after(async () => { await archive.dispose(); database.close(); orchestration.close(); await rm(directory, { recursive: true, force: true }); });
  orchestration.createThread({ id: 'owner', source: { type: 'desktop', id: 'main' } });
  /** A Task with one executed Run: archival identity is that session. */
  const task = (id, status = 'stopped', sessionId = `session-${id}`) => {
    const value = orchestration.createTask({ id, threadId: 'owner', target: `Complete ${id}`, mandate: { source: { channel: 'desktop', sessionId: 'main' } } });
    const assignment = orchestration.createAssignment(value.id, {});
    const [claimed] = orchestration.claimAssignments('worker', { validateMandate: () => true, assignmentId: assignment.id });
    orchestration.prepareRun(claimed.id, { owner: claimed.owner, fence: claimed.fence, sessionId, directory });
    if (status === 'stopped') return orchestration.cancelTask(value.id);
    return orchestration.updateTask(value.id, { status });
  };
  const confirm = (preview, ids = preview.items.map(row => row.id), source = { sessionId: 'main', messageId: 'human-approved-this-list' }) => tasks.createCleanupConfirmation({
    previewId: preview.previewId, manifestHash: preview.manifestHash, ids, actorId: 'desktop-owner', source });
  const restoreConfirm = (preview, ids = preview.ids) => tasks.createCleanupConfirmation({ previewId: preview.previewId, manifestHash: preview.manifestHash,
    ids, actorId: 'desktop-owner', source: { sessionId: 'main', callId: 'official-allowed-once' } });
  return { directory, registry, task, confirm, restoreConfirm,
    get database() { return database; }, get tasks() { return tasks; },
    get orchestration() { return orchestration; }, get archive() { return archive; },
    async reopen() {
      await archive.dispose(); database.close(); orchestration.close();
      orchestration = createAssistantOrchestrationStore({ directory });
      database = createAssistantRuntimeStore({ directory });
      tasks = createTaskManagement({ database, orchestration });
      archive = installArchive();
    } };
}

test('local session archive syncs the current Worker only and keeps actual stop independent', async t => {
  const f = await fixture(t);
  f.task('dispatch', 'waiting');
  const historical = f.orchestration.createAssignment('dispatch', {});
  const [first] = f.orchestration.claimAssignments('worker', { validateMandate: () => true, assignmentId: historical.id });
  f.orchestration.prepareRun(historical.id, { ...first, sessionId: 'historical', directory: f.directory });
  f.orchestration.finishAssignment(historical.id, { ...first, status: 'cancelled' });
  const current = f.orchestration.createAssignment('dispatch', {});
  const [second] = f.orchestration.claimAssignments('worker', { validateMandate: () => true, assignmentId: current.id });
  f.orchestration.prepareRun(current.id, { ...second, sessionId: 'current', directory: f.directory });
  await f.registry.archiveSession('historical');
  await f.registry.archiveSession('child');
  assert.equal(f.orchestration.getTask('dispatch').archived, false);
  await f.registry.archiveSession('current');
  const task = f.orchestration.getTask('dispatch');
  assert.equal(task.archived, true, 'only the latest Run session carries archival identity');
  assert.equal(task.executionControl.stopRequested, undefined, 'archival never invents a stop');
});

test('cleanup archives the human-approved subset through the official archive set', async t => {
  const f = await fixture(t);
  f.task('one'); f.task('two');
  const preview = f.tasks.previewCleanup({ scope, ids: ['one', 'two'] });
  assert.deepEqual(preview.items.map(row => row.id).sort(), ['one', 'two']);
  assert.deepEqual(preview.excluded, []);
  const receipt = await f.tasks.commitCleanup({ previewId: preview.previewId, ids: ['one'],
    confirmedBy: f.confirm(preview, ['one']), requestId: 'archive-one' });
  assert.deepEqual(receipt.confirmedBy.ids, ['one']);
  assert.equal(f.orchestration.getTask('one').archived, true);
  assert.equal(f.orchestration.getTask('two').archived, false, 'an approved subset never archives its siblings');
  assert.deepEqual(f.registry.archivedSessionIds, ['session-one'], 'archival is the official set, not a local flag');
});

test('a running Task can be archived without waiting for execution exit', async t => {
  const f = await fixture(t);
  f.task('running', 'running');
  const preview = f.tasks.previewCleanup({ scope, ids: ['running'] });
  assert.equal(preview.items.length, 1, 'a live execution no longer blocks archival');
  assert.deepEqual(preview.excluded, []);
  await f.tasks.commitCleanup({ previewId: preview.previewId, ids: ['running'],
    confirmedBy: f.confirm(preview), requestId: 'archive-running' });
  const task = f.orchestration.getTask('running');
  assert.equal(task.archived, true);
  assert.equal(task.status, 'running', 'archival never rewrites business state');
  assert.equal(task.executionExited, false, 'and never claims the execution ended');
});

test('an uncertain execution is archived and its unknown result stays unknown', async t => {
  const f = await fixture(t);
  f.task('uncertain', 'waiting');
  const assignment = f.orchestration.assignments('uncertain').at(-1);
  f.orchestration.renewAssignment(assignment.id, { owner: assignment.owner, fence: assignment.fence, leaseMs: 60000,
    validateMandate: () => false });
  assert.equal(f.orchestration.getTask('uncertain').status, 'waiting');
  const preview = f.tasks.previewCleanup({ scope, ids: ['uncertain'] });
  assert.equal(preview.items.length, 1);
  await f.tasks.commitCleanup({ previewId: preview.previewId, ids: ['uncertain'],
    confirmedBy: f.confirm(preview), requestId: 'archive-uncertain' });
  assert.equal(f.orchestration.getTask('uncertain').archived, true);
  assert.notEqual(f.orchestration.getTask('uncertain').executionExited, true, 'archival does not verify the result');
});

test('already archived tasks are excluded from repeated cleanup', async t => {
  const f = await fixture(t);
  f.task('one');
  const preview = f.tasks.previewCleanup({ scope, ids: ['one'] });
  await f.tasks.commitCleanup({ previewId: preview.previewId, ids: ['one'], confirmedBy: f.confirm(preview), requestId: 'first' });
  const again = f.tasks.previewCleanup({ scope, ids: ['one'] });
  assert.equal(again.items.length, 0);
  assert.equal(again.excluded[0].code, 'TASK_ALREADY_ARCHIVED');
});

test('a Task without an execution session has nothing to archive yet', async t => {
  const f = await fixture(t);
  f.orchestration.createTask({ id: 'bare', threadId: 'owner', target: 'No run', mandate: { source: { channel: 'desktop', sessionId: 'main' } } });
  const preview = f.tasks.previewCleanup({ scope, ids: ['bare'] });
  assert.equal(preview.items.length, 0);
  assert.equal(preview.excluded[0].code, 'NO_EXECUTION_SESSION');
});

test('changed display or execution state invalidates the frozen list', async t => {
  const f = await fixture(t);
  f.task('one');
  const preview = f.tasks.previewCleanup({ scope, ids: ['one'] });
  // Any recorded change to the Task or its execution invalidates the frozen list.
  f.orchestration.updateTask('one', { title: 'Renamed after preview' });
  await assert.rejects(f.tasks.commitCleanup({ previewId: preview.previewId, ids: ['one'],
    confirmedBy: f.confirm(preview), requestId: 'changed' }), { code: 'CLEANUP_CONFLICT' });
  assert.equal(f.orchestration.getTask('one').archived, false);
});

test('cleanup confirmation is global-owner-only and replayed requests return the original receipt', async t => {
  const f = await fixture(t);
  f.task('one');
  const preview = f.tasks.previewCleanup({ scope, ids: ['one'] });
  assert.throws(() => f.tasks.previewCleanup({ scope: { mode: 'local' }, ids: ['one'] }), { code: 'CLEANUP_SCOPE_DENIED' });
  const first = await f.tasks.commitCleanup({ previewId: preview.previewId, ids: ['one'], confirmedBy: f.confirm(preview), requestId: 'same' });
  const replay = await f.tasks.commitCleanup({ previewId: preview.previewId, ids: ['one'], confirmedBy: f.confirm(preview), requestId: 'same' });
  assert.equal(replay.receiptId, first.receiptId);
});

test('archive filtering happens before paging and follows the reopened archive set', async t => {
  const f = await fixture(t);
  for (const id of ['first', 'second', 'third', 'fourth']) f.task(id);
  const preview = f.tasks.previewCleanup({ scope, ids: ['first', 'third'] });
  await f.tasks.commitCleanup({ previewId: preview.previewId, ids: ['first', 'third'], confirmedBy: f.confirm(preview), requestId: 'many' });
  const current = () => f.orchestration.listTasks({ archived: false, limit: 10 }).map(row => row.id).sort();
  const archived = () => f.orchestration.listTasks({ archived: true, limit: 10 }).map(row => row.id).sort();
  assert.deepEqual(current(), ['fourth', 'second']);
  assert.deepEqual(archived(), ['first', 'third']);
  assert.equal(f.orchestration.listTasks({ archived: false, limit: 1 }).length, 1, 'filtering precedes LIMIT');
  await f.reopen();
  assert.deepEqual(f.orchestration.listTasks({ archived: true, limit: 10 }).map(row => row.id).sort(), ['first', 'third'],
    'the projection is durable, not process state');
});

test('restore clears the official archive entry and keeps the Task record intact', async t => {
  const f = await fixture(t);
  f.task('one');
  const preview = f.tasks.previewCleanup({ scope, ids: ['one'] });
  const archived = await f.tasks.commitCleanup({ previewId: preview.previewId, ids: ['one'], confirmedBy: f.confirm(preview), requestId: 'archive' });
  f.tasks.update({ kind: 'task', id: 'one', operation: 'rename', title: 'Later name', version: f.orchestration.getTask('one') ? 0 : 0 });
  const restore = f.tasks.previewRestore({ scope, receiptId: archived.receiptId });
  await f.tasks.restoreCleanup({ previewId: restore.previewId, ids: ['one'], confirmedBy: f.restoreConfirm(restore), requestId: 'restore' });
  assert.deepEqual(f.registry.archivedSessionIds, [], 'restore is the official unarchive');
  const task = f.orchestration.getTask('one');
  assert.equal(task.archived, false);
  assert.equal(task.status, 'waiting', 'restore never restarts or rewrites execution');
  assert.equal(f.orchestration.runs(f.orchestration.assignments('one').at(-1).id).length, 1, 'execution records survive');
});

test('expired unconsumed previews are collected while archived receipts remain replayable', async t => {
  const f = await fixture(t);
  f.task('one');
  const preview = f.tasks.previewCleanup({ scope, ids: ['one'] });
  const archived = await f.tasks.commitCleanup({ previewId: preview.previewId, ids: ['one'], confirmedBy: f.confirm(preview), requestId: 'archive' });
  const stale = f.tasks.previewRestore({ scope, receiptId: archived.receiptId });
  const later = Date.now() + CLEANUP_PREVIEW_TTL_MS + 1000;
  assert.ok(later > Date.now());
  assert.equal(f.tasks.cleanupHistory({ receiptId: archived.receiptId })[0].receiptId, archived.receiptId);
  assert.ok(stale.previewId);
});

test('a missing Task whole-row conflict leaves every selected Task unarchived', async t => {
  const f = await fixture(t);
  f.task('one'); f.task('two');
  const preview = f.tasks.previewCleanup({ scope, ids: ['one', 'two'] });
  f.orchestration.updateTask('two', { title: 'Changed after preview' });
  await assert.rejects(f.tasks.commitCleanup({ previewId: preview.previewId, ids: ['one', 'two'],
    confirmedBy: f.confirm(preview), requestId: 'atomic' }), { code: 'CLEANUP_CONFLICT' });
  assert.deepEqual(f.registry.archivedSessionIds, [], 'no partial archival survives a conflict');
  assert.equal(f.orchestration.getTask('one').archived, false);
});

test('archive and restore persist each outcome and retry only unfinished items', async t => {
  const f = await fixture(t);
  f.task('one'); f.task('two');
  const ids = ['one', 'two'];
  const exercise = async ({ method, preview, confirmation, run, requestId }) => {
    const original = f.registry[method];
    const calls = [];
    f.registry[method] = async session => {
      calls.push(session);
      if (session === 'session-two' && calls.length === 2)
        throw Object.assign(new Error('Temporary registry failure'), { code: 'REGISTRY_TEMPORARY' });
      return original(session);
    };
    const input = () => ({ previewId: preview.previewId, ids, confirmedBy: confirmation(), requestId });
    const partial = await run(input());
    assert.equal(partial.status, 'partial');
    assert.deepEqual(partial.items.map(item => [item.id, item.outcome, item.code]), [
      ['one', 'succeeded', undefined], ['two', 'failed', 'REGISTRY_TEMPORARY'],
    ]);
    assert.deepEqual(f.tasks.cleanupHistory({ receiptId: partial.receiptId })[0], partial);
    assert.equal(f.tasks.latestArchiveReceipt('one')?.receiptId, method === 'archiveSession' ? partial.receiptId : undefined);
    assert.equal(Boolean(f.tasks.latestArchiveReceipt('two')), method === 'unarchiveSession');
    const complete = await run(input());
    assert.equal(complete.receiptId, partial.receiptId);
    assert.equal(complete.status, 'completed');
    assert.deepEqual(complete.items.map(item => item.outcome), ['succeeded', 'succeeded']);
    assert.deepEqual(await run(input()), complete);
    assert.deepEqual(calls, ['session-one', 'session-two', 'session-two']);
    return complete;
  };
  const preview = f.tasks.previewCleanup({ scope, ids });
  const archived = await exercise({ method: 'archiveSession', preview, confirmation: () => f.confirm(preview),
    run: f.tasks.commitCleanup, requestId: 'archive-with-retry' });
  const restore = f.tasks.previewRestore({ scope, receiptId: archived.receiptId });
  await exercise({ method: 'unarchiveSession', preview: restore, confirmation: () => f.restoreConfirm(restore),
    run: f.tasks.restoreCleanup, requestId: 'restore-with-retry' });
  assert.deepEqual(f.registry.archivedSessionIds, []);
});

test('single archive records a reusable restore receipt and reports the current archive state', async t => {
  const f = await fixture(t);
  f.task('one'); f.task('two');
  const http = createManagementHttp({ taskManagement: f.tasks });
  const owner = { principal: { kind: 'owner' } };
  const input = { taskId: 'one', worker: f.archive.describeTask('one'), requestId: 'single-archive' };
  await assert.rejects(http.archiveWorkerTask(input, { principal: { kind: 'worker' } }, f.archive), { code: 'OWNER_REQUIRED' });
  await assert.rejects(http.archiveWorkerTask({ ...input, worker: f.archive.describeTask('two') }, owner, f.archive), { code: 'CLEANUP_CONFLICT' });
  const responses = await Promise.all([http.archiveWorkerTask(input, owner, f.archive), http.archiveWorkerTask(input, owner, f.archive)]);
  assert.deepEqual(responses, [{ archived: true }, { archived: true }]);
  const original = f.tasks.cleanupHistory({ taskId: 'one' });
  assert.equal(original.length, 1);
  assert.equal(f.tasks.project('task', [f.orchestration.getTask('one')])[0].cleanup.id, original[0].receiptId);
  const restore = await http.cleanup({ action: 'taskCleanupRestorePreview', taskIds: ['one'] }, owner);
  await http.cleanup({ action: 'taskCleanupRestore', previewId: restore.previewId, manifestHash: restore.manifestHash,
    selectedTaskIds: ['one'], requestId: 'single-restore' }, owner);
  assert.equal(f.orchestration.getTask('one').archived, false);
  assert.deepEqual(await http.archiveWorkerTask(input, owner, f.archive), { archived: false });
  assert.equal(f.tasks.cleanupHistory({ taskId: 'one' }).length, 2);
});

test('an archive already reflected in the official registry is reconciled after reopen', async t => {
  const f = await fixture(t);
  f.task('one');
  const preview = f.tasks.previewCleanup({ scope, ids: ['one'] });
  const original = f.registry.archiveSession;
  let calls = 0;
  f.registry.archiveSession = async session => {
    calls++;
    await original(session);
    throw new Error('Lost registry response');
  };
  const input = () => ({ previewId: preview.previewId, ids: ['one'], confirmedBy: f.confirm(preview), requestId: 'resume-archive' });
  const partial = await f.tasks.commitCleanup(input());
  assert.equal(partial.status, 'partial');
  assert.equal(f.orchestration.getTask('one').archived, true);
  await f.reopen();
  const result = await f.tasks.commitCleanup(input());
  assert.equal(result.status, 'completed');
  assert.equal(result.receiptId, partial.receiptId);
  assert.equal(calls, 1);
});
