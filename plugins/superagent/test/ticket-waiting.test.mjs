import test from 'node:test';
import assert from 'node:assert/strict';
import { ticketWaiting } from '../client/ticket-state.mjs';

const ticket = { id: 'original', status: 'waiting', instructionRevision: 2, resultVersion: 3,
  results: [{ instructionRevision: 2, version: 3, review: { verdict: 'wait', waitKind: 'review_wait', reason: '核验服务暂不可用' } }] };
test('only the current result can explain or retry a review wait', () => {
  const waiting = ticketWaiting(ticket);
  assert.equal(waiting.reason, '核验服务暂不可用');
  assert.deepEqual(waiting.actions.find(action => action.kind === 'review').input, { ticketId: 'original', expectedResultVersion: 3 });
  for (const patch of [{ resultVersion: 4 }, { instructionRevision: 3 }, { results: [] }]) {
    const state = ticketWaiting({ ...ticket, ...patch, waitReason: '旧通知不能当成当前原因' });
    assert(!state.actions.some(action => action.kind === 'review'));
    assert(!state.reason.includes('旧通知'));
  }
});
test('unknown external effects allow verification and stopping without resuming or retrying', () => {
  for (const code of ['EXECUTION_EFFECTS_UNKNOWN', 'EXECUTION_NOT_VERIFIED', 'EXECUTION_STOP_UNCONFIRMED']) {
    for (const status of ['waiting', 'paused', 'uncertain']) {
      const waiting = ticketWaiting({ ...ticket, status, continuationWait: { code, sourceResultVersion: 3 } });
      assert.equal(waiting.label, '等待核实外部效果');
      assert.deepEqual(waiting.actions.map(action => action.kind), ['refresh', 'stop']);
      assert.equal(waiting.actions[0].label, '核实当前状态');
    }
  }
});
test('manual and legacy quota pauses both resume directly; next steps never offer quota or added time', () => {
  assert.equal(ticketWaiting({ ...ticket, status: 'paused', pauseReason: { kind: 'manual' } }).actions[0].kind, 'resume');
  const legacy = ticketWaiting({ ...ticket, status: 'paused', pauseReason: { kind: 'budget', reason: 'tokens' } });
  assert.equal(legacy.actions[0].kind, 'resume');
  assert.doesNotMatch(JSON.stringify(legacy), /额度|goals|additionalExecutionMs/);
});
test('a pre-result Ticket parked by the removed execution-time gate resumes without added time', () => {
  const waiting = ticketWaiting({ ...ticket, resultVersion: 0, results: [],
    continuationWait: { code: 'EXECUTION_BUDGET_EXHAUSTED', sourceResultVersion: 0 } });
  assert.equal(waiting.actions[0].label, '恢复原单');
  assert.deepEqual(waiting.actions[0].input, { ticketId: 'original', expectedResultVersion: 0 });
  assert.notEqual(waiting.label, '等待续做资源');
});
test('current unanswered attention leads while stale attention never supplies a question', () => {
  const attention = { id: 'question', state: 'waiting', origin: 'review', instructionRevision: 2, resultVersion: 3,
    question: { question: '请确认范围' } };
  assert.equal(ticketWaiting({ ...ticket, attentions: [attention] }).reason, '请确认范围');
  assert.equal(ticketWaiting({ ...ticket, attentions: [{ ...attention, resultVersion: 2 }] }).attention, undefined);
  assert.equal(ticketWaiting({ ...ticket, attentions: [attention], continuationWait: { code: 'EXECUTION_EFFECTS_UNKNOWN', sourceResultVersion: 3 } }).attention, null);
  assert.equal(ticketWaiting({ ...ticket, status: 'cancelled' }), null);
});
