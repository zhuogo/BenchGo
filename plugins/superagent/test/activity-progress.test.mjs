import test from 'node:test';
import assert from 'node:assert/strict';
import { activityTask, createActivityStore } from '../client/activity-data.mjs';

const execution = () => ({ assignmentId: 'assignment', runId: 'run', sessionId: 'worker', instructionRevision: 2,
  phase: 'executing', observed: true, updatedAt: '2026-11-07T15:00:00.000Z',
  worker: { id: 'worker', label: 'Worker', status: 'running', activity: '正在搜索网页' },
  children: [{ id: 'child-1', label: '子 Worker 1', status: 'completed' },
    { id: 'child-2', label: '子 Worker 2', status: 'running' }, { id: 'child-3', label: '子 Worker 3', status: 'failed' }],
});
const createTask = () => ({ id: 'task', status: 'running', instructionRevision: 2,
  assignments: [{ id: 'assignment', instructionRevision: 2, state: 'claimed' }], execution: execution() });

test('the board shows observed worker activity and child outcomes without calling them task completion', () => {
  const row = activityTask(createTask(), 'task');
  assert.equal(row.status, 'running');
  assert.equal(row.progressSummary, '正在搜索网页 · 子任务 1/3 已返回 · 1 项执行中 · 1 项失败');
  assert.doesNotMatch(row.progressSummary, /%|预计/);
  const idle = createTask();
  idle.execution.worker = { ...idle.execution.worker, status: 'waiting', activity: '等待后续事件' };
  idle.execution.children = idle.execution.children.map(child => ({ ...child, status: 'completed' }));
  assert.equal(activityTask(idle, 'task').status, 'running', 'idle and all children returning do not finish a task');
});

test('activity from a different requirement or assignment cannot overwrite the current task', () => {
  for (const change of [{ instructionRevision: 1 }, { assignmentId: 'old-assignment' }]) {
    const row = createTask(); row.execution = { ...row.execution, ...change };
    const task = activityTask(row, 'task');
    assert.equal(task.execution, undefined);
    assert.equal(task.progressSummary, '');
    assert.equal(task.phase, '执行阶段 · 执行中');
  }
  const goal = activityTask({ ...createTask(), status: 'active' }, 'goal');
  assert.equal(goal.execution, undefined, 'goals do not adopt a task worker tree');
});

test('executor reports lead task summaries while completion and waiting facts remain authoritative', () => {
  const row = createTask();
  row.execution.summary = { text: '正在执行' };
  Object.assign(row.execution.worker, { activitySource: 'report', activity: '核对邮箱验证限制，准备重新注册' });
  assert.equal(activityTask(row, 'task').summaryText, '核对邮箱验证限制，准备重新注册');
  row.execution.worker.status = 'completed';
  assert.equal(activityTask(row, 'task').summaryText, '执行已结束');
  row.execution.worker.status = 'running';
  assert.equal(activityTask({ ...row, status: 'waiting' }, 'task').summaryText, '');
  row.execution.observed = false;
  assert.equal(activityTask(row, 'task').summaryText, '正在执行');
});

test('persistence adds no task stage and terminal outcomes override stale runtime summaries', () => {
  const row = createTask(); row.execution.phase = 'finished';
  row.execution.worker.status = 'completed';
  assert.equal(activityTask(row, 'task').status, 'running');
  assert.match(activityTask(row, 'task').progressSummary, /^执行已结束/);
  row.execution.summary = { text: '正在保存执行结果' };
  row.currentSummary = '执行状态待核实';
  for (const status of ['completed', 'waiting']) {
    const task = activityTask({ ...row, status }, 'task');
    assert.equal(task.status, status);
    assert.equal(task.progressSummary, '', 'stale activity must not claim execution is still advancing');
    assert.equal(task.summaryText, '', 'stale session summaries cannot override terminal or waiting facts');
  }
  const question = activityTask({ ...row, status: 'waiting', attentions: [{ id: 'attention', state: 'waiting', instructionRevision: 2,
    question: { question: '需要哪份材料？' } }] }, 'task');
  assert.equal(question.status, 'waiting');
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
  const env = environment(); let state = 'running', fail = false;
  const store = createActivityStore(async action => {
    if (fail) throw new Error('offline');
    return action === 'tasks' ? { tasks: [{ id: 't', status: state }] } : { goals: [] };
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
  state = 'running'; await store.refresh();
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
  pending.forEach(call => call.resolve(call.action === 'tasks' ? { tasks: [] } : { goals: [] }));
  await flush();
  assert.deepEqual([...env.timers.values()], [0], 'invalidate the potentially old response once');
  const [next] = env.timers.keys(); next();
  assert.equal(pending.length, 6);
  pending.slice(3).forEach(call => call.resolve(call.action === 'tasks' ? { tasks: [{ id: 'new', status: 'running' }] } : { goals: [] }));
  await flush();
  assert.equal(store.getSnapshot().rows[0].id, 'new');
  assert.deepEqual([...env.timers.values()], [10000]);
  unsubscribe();
});

test('fallback pages every active and archived task, including the final empty exact-size page', async () => {
  const env = environment(), calls = [];
  const active = Array.from({ length: 2505 }, (_, index) => ({ id: `active-${index}`, status: 'running' }));
  const archived = Array.from({ length: 1000 }, (_, index) => ({ id: `archived-${index}`, status: 'completed', archived: true }));
  const store = createActivityStore(async (action, args) => {
    calls.push([action, args]);
    return action === 'tasks' ? { tasks: (args.archived ? archived : active).slice(args.offset, args.offset + args.limit) } : { goals: [] };
  }, env);
  const stop = store.subscribe(() => {}); await flush();
  assert.equal(store.getSnapshot().rows.length, 3505);
  for (const [value, offsets] of [[false, [0, 1000, 2000]], [true, [0, 1000]]]) {
    assert.deepEqual(calls.filter(([name, args]) => name === 'tasks' && args.archived === value).map(([, args]) => args.offset), offsets);
  }
  assert(calls.filter(([name]) => name === 'tasks').every(([, args]) => args.limit === 1000));
  assert.equal(store.getSnapshot().error, ''); stop();
});

test('an old endpoint that ignores offsets fails explicitly without replacing the saved snapshot', async () => {
  const env = environment(); let ignoreOffsets = false, taskCalls = 0;
  const repeated = Array.from({ length: 1000 }, (_, index) => ({ id: `t-${index}`, status: 'running' }));
  const store = createActivityStore(async (action, args) => {
    if (action !== 'tasks') return { goals: [] };
    taskCalls++;
    return { tasks: args.archived ? [] : ignoreOffsets ? repeated : [{ id: 'saved', status: 'running' }] };
  }, env);
  const stop = store.subscribe(() => {}); await flush();
  const previous = store.getSnapshot().rows;
  ignoreOffsets = true; taskCalls = 0; await store.refresh();
  assert.strictEqual(store.getSnapshot().rows, previous); assert.equal(taskCalls, 3);
  assert.match(store.getSnapshot().error, /分页未继续前进/); stop();
});

test('a change during pagination discards stale pages and schedules one complete trailing snapshot', async () => {
  const env = environment(); let release, changed = false;
  const values = Array.from({ length: 1000 }, (_, index) => ({ id: `t-${index}`, status: 'running' }));
  const store = createActivityStore(async (action, args) => {
    if (action !== 'tasks') return { goals: [] };
    if (args.archived) return { tasks: [] };
    if (args.offset === 1000 && !changed) return new Promise(resolve => { release = resolve; });
    return { tasks: [...values, ...(changed ? [{ id: 'new', status: 'waiting' }] : [])].slice(args.offset, args.offset + args.limit) };
  }, env);
  const stop = store.subscribe(() => {}); await flush(); assert(release);
  changed = true; env.document.dispatchEvent(new Event('benchgo:assistant-changed'));
  release({ tasks: [] }); await flush();
  assert.equal(store.getSnapshot().rows, null, 'stale partial pages must not flash into the board');
  assert.deepEqual([...env.timers.values()], [0]);
  const [retry] = env.timers.keys(); retry(); await flush();
  assert.equal(store.getSnapshot().rows.length, 1001); assert(store.getSnapshot().rows.some(value => value.id === 'new'));
  stop();
});

test('cancelled fallback pagination never starts the next page or publishes a late result', async () => {
  const env = environment(), calls = []; let release;
  const store = createActivityStore((action, args) => {
    calls.push([action, args]);
    if (action === 'tasks' && !args.archived) return new Promise(resolve => { release = resolve; });
    return Promise.resolve(action === 'tasks' ? { tasks: [] } : { goals: [] });
  }, env);
  const stop = store.subscribe(() => {}); stop();
  release({ tasks: Array.from({ length: 1000 }, (_, index) => ({ id: `t-${index}` })) }); await flush();
  assert.equal(calls.length, 3); assert.equal(store.getSnapshot().rows, null); assert.equal(env.timers.size, 0);
});


test('task summaries retain verification facts and the stop fence without claiming executor exit', () => {
  const row = createTask(); row.status = 'waiting'; row.execution.uncertainty = { reason: '执行尚未完整结束', attempts: 3, nextCheckAt: 1794218400000, escalated: true };
  const task = activityTask(row, 'task');
  assert.equal(task.stateLabel, '等待');
  assert.equal(task.detail, '执行尚未完整结束');
  assert.equal(task.verificationSummary, undefined);
  const stopping = activityTask({ ...row, status: 'waiting', executionControl: { stopRequested: true }, execution: { ...row.execution, stopRequestedAt: '2026-11-09T10:00:00Z', stopConfirmationOverdue: true } }, 'task');
  assert.equal(stopping.stateLabel, '等待');
  assert.equal(stopping.progressSummary, '');
});
