import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createAssistantEngine } from '../src/engine.mjs';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { createDesktopDelegationService } from '../src/desktop-delegation-service.mjs';
import { createAssistantDeviceStatus } from '../src/device-status.mjs';
import { installRoleHost } from './role-host-fixture.mjs';

const requireHarness = createRequire(new URL('../../../deepseek-harness/packages/core/agent-loop/package.json', import.meta.url));
const load = name => import(pathToFileURL(requireHarness.resolve(name)).href);
const loadPackage = (directory, name) => import(pathToFileURL(createRequire(new URL(`../../../deepseek-harness/packages/${directory}/package.json`, import.meta.url)).resolve(name)).href);
const { Context } = await load('@deepseek-ai/cordis');
const { default: LlmRuntime, LlmAdapter } = await load('@deepseek-ai/dsh-llm');
const modules = await Promise.all(['@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-projection', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-agent-loop'].map(load));
const { default: Compaction } = await loadPackage('compaction/compaction-basic', '@deepseek-ai/dsh-compaction-basic');
const { default: TokenMeter } = await loadPackage('llm/token-meter', '@deepseek-ai/dsh-token-meter');
const NativeToolExecutor = await loadPackage('core/tool-executor-native', '@deepseek-ai/dsh-tool-executor-native');

const text = value => [{ type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: value }, { type: 'block-end', index: 0, block: { type: 'text', text: value } },
  { type: 'finish', reason: { kind: 'stop' } }];
const call = (id, name, args = {}) => [{ type: 'block-start', index: 0, blockType: 'tool-call' },
  { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: JSON.stringify(args) } },
  { type: 'finish', reason: { kind: 'tool-calls' } }];
const lastToolResult = request => request.messages.findLast(message => message.role === 'tool');
const resultText = message => (message?.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n');
const historyMarker = 'previous-Hong-Kong-inspection-marker';

/** Scripted Router decisions validate the real official tool loop, not language accuracy. */
async function fixture(t, { mode, proposal }) {
  const ctx = new Context();
  await ctx.plugin(LlmRuntime);
  for (let index = 0; index < modules.length; index++) await ctx.plugin(modules[index].default,
    index === modules.length - 1 ? { agents: [] } : undefined);
  await ctx.plugin(TokenMeter);
  await ctx.plugin(NativeToolExecutor);
  await installRoleHost(ctx);
  const database = createAssistantOrchestrationStore({ filename: ':memory:' });
  let state = { revision: 0, mainSessionId: null, threads: [], tasks: [] };
  const routerModel = { providerId: 'fixture', modelId: 'Router/opaque' };
  const workerModel = { providerId: 'fixture', modelId: 'Worker/opaque' };
  const config = { revision: 1, models: [routerModel], workerModels: [workerModel],
    auxiliary: { models: [{ providerId: 'fixture', modelId: 'Auxiliary/opaque' }], capabilities: ['review'] } };
  const policy = { desktopVersion: 'delegation-loop-policy', projects: [], model: routerModel,
    models: config.models, workerModels: config.workerModels, routingConfig: config };
  const store = { paths: { workspace: process.cwd() }, orchestration: database,
    getState: async () => structuredClone(state),
    updateState: async (patch, { revision }) => {
      assert.equal(revision, state.revision);
      state = { ...state, ...structuredClone(patch), revision: revision + 1 };
      return state;
    },
    getConfig: async () => structuredClone(config),
    getProfile: async () => ({ identity: 'Be concise.', user: '' }), listMemories: async () => [] };
  ctx.provide('sessionQuery', { listSessions: async () => ctx.sessions.list().map(session => ({ header: session.header })),
    readSession: async id => ({ events: ctx.sessions.get(id).snapshotEvents() }) });
  let linkReads = 0, activeQuery = false, routerSteps = 0;
  const requests = [], dispatched = [];
  ctx.provide('benchgoLink', { status: () => {
    linkReads++;
    return { enabled: true, devices: [{ id: 'phone', name: '测试手机', deviceType: 'mobile', lastSeenAt: 123 }], pending: [] };
  } });
  const devices = createAssistantDeviceStatus({ ctx, store });
  const delegation = createDesktopDelegationService({ ctx, store, readPolicy: async () => structuredClone(policy) });
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 131072 } }; }
    async *stream(request) {
      requests.push(request);
      assert.equal(request.model, routerModel.modelId, 'admission must not request an auxiliary review or Worker generation');
      if (!activeQuery) { yield* text(`已记录香港服务器只读巡检的上下文，${historyMarker}`); return; }
      routerSteps++;
      if (routerSteps === 1) {
        assert.ok(request.tools.some(tool => tool.name === 'assistant_device_status'));
        assert.match(JSON.stringify(request.messages), new RegExp(historyMarker), 'the Router retains its actual earlier conversation');
        yield* mode === 'direct'
          ? call('device-read', 'assistant_device_status')
          : call('delegate', 'assistant_delegate', proposal);
      } else if (routerSteps === 2) {
        const result = lastToolResult(request);
        assert.equal(result?.isError, false, JSON.stringify(result));
        if (mode === 'direct') {
          const facts = JSON.parse(resultText(result));
          assert.equal(facts.available, true);
          assert.equal(facts.devices[0].id, 'phone');
          assert.equal(facts.liveConnections, 'unknown');
          assert.equal(database.listTickets().length, 0);
          yield* text('Link 有一台已授权手机，当前实时在线状态未知。');
        } else {
          assert.equal(database.listTickets().length, 1);
          yield* text('已安排你要求的只读巡检，结果回来后告诉你。');
        }
      } else throw new Error(`Unexpected scripted Router step ${routerSteps}`);
    }
  }
  ctx.llm.registerAdapter(['fixture'], new Adapter());
  const engine = await createAssistantEngine({ ctx, store, compactionPlugin: Compaction, appendChatRecord: modules[0].appendPluginRecord,
    setupTools(scope, { agent, threadId }) {
      const register = (name, description, properties, required, execute) => scope.tools.register({
        name, description, parameters: { type: 'object', properties, required },
        output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        execute: async (args, exec) => { dispatched.push({ name, sessionId: exec.agent.id }); return execute(args, exec); },
      });
      register('assistant_device_status', 'Read Link authorized devices and recorded access times. Live connections are unknown.', {}, [],
        (_args, exec) => devices({ agent: exec.agent, ownerAgent: agent, threadId }));
      register('assistant_delegate', 'Delegate work selected by this Router within the current human request and conversation context.',
        { title: { type: 'string' }, text: { type: 'string' }, acceptance: { type: 'string' }, requestId: { type: 'string' } },
        ['text', 'acceptance', 'requestId'], (args, exec) => delegation.delegate(args, exec, { ownerAgent: agent, threadId }));
    } });
  t.after(async () => { await engine.dispose(); await ctx.fiber.dispose(); database.close(); });
  const agent = await engine.ensureSession();
  await engine.send({ text: `之前的香港服务器只读巡检尚未取得结果，连接资料仍在原项目。${historyMarker}`, requestId: 'historical-inspection' });
  await agent.whenIdle();
  assert.equal(requests.length, 1);
  activeQuery = true;
  return { ctx, engine, agent, database, requests, dispatched, routerModel, workerModel, linkReads: () => linkReads, routerSteps: () => routerSteps };
}

for (const question of ['有其他设备连接我们这台机器吗？', '手机最后一次访问是什么时候？']) {
  test(`Router selects the read-only tool without admission review or a Ticket: ${question}`, async t => {
    const f = await fixture(t, { mode: 'direct' });
    await f.engine.send({ text: question, requestId: 'device-question' });
    await f.agent.whenIdle();
    assert.deepEqual(f.dispatched.map(row => row.name), ['assistant_device_status']);
    assert.ok(f.dispatched.every(row => row.sessionId === f.agent.id));
    assert.equal(f.routerSteps(), 2);
    assert.equal(f.linkReads(), 1);
    assert.equal(f.database.listTickets().length, 0);
    assert.equal(f.requests.length, 3, 'only the preceding conversation and two current Router steps run');
    assert.equal(f.ctx.sessions.list().length, 1);
    const events = f.agent.session.snapshotEvents();
    assert.equal(events.findLast(event => event.type === 'turn/end')?.data.reason.kind, 'completed');
    assert.match(JSON.stringify(events.filter(event => event.type === 'assistant/message')), /当前实时在线状态未知/);
  });
}

for (const request of ['请只读检查香港服务器负载、内存、磁盘和服务状态。', '再来一次呗']) {
  test(`Router delegates in the original conversation without a review request: ${request}`, async t => {
    const proposal = { title: '香港服务器巡检', text: '依据原项目连接资料，只读检查香港服务器负载、内存、磁盘和服务状态',
      acceptance: '报告实际发现、检查来源和无法确认的部分，不修改服务器', requestId: 'requested-inspection' };
    const f = await fixture(t, { mode: 'delegate', proposal });
    await f.engine.send({ text: request, requestId: 'inspection-question' });
    await f.agent.whenIdle();
    assert.deepEqual(f.dispatched.map(row => row.name), ['assistant_delegate']);
    assert.ok(f.dispatched.every(row => row.sessionId === f.agent.id));
    assert.equal(f.routerSteps(), 2);
    assert.equal(f.linkReads(), 0);
    const [ticket] = f.database.listTickets();
    assert.ok(ticket);
    assert.equal(f.database.listTickets().length, 1);
    assert.equal(ticket.mandate.instruction, request);
    assert.equal(ticket.target, proposal.text);
    assert.equal(ticket.mandate.scopeCheck, undefined);
    assert.deepEqual(f.database.assignments(ticket.id)[0].model, f.workerModel);
    assert.equal(f.requests.length, 3, 'delegation adds no review generation to the two Router steps');
    assert.ok(f.requests.every(row => row.model === f.routerModel.modelId));
    assert.equal(f.ctx.sessions.list().length, 1, 'admission does not create another Router session');
    const events = f.agent.session.snapshotEvents();
    assert.equal(events.findLast(event => event.type === 'turn/end')?.data.reason.kind, 'completed');
    assert.match(JSON.stringify(events.filter(event => event.type === 'assistant/message')), /已安排你要求的只读巡检/);
  });
}
