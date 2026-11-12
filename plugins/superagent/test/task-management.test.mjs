import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantRuntimeStore } from '../src/runtime-store.mjs';
import { createTaskManagement } from '../src/task-management.mjs';

test('task lists show recent activity first with creation fallback and stable ties', () => {
  const tasks = createTaskManagement({ database: { meta: () => undefined } });
  const rows = [
    { id: 'old', updatedAt: '2026-11-01T00:00:00Z', createdAt: '2026-11-08T00:00:00Z' },
    { id: 'recent', updatedAt: '2026-11-09T00:00:00Z', createdAt: '2026-10-01T00:00:00Z' },
    { id: 'created', createdAt: '2026-11-08T00:00:00Z' },
    { id: 'invalid-update', updatedAt: 'invalid', createdAt: '2026-11-08T00:00:00Z' },
    { id: 'numeric', updatedAt: Date.parse('2026-11-07T00:00:00Z') },
    { id: 'epoch', updatedAt: 0, createdAt: '2026-11-09T00:00:00Z' },
    { id: 'unknown', updatedAt: 'invalid' },
    { id: 'also-unknown' },
  ];
  const before = structuredClone(rows);
  for (const kind of ['ticket', 'goal', 'evaluation']) {
    const projected = tasks.project(kind, rows);
    assert.deepEqual(projected.map(row => row.id), ['recent', 'created', 'invalid-update', 'numeric', 'old', 'epoch', 'unknown', 'also-unknown']);
    assert.deepEqual(tasks.project(kind, rows).map(row => row.id), projected.map(row => row.id));
  }
  assert.deepEqual(rows, before);
  rows[0].updatedAt = '2026-11-10T00:00:00Z';
  assert.equal(tasks.project('ticket', rows)[0].id, 'old', 'an older ticket moves to the top after new activity');
});

test('task organization persists without rewriting execution state and detects stale writes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-task-management-'));
  let database = createAssistantRuntimeStore({ directory });
  t.after(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
  const rows = { ticket: { id: 't', status: 'waiting', executionControl: { stopped: true }, target: 'original instruction' }, evaluation: { id: 'e', status: 'unavailable' } };
  const create = () => createTaskManagement({ database, orchestration: { getTicket: id => id === 't' && rows.ticket, getEvaluation: id => id === 'e' && rows.evaluation } });
  let tasks = create();
  tasks.update({ kind: 'ticket', id: 't', operation: 'rename', title: 'My title', version: 0 });
  assert.throws(() => tasks.update({ kind: 'ticket', id: 't', operation: 'rename', title: 'stale', version: 0 }), { code: 'REVISION_CONFLICT' });
  for (const operation of ['complete', 'reopen']) assert.throws(() => tasks.update({ kind: 'ticket', id: 't', operation, version: 1 }), { code: 'TICKET_COMPLETION_MANAGED' });
  assert.equal(rows.ticket.status, 'waiting');
  assert.equal(rows.ticket.target, 'original instruction');
  database.close(); database = createAssistantRuntimeStore({ directory }); tasks = create();
  assert.equal(tasks.project('ticket', [rows.ticket])[0].taskMeta.title, 'My title');
  assert.notEqual(tasks.project('ticket', [rows.ticket])[0].taskMeta.completed, true);
  assert.equal(rows.ticket.status, 'waiting');
  assert.throws(() => tasks.update({ kind: 'ticket', id: 't', operation: 'delete', version: 1 }), { code: 'CLEANUP_PREVIEW_REQUIRED' });
  assert.equal(tasks.project('ticket', [rows.ticket], { archived: true }).length, 0);
  assert.equal(tasks.project('ticket', [rows.ticket], { archived: false }).length, 1);
  tasks.update({ kind: 'evaluation', id: 'e', operation: 'complete', version: 0 });
  assert.equal(tasks.project('evaluation', [rows.evaluation])[0].taskMeta.completed, true);
  assert.equal(rows.evaluation.status, 'unavailable');
});

test('active work cannot be hidden or marked completed; metadata writes validate identity and input', () => {
  const metadata = new Map();
  const row = { id: 'active', status: 'running' };
  const database = { transaction: fn => fn(), meta: key => metadata.get(key), setMeta: (key, value) => metadata.set(key, value) };
  const tasks = createTaskManagement({ database, orchestration: { getTicket: id => id === row.id && row, getEvaluation: () => ({ status: 'queued' }) } });
  for (const kind of ['ticket', 'evaluation']) for (const operation of kind === 'ticket' ? ['complete'] : ['complete', 'delete']) {
    assert.throws(() => tasks.update({ kind, id: 'active', operation, version: 0 }), { code: kind === 'ticket' ? 'TICKET_COMPLETION_MANAGED' : 'EXECUTION_PENDING' });
  }
  assert.equal(tasks.project('ticket', [row])[0].taskCanOrganize, false);
  assert.equal(tasks.project('goal', [{ id: 'g', status: 'active', objective: '长期目标', rowVersion: 1 }])[0].taskCanOrganize, true, 'checklist goals have no execution to wait for');
  assert.equal(tasks.project('evaluation', [{ id: 'e', status: 'unavailable' }])[0].taskCanOrganize, true);
  assert.throws(() => tasks.update({ kind: 'ticket', id: 'missing', operation: 'rename', title: 'x', version: 0 }), /不存在/);
  assert.throws(() => tasks.update({ kind: 'ticket', id: 'active', operation: 'rename', title: ' ', version: 0 }), /名称/);
  assert.equal(metadata.size, 0);
});

test('a new execution does not inherit manual archive or legacy completion markers', () => {
  const saved = new Map();
  const row = { id: 't', status: 'waiting', executionControl: { stopped: true }, instructionRevision: 1 };
  const database = { transaction: fn => fn(), meta: key => saved.get(key), setMeta: (key, value) => saved.set(key, value) };
  const tasks = createTaskManagement({ database, orchestration: { getTicket: () => row } });
  database.setMeta('task-presentation:ticket:t', { version: 2, completed: true, executionRevision: 1, archived: true, archiveRevision: 1 });
  assert.equal(tasks.project('ticket', [row], { archived: true }).length, 1);
  row.status = 'running'; row.executionControl = {}; row.instructionRevision = 2;
  assert.equal(tasks.project('ticket', [row], { archived: false }).length, 1);
  assert.equal(tasks.project('ticket', [row])[0].taskMeta.completed, false);
  row.status = 'waiting'; row.executionControl = { stopped: true };
  assert.equal(tasks.project('ticket', [row], { archived: false }).length, 1, 'old archive revision cannot hide a new execution');
  tasks.update({ kind: 'ticket', id: 't', operation: 'rename', title: 'New execution', version: 2 });
  assert.equal(tasks.project('ticket', [row])[0].taskMeta.title, 'New execut');
});

test('ticket names are capped in storage and legacy projections without truncating requirements', () => {
  const stored = new Map([['task-presentation:ticket:t', { version: 2, title: '历史自定义工单标题超过十个字' }]]);
  const ticket = { id: 't', status: 'running', target: '完整任务要求不能因为标题变短而被修改或截断', acceptance: '验收标准也必须完整保留' };
  const before = structuredClone(ticket);
  const database = { transaction: fn => fn(), meta: key => stored.get(key), setMeta: (key, value) => stored.set(key, value) };
  const goal = { id: 'g', status: 'active', objective: '旧目标', rowVersion: 1 };
  const goals = { getGoal: () => goal, updateGoal: (_id, patch, { rowVersion }) => Object.assign(goal, patch, { rowVersion: rowVersion + 1 }) };
  const tasks = createTaskManagement({ database, orchestration: { getTicket: () => ticket }, goals });
  const projected = tasks.project('ticket', [ticket])[0];
  assert.equal(projected.taskMeta.title, '历史自定义工单标题超');
  assert.equal(stored.get('task-presentation:ticket:t').title, '历史自定义工单标题超过十个字');
  const updated = tasks.update({ kind: 'ticket', id: 't', operation: 'rename', title: '😀一二三四五六七八九十', version: 2 });
  assert.equal(updated.taskMeta.title, '😀一二三四五六七八九');
  assert.equal(stored.get('task-presentation:ticket:t').title, updated.taskMeta.title);
  assert.deepEqual(ticket, before);
  const goalTitle = '持续目标标题不沿用工单十字限制';
  assert.equal(tasks.update({ kind: 'goal', id: 'g', operation: 'rename', title: goalTitle, version: 1 }).taskMeta.title, goalTitle);
  assert.equal(goal.objective, goalTitle);
});
