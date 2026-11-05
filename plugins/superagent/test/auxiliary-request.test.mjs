import test from 'node:test';
import assert from 'node:assert/strict';
import { collectAuxiliaryText, auxiliaryFailureDiagnostic, auxiliaryFailureRouting } from '../src/auxiliary-request.mjs';
import { TICKET_REVIEW_REQUEST_POLICY, ticketReviewRequestBudget } from '../src/review-policy.mjs';

const main = { providerId: 'main', modelId: 'main/opaque', options: { maxTokens: 123 } };
const config = () => ({ revision: 7, auxiliary: { capabilities: ['review'], models: [
  { providerId: 'aux', modelId: 'Opaque A', options: { maxTokens: 321, reasoningEffort: 'low' } },
  { providerId: 'backup', modelId: 'Opaque B' },
  { providerId: 'unused', modelId: 'Opaque C' },
] } });
const stop = { type: 'finish', reason: { kind: 'stop' } };
const delta = text => ({ type: 'text-delta', text });
const failed = failure => ({ type: 'finish', reason: { kind: 'error', failure } });
const run = (stream, extra = {}) => collectAuxiliaryText({ llm: { stream }, config: config(), capability: 'review', model: main, request: { tools: [{ name: 'forbidden' }], maxTokens: 100 }, ...extra });

test('auxiliary request freezes configuration and discards failed text before one backup switch', async () => {
  const settings = config(), seen = [];
  const result = await run(async function* (request) {
    seen.push(request);
    assert.deepEqual(request.tools, []);
    if (request.provider === 'aux') {
      settings.revision = 8;
      settings.auxiliary.models[1].modelId = 'changed';
      yield delta('discard this');
      yield failed({ code: 'RATE_LIMIT', status: 429 });
    } else { yield delta('valid'); yield stop; }
  }, { config: settings });
  assert.equal(result.text, 'valid');
  assert.deepEqual(seen.map(row => [row.provider, row.model]), [['aux', 'Opaque A'], ['aux', 'Opaque A'], ['backup', 'Opaque B']]);
  assert.equal(seen[0].maxTokens, 321);
  assert.equal(seen[0].reasoningEffort, 'low');
  assert.equal(result.routing.configRevision, 7);
  assert.equal(result.routing.switched, true);
  assert.deepEqual(result.routing.attempts.map(row => [row.retry, row.status]), [[0, 'failed'], [1, 'failed'], [0, 'completed']]);
});

test('invalid structured output returns directly to main model with its exact options', async () => {
  const seen = [];
  const result = await run(async function* (request) {
    seen.push(request);
    yield delta(request.provider === 'aux' ? 'bad json' : '{"verdict":"pass"}'); yield stop;
  }, { validate: JSON.parse });
  assert.deepEqual(seen.map(row => row.provider), ['aux', 'main']);
  assert.equal(seen[1].model, main.modelId);
  assert.equal(seen[1].maxTokens, 123);
  assert.equal(seen[1].reasoningEffort, undefined);
  assert.equal(result.routing.attempts[0].code, 'AUXILIARY_QUALITY');
});

test('transient failures exhaust all configured models in order before main', async () => {
  const seen = [];
  await assert.rejects(run(async function* (request) {
    seen.push(request.provider); throw Object.assign(new Error('unavailable'), { status: 503 });
  }), /unavailable/);
  assert.deepEqual(seen, ['aux', 'aux', 'backup', 'backup', 'unused', 'unused', 'main', 'main']);
});

test('policy denial and aborted completion do not retry or switch models', async () => {
  for (const reason of [
    { kind: 'error', failure: { message: 'denied', status: 403 } },
    { kind: 'error', failure: { message: 'refused', refusal: true, status: 503 } },
    { kind: 'aborted' },
  ]) {
    let calls = 0;
    await assert.rejects(run(async function* () { calls++; yield { type: 'finish', reason }; }));
    assert.equal(calls, 1);
  }
});

test('signal cancellation discards partial response without dispatching a fallback', async () => {
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(run(async function* () {
    calls++; yield delta('partial'); controller.abort(); yield stop;
  }, { request: { signal: controller.signal } }), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('unassigned capabilities keep main model and never invoke auxiliary fallback', async () => {
  const seen = [];
  const result = await run(async function* (request) { seen.push(request.provider); yield delta('main answer'); yield stop; }, { capability: 'summary' });
  assert.deepEqual(seen, ['main']);
  assert.equal(result.routing.auxiliary, false);
  assert.equal(result.routing.switched, false);
});

test('tool calls and incomplete output cannot publish as successful auxiliary results', async () => {
  for (const bad of [
    [{ type: 'block-end', block: { type: 'tool-call', name: 'forbidden' } }, stop],
    [delta('unfinished')],
    [stop],
  ]) {
    const seen = [];
    const result = await run(async function* (request) {
      seen.push(request.provider);
      if (request.provider === 'aux') yield* bad;
      else { yield delta('safe result'); yield stop; }
    });
    assert.deepEqual(seen, ['aux', 'main']);
    assert.equal(result.text, 'safe result');
  }
});


test('third configured auxiliary model succeeds with its opaque ID intact', async () => {
  const seen = [];
  const result = await run(async function* (request) {
    seen.push([request.provider, request.model]);
    if (request.provider !== 'unused') { yield delta('discard'); yield failed({ status: 401 }); }
    else { yield delta('third result'); yield stop; }
  });
  assert.deepEqual(seen, [['aux', 'Opaque A'], ['backup', 'Opaque B'], ['unused', 'Opaque C']]);
  assert.equal(result.text, 'third result');
  assert.deepEqual(result.routing.attempts.map(row => row.status), ['failed', 'failed', 'completed']);
});

test('review without an auxiliary assignment follows explicit then configured model order', async () => {
  const calls = [];
  const llm = { async *stream(options) {
    calls.push(options.model);
    if (options.model !== 'third') { yield { type: 'finish', reason: { kind: 'error', failure: { code: 'INVALID_CREDENTIAL', status: 401 } } }; return; }
    yield { type: 'text-delta', text: 'accepted' }; yield { type: 'finish', reason: { kind: 'stop' } };
  } };
  const result = await collectAuxiliaryText({ llm, config: { models: ['second', 'third'].map(modelId => ({ providerId: 'test', modelId })) }, capability: 'review', model: { providerId: 'test', modelId: 'Explicit/opaque' }, request: {} });
  assert.equal(result.text, 'accepted');
  assert.deepEqual(calls, ['Explicit/opaque', 'second', 'third']);
});

test('quality failures distinguish output limits, absent text and invalid structure without retaining private content', async () => {
  const cases = [
    { chunks: [delta('{"partial":'), { type: 'finish', reason: { kind: 'max-tokens' } }], quality: 'MAX_TOKENS', finishKind: 'max-tokens', hasText: true },
    { chunks: [stop], quality: 'EMPTY_TEXT', finishKind: 'stop', hasText: false },
    { chunks: [delta('invalid response secret'), stop], quality: 'INVALID_JSON', finishKind: 'stop', hasText: true },
    { chunks: [delta('{}'), stop], quality: 'INVALID_DECISION', finishKind: 'stop', hasText: true, validate: () => { throw new Error('invalid contract secret'); } },
  ];
  for (const item of cases) {
    let error;
    try {
      await collectAuxiliaryText({ llm: { async *stream() { yield { type: 'reasoning-delta', text: 'private reasoning secret' }; yield* item.chunks; } },
        config: {}, capability: 'review', model: { providerId: 'p', modelId: 'opaque' }, request: { maxTokens: 12288 }, validate: item.validate || JSON.parse });
    } catch (caught) { error = caught; }
    assert.equal(error?.code, 'AUXILIARY_QUALITY');
    const diagnostic = auxiliaryFailureDiagnostic(error);
    assert.equal(diagnostic.quality, item.quality);
    assert.equal(diagnostic.finishKind, item.finishKind);
    assert.equal(diagnostic.hasText, item.hasText);
    assert.equal(diagnostic.maxTokens, 12288);
    assert.ok(Number.isSafeInteger(diagnostic.textCharacters));
    assert.doesNotMatch(JSON.stringify(diagnostic), /secret|reasoning|partial|contract/);
  }
});

test('unknown schema subtypes never cross the safe diagnostic boundary', async () => {
  const error = Object.assign(new Error('quality'), { code: 'AUXILIARY_QUALITY', quality: 'INVALID_DECISION', reviewSchemaCode: 'MALICIOUS_PROVIDER_TEXT' });
  const seen = [];
  try {
    await collectAuxiliaryText({ llm: { async *stream() { yield delta('{}'); yield stop; } }, config: {}, capability: 'review', model: { providerId: 'p', modelId: 'opaque' }, request: { maxTokens: 12288 }, validate: () => { throw error; } });
  } catch (caught) { seen.push(auxiliaryFailureDiagnostic(caught)); }
  assert.equal(seen.length, 1);
  assert.equal(seen[0].schemaCode, undefined);
  assert.equal(JSON.stringify(seen[0]).includes('MALICIOUS_PROVIDER_TEXT'), false);
});

test('safe stream diagnostics preserve the real provider error without exposing its body', async () => {
  const providerError = Object.assign(new Error('private provider body'), { code: 'HTTP', status: 400 });
  await assert.rejects(collectAuxiliaryText({ llm: { async *stream() { throw providerError; } },
    config: {}, capability: 'review', model: { providerId: 'p', modelId: 'opaque' }, request: { maxTokens: 12288 } }), error => error === providerError);
  assert.deepEqual(auxiliaryFailureDiagnostic(providerError), { finishKind: 'missing', textCharacters: 0, hasText: false, maxTokens: 12288 });
});

test('review gives a stalled auxiliary a separate deadline and preserves main fallback time', async () => {
  const seen = [], parent = new AbortController();
  const result = await run(async function* (request) {
    seen.push(request);
    if (request.provider === 'aux') await new Promise(() => {});
    yield delta('verified'); yield stop;
  }, { request: { signal: parent.signal }, policy: { ...TICKET_REVIEW_REQUEST_POLICY, attemptTimeoutMs: 15 } });
  assert.deepEqual(seen.map(row => row.provider), ['aux', 'main']);
  assert.equal(seen[0].signal.aborted, true);
  assert.equal(parent.signal.aborted, false);
  assert.equal(result.text, 'verified');
  assert.equal(result.routing.attempts[0].code, 'TIMEOUT');
});

test('review goes directly to main on auxiliary outage and preserves opaque options', async () => {
  const seen = [];
  const result = await run(async function* (request) {
    seen.push(request);
    if (request.provider === 'aux') throw Object.assign(new Error('unavailable'), { status: 503 });
    yield delta('verified'); yield stop;
  }, { policy: TICKET_REVIEW_REQUEST_POLICY });
  assert.deepEqual(seen.map(row => row.provider), ['aux', 'main']);
  assert.equal(seen[1].model, main.modelId);
  assert.equal(seen[1].maxTokens, 123);
  assert.equal(result.text, 'verified');
});

test('review repairs main schema once using only safe classification and original evidence', async () => {
  const seen = [];
  const result = await run(async function* (request) {
    seen.push(request);
    yield delta(seen.length === 1 ? 'private malformed response' : '{"ok":true}'); yield stop;
  }, { config: {}, validate: JSON.parse, request: { messages: [{ role: 'user', content: [{ type: 'text', text: 'original evidence' }] }] }, policy: TICKET_REVIEW_REQUEST_POLICY });
  assert.deepEqual(seen.map(row => row.provider), ['main', 'main']);
  assert.equal(result.text, '{"ok":true}');
  assert.match(JSON.stringify(seen[1].messages), /original evidence/);
  assert.match(JSON.stringify(seen[1].messages), /INVALID_JSON/);
  assert.doesNotMatch(JSON.stringify(seen[1].messages), /private malformed response/);
});

test('review cannot loop on repeated main schema errors or consume beyond shared allowance', async () => {
  let calls = 0;
  await assert.rejects(run(async function* () { calls++; yield delta('invalid'); yield stop; },
    { config: {}, validate: JSON.parse, policy: TICKET_REVIEW_REQUEST_POLICY }), { code: 'AUXILIARY_QUALITY' });
  assert.equal(calls, 2);
  calls = 0;
  const budget = { remaining: 1 };
  await assert.rejects(run(async function* () { calls++; throw Object.assign(new Error('outage'), { status: 503 }); },
    { policy: TICKET_REVIEW_REQUEST_POLICY, requestBudget: budget }), { code: 'REVIEW_REQUEST_LIMIT' });
  assert.equal(calls, 1);
  assert.equal(budget.remaining, 0);
});

test('bounded review still stops immediately for caller cancellation, refusal and budget denial', async () => {
  for (const error of [Object.assign(new Error('denied'), { code: 'POLICY_DENIED' }), Object.assign(new Error('budget'), { code: 'BENCHGO_GOAL_BUDGET_EXHAUSTED' })]) {
    let calls = 0;
    await assert.rejects(run(async function* () { calls++; throw error; }, { policy: TICKET_REVIEW_REQUEST_POLICY }), candidate => candidate === error);
    assert.equal(calls, 1);
  }
  const controller = new AbortController(); let calls = 0;
  const pending = run(async function* () { calls++; await new Promise(() => {}); }, { request: { signal: controller.signal }, policy: TICKET_REVIEW_REQUEST_POLICY });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('blocked completion and permission denial never dispatch another review model', async () => {
  for (const reason of [{ kind: 'blocked' }, { kind: 'error', failure: { code: 'PERMISSION_DENIED', status: 503 } }]) {
    let calls = 0;
    const requestBudget = ticketReviewRequestBudget();
    await assert.rejects(run(async function* () { calls++; yield { type: 'finish', reason }; },
      { policy: TICKET_REVIEW_REQUEST_POLICY, requestBudget }), error => {
      assert.equal(auxiliaryFailureRouting(error).attempts.length, 1);
      assert.equal(auxiliaryFailureRouting(error).attempts[0].status, 'failed');
      return error.code === (reason.kind === 'blocked' ? 'POLICY_DENIED' : 'PERMISSION_DENIED');
    });
    assert.equal(calls, 1);
    assert.equal(requestBudget.remaining, 5);
  }
});

test('main transient retry does not consume its one schema correction within the hard request limit', async () => {
  const seen = [];
  const result = await run(async function* (request) {
    seen.push(request);
    if (seen.length === 1) throw Object.assign(new Error('unavailable'), { code: 'TIMEOUT' });
    yield delta(seen.length === 2 ? 'private invalid output' : '{"ok":true}'); yield stop;
  }, { config: {}, validate: JSON.parse, policy: TICKET_REVIEW_REQUEST_POLICY });
  assert.equal(result.text, '{"ok":true}');
  assert.equal(seen.length, 3);
  assert.match(JSON.stringify(seen[2].messages), /INVALID_JSON/);
  assert.doesNotMatch(JSON.stringify(seen[2].messages), /private invalid output/);
});

test('auxiliary failure and main transport retry cannot overrun the three-request collection limit', async () => {
  let calls = 0;
  await assert.rejects(run(async function* (request) {
    calls++;
    if (request.provider === 'aux' || calls === 2) throw Object.assign(new Error('unavailable'), { code: 'TIMEOUT' });
    yield delta('invalid'); yield stop;
  }, { validate: JSON.parse, policy: TICKET_REVIEW_REQUEST_POLICY }), error => {
    assert.equal(error.code, 'REVIEW_REQUEST_LIMIT');
    assert.equal(auxiliaryFailureRouting(error).attempts.length, 3);
    return true;
  });
  assert.equal(calls, 3);
});

test('caller deadline stops all routing and retains safe bounded attempt evidence', async () => {
  const controller = new AbortController(); let calls = 0;
  const requestBudget = ticketReviewRequestBudget();
  const pending = run(async function* () { calls++; await new Promise(() => {}); },
    { request: { signal: controller.signal }, policy: TICKET_REVIEW_REQUEST_POLICY, requestBudget });
  controller.abort(new DOMException('private deadline', 'TimeoutError'));
  await assert.rejects(pending, error => {
    const routing = auxiliaryFailureRouting(error);
    assert.equal(routing.attempts.length, 1);
    assert.equal(routing.attempts[0].code, 'TIMEOUT');
    assert.equal(routing.attempts[0].timeoutMs, 45_000);
    assert.ok(Number.isSafeInteger(routing.attempts[0].elapsedMs));
    assert.doesNotMatch(JSON.stringify(routing), /private deadline/);
    return error.name === 'TimeoutError';
  });
  assert.equal(calls, 1);
});
