import test from 'node:test';
import assert from 'node:assert/strict';
import { ticketWaiting, ticketExecutionNotice } from '../client/ticket-state.mjs';

const ticket = { id: 'original', status: 'waiting', instructionRevision: 2, resultVersion: 3,
  results: [{ instructionRevision: 2, version: 3, outcome: 'completed', summary: '原文结果', selfCheck: { summary: '已自检' } }] };
test('saved current result is pending delivery without any content review action', () => {
  const waiting = ticketWaiting(ticket);
  assert.equal(waiting.status, 'delivery_pending');
  assert.match(waiting.reason, /正在交付/);
  assert(!waiting.actions.some(action => action.kind === 'review'));
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
      assert.equal(waiting.actions[0].label, '刷新记录');
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
  const attention = { id: 'question', state: 'waiting', origin: 'worker', instructionRevision: 2, resultVersion: 3,
    question: { question: '请确认范围' } };
  assert.equal(ticketWaiting({ ...ticket, attentions: [attention] }).reason, '请确认范围');
  assert.equal(ticketWaiting({ ...ticket, attentions: [{ ...attention, instructionRevision: 1 }] }).attention, undefined);
  assert.equal(ticketWaiting({ ...ticket, attentions: [attention], continuationWait: { code: 'EXECUTION_EFFECTS_UNKNOWN', sourceResultVersion: 3 } }).attention, null);
  assert.equal(ticketWaiting({ ...ticket, status: 'cancelled' }), null);
});


test('automatic verification exposes real reason, counted attempts and scheduled check without user investigation', () => {
  const execution = { uncertainty: { reasonCode: 'WORKER_TURN_INCOMPLETE', reason: '执行回合未提交完整结束记录。', attempts: 2, nextCheckAt: 1794218400000, escalated: false } };
  const waiting = ticketWaiting({ ...ticket, status: 'uncertain', execution });
  assert.equal(waiting.label, '执行状态自动核查中');
  assert.equal(waiting.reason, execution.uncertainty.reason);
  assert.equal(waiting.executionNotice.attempts, 2);
  assert.equal(waiting.executionNotice.nextCheckAt, 1794218400000);
  assert.doesNotMatch(JSON.stringify(waiting), /请先核实|核实当前状态/);
  assert.deepEqual(waiting.actions.map(action => action.kind), ['refresh', 'stop']);
  assert.equal(ticketExecutionNotice({ ...ticket, status: 'completed', execution }), null);
});

test('escalated verification is abnormal rather than a pending user decision', () => {
  const waiting = ticketWaiting({ ...ticket, status: 'uncertain', execution: { uncertainty: { reason: '宿主两次均未返回执行状态。', attempts: 4, escalated: true } } });
  assert.equal(waiting.label, '执行异常 · 核查仍无结论');
  assert.equal(waiting.executionNotice.escalated, true);
  assert.equal(waiting.executionNotice.nextCheckAt, null);
  assert.equal(waiting.attention, null);
});

test('stopping distinguishes the action fence from executor exit and trusts only the server threshold', () => {
  const execution = { stopRequestedAt: 1, stopConfirmationOverdue: false };
  const waiting = ticketWaiting({ ...ticket, status: 'cancelling', execution });
  assert.equal(waiting.label, '停止已生效 · 正在结束执行');
  assert.match(waiting.reason, /后续动作已拦截/);
  assert.equal(waiting.executionNotice.stopRequestedAt, 1);
  assert.deepEqual(waiting.actions.map(action => action.kind), ['refresh']);
  const overdue = ticketWaiting({ ...ticket, status: 'cancelling', execution: { ...execution, stopConfirmationOverdue: true } });
  assert.equal(overdue.label, '停止已生效 · 执行端未确认退出');
  assert.match(overdue.reason, /仍未确认退出/);
  assert.equal(overdue.executionNotice.escalated, true);
  assert.equal(ticketExecutionNotice({ ...ticket, status: 'uncertain' }), null, 'missing facts do not invent attempts or deadlines');
  assert.equal(ticketWaiting({ ...ticket, status: 'uncertain' }).label, '执行状态待同步');
});


test('missing recovery evidence is not advertised as a scheduled automatic check or a user task', () => {
  const row = { ...ticket, status: 'uncertain', execution: { uncertainty: { reason: '执行会话中断', attempts: 0, nextCheckAt: null, automatic: false, recoveryBlocked: '缺少完整结束证据' } } };
  const waiting = ticketWaiting(row);
  assert.equal(waiting.label, '执行状态待恢复证据');
  assert.equal(waiting.executionNotice.automatic, false);
  assert.equal(waiting.executionNotice.recoveryBlocked, '缺少完整结束证据');
  assert.equal(waiting.executionNotice.nextCheckAt, null);
  assert.equal(ticketExecutionNotice({ ...row, execution: { uncertainty: { ...row.execution.uncertainty, instructionRevision: 1 } } }), null);
});
