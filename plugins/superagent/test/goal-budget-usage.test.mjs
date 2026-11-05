import test from 'node:test';
import assert from 'node:assert/strict';
import { goalBudgetUsage, recordGoalBudgetEvents, installGoalBudgetUsage } from '../src/goal-budget-usage.mjs';

const sample = totalTokens => ({ type: 'chunk', time: 1, chunk: { type: 'usage', usage: { inputTokens: 2, outputTokens: 3, totalTokens } } });
test('durable failed attempts use the last official usage sample, not their sum', () => {
  const event = { type: 'assistant/attempt', seq: 9, data: { stream: [sample(5), sample(12)] } };
  assert.deepEqual(goalBudgetUsage(event), { seq: 9, tokens: 12, cost: null });
  assert.equal(goalBudgetUsage(event, { inheritedEventCount: 10 }), null);
  assert.deepEqual(goalBudgetUsage(event, { inheritedEventCount: 9 }), { seq: 9, tokens: 12, cost: null });
});

test('completed message uses authoritative usage and missing usage stays unknown', () => {
  assert.deepEqual(goalBudgetUsage({ type: 'assistant/message', seq: 1, data: { usage: { totalTokens: 0 }, stream: [sample(10)] } }), { seq: 1, tokens: 0, cost: null });
  for (const data of [{}, { usage: { inputTokens: 2, outputTokens: 3 } }, { usage: { totalTokens: -1 } }]) {
    assert.deepEqual(goalBudgetUsage({ type: 'assistant/message', seq: 1, data }), { seq: 1, tokens: null, cost: null });
  }
});

test('replay sends only owned assistant settlements with stable durable identity', () => {
  const recorded = [];
  recordGoalBudgetEvents({ database: { recordGoalUsage: row => recorded.push(row) }, ticketId: 't', sessionId: 's', inheritedEventCount: 2,
    events: [{ type: 'assistant/message', seq: 1, data: {} }, { type: 'user/message', seq: 2, data: {} }, { type: 'assistant/attempt', seq: 3, data: {} }] });
  assert.deepEqual(recorded, [{ ticketId: 't', sessionId: 's', seq: 3, tokens: null, cost: null }]);
});

test('worker usage replays owned history and observes only its own session', () => {
  const rows = [], listeners = new Map();
  const session = { inheritedEventCount: 2, snapshotEvents: () => [{ type: 'assistant/attempt', seq: 1, data: {} }, { type: 'assistant/message', seq: 3, data: { usage: { totalTokens: 8 } } }] };
  const dispose = () => {};
  const scope = { on: (name, fn) => { listeners.set(name, fn); return dispose; } };
  const database = { ticketGoalBudget: () => ({ goalId: 'g' }), recordGoalUsage: row => rows.push(row) };
  assert.equal(installGoalBudgetUsage(scope, { id: 'session', session }, { database, ticketId: 'ticket' }), dispose);
  listeners.get('session/event')({}, { type: 'assistant/message', seq: 4, data: {} });
  listeners.get('session/event')(session, { type: 'assistant/attempt', seq: 4, data: {} });
  assert.deepEqual(rows.map(row => [row.seq, row.tokens]), [[3, 8], [4, null]]);
  assert.equal(installGoalBudgetUsage({}, {}, { database: { ticketGoalBudget: () => null }, ticketId: 'ordinary' }), undefined);
});
