import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import { officialModelsUi } from '../scripts/official-models-ui.mjs';
import * as reasoning from '../client/model-reasoning-state.mjs';
import { isRouterGo, routerGo } from '../shared/builtin-providers.mjs';
import { hasTextCapability } from '../shared/model-capabilities.mjs';
import * as routerGoAccount from '../shared/routergo-account.mjs';
import * as providerTemplates from '../shared/provider-templates.mjs';
import * as protocolRules from '../../../deepseek-harness/packages/client/ui-settings-models/src/client/protocol-rules.ts';
import { TextSearchIndex } from '../../../deepseek-harness/packages/util/text-search/src/index.ts';

const upstream = new URL('../../../deepseek-harness/packages/client/ui-settings-models/src/client/', import.meta.url);
const handlers = [];
officialModelsUi().setup({ onLoad(match, callback) { handlers.push({ ...match, callback }); } });
const transform = filename => {
  const path = fileURLToPath(new URL(filename, upstream));
  const handler = handlers.find(item => item.filter.test(path));
  assert(handler, 'expected a build-only adapter for ' + filename);
  return handler.callback({ path });
};

test('model adoption never waits on external metadata and loading is explicit', async () => {
  const { contents } = await transform('ModelListEditor.tsx');
  assert.match(contents, /const adoptPicked = \(\): void/);
  assert.match(contents, /onChange\(\[\.\.\.keptRows, \.\.\.addedRows\]\)/);
  assert.match(contents, /listed\.has\(id\) && !isPicked\(id\)/);
  assert.match(contents, /disabled=\{emptiesList\}/);
  assert.doesNotMatch(contents, /withPublicProfile|api\/x\/public\/models/);
  assert.match(contents, /catch \(error\)/);
  assert.match(contents, /aria-busy=\{busy\}/);
  assert.match(contents, /useModelProfiles\(models, onChange, disabled \|\| props.reasoningLevelsOnly === true, true, props.overridden === false, discoveredModels\)/);
  assert.doesNotMatch(contents, /t\('resetModels'\)/);
  assert.match(contents, /cmd-model-discover/);
  assert.match((await transform('ModelsSection.tsx')).contents, /正在加载供应商与模型/);
  const deepseek = await transform('DeepSeekModelsEditor.tsx');
  assert.match(deepseek.contents, /useModelProfiles\(props.models, props.onChange, props.disabled, false, !props.overridden\)/);
  assert.doesNotMatch(deepseek.contents, /props\.t\('resetModels'\)/);
});

test('provider picker adapts official add flow and leaves upstream file unchanged', async () => {
  const path = new URL('ModelsSection.tsx', upstream);
  const original = await readFile(path, 'utf8');
  const { contents } = await transform('ModelsSection.tsx');
  assert(contents.includes('<ProviderAddForm'));
  assert(contents.includes('<ProviderBrandIcon id={row.entry.provider}'));
  assert(contents.includes('declared={row.entry.declared === true}'));
  assert(!contents.includes('<select\n'));
  assert.doesNotMatch(contents, /nativeOptions|nativeRows|nativeNamespace/);
  assert(contents.includes('preset={selection.type === "custom" ? undefined : selection}'));
  assert(!contents.includes("t('customTag')"));
  assert(!contents.includes('<ModelOperations'));
  assert(contents.includes('setAddOpen(false)'));
  assert(contents.includes('deepSeekProviderRow(row, snapshot.namespaces.get(row.entry.settingsNs))'));
  assert(contents.includes('disconnectDeepSeekProvider(operations, controller, deleteTarget.settingsNs, deleteTarget.settingsRevision)'));
  assert.doesNotMatch(contents, /setAddMode|SegmentedControl|addModes/);
  assert.equal(await readFile(path, 'utf8'), original);
});

test('RouterGo owns its identity fields and reuses official credential and settings operations', async () => {
  const { contents } = await transform('CustomProviderCard.tsx');
  for (const field of ['id', 'name', 'baseURL', 'protocol']) assert(contents.includes('props.preset?.' + field));
  assert(contents.includes('normalizeTemplateBaseURL(template, baseURL.trim())'));
  assert(contents.includes('required={requiresKey}'));
  assert(contents.includes('operations.storeCredential('));
  assert(contents.includes('operations.writeSettings('));
  assert(!contents.includes('profileRoute'));
  assert(!contents.includes('/api/plus/providers'));
});

test('official Models CSS remains a scoped module rather than a text export', async () => {
  const { contents, loader } = await transform('ModelsSection.module.css');
  assert.equal(loader, 'js');
  assert(contents.includes('commander-official-models-style'));
  assert(contents.includes('buttonSpinner'));
  assert(contents.includes('commander-button-spin'));
  assert(contents.includes('export default {'));
  assert(contents.includes('"addCard":'));
  assert.doesNotMatch(contents, /addModes|addPanel/);
});

test('official Models stylesheet restores on dependency reactivation and supports overlapping owners', async () => {
  const { contents } = await transform('ModelsSection.module.css');
  const sheets = new Map(), module = { exports: {} };
  const document = {
    getElementById: id => sheets.get(id),
    createElement: () => ({ dataset: {}, remove() { sheets.delete(this.id); } }),
    head: { append(style) { sheets.set(style.id, style); } },
  };
  runInNewContext(transformSync(contents, { loader: 'js', format: 'cjs' }).code, { module, exports: module.exports, document });
  assert.equal(sheets.size, 0, 'module import alone does not own a stylesheet');
  const first = module.exports.mountOfficialModelsStyle(), second = module.exports.mountOfficialModelsStyle();
  assert.equal(sheets.size, 1);
  assert.equal(sheets.values().next().value.dataset.users, '2');
  first(); first(); assert.equal(sheets.size, 1);
  second(); assert.equal(sheets.size, 0);
  const again = module.exports.mountOfficialModelsStyle();
  assert.equal(sheets.size, 1, 'same cached module restores the removed stylesheet');
  again(); assert.equal(sheets.size, 0);
});

test('model editors save through the official API configuration without a Harness field', async () => {
  for (const filename of ['ProviderEditor.tsx', 'CustomProviderCard.tsx']) {
    const path = new URL(filename, upstream), original = await readFile(path, 'utf8');
    const { contents } = await transform(filename);
    assert.doesNotMatch(contents, /useProviderHarness|ProviderHarnessField|harness\.save/);
    if (filename === 'ProviderEditor.tsx') {
      assert(contents.includes('<ProviderBrandIcon id={props.provider}'));
      assert(contents.indexOf('await applyOnce()') < contents.indexOf('props.onClose(true)'));
    } else {
      assert(contents.includes('if (reasoningFailure !== undefined) { setFailure(reasoningFailure); return }'));
      assert(contents.indexOf('await createOnce()') < contents.indexOf('props.onClose(true)'));
    }
    assert.equal(await readFile(path, 'utf8'), original);
  }
});

function elements(node) {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(elements);
  return [node, ...elements(node.props?.children), ...elements(node.props?.actions)];
}
const pick = (tree, type) => elements(tree).find(node => node.type === type);
const plain = value => JSON.parse(JSON.stringify(value));

/** Exercise adapted official render callbacks without mounting the graphical app. */
async function componentHarness(filename) {
  const values = []; let cursor = 0;
  const react = {
    useState(initial) {
      const id = cursor++;
      if (!(id in values)) values[id] = typeof initial === 'function' ? initial() : initial;
      return [values[id], next => { values[id] = typeof next === 'function' ? next(values[id]) : next; }];
    },
    useRef(initial) { const id = cursor++; return values[id] ??= { current: initial }; },
    useMemo: compute => compute(), useEffect() {},
  };
  const primitives = new Proxy({ useRowDragPreview: () => ({ start() {}, clear() { return true; } }) }, { get: (target, key) => target[key] ?? key });
  const deepSeekModels = { modelDrafts: models => models || [], validateDeepSeekModels: () => undefined, formatCapacity: String, parseCapacity: Number, DeepSeekModelsEditor: 'DeepSeekModelsEditor' };
  const jsx = (type, props) => ({ type, props });
  const module = { exports: {} };
  const { contents } = await transform(filename);
  const code = transformSync(contents, { loader: 'tsx', jsx: 'automatic', format: 'cjs' }).code;
  const reasoningEfforts = { exports: {} };
  const reasoningSource = await readFile(new URL('ModelReasoningEfforts.tsx', upstream), 'utf8');
  runInNewContext(transformSync(reasoningSource, { loader: 'tsx', jsx: 'automatic', format: 'cjs' }).code, {
    module: reasoningEfforts, exports: reasoningEfforts.exports,
    require: id => id === 'react' ? react : id.endsWith('DeepSeekModelsEditor.tsx') ? deepSeekModels : primitives,
  });
  runInNewContext(code, {
    module, exports: module.exports, structuredClone, URL,
    require: id => {
      if (id === 'react') return react;
      if (id === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'Fragment' };
      if (id.endsWith('model-profile.jsx')) return { usePublicModelProfiles() {}, useModelProfiles() {}, resolveModelProfiles: async models => models };
      if (id.endsWith('model-capabilities.mjs')) return { hasTextCapability };
      if (id.endsWith('model-catalog-filter.jsx')) return { ModelCatalogFilter: 'ModelCatalogFilter', ModelVendorFilter: 'ModelVendorFilter',
        useCatalogModelProfiles: () => new Map(), filterModelRows: rows => rows };
      if (id.endsWith('model-capabilities.jsx')) return { useModelCapabilities() {}, ModelCapabilityEditor: 'ModelCapabilityEditor',
        modelCatalogFacts: () => ({ capabilities: ['text'], input: [] }) };
      if (id.endsWith('ModelInputTypes.tsx')) return { ModelInputTypes: 'ModelInputTypes' };
      if (id.endsWith('model-reasoning-state.mjs')) return reasoning;
      if (id.endsWith('model-reasoning.jsx')) return { ModelReasoningEditor: 'ModelReasoningEditor' };
      if (id.endsWith('text-search/src/index.ts') || id.endsWith('text-search\\src\\index.ts')) return { TextSearchIndex };
      if (id.endsWith('protocol-rules.ts')) return protocolRules;
      if (id.endsWith('ModelReasoningEfforts.tsx')) return { ...reasoningEfforts.exports, ModelReasoningEfforts: 'ModelReasoningEfforts' };
      if (id.endsWith('useModelRows.ts')) return { useModelRows(models) {
        const [expanded, setExpanded] = react.useState(new Set());
        return { rows: models.map((model, key) => ({ model, key, expanded: expanded.has(key), order: {}, editing: new Map() })),
          toggle(index) { setExpanded(current => { const next = new Set(current); if (!next.delete(index)) next.add(index); return next; }); },
          edit() {}, forget() {}, reset() {} };
      } };
      if (id.endsWith('provider-settings.jsx')) return { ProviderBrandIcon: 'ProviderBrandIcon', isRouterGo, routerGo };
      if (id.endsWith('routergo-account.mjs')) return routerGoAccount;
      if (id.endsWith('provider-templates.mjs')) return providerTemplates;
      if (id.endsWith('DeepSeekModelsEditor.tsx')) return deepSeekModels;
      if (id.endsWith('apiKey.ts')) return { apiKeyFailure: () => undefined };
      if (id.endsWith('store.ts')) return { deriveKeyRef: () => 'ROUTERGO_API_KEY', protocolChoices: () => ['openai-completions'], reasoningLevelChoices: () => ['off', 'low', 'medium', 'high'] };
      if (id.endsWith('protocol-label.ts')) return { protocolLabel: (_, name) => name };
      if (id.endsWith('.css')) return { default: {} };
      return primitives;
    },
  });
  return props => { cursor = 0; return module.exports[filename.slice(0, -4)](props); };
}

test('text model inputs show directory types and keep text selected', async () => {
  const render = await componentHarness('ModelInputTypes.tsx');
  let model = { id: 'gpt-6.2-sol', maxTokens: 4096, input: ['image'] };
  const options = declared => elements(render({ model, declared, field: 'input', position: 1, disabled: false,
    t: key => ({ modelInputTypes: '输入类型', modelInputText: '文本', modelInputImage: '图片' })[key],
    onChange: row => { model = row; },
  })).filter(node => node.type === 'Checkbox').map(node => node.props);
  const declared = ['text', 'image', 'pdf'];
  assert.deepEqual(options([]).map(({ label }) => label), ['PDF', '音频', '视频', '图片', '文本']);
  assert.deepEqual(options([]).map(({ checked }) => checked), [false, false, false, true, true]);
  assert.deepEqual(options(declared).map(({ checked }) => checked), [true, false, false, true, true]);
  assert.deepEqual(options(declared).map(({ disabled }) => disabled), [true, true, true, false, true]);
  options(declared)[3].onChange(false);
  assert.deepEqual(plain(model.input), ['text']);
  assert.equal(model.maxTokens, 4096);
  assert.deepEqual(options(declared).map(({ checked }) => checked), [true, false, false, false, true]);
  assert.deepEqual(options(['audio', 'video']).map(({ checked }) => checked), [false, true, true, false, true]);
});

test('reasoning settings change only their model and appear inside its expanded controls', async () => {
  const render = await componentHarness('ModelListEditor.tsx');
  const second = { id: 'b', reasoningEfforts: { high: 'deep' }, maxTokens: 64000 };
  let models = [{ id: 'a', input: ['text', 'image'], compat: { supportsReasoningEffort: true } }, second];
  const props = { get models() { return models; }, disabled: false, onBusyChange() {}, onChange: next => { models = next; }, operations: {}, probe: { settingsNs: 'llm-pi-ai' }, t: key => key };
  let tree = render(props);
  let row = pick(tree, 'ModelRow');
  assert.equal(row.props.expanded, false);
  assert.equal(pick(row.props.extraSettings, 'ModelCapabilityEditor').props.modelId, 'a');
  pick(row.props.extraSettings, 'ModelReasoningEditor').props.onChange(reasoning.withModelReasoning(row.props.model, { off: null, high: 'deep' }));
  assert.equal(models[0].reasoningEfforts.high, 'deep');
  assert.equal(models[1], second);
  tree = render(props); row = pick(tree, 'ModelRow');
  row.props.onToggle();
  row = pick(render(props), 'ModelRow');
  assert.equal(row.props.expanded, true);
  pick(row.props.extraSettings, 'ModelReasoningEditor').props.onChange(reasoning.withModelReasoning(row.props.model, undefined));
  assert(!Object.hasOwn(models[0], 'reasoningEfforts'));
  assert.deepEqual(plain(models[0].input), ['text', 'image']);
  assert.deepEqual(plain(models[0].compat), { supportsReasoningEffort: true });
  assert.equal(models[1], second);
  const renderRow = await componentHarness('ModelRow.tsx');
  const settings = row.props.extraSettings;
  assert(!elements(renderRow({ ...row.props, expanded: false })).includes(settings));
  const expandedRow = renderRow({ ...row.props, expanded: true });
  assert(elements(expandedRow).includes(settings));
  assert(pick(expandedRow, 'ModelInputTypes'));
  assert.equal(pick(renderRow({ ...row.props, capabilityFacts: { capabilities: ['asr'], input: ['audio'] } }), 'ModelInputTypes'), undefined);
});

test('installed reasoning metadata comes from the exact provider and model', async () => {
  const render = await componentHarness('ModelListEditor.tsx');
  const props = {
    models: [{ id: 'gpt-5' }, { id: 'OpenAI/gpt-5' }], disabled: false, onBusyChange() {}, onChange() {},
    operations: {}, probe: { settingsNs: 'llm-pi-ai', provider: 'openai' }, defaultReasoningEffort: 'high', t: key => key,
  };
  const rows = elements(render(props)).filter(node => node.type === 'ModelRow');
  const first = pick(rows[0].props.extraSettings, 'ModelReasoningEditor');
  assert.deepEqual(plain(first.props.inherited), { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high' });
  assert.equal(first.props.defaultEffort, 'high');
  assert.equal(pick(rows[1].props.extraSettings, 'ModelReasoningEditor').props.inherited, undefined);
  const otherProvider = pick(render({ ...props, probe: { ...props.probe, provider: 'custom' } }), 'ModelRow');
  assert.equal(pick(otherProvider.props.extraSettings, 'ModelReasoningEditor').props.inherited, undefined);
});

test('discovery selection preserves unlisted models and configured fields', async () => {
  const render = await componentHarness('ModelListEditor.tsx');
  const kept = { id: 'vendor/model-v1', maxTokens: 12345, compat: { supportsReasoningEffort: true } };
  const unlisted = { id: 'private:model', input: ['text', 'image'] };
  let models = [kept, unlisted];
  const props = { get models() { return models; }, disabled: false, onBusyChange() {}, onChange: next => { models = next; },
    operations: { async discoverModels() { return { kind: 'found', models: [{ id: kept.id }, { id: 'vendor/model-v2', name: 'New' }] }; } },
    probe: { settingsNs: 'llm-pi-ai', provider: 'routergo' }, t: key => key };
  let tree = render(props);
  const fetch = elements(tree).find(node => node.type === 'button' && node.props.children === '同步模型');
  assert(fetch);
  fetch.props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  tree = render(props);
  const checks = elements(tree).filter(node => node.type === 'input' && node.props.type === 'checkbox');
  assert.deepEqual(checks.map(node => node.props.checked), [true, false]);
  checks[1].props.onChange();
  tree = render(props);
  assert.equal(elements(tree).some(node => node.type === 'Modal'), false);
  const picker = elements(tree).find(node => node.type === 'section' && node.props['aria-label'] === 'fetchTitle');
  assert(picker);
  const adopt = elements(picker).find(node => node.type === 'Button' && node.props.children === 'fetchAdopt');
  assert(adopt);
  adopt.props.onClick();
  assert.deepEqual(plain(models), [kept, unlisted, { id: 'vendor/model-v2', name: 'New' }]);
});

const schema = {
  getPath: (value, path) => path.reduce((current, key) => current?.[key], value),
  hasPath: (value, path) => schema.getPath(value, path) !== undefined,
  setPath(value, path, next) { const result = structuredClone(value); let at = result; for (const key of path.slice(0, -1)) at = at[key] ??= {}; at[path.at(-1)] = next; return result; },
  deletePath(value, path) { const result = structuredClone(value); let at = result; for (const key of path.slice(0, -1)) at = at[key]; delete at[path.at(-1)]; return result; },
  rehydrate: value => value, nodeAtPath: () => ({ meta: {} }), validate: () => undefined,
};

for (const filename of ['CustomProviderCard.tsx', 'ProviderEditor.tsx']) {
  test(filename + ' refuses invalid reasoning before write and uses official save for valid mappings', async () => {
    const render = await componentHarness(filename);
    const writes = [], closes = [];
    const original = { api: 'openai-completions', baseURL: 'https://routergo.cn/api/v1', models: [{ id: 'a' }] };
    const operations = { async writeSettings(...args) { writes.push(plain(args)); return { kind: 'written', view: { user: { providers: { routergo: original } }, revision: 2 } }; }, async storeCredential() {} };
    const props = filename === 'CustomProviderCard.tsx'
      ? { preset: { id: 'routergo', name: 'RouterGo', baseURL: original.baseURL, protocol: original.api }, taken: [], protocols: [original.api], revision: 1, operations, t: key => key, readOnly: false, onClose: next => closes.push(next) }
      : { provider: 'routergo', displayName: 'RouterGo', declared: true, namespace: { ns: 'llm-pi-ai', user: { providers: { routergo: original } }, value: { providers: { routergo: original } }, base: {}, schema: {}, revision: 1 }, schema, settingsPath: ['providers', 'routergo'], operations, t: key => key, readOnly: false, onClose: next => closes.push(next) };
    for (const invalid of [{}, { high: '' }, { high: null }, { off: null }, { ultra: 'deep' }]) {
      pick(render(props), 'ModelListEditor').props.onChange([{ id: 'a', reasoningEfforts: invalid }]);
      const footer = pick(render(props), 'EditorFooter');
      assert.equal(footer.props.submitDisabled, true);
      footer.props.onSubmit(); // Prove the handler refuses even if a caller bypasses disabled.
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(writes.length, 0);
      assert.equal(closes.length, 0);
    }
    const valid = [{ id: 'a', reasoningEfforts: { off: null, high: 'deep' }, compat: { supportsReasoningEffort: true } }, { id: 'b', reasoningEfforts: false }];
    pick(render(props), 'ModelListEditor').props.onChange(valid);
    let footer = pick(render(props), 'EditorFooter');
    assert.equal(footer.props.submitDisabled, false);
    footer.props.onCancel();
    assert.equal(writes.length, 0);
    assert.deepEqual(closes, [false]);
    footer = pick(render(props), 'EditorFooter');
    footer.props.onSubmit();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(writes.length, 1);
    assert.equal(writes[0][0], 'llm-pi-ai');
    const write = writes[0][1].find(op => op.op === 'set');
    assert.deepEqual(write.path, filename === 'CustomProviderCard.tsx' ? ['providers', 'routergo'] : ['providers', 'routergo', 'models']);
    assert.deepEqual(filename === 'CustomProviderCard.tsx' ? write.value.models : write.value, valid);
    assert.deepEqual(closes, [false, true]);
  });
}

test('credential-only editor remains usable despite a hidden invalid model mapping', async () => {
  const render = await componentHarness('ProviderEditor.tsx');
  const original = { models: [{ id: 'a', reasoningEfforts: {} }] };
  const writes = [], closes = [];
  const props = { provider: 'routergo', displayName: 'RouterGo', credentialOnly: true, namespace: { ns: 'llm-pi-ai', user: { providers: { routergo: original } }, value: { providers: { routergo: original } }, schema: {}, revision: 1 }, schema, settingsPath: ['providers', 'routergo'], operations: { async writeSettings(...args) { writes.push(args); } }, t: key => key, readOnly: false, onClose: changed => closes.push(changed) };
  const footer = pick(render(props), 'EditorFooter');
  assert.equal(footer.props.submitDisabled, false);
  footer.props.onSubmit();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(writes, []);
  assert.deepEqual(closes, [true]);
});

test('editing models saves and reloads opaque IDs without dropping other provider fields', async () => {
  let persisted = { providers: { routergo: { api: 'openai-completions', baseURL: 'https://example.test/v1', headers: { 'x-custom': 'kept' }, models: [{ id: 'vendor/model:v1', maxTokens: 1000 }] } } };
  const operations = { async writeSettings(_namespace, ops) {
    for (const op of plain(ops)) if (op.op === 'set') persisted = schema.setPath(persisted, op.path, op.value);
    return { kind: 'written', view: { user: persisted, revision: 2 } };
  } };
  const props = () => ({ provider: 'routergo', displayName: 'RouterGo', declared: true,
    namespace: { ns: 'llm-pi-ai', user: persisted, value: persisted, base: {}, schema: {}, revision: 1 }, schema,
    settingsPath: ['providers', 'routergo'], operations, t: key => key, readOnly: false, onClose() {} });
  const render = await componentHarness('ProviderEditor.tsx');
  pick(render(props()), 'ModelListEditor').props.onChange([{ id: 'vendor/model:v1', maxTokens: 2000, input: ['text', 'image'] }]);
  pick(render(props()), 'EditorFooter').props.onSubmit();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(persisted.providers.routergo.headers, { 'x-custom': 'kept' });
  const reload = await componentHarness('ProviderEditor.tsx');
  const reloadedModels = pick(reload(props()), 'ModelListEditor').props.models;
  assert.deepEqual(plain(reloadedModels), [{ id: 'vendor/model:v1', maxTokens: 2000, input: ['text', 'image'] }]);
});

test('Gemini renders fixed protocol levels and writes only supported mappings', async () => {
  const render = await componentHarness('ProviderEditor.tsx');
  const original = { api: 'google-generative-ai', apiKeyEnv: 'GEMINI_API_KEY', models: [{ id: 'vendor/opaque:v1' }] };
  const config = { providers: { gemini: original } }, writes = [];
  const props = { provider: 'gemini', displayName: 'Gemini', declared: true, namespace: { ns: 'llm-pi-ai', user: config, value: config, schema: {}, revision: 1 }, schema,
    settingsPath: ['providers', 'gemini'], operations: { async writeSettings(_ns, ops) {
      writes.push(plain(ops)); return { kind: 'written', view: { user: config, revision: 2 } };
    } }, t: key => key, readOnly: false, onClose() {} };
  let list = pick(render(props), 'ModelListEditor');
  assert.equal(list.props.reasoningLevelsOnly, true);
  assert.deepEqual(plain(list.props.reasoningLevels), ['low', 'medium', 'high']);
  const renderList = await componentHarness('ModelListEditor.tsx');
  const row = pick(renderList(list.props), 'ModelRow');
  assert.equal(pick(row.props.extraSettings, 'ModelReasoningEditor'), undefined);
  const renderRow = await componentHarness('ModelRow.tsx');
  assert.equal(pick(renderRow({ ...row.props, expanded: true }), 'ModelReasoningEfforts').props.levelsOnly, true);

  list.props.onChange([{ id: original.models[0].id, reasoningEfforts: { high: 'deep' } }]);
  assert.equal(pick(render(props), 'EditorFooter').props.submitDisabled, true);
  list = pick(render(props), 'ModelListEditor');
  list.props.onChange([{ id: original.models[0].id, reasoningEfforts: { high: 'high' } }]);
  const footer = pick(render(props), 'EditorFooter');
  assert.equal(footer.props.submitDisabled, false);
  footer.props.onSubmit();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(writes, [[{ op: 'set', path: ['providers', 'gemini', 'models'], value: [{ id: 'vendor/opaque:v1', reasoningEfforts: { high: 'high' } }] }]]);
});

test('a retry after credential removal keeps official path operations and does not remove twice', async () => {
  const render = await componentHarness('ProviderEditor.tsx');
  const original = { api: 'openai-completions', apiKeyEnv: 'ROUTERGO_API_KEY', retryPolicy: { mode: 'off', maxRetries: 3 } };
  const config = { providers: { openai: original } };
  const calls = [], closes = [];
  const props = { provider: 'openai', displayName: 'OpenAI', nativeAuth: { env: ['OPENAI_API_KEY'] },
    credential: { configured: true, source: 'file', writable: true, masked: '••••' },
    namespace: { ns: 'llm-pi-ai', user: config, value: config, schema: {}, revision: 1 }, schema, settingsPath: ['providers', 'openai'],
    operations: {
      async removeCredential(ref) { calls.push(ref); },
      async writeSettings(_ns, ops, rev) {
        calls.push([rev, plain(ops)]);
        if (calls.length === 2) return { kind: 'failed', message: 'Settings unavailable' };
        return { kind: 'written', view: { user: config, revision: 2 } };
      },
    }, t: key => key, readOnly: false, onClose: value => closes.push(value) };
  let tree = render(props);
  pick(tree, 'ApiKeyInput').props.saved.clear();
  assert.equal(pick(tree, 'RetryPolicyEditor'), undefined);
  tree = render(props);
  assert.equal(pick(tree, 'ModelListEditor').props.probeBlocked, 'keyRemovePending');
  pick(tree, 'EditorFooter').props.onSubmit();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(closes, []);
  const retry = pick(render(props), 'EditorFooter');
  assert.equal(retry.props.cancelLabelKey, 'close');
  retry.props.onSubmit();
  await new Promise(resolve => setImmediate(resolve));
  const expected = [1, [
    { op: 'unset', path: ['providers', 'openai', 'apiKeyEnv'] },
  ]];
  assert.deepEqual(calls, ['ROUTERGO_API_KEY', expected, expected]);
  assert.deepEqual(closes, [true]);
});
