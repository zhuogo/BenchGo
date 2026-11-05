import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-direct-reply-'));
  const db = createAssistantOrchestrationStore({ directory });
  t.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  const source = { channel: 'feishu', chatId: 'original-chat', messageId: 'original-message' };
  const actor = { id: 'human', kind: 'human' }, gate = { allowed: true, strength: 'explicit' };
  const { candidate } = db.ingest({ dedupeKey: 'message', thread: { id: 'thread', source: { type: 'feishu', id: 'original-chat' } }, source, actor, gate, content: 'hello', policyVersion: 'p1' });
  const evaluation = db.claimEval('thread', { owner: 'router', policyVersion: 'p1', now: 0 });
  const input = { evalId: evaluation.id, owner: 'router', outcome: 'answer', assessment: {}, policyVersion: 'p1', now: 1,
    reply: { text: 'Hello!', source, actor, gate, policyVersion: 'p1' } };
  return { db, candidate, input };
}

test('direct reply commits atomically without a ticket and cannot duplicate its candidate', async t => {
  const { db, candidate, input } = await setup(t);
  const result = db.decide(candidate.id, input);
  assert.equal(result.ticket, null);
  assert.equal(result.decision.ticketId, null);
  assert.equal(result.decision.outcome, 'answer');
  assert.equal(db.directReplies()[0].triggerId, candidate.triggerId);
  assert.throws(() => db.decide(candidate.id, input), { code: 'CANDIDATE_NOT_ACTIVE' });
  assert.equal(db.directReplies().length, 1);
  const [claimed] = db.claimDirectReplies({ owner: 'sender', now: 2 });
  assert.equal(claimed.attempts, 1);
  assert.deepEqual(db.claimDirectReplies({ owner: 'other', now: 3 }), []);
  assert.throws(() => db.finishDirectReply(claimed.id, { owner: 'other', sent: true, now: 3 }), { code: 'DIRECT_REPLY_LEASE_CONFLICT' });
  const delivered = db.finishDirectReply(claimed.id, { owner: 'sender', sent: true, receipt: { messageId: 'delivered' }, now: 3 });
  assert.equal(delivered.state, 'sent');
  assert.deepEqual(delivered.receipt, { messageId: 'delivered' });
});

test('invalid reply rolls back decision; source, policy and lease remain bound', async t => {
  const { db, candidate, input } = await setup(t);
  for (const reply of [ { ...input.reply, text: '' }, { ...input.reply, text: 'a'.repeat(12001) },
    { ...input.reply, source: { chatId: 'other' } }, { ...input.reply, actor: { id: 'other' } },
    { ...input.reply, gate: {} }, { ...input.reply, policyVersion: 'p2' }, { ...input.reply, source: { ...input.reply.source, invalid: undefined } } ]) {
    assert.throws(() => db.decide(candidate.id, { ...input, reply }));
    assert.equal(db.directReplies().length, 0);
  }
  assert.throws(() => db.decide(candidate.id, { ...input, policyVersion: 'p2' }), { code: 'POLICY_STALE' });
  assert.throws(() => db.decide(candidate.id, { ...input, owner: 'other' }), { code: 'EVAL_FENCING_CONFLICT' });
  db.decide(candidate.id, { ...input, outcome: 'ask' });
  assert.equal(db.directReplies()[0].kind, 'ask');
});

test('queued reply survives reopen; crashed delivery is uncertain and never automatically resent', async t => {
  const { db, candidate, input } = await setup(t);
  db.decide(candidate.id, input);
  const reopened = createAssistantOrchestrationStore({ filename: db.path });
  try {
    const [reply] = reopened.claimDirectReplies({ owner: 'sender', now: 2, leaseMs: 10 });
    assert.equal(reply.state, 'claimed');
    assert.deepEqual(db.claimDirectReplies({ owner: 'replacement', now: 12 }), []);
    assert.equal(reopened.directReplies()[0].state, 'uncertain');
    assert.throws(() => reopened.finishDirectReply(reply.id, { owner: 'sender', sent: true, now: 12 }), { code: 'DIRECT_REPLY_LEASE_CONFLICT' });
  } finally { reopened.close(); }
});

test('known unsent failure retries at next time; suppressed reply stops permanently', async t => {
  const { db, candidate, input } = await setup(t);
  db.decide(candidate.id, input);
  const [reply] = db.claimDirectReplies({ owner: 'sender', now: 2 });
  assert.throws(() => db.finishDirectReply(reply.id, { owner: 'sender', sent: true, suppressed: true, now: 3 }));
  assert.throws(() => db.finishDirectReply(reply.id, { owner: 'sender', sent: true, receipt: [], now: 3 }));
  db.finishDirectReply(reply.id, { owner: 'sender', error: 'not-sent', retryMs: 10, now: 3 });
  assert.deepEqual(db.claimDirectReplies({ owner: 'sender', now: 12 }), []);
  assert.equal(db.claimDirectReplies({ owner: 'sender', now: 13 })[0].attempts, 2);
  db.finishDirectReply(reply.id, { owner: 'sender', suppressed: true, error: 'policy-changed', now: 14 });
  assert.equal(db.directReplies()[0].state, 'suppressed');
  assert.deepEqual(db.claimDirectReplies({ owner: 'sender', now: 100000 }), []);
});
