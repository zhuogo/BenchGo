import test from 'node:test';
import assert from 'node:assert/strict';
import { ticketWaiting } from '../client/ticket-state.mjs';

const ticket = { id: 'original', status: 'waiting', instructionRevision: 2, resultVersion: 3,
  results: [{ instructionRevision: 2, version: 3, outcome: 'completed', summary: '原文结果', selfCheck: { summary: '已自检' } }] };
test('saved current result is pending delivery without any content review action', () => {
  const waiting = ticketWaiting(ticket);
  assert.equal(waiting.status, 'waiting');
  assert.match(waiting.reason, /等待交付/);
  assert(!waiting.actions.some(action => action.kind === 'review'));
  for (const patch of [{ resultVersion: 4 }, { instructionRevision: 3 }, { results: [] }]) {
    const state = ticketWaiting({ ...ticket, ...patch, waitReason: '旧通知不能当成当前原因' });
    assert(!state.actions.some(action => action.kind === 'review'));
    assert(!state.reason.includes('旧通知'));
  }
});
test('unknown external effects allow verification and stopping without resuming or retrying', () => {
  for (const code of ['EXECUTION_EFFECTS_UNKNOWN', 'EXECUTION_NOT_VERIFIED', 'EXECUTION_STOP_UNCONFIRMED']) {
    for (const executionControl of [{}, { paused: true }, { stopped: true }]) {
      const waiting = ticketWaiting({ ...ticket, executionControl, continuationWait: { code, sourceResultVersion: 3 } });
      assert.equal(waiting.label, '等待');
      assert(!waiting.actions.some(action => action.kind === 'resume'));
      assert.equal(waiting.actions.find(action => action.kind === 'refresh').label, '核实当前状态');
    }
  }
});
test('manual and legacy quota pauses both resume directly; next steps never offer quota or added time', () => {
  assert.equal(ticketWaiting({ ...ticket, executionControl: { paused: true }, pauseReason: { kind: 'manual' } }).actions[0].kind, 'resume');
  const legacy = ticketWaiting({ ...ticket, executionControl: { paused: true }, pauseReason: { kind: 'budget', reason: 'tokens' } });
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
  const attention = { id: 'question', state: 'waiting', origin: 'worker', instructionRevision: 2, resultVersion: 3,
    question: { question: '请确认范围' } };
  assert.equal(ticketWaiting({ ...ticket, attentions: [attention] }).reason, '请确认范围');
  assert.equal(ticketWaiting({ ...ticket, attentions: [{ ...attention, instructionRevision: 1 }] }).attention, undefined);
  assert.equal(ticketWaiting({ ...ticket, attentions: [attention], continuationWait: { code: 'EXECUTION_EFFECTS_UNKNOWN', sourceResultVersion: 3 } }).attention, null);
  assert.equal(ticketWaiting({ ...ticket, status: 'completed' }), null);
});

test('failed outcomes stay waiting with a short reason and require an explicit revision', () => {
  const waiting = ticketWaiting({ ...ticket, continuationWait: { code: 'EXECUTION_FAILED', sourceResultVersion: 3, reason: '部署失败；请补充权限。' } });
  assert.equal(waiting.status, 'waiting');
  assert.match(waiting.reason, /补充权限/);
  assert(!waiting.actions.some(action => action.kind === 'resume'));
  assert(waiting.actions.some(action => action.kind === 'tasks'));
});

test('failure cause, recovery condition and next step fit one short paragraph', () => {
  const waiting = ticketWaiting({ ...ticket, results: [{ instructionRevision: 2, version: 3, outcome: 'failed', failure: { cause: '原因'.repeat(200), resumeConditions: '补充权限'.repeat(200) } }], continuationWait: { code: 'EXECUTION_FAILED', sourceResultVersion: 3 } });
  assert(waiting.reason.length <= 240);
  assert.match(waiting.reason, /原因/);
  assert.match(waiting.reason, /补充权限/);
  assert.match(waiting.reason, /调整要求后继续/);
  assert(!waiting.reason.includes('\n'));
});
