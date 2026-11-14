import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { createAssistantRuntimeStore } from '../src/runtime-store.mjs';
import { createTaskManagement } from '../src/task-management.mjs';
import { createDesktopTaskAccess, conciseTaskSummary, TASK_SUMMARY_MAX_CHARS } from '../src/desktop-task-access.mjs';

async function managedFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-task-access-'));
  const orchestration = createAssistantOrchestrationStore({ directory });
  const database = createAssistantRuntimeStore({ directory });
  t.after(async () => { database.close(); orchestration.close(); await rm(directory, { recursive: true, force: true }); });
  orchestration.createThread({ id: 'owner', source: { type: 'desktop', id: 'owner' } });
  const management = createTaskManagement({ database, orchestration });
  const access = createDesktopTaskAccess(orchestration, management);
  const scope = { owner: 'desktop-owner', mode: 'global' };
  const task = id => orchestration.createTask({ id, threadId: 'owner', title: `原始标题 ${id}`, target: `完成 ${id}`,
    mandate: { source: { channel: 'desktop', sessionId: 'owner' } } });
  const confirm = preview => management.createCleanupConfirmation({ previewId: preview.previewId, manifestHash: preview.manifestHash,
    ids: preview.items.map(row => row.id), actorId: 'desktop-owner', source: { sessionId: 'owner', messageId: 'human-cleanup' } });
  return { orchestration, database, management, access, scope, task, confirm };
}

test('managed task reads return renamed presentation and current version without changing execution', async t => {
  const f = await managedFixture(t);
  f.task('rename');
  const original = f.orchestration.getTask('rename');
  assert.equal(f.access.read('rename', 'owner').taskMeta.version, 0);
  f.management.update({ kind: 'task', id: 'rename', operation: 'rename', title: '用户指定的新标题', version: 0 });
  const detail = f.access.read('rename', 'owner');
  const listed = f.access.query('owner').tasks[0];
  for (const row of [detail, listed]) {
    assert.equal(row.title, '用户指定的新标题');
    assert.equal(row.taskMeta.title, '用户指定的新标题');
    assert.equal(row.taskMeta.version, 1);
    assert.equal(row.archived, false);
    assert.equal(row.cleanup, null);
  }
  assert.throws(() => f.management.update({ kind: 'task', id: 'rename', operation: 'rename', title: '过期修改', version: 0 }), { code: 'REVISION_CONFLICT' });
  assert.deepEqual(f.orchestration.getTask('rename'), original);
  assert.deepEqual(validateJsonSchemaValue({ type: 'object', additionalProperties: true }, { detail, listed }), []);
});

test('managed archive filtering precedes paging and exposes restore pointers in list and detail', async t => {
  const f = await managedFixture(t);
  for (const id of ['a', 'b', 'c', 'd']) { f.task(id); f.orchestration.cancelTask(id); }
  const originals = f.orchestration.listTasks();
  const order = f.access.query('owner').tasks.map(row => row.id);
  const selected = [order[0], order[2]], visible = [order[1], order[3]];
  const preview = f.management.previewCleanup({ scope: f.scope, ids: selected });
  const receipt = f.management.commitCleanup({ previewId: preview.previewId, ids: preview.items.map(row => row.id),
    confirmedBy: f.confirm(preview), requestId: 'archive-access' });
  const first = f.access.query('owner', { archived: false, limit: 1 });
  const second = f.access.query('owner', { archived: false, limit: 1, offset: first.nextOffset });
  assert.equal(first.nextOffset, 1);
  assert.equal(second.nextOffset, null);
  assert.deepEqual([...first.tasks, ...second.tasks].map(row => row.id), visible);
  const archivedFirst = f.access.query('owner', { archived: true, limit: 1 });
  const archivedSecond = f.access.query('owner', { archived: true, limit: 1, offset: archivedFirst.nextOffset });
  assert.equal(archivedFirst.nextOffset, 1);
  assert.equal(archivedSecond.nextOffset, null);
  assert.deepEqual([...archivedFirst.tasks, ...archivedSecond.tasks].map(row => row.id), selected);
  for (const row of [...archivedFirst.tasks, ...archivedSecond.tasks, f.access.read(selected[0], 'owner')]) {
    assert.equal(row.archived, true);
    assert.equal(row.taskMeta.version, 1);
    assert.equal(row.cleanup.id, receipt.receiptId);
    assert.equal(row.cleanup.archivedAt, receipt.createdAt);
    assert.equal(row.cleanup.version, 1);
  }
  assert.equal(f.access.query('owner').tasks.length, 4, 'omitting archived preserves the full history query');
  assert.throws(() => f.access.query('owner', { archived: 'false' }), /archived/);
  const restore = f.management.previewRestore({ scope: f.scope, receiptId: archivedFirst.tasks[0].cleanup.id });
  f.management.restoreCleanup({ previewId: restore.previewId, ids: restore.items.map(row => row.id),
    confirmedBy: f.confirm(restore), requestId: 'restore-access' });
  assert.deepEqual(f.access.query('owner', { archived: true }).tasks, []);
  assert.deepEqual(f.access.query('owner', { archived: false }).tasks.map(row => row.id), order);
  const restored = f.access.read(selected[0], 'owner');
  assert.equal(restored.cleanup, null);
  assert.equal(restored.taskMeta.version, 2);
  assert.deepEqual(f.orchestration.listTasks(), originals, 'presentation organization preserves the original tasks and execution state');
});

test('task queries respect session ownership, filter projects before limiting, and remain read only', t => {
  const database = createAssistantOrchestrationStore({ filename: ':memory:' });
  t.after(() => database.close());
  const access = createDesktopTaskAccess(database);
  const tasks = ['a', 'b', 'a'].map((projectId, index) => {
    const threadId = `thread-${index}`;
    database.ingest({ dedupeKey: threadId, thread: { id: threadId, source: { type: 'desktop', id: threadId } }, source: { channel: 'desktop', sessionId: threadId }, actor: { id: 'owner' }, content: 'task', mode: 'direct' });
    return database.createTask({ threadId, target: `task-${index}`, mandate: { project: { id: projectId }, source: { channel: 'desktop', sessionId: index === 1 ? 'other' : 'owner' } } });
  });
  database.pauseTask(tasks[0].id);
  const before = database.listTasks();
  const first = access.query('owner', { projectId: 'a', limit: 1 });
  const second = access.query('owner', { projectId: 'a', limit: 1, offset: first.nextOffset });
  assert.equal(first.nextOffset, 1);
  assert.equal(second.nextOffset, null);
  assert.deepEqual(new Set([...first.tasks, ...second.tasks].map(row => row.id)), new Set([tasks[0].id, tasks[2].id]));
  assert.deepEqual(access.query('owner', { status: 'waiting', projectId: 'a' }).tasks.map(row => row.id), [tasks[0].id]);
  assert.deepEqual(access.query('owner', { status: 'running', projectId: 'a' }).tasks.map(row => row.id), [tasks[2].id]);
  const detail = access.read(tasks[0].id, 'owner');
  assert.throws(() => access.read(tasks[1].id, 'owner'), /当前会话/);
  assert.equal(access.query('owner').tasks.length, 2);
  assert.equal(detail.target, 'task-0');
  for (const key of ['revisions', 'assignments', 'results', 'attentions', 'deliveries']) assert.ok(Array.isArray(detail[key]));
  assert.equal(access.read('missing', 'owner'), null);
  assert.throws(() => access.query('owner', { limit: 101 }), /limit/);
  assert.throws(() => access.query('owner', { offset: -1 }), /offset/);
  assert.deepEqual(database.listTasks(), before);
});

test('routine AI query keeps one bounded paragraph and result pointers; full evidence is explicit', () => {
  const task = { id: 't', status: 'waiting', title: '任务', instructionRevision: 2, resultVersion: 1,
    mandate: { source: { channel: 'desktop', sessionId: 'owner' } },
    continuationWait: { reason: '服务不可用\n\n等待恢复', resumeConditions: '更新凭据后继续' },
    liveSummary: { goal: '要求'.repeat(1000), progress: '执行记录'.repeat(500) } };
  assert(Array.from(conciseTaskSummary(task)).length <= TASK_SUMMARY_MAX_CHARS);
  assert(!conciseTaskSummary(task).includes('\n'));
  assert.match(conciseTaskSummary(task), /更新凭据后继续/);
  assert.match(conciseTaskSummary({ ...task, continuationWait: { code: 'EXECUTION_FAILED', reason: '原因'.repeat(500), resumeConditions: '更新凭据后继续' } }), /继续条件：更新凭据后继续；下一步：/);
  const access = createDesktopTaskAccess({ listTasks: () => [task] });
  const [row] = access.query('owner').tasks;
  assert.equal(typeof row.liveSummary, 'string');
  assert.deepEqual(row.result, { taskId: 't', version: 1 });
  assert.equal('target' in row, false); assert.equal('results' in row, false);
  assert.match(conciseTaskSummary({ ...task, executionControl: { stopped: true } }), /已停止/);
});

test('trusted logical owner scope includes old model sessions and filters side conversations before paging', t => {
  const database = createAssistantOrchestrationStore({ filename: ':memory:' }); t.after(() => database.close());
  database.createThread({ id: 'desktop:old', source: { type: 'desktop', id: 'old' } });
  const old = database.createTask({ threadId: 'desktop:old', target: 'old', mandate: { source: { channel: 'desktop', sessionId: 'old' } } });
  const current = database.createTask({ threadId: 'desktop:old', target: 'current', mandate: { source: { channel: 'desktop', sessionId: 'new', threadId: 'main' } } });
  const foreign = database.createTask({ threadId: 'desktop:old', target: 'side', mandate: { source: { channel: 'desktop', sessionId: 'old', threadId: 'side' } } });
  const access = createDesktopTaskAccess(database), scope = { threadId: 'main', sessionIds: ['old', 'new'] };
  const first = access.query(scope, { limit: 1 }), second = access.query(scope, { limit: 1, offset: first.nextOffset });
  assert.deepEqual(new Set([...first.tasks, ...second.tasks].map(row => row.id)), new Set([old.id, current.id]));
  assert.equal(second.nextOffset, null); assert.equal(access.read(old.id, scope).id, old.id);
  assert.throws(() => access.read(foreign.id, scope), /当前会话/);
  assert.deepEqual(access.query({ threadId: 'main', sessionIds: [] }).tasks, []);
});

test('tasks without projects cross the official lossless JSON tool-output boundary', t => {
  const database = createAssistantOrchestrationStore({ filename: ':memory:' });
  t.after(() => database.close());
  database.createThread({ id: 'desktop:owner', source: { type: 'desktop', id: 'owner' } });
  database.createTask({ threadId: 'desktop:owner', target: '调查公开资料',
    mandate: { source: { channel: 'desktop', sessionId: 'owner' } } });
  const result = createDesktopTaskAccess(database).query('owner');
  assert.deepEqual(validateJsonSchemaValue({ type: 'object', additionalProperties: true }, result), []);
  assert.equal(result.tasks[0].project, null);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});
