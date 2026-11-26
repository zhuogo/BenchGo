import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { captureRouterTools, installRouterPermissionGate, installRouterFailureConvergence } from '../src/router-permissions.mjs';
import { recordDesktopTrigger } from '../src/desktop-trigger.mjs';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { isRouterQuery } from '../src/model-fallback.mjs';

test('owner device status is a repeatable Router query without opening execution tools', () => {
  assert.equal(isRouterQuery('assistant_device_status', {}), true);
  assert.equal(isRouterQuery('ops_discover_tools', {}), false);
});

test('real Router tool restrictions stop refreshing while their scopes are shutting down', () => {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { loadRolePackage } from ${JSON.stringify(new URL('./role-host-fixture.mjs', import.meta.url).href)};
    import { captureRouterTools, installRouterPermissionGate } from ${JSON.stringify(new URL('../src/router-permissions.mjs', import.meta.url).href)};
    const load = name => loadRolePackage('core/tools', name);
    const { Context } = await load('@deepseek-ai/cordis');
    const { createScope } = await load('@deepseek-ai/dsh-scope');
    const host = new Context(), failures = [];
    process.on('unhandledRejection', error => failures.push(error.code || error.message));
    host.logger.exporter({ export(message) {
      if (message.type === 'error') failures.push(...message.args.map(error => error.code || error.message || String(error)));
    } });
    for (const name of ['system-prompt', 'tools']) await host.plugin((await load('@deepseek-ai/dsh-' + name)).default);
    await host.plugin(await load('@deepseek-ai/dsh-tool-executor-native'));
    const tool = name => ({ name, description: name, parameters: {}, output: { schema: { type: 'string' }, render: () => [] }, async execute() { return ''; } });
    host.tools.register(tool('read'));
    host.tools.register(tool('ask_user_question'));
    const agents = [{}, {}, {}], scopes = [];
    await host.plugin({ inject: ['tools'], apply(ctx) {
      for (const agent of agents) {
        const scoped = createScope(ctx, agent); scopes.push(scoped);
        const inherited = captureRouterTools(ctx.tools, agent);
        scoped.ctx.tools.register(tool('router_own'));
        installRouterPermissionGate(scoped.ctx, { agent, inherited, controlled: inherited });
      }
    } });
    const restricted = () => agents.every(agent => !host.tools.get('read', agent) && !!host.tools.get('ask_user_question', agent));
    const before = restricted();
    const unregister = host.tools.register(tool('late_tool'));
    const afterChange = restricted();
    await scopes[0].dispose().catch(error => failures.push(error.code || error.message));
    unregister();
    const siblingStillRestricted = !host.tools.get('read', agents[1]) && !!host.tools.get('ask_user_question', agents[1]);
    await Promise.all(scopes.slice(1).map(scope => scope.dispose().catch(error => failures.push(error.code || error.message))));
    await host.fiber.dispose().catch(error => failures.push(error.code || error.message));
    await new Promise(resolve => setImmediate(resolve));
    console.log(JSON.stringify({ before, afterChange, siblingStillRestricted, failures }));
  `], { encoding: 'utf8', timeout: 30000 });
  assert.equal(child.status, 0, child.error?.message || child.stderr);
  assert.doesNotMatch(child.stderr, /INACTIVE_EFFECT|inactive context/, 'official teardown must not log an inactive-effect failure');
  const result = JSON.parse(child.stdout.trim());
  assert.equal(result.before, true);
  assert.equal(result.afterChange, true, 'live tool changes must still refresh Router restrictions');
  assert.equal(result.siblingStillRestricted, true, 'disposing one Router cannot lift a sibling restriction');
  assert.deepEqual(result.failures, [], 'scope disposal must never create effects on an inactive context');
});

test('desktop ingress retains full immutable original, skips Eval and deduplicates composer/send', () => {
  const database = createAssistantOrchestrationStore({ filename: ':memory:' });
  try {
    const content = '原始问题\n'.repeat(15000);
    const input = { sessionId: 'session', threadId: 'main', message: { id: 'message', source: { kind: 'user' }, content: [{ type: 'text', text: content }] } };
    const first = recordDesktopTrigger(database, input), second = recordDesktopTrigger(database, input);
    assert.equal(first.trigger.content, content);
    assert.equal(first.requiresEval, false);
    assert.equal(first.candidate, null);
    assert.equal(second.duplicate, true);
    assert.equal(first.trigger.id, second.trigger.id);
    assert.deepEqual(database.listTasks(), []);
    assert.throws(() => recordDesktopTrigger(database, { ...input, message: { ...input.message, content: [{ type: 'text', text: 'changed' }] } }), { code: 'TRIGGER_CONFLICT' });
    assert.equal(recordDesktopTrigger(database, { ...input, message: { ...input.message, source: { kind: 'plugin' } } }), null);
  } finally { database.close(); }
});

test('Router gates exact definitions, operations, nested calls and unknown tools before dispatch', async () => {
  const definitions = new Map(['read', 'str_replace_editor', 'bash', 'mcp__read_fake', 'run_code'].map(name => [name, { name }]));
  const tools = { schemas: () => [...definitions.values()], get: name => definitions.get(name) };
  const agent = {}, inherited = captureRouterTools(tools, agent);
  definitions.set('assistant_config', { name: 'assistant_config' });
  let guard, executions = 0;
  installRouterPermissionGate({ tools, on: (name, callback) => { if (name === 'tools/execute') guard = callback; } }, { agent, inherited, controlled: captureRouterTools(tools, agent) });
  const invoke = (name, args = {}, extra = {}) => guard({ agent, name, arguments: args, signal: new AbortController().signal, ...extra }, async () => ++executions);
  await assert.rejects(invoke('read'), error => error.code === 'ROUTER_TASK_REQUIRED'
    && /统一使用 assistant_delegate/.test(error.message) && /deviceId/.test(error.message));
  await assert.rejects(invoke('str_replace_editor', { command: 'view' }), { code: 'ROUTER_TASK_REQUIRED' });
  await invoke('assistant_config');
  for (const name of ['bash', 'mcp__read_fake', 'run_code', 'assistant_unregistered']) await assert.rejects(invoke(name), { code: 'ROUTER_TASK_REQUIRED' });
  await assert.rejects(invoke('str_replace_editor', { command: 'create' }), { code: 'ROUTER_TASK_REQUIRED' });
  await assert.rejects(invoke('bash', { taskId: 'forged', readOnly: true }, { parent: Symbol('nested') }), { code: 'ROUTER_TASK_REQUIRED' });
  definitions.set('read', { name: 'read' });
  await assert.rejects(invoke('read'), { code: 'ROUTER_TASK_REQUIRED' });
  // A call routed to another agent is not this gate's to decide: it passes on.
  assert.equal(await invoke('assistant_config', {}, { agent: {} }), 2);
  assert.equal(executions, 2);
});

test('Router denies every investigation from the first call while coordination and delegation remain available', async () => {
  const agent = {};
  const investigations = ['read', 'read_image', 'glob', 'grep', 'web_search', 'web_fetch', 'skill', 'skills_read', 'str_replace_editor', 'plugin_manager', 'mcp__notes__read', 'run_code', 'spawn_agent'];
  const definitions = new Map([...investigations, 'ask_user_question', 'schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete'].map(name => [name, { name }]));
  let restriction;
  const tools = { schemas: () => [...definitions.values()], get: name => definitions.get(name), restrict: filter => { restriction = filter; } };
  const inherited = captureRouterTools(tools, agent);
  definitions.set('assistant_delegate', { name: 'assistant_delegate' });
  let guard, dispatched = 0;
  const install = () => installRouterPermissionGate({ tools, on: (_event, fn) => { guard = fn; } }, { agent, inherited, controlled: captureRouterTools(tools, agent) });
  const invoke = (name, callId) => guard({ agent, name, callId, signal: new AbortController().signal }, async () => ++dispatched);
  install();
  assert.deepEqual(restriction, { allow: ['ask_user_question', 'schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete'] });
  for (const name of investigations) await assert.rejects(invoke(name, name), { code: 'ROUTER_TASK_REQUIRED' });
  install();
  await assert.rejects(invoke('read', 'after-resume'), { code: 'ROUTER_TASK_REQUIRED' });
  await invoke('assistant_delegate', 'delegate');
  await invoke('ask_user_question', 'question');
  await invoke('schedule_create', 'schedule-create');
  await invoke('schedule_list', 'schedules');
  await invoke('schedule_update', 'schedule-update');
  await invoke('schedule_delete', 'schedule-delete');
  assert.equal(dispatched, 6);
  // Coordination stays the Router's own decision after a host re-registration.
  definitions.set('ask_user_question', { name: 'ask_user_question' });
  await invoke('ask_user_question', 'replacement');
  assert.equal(dispatched, 7);
});

test('Router leaves another agent’s calls to that agent’s own gate', async () => {
  const agent = {}, otherAgent = {};
  const definitions = new Map(['read', 'assistant_config', 'ask_user_question'].map(name => [name, { name }]));
  const tools = { schemas: () => [...definitions.values()], get: name => definitions.get(name) };
  const inherited = captureRouterTools(tools, agent);
  definitions.set('assistant_delegate', { name: 'assistant_delegate' });
  let guard, dispatched = 0;
  const listeners = [];
  installRouterPermissionGate({ tools, on: (event, fn) => { listeners.push(event); guard = fn; } }, { agent, inherited, controlled: captureRouterTools(tools, agent) });
  const invoke = extra => guard({ agent, ...extra, signal: new AbortController().signal }, async () => ++dispatched);
  // Another router's delegate, inherited read and coordination call all pass through untouched here.
  await invoke({ agent: otherAgent, name: 'assistant_delegate' });
  await invoke({ agent: otherAgent, name: 'read' });
  await invoke({ agent: otherAgent, name: 'ask_user_question' });
  assert.equal(dispatched, 3);
  // Its own inherited execution tool is still denied.
  await assert.rejects(invoke({ name: 'read' }), { code: 'ROUTER_TASK_REQUIRED' });
  assert.equal(dispatched, 3);
  // The gate leaves diagnostic results to the official executor and Router;
  // it does not turn one denied call into a hard chat failure.
  assert.deepEqual(listeners, ['system-prompt/assemble', 'tools/execute']);
});

for (const code of ['PROFILE_CONFIG_DIRECT_WRITE', 'PROFILE_CONFIG_RESTORED']) test(`configuration guard permits one model reply after stopping tools (${code})`, () => {
  const listeners = new Map(), agent = {};
  const replyFacts = installRouterFailureConvergence({ on: (event, fn) => listeners.set(event, fn) }, agent);
  listeners.get('tools/result')({ agent, callId: 'config-write', name: 'shell' }, {
    isError: true, error: { code }, content: [{ type: 'text', text: `${code}: direct profile configuration is blocked` }],
  });
  const step = listeners.get('agent/pre-step');
  const next = () => ({ kind: 'accept' });
  assert.deepEqual(step({ agent: {}, messages: [] }, next), { kind: 'accept' });
  assert.deepEqual(step({ agent, messages: [] }, next), { kind: 'accept' });
  assert.deepEqual(step({ agent, messages: [] }, next), { kind: 'reject' });
  assert.equal(replyFacts().error.code, code);
  assert.equal(replyFacts().error.callId, 'config-write');
});

for (const scenario of ['structural', 'archive-duplicate', 'archive-varied', 'archive-json', 'archive-corrected-input']) test(`official Router loop handles tool failures (${scenario})`, { timeout: 15000 }, async t => {
  const requireHarness = createRequire(new URL('../../../deepseek-harness/packages/core/agent-loop/package.json', import.meta.url));
  const load = name => import(pathToFileURL(requireHarness.resolve(name)).href);
  const { Context } = await load('@deepseek-ai/cordis');
  const { default: LlmRuntime, LlmAdapter, createUserMessage, HarnessError } = await load('@deepseek-ai/dsh-llm');
  const ctx = new Context(); t.after(() => ctx.fiber.dispose());
  await ctx.plugin(LlmRuntime);
  for (const name of ['@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-projection', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-agent-loop']) {
    await ctx.plugin((await load(name)).default, name === '@deepseek-ai/dsh-agent-loop' ? { agents: [] } : undefined);
  }
  const requireNative = createRequire(new URL('../../../deepseek-harness/packages/core/tool-executor-native/package.json', import.meta.url));
  await ctx.plugin(await import(pathToFileURL(requireNative.resolve('@deepseek-ai/dsh-tool-executor-native')).href));
  const requests = [];
  const limit = { structural: 2, 'archive-duplicate': 5, 'archive-varied': 8, 'archive-json': 1, 'archive-corrected-input': 3 }[scenario];
  const receipt = { archived: 1, alreadyArchived: 0, skipped: 2, failed: 0, partial: 0 };
  let readArchiveReply, facts;
  const previewCalls = [];
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 131072 } }; }
    async *stream(request) {
      requests.push(request);
      const step = requests.length;
      if (step === limit + 1) {
        facts = readArchiveReply();
        const text = 'Reply grounded in the tool result';
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'block-end', index: 0, block: { type: 'text', text } };
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }
      assert.ok(step <= limit, 'must stop at the next official boundary');
      let name, args = {};
      if (scenario === 'structural') name = step === 1 ? 'first' : 'alternate';
      else if (scenario === 'archive-duplicate' && step > 2) {
        name = 'assistant_projects';
        args = step % 2 ? { scope: 'local', deviceIds: [] } : { deviceIds: [], scope: 'local' };
      } else {
        name = scenario === 'archive-duplicate' && step === 2 ? 'assistant_session_archive_apply' : 'assistant_session_archive_preview';
        args = scenario === 'archive-corrected-input' && step <= 2 ? { before: 'invalid' } : { keepLatest: step };
      }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `failure-${step}`, name, arguments: JSON.stringify(args) } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    }
  }
  ctx.llm.registerAdapter(['convergence-test'], new Adapter());
  const sessionId = 'convergence-same-session';
  let created = 0;
  ctx.on('agent/created', () => { created++; });
  const handle = await ctx.agents.create({ sessionId, setup: async (scope, agent) => {
    readArchiveReply = installRouterFailureConvergence(scope, agent);
    for (const name of ['first', 'alternate']) scope.tools.register({ name, description: 'test', parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object' }, render: () => [] },
      execute() { throw new HarnessError('Disk quota exhausted before dispatch', 'ENOSPC'); } });
    for (const name of ['assistant_session_archive_preview', 'assistant_session_archive_apply', 'assistant_projects']) scope.tools.register({ name, description: 'test',
      parameters: { type: 'object', additionalProperties: true },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute(args) {
        if (name === 'assistant_session_archive_preview') previewCalls.push(args);
        if (args.before === 'invalid') throw new HarnessError('before 必须是带时区的 ISO 时间', 'MANAGEMENT_INPUT');
        return scenario === 'archive-json' ? { project: undefined } : name === 'assistant_session_archive_apply' ? receipt : { total: 0 };
      } });
  } });
  t.after(() => handle.dispose());
  handle.agent.model.select({ provider: 'convergence-test', model: 'opaque-model' });
  handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue the task' }] }));
  await handle.agent.whenIdle();
  const events = handle.agent.session.snapshotEvents();
  assert.equal(created, 1); assert.equal(handle.agent.id, sessionId);
  assert.equal(requests.length, limit + 1);
  const results = events.filter(event => event.type === 'tool/result');
  assert.equal(results.length, limit);
  if (scenario === 'structural') assert.equal(facts.error.code, 'ENOSPC');
  else if (scenario === 'archive-corrected-input') {
    assert.equal(facts, undefined);
    assert.deepEqual(previewCalls, [{ before: 'invalid' }, { keepLatest: 3 }]);
    assert.match(results[1].data.message.content[0].text, /before.+本轮未再次执行/);
    assert.equal(results[2].data.message.isError, false);
  }
  else assert.equal(facts.calls, limit);
  if (scenario === 'archive-duplicate') assert.deepEqual(facts.receipt, receipt);
  if (scenario === 'archive-json') assert.equal(facts.error.code, 'INVALID_TOOL_OUTPUT');
  assert.equal(events.findLast(event => event.type === 'turn/end').data.reason.kind, 'completed');
});
