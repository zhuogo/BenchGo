import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { captureRouterTools, installRouterPermissionGate } from '../src/router-permissions.mjs';
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
