import test from 'node:test';
import assert from 'node:assert/strict';
import { activityTask, createActivityStore } from '../client/activity-data.mjs';

const execution = () => ({ assignmentId: 'assignment', runId: 'run', sessionId: 'worker', instructionRevision: 2,
  phase: 'executing', observed: true, updatedAt: '2026-11-07T15:00:00.000Z',
  worker: { id: 'worker', label: 'Worker', status: 'running', activity: '正在搜索网页' },
  children: [{ id: 'child-1', label: '子 Worker 1', status: 'completed' },
    { id: 'child-2', label: '子 Worker 2', status: 'running' }, { id: 'child-3', label: '子 Worker 3', status: 'failed' }],
});
const ticket = () => ({ id: 'ticket', status: 'open', instructionRevision: 2,
  assignments: [{ id: 'assignment', instructionRevision: 2, state: 'claimed' }], execution: execution() });

test('the board shows observed worker activity and child outcomes without calling them ticket completion', () => {
  const row = activityTask(ticket(), 'ticket');
  assert.equal(row.status, 'claimed');
  assert.equal(row.progressSummary, '正在搜索网页 · 子任务 1/3 已返回 · 1 项执行中 · 1 项失败');
  assert.doesNotMatch(row.progressSummary, /%|预计/);
  const idle = ticket();
  idle.execution.worker = { ...idle.execution.worker, status: 'waiting', activity: '等待后续事件' };
  idle.execution.children = idle.execution.children.map(child => ({ ...child, status: 'completed' }));
  assert.equal(activityTask(idle, 'ticket').status, 'claimed', 'idle and all children returning do not finish a ticket');
});

test('activity from a different requirement or assignment cannot overwrite the current task', () => {
  for (const change of [{ instructionRevision: 1 }, { assignmentId: 'old-assignment' }]) {
    const row = ticket(); row.execution = { ...row.execution, ...change };
    const task = activityTask(row, 'ticket');
    assert.equal(task.execution, undefined);
    assert.equal(task.progressSummary, '');
    assert.equal(task.phase, '执行阶段 · 执行中');
  }
  const goal = activityTask({ ...ticket(), status: 'active' }, 'goal');
  assert.equal(goal.execution, undefined, 'goals do not adopt a ticket worker tree');
});

test('result persistence is distinct from execution, while user waits and terminal outcomes override runtime activity', () => {
  const row = ticket(); row.execution.phase = 'verifying';
  assert.equal(activityTask(row, 'ticket').status, 'verifying');
  assert.equal(activityTask(row, 'ticket').progressSummary, 'Worker 已交回结果，正在保存');
  for (const status of ['completed', 'cancelled', 'failed', 'paused', 'pausing', 'cancelling', 'uncertain']) {
    const task = activityTask({ ...row, status }, 'ticket');
    assert.equal(task.status, status);
    assert.equal(task.progressSummary, '', 'stale activity must not claim execution is still advancing');
  }
  const question = activityTask({ ...row, attentions: [{ id: 'attention', state: 'waiting', instructionRevision: 2,
    question: { question: '需要哪份材料？' } }] }, 'ticket');
  assert.equal(question.status, 'awaiting_user');
  assert.equal(question.detail, '需要哪份材料？');
  assert.equal(question.progressSummary, '');
});

function environment() {
  const document = new EventTarget(); document.hidden = false;
  const timers = new Map();
  return { document, timers, setTimeout(fn, ms) { timers.set(fn, ms); return fn; }, clearTimeout(fn) { timers.delete(fn); } };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('fallback reads stay bounded regardless of open views and back off after errors', async () => {
  const env = environment(); let state = 'open', fail = false;
  const store = createActivityStore(async action => {
    if (fail) throw new Error('offline');
    return action === 'tickets' ? { tickets: [{ id: 't', status: state }] } : { goals: [] };
  }, env);
  const unsubscribe = store.subscribe(() => {}); await flush();
  assert.deepEqual([...env.timers.values()], [10000]);
  await flush();
  assert.deepEqual([...env.timers.values()], [10000]);
  await flush();
  assert.deepEqual([...env.timers.values()], [10000], 'a second view shares the one polling timer');
  env.document.hidden = true; env.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(env.timers.size, 0);
  env.document.hidden = false; env.document.dispatchEvent(new Event('visibilitychange')); await flush();
  fail = true; await store.refresh();
  assert.equal(store.getSnapshot().rows.length, 1, 'failed refresh retains the last observation');
  assert.deepEqual([...env.timers.values()], [20000]);
  fail = false; state = 'completed'; await store.refresh();
  assert.deepEqual([...env.timers.values()], [10000]);
  state = 'open'; await store.refresh();
  assert.deepEqual([...env.timers.values()], [10000]);
  unsubscribe(); assert.equal(env.timers.size, 0);
});

test('changes arriving during a fetch are coalesced into one follow-up refresh', async () => {
  const env = environment(), pending = [];
  const store = createActivityStore((action, args, signal) => new Promise(resolve => pending.push({ action, signal, resolve })), env);
  const unsubscribe = store.subscribe(() => {});
  env.document.dispatchEvent(new Event('benchgo:assistant-changed'));
  env.document.dispatchEvent(new Event('benchgo:assistant-changed'));
  assert.equal(pending.length, 3, 'one shared active/archive/goal request batch');
  pending.forEach(call => call.resolve(call.action === 'tickets' ? { tickets: [] } : { goals: [] }));
  await flush();
  assert.deepEqual([...env.timers.values()], [0], 'invalidate the potentially old response once');
  const [next] = env.timers.keys(); next();
  assert.equal(pending.length, 6);
  pending.slice(3).forEach(call => call.resolve(call.action === 'tickets' ? { tickets: [{ id: 'new', status: 'open' }] } : { goals: [] }));
  await flush();
  assert.equal(store.getSnapshot().rows[0].id, 'new');
  assert.deepEqual([...env.timers.values()], [10000]);
  unsubscribe();
});


test('task summaries retain verification facts and the stop fence without claiming executor exit', () => {
  const row = ticket(); row.status = 'uncertain'; row.execution.uncertainty = { reason: '执行尚未完整结束', attempts: 3, nextCheckAt: 1794218400000, escalated: true };
  const task = activityTask(row, 'ticket');
  assert.equal(task.stateLabel, '执行异常 · 核查仍无结论');
  assert.equal(task.detail, '执行尚未完整结束');
  assert.match(task.verificationSummary, /已查 3 次.*下次/);
  const stopping = activityTask({ ...row, status: 'cancelling', execution: { ...row.execution, stopRequestedAt: '2026-11-09T10:00:00Z', stopConfirmationOverdue: true } }, 'ticket');
  assert.equal(stopping.stateLabel, '停止已生效 · 执行端未确认退出');
  assert.equal(stopping.progressSummary, '');
});
