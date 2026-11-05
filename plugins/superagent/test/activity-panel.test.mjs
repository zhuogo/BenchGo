import test from 'node:test';
import assert from 'node:assert/strict';
import { groupByDay } from '../client/time-groups.mjs';
import { activityTask as task } from '../client/activity-data.mjs';
test('task phases exclude old requirements and match delivery to the current result', () => {
  const row = { id: 't', status: 'open', instructionRevision: 2, assignments: [{ instructionRevision: 2, state: 'claimed' }], results: [{ instructionRevision: 1, summary: 'old' }], deliveries: [{ state: 'sent', payload: { result: { instructionRevision: 1, version: 1 } } }] };
  assert.equal(task(row, 'ticket').status, 'claimed');
  assert.equal(task(row, 'ticket').detail, undefined);
  assert.equal(task(row, 'ticket').phase, '执行阶段 · 执行中');
  row.results.push({ instructionRevision: 2, version: 2, summary: 'current', review: { reason: 'accepted' } });
  row.deliveries.push({ state: 'sent', payload: { result: { instructionRevision: 2, version: 2 } } });
  assert.equal(task(row, 'ticket').phase, '结果已交付');
});
test('completed tasks show the automatic report and only its current delivery state', () => {
  const row = { id: 't', status: 'completed', instructionRevision: 2,
    results: [{ instructionRevision: 2, version: 3, summary: 'worker draft', review: { verdict: 'passed', reason: 'checks passed' }, delivery: { action: 'deliver', text: '正式完成报告' } }],
    deliveries: [{ state: 'sent', payload: { type: 'ticket.result', instructionRevision: 1, resultVersion: 3 } }, { state: 'sent', payload: { type: 'ticket.result', instructionRevision: 2, resultVersion: 2 } }],
  };
  assert.equal(task(row, 'ticket').status, 'completed');
  assert.equal(task(row, 'ticket').detail, '正式完成报告');
  assert.equal(task(row, 'ticket').phase, '自动核验已结束');
  row.deliveries.push({ state: 'queued', payload: { type: 'ticket.result', instructionRevision: 2, resultVersion: 3 } });
  assert.equal(task(row, 'ticket').phase, '结果交付阶段');
  row.deliveries.at(-1).state = 'sent';
  assert.equal(task(row, 'ticket').phase, '结果已交付');
  row.deliveries.push({ state: 'queued', payload: { type: 'ticket.attention', instructionRevision: 2, resultVersion: 3 } });
  assert.equal(task(row, 'ticket').phase, '结果已交付');
  row.deliveries = [];
  row.status = 'waiting';
  row.results[0].review = { verdict: 'wait', reason: '需要补充信息' };
  assert.equal(task(row, 'ticket').phase, '系统自动补证与核验');
});
test('memory time groups sort newest first and preserve unknown dates', () => {
  const groups = groupByDay([{ id: 'unknown' }, { id: 'old', time: '2026-11-02T12:00:00' }, { id: 'new', time: '2026-11-03T12:00:00' }], row => row.time, new Date('2026-11-03T13:00:00'));
  assert.deepEqual(groups.map(group => group.label), ['今天', '昨天', '时间未记录']);
  assert.equal(groups[0].entries[0].id, 'new');
});
