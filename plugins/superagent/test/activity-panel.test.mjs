import test from 'node:test';
import assert from 'node:assert/strict';
import { groupByDay } from '../client/time-groups.mjs';
import { activityTask as task } from '../client/activity-data.mjs';
test('task phases exclude old requirements and match delivery to the current result', () => {
  const row = { id: 't', status: 'running', instructionRevision: 2, assignments: [{ instructionRevision: 2, state: 'claimed' }], results: [{ instructionRevision: 1, summary: 'old' }], deliveries: [{ state: 'sent', payload: { result: { instructionRevision: 1, version: 1 } } }] };
  assert.equal(task(row, 'task').status, 'running');
  assert.equal(task(row, 'task').detail, undefined);
  assert.equal(task(row, 'task').phase, '执行阶段 · 执行中');
  row.results.push({ instructionRevision: 2, version: 2, summary: 'current' });
  row.deliveries.push({ state: 'sent', payload: { result: { instructionRevision: 2, version: 2 } } });
  assert.equal(task(row, 'task').phase, '结果已交付');
});
test('completed tasks show the automatic report and only its current delivery state', () => {
  const row = { id: 't', status: 'completed', instructionRevision: 2,
    results: [{ instructionRevision: 2, version: 3, summary: '原文', delivery: { action: 'deliver', text: '正式完成报告' } }],
    deliveries: [{ state: 'sent', payload: { type: 'task.result', instructionRevision: 1, resultVersion: 3 } }, { state: 'sent', payload: { type: 'task.result', instructionRevision: 2, resultVersion: 2 } }],
  };
  assert.equal(task(row, 'task').status, 'completed');
  assert.equal(task(row, 'task').detail, '原文');
  assert.equal(task(row, 'task').phase, '执行完成');
  row.deliveries.push({ state: 'queued', payload: { type: 'task.result', instructionRevision: 2, resultVersion: 3 } });
  assert.equal(task(row, 'task').phase, '执行完成');
  row.deliveries.at(-1).state = 'sent';
  assert.equal(task(row, 'task').phase, '执行完成 · 结果已交付');
  row.deliveries.push({ state: 'queued', payload: { type: 'task.attention', instructionRevision: 2, resultVersion: 3 } });
  assert.equal(task(row, 'task').phase, '执行完成 · 结果已交付');
  row.deliveries = [];
  row.status = 'waiting';
  assert.equal(task(row, 'task').status, 'waiting');
  assert.equal(task(row, 'task').phase, '等待原因尚未明确，请刷新任务记录。');
});
test('memory time groups sort newest first and preserve unknown dates', () => {
  const groups = groupByDay([{ id: 'unknown' }, { id: 'old', time: '2026-11-02T12:00:00' }, { id: 'new', time: '2026-11-03T12:00:00' }], row => row.time, new Date('2026-11-03T13:00:00'));
  assert.deepEqual(groups.map(group => group.label), ['今天', '昨天', '时间未记录']);
  assert.equal(groups[0].entries[0].id, 'new');
});
