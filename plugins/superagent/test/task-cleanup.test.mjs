import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAssistantRuntimeStore } from '../src/runtime-store.mjs';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { createTaskManagement } from '../src/task-management.mjs';

const scope = { owner: 'desktop-owner', mode: 'global' };
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-cleanup-'));
  const orchestration = createAssistantOrchestrationStore({ directory });
  let database = createAssistantRuntimeStore({ directory });
  let tasks = createTaskManagement({ database, orchestration });
  t.after(async () => { database.close(); orchestration.close(); await rm(directory, { recursive: true, force: true }); });
  orchestration.createThread({ id: 'owner', source: { type: 'desktop', id: 'main' } });
  const ticket = (id, status = 'cancelled') => {
    const value = orchestration.createTicket({ id, threadId: 'owner', target: `Complete ${id}`, mandate: { source: { channel: 'desktop', sessionId: 'main' } } });
    return orchestration.updateTicket(value.id, { status });
  };
  const confirm = (preview, ids = preview.items.map(row => row.id), source = { sessionId: 'main', messageId: 'human-approved-this-list' }) => tasks.createCleanupConfirmation({
    previewId: preview.previewId, manifestHash: preview.manifestHash, ids, actorId: 'desktop-owner', source });
  const restoreConfirm = (preview, ids = preview.ids) => tasks.createCleanupConfirmation({ previewId: preview.previewId, manifestHash: preview.manifestHash,
    ids, actorId: 'desktop-owner', source: { sessionId: 'main', callId: 'official-allowed-once' } });
  return { directory, orchestration, ticket, confirm, restoreConfirm,
    get database() { return database; }, get tasks() { return tasks; },
    reopen() { database.close(); database = createAssistantRuntimeStore({ directory }); tasks = createTaskManagement({ database, orchestration }); } };
}

test('cleanup freezes a persistent list, excludes unsettled work and archives only the human-approved subset', async t => {
  const f = await fixture(t);
  f.ticket('one'); f.ticket('two'); f.ticket('waiting', 'waiting'); f.ticket('completed', 'completed');
  const artifact = join(f.directory, 'result.txt'); await writeFile(artifact, 'keep result');
  const before = f.orchestration.getTicket('one');
  const preview = f.tasks.previewCleanup({ scope, ids: ['one', 'two', 'waiting', 'missing'], includeUnsettled: true });
  assert.deepEqual(preview.items.map(row => row.id), ['one', 'two']);
  assert.deepEqual(preview.excluded.map(row => row.code), ['TICKET_NOT_FOUND', 'EXECUTION_PENDING']);
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
  assert.deepEqual({ ...f.orchestration.getTicket('one'), archived: false }, before, 'archive only changes the presentation flag, never domain state or requirements');
  assert.equal(f.orchestration.getTicket('one').archived, true);
  assert.equal(await readFile(artifact, 'utf8'), 'keep result');
  assert(f.orchestration.listTickets({ archived: true }).some(row => row.id === 'one'));
  assert(!f.orchestration.listTickets({ archived: false }).some(row => row.id === 'one'));
  assert.equal(Object.hasOwn(f.tasks.project('ticket', [before], { archived: true })[0].taskMeta, 'deleted'), false);
  assert.equal(f.tasks.cleanupHistory({ ticketId: 'one' }).length, 1);
  const next = f.tasks.previewCleanup({ scope, ids: ['two'] });
  assert.throws(() => f.tasks.commitCleanup({ previewId: next.previewId, ids: ['two'], confirmedBy: f.confirm(next), requestId: 'archive-1' }), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('cleanup confirmation is global-owner-only and all selected rows conflict atomically', async t => {
  const f = await fixture(t); f.ticket('one'); f.ticket('two');
  for (const badScope of [undefined, { owner: 'channel', mode: 'global' }, { owner: 'desktop-owner', mode: 'thread' }, { ...scope, sessionId: 'side' }])
    assert.throws(() => f.tasks.previewCleanup({ scope: badScope }), { code: 'CLEANUP_SCOPE_DENIED' });
  const preview = f.tasks.previewCleanup({ scope });
  const confirmedBy = f.confirm(preview);
  f.tasks.update({ kind: 'ticket', id: 'two', operation: 'rename', title: 'Changed', version: 0 });
  assert.throws(() => f.tasks.commitCleanup({ previewId: preview.previewId, ids: ['one', 'two'], confirmedBy, requestId: 'conflict' }), { code: 'CLEANUP_CONFLICT' });
  assert.equal(f.database.meta('task-presentation:ticket:one'), null, 'no first-row write survives a later conflict');
  assert.equal(f.tasks.cleanupHistory({}).length, 0);
  assert.equal(f.tasks.getCleanupPreview(preview.previewId).consumedBy, null);
  const next = f.tasks.previewCleanup({ scope });
  f.orchestration.updateTicket('two', { status: 'open' });
  assert.throws(() => f.tasks.commitCleanup({ previewId: next.previewId, ids: ['one', 'two'], confirmedBy: f.confirm(next), requestId: 'status-conflict' }), { code: 'CLEANUP_CONFLICT' });
  assert.equal(f.database.meta('task-presentation:ticket:one'), null);
});

test('pending executor release cannot be hidden even when the ticket status is terminal', async t => {
  const f = await fixture(t); f.ticket('unsafe', 'open');
  f.orchestration.createAssignment('unsafe', {});
  const [assignment] = f.orchestration.claimAssignments('worker', { validateMandate: () => true });
  f.orchestration.prepareRun(assignment.id, { owner: assignment.owner, fence: assignment.fence, sessionId: 'worker-session', directory: '/unused' });
  f.orchestration.updateTicket('unsafe', { status: 'cancelled' });
  const preview = f.tasks.previewCleanup({ scope, includeUnsettled: true });
  assert.equal(preview.items.length, 0); assert.equal(preview.excluded[0].code, 'EXECUTION_PENDING');
  assert.equal(f.database.meta('task-presentation:ticket:unsafe'), null);
});

test('archive filtering happens before paging and metadata survives a reopen', async t => {
  const f = await fixture(t);
  for (const id of ['a', 'b', 'c']) f.ticket(id);
  const preview = f.tasks.previewCleanup({ scope, ids: ['a', 'b'] });
  f.tasks.commitCleanup({ previewId: preview.previewId, ids: ['a', 'b'], confirmedBy: f.confirm(preview), requestId: 'page' });
  assert.deepEqual(f.orchestration.listTickets({ archived: false, limit: 1 }).map(row => row.id), ['c']);
  assert.deepEqual(f.orchestration.listTickets({ archived: true, limit: 1, offset: 1 }).map(row => row.id), ['b']);
  f.reopen(); assert.equal(f.tasks.cleanupHistory({}).length, 1);
  assert.deepEqual(f.tasks.project('ticket', f.orchestration.listTickets(), { archived: true }).map(row => row.id).sort(), ['a', 'b']);
});

test('restore is a current-version inverse of archive fields and preserves later names and terminal state', async t => {
  const f = await fixture(t); f.ticket('cancelled'); f.ticket('completed', 'completed');
  const preview = f.tasks.previewCleanup({ scope });
  const archived = f.tasks.commitCleanup({ previewId: preview.previewId, ids: preview.items.map(row => row.id), confirmedBy: f.confirm(preview), requestId: 'archive' });
  let restore = f.tasks.previewRestore({ scope, receiptId: archived.receiptId });
  assert.equal(restore.items.find(row => row.id === 'completed').remainsAutomaticallyArchived, true);
  f.tasks.update({ kind: 'ticket', id: 'cancelled', operation: 'rename', title: 'New name', version: 1 });
  assert.throws(() => f.tasks.restoreCleanup({ ...restore, confirmedBy: f.restoreConfirm(restore), requestId: 'stale-restore' }), { code: 'CLEANUP_CONFLICT' });
  restore = f.tasks.previewRestore({ scope, receiptId: archived.receiptId });
  f.reopen(); assert.equal(f.tasks.getCleanupPreview(restore.previewId).type, 'restore');
  f.tasks.update({ kind: 'ticket', id: 'cancelled', operation: 'complete', version: 2 });
  restore = f.tasks.previewRestore({ scope, receiptId: archived.receiptId });
  const confirmedBy = f.restoreConfirm(restore);
  const restored = f.tasks.restoreCleanup({ ...restore, confirmedBy, requestId: 'restore' });
  assert.deepEqual(f.tasks.restoreCleanup({ ...restore, confirmedBy, requestId: 'restore' }), restored);
  assert.equal(f.database.meta('task-presentation:ticket:cancelled').title, 'New name');
  assert.equal(f.tasks.project('ticket', [f.orchestration.getTicket('cancelled')])[0].taskMeta.completed, true, 'restore preserves a later human completion marker');
  assert.equal(f.orchestration.getTicket('cancelled').status, 'cancelled');
  assert.deepEqual(f.orchestration.listTickets({ archived: false }).map(row => row.id), ['cancelled']);
  assert.deepEqual(f.orchestration.listTickets({ archived: true }).map(row => row.id), ['completed']);
  assert.equal(f.tasks.cleanupHistory({ ticketId: 'cancelled' }).length, 2);
});

test('restore binds the approved subset and leaves the other archived items for a fresh preview', async t => {
  const f = await fixture(t); f.ticket('one'); f.ticket('two');
  const preview = f.tasks.previewCleanup({ scope });
  const archived = f.tasks.commitCleanup({ previewId: preview.previewId, ids: ['one', 'two'], confirmedBy: f.confirm(preview), requestId: 'archive-subset' });
  const restore = f.tasks.previewRestore({ scope, receiptId: archived.receiptId });
  const confirmedBy = f.restoreConfirm(restore, ['one']);
  assert.throws(() => f.tasks.restoreCleanup({ previewId: restore.previewId, ids: ['one', 'two'], confirmedBy, requestId: 'restore-subset' }), { code: 'CLEANUP_CONFIRMATION_REQUIRED' });
  const restored = f.tasks.restoreCleanup({ previewId: restore.previewId, ids: ['one'], confirmedBy, requestId: 'restore-subset' });
  assert.deepEqual(restored.items.map(row => row.id), ['one']);
  assert.deepEqual(f.orchestration.listTickets({ archived: false }).map(row => row.id), ['one']);
  assert.deepEqual(f.orchestration.listTickets({ archived: true }).map(row => row.id), ['two']);
  assert.throws(() => f.tasks.restoreCleanup({ previewId: restore.previewId, ids: ['two'], confirmedBy: f.restoreConfirm(restore, ['two']), requestId: 'restore-other' }), { code: 'CLEANUP_PREVIEW_CONSUMED' });
  const next = f.tasks.previewRestore({ scope, receiptId: archived.receiptId, ids: ['two'] });
  f.tasks.restoreCleanup({ previewId: next.previewId, ids: ['two'], confirmedBy: f.restoreConfirm(next), requestId: 'restore-other' });
  assert.deepEqual(f.orchestration.listTickets({ archived: true }), []);
});

test('legacy hidden tickets become recoverable archive tombstones without reopening execution', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-legacy-cleanup-'));
  let orchestration = createAssistantOrchestrationStore({ directory }), database;
  t.after(async () => { database?.close(); orchestration.close(); await rm(directory, { recursive: true, force: true }); });
  orchestration.createThread({ id: 'owner', source: { type: 'desktop', id: 'main' } });
  for (const id of ['legacy', 'stale', 'complete', 'visible', 'unsafe', 'archived']) {
    orchestration.createTicket({ id, threadId: 'owner', target: id, mandate: {} });
    if (id === 'unsafe') orchestration.createAssignment(id, {});
    orchestration.updateTicket(id, { status: id === 'stale' ? 'open' : 'cancelled' });
  }
  const before = orchestration.getTicket('legacy');
  orchestration.close();
  let sqlite = new DatabaseSync(join(directory, 'assistant.db'));
  const put = (kind, id, value) => sqlite.prepare('INSERT INTO task_meta(key,value) VALUES (?,?)').run(`task-presentation:${kind}:${id}`, JSON.stringify(value));
  for (const id of ['legacy', 'stale', 'unsafe']) put('ticket', id, { version: 2, deleted: true, executionRevision: 1, title: 'Legacy' });
  put('ticket', 'complete', { version: 2, deleted: false, completed: true, executionRevision: 1 });
  put('ticket', 'visible', { version: 2, deleted: false, archived: true, executionRevision: 1 });
  put('ticket', 'archived', { version: 2, deleted: false, archived: true, archiveRevision: 1, cleanupReceiptId: 'existing-receipt' });
  const existingReceipt = JSON.stringify({ receiptId: 'existing-receipt', requestId: 'existing-request', operation: 'archive',
    items: [{ id: 'archived', instructionRevision: 1, before: {}, after: { archived: true, archiveRevision: 1, cleanupReceiptId: 'existing-receipt' } }] });
  sqlite.prepare('INSERT INTO task_cleanup_receipts(id,request_id,binding,payload) VALUES (?,?,?,?)').run('existing-receipt', 'existing-request', 'existing-binding', existingReceipt);
  put('goal', 'goal', { version: 2, deleted: true }); put('evaluation', 'eval', { version: 2, deleted: true });
  sqlite.close();
  // Reopen only the authoritative store: migration must finish before runtime exists.
  orchestration = createAssistantOrchestrationStore({ directory });
  sqlite = new DatabaseSync(join(directory, 'assistant.db'));
  const meta = id => JSON.parse(sqlite.prepare('SELECT value FROM task_meta WHERE key=?').get(`task-presentation:ticket:${id}`).value);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM task_meta WHERE key LIKE 'task-presentation:ticket:%' AND json_type(value,'$.deleted') IS NOT NULL").get().n, 0);
  assert.equal(meta('legacy').archived, true); assert.equal(meta('legacy').archiveRevision, 1); assert.equal(meta('legacy').version, 3);
  assert.equal(Object.hasOwn(meta('legacy'), 'executionRevision'), false);
  assert.equal(meta('complete').completed, true); assert.equal(meta('complete').executionRevision, 1);
  assert.equal(meta('archived').archiveRevision, 1); assert.equal(meta('archived').cleanupReceiptId, 'existing-receipt');
  assert.equal(sqlite.prepare("SELECT payload FROM task_cleanup_receipts WHERE id='existing-receipt'").get().payload, existingReceipt, 'existing audit is immutable');
  assert.equal(meta('stale').archived, undefined); assert.equal(meta('unsafe').archived, undefined);
  assert.equal(sqlite.prepare("SELECT json_extract(value,'$.deleted') AS deleted FROM task_meta WHERE key='task-presentation:goal:goal'").get().deleted, 1);
  assert.equal(sqlite.prepare("SELECT json_extract(value,'$.deleted') AS deleted FROM task_meta WHERE key='task-presentation:evaluation:eval'").get().deleted, 1);
  const audits = sqlite.prepare('SELECT payload FROM task_cleanup_receipts').all().map(row => JSON.parse(row.payload));
  assert.equal(audits.length, 4);
  sqlite.close();
  assert.deepEqual({ ...orchestration.getTicket('legacy'), archived: false }, before);
  assert.equal(orchestration.getTicket('legacy').archived, true);
  assert.deepEqual(orchestration.listTickets({ archived: true }).map(row => row.id).sort(), ['archived', 'legacy']);
  assert(orchestration.listTickets({ archived: true }).every(row => row.archived));
  database = createAssistantRuntimeStore({ directory });
  const tasks = createTaskManagement({ database, orchestration });
  assert.equal(tasks.project('ticket', [orchestration.getTicket('complete')])[0].taskMeta.completed, true);
  assert.deepEqual(tasks.project('ticket', orchestration.listTickets(), { archived: true }).map(row => row.id).sort(), ['archived', 'legacy']);
  const audit = tasks.cleanupHistory({ ticketId: 'legacy' })[0];
  assert.equal(audit.operation, 'legacy-migration'); assert.equal(audit.items[0].legacyDeleted, true);
  const restore = tasks.previewRestore({ scope, receiptId: audit.receiptId });
  const confirmedBy = tasks.createCleanupConfirmation({ previewId: restore.previewId, manifestHash: restore.manifestHash,
    ids: ['legacy'], actorId: 'desktop-owner', source: { sessionId: 'main', messageId: 'restore-legacy' } });
  tasks.restoreCleanup({ previewId: restore.previewId, ids: ['legacy'], confirmedBy, requestId: 'restore-legacy' });
  assert.equal(Object.hasOwn(database.meta('task-presentation:ticket:legacy'), 'deleted'), false);
  assert.equal(orchestration.getTicket('legacy').archived, false);
  const count = tasks.cleanupHistory({}).length;
  database.close(); database = undefined; orchestration.close();
  orchestration = createAssistantOrchestrationStore({ directory });
  database = createAssistantRuntimeStore({ directory });
  assert.equal(database.taskCleanup.cleanupHistory({}).length, count, 'migration is not replayed');
  assert.equal(orchestration.getTicket('legacy').status, 'cancelled');
});
