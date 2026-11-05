import test from 'node:test';
import assert from 'node:assert/strict';
import { replyNotificationOption } from '../src/notification-option.mjs';

function fixture() {
  const event = { eventId: 'event', taskId: 'ticket', threadId: 'side', instructionRevision: 2, resultVersion: 3, text: '这份结果要放进哪个位置？', options: ['放进仓库', '先不放'] };
  const ticket = { mandate: { source: { threadId: 'side' } }, instructionRevision: 2, resultVersion: 3, status: 'completed' };
  const sent = [];
  const dependencies = { database: { notifications: () => ({ events: [event], hasMore: false }) }, orchestration: { getTicket: id => id === 'ticket' ? ticket : null }, engine: { send: async input => { sent.push(input); return { ...input, messageId: 'message' }; } } };
  return { event, ticket, sent, dependencies, input: { eventId: 'event', threadId: 'side', text: '放进仓库' } };
}
test('option sends original intent with a stable one-event idempotency key', async () => {
  const f = fixture(); await replyNotificationOption(f.dependencies, f.input);
  await replyNotificationOption(f.dependencies, f.input);
  assert.deepEqual(f.sent, Array(2).fill({ threadId: 'side', text: '放进仓库', requestId: 'notification-option:event',
    replyContext: { eventId: 'event', ticketId: 'ticket', instructionRevision: 2, resultVersion: 3, question: f.event.text } }));
  assert.equal(f.sent[0].approval, undefined);
});
test('cross-thread, fabricated and stale choices never reach send', async () => {
  for (const change of [f => f.input.threadId = 'main', f => f.input.text = '花钱', f => f.ticket.instructionRevision++, f => f.ticket.resultVersion++, f => f.ticket.status = 'cancelled', f => f.ticket.mandate.source.threadId = 'other', f => { delete f.event.instructionRevision; delete f.ticket.instructionRevision; }, f => { delete f.event.resultVersion; delete f.ticket.resultVersion; }]) {
    const f = fixture(); change(f);
    await assert.rejects(replyNotificationOption(f.dependencies, f.input));
    assert.equal(f.sent.length, 0);
  }
});

test('legacy desktop source without a thread retains its main-chat ownership', async () => {
  const f = fixture();
  f.input.threadId = 'main'; f.event.threadId = 'main'; delete f.ticket.mandate.source.threadId;
  await replyNotificationOption(f.dependencies, f.input);
  assert.equal(f.sent[0].threadId, 'main');
  assert.equal(f.sent[0].replyContext.ticketId, 'ticket');
});
test('option lookup follows durable global cursor past filtered pages', async () => {
  const f = fixture(), cursors = [];
  f.dependencies.database.notifications = ({ after }) => { cursors.push(after); return after === 0 ? { events: [], cursor: 500, hasMore: true } : { events: [f.event], cursor: 501, hasMore: false }; };
  await replyNotificationOption(f.dependencies, f.input);
  assert.deepEqual(cursors, [0, 500]);
});

test('Attention choice answers its exact saved question rather than dispatching a bare option', async () => {
  const f = fixture(), replies = [];
  f.event.attentionId = 'attention'; f.ticket.status = 'waiting';
  f.dependencies.orchestration.attentions = ticketId => ticketId === 'ticket' ? [
    { id: 'other-attention', resultVersion: 3, question: { options: [{ label: '放进仓库' }] } },
    { id: 'attention', resultVersion: 3, question: { options: [{ label: '放进仓库' }] } },
  ] : [];
  f.dependencies.orchestration.answerDesktopAttention = input => { replies.push(input); return { id: input.attentionId }; };
  assert.deepEqual(await replyNotificationOption(f.dependencies, f.input), { id: 'attention' });
  assert.deepEqual(replies, [{ ticketId: 'ticket', attentionId: 'attention', instructionRevision: 2,
    requestId: 'notification-option:event', answer: { selected: ['放进仓库'] } }]);
  assert.equal(f.sent.length, 0);
});

test('an outdated or mismatched Attention choice cannot answer a different question', async () => {
  for (const attention of [
    undefined,
    { id: 'attention', resultVersion: 2, question: { options: [{ label: '放进仓库' }] } },
    { id: 'attention', resultVersion: 3, question: { options: [{ label: '先不放' }] } },
  ]) {
    const f = fixture(); f.event.attentionId = 'attention';
    f.dependencies.orchestration.attentions = () => attention ? [attention] : [];
    f.dependencies.orchestration.answerDesktopAttention = () => assert.fail('must not answer');
    await assert.rejects(replyNotificationOption(f.dependencies, f.input), /问题已变化/);
    assert.equal(f.sent.length, 0);
  }
});
