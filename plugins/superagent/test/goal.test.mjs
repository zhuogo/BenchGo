import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createGoalChecklist } from '../src/goal-checklist.mjs';
import { createAssistantRuntimeStore } from '../src/runtime-store.mjs';
import { createTaskManagement } from '../src/task-management.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'assistant-goal-'));
  let database = createAssistantRuntimeStore({ filename: join(directory, 'assistant.db') });
  let goals = createGoalChecklist({ database });
  t.after(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
  return { get database() { return database; }, get goals() { return goals; },
    restart() { database.close(); database = createAssistantRuntimeStore({ filename: join(directory, 'assistant.db') }); goals = createGoalChecklist({ database }); } };
}

test('checklist goals persist as one sentence and a done flag without projects or Tickets', async t => {
  const f = await fixture(t);
  const goal = f.goals.createGoal({ objective: '  长期整理知识库  ', requestId: 'checklist' });
  assert.equal(goal.objective, '长期整理知识库');
  assert.equal(goal.title, goal.objective);
  assert.equal(goal.status, 'active');
  for (const key of ['executionKind', 'ticketIds', 'childGoalIds', 'projectId', 'budgetGoalId']) assert.equal(goal[key], undefined);
  assert.equal(f.goals.createGoal({ objective: goal.objective, requestId: 'checklist', ownerSessionId: 'new-main' }).id, goal.id);
  assert.throws(() => f.goals.createGoal({ objective: 'different', requestId: 'checklist' }), { code: 'IDEMPOTENCY_CONFLICT' });
  f.restart();
  assert.equal(f.goals.goals()[0].objective, goal.objective);
  const completed = f.goals.updateGoal(goal.id, { status: 'completed' }, { rowVersion: goal.rowVersion });
  assert.equal(completed.status, 'completed');
  assert.ok(completed.completedAt);
  assert.throws(() => f.goals.updateGoal(goal.id, { objective: 'stale' }, { rowVersion: goal.rowVersion }), { code: 'ROW_CONFLICT' });
  assert.throws(() => f.goals.updateGoal(goal.id, { status: 'active' }), /rowVersion/);
  const reopened = f.goals.updateGoal(goal.id, { status: 'active', objective: '整理产品知识库' }, { rowVersion: completed.rowVersion });
  assert.equal(reopened.completedAt, null);
  assert.equal(reopened.title, reopened.objective);
  f.goals.updateGoal(goal.id, { deleted: true }, { rowVersion: reopened.rowVersion });
  assert.deepEqual(f.goals.goals(), []);
  assert.equal(f.goals.getGoal(goal.id), null);
  assert.equal(f.goals.createGoal({ objective: goal.objective, requestId: 'checklist' }).deleted, true, 'a delayed creation retry never resurrects a deleted item');
  assert.throws(() => f.goals.updateGoal(goal.id, { status: 'active' }, { rowVersion: reopened.rowVersion + 1 }), /不存在/);
  f.restart();
  assert.deepEqual(f.goals.goals(), []);
});

test('checklist validation rejects execution fields, model overrides and unknown states', async t => {
  const f = await fixture(t);
  for (const objective of ['', ' '.repeat(5), 'x'.repeat(2001), 1]) assert.throws(() => f.goals.createGoal({ objective, requestId: 'invalid' }));
  for (const key of ['projectId', 'text', 'children', 'model', 'budget']) assert.throws(() => f.goals.createGoal({ objective: '目标', requestId: 'invalid', [key]: 'unsupported' }));
  for (const requestId of [undefined, '', ' ', 'x'.repeat(2049)]) assert.throws(() => f.goals.createGoal({ objective: '目标', requestId }), /请求标识/);
  assert.deepEqual(f.goals.goals(), []);
  const goal = f.goals.createGoal({ objective: '目标', requestId: 'valid' });
  for (const patch of [{ status: 'paused' }, { status: 'cancelled' }, { projectId: 'p' }, { deleted: false }, {}]) assert.throws(() => f.goals.updateGoal(goal.id, patch, { rowVersion: 1 }));
  for (const name of ['cancelGoal', 'advanceGoal', 'tick', 'getGoalBudget', 'createChecklistGoal']) assert.equal(f.goals[name], undefined);
  assert.deepEqual(f.goals.getGoal(goal.id), goal);
});

test('shared task projection organizes checklist goals through their actual versioned state', async t => {
  const f = await fixture(t);
  const goal = f.goals.createGoal({ objective: '共享清单', requestId: 'task-projection' });
  const tasks = createTaskManagement({ database: f.database, goals: f.goals });
  const projected = tasks.project('goal', f.goals.goals())[0];
  assert.equal(projected.taskCanOrganize, true);
  assert.equal(projected.taskMeta.version, goal.rowVersion);
  const completed = tasks.update({ kind: 'goal', id: goal.id, operation: 'complete', version: goal.rowVersion });
  assert.equal(f.goals.getGoal(goal.id).status, 'completed');
  assert.equal(completed.taskMeta.completed, true);
  assert.throws(() => tasks.update({ kind: 'goal', id: goal.id, operation: 'rename', title: '旧页面', version: goal.rowVersion }), { code: 'REVISION_CONFLICT' });
  const reopened = tasks.update({ kind: 'goal', id: goal.id, operation: 'reopen', version: completed.taskMeta.version });
  assert.equal(f.goals.getGoal(goal.id).status, 'active');
  tasks.update({ kind: 'goal', id: goal.id, operation: 'delete', version: reopened.taskMeta.version });
  assert.deepEqual(tasks.project('goal', f.goals.goals()), []);
});
