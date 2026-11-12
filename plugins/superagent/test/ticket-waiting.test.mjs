import test from 'node:test';
import assert from 'node:assert/strict';
import { ticketWaiting, ticketExecutionNotice } from '../client/ticket-state.mjs';
import { executionStatusText } from '../src/ticket-lifecycle.mjs';

const ticket = { id: 'original', status: 'waiting', instructionRevision: 2, resultVersion: 3,
  results: [{ instructionRevision: 2, version: 3, outcome: 'completed', summary: '原文结果' }] };
test('legacy persistence status is readable Chinese without changing unknown messages', () => {
  const reason = 'Saved result is awaiting persistence';
  assert.equal(executionStatusText(reason), '执行结果已暂存，尚未完成正式保存。');
  assert.equal(executionStatusText('Exact: Model/01'), 'Exact: Model/01');
  assert.equal(ticketWaiting({ ...ticket, continuationWait: { sourceResultVersion: 3, reason } }).reason, executionStatusText(reason));
  assert.equal(ticketExecutionNotice({ ...ticket, execution: { uncertainty: { reason, reasonCode: 'saved-result-blocked' } } }).reason, executionStatusText(reason));
});
test('saved current result does not invent delivery or queueing as a business wait reason', () => {
  const waiting = ticketWaiting(ticket);
  assert.equal(waiting.status, 'waiting');
  assert.match(waiting.reason, /等待原因尚未明确/);
  assert(!waiting.actions.some(action => action.kind === 'review'));
  for (const patch of [{ resultVersion: 4 }, { instructionRevision: 3 }, { results: [] }]) {
    const state = ticketWaiting({ ...ticket, ...patch, waitReason: '旧通知不能当成当前原因' });
    assert(!state.actions.some(action => action.kind === 'review'));
    assert(!state.reason.includes('旧通知'));
  }
});
test('delivery uncertainty neither hides a real question nor replaces the execution failure', () => {
  const deliveries = [{ state: 'uncertain', lastError: '来源回执未知', payload: { type: 'ticket.result', instructionRevision: 2, resultVersion: 3 } }];
  const attention = { id: 'question', state: 'waiting', instructionRevision: 2, question: { question: '请选择检查范围' } };
  const asking = ticketWaiting({ ...ticket, deliveries, attentions: [attention] });
  assert.equal(asking.attention, attention);
  assert.equal(asking.reason, '请选择检查范围');
  const failed = ticketWaiting({ ...ticket, deliveries, results: [{ ...ticket.results[0], outcome: 'failed' }],
    continuationWait: { code: 'EXECUTION_FAILED', sourceResultVersion: 3, reason: '目标模型当前不可用', resumeConditions: '请调整模型配置' } });
  assert.match(failed.reason, /目标模型当前不可用/);
  assert.doesNotMatch(failed.reason, /来源回执未知|外部操作是否生效/);
});
test('unknown external effects allow refreshing without resuming or retrying', () => {
  for (const code of ['EXECUTION_EFFECTS_UNKNOWN', 'EXECUTION_NOT_VERIFIED', 'EXECUTION_STOP_UNCONFIRMED']) {
    for (const status of ['waiting']) {
      const waiting = ticketWaiting({ ...ticket, status, continuationWait: { code, sourceResultVersion: 3 } });
      assert.equal(waiting.label, '等待');
      assert.deepEqual(waiting.actions.map(action => action.kind), ['refresh']);
      assert.equal(waiting.actions[0].label, '刷新记录');
    }
  }
});
test('a manual pause resumes directly; next steps never offer quota or added time', () => {
  const paused = ticketWaiting({ ...ticket, status: 'waiting', executionControl: { paused: true }, pauseReason: { kind: 'manual' } });
  assert.equal(paused.actions[0].kind, 'resume');
  assert.doesNotMatch(JSON.stringify(paused), /额度|goals|additionalExecutionMs/);
});
test('current unanswered attention leads while stale attention never supplies a question', () => {
  const attention = { id: 'question', state: 'waiting', origin: 'worker', instructionRevision: 2, resultVersion: 3,
    question: { question: '请确认范围' } };
  assert.equal(ticketWaiting({ ...ticket, attentions: [attention] }).reason, '请确认范围');
  assert.equal(ticketWaiting({ ...ticket, attentions: [{ ...attention, instructionRevision: 1 }] }).attention, undefined);
  assert.equal(ticketWaiting({ ...ticket, attentions: [attention], continuationWait: { code: 'EXECUTION_EFFECTS_UNKNOWN', sourceResultVersion: 3 } }).attention, null);
  assert.equal(ticketWaiting({ ...ticket, status: 'completed' }), null);
});


test('interrupted execution exposes its reason without an automatic verification schedule', () => {
  const execution = { uncertainty: { reasonCode: 'WORKER_TURN_INCOMPLETE', reason: '执行回合未提交完整结束记录。', attempts: 2, nextCheckAt: 1794218400000, escalated: false } };
  const waiting = ticketWaiting({ ...ticket, status: 'waiting', execution });
  assert.equal(waiting.label, '等待');
  assert.equal(waiting.reason, execution.uncertainty.reason);
  assert.equal(waiting.executionNotice.attempts, undefined);
  assert.equal(waiting.executionNotice.nextCheckAt, undefined);
  assert.doesNotMatch(JSON.stringify(waiting), /请先核实|核实当前状态/);
  assert.deepEqual(waiting.actions.map(action => action.kind), ['refresh']);
  assert.equal(ticketExecutionNotice({ ...ticket, status: 'completed', execution }), null);
});

test('escalated verification is abnormal rather than a pending user decision', () => {
  const waiting = ticketWaiting({ ...ticket, status: 'waiting', execution: { uncertainty: { reason: '宿主两次均未返回执行状态。', attempts: 4, escalated: true } } });
  assert.equal(waiting.label, '等待');
  assert.equal(waiting.executionNotice.escalated, true);
  assert.equal(waiting.executionNotice.nextCheckAt, undefined);
  assert.equal(waiting.attention, null);
});

test('stopping distinguishes the action fence from executor exit and trusts only the server threshold', () => {
  const execution = { stopRequestedAt: 1, stopConfirmationOverdue: false };
  const waiting = ticketWaiting({ ...ticket, status: 'waiting', executionControl: { stopRequested: true }, execution });
  assert.equal(waiting.label, '等待');
  assert.match(waiting.reason, /后续动作已拦截/);
  assert.equal(waiting.executionNotice.stopRequestedAt, 1);
  assert.deepEqual(waiting.actions.map(action => action.kind), ['refresh']);
  const overdue = ticketWaiting({ ...ticket, status: 'waiting', executionControl: { stopRequested: true }, execution: { ...execution, stopConfirmationOverdue: true } });
  assert.equal(overdue.label, '等待');
  assert.match(overdue.reason, /仍未确认退出/);
  assert.equal(overdue.executionNotice.escalated, true);
  assert.equal(ticketExecutionNotice({ ...ticket, status: 'waiting' }), null, 'missing facts do not invent attempts or deadlines');
  assert.equal(ticketWaiting({ ...ticket, status: 'waiting' }).label, '等待');
});


test('missing recovery evidence is not advertised as a scheduled automatic check or a user task', () => {
  const row = { ...ticket, status: 'waiting', execution: { uncertainty: { reason: '执行会话中断', attempts: 0, nextCheckAt: null, automatic: false, recoveryBlocked: '缺少完整结束证据' } } };
  const waiting = ticketWaiting(row);
  assert.equal(waiting.label, '等待');
  assert.equal(waiting.executionNotice.automatic, undefined);
  assert.equal(waiting.executionNotice.recoveryBlocked, '缺少完整结束证据');
  assert.equal(waiting.executionNotice.nextCheckAt, undefined);
  assert.equal(ticketExecutionNotice({ ...row, execution: { uncertainty: { ...row.execution.uncertainty, instructionRevision: 1 } } }), null);
});


test('failed execution waits with a concise reason and a concrete next step instead of blind resume', () => {
  const failed = { ...ticket, results: [{ instructionRevision: 2, version: 3, outcome: 'failed' }],
    continuationWait: { code: 'EXECUTION_FAILED', sourceResultVersion: 3, reason: '服务拒绝请求。'.repeat(100), resumeConditions: '修改有效授权。'.repeat(100) } };
  const waiting = ticketWaiting(failed);
  assert.equal(waiting.status, 'waiting');
  assert(Array.from(waiting.reason).length <= 240);
  assert.match(waiting.reason, /调整要求后继续/);
  assert(waiting.actions.some(action => action.kind === 'tasks'));
  assert(!waiting.actions.some(action => action.kind === 'resume'));
  const stopped = ticketWaiting({ ...ticket, executionControl: { stopped: true } });
  assert(!stopped.actions.some(action => action.kind === 'resume' || action.kind === 'stop'));
});

test('only current interrupted execution offers explicit original-ticket continuation', () => {
  for (const reasonCode of ['session-interrupted']) {
    const row = { ...ticket, execution: { uncertainty: { reasonCode, instructionRevision: 2, reason: '执行中断，等待继续。' } } };
    assert.deepEqual(ticketWaiting(row).actions[0], { kind: 'resume', label: '继续原工单', input: { ticketId: ticket.id } });
    for (const control of [{ paused: true }, { pauseRequested: true }, { stopped: true }, { stopRequested: true }])
      assert(!ticketWaiting({ ...row, executionControl: control }).actions.some(action => action.label === '继续原工单'));
    assert(!ticketWaiting({ ...row, execution: { uncertainty: { ...row.execution.uncertainty, instructionRevision: 1 } } }).actions.some(action => action.kind === 'resume'));
  }
});

test('automatic saved-result recovery never asks the user to continue or authorize persistence', () => {
  const execution = { uncertainty: { reasonCode: 'saved-result-pending', automatic: true, instructionRevision: 2, reason: '执行结果已保留，系统正在自动核对并保存，无需授权。' } };
  assert.equal(ticketWaiting({ ...ticket, status: 'running', execution }), null);
  assert.equal(ticketExecutionNotice({ ...ticket, status: 'running', execution }).label, '正在保存结果');
  assert.equal(ticketWaiting({ ...ticket, execution }).actions.some(action => action.kind === 'resume'), false, 'legacy snapshots never offer a manual continuation for automatic persistence');
  assert.equal(ticketWaiting({ ...ticket, execution: { uncertainty: { ...execution.uncertainty, reasonCode: 'saved-result-blocked' } } }).actions.some(action => action.kind === 'resume'), false);
});

test('configuration blockers display their cause without an ineffective manual continuation', () => {
  const waiting = ticketWaiting({ ...ticket, continuationWait: { stage: 'scheduling', code: 'WORKER_MODEL_ROUTE', sourceResultVersion: 3, reason: '请配置可用的 Worker 模型。' } });
  assert.match(waiting.reason, /Worker/);
  assert.deepEqual(waiting.actions.map(action => action.kind), ['refresh']);
});
