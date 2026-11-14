import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
import { createAssistantStore } from '../src/store.mjs';
import { createAssistantRuntimeStore } from '../src/runtime-store.mjs';
import { createTaskManagement } from '../src/task-management.mjs';
import { createDesktopTaskAccess } from '../src/desktop-task-access.mjs';
import { createRouterTools } from '../src/router-tools.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-router-task-management-'));
  const store = await createAssistantStore({ dataDirectory: directory });
  const database = createAssistantRuntimeStore({ filename: store.paths.database });
  t.after(async () => { database.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const events = [{ type: 'turn/start' }, { type: 'user/message', data: { id: 'owner-input', source: { kind: 'user' },
    content: [{ type: 'text', text: '把文档工单改名为发布文档，再从列表删掉；也要能恢复。' }] } }];
  const agent = { id: 'router-owner', status: 'running', session: { header: {}, snapshotEvents: () => structuredClone(events) } };
  await store.updateState({ mainSessionId: agent.id });
  const approvals = [], tools = new Map();
  const approval = { overrideOf: () => 'never', request: async input => { approvals.push(input); return 'rejected'; } };
  const ctx = { get: name => name === 'approval' ? approval : undefined,
    agents: { get: id => id === agent.id ? agent : undefined, currentInitiator: () => agent, turnBoundaryOf: () => ({ openTurnStartSeq: 0 }) } };
  const taskManagement = createTaskManagement({ database, orchestration: store.orchestration });
  const desktopTasks = createDesktopTaskAccess(store.orchestration, taskManagement);
  createRouterTools({ ctx, store, taskManagement, desktopTasks, shutdown: new AbortController() })(
    { tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } }, systemPrompt: { section() {}, context() {} } },
    { threadId: 'main', agent });
  const exec = { agent, callId: 'router-call', signal: new AbortController().signal };
  const run = async (name, args) => {
    const tool = tools.get(name);
    assert.ok(tool, `Router must register ${name}`);
    assert.deepEqual(validateJsonSchemaValue(tool.parameters, args), []);
    const value = await tool.execute(args, exec);
    assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value), []);
    assert.deepEqual(JSON.parse(JSON.stringify(value)), value, 'official output must be lossless JSON');
    return value;
  };
  store.orchestration.createThread({ id: 'external', source: { type: 'feishu', id: 'source' } });
  store.orchestration.createTask({ id: 'finished', threadId: 'external', title: '整理文档', target: '完成发布文档',
    mandate: { source: { channel: 'feishu', sessionId: 'other-source' } } });
  store.orchestration.updateTask('finished', { status: 'completed' });
  store.orchestration.createTask({ id: 'running', threadId: 'external', target: '仍在处理的工作',
    mandate: { source: { channel: 'feishu', sessionId: 'other-source' } } });
  return { store, events, run, approvals };
}

test('registered Router tools rename, archive, read receipts and restore cross-source tasks under never', async t => {
  const f = await fixture(t);
  const before = f.store.orchestration.listTasks();
  const [row] = (await f.run('assistant_tasks', { op: 'list', status: 'completed', archived: false })).tasks;
  assert.equal(row.taskMeta.version, 0);
  assert.equal(row.taskMeta.title, row.title);
  const renamed = await f.run('assistant_task_manage', { op: 'rename', id: row.id, title: '发布文档', version: row.taskMeta.version });
  assert.equal(renamed.taskMeta.version, 1);
  const detail = (await f.run('assistant_tasks', { op: 'get', id: row.id })).task;
  assert.equal(detail.title, '发布文档'); assert.equal(detail.target, '完成发布文档');
  const preview = await f.run('assistant_task_cleanup', { op: 'preview', ids: [row.id, 'running'] });
  assert.deepEqual(preview.items.map(item => item.id), [row.id]);
  assert.equal(preview.excluded[0].code, 'EXECUTION_PENDING');
  const input = { op: 'commit', previewId: preview.previewId, ids: [row.id] };
  const receipt = await f.run('assistant_task_cleanup', input);
  assert.equal(receipt.operation, 'archive'); assert.equal(receipt.confirmedBy.source.messageId, 'owner-input');
  assert.deepEqual(await f.run('assistant_task_cleanup', input), receipt, 'replay returns the same durable receipt');
  assert.deepEqual((await f.run('assistant_tasks', { op: 'list', archived: false })).tasks.map(task => task.id), ['running']);
  const [archived] = (await f.run('assistant_tasks', { op: 'list', archived: true })).tasks;
  assert.equal(archived.cleanup.id, receipt.receiptId);
  assert.deepEqual(await f.run('assistant_task_cleanup', { op: 'history', receiptId: receipt.receiptId }), { history: [receipt] });
  const restore = await f.run('assistant_task_cleanup', { op: 'restore', receiptId: archived.cleanup.id });
  const restored = await f.run('assistant_task_cleanup', { op: 'restore', previewId: restore.previewId, ids: [row.id] });
  assert.equal(restored.operation, 'restore');
  assert.equal((await f.run('assistant_tasks', { op: 'list', archived: true })).tasks.length, 0);
  assert.deepEqual(f.store.orchestration.listTasks(), before, 'presentation changes preserve execution, original mandate and results');
  assert.deepEqual(f.approvals, []);
});

test('registered tools reject stale rename versions and stale instruction manifests without side effects', async t => {
  const f = await fixture(t);
  await assert.rejects(f.run('assistant_task_manage', { op: 'rename', id: 'finished', title: '发布文档', version: 4 }), { code: 'REVISION_CONFLICT' });
  const preview = await f.run('assistant_task_cleanup', { op: 'preview', ids: ['finished'] });
  f.events[1].data.id = 'new-human-input';
  f.events[1].data.content[0].text = '不要整理了';
  await assert.rejects(f.run('assistant_task_cleanup', { op: 'commit', previewId: preview.previewId, ids: ['finished'] }), { code: 'MANAGEMENT_STALE_INSTRUCTION' });
  assert.equal(f.store.orchestration.getTask('finished').archived, false);
  assert.deepEqual((await f.run('assistant_task_cleanup', { op: 'history', taskId: 'finished' })).history, []);
});
