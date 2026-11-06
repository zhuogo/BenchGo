import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { createAssistantRuntimeStore } from '../src/runtime-store.mjs';
import { notificationPublication } from '../src/notification-publication.mjs';
import { deliverySuppression } from '../src/result-delivery.mjs';

function request(api, suffix = 'one') {
  const source = { channel: 'desktop', threadId: 'side', sessionId: 'owner', messageId: suffix };
  const { trigger } = api.ingest({ dedupeKey: suffix, thread: { source: { type: 'desktop', id: 'side' } }, source,
    actor: { kind: 'human', id: 'desktop-owner' }, content: 'Investigate website', mode: 'direct' });
  return { triggerId: trigger.id, requestKey: suffix, fingerprint: suffix, target: 'Investigate website',
    model: { providerId: 'provider', modelId: 'opaque' },
    mandate: { source, actorId: 'desktop-owner', instruction: 'Investigate website', policyVersion: 'version', admission: 'desktop-approved-delegation' } };
}

test('desktop acceptance stays durable and idempotent without a host-authored reply', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-ack-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const db = createAssistantOrchestrationStore({ directory });
  const input = request(db), ticket = db.acceptDesktop(input);
  assert.equal(db.acceptDesktop(input).id, ticket.id);
  assert.equal(db.deliveries(ticket.id).length, 0);
  assert.equal(db.assignments(ticket.id).length, 1);
  db.close();
  const restored = createAssistantOrchestrationStore({ directory });
  try {
    assert.equal(restored.acceptDesktop(input).id, ticket.id);
    assert.equal(restored.assignments(ticket.id).length, 1);
    assert.deepEqual(restored.pendingOutbox(), []);
  }
  finally { restored.close(); }
});

test('failed admission produces neither a Ticket nor an acknowledgement', t => {
  const db = createAssistantOrchestrationStore({ filename: ':memory:' }); t.after(() => db.close());
  assert.throws(() => db.acceptDesktop({ ...request(db), budgetGoalId: 'missing' }));
  assert.equal(db.listTickets().length, 0);
  assert.equal(db.pendingOutbox().length, 0);
});

function channelRequest(api, { suffix = 'one', kind = 'human', strength = 'explicit' } = {}) {
  const source = { channel: 'feishu', chatId: suffix, messageId: suffix };
  const { trigger } = api.ingest({ dedupeKey: suffix, thread: { id: suffix, source: { type: 'feishu', id: suffix } }, source,
    actor: { kind, id: 'owner' }, content: '查一下今天的新闻', gate: { allowed: true, strength }, policyVersion: 'p' });
  const lease = api.claimEval(trigger.threadId, { owner: 'router', policyVersion: 'p' });
  const candidate = api.candidates({ threadId: trigger.threadId })[0];
  return { candidate, trigger, input: { evalId: lease.id, owner: 'router', policyVersion: 'p', outcome: 'accept',
    assessment: { reason: 'Requested research', ruleIds: ['news'] }, mode: 'auto', enabledRuleIds: ['news'],
    ticket: { target: '查今天的新闻', mandate: { source, actorId: 'owner', policyVersion: 'p' } } } };
}

test('channel Router wording commits with the Ticket once and survives reopening', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-router-ack-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const db = createAssistantOrchestrationStore({ directory });
  const { candidate, trigger, input } = channelRequest(db);
  input.replyText = '我来查今天的消息，整理时会附上来源。';
  const { ticket } = db.decide(candidate.id, input);
  const [ack] = db.deliveries(ticket.id);
  assert.equal(ack.payload.origin, 'router');
  assert.equal(ack.payload.text, input.replyText);
  assert.equal(ack.payload.requestId, trigger.id);
  assert.deepEqual(ack.payload.source, trigger.source);
  assert.equal(deliverySuppression(db, ack), null);
  assert.throws(() => db.decide(candidate.id, input), /active evaluation/);
  assert.equal(db.deliveries(ticket.id).length, 1);
  db.close();
  const restored = createAssistantOrchestrationStore({ directory });
  try {
    assert.equal(restored.getTicket(ticket.id).id, ticket.id);
    assert.deepEqual(restored.pendingOutbox()[0].payload, ack.payload);
  } finally { restored.close(); }
});

test('missing Router text has no canned fallback, invalid text rolls back admission', t => {
  const db = createAssistantOrchestrationStore({ filename: ':memory:' }); t.after(() => db.close());
  const missing = channelRequest(db, { suffix: 'missing' });
  const { ticket } = db.decide(missing.candidate.id, missing.input);
  assert.deepEqual(db.deliveries(ticket.id), []);
  const invalid = channelRequest(db, { suffix: 'invalid' });
  for (const replyText of ['', ' ', 123, null, 'x'.repeat(6001)]) {
    assert.throws(() => db.decide(invalid.candidate.id, { ...invalid.input, replyText }), /接单回复/);
    assert.equal(db.listTickets().length, 1);
    assert.deepEqual(db.pendingOutbox(), []);
  }
  const accepted = db.decide(invalid.candidate.id, { ...invalid.input, replyText: '我会按刚才说的范围查。' });
  assert.equal(db.deliveries(accepted.ticket.id)[0].payload.text, '我会按刚才说的范围查。');
});

test('inferred or machine intake does not announce a human acceptance', t => {
  const db = createAssistantOrchestrationStore({ filename: ':memory:' }); t.after(() => db.close());
  for (const [kind, strength] of [['human', 'inferred'], ['machine', 'explicit']]) {
    const { candidate, input } = channelRequest(db, { suffix: kind, kind, strength });
    const { ticket } = db.decide(candidate.id, { ...input, replyText: 'Not a human-directed reply' });
    assert.deepEqual(db.deliveries(ticket.id), []);
  }
});

test('acknowledgement cannot follow a completed, cancelled or already reviewed result', () => {
  const source = { channel: 'feishu', chatId: 'original' };
  const ticket = { id: 'ticket', status: 'open', resultVersion: 0, mandate: { source } };
  const row = { ticketId: 'ticket', payload: { type: 'ticket.accepted', origin: 'router', ticketId: 'ticket', requestId: 'request', text: '我来查一下。', source } };
  const db = { getTicket: () => ticket };
  assert.equal(deliverySuppression(db, row), null);
  ticket.resultVersion = 1;
  assert.equal(deliverySuppression(db, row), 'ack-superseded');
  ticket.resultVersion = 0;
  for (const status of ['completed', 'failed', 'cancelled', 'cancelling', 'paused']) {
    ticket.status = status; assert.equal(deliverySuppression(db, row), 'ack-superseded');
  }
  ticket.status = 'open'; row.payload.source = { channel: 'feishu', chatId: 'wrong' };
  assert.equal(deliverySuppression(db, row), 'source-mismatch');
});

test('legacy host acknowledgements are suppressed instead of replayed', () => {
  const payload = { type: 'ticket.accepted', ticketId: 'ticket', requestId: 'request', text: 'legacy host text' };
  assert.equal(deliverySuppression({}, { ticketId: 'ticket', payload }), 'legacy-or-invalid-ack');
  assert.equal(notificationPublication(payload), null);
});

test('notification history preserves Router wording and provenance across projections', t => {
  const db = createAssistantRuntimeStore({ filename: ':memory:' }); t.after(() => db.close());
  const payload = { type: 'ticket.accepted', origin: 'router', ticketId: 'ticket', requestId: 'request', text: '我来整理你提到的三家供应商，重点看费用。' };
  const a = db.notify({ id: 'ticket', threadId: 'side' }, payload.type, payload, 'ack-ticket');
  const b = db.notify({ id: 'ticket', threadId: 'side' }, payload.type, payload, 'ack-ticket');
  assert.equal(a.id, b.id);
  assert.equal(a.threadId, 'side');
  assert.equal(a.ticketId, 'ticket');
  assert.equal(a.requestId, 'request');
  assert.equal(a.text, payload.text);
  assert.equal(db.notifications({ threadId: 'side' }).events[0].text, payload.text);
  assert.equal(notificationPublication(a).origin, 'router');
  assert.equal(notificationPublication({ ...payload, origin: undefined }), null);
  assert.equal(notificationPublication({ ...payload, text: 'x'.repeat(6001) }), null);
});
