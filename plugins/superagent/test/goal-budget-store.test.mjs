import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installGoalBudgetStore, validateGoalBudget } from '../src/goal-budget-store.mjs';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { recordGoalBudgetEvents } from '../src/goal-budget-usage.mjs';

function open(filename = ':memory:') {
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA foreign_keys=ON');
  const tx = fn => { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } };
  return { db, ...installGoalBudgetStore({ db, tx }) };
}
function family(api, budget) {
  api.ensureGoalBudget({ goalId: 'parent', budget });
  for (const id of ['a', 'b']) {
    api.ensureGoalBudget({ goalId: id, parentGoalId: 'parent' });
    api.bindTicketGoal({ ticketId: `ticket-${id}`, goalId: id });
  }
}
test('siblings reserve shared parent requests atomically and replay never double charges', t => {
  const api = open(); t.after(() => api.db.close()); family(api, { requests: 1 });
  assert.equal(api.reserveGoalRequest({ ticketId: 'ticket-a', requestId: 'one' }).allowed, true);
  assert.equal(api.reserveGoalRequest({ ticketId: 'ticket-a', requestId: 'one' }).duplicate, true);
  const denied = api.reserveGoalRequest({ ticketId: 'ticket-b', requestId: 'two' });
  assert.equal(denied.reason, 'requests'); assert.equal(denied.goalId, 'parent');
  assert.equal(api.goalBudget('b').usage.requests, 0);
  assert.throws(() => api.reserveGoalRequest({ ticketId: 'ticket-b', requestId: 'one' }), /identity conflict/);
  api.updateGoalBudget({ goalId: 'parent', expectedVersion: 1, budget: { requests: 2 } });
  assert.equal(api.reserveGoalRequest({ ticketId: 'ticket-b', requestId: 'two' }).allowed, true);
  assert.equal(api.goalBudget('parent').usage.requests, 2);
});
test('usage deduplication, missing usage, binding and reservation survive reopening', () => {
  const directory = mkdtempSync(join(tmpdir(), 'goal-budget-')); let api;
  try {
    const path = join(directory, 'store.db'); api = open(path); family(api, { tokens: 20, cost: 2 });
    api.recordGoalUsage({ ticketId: 'ticket-a', sessionId: 'worker', seq: 1, tokens: 15, cost: 1 });
    api.recordGoalUsage({ ticketId: 'ticket-a', sessionId: 'worker', seq: 2 });
    api.recordGoalUsage({ ticketId: 'ticket-a', sessionId: 'worker', seq: 3, tokens: 100, cost: 10, inherited: true });
    api.db.close(); api = open(path);
    assert.equal(api.recordGoalUsage({ ticketId: 'ticket-a', sessionId: 'worker', seq: 1, tokens: 15, cost: 1 }).duplicate, true);
    assert.deepEqual(api.goalBudget('parent').usage, { requests: 0, tokens: 15, cost: 1, unknownTokens: 1, unknownCost: 1 });
    api.recordGoalUsage({ ticketId: 'ticket-b', sessionId: 'other-worker', seq: 1, tokens: 7, cost: 0.5 });
    assert.equal(api.checkGoalBudget({ ticketId: 'ticket-a' }).reason, 'tokens');
    assert.throws(() => api.recordGoalUsage({ ticketId: 'ticket-a', sessionId: 'worker', seq: 1, tokens: 99 }), /identity conflict/);
    assert.throws(() => api.bindTicketGoal({ ticketId: 'ticket-a', goalId: 'b' }), /binding conflict/);
  } finally { api?.db.close(); rmSync(directory, { recursive: true, force: true }); }
});
test('deadline and zero limits deny at boundary and revision updates cannot lose usage', t => {
  const api = open(); t.after(() => api.db.close()); family(api, { deadline: 100 });
  assert.equal(api.reserveGoalRequest({ ticketId: 'ticket-a', requestId: 'one', now: 99 }).allowed, true);
  assert.equal(api.reserveGoalRequest({ ticketId: 'ticket-b', requestId: 'two', now: 100 }).reason, 'deadline');
  api.updateGoalBudget({ goalId: 'parent', budget: { cost: 0 }, expectedVersion: 1 });
  assert.equal(api.checkGoalBudget({ ticketId: 'ticket-b' }).reason, 'cost');
  assert.throws(() => api.updateGoalBudget({ goalId: 'parent', budget: {}, expectedVersion: 1 }), /version conflict/);
  assert.equal(api.goalBudget('parent').usage.requests, 1);
});

test('one-shot usage settles the reserved request once across reopen and charges its ancestry', () => {
  const directory = mkdtempSync(join(tmpdir(), 'goal-request-usage-')); let api;
  try {
    const path = join(directory, 'store.db'); api = open(path); family(api, { requests: 3, tokens: 20 });
    api.reserveGoalRequest({ ticketId: 'ticket-a', requestId: 'review' });
    const usage = { ticketId: 'ticket-a', requestId: 'review', tokens: 12, cost: 0.25 };
    assert.deepEqual(api.recordGoalRequestUsage(usage), { duplicate: false });
    api.db.close(); api = open(path);
    assert.deepEqual(api.recordGoalRequestUsage(usage), { duplicate: true });
    api.reserveGoalRequest({ ticketId: 'ticket-b', requestId: 'failed-compaction' });
    api.recordGoalRequestUsage({ ticketId: 'ticket-b', requestId: 'failed-compaction' });
    assert.deepEqual(api.goalBudget('parent').usage, { requests: 2, tokens: 12, cost: 0.25, unknownTokens: 1, unknownCost: 1 });
    assert.equal(api.goalBudget('a').usage.tokens, 12);
    assert.equal(api.goalBudget('a').usage.unknownTokens, 0);
    assert.equal(api.goalBudget('b').usage.tokens, 0);
    assert.equal(api.goalBudget('b').usage.unknownTokens, 1);
    assert.throws(() => api.recordGoalRequestUsage({ ...usage, tokens: 13 }), /identity conflict/);
    assert.throws(() => api.recordGoalRequestUsage({ ...usage, ticketId: 'ticket-b' }), /identity conflict/);
    assert.throws(() => api.recordGoalRequestUsage({ ...usage, ticketId: 'unbound' }), /identity conflict/);
    assert.throws(() => api.recordGoalRequestUsage({ ...usage, requestId: 'never-reserved' }), /reservation missing/);
    assert.deepEqual(api.recordGoalRequestUsage({ ticketId: 'ordinary', requestId: 'unbound' }), { ignored: true });
    for (const invalid of [{ tokens: -1 }, { tokens: 1.5 }, { cost: Infinity }, { cost: -1 }]) {
      assert.throws(() => api.recordGoalRequestUsage({ ...usage, ...invalid }), /Invalid goal usage/);
    }
    assert.equal(api.goalBudget('parent').usage.tokens, 12);
  } finally { api?.db.close(); rmSync(directory, { recursive: true, force: true }); }
});
test('strict budgets and immutable parent chains reject unsafe input', t => {
  const api = open(); t.after(() => api.db.close());
  for (const budget of [null, [], { maxTokens: 1 }, { tokens: -1 }, { requests: 1.5 }, { cost: Infinity }, { deadline: 'tomorrow' }]) assert.throws(() => validateGoalBudget(budget));
  assert.throws(() => api.ensureGoalBudget({ goalId: 'a', parentGoalId: 'a' }), /parent/);
  assert.throws(() => api.ensureGoalBudget({ goalId: 'a', parentGoalId: 'missing' }), /missing/);
  family(api, {});
  assert.throws(() => api.ensureGoalBudget({ goalId: 'parent', parentGoalId: 'a' }), /identity conflict/);
  assert.equal(api.reserveGoalRequest({ ticketId: 'ordinary-ticket', requestId: 'ordinary' }).unbound, true);
});

test('Ticket admission atomically binds budgets and rolls back an invalid binding', t => {
  const api = createAssistantOrchestrationStore({ filename: ':memory:' }); t.after(() => api.close());
  api.ensureGoalBudget({ goalId: 'shared', budget: { requests: 1 } });
  const source = { channel: 'desktop', sessionId: 'owner', messageId: 'message' };
  const { trigger } = api.ingest({ dedupeKey: 'message', thread: { source: { type: 'desktop', id: 'owner' } }, source, actor: { kind: 'human', id: 'desktop-owner' }, content: 'work', mode: 'direct' });
  const input = { triggerId: trigger.id, requestKey: 'request', fingerprint: 'fingerprint', target: 'work', model: { providerId: 'provider', modelId: 'opaque' },
    mandate: { source, actorId: 'desktop-owner', policyVersion: 'version', admission: 'desktop-approved-delegation' } };
  assert.throws(() => api.acceptDesktop({ ...input, budgetGoalId: 'missing' }), /missing/);
  assert.equal(api.listTickets().length, 0);
  assert.equal(api.desktopRequest(input.requestKey), undefined);
  const ticket = api.acceptDesktop({ ...input, budgetGoalId: 'shared' });
  assert.equal(api.ticketGoalBudget(ticket.id).goalId, 'shared');
  assert.equal(api.assignments(ticket.id)[0].state, 'queued');
  assert.equal(api.acceptDesktop({ ...input, budgetGoalId: 'shared' }).id, ticket.id);
  assert.throws(() => api.acceptDesktop(input), /预算绑定/);
  assert.throws(() => api.bindTicketGoalInTransaction({ ticketId: 'outside', goalId: 'shared' }), /active transaction/);
  const replay = { database: api, ticketId: ticket.id, sessionId: 'worker', events: [{ type: 'assistant/attempt', seq: 1, data: { stream: [{ type: 'chunk', time: 1, chunk: { type: 'usage', usage: { totalTokens: 7 } } }] } }] };
  recordGoalBudgetEvents(replay); recordGoalBudgetEvents(replay);
  assert.equal(api.goalBudget('shared').usage.tokens, 7);
  assert.equal(api.goalBudget('shared').usage.unknownCost, 1);
});
