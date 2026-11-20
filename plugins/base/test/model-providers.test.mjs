import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModelProviders } from '../src/model-providers.mjs';
import { assertProviderToolAccess } from '../src/provider-access.mjs';
function fixture() {
  const refs = new Map([['ROUTER_KEY', 'fixture-secret-value'], ['NATIVE_API_KEY', 'native-fixture-secret']]);
  const doc = { ns: 'llm-pi-ai', revision: 1, value: { providers: { routergo: { displayName: 'RouterGo', baseURL: 'https://gateway.example/v1', apiKeyEnv: 'ROUTER_KEY', api: 'openai-completions', models: [] } } } };
  const special = { ns: 'llm-special', revision: 2, value: { baseURL: 'https://special.example/v1', apiKeyEnv: 'NATIVE_API_KEY', api: 'anthropic-messages' } };
  const base = [{ provider: 'native', displayName: 'Native', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'native'], defaultBaseURL: 'https://native.example/v1', protocol: 'openai-responses', nativeAuth: { env: ['NATIVE_API_KEY'] } }, { provider: 'special', displayName: 'Special', settingsNs: 'llm-special', settingsPath: [] }];
  const ctx = { llm: { listConfigurableProviders: () => [...base, ...Object.keys(doc.value.providers).map(provider => ({ provider, settingsNs: doc.ns, settingsPath: ['providers', provider] }))] }, settings: { describe: () => [doc, special], mutate: async (ns, operations, revision) => { assert.equal(ns, doc.ns); assert.equal(revision, doc.revision); for (const op of operations) { let node = doc.value; for (const part of op.path.slice(0, -1)) node = node[part] ||= {}; node[op.path.at(-1)] = structuredClone(op.value); } doc.revision++; } }, credentials: { resolve: async ref => refs.has(ref) ? { value: refs.get(ref) } : undefined, set: async (ref, value) => refs.set(ref, value) }, effect: callback => callback(), connection: { fetch: { register: entry => { ctx.route = entry; return () => {}; } } } };
  return { ctx, doc, refs, service: createModelProviders(ctx) };
}
test('provider directory resolves official profile/native credentials and orders RouterGo first without secrets', async () => {
  const { service } = fixture(); const list = await service.list(); assert.equal(list[0].id, 'routergo'); assert.equal(list.length, 3); assert.ok(!JSON.stringify(list).includes('fixture-secret')); assert.deepEqual(await service.resolve('routergo'), { baseURL: 'https://gateway.example/v1', apiKey: 'fixture-secret-value' });
});

test('provider directory projects settings once for all providers and observes the next read', async () => {
  const { ctx, doc, refs, service } = fixture();
  let descriptions = 0;
  const describe = ctx.settings.describe;
  ctx.settings.describe = () => { descriptions++; return describe(); };
  const first = await service.list();
  assert.equal(first.length, 3);
  assert.equal(descriptions, 1);
  doc.value.providers.routergo.displayName = 'Updated RouterGo';
  refs.delete('NATIVE_API_KEY');
  const second = await service.list();
  assert.equal(descriptions, 2);
  assert.deepEqual(second.map(row => row.id), ['routergo']);
  assert.equal(second[0].name, 'RouterGo');
  assert.equal(second[0].declared, undefined);
  assert.equal(doc.value.providers.routergo.displayName, 'Updated RouterGo');
  assert.equal(first[0].name, 'RouterGo');
});

test('independent provider credentials are read concurrently while preserving directory ordering', async () => {
  const { ctx, service } = fixture(), requested = new Set();
  const original = ctx.credentials.resolve;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  ctx.credentials.resolve = async ref => { requested.add(ref); await gate; return original(ref); };
  const pending = service.list();
  try { assert.deepEqual([...requested].sort(), ['NATIVE_API_KEY', 'ROUTER_KEY']); }
  finally { release(); }
  assert.deepEqual((await pending).map(row => row.id), ['routergo', 'native', 'special']);
});
test('model discovery classifies structured metadata and treats identifiers as opaque', async t => {
  const { service, doc } = fixture(); const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, options) => { assert.equal(url, 'https://gateway.example/v1/models'); assert.equal(options.redirect, 'error'); assert.equal(options.headers.authorization, 'Bearer fixture-secret-value'); return Response.json({ data: [{ id: 'chat-good', capabilities: { text: true } }, { id: 'speech-one', task: 'text-to-speech' }, { id: 'listen-one', task: 'automatic-speech-recognition' }, { id: 'whisper-1' }, { id: 'tts-1' }, { id: 'tts-named-chat', task: 'text-generation' }, { id: 'embed', type: 'embedding' }, { id: 'image', type: 'image-generation' }, { id: 'fixture-secret-value' }] }); };
  const models = await service.models('routergo');
  const rows = new Map(models.map(row => [row.id, row]));
  assert.deepEqual(rows.get('speech-one').kinds, ['tts']);
  assert.deepEqual(rows.get('listen-one').kinds, ['asr']);
  assert.deepEqual(rows.get('whisper-1').kinds, []);
  assert.deepEqual(rows.get('tts-1').kinds, []);
  assert.deepEqual(rows.get('tts-named-chat').capabilities, ['text']);
  assert.deepEqual(rows.get('image').capabilities, ['image-generation']);
  assert.equal(rows.has('fixture-secret-value'), false);
  assert.deepEqual(doc.value.providers.routergo.models, []);
});
test('catalog failures do not expose service payloads or credential-bearing errors', async t => {
  const { service } = fixture(), original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => new Response('fixture-secret-value', { status: 401 }); await assert.rejects(service.models('routergo'), error => /401/.test(error.message) && !error.message.includes('secret'));
  globalThis.fetch = async () => { throw Error('request fixture-secret-value redirect'); }; await assert.rejects(service.models('routergo'), /Unable to reach/);
  globalThis.fetch = async () => new Response('x', { headers: { 'content-length': String(4 * 1024 * 1024 + 1) } }); await assert.rejects(service.models('routergo'), /4 MiB/);
  globalThis.fetch = async () => new Response('x'.repeat(4 * 1024 * 1024 + 1)); await assert.rejects(service.models('routergo'), /4 MiB/);
  globalThis.fetch = async () => new Response('fixture-secret-value'); await assert.rejects(service.models('routergo'), /invalid JSON/);
});
test('voice discovery preserves custom chat model parameters and omits unknown capabilities', async t => {
  const { service, doc } = fixture(), original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  doc.value.providers.routergo.models = [{ id: 'chat-custom', contextWindow: 12000, maxTokens: 2000, reasoningEfforts: false, input: ['text', 'image'] }];
  globalThis.fetch = async () => Response.json({ data: [{ id: 'chat-custom', name: 'Updated' }, { id: 'whisper-special', metadata: { context_window: 16000 } }, { id: 'tts-one', type: 'model', metadata: { max_tokens: 2048 } }] });
  const rows = await service.models('routergo'); assert.deepEqual(rows.find(row => row.id === 'whisper-special').capabilities, []); assert.deepEqual(rows.find(row => row.id === 'tts-one').kinds, []); assert.deepEqual(doc.value.providers.routergo.models, [{ id: 'chat-custom', contextWindow: 12000, maxTokens: 2000, reasoningEfforts: false, input: ['text', 'image'] }]);
});

test('RouterGo keeps account capabilities and prefers the exact public model metadata', async t => {
  const { ctx, doc } = fixture(), original = globalThis.fetch;
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-model-capabilities-'));
  t.after(async () => { globalThis.fetch = original; await rm(directory, { recursive: true, force: true }); });
  ctx.get = id => id === 'benchgo' ? { directory } : undefined;
  doc.value.providers.routergo.baseURL = 'https://routergo.cn/api/v1';
  const exactId = 'Opaque/Model ?';
  const accountModel = {
    id: exactId, display_name: 'RouterGo display name', capabilities: ['image-generation', 'image-edit'],
    input_modalities: ['text'],
    context_length: 120000, media_constraints: { image: { input_types: ['image/png', 'fixture-secret-value'], mask: false } },
  };
  const publicProfile = { model_id: exactId, model_name: 'Public display name', input_modalities: ['text', 'image', 'audio', 'video'], output_modalities: ['video'], thinking_levels: ['min', 'high'], context: 40000, max_output: 10000 };
  globalThis.fetch = async (url, options) => {
    if (url === 'https://routergo.cn/api/v1/models') {
      assert.equal(options.headers.authorization, 'Bearer fixture-secret-value');
      return Response.json({ data: [accountModel, { id: exactId.toLowerCase(), capabilities: ['video'] }] });
    }
    assert.equal(url, 'https://routergo.cn/api/x/public/models');
    assert.deepEqual(options.headers, { accept: 'application/json' });
    return Response.json({ success: true, data: [publicProfile] });
  };
  const service = createModelProviders(ctx);
  const [model, differentCase] = await service.models('routergo');
  assert.deepEqual(model, {
    id: exactId, name: 'RouterGo display name', capabilities: ['image-generation', 'image-edit'], kinds: [],
    mediaConstraints: { image: { input_types: ['image/png'], mask: false } },
    inputModalities: ['text', 'image', 'audio', 'video'], outputModalities: ['video'], thinkingLevels: ['min', 'high'], contextWindow: 40000, maxTokens: 10000,
  });
  assert.equal(differentCase.thinkingLevels, undefined);
  assert.equal(differentCase.inputModalities, undefined);
  await Promise.all([service.saveModelCapabilities('routergo', exactId, []), service.saveModelCapabilities('routergo', exactId.toLowerCase(), ['asr'])]);
  const reloaded = createModelProviders(ctx);
  const [overridden, otherOverride] = await reloaded.models('routergo');
  assert.deepEqual(overridden.capabilities, []);
  assert.deepEqual(overridden.providerCapabilities, ['image-generation', 'image-edit']);
  assert.deepEqual(otherOverride.kinds, ['asr']);
  assert.equal((await reloaded.modelCapabilities('routergo')).length, 2);
  await reloaded.saveModelCapabilities('routergo', exactId, null);
  assert.deepEqual((await service.models('routergo'))[0].capabilities, ['image-generation', 'image-edit']);
  assert.deepEqual(await reloaded.modelCapabilities('routergo'), [{ modelId: exactId.toLowerCase(), capabilities: ['asr'] }]);
});
test('catalog request cannot commit after credential value or reference changes', async t => {
  const { service, refs, doc } = fixture(), original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => { refs.set('ROUTER_KEY', 'rotated-fixture-key'); return Response.json({ data: [{ id: 'new-chat' }] }); };
  await assert.rejects(service.models('routergo'), /Provider changed/); assert.deepEqual(doc.value.providers.routergo.models, []);
  globalThis.fetch = async () => { doc.value.providers.routergo.apiKeyEnv = 'OTHER_KEY'; refs.set('OTHER_KEY', 'rotated-fixture-key'); return Response.json({ data: [{ id: 'new-chat' }] }); };
  await assert.rejects(service.models('routergo'), /Provider changed/); assert.deepEqual(doc.value.providers.routergo.models, []);
});

test('managed route descriptor reuses official protocol and credential reference only on the server',async()=>{
 const {service}=fixture(); const descriptor=await service.describeRoute('routergo');
 assert.equal(descriptor.protocol,'openai-completions');assert.equal(descriptor.credentialRef,'ROUTER_KEY');
 assert.equal(descriptor.baseURL,'https://gateway.example/v1');
 assert.doesNotMatch(JSON.stringify(await service.list()),/fixture-secret|apiKey|credentialRef/);
});

test('route can be described for independent credentials without resolving shared credentials', async () => {
 const { service, refs } = fixture(); refs.clear();
 const route = await service.describeRoute('routergo', { credentials: false });
 assert.equal(route.baseURL, 'https://gateway.example/v1');
 assert.equal(route.apiKey, undefined);
 await assert.rejects(service.describeRoute('routergo'), /credential/);
});

test('RouterGo protocol directory coalesces discovery and rechecks account credentials', async t => {
  const { ctx, doc, refs } = fixture();
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-model-capabilities-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  ctx.get = id => id === 'benchgo' ? { directory } : undefined;
  const service = createModelProviders(ctx);
  const ref = 'BENCHGO_ROUTERGO_KEY_' + 'a'.repeat(32);
  Object.assign(doc.value.providers.routergo, { baseURL: 'https://routergo.cn/api/v1', apiKeyEnv: ref, api: 'openai-responses' });
  refs.set(ref, 'account-test-key');
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://routergo.cn/api/v1/models');
    assert.equal(options.headers.authorization, 'Bearer ' + refs.get(ref));
    calls++;
    return Response.json({ data: [{ id: 'Exact/ID', capabilities: ['chat', 'responses'] }] });
  });
  const [first, concurrent] = await Promise.all([service.routerGoProtocolModels(), service.routerGoProtocolModels()]);
  assert.deepEqual(first.get('Exact/ID').capabilities, ['text']);
  assert.deepEqual(first.get('Exact/ID').providerCapabilities, ['chat', 'responses']);
  assert.deepEqual(concurrent, first);
  assert.equal(calls, 1);
  const modelId = 'Exact/ID';
  await writeFile(join(directory, 'model-capabilities.json'), JSON.stringify({ version: 1,
    entries: [{ providerId: 'routergo', modelId, capabilities: ['chat', 'responses', 'decision'] }],
  }));
  assert.deepEqual(await service.modelCapabilities('routergo'), [{ modelId, capabilities: ['text', 'decision'] }]);
  assert.deepEqual((await service.routerGoProtocolModels()).get(modelId).capabilities, ['text', 'decision']);
  await service.saveModelCapabilities('routergo', modelId, []);
  const disabled = (await service.routerGoProtocolModels()).get(modelId);
  assert.deepEqual(disabled.capabilities, []);
  assert.deepEqual(disabled.providerCapabilities, ['chat', 'responses']);
  assert.equal(calls, 1);
  refs.set(ref, 'rotated-test-key');
  await service.routerGoProtocolModels();
  assert.equal(calls, 2);
  doc.value.providers.routergo.baseURL = 'https://other.example/v1';
  await assert.rejects(service.routerGoProtocolModels(), /account is not connected/);
  assert.equal(calls, 2);
});

test('OAuth-only references are not API model providers', async () => {
  const { ctx } = fixture();
  const document = { ns: 'llm-oauth', revision: 1, value: { apiKeyEnv: 'ANTHROPIC_OAUTH_TOKEN', baseURL: 'https://api.anthropic.com' } };
  ctx.settings.describe = () => [document];
  ctx.llm.listConfigurableProviders = () => [{ provider: 'oauth-only', settingsNs: 'llm-oauth', settingsPath: [], nativeAuth: { env: ['ANTHROPIC_OAUTH_TOKEN'] } }];
  const service = createModelProviders(ctx);
  assert.equal((await service.describeAccess('oauth-only')).configured, false);
  await assert.rejects(service.resolve('oauth-only'), /API credential/);
  assert.deepEqual(await service.list(), []);
});

test('API execution access enforces the selected Harness wire protocol', () => {
  assert.throws(() => assertProviderToolAccess({ authMode: 'unconfigured' }, 'codex'), { code: 'API_CREDENTIAL_REQUIRED' });
  assert.throws(() => assertProviderToolAccess({ authMode: 'api', modelProtocol: 'openai' }, 'codex'), { code: 'API_PROTOCOL_MISMATCH' });
  assert.throws(() => assertProviderToolAccess({ authMode: 'api', modelProtocol: 'responses' }, 'claude'), { code: 'API_PROTOCOL_MISMATCH' });
  assert.doesNotThrow(() => assertProviderToolAccess({ authMode: 'api', modelProtocol: 'responses' }, 'codex'));
  assert.doesNotThrow(() => assertProviderToolAccess({ authMode: 'api', modelProtocol: 'anthropic' }, 'claude'));
});
