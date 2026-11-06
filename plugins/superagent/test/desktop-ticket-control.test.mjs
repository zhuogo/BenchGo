import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { createDesktopTicketControl } from '../src/desktop-ticket-control.mjs';
import { recordDesktopTrigger } from '../src/desktop-trigger.mjs';

function fixture(t) {
  const database = createAssistantOrchestrationStore({ filename: ':memory:' });
  t.after(() => database.close());
  const events = [{ type: 'turn/start' }, { type: 'user/message', data: { id: 'followup', source: { kind: 'user' }, content: [{ type: 'text', text: '补充：请附上原文链接' }] } }];
  const ownerAgent = { id: 'owner', status: 'running', session: { header: {}, snapshotEvents: () => events } };
  const ctx = { agents: { get: () => ownerAgent, currentInitiator: () => ownerAgent, turnBoundaryOf: () => ({ openTurnStartSeq: 0 }) } };
  const initial = recordDesktopTrigger(database, { sessionId: 'owner', message: { id: 'initial', source: { kind: 'user' }, content: [{ type: 'text', text: '调查网站' }] } }).trigger;
  function ticket(source = { channel: 'desktop', sessionId: 'owner', threadId: 'main' }) {
    const row = database.createTicket({ threadId: initial.threadId, target: '调查网站', mandate: { source, actorId: 'desktop-owner' } });
    database.subscribe(row.id, initial.threadId, { cursorTriggerId: initial.id });
    return row;
  }
  const service = createDesktopTicketControl({ ctx, database });
  return { database, events, ctx, ownerAgent, ticket, control: (id, operation = 'supplement', options = {}) => service.control({ id, operation }, { agent: ownerAgent }, { ownerAgent, ...options }) };
}

test('supplement selects one ticket, retains original text and mandate, and deduplicates', t => {
  const f = fixture(t), a = f.ticket(), b = f.ticket();
  const result = f.control(a.id);
  assert.equal(result.ticketId, a.id);
  assert.equal(f.control(a.id).duplicate, true);
  assert.equal(f.database.pendingSubscriptionMessages(a.id).length, 1);
  assert.equal(f.database.pendingSubscriptionMessages(a.id)[0].content, '补充：请附上原文链接');
  assert.equal(f.database.pendingSubscriptionMessages(b.id).length, 0);
  assert.deepEqual(f.database.getTicket(a.id).mandate, a.mandate);
  assert.throws(() => f.control(b.id), /already belongs/);
});

test('after model session clear a trusted logical owner can supplement the old ticket without changing its mandate', t => {
  const f = fixture(t), ticket = f.ticket(); f.ownerAgent.id = 'replacement';
  const result = f.control(ticket.id, 'supplement', { ownerScope: { threadId: 'main', sessionIds: ['owner', 'replacement'] } });
  assert.equal(result.ticketId, ticket.id);
  assert.equal(f.database.pendingSubscriptionMessages(ticket.id)[0].source.sessionId, 'replacement');
  assert.deepEqual(f.database.getTicket(ticket.id).mandate, ticket.mandate);
  assert.equal(f.database.getTicket(ticket.id).threadId, 'desktop:owner');
});

test('a chat Attention answer uses the exact current human text on the original ticket, including after clear', t => {
  const f = fixture(t), ticket = f.ticket();
  f.database.createAssignment(ticket.id, {});
  const [assignment] = f.database.claimAssignments('worker', { validateMandate: () => true });
  const ownership = { owner: assignment.owner, fence: assignment.fence };
  const run = f.database.prepareRun(assignment.id, { ...ownership, sessionId: 'worker-session', directory: process.cwd() });
  f.database.updateRun(run.id, { ...ownership, state: 'submitted' });
  const [attention] = f.database.openAttention(assignment.id, { ...ownership, sessionId: run.sessionId, callId: 'ask', questions: [{ id: 'timezone', question: '采用什么时区？' }] });
  const service = createDesktopTicketControl({ ctx: f.ctx, database: f.database });
  const request = { id: ticket.id, operation: 'answer', attentionId: attention.id };
  f.ownerAgent.id = 'replacement'; f.events[1].data.content[0].text = '  使用北京时间\n保留原文  ';
  const options = { ownerAgent: f.ownerAgent, ownerScope: { threadId: 'main', sessionIds: ['owner', 'replacement'] } };
  assert.throws(() => service.control({ ...request, attentionId: undefined }, { agent: f.ownerAgent }, options), /明确选择/);
  assert.throws(() => service.control(request, { agent: f.ownerAgent }, { ...options, threadId: 'side' }), /当前会话/);
  const result = service.control(request, { agent: f.ownerAgent }, options);
  const answer = f.database.getTrigger(result.attention.answerTriggerId);
  assert.equal(answer.content, '  使用北京时间\n保留原文  ');
  assert.deepEqual(answer.source.answer, { selected: [], custom: answer.content });
  assert.equal(result.ticketId, ticket.id); assert.equal(f.database.getTicket(ticket.id).instructionRevision, 1);
  assert.equal(service.control(request, { agent: f.ownerAgent }, options).attention.duplicate, true);
});

test('a supplement cannot implicitly answer an Attention even when it contains an attention id', t => {
  const f = fixture(t), ticket = f.ticket(); let answers = 0;
  const actual = f.database.answerDesktopAttention; f.database.answerDesktopAttention = () => { answers++; };
  const service = createDesktopTicketControl({ ctx: f.ctx, database: f.database });
  service.control({ id: ticket.id, operation: 'supplement', attentionId: 'question' }, { agent: f.ownerAgent }, { ownerAgent: f.ownerAgent });
  assert.equal(answers, 0); f.database.answerDesktopAttention = actual;
});

test('control rejects different sessions, channels and threads', t => {
  const f = fixture(t);
  for (const source of [{ channel: 'feishu', sessionId: 'owner' }, { channel: 'desktop', sessionId: 'another' }, { channel: 'desktop', sessionId: 'owner', threadId: 'side' }]) {
    const ticket = f.ticket(source);
    assert.throws(() => f.control(ticket.id, 'cancel'), /不属于当前会话/);
    assert.notEqual(f.database.getTicket(ticket.id).status, 'cancelled');
  }
});

test('internal notifications and non-root callers cannot control tickets', t => {
  const f = fixture(t), ticket = f.ticket();
  f.events[1].data.source.kind = 'benchgo-subscription';
  assert.throws(() => f.control(ticket.id), /原始用户/);
  f.events[1].data.source.kind = 'user';
  f.ownerAgent.session.header.origin = 'subagent';
  assert.throws(() => f.control(ticket.id, 'cancel'), /原始用户/);
});

test('cancellation is idempotent and stopped tickets cannot receive supplements', t => {
  const f = fixture(t), ticket = f.ticket();
  assert.equal(f.control(ticket.id, 'cancel').ticket.status, 'cancelled');
  assert.equal(f.control(ticket.id, 'cancel').ticket.status, 'cancelled');
  assert.throws(() => f.control(ticket.id), /已停止/);
});
