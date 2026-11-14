import test from 'node:test';
import assert from 'node:assert/strict';
import { filterTasks, groupTasks, taskLane } from '../client/task-board.mjs';

test('board uses only the three persisted Task states', () => {
  for (const status of ['running', 'waiting', 'completed']) assert.equal(taskLane({ status }), status);
  assert.equal(taskLane({ status: 'waiting', taskMeta: { completed: true } }), 'waiting');
  assert.equal(taskLane({ status: 'waiting', executionControl: { stopped: true } }), 'waiting');
  assert.equal(taskLane({ status: 'running', assignments: [{ state: 'claimed' }] }), 'running');
});

test('search keeps opaque ids and matches all words without mutating the durable rows', () => {
  const rows = [
    { id: 'Task:01/A', title: '汇总报告', target: '整理周报', mandate: { source: { channel: 'feishu', scheduleId: 'Cron@Exact' } } },
    { id: 'Task:02/B', target: '检查测试', taskMeta: { title: '测试失败追踪' } },
    { id: 'deleted', target: '汇总报告', taskMeta: { deleted: true } },
  ];
  const before = structuredClone(rows);
  assert.deepEqual(filterTasks(rows, '报告 FEISHU').map(row => row.id), ['Task:01/A']);
  assert.equal(filterTasks(rows, 'Cron@Exact')[0], rows[0]);
  assert.equal(filterTasks(rows, '失败')[0], rows[1]);
  assert.deepEqual(filterTasks(rows, '不存在'), []);
  assert.deepEqual(rows, before);
  const groups = groupTasks(rows);
  assert.equal(groups.reduce((sum, lane) => sum + lane.rows.length, 0), 2);
  assert.equal(groups.length, 3);
});
