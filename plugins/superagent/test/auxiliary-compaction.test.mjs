import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuxiliaryCompactionHook } from '../src/auxiliary-compaction.mjs';

const models = [{ providerId: 'aux', modelId: 'opaque/a' }, { providerId: 'backup', modelId: 'opaque B' }, { providerId: 'third', modelId: 'unused' }];
const config = () => ({ auxiliary: { capabilities: ['compression'], models } });
const collect = async stream => { const result = []; for await (const chunk of stream) result.push(chunk); return result; };
const text = value => ({ type: 'text-delta', index: 0, text: value });
const stop = { type: 'finish', reason: { kind: 'stop' } };

test('compaction buffers failed output and records exact successful fallback route', async () => {
  const options = { purpose: 'compaction', provider: 'main', model: 'main', maxTokens: 2048, reasoningEffort: 'old' };
  const seen = [];
  const hook = createAuxiliaryCompactionHook({ getConfig: config });
  const result = await collect(hook(options, async function* () {
    seen.push({ ...options });
    yield text(options.provider);
    yield options.provider === 'aux' ? { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT' } } } : stop;
  }));
  assert.deepEqual(result, [text('backup'), stop]);
  assert.deepEqual(seen.map(row => row.model), ['opaque/a', 'opaque/a', 'opaque B']);
  assert.equal(options.model, 'opaque B');
  assert.equal(options.maxTokens, 2048);
  assert.equal('reasoningEffort' in options, false);
});

test('ordinary calls and unassigned compaction pass through unchanged', async () => {
  for (const [purpose, auxiliary] of [['chat', config().auxiliary], ['compaction', null]]) {
    const options = { purpose, provider: 'main', model: 'm' };
    const hook = createAuxiliaryCompactionHook({ getConfig: () => ({ auxiliary }) });
    assert.deepEqual(await collect(hook(options, async function* () { yield stop; })), [stop]);
    assert.equal(options.provider, 'main');
  }
});

test('all configured fallbacks are tried, while refusal and aborted finish never retry', async () => {
  for (const reason of [{ kind: 'error', failure: { code: 'RATE_LIMIT' } }, { kind: 'error', failure: { status: 400 } }, { kind: 'aborted', failure: { code: 'RATE_LIMIT' } }]) {
    let calls = 0;
    const hook = createAuxiliaryCompactionHook({ getConfig: config });
    const result = await collect(hook({ purpose: 'compaction' }, async function* () { calls++; yield { type: 'finish', reason }; }));
    assert.equal(calls, reason.failure.code === 'RATE_LIMIT' && reason.kind === 'error' ? 6 : 1);
    assert.deepEqual(result, [{ type: 'finish', reason }]);
  }
});

test('abort discards all buffered chunks and never dispatches fallback', async () => {
  const controller = new AbortController();
  let calls = 0;
  const hook = createAuxiliaryCompactionHook({ getConfig: config });
  await assert.rejects(collect(hook({ purpose: 'compaction', signal: controller.signal }, async function* () {
    calls++; yield text('partial'); controller.abort(); yield stop;
  })), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('incomplete and oversized streams fail closed without fallback', async () => {
  for (const maxBufferedBytes of [1, 4096]) {
    let calls = 0;
    const hook = createAuxiliaryCompactionHook({ getConfig: config, maxBufferedBytes });
    await assert.rejects(collect(hook({ purpose: 'compaction' }, async function* () { calls++; yield text('partial'); })), { code: maxBufferedBytes === 1 ? 'COMPACTION_BUFFER_LIMIT' : 'COMPACTION_INCOMPLETE_STREAM' });
    assert.equal(calls, 1);
  }
});

test('identical fallback preserves terminal failure instead of ending silently', async () => {
  const model = { providerId: 'same', modelId: 'opaque' };
  const hook = createAuxiliaryCompactionHook({ getConfig: () => ({ auxiliary: { capabilities: ['compression'], models: [model] } }) });
  const failure = { type: 'finish', reason: { kind: 'error', failure: { status: 401 } } };
  assert.deepEqual(await collect(hook({ purpose: 'compaction', provider: 'same', model: 'opaque' }, async function* () { yield failure; })), [failure]);
});

test('thrown transient failures retry once before switching without leaking partial output', async () => {
  const options = { purpose: 'compaction', provider: 'main', model: 'main' };
  const seen = [];
  const hook = createAuxiliaryCompactionHook({ getConfig: config });
  const result = await collect(hook(options, async function* () {
    seen.push(options.provider);
    if (options.provider === 'aux') { yield text('discard'); throw Object.assign(new Error('busy'), { status: 503 }); }
    yield text('complete'); yield stop;
  }));
  assert.deepEqual(seen, ['aux', 'aux', 'backup']);
  assert.deepEqual(result, [text('complete'), stop]);
});


test('compaction reaches the third configured model before main and reports its route', async () => {
  const seen = [], records = [];
  const options = { purpose: 'compaction', provider: 'main', model: 'main' };
  const hook = createAuxiliaryCompactionHook({ getConfig: config, onRoute: route => records.push(route) });
  const result = await collect(hook(options, async function* () {
    seen.push([options.provider, options.model]);
    yield text(options.provider);
    yield options.provider === 'third' ? stop : { type: 'finish', reason: { kind: 'error', failure: { status: 401 } } };
  }));
  assert.deepEqual(seen, [['aux', 'opaque/a'], ['backup', 'opaque B'], ['third', 'unused']]);
  assert.deepEqual(result, [text('third'), stop]);
  assert.deepEqual(records[0].attempts.map(row => row.status), ['failed', 'failed', 'completed']);
});
