import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { ingestAssistantEvent } from '../src/intake.mjs';

test('late Feishu requests still get assessment but cannot answer current attention or enter subscriptions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-late-message-'));
  let db = createAssistantOrchestrationStore({ directory });
  try {
    const policy = { version: 'v', allowHumanRequests: true, routeDirect: true };
    const event = { channel: 'feishu', kind: 'group', mentioned: true, actor: { kind: 'human', id: 'member' },
      source: { channel: 'feishu', appId: 'app', chatId: 'chat' }, text: 'hello' };
    ingestAssistantEvent(db, { ...event, sourceKey: 'new', threadId: 'new', occurredAt: '2026-11-03T15:31:00Z' }, policy);
    db.close(); db = createAssistantOrchestrationStore({ directory });
    const ticket = db.createTicket({ threadId: 'new', target: 'new work', mandate: {} });
    db.subscribe(ticket.id, 'new');
    db.answerAttention = () => assert.fail('historical message cannot answer current attention');
    const late = ingestAssistantEvent(db, { ...event, sourceKey: 'old', threadId: 'new', occurredAt: '2026-11-03T14:26:00Z' }, policy);
    assert.equal(late.gate.reason, 'allowed');
    assert.equal(late.requiresEval, true);
    assert.equal(db.pendingSubscriptionMessages(ticket.id).length, 0);
    assert.equal(db.getTrigger(late.trigger.id).content, 'hello');
    const candidate = { source: event.source, actor: event.actor, createdAt: '2026-11-03T14:26:00Z' };
    assert.equal(db.sourceMessageSuperseded(candidate), true);
    assert.equal(db.sourceMessageSuperseded({ ...candidate, createdAt: '2026-11-03T15:29:00Z' }), false);
    assert.equal(db.sourceMessageSuperseded({ ...candidate, actor: { kind: 'human', id: 'other' } }), false);
    assert.equal(db.sourceMessageSuperseded({ ...candidate, source: { ...event.source, appId: 'other' } }), false);
    assert.equal(db.sourceMessageSuperseded({ ...candidate, source: { ...event.source, chatId: 'other' } }), false);
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});

test('platform access accepts human requests without granting owner identity or opening unmentioned work', () => {
  const db = createAssistantOrchestrationStore({ filename: ':memory:' });
  try {
    const policy = { version: 'platform', ownerIds: [], allowHumanRequests: true, sourceAllowed: true, routeDirect: true };
    const event = { channel: 'feishu', sourceKey: 'platform-request', threadId: 'thread', source: { chatId: 'chat' }, actor: { kind: 'human', id: 'member' }, text: 'Help', kind: 'group', mentioned: true };
    const accepted = ingestAssistantEvent(db, event, policy);
    assert.equal(accepted.requiresEval, true);
    assert.deepEqual(db.getTrigger(accepted.trigger.id).actor, { id: 'member', kind: 'human' });
    assert.equal(ingestAssistantEvent(db, { ...event, sourceKey: 'discussion', mentioned: false }, policy).requiresEval, false);
    assert.equal(ingestAssistantEvent(db, { ...event, sourceKey: 'dm', kind: 'direct', mentioned: false }, policy).requiresEval, true);
    assert.equal(ingestAssistantEvent(db, { ...event, sourceKey: 'revoked' }, { ...policy, sourceAllowed: false }).gate.allowed, false);
    assert.equal(ingestAssistantEvent(db, { ...event, sourceKey: 'machine', actor: { id: 'bot', kind: 'machine' } }, policy).gate.allowed, false);
    assert.equal(ingestAssistantEvent(db, { ...event, sourceKey: 'other-channel', threadId: 'telegram-thread', channel: 'telegram' }, policy).gate.allowed, false);
  } finally { db.close(); }
});

test('explicit requests keep their own candidates with one or multiple running subscriptions', () => {
  const db = createAssistantOrchestrationStore({ filename: ':memory:' });
  try {
    const policy = { version: 'p', allowHumanRequests: true, routeDirect: true };
    const event = { channel: 'feishu', kind: 'group', mentioned: true, threadId: 'chat', source: { channel: 'feishu', chatId: 'chat' }, actor: { id: 'user', kind: 'human' }, text: 'Investigate another website' };
    ingestAssistantEvent(db, { ...event, sourceKey: 'first' }, policy);
    const first = db.createTicket({ threadId: 'chat', target: 'first website', mandate: {} });
    db.subscribe(first.id, 'chat');
    const second = ingestAssistantEvent(db, { ...event, sourceKey: 'second' }, policy);
    assert.equal(second.requiresEval, true);
    assert.equal(second.delivery, null);
    const another = db.createTicket({ threadId: 'chat', target: 'second website', mandate: {} });
    db.subscribe(another.id, 'chat');
    const third = ingestAssistantEvent(db, { ...event, kind: 'direct', sourceKey: 'third' }, policy);
    assert.equal(third.requiresEval, true);
    assert.equal(third.delivery, null);
    assert.equal(db.candidates().length, 3);
    assert.equal(db.pendingSubscriptionMessages(first.id).length, 0);
    assert.equal(db.pendingSubscriptionMessages(another.id).length, 0);
    assert.equal(ingestAssistantEvent(db, { ...event, sourceKey: 'second' }, policy).duplicate, true);
    assert.equal(db.candidates().length, 3);
  } finally { db.close(); }
});

test('received discussion is a bounded same-app same-chat reference without new candidates', () => {
  const db = createAssistantOrchestrationStore({ filename: ':memory:' });
  try {
    const policy = { version: 'v', allowHumanRequests: true, routeDirect: true };
    const source = { channel: 'feishu', appId: 'app', chatId: 'group', messageId: 'anchor' };
    const event = { channel: 'feishu', actor: { id: 'member', kind: 'human' }, kind: 'group', mentioned: false, text: 'Discussion' };
    for (let i = 0; i < 25; i++) ingestAssistantEvent(db, { ...event, sourceKey: `m${i}`, threadId: `thread${i}`, source: { ...source, messageId: `m${i}` } }, policy);
    ingestAssistantEvent(db, { ...event, sourceKey: 'outside', threadId: 'outside', source: { ...source, chatId: 'another', messageId: 'outside' } }, policy);
    ingestAssistantEvent(db, { ...event, sourceKey: 'anchor', threadId: 'anchor-thread', source, mentioned: true }, policy);
    ingestAssistantEvent(db, { ...event, sourceKey: 'later', threadId: 'later', source: { ...source, messageId: 'later' } }, policy);
    const rows = db.feishuContext(source);
    assert.equal(rows.length, 20);
    assert.equal(rows.at(-1).messageId, 'anchor');
    assert.equal(rows.some(row => ['outside', 'later'].includes(row.messageId)), false);
    assert.equal(db.candidates().length, 1);
    assert.deepEqual(db.feishuContext({ ...source, appId: 'other' }), []);
  } finally { db.close(); }
});

test('trusted policy controls direct intake and group mention; replay cannot create another candidate', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-intake-'));
  const db = createAssistantOrchestrationStore({ directory });
  try {
    const policy = { version: 'v1', ownerIds: ['owner'], actorIds: [], machineIds: [], threadIds: ['chat'] };
    const event = { channel: 'feishu', sourceKey: 'message-1', threadId: 'thread', source: { chatId: 'chat' }, actor: { kind: 'human', id: 'owner' }, text: '修复问题', kind: 'group', mentioned: false };
    const ignored = ingestAssistantEvent(db, event, policy);
    assert.equal(ignored.requiresEval, false);
    const mentioned = { ...event, sourceKey: 'message-2', mentioned: true };
    const candidate = ingestAssistantEvent(db, mentioned, policy);
    assert.equal(candidate.requiresEval, true);
    assert.equal(ingestAssistantEvent(db, mentioned, policy).duplicate, true);
    assert.equal(db.candidates().length, 1);
    const direct = ingestAssistantEvent(db, { ...event, sourceKey: 'message-3', kind: 'direct' }, policy);
    assert.equal(direct.direct, true); assert.equal(direct.requiresEval, false);
    const forged = ingestAssistantEvent(db, { ...event, sourceKey: 'message-4', actor: { kind: 'human', id: 'other', owner: true }, kind: 'direct' }, policy);
    assert.equal(forged.direct, false); assert.equal(forged.gate.allowed, false);
    assert.throws(() => ingestAssistantEvent(db, { ...mentioned, text: 'changed' }, policy), { code: 'TRIGGER_CONFLICT' });
    const ticket = db.createTicket({ threadId: 'thread', target: '修复问题', mandate: {} });
    db.subscribe(ticket.id, 'thread');
    assert.equal(ingestAssistantEvent(db, mentioned, policy).duplicate, true, 'original trigger replay after subscription is still acknowledged');
    const followup = { ...event, sourceKey: 'message-5', text: '补充资料' };
    assert.equal(ingestAssistantEvent(db, followup, policy).delivery.ticketId, ticket.id);
    assert.equal(ingestAssistantEvent(db, followup, policy).duplicate, true);
    assert.equal(db.pendingSubscriptionMessages(ticket.id).length, 1);
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});

test('machine allowlist is separate and mentions never promote machine authority', () => {
  const db = createAssistantOrchestrationStore({ filename: ':memory:' });
  try {
    const policy = { version: 'p', ownerIds: ['owner'], machineIds: ['ci'], threadIds: ['chat'] };
    const event = { channel: 'feishu', sourceKey: 'machine', threadId: 'thread', source: { chatId: 'chat' }, actor: { kind: 'machine', id: 'ci' }, text: 'report', kind: 'group', mentioned: true };
    assert.equal(ingestAssistantEvent(db, event, policy).gate.strength, 'inferred');
    assert.equal(ingestAssistantEvent(db, { ...event, sourceKey: 'unmentioned', mentioned: false }, policy).gate.strength, 'inferred');
    assert.equal(ingestAssistantEvent(db, { ...event, sourceKey: 'unlisted', actor: { kind: 'machine', id: 'other' } }, policy).gate.allowed, false);
    assert.equal(ingestAssistantEvent(db, { ...event, sourceKey: 'human', actor: { kind: 'human', id: 'ci' } }, policy).gate.allowed, false);
  } finally { db.close(); }
});

test('subscription catches context arriving during assessment without taking another candidate or denied thread input', () => {
  const db = createAssistantOrchestrationStore({ filename: ':memory:' });
  try {
    const policy = { version: 'p', ownerIds: ['owner'], threadIds: ['chat'] };
    const event = { channel: 'feishu', sourceKey: 'initial', threadId: 'thread', source: { chatId: 'chat' }, actor: { kind: 'human', id: 'owner' }, text: '修复问题', kind: 'group', mentioned: true };
    const initial = ingestAssistantEvent(db, event, policy);
    const lease = db.claimEval('thread', { owner: 'router', policyVersion: 'p' });
    const contextEvent = { ...event, sourceKey: 'context', mentioned: false, text: '相关日志' };
    const context = ingestAssistantEvent(db, contextEvent, policy);
    const separate = ingestAssistantEvent(db, { ...event, sourceKey: 'separate' }, policy);
    ingestAssistantEvent(db, { ...event, sourceKey: 'denied', mentioned: false }, { ...policy, threadIds: [] });
    const { ticket } = db.decide(initial.candidate.id, { evalId: lease.id, owner: 'router', policyVersion: 'p', outcome: 'accept', assessment: {}, ticket: { target: '修复问题', mandate: {} } });
    assert.deepEqual(db.pendingSubscriptionMessages(ticket.id).map(row => row.id), [context.trigger.id]);
    assert.equal(db.candidates({ status: 'queued' })[0].id, separate.candidate.id);
    assert.equal(db.getTicket(ticket.id).instructionRevision, 1);
    assert.equal(ingestAssistantEvent(db, contextEvent, policy).duplicate, true);
    assert.equal(db.pendingSubscriptionMessages(ticket.id).length, 1);
    const subscription = db.subscriptions({ ticketId: ticket.id })[0];
    assert.equal(subscription.cursorSeq, context.trigger.seq);
  } finally { db.close(); }
});

test('late subscription preserves ambiguous messages without guessing ownership', () => {
  const db = createAssistantOrchestrationStore({ filename: ':memory:' });
  try {
    const policy = { version: 'p', ownerIds: ['owner'], threadIds: ['chat'] };
    const event = { channel: 'feishu', sourceKey: 'initial', threadId: 'thread', source: { chatId: 'chat' }, actor: { kind: 'human', id: 'owner' }, text: '修复问题', kind: 'group', mentioned: false };
    const initial = ingestAssistantEvent(db, event, policy);
    const first = db.createTicket({ threadId: 'thread', target: 'one', mandate: {} });
    db.subscribe(first.id, 'thread');
    const late = ingestAssistantEvent(db, { ...event, sourceKey: 'late' }, policy);
    const second = db.createTicket({ threadId: 'thread', target: 'two', mandate: {} });
    db.subscribe(second.id, 'thread', { cursorTriggerId: initial.trigger.id });
    assert.equal(db.pendingSubscriptionMessages(second.id).length, 0);
    assert.equal(db.pendingSubscriptionMessages(first.id)[0].id, late.trigger.id);
    const ambiguous = ingestAssistantEvent(db, { ...event, sourceKey: 'ambiguous' }, policy);
    assert.equal(ambiguous.ambiguousSubscription, true);
    assert.equal(ambiguous.delivery, null);
    assert.equal(db.getTrigger(ambiguous.trigger.id).content, event.text);
  } finally { db.close(); }
});

test('a batch opening two tickets does not assign late context to whichever decision finishes first', () => {
  const db = createAssistantOrchestrationStore({ filename: ':memory:' });
  try {
    const policy = { version: 'p', ownerIds: ['owner'], threadIds: ['chat'] };
    const event = { channel: 'feishu', sourceKey: 'one', threadId: 'thread', source: { chatId: 'chat' }, actor: { kind: 'human', id: 'owner' }, text: '任务', kind: 'group', mentioned: true };
    const one = ingestAssistantEvent(db, event, policy);
    const two = ingestAssistantEvent(db, { ...event, sourceKey: 'two' }, policy);
    const lease = db.claimEval('thread', { owner: 'router', policyVersion: 'p' });
    const context = ingestAssistantEvent(db, { ...event, sourceKey: 'context', mentioned: false }, policy);
    const decide = candidate => db.decide(candidate.id, { evalId: lease.id, owner: 'router', policyVersion: 'p', outcome: 'accept', assessment: {}, ticket: { target: 'task', mandate: {} } });
    const first = decide(one.candidate).ticket;
    assert.equal(db.pendingSubscriptionMessages(first.id).length, 0);
    const second = decide(two.candidate).ticket;
    assert.equal(db.pendingSubscriptionMessages(first.id).length, 0);
    assert.equal(db.pendingSubscriptionMessages(second.id).length, 0);
    assert.ok(db.getTrigger(context.trigger.id));
    assert.equal(db.deliverSubscribedMessage(context.trigger.id, { ticketId: second.id }).ticketId, second.id);
  } finally { db.close(); }
});

test('finishing a batch reconciles earlier context even after live delivery advanced the cursor', () => {
  const db = createAssistantOrchestrationStore({ filename: ':memory:' });
  try {
    const policy = { version: 'p', ownerIds: ['owner'], threadIds: ['chat'] };
    const event = { channel: 'feishu', sourceKey: 'one', threadId: 'thread', source: { chatId: 'chat' }, actor: { kind: 'human', id: 'owner' }, text: '任务', kind: 'group', mentioned: true };
    const one = ingestAssistantEvent(db, event, policy);
    const two = ingestAssistantEvent(db, { ...event, sourceKey: 'two' }, policy);
    const lease = db.claimEval('thread', { owner: 'router', policyVersion: 'p' });
    const early = ingestAssistantEvent(db, { ...event, sourceKey: 'early', mentioned: false }, policy);
    const decision = { evalId: lease.id, owner: 'router', policyVersion: 'p', assessment: {} };
    const { ticket } = db.decide(one.candidate.id, { ...decision, outcome: 'accept', ticket: { target: 'task', mandate: {} } });
    const later = ingestAssistantEvent(db, { ...event, sourceKey: 'later', mentioned: false }, policy);
    db.decide(two.candidate.id, { ...decision, outcome: 'ignore' });
    assert.deepEqual(db.pendingSubscriptionMessages(ticket.id).map(row => row.id), [early.trigger.id, later.trigger.id]);
    assert.equal(db.subscriptions({ ticketId: ticket.id })[0].cursorSeq, later.trigger.seq);
  } finally { db.close(); }
});
