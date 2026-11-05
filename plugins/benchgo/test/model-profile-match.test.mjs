import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import { applyModelProfile, matchModelProfile, modelProfilePatch } from '../client/model-profile-match.mjs';

const catalog = [
  { model_id: 'gpt-5.4', model_name: 'GPT-5.4', context: 1050000, max_output: 128000, input_modalities: [], thinking_levels: ['low', 'medium', 'high', 'xhigh'] },
  { model_id: 'deepseek-v4-flash', model_name: 'DeepSeek V4 Flash', context: 1048576, max_output: 393216, input_modalities: ['text', 'image', 'video'], thinking_levels: ['low', 'high', 'max'] },
  { model_id: 'deepseek-v4.1-flash', model_name: 'DeepSeek V4.1 Flash 1017', context: 1048576, max_output: 393216, input_modalities: ['text', 'image'], thinking_levels: ['min', 'high'] },
  { model_id: 'gpt-image-2', model_name: 'gpt-image-2', context: 0, max_output: 0, input_modalities: ['text', 'image'], thinking_levels: [] },
  { model_name: 'Command R' },
  { model_name: 'Command R+' },
];

test('supplier IDs match exact model_id only and never a display name or prefix', () => {
  assert.equal(matchModelProfile('gpt-5.4', catalog).model_name, 'GPT-5.4');
  assert.equal(matchModelProfile(' deepseek v4 flash ', catalog), undefined);
  assert.equal(matchModelProfile('GPT-5.4', catalog), undefined);
  assert.equal(matchModelProfile('gpt-5.4', [...catalog, catalog[0]]), undefined);
  assert.equal(matchModelProfile('deepseek-v4', catalog), undefined);
  assert.equal(matchModelProfile('deepseek-v4.1-flash', catalog).model_name, 'DeepSeek V4.1 Flash 1017');
  assert.equal(matchModelProfile('command-r', catalog), undefined);
  assert.equal(matchModelProfile('', catalog), undefined);
});

test('aliases are never guessed', () => {
  assert.equal(matchModelProfile('gpt-image-2.5', catalog), undefined);
  assert.equal(matchModelProfile('missing-model', catalog), undefined);
});

test('profile facts fill only supported empty fields and preserve manual values', () => {
  const row = matchModelProfile('gpt-5.4', catalog);
  assert.deepEqual(modelProfilePatch(row, { reasoning: true }), {
    contextWindow: 1050000,
    maxTokens: 128000,
    reasoningEfforts: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' },
  });
  const manual = { id: 'gpt-5.4', contextWindow: 4000, compat: { supportsReasoningEffort: true } };
  const applied = applyModelProfile(manual, row, { reasoning: true });
  assert.equal(applied.matched, true);
  assert.equal(applied.model.contextWindow, 4000);
  assert.equal(applied.model.maxTokens, 128000);
  assert.deepEqual(applied.model.compat, manual.compat);
  assert.equal(applyModelProfile({ id: 'gpt-image-2.5', input: ['text'] }, matchModelProfile('gpt-image-2.5', catalog)).matched, false);
});

test('reasoning is omitted unless requested and min maps to minimal', () => {
  const row = matchModelProfile('deepseek-v4.1-flash', catalog);
  assert.equal(modelProfilePatch(row).reasoningEfforts, undefined);
  assert.deepEqual(modelProfilePatch(row, { reasoning: true }).reasoningEfforts, { minimal: 'min', high: 'high' });
  assert.deepEqual(modelProfilePatch(row).input, ['text', 'image']);
});

const profileCode = transformSync(readFileSync(new URL('../client/model-profile.jsx', import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs' }).code;
function mountProfile(fetcher) {
  const refs = []; let cursor = 0, cleanup, timer, previousDeps;
  const react = {
    useRef(initial) { return refs[cursor++] ||= { current: initial }; },
    useEffect(effect, deps) { if (previousDeps && deps.every((value, at) => Object.is(value, previousDeps[at]))) return; cleanup?.(); previousDeps = deps; cleanup = effect(); },
  };
  const module = { exports: {} };
  runInNewContext(profileCode, { module, exports: module.exports, AbortSignal, URL, document: { baseURI: 'http://localhost:4000/' }, fetch: fetcher, setTimeout: fn => { timer = fn; return 1; }, clearTimeout: () => { timer = null; }, require: id => id.endsWith('model-profile-match.mjs') ? { applyModelProfile, matchModelProfile } : react });
  return { render(models, onChange, disabled = false) { cursor = 0; return module.exports.useNewModelProfiles(models, onChange, disabled); }, async flush() { const fn = timer; timer = null; await fn?.(); }, clean() { cleanup?.(); } };
}

test('only newly added models silently match in one batch without overriding manual values', async () => {
  let requests = 0, result;
  const view = mountProfile(async () => { requests++; return { ok: true, json: async () => ({ success: true, data: [{ model_id: 'gpt-5.4', context: 1050000, max_output: 128000 }, { model_id: 'Other', context: 50000 }] }) }; });
  const existing = { id: 'Other' };
  assert.equal(view.render([existing], value => { result = value; }), undefined);
  await view.flush(); assert.equal(requests, 0);
  view.render([existing, { id: 'gpt-5.4', contextWindow: 4000 }], value => { result = value; });
  await view.flush();
  assert.equal(requests, 1); assert.equal(result[0], existing);
  assert.equal(result[1].contextWindow, 4000); assert.equal(result[1].maxTokens, 128000);
  view.render(result, () => assert.fail('must not rematch')); await view.flush();
  assert.equal(requests, 1); view.clean();
});

test('unavailable reference data is silent and never changes the draft', async () => {
  const view = mountProfile(async () => { throw Error('Failed to fetch'); });
  view.render([], () => assert.fail('unexpected change'));
  view.render([{ id: 'Opaque:ID' }], () => assert.fail('unexpected change'));
  await view.flush(); view.clean();
});

test('ordinary rerenders with cloned rows preserve pending enrichment', async () => {
  let finish, result;
  const view = mountProfile((url, options) => {
    assert.equal(String(url), 'http://localhost:4000/api/commander/tooling');
    assert.equal(JSON.parse(options.body).action, 'modelProfiles');
    return new Promise(resolve => { finish = resolve; });
  });
  view.render([], () => {});
  view.render([{ id: 'gpt-6.1-sol' }], value => { result = value; });
  const pending = view.flush();
  view.render([{ id: 'gpt-6.1-sol' }], value => { result = value; });
  finish({ ok: true, json: async () => ({ success: true, data: [{ model_id: 'gpt-6.1-sol', context: 1050000, max_output: 128000, thinking_levels: ['high'] }] }) });
  await pending;
  assert.equal(result[0].contextWindow, 1050000);
  assert.equal(result[0].maxTokens, 128000);
  assert.deepEqual(result[0].reasoningEfforts, { high: 'high' });
  view.clean();
});

test('save or unmount invalidates pending enrichment', async () => {
  let finish;
  const view = mountProfile(() => new Promise(resolve => { finish = resolve; }));
  view.render([], () => {});
  view.render([{ id: 'gpt-5.4' }], () => assert.fail('late write'));
  const pending = view.flush(); view.clean();
  finish({ ok: true, json: async () => ({ success: true, data: [{ model_id: 'gpt-5.4', context: 10000 }] }) });
  await pending;
});
