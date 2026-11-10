import test from 'node:test';
import assert from 'node:assert/strict';
import { filterTickets, groupTickets, ticketLane } from '../client/ticket-board.mjs';

test('board uses only the three persisted Ticket states', () => {
  for (const status of ['running', 'waiting', 'completed']) assert.equal(ticketLane({ status }), status);
  assert.equal(ticketLane({ status: 'waiting', taskMeta: { completed: true } }), 'waiting');
  assert.equal(ticketLane({ status: 'waiting', executionControl: { stopped: true } }), 'waiting');
  assert.equal(ticketLane({ status: 'running', assignments: [{ state: 'claimed' }] }), 'running');
});

test('search keeps opaque ids and matches all words without mutating the durable rows', () => {
  const rows = [
    { id: 'Task:01/A', title: '汇总报告', target: '整理周报', mandate: { source: { channel: 'feishu', scheduleId: 'Cron@Exact' } } },
    { id: 'Task:02/B', target: '检查测试', taskMeta: { title: '测试失败追踪' } },
    { id: 'deleted', target: '汇总报告', taskMeta: { deleted: true } },
  ];
  const before = structuredClone(rows);
  assert.deepEqual(filterTickets(rows, '报告 FEISHU').map(row => row.id), ['Task:01/A']);
  assert.equal(filterTickets(rows, 'Cron@Exact')[0], rows[0]);
  assert.equal(filterTickets(rows, '失败')[0], rows[1]);
  assert.deepEqual(filterTickets(rows, '不存在'), []);
  assert.deepEqual(rows, before);
  const groups = groupTickets(rows);
  assert.equal(groups.reduce((sum, lane) => sum + lane.rows.length, 0), 2);
  assert.equal(groups.length, 3);
});
