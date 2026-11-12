import test from 'node:test';
import assert from 'node:assert/strict';
import { triageWorkerQuestions, validateAttentionDecisions, buildAttentionExcerpts, parseAttentionDecisions, requiresHumanDecision } from '../src/attention-triage.mjs';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { attentionBatchAnswers } from '../src/worker-attention.mjs';

const questions = [{ id: 'known', question: '输出语言？' }, { id: 'format', question: '列表还是短句？' }];
const instruction = '使用简体中文。若需选择格式，你可自行决定，采用默认列表。';
const decisions = [{ questionId: 'known', route: 'self', basis: '原指令明确语言', evidence: '简体中文' },
  { questionId: 'format', route: 'default', basis: '原指令明确允许默认列表', evidence: '列表', authorization: '你可自行决定，采用默认列表', nonBlocking: true }];
const policy = { models: [{ providerId: 'p', modelId: 'Opaque Router/1' }], workerModels: [{ providerId: 'p', modelId: 'Worker' }] };

test('Attention distinguishes narrow historical authorization from a current approval request', () => {
  const historical = { id: 'language', question: '交付语言使用简体中文还是英文？（原请求已授权简体中文，本项可由总助手按原请求答复）' };
  assert.equal(requiresHumanDecision(historical), false);
  for (const source of ['原请求', '原指令', '原始指令']) {
    for (const past of ['已', '已经']) {
      assert.equal(requiresHumanDecision({ question: `${source}${past}授权简体中文，交付语言？` }), false);
    }
  }
  for (const question of ['原请求已授权旧操作，请授权新操作', '已授权简体中文，交付语言？', '无需授权，直接执行',
    '原请求已授权吗？', '原请求已授权？', '原请求已授权是否有效', '原请求是否已授权', '是否原请求已授权', '原请求已授权简体中文，请批准执行']) {
    assert.equal(requiresHumanDecision({ question }), true, question);
  }
  assert.equal(requiresHumanDecision({ ...historical, intent: { kind: 'approval' } }), true);
  assert.throws(() => validateAttentionDecisions({ decisions: [{ questionId: historical.id, route: 'self', basis: 'Question claims authorization', evidence: '简体中文' }] },
    { questions: [historical], instruction: '请整理三条事实。' }), /ATTENTION_UNSUPPORTED_ANSWER/);
});

test('Attention automatic decisions require verbatim mandate evidence and explicit nonblocking default permission', () => {
  assert.deepEqual(validateAttentionDecisions({ decisions }, { questions, instruction }).map(row => row.answer.custom), ['简体中文', '列表']);
  assert.throws(() => validateAttentionDecisions({ decisions: [{ ...decisions[0], evidence: 'English' }, decisions[1]] }, { questions, instruction }), /ATTENTION_UNSUPPORTED_ANSWER/);
  assert.throws(() => validateAttentionDecisions({ decisions: [decisions[0], { ...decisions[1], nonBlocking: false }] }, { questions, instruction }), /ATTENTION_DEFAULT_NOT_AUTHORIZED/);
  assert.throws(() => validateAttentionDecisions({ decisions: [decisions[0]] }, { questions, instruction }), /ATTENTION_INVALID_DECISION/);
  const approval = [{ id: 'known', question: '继续？', intent: { kind: 'approval', approve: '是', reject: '否' } }];
  assert.equal(validateAttentionDecisions({ decisions: [decisions[0]] }, { questions: approval, instruction })[0].route, 'user');
});

test('Attention excerpt IDs preserve original text and retain strict answer/default validation', () => {
  const original = '  使用简体中文。\r\n若需选择格式，你可自行决定，采用默认列表。\n' + '长'.repeat(6001) + '🙂';
  const excerpts = buildAttentionExcerpts(original);
  assert.equal(excerpts.map(row => row.text).join(''), original);
  assert.ok(excerpts.every(row => row.text.length <= 6000));
  assert.deepEqual(buildAttentionExcerpts(original), excerpts);
  assert.deepEqual(buildAttentionExcerpts('使用简体中文，保留任务；English, next; done: A、B').map(row => row.text),
    ['使用简体中文，', '保留任务；', 'English,', ' next;', ' done: A、B']);
  assert.equal(excerpts[0].text, '  使用简体中文。');
  const evidence = excerpts.find(row => row.text.includes('简体中文'));
  const authorization = excerpts.find(row => row.text.includes('采用默认列表'));
  const rows = [{ questionId: 'known', route: 'self', basis: 'Language is explicit', evidenceId: evidence.id },
    { questionId: 'format', route: 'default', basis: 'Exact default is authorized', evidenceId: authorization.id, authorizationId: authorization.id, nonBlocking: true }];
  const parse = decisions => parseAttentionDecisions(JSON.stringify({ decisions }), { questions, instruction: original });
  const result = parse(rows);
  assert.equal(result[0].answer.custom, evidence.text);
  assert.equal(result[1].authorization, authorization.text);
  assert.throws(() => parse([{ ...rows[0], evidenceId: 'missing' }, rows[1]]), /ATTENTION_UNSUPPORTED_ANSWER/);
  assert.throws(() => parse([{ ...rows[0], evidenceId: null }, rows[1]]), /ATTENTION_UNSUPPORTED_ANSWER/);
  assert.throws(() => parse([{ ...rows[0], evidence: '简体中文' }, rows[1]]), /ATTENTION_UNSUPPORTED_ANSWER/);
  assert.throws(() => parse([rows[0], { ...rows[1], authorizationId: 'missing' }]), /ATTENTION_DEFAULT_NOT_AUTHORIZED/);
  assert.throws(() => parse([rows[0], { ...rows[1], authorization: '自行决定' }]), /ATTENTION_DEFAULT_NOT_AUTHORIZED/);
  assert.throws(() => parse([rows[0], { ...rows[1], authorizationId: evidence.id }]), /ATTENTION_DEFAULT_NOT_AUTHORIZED/);
  assert.throws(() => parse([rows[0], { ...rows[1], nonBlocking: false }]), /ATTENTION_DEFAULT_NOT_AUTHORIZED/);
  assert.throws(() => parse([rows[0], { ...rows[1], authorizationId: undefined }]), /ATTENTION_DEFAULT_NOT_AUTHORIZED/);
  assert.deepEqual(parseAttentionDecisions(JSON.stringify({ decisions }), { questions, instruction }).map(row => row.answer.custom), ['简体中文', '列表']);
  assert.equal(parseAttentionDecisions(JSON.stringify({ decisions: [{ ...rows[0], evidenceId: 'missing' }] }), {
    questions: [{ id: 'known', question: '批准执行？' }], instruction: original,
  })[0].route, 'user', 'approval remains human-owned even with invalid model evidence');
  assert.equal(parse([{ questionId: 'known', route: 'user', basis: 'Instruction does not answer this question' }, rows[1]])[0].route, 'user');
});

test('Attention Router requests excerpt IDs and resolves them in one request without invented answers', async () => {
  let calls = 0;
  const llm = { async *stream(options) {
    calls++;
    const input = JSON.parse(options.messages[1].content[0].text);
    assert.equal(input.excerpts.map(row => row.text).join(''), instruction);
    assert.match(options.messages[0].content[0].text, /evidenceId/);
    assert.match(options.messages[0].content[0].text, /If no provided excerpt adequately answers/);
    yield { type: 'text-delta', text: JSON.stringify({ decisions: [
      { questionId: 'known', route: 'self', basis: 'Language is explicit', evidenceId: 'e0' },
      { questionId: 'format', route: 'user', basis: 'User decides' },
    ] }) };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } };
  const result = await triageWorkerQuestions({ llm, ticket: { id: 't', mandate: { instruction } }, questions, policy });
  assert.equal(calls, 1);
  assert.equal(result[0].answer.custom, '使用简体中文。');
  assert.equal(result[1].route, 'user');
});

test('Attention uses a single Router request and times out a stalled adapter without retry', async () => {
  const calls = [];
  const llm = { async *stream(options) { calls.push(options); yield { type: 'text-delta', text: JSON.stringify({ decisions }) }; yield { type: 'finish', reason: { kind: 'stop' } }; } };
  const result = await triageWorkerQuestions({ llm, ticket: { id: 't', mandate: { instruction } }, questions, policy });
  assert.deepEqual(result.map(row => row.route), ['self', 'default']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, 'Opaque Router/1'); assert.deepEqual(calls[0].tools, []); assert.equal(calls[0].sessionId, undefined);
  let attempts = 0;
  const stalled = { async *stream() { attempts++; await new Promise(() => {}); } };
  const timed = await triageWorkerQuestions({ llm: stalled, ticket: { id: 't', mandate: { instruction } }, questions, policy, timeoutMs: 10 });
  assert.equal(attempts, 1); assert.ok(timed.every(row => row.route === 'user' && row.systemState === 'timeout'));
});

for (const kind of ['error', 'blocked', 'aborted', 'max-tokens', 'tool-calls']) test(`Attention stops at terminal ${kind} without waiting for a stalled stream tail`, async () => {
  let attempts = 0, pulledAfterFinish = false, closed = false, requestSignal;
  const llm = { async *stream({ signal }) {
    attempts++; requestSignal = signal;
    try {
      yield { type: 'usage', usage: { totalTokens: 7 } };
      yield { type: 'finish', reason: { kind, ...(kind === 'error' ? { failure: { code: 'SERVER', message: 'fixture failure' } } : {}) } };
      pulledAfterFinish = true;
      await new Promise(() => {});
    } finally { closed = true; }
  } };
  const result = await triageWorkerQuestions({ llm, ticket: { id: 't', mandate: { instruction } }, questions, policy, timeoutMs: 30 });
  assert.ok(result.every(row => row.route === 'user' && row.systemState === 'triage-unavailable'));
  assert.equal(attempts, 1);
  assert.equal(pulledAfterFinish, false, 'a terminal failure must not request another stream chunk');
  assert.equal(requestSignal.aborted, true, 'finished triage cancels the underlying request');
  // Closing the provider stream runs on the cleanup microtask.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, true);
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
  const receipt = database.ticketInputs(ticket.id).find(row => row.kind === 'answer');
  assert.equal(receipt.state, 'applied'); assert.equal(receipt.application.runId, run.id);
  assert.equal(receipt.application.attentionId, entry.id);
  assert.ok(database.attentionResolutions(ticket.id).every(row => !row.answerTriggerId));
});

for (const channel of ['desktop', 'feishu']) test(`failed Attention triage keeps ${channel} questions unchanged and preserves diagnostics`, async t => {
  const database = createAssistantOrchestrationStore({ filename: ':memory:' });
  t.after(() => database.close());
  database.createThread({ id: 'thread', source: { type: channel, id: 'owner' } });
  const source = { channel, sessionId: 'owner', chatId: 'origin-chat' };
  const ticket = database.createTicket({ threadId: 'thread', target: 'Choose format', mandate: { instruction, actorId: 'desktop-owner', source } });
  database.createAssignment(ticket.id, { model: policy.models[0] });
  const [assignment] = database.claimAssignments('worker', { validateMandate: () => true });
  const ownership = { owner: assignment.owner, fence: assignment.fence };
  const run = database.prepareRun(assignment.id, { ...ownership, sessionId: 'worker-session', directory: '/fixture' });
  database.updateRun(run.id, { ...ownership, state: 'submitted' });
  const question = { id: 'format', question: '交付用列表还是短句？', detail: '请按阅读习惯选择。',
    options: [{ label: '列表', description: '逐项阅读' }, { label: '短句' }] };
  const llm = { async *stream() { yield { type: 'finish', reason: { kind: 'error' } }; } };
  const decisions = await triageWorkerQuestions({ llm, ticket, questions: [question], policy });
  assert.deepEqual(decisions, [{ questionId: question.id, route: 'user', basis: 'Router 自动核对未完成，需用户补充', systemState: 'triage-unavailable' }]);
  const batch = { ...ownership, sessionId: run.sessionId, callId: 'failed-triage', questions: [question] };
  database.saveAttentionResolutions(assignment.id, { ...batch, decisions });
  const [attention] = database.openAttention(assignment.id, batch);
  const [delivery] = database.claimOutbox('sender');
  const text = '交付用列表还是短句？\n请按阅读习惯选择。\n列表：逐项阅读\n短句';
  assert.equal(delivery.payload.text, channel === 'desktop' ? text
    : `${text}\n\n问题编号：${attention.id}\n可引用这条消息回答，或发送 /answer ${attention.id} 你的回答`);
  assert.deepEqual(delivery.payload.options, ['列表', '短句']);
  assert.deepEqual(delivery.payload.source, source);
  assert.deepEqual(delivery.payload.triage, decisions[0]);
  assert.deepEqual(database.attentionResolutions(ticket.id).map(({ questionId, route, basis, systemState }) => ({ questionId, route, basis, systemState })), decisions);
  assert.deepEqual(attention.question, question);
  assert.equal(attention.state, 'waiting');
  assert.equal(attention.answerTriggerId, null);
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
