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
const historyMarker = 'previous-Windows-audit-only-marker';

/** The adapter scripts decisions: this checks real host plumbing, not model language accuracy. */
async function fixture(t, { scopeDecision, proposal }) {
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
  const auxiliaryModel = { providerId: 'fixture', modelId: 'Scope/opaque' };
  const config = { revision: 1, models: [routerModel], workerModels: [workerModel],
    auxiliary: { models: [auxiliaryModel], capabilities: ['review'] } };
  const policy = { desktopVersion: 'scope-loop-policy', projects: [], model: routerModel,
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
  const requests = [], dispatched = [], capabilities = new Map();
  const deviceDescription = 'Read Link authorized devices and recorded pairing/authentication access times. Live connections are unknown. Read only.';
  ctx.provide('benchgoLink', { status: () => {
    linkReads++;
    return { enabled: true, devices: [{ id: 'phone', name: '测试手机', deviceType: 'mobile', lastSeenAt: 123 }], pending: [] };
  } });
  const devices = createAssistantDeviceStatus({ ctx, store });
  const delegation = createDesktopDelegationService({ ctx, store, readPolicy: async () => structuredClone(policy),
    readOnlyCapabilities({ agent }) {
      const visible = new Set(agent.ctx.tools.schemas(agent).map(tool => tool.name));
      const definition = capabilities.get(agent.id);
      return definition && visible.has(definition.name) && agent.ctx.tools.get(definition.name, agent) === definition
        ? [{ name: definition.name, description: definition.description }] : [];
    } });
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 131072 } }; }
    async *stream(request) {
      requests.push(request);
      if (request.purpose === 'superagent-delegation-scope') {
        assert.equal(request.model, auxiliaryModel.modelId);
        assert.deepEqual(request.tools, []);
        yield* text(JSON.stringify(scopeDecision));
        return;
      }
      assert.equal(request.model, routerModel.modelId);
      if (!activeQuery) { yield* text(`已记录旧调查，${historyMarker}`); return; }
      routerSteps++;
      if (routerSteps === 1) {
        assert.ok(request.tools.some(tool => tool.name === 'assistant_device_status'));
        assert.match(JSON.stringify(request.messages), new RegExp(historyMarker), 'the Router still has its actual earlier conversation');
        yield* call('scope-delegate', 'assistant_delegate', proposal);
      } else if (scopeDecision.outcome === 'direct' && routerSteps === 2) {
        const refusal = lastToolResult(request);
        assert.equal(refusal?.isError, true, JSON.stringify(refusal));
        assert.match(resultText(refusal), /assistant_device_status/);
        assert.equal(database.listTickets().length, 0);
        yield* call('scope-device-read', 'assistant_device_status');
      } else if (scopeDecision.outcome === 'direct' && routerSteps === 3) {
        const result = lastToolResult(request);
        assert.equal(result?.isError, false, JSON.stringify(result));
        const facts = JSON.parse(resultText(result));
        assert.equal(facts.available, true);
        assert.equal(facts.devices[0].id, 'phone');
        assert.equal(facts.liveConnections, 'unknown');
        yield* text('Link 有一台已授权手机，当前实时在线状态未知。');
      } else if (scopeDecision.outcome === 'delegate' && routerSteps === 2) {
        const result = lastToolResult(request);
        assert.equal(result?.isError, false, JSON.stringify(result));
        assert.equal(database.listTickets().length, 1);
        yield* text('已安排你要求的网络调查。');
      } else throw new Error(`Unexpected scripted Router step ${routerSteps}`);
    }
  }
  ctx.llm.registerAdapter(['fixture'], new Adapter());
  const engine = await createAssistantEngine({ ctx, store, compactionPlugin: Compaction, appendChatRecord: modules[0].appendPluginRecord,
    setupTools(scope, { agent, threadId }) {
      const register = (name, description, properties, required, execute) => {
        const definition = { name, description, parameters: { type: 'object', properties, required },
          output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
          execute: async (args, exec) => { dispatched.push({ name, sessionId: exec.agent.id }); return execute(args, exec); } };
        scope.tools.register(definition);
        return definition;
      };
      capabilities.set(agent.id, register('assistant_device_status', deviceDescription, {}, [],
        (_args, exec) => devices({ agent: exec.agent, ownerAgent: agent, threadId })));
      register('assistant_delegate', 'Delegate explicitly requested work; read-only product status uses direct tools.',
        { title: { type: 'string' }, text: { type: 'string' }, acceptance: { type: 'string' }, requestId: { type: 'string' } },
        ['text', 'acceptance', 'requestId'], (args, exec) => delegation.delegate(args, exec, { ownerAgent: agent, threadId }));
    } });
  t.after(async () => { await engine.dispose(); await ctx.fiber.dispose(); database.close(); });
  const agent = await engine.ensureSession();
  await engine.send({ text: `此前检查过 Windows 远程登录，旧调查已结束。${historyMarker}`, requestId: 'historical-audit' });
  await agent.whenIdle();
  assert.equal(requests.length, 1, 'ordinary conversation does not invoke an admission classifier');
  activeQuery = true;
  return { ctx, engine, agent, database, requests, dispatched, workerModel, linkReads: () => linkReads, routerSteps: () => routerSteps };
}

const statusQuestions = [
  '有其他设备连接我们这台机器吗？',
  '现在有几台设备连接着这里？',
  '我的手机现在还在线吗？',
  '手机最后一次访问是什么时候？',
];
for (const question of statusQuestions) test(`scripted scope refusal continues in the same official Router turn: ${question}`, async t => {
  const proposal = { title: '系统连接调查', text: '检查 Windows 网络连接和远程登录，调查其他设备访问', acceptance: '报告当前连接与远程登录记录', requestId: 'new-investigation' };
  const f = await fixture(t, { proposal, scopeDecision: { outcome: 'direct', reason: '当前询问产品设备状态，先读取已注册只读事实。', toolNames: ['assistant_device_status'] } });
  await f.engine.send({ text: question, requestId: 'device-question' });
  await f.agent.whenIdle();
  assert.deepEqual(f.dispatched.map(row => row.name), ['assistant_delegate', 'assistant_device_status']);
  assert.ok(f.dispatched.every(row => row.sessionId === f.agent.id));
  assert.equal(f.routerSteps(), 3);
  assert.equal(f.linkReads(), 1);
  assert.equal(f.database.listTickets().length, 0);
  assert.equal(f.ctx.sessions.list().length, 1, 'the scope check creates no additional Agent or Session');
  const [scopeRequest, ...extra] = f.requests.filter(request => request.purpose === 'superagent-delegation-scope');
  assert.ok(scopeRequest); assert.equal(extra.length, 0);
  const evidence = JSON.stringify(scopeRequest.messages);
  assert.ok(evidence.includes(question));
  assert.ok(evidence.includes(proposal.text));
  assert.ok(evidence.includes('assistant_device_status'));
  assert.equal(evidence.includes(historyMarker), false, 'unreferenced historical investigation cannot supply authority');
  const events = f.agent.session.snapshotEvents();
  const currentMessage = events.findLast(event => event.type === 'user/message' && event.data.source?.kind === 'user').data;
  const scopeInput = JSON.parse(resultText(scopeRequest.messages.find(message => message.role === 'user')));
  assert.deepEqual(scopeInput.currentRequest, { messageId: currentMessage.id, text: question });
  assert.equal(scopeInput.explicitReference, null);
  assert.equal(scopeInput.proposal.target, proposal.text);
  assert.equal(scopeInput.proposal.acceptance, proposal.acceptance);
  assert.deepEqual(scopeInput.capabilities.map(row => row.name), ['assistant_device_status']);
  const refusal = events.find(event => event.type === 'tool/result' && event.data.message?.toolCallId === 'scope-delegate');
  const reading = events.find(event => event.type === 'tool/result' && event.data.message?.toolCallId === 'scope-device-read');
  assert.equal(refusal?.data.message.isError, true);
  assert.equal(reading?.data.message.isError, false);
  assert.equal(events.findLast(event => event.type === 'turn/end')?.data.reason.kind, 'completed');
});

test('scripted explicit network investigation passes scope check and keeps the Worker model route', async t => {
  const question = '请扫描局域网并检查这台 Windows 机器的 RDP 和 SMB 登录，调查其他设备的访问记录。';
  const proposal = { title: '网络访问调查', text: question, acceptance: '报告实际发现、检查来源和无法确认的部分', requestId: 'authorized-investigation' };
  const f = await fixture(t, { proposal, scopeDecision: { outcome: 'delegate', reason: '用户明确要求系统网络调查，Link 只读状态无法完成此范围。' } });
  await f.engine.send({ text: question, requestId: 'investigation-question' });
  await f.agent.whenIdle();
  assert.deepEqual(f.dispatched.map(row => row.name), ['assistant_delegate']);
  assert.equal(f.routerSteps(), 2);
  assert.equal(f.linkReads(), 0);
  const [ticket] = f.database.listTickets();
  assert.ok(ticket);
  assert.equal(f.database.listTickets().length, 1);
  assert.equal(ticket.mandate.instruction, question);
  assert.equal(ticket.target, question);
  assert.deepEqual(f.database.assignments(ticket.id)[0].model, f.workerModel);
  assert.equal(f.requests.filter(request => request.purpose === 'superagent-delegation-scope').length, 1);
  assert.equal(f.ctx.sessions.list().length, 1);
});
