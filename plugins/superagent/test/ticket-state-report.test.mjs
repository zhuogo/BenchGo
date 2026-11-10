import test from 'node:test';
import assert from 'node:assert/strict';
import { isTicketStateNotice, ticketStateSignal } from '../src/ticket-state-report.mjs';

function fixture(state = 'continuation_wait') {
  const ticket = { id: 'ticket', title: '整理资料', status: 'running', instructionRevision: 2, resultVersion: 3, result: 'PRIVATE WORKER BODY' };
  const assignment = { id: 'assignment', fence: 4, state: 'uncertain', lastFailure: { code: 'WORKER_TURN_INCOMPLETE', stage: 'execution', message: 'PRIVATE ERROR STACK' }, result: 'PRIVATE WORKER RESULT' };
  const delivery = { uniqueKey: 'notice:1', ticketId: ticket.id, payload: { type: 'ticket.result', source: { channel: 'desktop' },
    assignmentId: assignment.id, fence: assignment.fence, instructionRevision: 2, resultVersion: 3,
    result: { summary: 'PRIVATE RESULT SUMMARY', body: 'PRIVATE RESULT BODY' },
    publication: { origin: 'system', text: 'PRIVATE PUBLICATION BODY', systemState: { state, code: assignment.lastFailure.code, stage: assignment.lastFailure.stage, error: 'PRIVATE FAILURE' } } } };
  const database = { getTicket: id => id === ticket.id ? ticket : null, assignments: () => [assignment], deliveries: () => [delivery] };
  return { database, ticket, assignment, delivery };
}

test('Router receives only ledger facts, never Worker bodies, publication text or raw failures', () => {
  const { database, delivery } = fixture();
  const signal = ticketStateSignal(database, delivery);
  assert.deepEqual(signal, { eventKey: 'notice:1', ticketId: 'ticket', title: '整理资料', status: 'running',
    instructionRevision: 2, resultVersion: 3, state: 'continuation_wait', code: 'WORKER_TURN_INCOMPLETE', stage: 'execution', assignmentId: 'assignment', fence: 4 });
  assert.doesNotMatch(JSON.stringify(signal), /PRIVATE/);
});

test('only system waiting notices from the current Ticket can become signals', async t => {
  const changes = {
    'Worker publication': f => { f.delivery.payload.publication.origin = 'worker'; },
    'ordinary result': f => { f.delivery.payload.publication.systemState.state = 'completed'; },
    'foreign payload type': f => { f.delivery.payload.type = 'ticket.progress'; },
    'missing Ticket': f => { f.delivery.ticketId = 'missing'; },
    'old instruction': f => { f.ticket.instructionRevision++; },
    'old result': f => { f.ticket.resultVersion++; },
    'paused Ticket': f => { f.ticket.executionControl = { paused: true }; },
    'finished Ticket': f => { f.ticket.status = 'completed'; },
    'cancelled Ticket': f => { f.ticket.executionControl = { stopped: true }; },
  };
  for (const [name, change] of Object.entries(changes)) await t.test(name, () => {
    const f = fixture(); change(f);
    assert.equal(ticketStateSignal(f.database, f.delivery), null);
  });
  assert.equal(isTicketStateNotice(null), false);
  assert.equal(isTicketStateNotice(fixture('delivery_wait').delivery.payload), true);
});

test('continuation notices stop being current after recovery, reassignment or failure replacement', async t => {
  const changes = {
    recovery: f => { f.assignment.state = 'running'; },
    'reclaimed fence': f => { f.assignment.fence++; },
    'another Assignment': f => { f.assignment.id = 'replacement'; },
    'different failure code': f => { f.assignment.lastFailure.code = 'MODEL_UNAVAILABLE'; },
    'different failure stage': f => { f.assignment.lastFailure.stage = 'delivery'; },
  };
  for (const [name, change] of Object.entries(changes)) await t.test(name, () => {
    const f = fixture();
    change(f);
    assert.equal(ticketStateSignal(f.database, f.delivery), null);
  });
});

test('delivery waiting can report current Ticket facts without claiming a Worker failure', () => {
  const f = fixture('delivery_wait');
  f.assignment.state = 'completed';
  const signal = ticketStateSignal(f.database, f.delivery);
  assert.equal(signal.state, 'delivery_wait');
  assert.equal('assignmentId' in signal, false);
  assert.equal('fence' in signal, false);
  assert.doesNotMatch(JSON.stringify(signal), /PRIVATE/);
  f.ticket.status = 'completed';
  assert.equal(ticketStateSignal(f.database, f.delivery), null);
});
