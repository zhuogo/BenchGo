import test from 'node:test';
import assert from 'node:assert/strict';
import { filterTickets, groupTickets, ticketLane } from '../client/ticket-board.mjs';

test('board projects current execution and wait fences instead of display completion', () => {
  assert.equal(ticketLane({ status: 'open', taskMeta: { completed: true } }), 'queued');
  assert.equal(ticketLane({ status: 'open', instructionRevision: 2, assignments: [{ instructionRevision: 1, state: 'claimed' }, { instructionRevision: 2, state: 'queued' }] }), 'queued');
  assert.equal(ticketLane({ status: 'open', assignments: [{ state: 'claimed' }] }), 'running');
  assert.equal(ticketLane({ status: 'waiting', attentions: [{ state: 'waiting', instructionRevision: 1 }] }), 'attention');
  assert.equal(ticketLane({ status: 'waiting', resultVersion: 3, continuationWait: { sourceResultVersion: 3, code: 'EXECUTION_EFFECTS_UNKNOWN' } }), 'attention');
  assert.equal(ticketLane({ status: 'waiting', results: [{ review: { verdict: 'wait' } }] }), 'running');
  for (const status of ['completed', 'failed', 'cancelled', 'closed']) assert.equal(ticketLane({ status }), 'finished');
  for (const status of ['paused', 'uncertain', 'blocked', 'future-state']) assert.equal(ticketLane({ status }), 'attention');
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
  assert.equal(groups.length, 4);
});
