import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { ingestAssistantEvent } from '../src/intake.mjs';
import { attentionAnswer } from '../src/worker-attention.mjs';

test('Desktop Attention validates exact choices, revisions and idempotency and preserves answers across reopen', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-desktop-attention-'));
  let db = createAssistantOrchestrationStore({ directory });
  t.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  db.createThread({ id: 'desktop', source: { type: 'desktop', id: 'desktop' } });
  const task = db.createTask({ threadId: 'desktop', target: 'work', mandate: { actorId: 'desktop-owner', source: { channel: 'desktop', sessionId: 'owner-session', messageId: 'original' } } });
  db.createAssignment(task.id, {});
  const [assignment] = db.claimAssignments('worker', { validateMandate: () => true });
  const ownership = { owner: assignment.owner, fence: assignment.fence };
  const run = db.prepareRun(assignment.id, { ...ownership, sessionId: 'worker-session', directory });
  db.updateRun(run.id, { ...ownership, state: 'submitted' });
  const [attention, second] = db.openAttention(assignment.id, { ...ownership, sessionId: 'worker-session', callId: 'call', questions: [
    { id: 'q1', question: '选哪项？', options: [{ label: '精确 A' }, { label: '精确 B' }] },
    { id: 'q2', question: '补充？' },
  ] });
  const request = { taskId: task.id, attentionId: attention.id, instructionRevision: 1, requestId: 'reply', answer: { selected: ['精确 A'], custom: '  原文  ' } };
  assert.throws(() => db.answerDesktopAttention({ ...request, instructionRevision: 2 }), /requirements changed/);
  for (const answer of [{ selected: ['a'] }, { selected: ['精确 A', '精确 B'] }, { selected: ['精确 A', '精确 A'] }, { selected: [] }, { selected: [], custom: 42 }]) {
    assert.throws(() => db.answerDesktopAttention({ ...request, answer }), /Invalid Attention answer/);
  }
  const result = db.answerDesktopAttention(request);
  assert.equal(result.duplicate, false);
  assert.deepEqual(attentionAnswer(db, result), { id: 'q1', ...request.answer });
  assert.equal(db.getTask(task.id).instructionRevision, 1);
  assert.equal(db.candidates().length, 0, 'answers never request new authority');
  db.close(); db = createAssistantOrchestrationStore({ directory });
  assert.equal(db.answerDesktopAttention(request).duplicate, true);
  assert.throws(() => db.answerDesktopAttention({ ...request, answer: { selected: ['精确 B'] } }), /conflict/);
  assert.throws(() => db.answerDesktopAttention({ ...request, requestId: 'new-reply' }), /already answered/);
  assert.throws(() => db.answerDesktopAttention({ ...request, attentionId: second.id, answer: { selected: [], custom: 'other' } }), /conflict/);
  db.cancelTask(task.id);
  assert.throws(() => db.answerDesktopAttention({ ...request, attentionId: second.id, requestId: 'other', answer: { selected: [], custom: 'other' } }), /terminal/);
});

for (const machine of [false, true]) test(`Attention replies require admitted original requester and exact source after reopening (machine=${machine})`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-attention-'));
  let db = createAssistantOrchestrationStore({ directory });
  t.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  db.createThread({ id: 'origin', source: { type: 'feishu', id: 'origin' } });
  const source = { channel: 'feishu', sourceType: 'group', connectionId: 'feishu', conversationId: 'chat', appId: 'app', chatId: 'chat', messageId: 'original' };
  const task = db.createTask({ threadId: 'origin', target: 'work', mandate: { actorId: machine ? 'ci' : 'owner', source, ...(machine ? { admission: 'enabled-rules', actorKind: 'machine', strength: 'inferred' } : {}) } });
  db.createAssignment(task.id, {});
  const [assignment] = db.claimAssignments('worker', { validateMandate: () => true });
  const ownership = { owner: assignment.owner, fence: assignment.fence };
  const run = db.prepareRun(assignment.id, { ...ownership, sessionId: 'session', directory });
  db.updateRun(run.id, { ...ownership, state: 'submitted' });
  const request = { ...ownership, sessionId: 'session', callId: 'opaque-call', questions: [{ id: 'opaque-question', question: '原样的问题？', detail: '原样详情', options: [{ label: '原样选项' }] }] };
  const [attention] = db.openAttention(assignment.id, request);
  assert.deepEqual(db.openAttention(assignment.id, request), [attention]);
  assert.equal(db.deliveries(task.id).length, 1);
  const [outbox] = db.claimOutbox('sender');
  assert.equal(outbox.payload.text, `原样的问题？\n原样详情\n原样选项\n\n问题编号：${attention.id}\n可引用这条消息回答，或发送 /answer ${attention.id} 你的回答`);
  db.finishOutbox(outbox.id, { owner: 'sender', sent: true, receipt: { messageId: 'sent-question' } });
  db.close(); db = createAssistantOrchestrationStore({ directory });
  const policy = { version: 'v1', ownerIds: ['owner', 'other-owner'], machineIds: ['ci'], threadIds: ['chat', 'other-chat'] };
  const event = { channel: 'feishu', sourceKey: 'answer', threadId: 'reply-thread', source: { ...source, messageId: 'answer', parentMessageId: 'sent-question' }, actor: { kind: machine ? 'machine' : 'human', id: machine ? 'ci' : 'owner' }, text: '完整原文回答', kind: 'group', mentioned: true };
  for (const [key, patch] of [
    ['foreign-owner', { actor: { kind: 'human', id: 'other-owner' } }],
    ['machine', { actor: { kind: 'machine', id: 'owner' } }],
    ['foreign-connection', { source: { ...event.source, connectionId: 'other-connection' } }],
    ['foreign-conversation', { source: { ...event.source, conversationId: 'other-conversation' } }],
    ['foreign-chat', { source: { ...event.source, chatId: 'other-chat', conversationId: 'other-chat' } }],
    ['foreign-app', { source: { ...event.source, appId: 'other-app' } }],
    ['wrong-parent', { source: { ...event.source, parentMessageId: 'other-message' } }],
  ]) assert.equal(ingestAssistantEvent(db, { ...event, ...patch, sourceKey: key }, policy).attention, undefined);
  const accepted = ingestAssistantEvent(db, event, policy);
  assert.equal(accepted.attention.id, attention.id);
  assert.equal(accepted.requiresEval, false);
  assert.equal(db.candidates().find(candidate => candidate.triggerId === accepted.trigger.id).status, 'held');
  assert.equal(ingestAssistantEvent(db, event, policy).attention.duplicate, true);
  assert.equal(db.attentions(task.id)[0].answerTriggerId, accepted.trigger.id);
  assert.equal(ingestAssistantEvent(db, { ...event, sourceKey: 'second-answer' }, policy).attention, undefined);
  assert.equal(db.getTask(task.id).instructionRevision, 1, 'answers do not broaden execution authority');
});
