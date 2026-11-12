import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAssistantScheduler } from '../src/scheduler.mjs';
import { createAssistantRuntimeStore } from '../src/runtime-store.mjs';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { createTaskManagement } from '../src/task-management.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'assistant-goal-'));
  const database = createAssistantRuntimeStore({ filename: join(directory, 'assistant.db') });
  const store = { paths: { database: join(directory, 'assistant.db') } };
  let scheduler = createAssistantScheduler({ store, database });
  t.after(async () => { await scheduler.dispose(); database.close(); store.orchestration?.close?.(); await rm(directory, { recursive: true, force: true }); });
  return { database, store, get scheduler() { return scheduler; },
    async restart() { await scheduler.dispose(); scheduler = createAssistantScheduler({ store, database }); },
    goal(id, patch = {}) { return database.insertGoal({ id, requestId: id, objective: id, status: 'active', projectId: 'p', provider: 'opaque', model: 'exact', text: 'current instruction', childGoalIds: [], ticketIds: [], ...patch }); } };
}

test('goal usage API reads authoritative totals and exposes no quota controls', async t => {
  const f = await fixture(t);
  const ledger = createAssistantOrchestrationStore({ filename: f.store.paths.database });
  f.store.orchestration = ledger;
  f.goal('goal', { executionKind: 'ticket', budgetGoalId: 'ledger' });
  ledger.ensureGoalBudget({ goalId: 'ledger' });
  ledger.bindTicketGoal({ ticketId: 'ticket', goalId: 'ledger' });
  for (let index = 0; index < 3; index++) ledger.reserveGoalRequest({ ticketId: 'ticket', requestId: `request-${index}` });
  assert.equal(f.scheduler.getGoalBudget('goal').usage.requests, 3);
  assert.equal(f.scheduler.getGoal('goal').budgetState.usage.requests, 3);
  assert.equal(f.scheduler.updateGoalBudget, undefined);
  assert.equal(f.scheduler.resumeGoalBudget, undefined);
  f.goal('history');
  assert.equal(f.scheduler.getGoalBudget('history'), null);
});

test('invalid goal trees do not leave a partially created parent', async t => {
  const f = await fixture(t);
  await assert.rejects(f.scheduler.createGoal({ objective: 'parent', children: [{ objective: 'invalid' }] }), /目标缺少/u);
  assert.deepEqual(f.scheduler.goals(), []);
});

test('checklist goals persist without projects, Tickets or scheduler execution', async t => {
  const f = await fixture(t);
  const goal = f.scheduler.createChecklistGoal({ objective: '  长期整理知识库  ', requestId: 'checklist' });
  assert.equal(goal.executionKind, 'checklist');
  assert.equal(goal.objective, '长期整理知识库');
  assert.deepEqual(goal.ticketIds, []);
  assert.equal(goal.projectId, undefined);
  assert.equal(f.scheduler.createChecklistGoal({ objective: goal.objective, requestId: 'checklist', ownerSessionId: 'new-main' }).id, goal.id);
  assert.throws(() => f.scheduler.createChecklistGoal({ objective: 'different', requestId: 'checklist' }), { code: 'IDEMPOTENCY_CONFLICT' });
  const before = f.scheduler.getGoal(goal.id);
  await f.scheduler.tick();
  assert.deepEqual(f.scheduler.getGoal(goal.id), before);
  await f.restart();
  assert.equal(f.scheduler.goals()[0].objective, goal.objective);
  const completed = f.scheduler.updateGoal(goal.id, { status: 'completed' }, { rowVersion: goal.rowVersion });
  assert.equal(completed.status, 'completed');
  assert.ok(completed.completedAt);
  assert.throws(() => f.scheduler.updateGoal(goal.id, { objective: 'stale' }, { rowVersion: goal.rowVersion }), { code: 'ROW_CONFLICT' });
  assert.throws(() => f.scheduler.updateGoal(goal.id, { status: 'active' }), /rowVersion/);
  const reopened = f.scheduler.updateGoal(goal.id, { status: 'active', objective: '整理产品知识库' }, { rowVersion: completed.rowVersion });
  assert.equal(reopened.completedAt, null);
  assert.equal(reopened.title, reopened.objective);
  f.scheduler.updateGoal(goal.id, { deleted: true }, { rowVersion: reopened.rowVersion });
  assert.deepEqual(f.scheduler.goals(), []);
  assert.equal(f.scheduler.getGoal(goal.id), null);
  assert.equal(f.scheduler.createChecklistGoal({ objective: goal.objective, requestId: 'checklist' }).deleted, true, 'a delayed creation retry never resurrects a deleted item');
  assert.throws(() => f.scheduler.updateGoal(goal.id, { status: 'active' }, { rowVersion: reopened.rowVersion + 1 }), /不存在/);
  await f.restart();
  assert.deepEqual(f.scheduler.goals(), []);
});

test('checklist validation rejects execution fields and never bypasses legacy completion', async t => {
  const f = await fixture(t);
  for (const objective of ['', ' '.repeat(5), 'x'.repeat(2001), 1]) assert.throws(() => f.scheduler.createChecklistGoal({ objective, requestId: 'invalid' }));
  for (const key of ['projectId', 'text', 'children', 'model', 'budget']) assert.throws(() => f.scheduler.createChecklistGoal({ objective: '目标', requestId: 'invalid', [key]: 'unsupported' }));
  assert.deepEqual(f.scheduler.goals(), []);
  const goal = f.scheduler.createChecklistGoal({ objective: '目标', requestId: 'valid' });
  assert.throws(() => f.scheduler.updateGoal(goal.id, { status: 'paused' }, { rowVersion: 1 }));
  assert.throws(() => f.scheduler.updateGoal(goal.id, { projectId: 'p' }, { rowVersion: 1 }));
  await assert.rejects(f.scheduler.cancelGoal(goal.id, { rowVersion: 1 }), /没有执行控制/);
  f.goal('legacy', { executionKind: 'ticket' });
  assert.throws(() => f.scheduler.updateGoal('legacy', { status: 'completed' }, { rowVersion: 1 }), /不能直接标记完成/);
});

test('shared task projection organizes checklist goals through their actual versioned state', async t => {
  const f = await fixture(t);
  const goal = f.scheduler.createChecklistGoal({ objective: '共享清单', requestId: 'task-projection' });
  const tasks = createTaskManagement({ database: f.database, scheduler: f.scheduler });
  const projected = tasks.project('goal', f.scheduler.goals())[0];
  assert.equal(projected.taskCanOrganize, true);
  assert.equal(projected.taskMeta.version, goal.rowVersion);
  const completed = tasks.update({ kind: 'goal', id: goal.id, operation: 'complete', version: goal.rowVersion });
  assert.equal(f.scheduler.getGoal(goal.id).status, 'completed');
  assert.equal(completed.taskMeta.completed, true);
  assert.throws(() => tasks.update({ kind: 'goal', id: goal.id, operation: 'rename', title: '旧页面', version: goal.rowVersion }), { code: 'REVISION_CONFLICT' });
  const reopened = tasks.update({ kind: 'goal', id: goal.id, operation: 'reopen', version: completed.taskMeta.version });
  assert.equal(f.scheduler.getGoal(goal.id).status, 'active');
  tasks.update({ kind: 'goal', id: goal.id, operation: 'delete', version: reopened.taskMeta.version });
  assert.deepEqual(tasks.project('goal', f.scheduler.goals()), []);
});
