import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantRuntimeStore } from '../src/runtime-store.mjs';
import { createTaskManagement } from '../src/task-management.mjs';

test('task organization persists without rewriting execution state and detects stale writes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-task-management-'));
  let database = createAssistantRuntimeStore({ directory });
  t.after(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
  const rows = { ticket: { id: 't', status: 'failed', target: 'original instruction' }, goal: { id: 'g', status: 'cancelled' }, evaluation: { id: 'e', status: 'unavailable' } };
  const create = () => createTaskManagement({ database, orchestration: { getTicket: id => id === 't' && rows.ticket, getEvaluation: id => id === 'e' && rows.evaluation }, scheduler: { getGoal: id => id === 'g' && rows.goal } });
  let tasks = create();
  tasks.update({ kind: 'ticket', id: 't', operation: 'rename', title: 'My title', version: 0 });
  assert.throws(() => tasks.update({ kind: 'ticket', id: 't', operation: 'complete', version: 0 }), { code: 'REVISION_CONFLICT' });
  tasks.update({ kind: 'ticket', id: 't', operation: 'complete', version: 1 });
  assert.equal(rows.ticket.status, 'failed');
  assert.equal(rows.ticket.target, 'original instruction');
  database.close(); database = createAssistantRuntimeStore({ directory }); tasks = create();
  assert.equal(tasks.project('ticket', [rows.ticket])[0].taskMeta.title, 'My title');
  assert.equal(tasks.project('ticket', [rows.ticket])[0].taskMeta.completed, true);
  tasks.update({ kind: 'ticket', id: 't', operation: 'reopen', version: 2 });
  assert.equal(rows.ticket.status, 'failed');
  tasks.update({ kind: 'ticket', id: 't', operation: 'delete', version: 3 });
  assert.deepEqual(tasks.project('ticket', [rows.ticket]), []);
  for (const kind of ['goal', 'evaluation']) {
    tasks.update({ kind, id: rows[kind].id, operation: 'complete', version: 0 });
    assert.equal(tasks.project(kind, [rows[kind]])[0].taskMeta.completed, true);
  }
  assert.equal(rows.evaluation.status, 'unavailable');
});

test('active work cannot be hidden or marked completed; metadata writes validate identity and input', () => {
  const metadata = new Map();
  const row = { id: 'active', status: 'open' };
  const database = { transaction: fn => fn(), meta: key => metadata.get(key), setMeta: (key, value) => metadata.set(key, value) };
  const tasks = createTaskManagement({ database, orchestration: { getTicket: id => id === row.id && row, getEvaluation: () => ({ status: 'queued' }) }, scheduler: { getGoal: () => ({ status: 'paused' }) } });
  for (const kind of ['ticket', 'goal', 'evaluation']) for (const operation of ['complete', 'delete']) {
    assert.throws(() => tasks.update({ kind, id: 'active', operation, version: 0 }), { code: 'EXECUTION_PENDING' });
  }
  assert.equal(tasks.project('ticket', [row])[0].taskCanOrganize, false);
  assert.equal(tasks.project('goal', [{ id: 'g', status: 'cancelled' }])[0].taskCanOrganize, true);
  assert.equal(tasks.project('evaluation', [{ id: 'e', status: 'unavailable' }])[0].taskCanOrganize, true);
  assert.throws(() => tasks.update({ kind: 'ticket', id: 'missing', operation: 'rename', title: 'x', version: 0 }), /不存在/);
  assert.throws(() => tasks.update({ kind: 'ticket', id: 'active', operation: 'rename', title: ' ', version: 0 }), /名称/);
  assert.equal(metadata.size, 0);
});

test('a reopened execution does not inherit a prior completion or deletion marker', () => {
  const saved = new Map();
  const row = { id: 't', status: 'failed', instructionRevision: 1 };
  const database = { transaction: fn => fn(), meta: key => saved.get(key), setMeta: (key, value) => saved.set(key, value) };
  const tasks = createTaskManagement({ database, orchestration: { getTicket: () => row } });
  tasks.update({ kind: 'ticket', id: 't', operation: 'complete', version: 0 });
  row.status = 'open'; row.instructionRevision = 2;
  assert.equal(tasks.project('ticket', [row])[0].taskMeta.completed, false);
  row.status = 'failed';
  assert.equal(tasks.project('ticket', [row])[0].taskMeta.completed, false);
  tasks.update({ kind: 'ticket', id: 't', operation: 'delete', version: 1 });
  assert.equal(tasks.project('ticket', [row]).length, 0);
  row.status = 'open'; row.instructionRevision = 3;
  assert.equal(tasks.project('ticket', [row]).length, 1);
  tasks.update({ kind: 'ticket', id: 't', operation: 'rename', title: 'New execution', version: 2 });
  assert.equal(tasks.project('ticket', [row])[0].taskMeta.title, 'New execut');
});

test('ticket names are capped in storage and legacy projections without truncating requirements', () => {
  const stored = new Map([['task-presentation:ticket:t', { version: 2, title: '历史自定义工单标题超过十个字' }]]);
  const ticket = { id: 't', status: 'open', target: '完整任务要求不能因为标题变短而被修改或截断', acceptance: '验收标准也必须完整保留' };
  const before = structuredClone(ticket);
  const database = { transaction: fn => fn(), meta: key => stored.get(key), setMeta: (key, value) => stored.set(key, value) };
  const tasks = createTaskManagement({ database, orchestration: { getTicket: () => ticket }, scheduler: { getGoal: () => ({ id: 'g', status: 'active' }) } });
  const projected = tasks.project('ticket', [ticket])[0];
  assert.equal(projected.taskMeta.title, '历史自定义工单标题超');
  assert.equal(stored.get('task-presentation:ticket:t').title, '历史自定义工单标题超过十个字');
  const updated = tasks.update({ kind: 'ticket', id: 't', operation: 'rename', title: '😀一二三四五六七八九十', version: 2 });
  assert.equal(updated.taskMeta.title, '😀一二三四五六七八九');
  assert.equal(stored.get('task-presentation:ticket:t').title, updated.taskMeta.title);
  assert.deepEqual(ticket, before);
  const goalTitle = '持续目标标题不沿用工单十字限制';
  assert.equal(tasks.update({ kind: 'goal', id: 'g', operation: 'rename', title: goalTitle, version: 0 }).taskMeta.title, goalTitle);
});
