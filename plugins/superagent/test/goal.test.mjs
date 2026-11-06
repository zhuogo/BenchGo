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
