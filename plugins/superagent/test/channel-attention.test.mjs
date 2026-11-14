import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { ingestAssistantEvent } from '../src/intake.mjs';
import { attentionReplyText } from '../src/attention-store.mjs';

async function fixture(t, channel) {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-channel-attention-'));
  let db = createAssistantOrchestrationStore({ directory });
  t.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  db.createThread({ id: 'origin', source: { type: channel, id: 'origin' } });
  const source = { channel, sourceType: 'topic', connectionId: channel, conversationId: 'chat', accountId: 'account', connectionRevision: 3, chatId: 'chat', messageId: 'original', topicId: 'topic' };
  const entries = [];
  for (let index = 0; index < 2; index++) {
    const task = db.createTask({ threadId: 'origin', target: `work-${index}`, mandate: { actorId: 'owner', source } });
    db.createAssignment(task.id, {});
    const assignment = db.claimAssignments('worker', { validateMandate: () => true })[0];
    const ownership = { owner: assignment.owner, fence: assignment.fence }, sessionId = `session-${index}`;
    const run = db.prepareRun(assignment.id, { ...ownership, sessionId, directory });
    db.updateRun(run.id, { ...ownership, state: 'submitted' });
    const [attention] = db.openAttention(assignment.id, { ...ownership, sessionId, callId: `call-${index}`, questions: [{ id: 'opaque-question', question: '选择？', options: [{ label: '继续' }] }] });
    entries.push({ task, attention, assignment, run, ownership });
  }
  const policy = { version: 'p1', ownerIds: ['owner', 'other-owner'], threadIds: ['chat', 'other-chat'] };
  let sequence = 0;
  const receive = (patch = {}) => ingestAssistantEvent(db, { sourceKey: `reply:${++sequence}`, channel, threadId: 'reply-thread', source: { ...source, messageId: 'reply' }, actor: { id: 'owner', kind: 'human' }, kind: 'topic', mentioned: true, text: '继续', ...patch }, policy);
  return { get db() { return db; }, source, entries, receive, restart() { db.close(); db = createAssistantOrchestrationStore({ directory }); } };
}

for (const channel of ['telegram', 'discord', 'whatsapp', 'weixin']) test(`${channel} answers the exact numbered question after restart and rejects foreign sources`, async t => {
  const h = await fixture(t, channel), [first, second] = h.entries;
  h.restart();
  const text = `/answer ${second.attention.id} 继续`;
  for (const patch of [
    { actor: { id: 'other-owner', kind: 'human' } }, { actor: { id: 'owner', kind: 'machine' } },
    ...[{ channel: 'foreign' }, { accountId: 'other' }, { connectionRevision: 4 }, { chatId: 'other-chat', conversationId: 'other-chat' }, { topicId: 'other' }]
      .map(source => ({ source: { ...h.source, ...source, messageId: 'reply' } })),
  ]) assert.equal(h.receive({ text, ...patch }).attention, undefined);
  const answer = h.receive({ text });
  assert.equal(answer.attention.id, second.attention.id);
  assert.equal(answer.requiresEval, false);
  assert.equal(h.db.attentions(first.task.id)[0].state, 'waiting');
  assert.equal(h.db.attentions(second.task.id)[0].answerTriggerId, answer.trigger.id);
  assert.equal(attentionReplyText(second.attention.id, h.db.getTrigger(answer.trigger.id).content), '继续');
  assert.equal(h.db.getTask(second.task.id).instructionRevision, 1);
});

test('reply to any confirmed message part resolves its original question without selecting the latest task', async t => {
  const h = await fixture(t, 'telegram'), [first, second] = h.entries;
  const outboxes = h.db.claimOutbox('sender');
  for (const row of outboxes) h.db.finishOutbox(row.id, { owner: 'sender', sent: true, receipt: row.payload.attentionId === first.attention.id
    ? { messageId: 'chat:last', parts: [{ messageId: 'chat:first' }, { messageId: 'chat:last' }] }
    : { messageId: 'chat:other' } });
  h.restart();
  const accepted = h.receive({ source: { ...h.source, messageId: 'reply', parentMessageId: 'chat:first' } });
  assert.equal(accepted.attention.id, first.attention.id);
  assert.equal(h.db.attentions(second.task.id)[0].state, 'waiting');
});

test('old Telegram integer receipts match only the exact originating account and chat', async t => {
  const h = await fixture(t, 'telegram'), [first] = h.entries;
  for (const row of h.db.claimOutbox('sender')) h.db.finishOutbox(row.id, { owner: 'sender', sent: true, receipt: { messageId: row.payload.attentionId === first.attention.id ? '42' : '43' } });
  const accepted = h.receive({ source: { ...h.source, messageId: 'reply', parentMessageId: 'chat:42' } });
  assert.equal(accepted.attention.id, first.attention.id);
});

test('numbered answers cannot revive a question after its new requirements apply or a terminal task', async t => {
  const h = await fixture(t, 'weixin'), [first, second] = h.entries;
  h.db.updateTask(first.task.id, { target: 'changed' }, { expectedInstructionRevision: 1 });
  h.db.applyTaskRevision(first.assignment.id, { ...first.ownership, runId: first.run.id, boundaryId: 'next-tool-batch' });
  h.db.cancelTask(second.task.id);
  for (const entry of [first, second]) assert.equal(h.receive({ text: `/answer ${entry.attention.id} 继续` }).attention, undefined);
});
