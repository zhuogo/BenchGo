import test from 'node:test';
import assert from 'node:assert/strict';
import { ticketGoalRecord, assertGoalTicketBinding } from '../src/goal-ticket-record.mjs';

function fixture() {
  const ticket = { id: 'ticket', target: '修复', acceptance: '通过测试', status: 'completed', instructionRevision: 2, resultVersion: 3,
    mandate: { actorId: 'desktop-owner', admission: 'desktop-approved-delegation', source: { channel: 'desktop', sessionId: 'owner' }, project: { id: 'project' } } };
  const results = [{ ticketId: ticket.id, instructionRevision: 2, version: 3, outcome: 'completed', evidenceRefs: ['session:run'] }];
  const assignments = [{ instructionRevision: 2, model: { providerId: 'opaque/provider', modelId: 'model:v2' } }];
  const database = { getTicket: id => id === ticket.id ? ticket : null, results: () => results, assignments: () => assignments };
  const goal = { ownerSessionId: 'owner', projectId: 'project', text: '修复', acceptance: '通过测试', provider: 'opaque/provider', model: 'model:v2' };
  return { ticket, results, assignments, database, goal };
}

test('Goal observes only the latest current committed Ticket result', () => {
  const f = fixture();
  const row = ticketGoalRecord(f.database, 'ticket');
  assert.equal(row.result.outcome, 'completed');
  assert.deepEqual(row.result.evidenceRefs, ['session:run']);
  assert.equal(row.instructionRevision, 2);
  f.results.push({ ...f.results[0], version: 4, outcome: 'failed' });
  assert.equal(ticketGoalRecord(f.database, 'ticket').result, null);
  f.ticket.resultVersion = 4;
  assert.equal(ticketGoalRecord(f.database, 'ticket').result.outcome, 'failed');
  f.ticket.instructionRevision = 3;
  assert.equal(ticketGoalRecord(f.database, 'ticket').result, null);
  assert.equal(ticketGoalRecord(f.database, 'missing'), null);
});

test('Goal binding rejects foreign owner, different work, aliases and stale assignments', () => {
  const f = fixture();
  assert.equal(assertGoalTicketBinding(f.database, 'ticket', f.goal), f.ticket);
  for (const patch of [{ ownerSessionId: 'other' }, { projectId: 'other' }, { text: 'different' }, { acceptance: 'different' }, { provider: 'alias' }, { model: 'alias' }]) {
    assert.throws(() => assertGoalTicketBinding(f.database, 'ticket', { ...f.goal, ...patch }));
  }
  f.assignments[0].instructionRevision = 1;
  assert.throws(() => assertGoalTicketBinding(f.database, 'ticket', f.goal));
});
