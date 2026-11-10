import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import { registerNativePromptIngress } from '../src/native-prompt-ingress.mjs';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { installRoleHost } from './role-host-fixture.mjs';

const prompt = extra => ({ sessionId: 'assistant/session:原样', requestId: 'request/opaque:原样', mode: 'queue',
  content: [{ type: 'text', text: '保留原文\n / model:x.y ' }], clientTimeZone: 'Asia/Shanghai', ...extra });
const envelope = (request, rpcId = 'transport/one') => ({ type: 'client-request', rpcId, method: 'session/prompt', payload: { args: { request } } });
const http = (body, options = {}) => new Request('http://localhost/api/session/prompt', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...options,
});
function fixture({ nativePrompt, invoke } = {}) {
  const calls = [], admissions = [];
  const peer = { principal: { kind: 'owner' }, id: 'official-browser-peer' };
  let route, removed = false;
  const ctx = {
    connection: { browserPeer: peer, fetch: { register(value) { route = value; return async () => { removed = true; }; } } },
    typertGateway: { async invoke(value) { admissions.push(value); return invoke ? invoke(value) : { accepted: true }; } },
  };
  const engine = { async nativePrompt(value) { calls.push(value); return nativePrompt ? nativePrompt(value) : value.dispatch(); } };
  const dispose = registerNativePromptIngress(ctx, engine);
  return { ctx, peer, calls, admissions, dispose, removed: () => removed, route,
    async send(body, options) { const response = await route.fetch(http(body, options)); return { status: response.status, body: await response.json() }; } };
}

test('public exact route forwards the complete opaque prompt through official Gateway admission', async () => {
  const f = fixture();
  const request = prompt({ mode: 'steer', content: [
    { type: 'file', receiptId: 'file/receipt:保留' },
    { type: 'text', text: '原文\n引用 @file 与 /command' },
    { type: 'image', mediaType: 'image/png', data: 'AQID', name: '图.png' },
  ] });
  assert.equal(f.route.path, '/api/session/prompt');
  assert.deepEqual(f.route.methods, ['POST']);
  assert.equal(f.route.requestBody, 'buffered');
  const result = await f.send(envelope(request, 'outer/request:零'));
  assert.deepEqual(result, { status: 200, body: { type: 'server-response', rpcId: 'outer/request:零', result: { ok: true, value: { accepted: true } } } });
  assert.deepEqual(f.calls[0].request, request);
  assert.deepEqual(f.admissions[0].args, { request });
  assert.equal(f.admissions[0].peer, f.peer);
  assert.equal(f.admissions[0].namespace, 'session');
  assert.equal(f.admissions[0].method, 'prompt');
  assert.equal(f.calls[0].signal, f.admissions[0].signal);
  await f.dispose();
  assert.equal(f.removed(), true);
});

test('ordinary sessions and empty official retry prompts retain their original request', async () => {
  const f = fixture({ nativePrompt: ({ dispatch }) => dispatch() });
  for (const request of [prompt({ sessionId: 'ordinary-session' }), prompt({ sessionId: 'ordinary-session', content: [] })]) {
    const result = await f.send(envelope(request));
    assert.equal(result.body.result.ok, true);
    assert.deepEqual(f.admissions.at(-1).args, { request });
  }
});

test('transport retries preserve inner requestId while correlating each outer rpcId', async () => {
  const f = fixture();
  const request = prompt();
  const results = await Promise.all(['outer-a', 'outer-b'].map(id => f.send(envelope(request, id))));
  assert.deepEqual(results.map(row => row.body.rpcId), ['outer-a', 'outer-b']);
  assert.deepEqual(f.admissions.map(row => row.args.request.requestId), [request.requestId, request.requestId]);
  assert.equal(f.admissions.length, 2, 'official Host retains ownership of request deduplication');
});

test('does not acknowledge attachments until official admission has settled', async () => {
  const admission = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const f = fixture({ invoke: () => { entered.resolve(); return admission.promise; } });
  let settled = false;
  const pending = f.send(envelope(prompt({ content: [{ type: 'file', receiptId: 'opaque:upload' }] }))).then(value => { settled = true; return value; });
  await entered.promise;
  assert.equal(settled, false);
  admission.resolve({ accepted: true });
  assert.equal((await pending).body.result.ok, true);
});

test('official attachment rejection is returned unchanged without retry or success acknowledgement', async () => {
  const failure = new RemoteError('session/attachment-invalid', 'image route unavailable', { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' });
  const f = fixture({ invoke: () => { throw failure; } });
  const result = await f.send(envelope(prompt({ content: [{ type: 'file', receiptId: 'expired/receipt' }] })));
  assert.deepEqual(result.body.result, { ok: false, error: { code: failure.code, message: failure.message, details: failure.details } });
  assert.equal(f.admissions.length, 1);
});

test('Gateway still receives all named args and owns prompt schema validation', async () => {
  const failure = new RemoteError('gateway/arguments-invalid', 'unexpected argument', { field: 'extra' });
  const f = fixture({ invoke: ({ args }) => { assert.equal(args.extra, true); throw failure; } });
  const body = envelope(prompt());
  body.payload.args.extra = true;
  assert.equal((await f.send(body)).body.result.error.code, 'gateway/arguments-invalid');
  const invalid = fixture({ invoke: ({ args }) => { assert.equal(args.request, null); throw failure; } });
  assert.equal((await invalid.send(envelope(null))).body.result.ok, false);
  assert.equal(invalid.calls.length, 0, 'malformed routing identity goes directly to official validation');
});

test('invalid envelopes cannot invoke the assistant or official admission', async () => {
  const f = fixture();
  for (const body of [null, [], { ...envelope(prompt()), method: 'session/other' }, { ...envelope(prompt()), rpcId: 12 },
    { ...envelope(prompt()), payload: { args: [] } }, { ...envelope(prompt()), payload: { args: {}, extra: true } }]) {
    const result = await f.send(body);
    assert.equal(result.body.result.error.code, 'gateway/bad-request');
  }
  assert.equal(f.calls.length, 0);
  assert.equal(f.admissions.length, 0);
  assert.equal((await f.route.fetch(new Request('http://localhost/api/session/prompt', { method: 'POST', body: '{}' }))).status, 415);
  assert.equal((await f.route.fetch(new Request('http://localhost/api/session/prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' }))).status, 400);
});

test('uncertain failures never trigger a second dispatch', async () => {
  const f = fixture({ invoke: () => { throw new Error('admission outcome unavailable'); } });
  const result = await f.send(envelope(prompt()));
  assert.equal(result.body.result.ok, false);
  assert.equal(result.body.result.error.code, 'gateway/internal');
  assert.equal(f.admissions.length, 1);
});

test('explicit engine refusals preserve the error and do not reach admission', async () => {
  const f = fixture({ nativePrompt: () => { throw new RemoteError('session/agent-busy', '暂不能恢复此请求', { reason: 'NATIVE_ROUTE_UNAVAILABLE' }); } });
  const result = await f.send(envelope(prompt()));
  assert.equal(result.body.result.error.code, 'session/agent-busy');
  assert.equal(result.body.result.error.details.reason, 'NATIVE_ROUTE_UNAVAILABLE');
  assert.equal(f.admissions.length, 0);
});

test('cancelled transport preserves cancellation and dispatches no prompt', async () => {
  const f = fixture();
  const controller = new AbortController(); controller.abort();
  const result = await f.send(envelope(prompt()), { signal: controller.signal });
  assert.equal(result.body.result.error.code, 'gateway/cancelled');
  assert.equal(f.admissions.length, 0);
});

test('real Gateway codec and SessionController admit and deduplicate native prompts', async t => {
  const requireHost = createRequire(new URL('../../../deepseek-harness/packages/api/session-controller/package.json', import.meta.url));
  const load = name => import(pathToFileURL(requireHost.resolve(name)).href);
  const { Context } = await load('@deepseek-ai/cordis');
  const [SessionStore, Projections, Agents, Registry, Access, Gateway, Controller] = await Promise.all([
    '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-projection', '@deepseek-ai/dsh-agent',
    '@deepseek-ai/dsh-typert-registry', '@deepseek-ai/dsh-api-remote-access', '@deepseek-ai/dsh-api-gateway', '@deepseek-ai/dsh-api-session-controller',
  ].map(load));
  const { TYPERT } = await load('@deepseek-ai/dsh-api-session-controller/typert');
  const { Peer } = await import('../../../deepseek-harness/packages/client/connection/lib/index.js');
  const Attachment = await load('@deepseek-ai/dsh-attachment');
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  for (const plugin of [SessionStore, Projections, Agents, Registry, Access, Gateway]) await ctx.plugin(plugin.default);
  ctx.typert.register(TYPERT);
  const admitted = [], bindings = [];
  const attachment = { id: 'attachment:opaque', name: 'example.txt', mediaType: 'text/plain', byteLength: 7 };
  class Attachments extends Attachment.default {
    imageLimits = { maxImageBytes: 1000, maxImagesPerMessage: 5, maxMessageImageBytes: 5000, maxImagePixels: 1000, maxImageDimension: 1000, mediaTypes: ['image/png'] };
  }
  new Attachments(ctx);
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'fixture', model: 'model/opaque' }) });
  ctx.provide('llm', { resolveModelInfo: async () => ({ inputModalities: ['text'] }) });
  ctx.provide('fileUploads', {
    registerAgentResolver: () => () => {}, resolve: (_agent, id) => id === 'receipt/opaque' ? { type: 'file', attachment } : undefined,
    bindPrompt: (_agent, ids, requestId) => ({ commit: () => bindings.push({ ids, requestId }), [Symbol.dispose]() {} }), retirePrompt() {},
  });
  ctx.provide('fs', {});
  ctx.provide('sessionQuery', { listSessions: async () => [], traceSession: async () => [] });
  ctx.provide('workspaceRegistry', { list: () => [], get: () => undefined, archivedSessionIds: [] });
  await ctx.plugin(Controller.default);
  const session = ctx.sessions.create('session/opaque:原样', { meta: { cwd: process.cwd() } });
  const receive = (target, message) => {
    session.append('agent/inbox/spliced', { target, start: 0, inserted: [message] });
    admitted.push({ target, message });
  };
  const agent = { id: session.id, session, ctx, status: 'idle', options: {},
    model: { current: () => ({ provider: 'fixture', model: 'model/opaque' }) },
    followup: message => receive('next-turn', message), steer: message => receive('next-step', message),
  };
  await ctx.agents.register(agent);
  const routes = new Map();
  const peer = new Peer(ctx, { principal: { kind: 'owner' } });
  const adapter = { connection: { browserPeer: peer, fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path); } } }, typertGateway: ctx.typertGateway };
  const dispose = registerNativePromptIngress(adapter, { nativePrompt: ({ dispatch }) => dispatch() });
  t.after(dispose);
  const route = routes.get('/api/session/prompt');
  const request = prompt({ sessionId: session.id, mode: 'steer', content: [{ type: 'file', receiptId: 'receipt/opaque' }, { type: 'text', text: '原文 /不改' }] });
  const send = async body => (await route.fetch(http(body))).json();
  const first = await send(envelope(request, 'outer-1'));
  assert.deepEqual(first.result, { ok: true, value: { accepted: true } });
  const repeated = await send(envelope(request, 'outer-2'));
  assert.deepEqual(repeated.result, first.result);
  assert.equal(admitted.length, 1, 'official persistent inbox receipt deduplicates the same requestId');
  assert.equal(admitted[0].target, 'next-step');
  assert.deepEqual(admitted[0].message.content, [{ type: 'file', attachment }, { type: 'text', text: '原文 /不改' }]);
  assert.equal(admitted[0].message.source.rpcId, request.requestId);
  assert.equal(admitted[0].message.source.clientTimeZone, 'Asia/Shanghai');
  assert.deepEqual(bindings, [{ ids: ['receipt/opaque'], requestId: request.requestId }]);
  const malformed = await send(envelope({ ...request, requestId: 'bad-mode', mode: 'unsupported' }));
  assert.equal(malformed.result.ok, false);
  assert.match(malformed.result.error.code, /^gateway\//u);
  const expired = await send(envelope({ ...request, requestId: 'expired-file', content: [{ type: 'file', receiptId: 'expired' }] }));
  assert.equal(expired.result.ok, false);
  assert.equal(expired.result.error.code, 'session/attachment-invalid');
  assert.equal(admitted.length, 1);
});

test('real assistant engine selects image admission models and preserves busy file queueing', async t => {
  const requireHost = createRequire(new URL('../../../deepseek-harness/packages/api/session-controller/package.json', import.meta.url));
  const load = name => import(pathToFileURL(requireHost.resolve(name)).href);
  const requireLoop = createRequire(new URL('../../../deepseek-harness/packages/core/agent-loop/package.json', import.meta.url));
  const loadLoop = name => import(pathToFileURL(requireLoop.resolve(name)).href);
  const loadPackage = (directory, name) => import(pathToFileURL(createRequire(new URL(`../../../deepseek-harness/packages/${directory}/package.json`, import.meta.url)).resolve(name)).href);
  const { Context } = await load('@deepseek-ai/cordis');
  const { default: LlmRuntime, LlmAdapter } = await load('@deepseek-ai/dsh-llm');
  const modules = await Promise.all(['@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-projection', '@deepseek-ai/dsh-system-prompt',
    '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-agent-loop'].map(loadLoop));
  const [Registry, Access, Gateway, Controller, Attachment] = await Promise.all(['@deepseek-ai/dsh-typert-registry',
    '@deepseek-ai/dsh-api-remote-access', '@deepseek-ai/dsh-api-gateway', '@deepseek-ai/dsh-api-session-controller', '@deepseek-ai/dsh-attachment'].map(load));
  const { TYPERT } = await load('@deepseek-ai/dsh-api-session-controller/typert');
  const { Peer } = await import('../../../deepseek-harness/packages/client/connection/lib/index.js');
  const { createAssistantEngine } = await import('../src/engine.mjs');
  const { default: Compaction } = await loadPackage('compaction/compaction-basic', '@deepseek-ai/dsh-compaction-basic');
  const { default: TokenMeter } = await loadPackage('llm/token-meter', '@deepseek-ai/dsh-token-meter');
  const NativeTools = await loadPackage('core/tool-executor-native', '@deepseek-ai/dsh-tool-executor-native');
  const ctx = new Context();
  const orchestration = createAssistantOrchestrationStore({ filename: ':memory:' });
  let engine, release, hold;
  t.after(async () => { release?.(); await engine?.dispose(); await ctx.fiber.dispose(); orchestration.close(); });
  await ctx.plugin(LlmRuntime);
  for (let i = 0; i < modules.length; i++) await ctx.plugin(modules[i].default, i === modules.length - 1 ? { agents: [] } : undefined);
  await ctx.plugin(TokenMeter); await ctx.plugin(NativeTools);
  await installRoleHost(ctx);
  for (const plugin of [Registry, Access, Gateway]) await ctx.plugin(plugin.default);
  ctx.typert.register(TYPERT);
  const requests = [];
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 131072 }, inputModalities: model === 'vision/opaque' ? ['text', 'image'] : ['text'] }; }
    async *stream(request) {
      requests.push(request);
      if (hold) { const current = hold; hold = undefined; current.entered.resolve(); await current.done.promise; }
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Acknowledged' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['native/test'], new Adapter());
  const image = { attachmentId: 'image:opaque', mediaType: 'image/png', bytes: 3, width: 1, height: 1, name: '图.png' };
  const file = { attachmentId: 'file:opaque', bytes: 7, name: 'note.txt' };
  class Attachments extends Attachment.default {
    imageLimits = { maxImageBytes: 1000, maxImagesPerMessage: 5, maxMessageImageBytes: 5000, maxImagePixels: 1000, maxImageDimension: 1000, mediaTypes: ['image/png'] };
  }
  new Attachments(ctx);
  const bindings = [];
  ctx.provide('fileUploads', {
    registerAgentResolver: () => () => {},
    resolve: (_agent, id) => id === 'receipt/image' ? { type: 'image', attachment: image, encodedBytes: 3 }
      : id === 'receipt/file' ? { type: 'file', attachment: file } : undefined,
    bindPrompt: (_agent, ids, requestId) => ({ commit: () => bindings.push({ ids, requestId }), [Symbol.dispose]() {} }), retirePrompt() {},
  });
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'native/test', model: 'text/opaque' }) });
  ctx.provide('fs', {});
  ctx.provide('sessionQuery', {
    listSessions: async () => ctx.sessions.list().map(session => ({ header: session.header })),
    readSession: async id => ({ events: ctx.sessions.get(id).snapshotEvents() }), traceSession: async () => [],
  });
  ctx.provide('workspaceRegistry', { list: () => [], get: () => undefined, archivedSessionIds: [] });
  await ctx.plugin(Controller.default);
  let state = { revision: 0, mainSessionId: null, threads: [], tasks: [] };
  let model = 'text/opaque';
  const store = { orchestration, paths: { workspace: process.cwd() }, getState: async () => structuredClone(state),
    updateState: async (patch, { revision }) => { assert.equal(revision, state.revision); state = { ...state, ...structuredClone(patch), revision: revision + 1 }; return state; },
    getConfig: async () => ({ models: [{ providerId: 'native/test', modelId: model }] }), getProfile: async () => ({}), listMemories: async () => [],
  };
  engine = await createAssistantEngine({ ctx, store, compactionPlugin: Compaction, appendChatRecord: modules[0].appendPluginRecord });
  const agent = await engine.ensureSession();
  let route;
  const peer = new Peer(ctx, { principal: { kind: 'owner' } });
  const dispose = registerNativePromptIngress({ connection: { browserPeer: peer, fetch: { register(value) { route = value; return () => {}; } } }, typertGateway: ctx.typertGateway }, engine);
  t.after(dispose);
  const send = async (id, content, mode = 'queue') => (await route.fetch(http(envelope(prompt({ sessionId: agent.id, requestId: id, content, mode }), `outer/${id}`)))).json();
  const imageContent = [{ type: 'file', receiptId: 'receipt/image' }, { type: 'text', text: '看图，保持原文 /opaque' }];
  assert.equal(agent.model.current().model, 'text/opaque');
  model = 'vision/opaque';
  assert.deepEqual((await send('image-1', imageContent)).result, { ok: true, value: { accepted: true } });
  await agent.whenIdle();
  assert.deepEqual(requests.map(row => row.model), ['vision/opaque']);
  const original = agent.session.snapshotEvents().find(event => event.type === 'user/message' && event.data.source.rpcId === 'image-1').data;
  assert.deepEqual(original.content, [{ type: 'image', attachment: image }, imageContent[1]]);
  assert.equal(original.source.clientTimeZone, 'Asia/Shanghai');
  model = 'text/opaque';
  assert.equal((await send('image-1', imageContent)).result.ok, true, 'same request keeps its frozen vision route and official receipt');
  assert.equal(requests.length, 1);
  const denied = await send('image-2', imageContent);
  assert.equal(denied.result.error.code, 'session/attachment-invalid');
  assert.equal(denied.result.error.details.reason, 'MODEL_DOES_NOT_SUPPORT_IMAGES');
  assert.equal(agent.model.current().model, 'vision/opaque', 'rejected admission restores the prior choice');
  assert.equal(requests.length, 1);
  const entered = Promise.withResolvers(), done = Promise.withResolvers();
  hold = { entered, done }; release = () => done.resolve();
  model = 'vision/opaque';
  assert.equal((await send('busy-start', [{ type: 'text', text: 'Keep running' }])).result.ok, true);
  await entered.promise;
  model = 'text/opaque';
  const blocked = await send('busy-image-switch', imageContent, 'queue');
  assert.equal(blocked.result.error.details.reason, 'NATIVE_ATTACHMENT_REQUIRES_IDLE');
  const fileContent = [{ type: 'file', receiptId: 'receipt/file' }, { type: 'text', text: '排队处理文件 /original' }];
  assert.equal((await send('busy-file', fileContent)).result.ok, true, 'ordinary files retain official queue support while running');
  const queued = agent.inbox.nextTurn.find(message => message.source.rpcId === 'busy-file');
  assert.deepEqual(queued.content, [{ type: 'file', attachment: file }, fileContent[1]]);
  release(); await agent.whenIdle();
  assert.deepEqual(requests.map(row => row.model), ['vision/opaque', 'vision/opaque', 'text/opaque']);
  assert.equal(bindings.filter(row => row.requestId === 'image-1').length, 1);
  assert.equal(bindings.some(row => row.requestId === 'busy-image-switch'), false);
});
