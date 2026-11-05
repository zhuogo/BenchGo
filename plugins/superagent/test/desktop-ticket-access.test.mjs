import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { createDesktopTicketAccess } from '../src/desktop-ticket-access.mjs';

test('ticket queries respect session ownership, filter projects before limiting, and remain read only', t => {
  const database = createAssistantOrchestrationStore({ filename: ':memory:' });
  t.after(() => database.close());
  const access = createDesktopTicketAccess(database);
  const tickets = ['a', 'b', 'a'].map((projectId, index) => {
    const threadId = `thread-${index}`;
    database.ingest({ dedupeKey: threadId, thread: { id: threadId, source: { type: 'desktop', id: threadId } }, source: { channel: 'desktop', sessionId: threadId }, actor: { id: 'owner' }, content: 'task', mode: 'direct' });
    return database.createTicket({ threadId, target: `task-${index}`, mandate: { project: { id: projectId }, source: { channel: 'desktop', sessionId: index === 1 ? 'other' : 'owner' } } });
  });
  database.pauseTicket(tickets[0].id);
  const before = database.listTickets();
  const first = access.query('owner', { projectId: 'a', limit: 1 });
  const second = access.query('owner', { projectId: 'a', limit: 1, offset: first.nextOffset });
  assert.equal(first.nextOffset, 1);
  assert.equal(second.nextOffset, null);
  assert.deepEqual(new Set([...first.tickets, ...second.tickets].map(row => row.id)), new Set([tickets[0].id, tickets[2].id]));
  assert.deepEqual(access.query('owner', { status: 'paused', projectId: 'a' }).tickets.map(row => row.id), [tickets[0].id]);
  const detail = access.read(tickets[0].id, 'owner');
  assert.throws(() => access.read(tickets[1].id, 'owner'), /当前会话/);
  assert.equal(access.query('owner').tickets.length, 2);
  assert.equal(detail.target, 'task-0');
  for (const key of ['revisions', 'assignments', 'results', 'attentions', 'deliveries']) assert.ok(Array.isArray(detail[key]));
  assert.equal(access.read('missing', 'owner'), null);
  assert.throws(() => access.query('owner', { limit: 101 }), /limit/);
  assert.throws(() => access.query('owner', { offset: -1 }), /offset/);
  assert.deepEqual(database.listTickets(), before);
});

test('trusted logical owner scope includes old model sessions and filters side conversations before paging', t => {
  const database = createAssistantOrchestrationStore({ filename: ':memory:' }); t.after(() => database.close());
  database.createThread({ id: 'desktop:old', source: { type: 'desktop', id: 'old' } });
  const old = database.createTicket({ threadId: 'desktop:old', target: 'old', mandate: { source: { channel: 'desktop', sessionId: 'old' } } });
  const current = database.createTicket({ threadId: 'desktop:old', target: 'current', mandate: { source: { channel: 'desktop', sessionId: 'new', threadId: 'main' } } });
  const foreign = database.createTicket({ threadId: 'desktop:old', target: 'side', mandate: { source: { channel: 'desktop', sessionId: 'old', threadId: 'side' } } });
  const access = createDesktopTicketAccess(database), scope = { threadId: 'main', sessionIds: ['old', 'new'] };
  const first = access.query(scope, { limit: 1 }), second = access.query(scope, { limit: 1, offset: first.nextOffset });
  assert.deepEqual(new Set([...first.tickets, ...second.tickets].map(row => row.id)), new Set([old.id, current.id]));
  assert.equal(second.nextOffset, null); assert.equal(access.read(old.id, scope).id, old.id);
  assert.throws(() => access.read(foreign.id, scope), /当前会话/);
  assert.deepEqual(access.query({ threadId: 'main', sessionIds: [] }).tickets, []);
});
