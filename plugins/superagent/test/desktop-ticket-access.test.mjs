import test from 'node:test';
import assert from 'node:assert/strict';
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { createDesktopTicketAccess, conciseTicketSummary, TICKET_SUMMARY_MAX_CHARS } from '../src/desktop-ticket-access.mjs';

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
  assert.equal(access.query('owner', { status: 'waiting', projectId: 'a' }).tickets.length, 2);
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

test('routine AI query keeps one bounded paragraph and result pointers; full evidence is explicit', () => {
  const ticket = { id: 't', status: 'waiting', title: '任务', instructionRevision: 2, resultVersion: 1,
    mandate: { source: { channel: 'desktop', sessionId: 'owner' } },
    continuationWait: { reason: '服务不可用\n\n等待恢复', resumeConditions: '更新凭据后继续' },
    liveSummary: { goal: '要求'.repeat(1000), progress: '执行记录'.repeat(500) } };
  assert(Array.from(conciseTicketSummary(ticket)).length <= TICKET_SUMMARY_MAX_CHARS);
  assert(!conciseTicketSummary(ticket).includes('\n'));
  assert.match(conciseTicketSummary(ticket), /更新凭据后继续/);
  assert.match(conciseTicketSummary({ ...ticket, continuationWait: { code: 'EXECUTION_FAILED', reason: '原因'.repeat(500), resumeConditions: '更新凭据后继续' } }), /继续条件：更新凭据后继续；下一步：/);
  const access = createDesktopTicketAccess({ listTickets: () => [ticket] });
  const [row] = access.query('owner').tickets;
  assert.equal(typeof row.liveSummary, 'string');
  assert.deepEqual(row.result, { ticketId: 't', version: 1 });
  assert.equal('target' in row, false); assert.equal('results' in row, false);
  assert.match(conciseTicketSummary({ ...ticket, executionControl: { stopped: true } }), /已停止/);
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

test('tickets without projects cross the official lossless JSON tool-output boundary', t => {
  const database = createAssistantOrchestrationStore({ filename: ':memory:' });
  t.after(() => database.close());
  database.createThread({ id: 'desktop:owner', source: { type: 'desktop', id: 'owner' } });
  database.createTicket({ threadId: 'desktop:owner', target: '调查公开资料',
    mandate: { source: { channel: 'desktop', sessionId: 'owner' } } });
  const result = createDesktopTicketAccess(database).query('owner');
  assert.deepEqual(validateJsonSchemaValue({ type: 'object', additionalProperties: true }, result), []);
  assert.equal(result.tickets[0].project, null);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});
