import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAssistantScheduler } from '../src/scheduler.mjs';
import { createAssistantRuntimeStore } from '../src/runtime-store.mjs';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';

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

test('budget API reads authoritative totals, requires version and does not reset use or auto resume', async t => {
  const f = await fixture(t);
  const budgets = createAssistantOrchestrationStore({ filename: f.store.paths.database });
  f.store.orchestration = budgets;
  f.goal('goal', { executionKind: 'ticket', budgetGoalId: 'budget', status: 'waiting', waitReason: 'budget' });
  budgets.ensureGoalBudget({ goalId: 'budget', budget: { requests: 1 } });
  budgets.bindTicketGoal({ ticketId: 'ticket', goalId: 'budget' });
  budgets.reserveGoalRequest({ ticketId: 'ticket', requestId: 'request' });
  assert.equal(f.scheduler.getGoalBudget('goal').usage.requests, 1);
  assert.throws(() => f.scheduler.updateGoalBudget('goal', { budget: { requests: 2 } }), /版本/u);
  const updated = f.scheduler.updateGoalBudget('goal', { budget: { requests: 2 }, expectedVersion: 1 });
  assert.equal(updated.usage.requests, 1);
  assert.equal(updated.version, 2);
  assert.equal(f.scheduler.getGoal('goal').status, 'waiting');
  assert.throws(() => f.scheduler.updateGoalBudget('goal', { budget: { requests: 9 }, expectedVersion: 1 }), /version conflict/);
  f.goal('history');
  assert.equal(f.scheduler.getGoalBudget('history'), null);
  assert.throws(() => f.scheduler.updateGoalBudget('history', { budget: {}, expectedVersion: 1 }), /不能调整/u);
});

test('budget resume preflights all shared limits and returns review-only retries without resuming human pauses', async t => {
  const f = await fixture(t);
  const budgets = createAssistantOrchestrationStore({ filename: f.store.paths.database });
  const tickets = new Map([
    ['worker', { id: 'worker', status: 'paused', pauseReason: { kind: 'budget' } }],
    ['review', { id: 'review', status: 'waiting', instructionRevision: 1, resultVersion: 1 }],
    ['human', { id: 'human', status: 'paused', pauseReason: { kind: 'user' } }],
  ]);
  const resumed = [];
  f.store.orchestration = { ...budgets, getTicket: id => tickets.get(id), assignments: () => [],
    results: id => id === 'review' ? [{ ticketId: id, version: 1, instructionRevision: 1, review: { budgetWait: {} } }] : [],
    resumeTicket(id) { resumed.push(id); tickets.get(id).status = 'open'; } };
  budgets.ensureGoalBudget({ goalId: 'parent-budget', budget: { requests: 0 } });
  for (const id of tickets.keys()) {
    budgets.ensureGoalBudget({ goalId: id, parentGoalId: 'parent-budget' });
    budgets.bindTicketGoal({ ticketId: id, goalId: id });
  }
  const goal = f.goal('goal', { executionKind: 'ticket', status: 'waiting', waitReason: 'budget', ticketIds: [...tickets.keys()] });
  await assert.rejects(f.scheduler.resumeGoalBudget('goal', { rowVersion: 999 }), { code: 'ROW_CONFLICT' });
  await assert.rejects(f.scheduler.resumeGoalBudget('goal'), { code: 'GOAL_BUDGET_EXHAUSTED' });
  assert.deepEqual(resumed, []);
  budgets.updateGoalBudget({ goalId: 'parent-budget', budget: { requests: 4 }, expectedVersion: 1 });
  const result = await f.scheduler.resumeGoalBudget('goal', { rowVersion: goal.rowVersion });
  assert.deepEqual(resumed, ['worker']);
  assert.deepEqual(result.reviewTicketIds, ['review']);
  assert.equal(tickets.get('human').status, 'paused');
});

test('invalid goal trees do not leave a partially created parent', async t => {
  const f = await fixture(t);
  await assert.rejects(f.scheduler.createGoal({ objective: 'parent', children: [{ objective: 'invalid' }] }), /目标缺少/u);
  assert.deepEqual(f.scheduler.goals(), []);
});
