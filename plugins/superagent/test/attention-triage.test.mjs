import test from 'node:test';
import assert from 'node:assert/strict';
import { triageWorkerQuestions, validateAttentionDecisions } from '../src/attention-triage.mjs';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { attentionBatchAnswers } from '../src/worker-attention.mjs';

const questions = [{ id: 'known', question: '输出语言？' }, { id: 'format', question: '列表还是短句？' }];
const instruction = '使用简体中文。若需选择格式，你可自行决定，采用默认列表。';
const decisions = [{ questionId: 'known', route: 'self', basis: '原指令明确语言', evidence: '简体中文' },
  { questionId: 'format', route: 'default', basis: '原指令明确允许默认列表', evidence: '列表', authorization: '你可自行决定，采用默认列表', nonBlocking: true }];
const policy = { models: [{ providerId: 'p', modelId: 'Opaque Router/1' }], workerModels: [{ providerId: 'p', modelId: 'Worker' }] };

test('Attention automatic decisions require verbatim mandate evidence and explicit nonblocking default permission', () => {
  assert.deepEqual(validateAttentionDecisions({ decisions }, { questions, instruction }).map(row => row.answer.custom), ['简体中文', '列表']);
  assert.throws(() => validateAttentionDecisions({ decisions: [{ ...decisions[0], evidence: 'English' }, decisions[1]] }, { questions, instruction }), /ATTENTION_UNSUPPORTED_ANSWER/);
  assert.throws(() => validateAttentionDecisions({ decisions: [decisions[0], { ...decisions[1], nonBlocking: false }] }, { questions, instruction }), /ATTENTION_DEFAULT_NOT_AUTHORIZED/);
  assert.throws(() => validateAttentionDecisions({ decisions: [decisions[0]] }, { questions, instruction }), /ATTENTION_INVALID_DECISION/);
  const approval = [{ id: 'known', question: '继续？', intent: { kind: 'approval', approve: '是', reject: '否' } }];
  assert.equal(validateAttentionDecisions({ decisions: [decisions[0]] }, { questions: approval, instruction })[0].route, 'user');
});

test('Attention uses a single budgeted Router request and times out a stalled adapter without retry', async () => {
  const calls = [], charged = [];
  const database = { ticketGoalBudget: () => true, reserveGoalRequest: input => { charged.push(input); return { allowed: true }; }, recordGoalRequestUsage() {} };
  const llm = { async *stream(options) { calls.push(options); yield { type: 'text-delta', text: JSON.stringify({ decisions }) }; yield { type: 'finish', reason: { kind: 'stop' } }; } };
  const result = await triageWorkerQuestions({ llm, database, ticket: { id: 't', mandate: { instruction } }, questions, policy });
  assert.deepEqual(result.map(row => row.route), ['self', 'default']);
  assert.equal(calls.length, 1); assert.equal(charged.length, 1);
  assert.equal(calls[0].model, 'Opaque Router/1'); assert.deepEqual(calls[0].tools, []); assert.equal(calls[0].sessionId, undefined);
  let attempts = 0;
  const stalled = { async *stream() { attempts++; await new Promise(() => {}); } };
  const timed = await triageWorkerQuestions({ llm: stalled, database, ticket: { id: 't', mandate: { instruction } }, questions, policy, timeoutMs: 10 });
  assert.equal(attempts, 1); assert.ok(timed.every(row => row.route === 'user' && row.systemState === 'timeout'));
});

test('Attention stores host resolutions separately and assembles mixed batches without forged human triggers', t => {
  const database = createAssistantOrchestrationStore({ filename: ':memory:' });
  t.after(() => database.close());
  database.createThread({ id: 'thread', source: { type: 'desktop', id: 'owner' } });
  const ticket = database.createTicket({ threadId: 'thread', target: 'Answer', mandate: { instruction, actorId: 'desktop-owner', source: { channel: 'desktop', sessionId: 'owner' } } });
  database.createAssignment(ticket.id, { model: policy.models[0] });
  const [assignment] = database.claimAssignments('worker', { validateMandate: () => true });
  const ownership = { owner: assignment.owner, fence: assignment.fence };
  const run = database.prepareRun(assignment.id, { ...ownership, sessionId: 'worker-session', directory: '/fixture' });
  database.updateRun(run.id, { ...ownership, state: 'submitted' });
  const input = { ...ownership, sessionId: run.sessionId, callId: 'call', questions, decisions: [decisions[0], { questionId: 'format', route: 'user', basis: '用户应决定格式' }] };
  const saved = database.saveAttentionResolutions(assignment.id, input);
  assert.deepEqual(database.saveAttentionResolutions(assignment.id, input), saved);
  assert.throws(() => database.openAttention(assignment.id, { ...ownership, sessionId: run.sessionId, callId: 'call', questions: [questions[0]] }), /Automatically resolved/);
  const [entry] = database.openAttention(assignment.id, { ...ownership, sessionId: run.sessionId, callId: 'call', questions: [questions[1]] });
  assert.equal(database.attentions(ticket.id).length, 1); assert.equal(entry.answerTriggerId, null);
  assert.throws(() => attentionBatchAnswers(database, ticket.id, { sessionId: run.sessionId, callId: 'call' }), /answer is missing/);
  database.answerDesktopAttention({ ticketId: ticket.id, attentionId: entry.id, instructionRevision: 1, requestId: 'human-answer', answer: { selected: [], custom: '列表' } });
  const answers = attentionBatchAnswers(database, ticket.id, { sessionId: run.sessionId, callId: 'call' });
  assert.deepEqual(answers, [{ id: 'known', selected: [], custom: '简体中文' }, { id: 'format', selected: [], custom: '列表' }]);
  assert.ok(database.attentionResolutions(ticket.id).every(row => !row.answerTriggerId));
});

test('parking one Attention assignment does not block another assignment on the same Ticket', t => {
  const database = createAssistantOrchestrationStore({ filename: ':memory:' });
  t.after(() => database.close());
  database.createThread({ id: 'thread', source: { type: 'desktop', id: 'owner' } });
  const ticket = database.createTicket({ threadId: 'thread', target: 'Parallel work', mandate: { instruction, actorId: 'desktop-owner', source: { channel: 'desktop', sessionId: 'owner' } } });
  const waiting = database.createAssignment(ticket.id, { model: policy.models[0] });
  const [assignment] = database.claimAssignments('waiting-worker', { assignmentId: waiting.id, validateMandate: () => true });
  const other = database.createAssignment(ticket.id, { model: policy.models[0] });
  const ownership = { owner: assignment.owner, fence: assignment.fence };
  const run = database.prepareRun(assignment.id, { ...ownership, sessionId: 'waiting-session', directory: '/fixture' });
  database.updateRun(run.id, { ...ownership, state: 'submitted' });
  const [attention] = database.openAttention(assignment.id, { ...ownership, sessionId: run.sessionId, callId: 'wait-call', questions: [questions[1]] });
  const result = { runId: run.id, waitingAttention: { callIds: ['wait-call'], attentionIds: [attention.id] }, checkpoint: {}, transcript: {} };
  database.updateRun(run.id, { ...ownership, state: 'verifying', evidence: result });
  database.parkAttention(assignment.id, { ...ownership, result });
  const [parallel] = database.claimAssignments('parallel-worker', { validateMandate: () => true });
  assert.equal(parallel.id, other.id);
  assert.equal(database.renewAssignment(parallel.id, { owner: parallel.owner, fence: parallel.fence, validateMandate: () => true }).allowed, true);
  assert.equal(database.getAssignment(assignment.id).state, 'waiting');
});
