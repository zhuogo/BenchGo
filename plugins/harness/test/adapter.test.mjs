import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import { Session, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session';
import { mountHarnessAdapter } from '../src/adapter.mjs';
import { mediaResultFile, NATIVE_MEDIA_RESULT } from '../../media/shared/generation-result.mjs';
import { encodeRouteModelId } from '../../base/src/picker-catalog.mjs';
import { createSessionRoutes } from '../../base/src/session-routes.mjs';
import { createRuntimeSettings } from '../../base/src/runtime-settings.mjs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

class Native extends EventEmitter {
  routeService = { async capture({ providerId, model }) { return { providerId, model }; } };
  pickerCatalog = { async models() { return [{ provider: 'commander-codex', id: selectedApiModel, name: 'Real model', context: { contextWindow: 131072 }, inputModalities: ['text'] }]; } };
  providers = new Map([['codex', { config: {} }]]);
  records = [];
  sent = [];
  drivers = new Map();
  interrupted = 0;
  list() { return this.records; }
  snapshot(id) { return this.get(id); }
  get(id) { return this.records.find(record => record.id === id); }
  async create(options) {
    const record = { ...options, model: options.route?.model, id: `native-${this.records.length}`, status: 'idle', cursor: 0, events: [], receipts: {} };
    this.records.push(record); return record;
  }
  async connect(id) { this.get(id).status = 'idle'; this.drivers.set(id, { setModel: async model => { this.get(id).model = model; } }); }
  async disconnect(id) { this.get(id).status = 'closed'; this.drivers.delete(id); }
  async persist() {}
  event(id, type, data, turnId) {
    const record = this.get(id);
    const event = { sessionId: id, type, data, turnId, seq: ++record.cursor };
    record.events.push(event);
    if (type === 'turn.completed') record.status = data.status === 'completed' ? 'idle' : 'failed';
    this.emit('event', event);
  }
  async submit(id, text, { requestId }) {
    const record = this.get(id);
    this.sent.push(text); record.status = 'running';
    const receipt = { requestId, turnId: `turn-${this.sent.length}`, status: 'accepted' };
    record.receipts[requestId] = { text, receipt };
    if (this.respond !== false) {
      this.event(id, 'text.delta', { text: 'native reply' }, receipt.turnId);
      this.event(id, 'turn.completed', { status: this.fail ? 'failed' : 'completed', error: this.fail ? 'broken' : undefined }, receipt.turnId);
    }
    return receipt;
  }
  async interrupt(id) { this.interrupted++; this.get(id).status = 'idle'; }
  events(id, after, limit) {
    const record = this.get(id), events = record.events.filter(event => event.seq > after).slice(0, limit);
    return { events, cursor: events.at(-1)?.seq ?? after, latest: record.cursor, truncated: false };
  }
}
function setup() {
  const native = new Native(), effects = [], owners = [];
  const ctx = {
    agents: { requireInitiator: () => ({ session: { id: 'harness', header: { cwd: '/project' } } }) },
    llm: { registerAdapter(routes, adapter) { ctx.routes = routes; ctx.adapter = adapter; return () => { ctx.removed = true; }; } },
    get: () => ({ list: () => [{ path: '/project' }] }),
    effect(fn) { effects.push(fn()); }, on() {}, logger: { warn() {} },
  };
  const adapter = mountHarnessAdapter(ctx, native, { bindOwner: (...args) => owners.push(args), discover: async () => [{ id: 'real-model', name: 'Real model', contextWindow: 131072 }] });
  return { ctx, native, adapter, owners, dispose: async () => { for (const effect of effects.reverse()) await effect?.(); } };
}
test('provider route identity reaches native create and existing conversations cannot silently switch', async () => {
  const s = setup(), model = encodeRouteModelId('router/a', 'vendor/model');
  s.native.pickerCatalog = { models: async () => [{ provider: 'commander-codex', id: model, name: 'Actual model', inputModalities: ['text'] }] };
  assert.deepEqual((await s.adapter.listModels('commander-codex')).map(row => row.id), [model]);
  await collect(s.adapter.stream({ ...request([human('one', 'hello')]), model }));
  assert.equal(s.native.records[0].model, 'vendor/model');
  assert.deepEqual(s.native.records[0].route, { providerId: 'router/a', model: 'vendor/model' });
  await collect(s.adapter.stream({ ...request([human('one', 'hello'), human('two', 'continue')]), model }));
  assert.equal(s.native.records.length, 1);
  await assert.rejects(collect(s.adapter.stream({ ...request([human('three', 'switch')]), model: encodeRouteModelId('router/b', 'vendor/model') })), /新建聊天/);
  assert.equal(s.native.records.length, 1);
  await s.dispose();
});
test('same tool and supplier can change models on its existing idle native conversation', async () => {
  const s = setup(), first = encodeRouteModelId('router/a', 'vendor/one'), second = encodeRouteModelId('router/a', 'vendor/two');
  s.native.pickerCatalog = { models: async () => [first, second].map(id => ({ provider: 'commander-codex', id, name: id, inputModalities: ['text'] })) };
  await collect(s.adapter.stream({ ...request([human('one', 'hello')]), model: first }));
  await collect(s.adapter.stream({ ...request([human('two', 'switch')]), model: second }));
  assert.equal(s.native.records.length, 1);
  assert.equal(s.native.records[0].model, 'vendor/two');
  assert.equal(s.native.records[0].route.model, 'vendor/two');
  await assert.rejects(collect(s.adapter.stream({ ...request([human('three', 'other supplier')]), model: encodeRouteModelId('router/b', 'vendor/three') })), /新建聊天/);
  await s.dispose();
});
test('changing models and effort retains a complete reconnectable binding on the same native conversation', async t => {
  const s = setup(), directory = await mkdtemp(join(tmpdir(), 'adapter-route-switch-'));
  t.after(async () => { await s.dispose(); await rm(directory, { recursive: true, force: true }); });
  const provider = { baseURL: 'https://router.example/v1', apiKey: 'test-secret', credentialRef: 'router-key', protocol: 'openai-responses' };
  const runtimeSettings = createRuntimeSettings({ directory });
  const routes = createSessionRoutes({ directory, runtimeSettings, providers: { resolve: async () => provider, describeRoute: async () => provider },
    harnessDefaults: () => ({ config: { features: { multi_agent: true } } }) });
  s.native.routeService = routes;
  const create = s.native.create.bind(s.native);
  s.native.create = async options => create({ ...options, route: await routes.capture({ tool: options.provider, ...options.route }) });
  const first = encodeRouteModelId('router', 'vendor/one'), second = encodeRouteModelId('router', 'vendor/two');
  const reasoning = { defaultEffort: 'low', efforts: ['low', 'high'].map(id => ({ id, name: id })) };
  s.native.pickerCatalog = { models: async () => [first, second].map(id => ({ id, provider: 'commander-codex', name: id, inputModalities: ['text'], reasoning })) };
  await collect(s.adapter.stream({ ...request([human('one', 'hello')]), model: first }));
  const before = structuredClone(s.native.records[0].route);
  assert.equal(before.advancedConfig.config.model_reasoning_effort, 'low');
  await s.native.connect(s.native.records[0].id);
  await collect(s.adapter.stream({ ...request([human('two', 'change')]), model: second, reasoningEffort: 'high' }));
  const after = s.native.records[0].route;
  assert.equal(after.model, 'vendor/two');
  assert.equal(after.version, 1);
  assert.equal(after.mode, before.mode);
  assert.equal(after.baseURL, before.baseURL);
  assert.equal(after.credentialRef, before.credentialRef);
  assert.deepEqual(after.advancedConfig, { config: { features: { multi_agent: true }, model_reasoning_effort: 'high' } });
  assert.equal(s.native.records.length, 1);
  assert.notEqual(after.fingerprint, before.fingerprint);
  const launch = await routes.launch({ tool: 'codex', route: JSON.parse(JSON.stringify(after)), sessionId: randomUUID() });
  assert(launch.commandArgs.includes('model="vendor/two"'));
  assert(launch.commandArgs.includes('model_reasoning_effort="high"'));
  await collect(s.adapter.stream({ ...request([human('three', 'change effort only')]), model: second, reasoningEffort: 'low' }));
  assert.equal(s.native.records[0].route.advancedConfig.config.model_reasoning_effort, 'low');
  const switched = s.native.records[0].route;
  provider.baseURL = 'https://changed.example/v1';
  await assert.rejects(collect(s.adapter.stream({ ...request([human('four', 'change back')]), model: first })), /已更改/);
  assert.equal(s.native.records[0].model, 'vendor/two');
  assert.deepEqual(s.native.records[0].route, switched);
});
test('native adapters reject API effort IDs instead of silently ignoring a saved selection', async () => {
  const s = setup();
  await assert.rejects(collect(s.adapter.stream({ ...request([human('one', 'hello')]), reasoningEffort: 'high' })), /不受此模型与 Harness 支持/);
  assert.equal(s.native.records.length, 0);
  assert.equal(s.native.sent.length, 0);
  await s.dispose();
});
test('managed picker requires an explicit executable API route', async () => {
  const s = setup(); s.native.pickerCatalog = { models: async () => [] };
  await assert.rejects(collect(s.adapter.stream({ ...request([human('one', 'hello')]), model: 'native-default' })), /API 模型目录/);
  await assert.rejects(collect(s.adapter.stream({ ...request([human('one', 'hello')]), model: encodeRouteModelId('removed', 'model') })), /重新选择/);
  assert.equal(s.native.records.length, 0);
  await s.dispose();
});
const human = (id, text) => ({ role: 'user', id, source: { kind: 'user' }, content: [{ type: 'text', text }] });
const selectedApiModel = encodeRouteModelId('test-api', 'real-model');
const request = messages => ({ provider: 'commander-codex', model: selectedApiModel, sessionId: 'harness', messages });
async function collect(stream) { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks; }

test('native providers and discovered models enter the official catalog without creating sessions', async () => {
  const s = setup();
  assert.deepEqual(s.ctx.routes, ['commander-codex', 'commander-claude', 'commander-pi', 'commander-opencode', 'commander-gemini', 'commander-grok', 'commander-mcode']);
  assert.deepEqual((await s.adapter.listModels('commander-codex')).map(model => model.id), [selectedApiModel]);
  assert.deepEqual((await s.adapter.resolveModel('commander-codex', selectedApiModel)).context, { contextWindow: 131072 });
  await assert.rejects(s.adapter.resolveModel('commander-codex', 'native-default'), /API 模型目录/);
  assert.equal(s.native.records.length, 0);
  assert.equal(s.adapter.providerRetryPolicy().maxRetries, 0);
  await s.dispose(); assert.equal(s.ctx.removed, true);
});

test('official text stream forwards only durable human inputs and preserves native identity on follow-up and replay', async () => {
  const s = setup();
  const context = { role: 'user', id: 'ctx', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'Do not forward' }] };
  const one = request([{ role: 'system', content: [{ type: 'text', text: 'Harness tool definitions' }] }, context, human('one', 'hello')]);
  const chunks = await collect(s.adapter.stream(one));
  assert.deepEqual(s.native.sent, ['hello']);
  assert.equal(chunks[0].type, 'block-start');
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } });
  assert.equal(chunks.some(chunk => chunk.type === 'usage' || chunk.type === 'tool-call-delta'), false);
  await collect(s.adapter.stream(request([human('one', 'hello'), human('two', 'continue')])));
  assert.deepEqual(s.native.sent, ['hello', 'continue']);
  assert.equal(s.native.records.length, 1);
  await collect(s.adapter.stream(request([human('one', 'hello'), human('two', 'continue')])));
  assert.equal(s.native.sent.length, 2);
  assert.equal(s.native.listenerCount('event'), 0);
  await s.dispose();
});

test('official native replay keeps the external media receipt and its original group', async t => {
  const s = setup(), session = Session.create('harness', undefined, {
    id: 'harness', version: SESSION_FORMAT_VERSION, cwd: process.cwd(), createdAt: 1, isSeeded: false,
  });
  t.after(s.dispose);
  s.ctx.agents.requireInitiator = () => ({ session });
  s.native.respond = false;
  const submit = s.native.submit.bind(s.native);
  const externalUrl = 'https://images.cdn.com/finished?signature=a%2Fb';
  s.native.submit = async (...args) => {
    const receipt = await submit(...args), id = args[0];
    s.native.event(id, 'media.result', { requestId: receipt.turnId, externalUrl, url: externalUrl, mimeType: 'image/png' }, receipt.turnId);
    s.native.event(id, 'text.delta', { text: 'native reply' }, receipt.turnId);
    s.native.event(id, 'turn.completed', { status: 'completed' }, receipt.turnId);
    return receipt;
  };
  const first = human('one', 'Draw spring');
  const send = (...messages) => collect(s.adapter.stream(request(messages)));
  const records = () => session.snapshotEvents().filter(row => row.type === NATIVE_MEDIA_RESULT);
  await send(first);
  await send(first);
  assert.equal(records().length, 1);
  assert.equal(mediaResultFile(records()[0].data).url, externalUrl);
  await send(first, human('two', 'Draw again'));
  assert.equal(records().length, 2);
  assert.notEqual(records()[0].data.groupId, records()[1].data.groupId);
});

test('auxiliary requests, wrong identities and unsupported images fail before native side effects', async () => {
  const s = setup();
  await assert.rejects(collect(s.adapter.stream({ ...request([human('one', 'hello')]), purpose: 'session-title' })), /auxiliary/);
  await assert.rejects(collect(s.adapter.stream({ ...request([human('one', 'hello')]), sessionId: 'other' })), /identity/);
  const attachment = human('one', 'hello'); attachment.content.push({ type: 'image', attachment: {} });
  await assert.rejects(collect(s.adapter.stream(request([attachment]))), /不支持图片/);
  assert.equal(s.native.records.length, 0); await s.dispose();
});

test('a single native request feeds official usage while replay and multi-request turns do not', async () => {
  const s = setup();
  const submit = s.native.submit.bind(s.native);
  s.native.respond = false;
  s.native.submit = async (...args) => {
    const receipt = await submit(...args), id = args[0];
    s.native.event(id, 'text.delta', { text: 'native reply' }, receipt.turnId);
    const sample = { inputTokens: 100, cachedInputTokens: 60, outputTokens: 20, totalTokens: 120 };
    s.native.event(id, 'usage', { id: 'request-one', convention: 'inclusive', usage: sample }, receipt.turnId);
    if (s.native.multiple) s.native.event(id, 'usage', { id: 'request-two', convention: 'inclusive', usage: sample }, receipt.turnId);
    s.native.event(id, 'turn.completed', { status: 'completed' }, receipt.turnId);
    return receipt;
  };
  const first = await collect(s.adapter.stream(request([human('one', 'hello')])));
  assert.deepEqual(first.find(chunk => chunk.type === 'usage'), { type: 'usage', usage: { inputTokens: 40, outputTokens: 20, cacheReadTokens: 60, totalTokens: 120 } });
  const replay = await collect(s.adapter.stream(request([human('one', 'hello')])));
  assert.equal(replay.some(chunk => chunk.type === 'usage'), false);
  s.native.multiple = true;
  const multiple = await collect(s.adapter.stream(request([human('one', 'hello'), human('two', 'continue')])));
  assert.equal(multiple.some(chunk => chunk.type === 'usage'), false);
  await s.dispose();
});

test('native turn failures reject and release stream listeners', async () => {
  const s = setup(); s.native.fail = true;
  await assert.rejects(collect(s.adapter.stream(request([human('one', 'hello')]))), /failed.*broken/);
  assert.equal(s.native.listenerCount('event'), 0); await s.dispose();
});

test('a delegated child with the same owner and model cannot become the main conversation', async () => {
  const s = setup();
  const child = await s.native.create({ provider: 'codex', cwd: '/project', ownerSessionId: 'harness', parentId: 'another-native-parent' });
  await collect(s.adapter.stream(request([human('one', 'hello')])));
  assert.equal(s.native.records.length, 2);
  assert.notEqual(s.owners.at(-1)[0], child.id);
  assert.equal(child.cursor, 0);
  await s.dispose();
});

test('aborting an official stream interrupts the native turn and removes listeners', async () => {
  const s = setup(); s.native.respond = false;
  const controller = new AbortController();
  const pending = collect(s.adapter.stream({ ...request([human('one', 'hello')]), signal: controller.signal }));
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(new Error('cancelled'));
  await assert.rejects(pending, /cancelled/);
  assert.equal(s.native.interrupted, 1); assert.equal(s.native.listenerCount('event'), 0); await s.dispose();
});

test('plugin disposal cancels active streams before unregistering', async () => {
  const s = setup(); s.native.respond = false;
  const pending = collect(s.adapter.stream(request([human('one', 'hello')])));
  const rejected = assert.rejects(pending, /disposed/);
  await new Promise(resolve => setImmediate(resolve)); await s.dispose(); await rejected;
  assert.equal(s.native.listenerCount('event'), 0); assert.equal(s.native.interrupted, 1);
});

test('Harness LlmRuntime sends file paths and native images, rejects unsupported images, and skips replayed images', async t => {
  const ctx = new Context(), native = new Native();
  const cwd = await mkdtemp(join(tmpdir(), 'benchgo-adapter-attachments-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const filePath = join(cwd, 'a note.txt'), imagePath = join(cwd, 'scene.png');
  await Promise.all([writeFile(filePath, 'file content'), writeFile(imagePath, 'test image bytes')]);
  ctx.provide('agents', { requireInitiator: () => ({ session: { id: 'harness', header: { cwd } } }) });
  ctx.provide('attachments', { fileHostPath: () => filePath, imageHostPath: () => imagePath });
  ctx.provide('fs', { processPathFromHostPath: path => path });
  const vision = encodeRouteModelId('test-api', 'vision');
  const list = native.pickerCatalog.models;
  native.pickerCatalog.models = async () => [...await list(), { provider: 'commander-codex', id: vision, name: 'Vision', inputModalities: ['text', 'image'] }];
  try {
    await ctx.plugin(LlmRuntime);
    const fiber = ctx.plugin({ name: 'adapter-test', inject: ['llm', 'agents'], apply(scope) { mountHarnessAdapter(scope, native, { discover: async () => [] }); } });
    await fiber;
    assert.equal(ctx.llm.listProviders().length, 7);
    const chunks = await collect(ctx.llm.stream(request([human('one', 'hello')])));
    assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } });
    const photo = { id: 'two', role: 'user', source: { kind: 'user' }, content: [
      { type: 'image', attachment: { attachmentId: 'image-id', name: 'scene.png', mediaType: 'image/png' } },
    ] };
    const unsupported = await collect(ctx.llm.stream(request([photo])));
    assert.equal(unsupported.at(-1).reason.failure.code, 'MODEL_DOES_NOT_SUPPORT_IMAGES');
    assert.equal((await collect(ctx.llm.stream({ ...request([photo]), model: vision }))).at(-1).reason.kind, 'stop');
    assert.deepEqual(native.sent[1], { text: '', images: [{ id: 'image-id', path: imagePath }] });
    const file = human('three', 'Read the file');
    file.content.push({ type: 'file', attachment: { attachmentId: 'file-id', name: 'a note.txt', bytes: 12 } });
    assert.equal((await collect(ctx.llm.stream(request([photo, file])))).at(-1).reason.kind, 'stop');
    assert.match(native.sent[2], /verbatim read-only copy/);
    assert.ok(native.sent[2].includes(JSON.stringify(filePath)));
    assert.equal((await collect(ctx.llm.stream(request([photo, file])))).at(-1).reason.kind, 'stop');
    assert.equal(native.sent.length, 3);
    await fiber.dispose(); assert.equal(ctx.llm.listProviders().length, 0);
  } finally { await ctx.fiber.dispose(); }
});

test('a child explicitly adopted into its own Harness conversation reuses its native context', async () => {
  const s = setup();
  const child = await s.native.create({ provider: 'codex', cwd: '/project', ownerSessionId: 'harness', parentId: 'parent', harnessAdopted: true, route: { providerId: 'test-api', model: 'real-model' } });
  await collect(s.adapter.stream(request([human('one', 'continue child')])));
  assert.equal(s.native.records.length, 1);
  assert.equal(s.owners.at(-1)[0], child.id);
  await s.dispose();
});
