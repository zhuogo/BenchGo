import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewTicketResult, recoverableReview } from '../src/ticket-review.mjs';
const passed = { verdict: 'passed', reason: 'source verified', delivery: { action: 'deliver', text: '已核实。' } };
function input(responses, inspect = () => {}) {
  let count = 0;
  return { model: { providerId: 'test', modelId: 'opaque' }, ticket: { id: 'ticket', target: '今天热点', createdAt: '2026-11-03T10:00:00Z' }, result: { summary: 'news', evidenceRefs: ['transcript'], toolEvidence: { truncated: true } }, rules: '',
    llm: { async *stream(request) { inspect(request, count); yield { type: 'text-delta', text: JSON.stringify(responses[Math.min(count++, responses.length - 1)]) }; yield { type: 'finish', reason: { kind: 'stop' } }; } } };
}
function reader() {
  let count = 0;
  const read = async ({ seq, offset = 0 }) => { count++; return { seq, offset, text: 'verified source', totalLength: 15 }; };
  read.index = async () => ({ entries: [{ seq: 8, name: 'web_fetch', textLength: 15 }], total: 1, omitted: 0 });
  read.count = () => count;
  return read;
}
test('review reads indexed omitted evidence and receives trusted clock', async () => {
  const readEvidence = reader();
  const args = input([{ readEvidence: [{ seq: 8 }] }, passed], (request, round) => {
    assert.deepEqual(request.tools, []);
    const data = JSON.parse(request.messages[1].content[0].text);
    assert.equal(data.trustedClock.taskCreatedAt, '2026-11-03T10:00:00Z');
    assert.ok(Number.isFinite(Date.parse(data.trustedClock.now)));
    assert.ok(data.trustedClock.timeZone);
    if (round) assert.match(request.messages.at(-1).content[0].text, /verified source/);
  });
  assert.equal((await reviewTicketResult({ ...args, readEvidence })).verdict, 'passed');
  assert.equal(readEvidence.count(), 1);
});

test('review preserves successful and failed request evidence across evidence rounds', async () => {
  const args = input([passed]); let calls = 0;
  args.readEvidence = reader();
  args.routingConfig = { auxiliary: { capabilities: ['review'], models: [{ providerId: 'aux', modelId: 'Aux/Opaque' }] } };
  args.llm = { async *stream(request) {
    calls++;
    if (calls === 1) throw Object.assign(new Error('private provider body'), { code: 'NO_ADAPTER' });
    yield { type: 'text-delta', text: JSON.stringify(calls === 2 ? { readEvidence: [{ seq: 8 }] } : passed) };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } };
  const result = await reviewTicketResult(args);
  assert.equal(result.verdict, 'passed');
  assert.equal(result.routing.switched, true);
  assert.deepEqual(result.routing.attempts.map(row => [row.providerId, row.modelId, row.status]), [
    ['aux', 'Aux/Opaque', 'failed'], ['test', 'opaque', 'completed'], ['aux', 'Aux/Opaque', 'completed'],
  ]);
  assert.deepEqual(result.routing.attempts.map(row => row.timeoutMs), [45_000, 120_000, 45_000]);
  assert.doesNotMatch(JSON.stringify(result.routing), /private provider body|source verified|已核实/);
});

test('evidence rounds share one main-model structure correction instead of restarting its allowance', async () => {
  const args = input([passed]); let calls = 0;
  args.readEvidence = reader();
  args.llm = { async *stream() {
    calls++;
    yield { type: 'text-delta', text: calls === 2 ? JSON.stringify({ readEvidence: [{ seq: 8 }] }) : 'private invalid output' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } };
  const result = await recoverableReview(reviewTicketResult, args);
  assert.equal(calls, 3);
  assert.equal(args.readEvidence.count(), 1);
  assert.equal(result.waitKind, 'review_wait');
  assert.equal(result.delivery.origin, 'system');
  assert.equal(result.routing.attempts.length, 3);
  assert.equal(result.diagnostic.stream.quality, 'INVALID_JSON');
  assert.doesNotMatch(JSON.stringify(result), /private invalid output/);
});
test('repairable defects retain a natural explanation and instruction for the original task', async () => {
  for (const verdict of ['rework', 'failed']) {
    const result = await reviewTicketResult(input([{ verdict, reason: 'source missing', instruction: '核对原来源并纠正日期，不扩大范围。', delivery: { action: 'deliver', text: '摘要里有一处日期还没核实，我会在原任务里补查并修正。' } }]));
    assert.equal(result.verdict, verdict); assert.match(result.delivery.text, /日期/); assert.ok(result.instruction);
  }
});
test('unindexed and oversized reads are rejected before reader invocation', async () => {
  for (const page of [{ seq: 99 }, { seq: 8, limit: 8001 }, { seq: 8, offset: -1 }]) {
    const readEvidence = reader();
    await assert.rejects(reviewTicketResult({ ...input([{ readEvidence: [page] }]), readEvidence }), /格式/);
    assert.equal(readEvidence.count(), 0);
  }
});
test('evidence read failure cannot become success or attention', async () => {
  const readEvidence = reader(); readEvidence.index = async () => { throw new Error('sensitive internal details'); };
  const verdict = await reviewTicketResult({ ...input([passed], () => assert.fail('no model call')), readEvidence });
  assert.equal(verdict.verdict, 'wait'); assert.equal(verdict.waitKind, 'review_wait'); assert.equal(verdict.retryable, true);
  assert.equal(verdict.delivery.origin, 'system'); assert.equal(verdict.delivery.systemState.code, 'REVIEW_EVIDENCE_UNAVAILABLE');
  assert.equal(verdict.userDecision, undefined); assert.doesNotMatch(JSON.stringify(verdict), /sensitive/);
});
test('evidence read loop is bounded without invented verdict', async () => {
  const readEvidence = reader();
  const verdict = await reviewTicketResult({ ...input([{ readEvidence: [{ seq: 8 }] }]), readEvidence });
  assert.equal(readEvidence.count(), 3); assert.equal(verdict.verdict, 'wait'); assert.equal(verdict.retryable, true);
  assert.equal(verdict.delivery.origin, 'system'); assert.equal(verdict.delivery.systemState.code, 'EVIDENCE_READ_WINDOW_EXHAUSTED');
});
test('only a real blocked question creates attention and ordinary failures cannot be silenced', async () => {
  await assert.rejects(reviewTicketResult(input([{ verdict: 'wait', reason: 'need evidence', delivery: { action: 'ask', text: '要不要重新搜索？' } }])), /格式/);
  for (const verdict of ['rework', 'failed']) {
    await assert.rejects(reviewTicketResult(input([{ verdict, reason: 'fix', instruction: 'fix' }])), /格式/);
    await assert.rejects(reviewTicketResult(input([{ verdict, reason: 'fix', delivery: { action: 'deliver', text: 'fixing' } }])), /格式/);
    await assert.rejects(reviewTicketResult(input([{ verdict, reason: 'fix', instruction: 'fix', delivery: { action: 'silent' } }])), /格式/);
  }
  const result = await reviewTicketResult(input([{ verdict: 'wait', reason: 'scope unknown', delivery: { action: 'ask', text: '需要哪个城市？' }, userDecision: { kind: 'information', question: '需要哪个城市？' } }]));
  assert.equal(result.delivery.action, 'ask'); assert.equal(result.waitKind, 'blocked'); assert.equal(result.retryable, undefined);
});

test('a text-only task is reviewed against its persisted concrete criteria, never an invented file gate', async () => {
  const acceptance = '整理6–10条中文新闻，每条1–2句，附来源、报道时间、多源/单一来源标记和一句整体概览；渠道不可访问如实说明。';
  const args = input([passed], request => {
    const prompt = request.messages[0].content[0].text;
    const payload = JSON.parse(request.messages[1].content[0].text);
    assert.match(prompt, /empty artifactRefs array or a checkpoint with zero files is valid/);
    assert.match(prompt, /6-10 item digest must be corrected if it contains 14/);
    assert.match(prompt, /never add new conditions at review/);
    assert.equal(payload.taskContract.acceptance, acceptance);
    assert.equal(payload.taskContract.originalInstruction, '调查当天新闻，按下列要求整理。');
  });
  args.ticket = { ...args.ticket, acceptance, instructionRevision: 1, mandate: { instruction: '调查当天新闻，按下列要求整理。', acceptance: 'old criteria' } };
  args.result = { ...args.result, artifactRefs: [], checkpoint: { files: [] } };
  const review = await reviewTicketResult(args);
  assert.equal(review.verdict, 'passed'); assert.equal(review.delivery.text, passed.delivery.text);
});

test('review preserves current owner process requirements when Router summaries omit them', async () => {
  const originalInstruction = '读取甲、乙两份记录，分别核对来源，再交付总数。即使总数已知也要完成两次来源核对；不要联网。';
  const target = '读取甲记录并交付总数。';
  const acceptance = '总数正确即可。';
  const args = input([passed], request => {
    const prompt = request.messages[0].content[0].text;
    const payload = JSON.parse(request.messages[1].content[0].text);
    assert.equal(payload.taskContract.instructionRevision, 3);
    assert.equal(payload.taskContract.originalInstruction, originalInstruction);
    assert.equal(payload.mandate.instruction, originalInstruction);
    assert.equal(payload.taskContract.objective, target);
    assert.equal(payload.taskContract.acceptance, acceptance);
    assert.match(prompt, /originalInstruction first:.*takes precedence over Router-written objective and acceptance summaries/);
    assert.match(prompt, /cannot waive, contradict or omit an explicit owner requirement applicable to this Ticket/);
    assert.match(prompt, /required outcomes and explicitly required process steps, order and verification paths against actual evidence/);
    assert.match(prompt, /Read relevant indexed evidence before concluding a step is absent/);
    assert.match(prompt, /bounded rework for this same Worker session/);
  });
  args.ticket = { ...args.ticket, target, acceptance, instructionRevision: 3,
    mandate: { instruction: originalInstruction, acceptance: '原始要求中的来源核对和总数。' } };
  const before = structuredClone(args.ticket);
  // The fixture checks the request contract, not whether a model obeys it.
  await reviewTicketResult(args);
  assert.deepEqual(args.ticket, before);
});

test('review accepts a fenced or single enveloped JSON decision and rejects ambiguous output', async () => {
  const decision = { ...passed, reason: 'source {verified}' };
  const fenced = input([decision]);
  fenced.llm = { async *stream() {
    yield { type: 'text-delta', text: `\`\`\`json\n${JSON.stringify(decision)}\n\`\`\`` };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } };
  assert.equal((await reviewTicketResult(fenced)).verdict, 'passed');

  const wrapped = input([decision]);
  wrapped.llm = { async *stream() {
    yield { type: 'text-delta', text: `审查结论：\n${JSON.stringify(decision)}\n结果已按现行任务书核对。` };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } };
  assert.equal((await reviewTicketResult(wrapped)).verdict, 'passed');

  const ambiguous = input([decision]);
  ambiguous.llm = { async *stream() {
    yield { type: 'text-delta', text: `审查结论：${JSON.stringify(decision)}\n替代结论：${JSON.stringify(decision)}` };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } };
  const waiting = await recoverableReview(reviewTicketResult, ambiguous);
  assert.equal(waiting.waitKind, 'review_wait');
  assert.equal(waiting.diagnostic.stream.quality, 'INVALID_JSON');

  const prose = input([decision]);
  prose.llm = { async *stream() {
    yield { type: 'text-delta', text: '审查结论仍在核对，没有结构化决策。' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } };
  const proseWait = await recoverableReview(reviewTicketResult, prose);
  assert.equal(proseWait.waitKind, 'review_wait');
  assert.equal(proseWait.diagnostic.stream.quality, 'INVALID_JSON');
});

test('review prompt makes delivery text and decision branch requirements explicit', async () => {
  const args = input([passed], request => {
    const prompt = request.messages[0].content[0].text;
    assert.match(prompt, /Return exactly one JSON object, without Markdown or surrounding prose/);
    assert.match(prompt, /Passed result:.*delivery.*text/);
    assert.match(prompt, /Actual user blocker:.*ask always requires wait, text and userDecision/);
    assert.match(prompt, /Correctable result:.*instruction.*delivery.*text/);
    assert.match(prompt, /publicationContext.silentAllowed is false/);
    assert.match(prompt, /passed verdict MUST use delivery.action="deliver"/);
  });
  assert.equal((await reviewTicketResult(args)).verdict, 'passed');
});

test('review keeps a required user-dependent later phase open after an intermediate deliverable', async () => {
  const question = '候选整理已完成，后续摘要更偏向 AI 科技还是宏观经济？';
  const args = input([{ verdict: 'wait', reason: 'The final summary depends on the owner selecting a focus.',
    delivery: { action: 'ask', text: question }, userDecision: { kind: 'scope', question } }], request => {
    const prompt = request.messages[0].content[0].text;
    const payload = JSON.parse(request.messages[1].content[0].text);
    assert.match(prompt, /Compare the whole original owner request as well as any decomposed phase objective/);
    assert.match(prompt, /completing an intermediate phase does not pass the Ticket while the required input is absent/);
    assert.match(prompt, /do not mark the phase passed or merely include the question in a delivered report/);
    assert.match(payload.taskContract.originalInstruction, /after the user selects, continue the same task/i);
    assert.match(payload.taskContract.acceptance, /final 6-10 item digest/);
    assert.match(payload.result.finalSummary, /候选事实/);
    assert.match(payload.result.finalSummary, /请用户选择/);
  });
  args.ticket = {
    ...args.ticket,
    target: 'Collect candidate facts, then continue after the user selects a focus.',
    acceptance: 'Intermediate candidate list is followed by a final 6-10 item digest after user selection.',
    instructionRevision: 1,
    mandate: { instruction: 'Complete candidate research. After the user selects, continue the same task.',
      acceptance: 'Deliver a final 6-10 item digest after the user selection.' },
  };
  args.result = { ...args.result, finalSummary: '候选事实已整理，请用户选择后生成最终摘要。' };
  const review = await reviewTicketResult(args);
  assert.equal(review.verdict, 'wait');
  assert.equal(review.waitKind, 'blocked');
  assert.equal(review.delivery.action, 'ask');
  assert.equal(review.userDecision.kind, 'scope');
  assert.equal(review.userDecision.question, question);
});

test('review guard blocks a passed intermediate result when the Mandate and Worker text still require the user', async () => {
  const workerText = '候选事实已经整理完成，请用户选择 AI 科技优先还是宏观经济优先？选择后我会继续生成最终摘要。';
  const routerAsk = { verdict: 'wait', reason: '最终取舍取决于你尚未给出的阅读重点。',
    delivery: { action: 'ask', text: '你希望最终摘要优先突出 AI 科技，还是宏观经济？' },
    userDecision: { kind: 'scope', question: '你希望最终摘要优先突出 AI 科技，还是宏观经济？' } };
  let calls = 0;
  const args = input([passed, routerAsk], request => {
    if (calls++) assert.match(request.messages.at(-1).content[0].text, /Host consistency check/);
  });
  args.ticket = {
    ...args.ticket,
    target: '先整理候选事实，用户选择后继续同一任务。',
    acceptance: '用户选择后交付最终 6-10 条摘要。',
    mandate: { instruction: '完成候选调研。用户选择后继续同一任务。', acceptance: '用户选择后交付最终 6-10 条摘要。' },
  };
  args.result = { ...args.result, finalSummary: workerText };
  const review = await reviewTicketResult(args);
  assert.equal(review.verdict, 'wait');
  assert.equal(review.waitKind, 'blocked');
  assert.equal(review.delivery.action, 'ask');
  assert.equal(review.delivery.text, routerAsk.delivery.text);
  assert.equal(review.userDecision.question, routerAsk.userDecision.question);
  assert.notEqual(review.delivery.text, workerText);
  assert.equal(calls, 2);
});

test('review guard does not block an ordinary completed result with no unresolved user decision', async () => {
  const args = input([passed]);
  args.ticket = { ...args.ticket, target: '整理新闻并交付摘要。', acceptance: '交付 6-10 条摘要。' };
  args.result = { ...args.result, finalSummary: '已按验收条件交付 8 条摘要，附来源、时间与限制说明。' };
  const review = await reviewTicketResult(args);
  assert.equal(review.verdict, 'passed');
});

test('review guard does not reopen a quoted choice after the Worker records the answer and final delivery', async () => {
  let calls = 0;
  const args = input([passed], () => assert.equal(calls++, 0, 'answered work must not trigger a second review request'));
  args.ticket = {
    ...args.ticket,
    target: 'Collect candidate facts, then continue after the user selects a focus.',
    acceptance: 'Deliver the final 6-10 item digest after user selection.',
    mandate: { instruction: 'After the user selects, continue the same task.', acceptance: 'Deliver the final digest after user selection.' },
  };
  args.result = { ...args.result, finalSummary: '此前询问过“AI 科技优先还是宏观经济优先？”。用户已选择 AI 科技，我已据此完成并交付最终摘要。' };
  assert.equal((await reviewTicketResult(args)).verdict, 'passed');
  assert.equal(calls, 1);
});

test('review guard ignores an unrelated answered Attention', async () => {
  let calls = 0;
  const args = input([passed, {
    verdict: 'wait', reason: 'The final digest still needs the owner focus.',
    delivery: { action: 'ask', text: 'Which focus should the final digest use?' },
    userDecision: { kind: 'scope', question: 'Which focus should the final digest use?' },
  }], request => {
    if (calls++) assert.match(request.messages.at(-1).content[0].text, /Host consistency check/);
  });
  args.ticket = {
    ...args.ticket,
    target: 'Collect candidate facts before the owner chooses a focus, then continue the same task.',
    acceptance: 'Deliver the final digest after the owner choice.',
    mandate: {
      instruction: 'Research the candidates. The user must choose a focus before the worker continues.',
      acceptance: 'After the user selects, complete and deliver the final digest.',
      attentions: [{ state: 'answered', question: 'An unrelated question' }],
    },
    attentions: [{ state: 'answered', question: 'An unrelated question' }],
  };
  args.result = { ...args.result, finalSummary: 'Candidate facts are ready. Please choose a focus before I continue.' };
  const review = await reviewTicketResult(args);
  assert.equal(review.verdict, 'wait');
  assert.equal(review.waitKind, 'blocked');
  assert.equal(review.delivery.action, 'ask');
  assert.equal(calls, 2);
});

test('a conflicting second Router verdict becomes a recoverable internal review wait', async () => {
  const args = input([passed, passed]);
  args.ticket = { ...args.ticket, target: '用户选择后继续同一任务。', acceptance: '用户选择后交付最终摘要。',
    mandate: { instruction: '用户选择后继续同一任务。', acceptance: '用户选择后交付最终摘要。' } };
  args.result = { ...args.result, finalSummary: '候选事实已整理，请用户选择 AI 优先还是经济优先？选择后继续生成摘要。' };
  const review = await reviewTicketResult(args);
  assert.equal(review.verdict, 'wait');
  assert.equal(review.waitKind, 'review_wait');
  assert.equal(review.delivery.origin, 'system');
  assert.equal(review.delivery.systemState.code, 'USER_CONTINUATION_REVIEW_CONFLICT');
  assert.equal(review.userDecision, undefined);
});

test('review guard recognises English before/until user decisions without fixed wording', async () => {
  const args = input([passed, { verdict: 'wait', reason: 'The owner has not selected a focus.',
    delivery: { action: 'ask', text: 'Which focus should the final digest use?' },
    userDecision: { kind: 'scope', question: 'Which focus should the final digest use?' } }]);
  args.ticket = {
    ...args.ticket,
    target: 'Collect candidate facts before the owner chooses a focus, then continue the same task.',
    acceptance: 'Deliver the final digest after the owner choice.',
    mandate: {
      instruction: 'Research the candidates. The user must choose a focus before the worker continues.',
      acceptance: 'After the user selects, complete and deliver the final digest.',
    },
  };
  args.result = { ...args.result, finalSummary: 'Candidate facts are ready. Please choose a focus before I continue.' };
  const review = await reviewTicketResult(args);
  assert.equal(review.verdict, 'wait');
  assert.equal(review.waitKind, 'blocked');
  assert.equal(review.delivery.action, 'ask');
  assert.equal(review.delivery.text, 'Which focus should the final digest use?');
});

test('review receives the exact answered Attention for this run and does not lose it on retry', async () => {
  const answers = [{ attentionId: 'attention-1', question: { id: 'focus', question: 'Which focus?' }, answer: { selected: [], custom: 'AI technology first' } }];
  let payload;
  const args = input([passed], request => { payload = JSON.parse(request.messages[1].content[0].text); });
  args.ticket = { ...args.ticket, instructionRevision: 1, mandate: { instruction: 'After the user chooses, deliver the digest.', acceptance: 'Use the saved focus.' } };
  args.result = { ...args.result, runId: 'run-1', sessionId: 'session-1', finalSummary: 'Final digest uses AI technology first.' };
  args.answeredAttentions = answers;
  const review = await reviewTicketResult(args);
  assert.equal(review.verdict, 'passed');
  assert.deepEqual(payload.answeredAttentions, answers);

  let secondPayload;
  const retry = input([passed], request => { secondPayload = JSON.parse(request.messages[1].content[0].text); });
  retry.ticket = args.ticket;
  retry.result = args.result;
  retry.answeredAttentions = [];
  const retryReview = await reviewTicketResult(retry);
  assert.equal(retryReview.verdict, 'passed');
  assert.deepEqual(secondPayload.answeredAttentions, []);
  assert.notEqual(review.inputHash, retryReview.inputHash);
});

test('first verified delivery forbids silent even after a system status was delivered', async () => {
  const args = input([{ verdict: 'passed', reason: 'verified', delivery: { action: 'silent' } }], request => {
    const payload = JSON.parse(request.messages[1].content[0].text);
    assert.equal(payload.publicationContext.hasPreviouslyDelivered, false);
    assert.equal(payload.publicationContext.silentAllowed, false);
    assert.match(request.messages[0].content[0].text, /Never choose silent or treat Worker output, saved results or earlier system status notifications as delivery/);
  });
  args.ticket = { ...args.ticket, instructionRevision: 1, resultVersion: 2 };
  args.result = { ...args.result, transcript: { hash: 'verified-transcript' } };
  args.database = {
    results: () => [{ ...args.result, instructionRevision: 1, review: { verdict: 'wait' }, delivery: { action: 'deliver', origin: 'system', text: 'system status' } }],
    deliveries: () => [{ state: 'sent', payload: { resultVersion: 2, publication: { action: 'deliver', origin: 'system' } }, receipt: { status: 'accepted' } }],
    ticketGoalBudget: () => undefined,
  };
  const result = await recoverableReview(reviewTicketResult, args);
  assert.equal(result.waitKind, 'review_wait');
  assert.equal(result.diagnostic.stream.schemaCode, 'SILENT_NOT_ALLOWED');
  assert.equal(result.delivery.origin, 'system');
});

test('silent eligibility requires the exact passed result and a non-system accepted delivery receipt', async () => {
  for (const variation of ['unchanged', 'changed', 'unsent', 'unverified', 'system-publication', 'system-receipt', 'wrong-version']) {
    const allowed = variation === 'unchanged';
    const args = input([{ verdict: 'passed', reason: 'verified', delivery: { action: 'silent' } }], request => {
      const context = JSON.parse(request.messages[1].content[0].text).publicationContext;
      assert.equal(context.silentAllowed, allowed);
      assert.equal(context.hasPreviouslyDelivered, ['unchanged', 'changed'].includes(variation));
    });
    args.ticket = { ...args.ticket, instructionRevision: 1, resultVersion: 2 };
    args.result = { ...args.result, version: 2, transcript: { hash: 'verified-transcript' } };
    const previous = { ...args.result, instructionRevision: 1, review: { verdict: variation === 'unverified' ? 'wait' : 'passed' }, delivery: { action: 'deliver', text: 'verified answer' } };
    if (variation === 'system-publication') previous.delivery.origin = 'system';
    if (variation === 'changed') previous.summary = 'older answer';
    args.database = { results: () => [previous], deliveries: () => [{ state: variation === 'unsent' ? 'queued' : 'sent', payload: { type: 'ticket.result', instructionRevision: 1, resultVersion: variation === 'wrong-version' ? 1 : 2, publication: variation === 'system-receipt' ? { ...previous.delivery, origin: 'system' } : previous.delivery }, receipt: { status: 'accepted' } }], ticketGoalBudget: () => undefined };
    const result = await recoverableReview(reviewTicketResult, args);
    if (allowed) { assert.equal(result.verdict, 'passed'); assert.equal(result.delivery.action, 'silent'); }
    else { assert.equal(result.waitKind, 'review_wait'); assert.equal(result.diagnostic.stream.schemaCode, 'SILENT_NOT_ALLOWED'); }
  }
});

test('review schema faults retain only an allowlisted safe subtype', async () => {
  for (const [response, schemaCode] of [
    [{ verdict: 'passed', reason: 'ok', delivery: { action: 'deliver' } }, 'MISSING_DELIVERY_TEXT'],
    [{ verdict: 'passed', reason: 'ok', delivery: { action: 'ask', text: 'Confirm?' }, userDecision: { kind: 'information', question: 'Confirm?' } }, 'INVALID_ASK'],
    [{ verdict: 'rework', reason: 'fix', delivery: { action: 'deliver', text: 'fixing' } }, 'CORRECTION_FIELDS'],
  ]) {
    const result = await recoverableReview(reviewTicketResult, input([response]));
    assert.equal(result.waitKind, 'review_wait');
    assert.equal(result.diagnostic.stream.quality, 'INVALID_DECISION');
    assert.equal(result.diagnostic.stream.schemaCode, schemaCode);
    assert.equal(JSON.stringify(result).includes('Confirm?'), false);
    assert.equal(JSON.stringify(result).includes('fixing'), false);
  }
});

test('internal model waits retry automatically and cannot impersonate a user decision', async () => {
  const verdict = await reviewTicketResult(input([{ verdict: 'wait', reason: 'source pages still loading', delivery: { action: 'deliver', text: '原始页面尚未完成核对，结果已保留，我会继续核验。' } }]));
  assert.equal(verdict.waitKind, 'review_wait'); assert.equal(verdict.retryable, true); assert.equal(verdict.userDecision, undefined);
  for (const response of [
    { verdict: 'wait', reason: 'wait', delivery: { action: 'silent' } },
    { verdict: 'passed', reason: 'ok', delivery: { action: 'ask', text: 'Confirm?' }, userDecision: { kind: 'information', question: 'Confirm?' } },
    { ...passed, delivery: { action: 'deliver', text: 'status', origin: 'system', systemState: { state: 'review_wait', code: 'FAKE', stage: 'review' } } },
  ]) await assert.rejects(reviewTicketResult(input([response])), /格式/);
});

test('corrected final deliverable is distinct from rejected drafts retained in the same transcript', async () => {
  const args = input([passed], request => {
    const prompt = request.messages[0].content[0].text;
    const payload = JSON.parse(request.messages[1].content[0].text);
    assert.match(prompt, /never count an earlier rejected draft as part of the corrected final deliverable/);
    assert.equal(payload.result.finalSummary, 'Corrected final digest: 8 items');
    assert.match(payload.result.summary, /Rejected draft: 14 items/);
  });
  args.result = { ...args.result, summary: 'Rejected draft: 14 items\nCorrected final digest: 8 items', finalSummary: 'Corrected final digest: 8 items' };
  assert.equal((await reviewTicketResult(args)).verdict, 'passed');
});

test('transport faults are explicit system states without raw provider text or fake AI reports', async () => {
  const args = input([passed]);
  const result = await recoverableReview(async () => { throw Object.assign(new Error('secret provider body'), { code: 'NETWORK' }); }, args);
  assert.equal(result.waitKind, 'review_wait'); assert.equal(result.retryable, true);
  assert.equal(result.delivery.origin, 'system'); assert.match(result.delivery.text, /^系统状态/);
  assert.equal(result.diagnostic.code, 'NETWORK'); assert.doesNotMatch(JSON.stringify(result), /secret/);
  const missing = await reviewTicketResult({ ...args, model: undefined });
  assert.equal(missing.delivery.systemState.code, 'ROUTER_MODEL_UNAVAILABLE');
  const empty = await reviewTicketResult({ ...args, result: { summary: '', evidenceRefs: [] } });
  assert.equal(empty.delivery.systemState.code, 'RESULT_EVIDENCE_PENDING');
});

test('review allows a bounded full digest response and retains configured model output limits', async () => {
  for (const explicit of [undefined, 7777]) {
    const args = input([passed], request => assert.equal(request.maxTokens, explicit ?? 12288));
    if (explicit) args.model.options = { maxTokens: explicit };
    assert.equal((await reviewTicketResult(args)).verdict, 'passed');
  }
});

test('review output truncation persists only safe metadata and remains an internal wait', async () => {
  const args = input([passed]);
  args.llm = { async *stream() {
    yield { type: 'reasoning-delta', text: 'private reasoning secret' };
    yield { type: 'text-delta', text: '{"private incomplete body"' };
    yield { type: 'finish', reason: { kind: 'max-tokens' } };
  } };
  const verdict = await recoverableReview(reviewTicketResult, args);
  assert.equal(verdict.verdict, 'wait');
  assert.equal(verdict.waitKind, 'review_wait');
  assert.equal(verdict.retryable, true);
  assert.equal(verdict.diagnostic.stream.quality, 'MAX_TOKENS');
  assert.equal(verdict.diagnostic.stream.finishKind, 'max-tokens');
  assert.equal(verdict.diagnostic.stream.maxTokens, 12288);
  assert.equal(verdict.userDecision, undefined);
  assert.doesNotMatch(JSON.stringify(verdict), /private|secret|incomplete body/);
});

test('main review corrects an invalid ask shape once without inventing or replacing the Router report', async () => {
  const question = '最终文档采用哪一份已批准模板？';
  const args = input([
    { verdict: 'passed', reason: 'template unknown', delivery: { action: 'ask', text: question } },
    { verdict: 'wait', reason: '必须使用用户已批准的模板。', delivery: { action: 'ask', text: question }, userDecision: { kind: 'information', question } },
  ], (request, attempt) => {
    if (attempt === 1) assert.match(request.messages.at(-1).content[0].text, /INVALID_ASK/);
  });
  const result = await reviewTicketResult(args);
  assert.equal(result.waitKind, 'blocked');
  assert.equal(result.userDecision.question, question);
  assert.equal(result.delivery.text, question);
  assert.equal(result.routing.attempts.length, 2);
});

test('review auxiliary outage falls back to main without changing task acceptance', async () => {
  const args = input([passed]), models = [];
  args.ticket.acceptance = '仅总结本地文档的三个既定要点。';
  args.routingConfig = { auxiliary: { capabilities: ['review'], models: [{ providerId: 'aux', modelId: 'Aux/Opaque' }] } };
  args.llm = { async *stream(request) {
    models.push(request.model);
    assert.equal(JSON.parse(request.messages[1].content[0].text).taskContract.acceptance, args.ticket.acceptance);
    if (request.provider === 'aux') throw Object.assign(new Error('unavailable'), { code: 'NO_ADAPTER' });
    yield { type: 'text-delta', text: JSON.stringify(passed) }; yield { type: 'finish', reason: { kind: 'stop' } };
  } };
  assert.equal((await reviewTicketResult(args)).verdict, 'passed');
  assert.deepEqual(models, ['Aux/Opaque', 'opaque']);
});

test('all evidence rounds share a bounded request allowance and exhaustion remains a system wait', async () => {
  const args = input([passed]); let calls = 0;
  args.routingConfig = { auxiliary: { capabilities: ['review'], models: [{ providerId: 'aux', modelId: 'aux' }] } };
  args.readEvidence = reader();
  args.llm = { async *stream(request) {
    calls++;
    if (request.provider === 'aux') throw Object.assign(new Error('unavailable'), { code: 'NO_ADAPTER' });
    yield { type: 'text-delta', text: JSON.stringify({ readEvidence: [{ seq: 8 }] }) }; yield { type: 'finish', reason: { kind: 'stop' } };
  } };
  const result = await recoverableReview(reviewTicketResult, args);
  assert.equal(calls, 6);
  assert.equal(args.readEvidence.count(), 3);
  assert.equal(result.waitKind, 'review_wait');
  assert.equal(result.delivery.origin, 'system');
  assert.equal(result.delivery.systemState.code, 'REVIEW_REQUEST_LIMIT');
  assert.equal(result.retryable, true);
  assert.equal(result.routing.attempts.length, 6);
  assert.deepEqual(result.routing.attempts.map(row => row.status), ['failed', 'completed', 'failed', 'completed', 'failed', 'completed']);
});
