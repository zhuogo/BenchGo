import test from 'node:test';
import assert from 'node:assert/strict';
import { captureRouterTools, installRouterPermissionGate, toolFailureNote } from '../src/router-permissions.mjs';
import { recordDesktopTrigger } from '../src/desktop-trigger.mjs';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';

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
    assert.deepEqual(database.listTickets(), []);
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
  installRouterPermissionGate({ tools, on: (name, callback) => { assert.equal(name, 'tools/execute'); guard = callback; } }, { agent, inherited, controlled: captureRouterTools(tools, agent) });
  const invoke = (name, args = {}, extra = {}) => guard({ agent, name, arguments: args, signal: new AbortController().signal, ...extra }, async () => ++executions);
  await assert.rejects(invoke('read'), { code: 'ROUTER_TICKET_REQUIRED' });
  await assert.rejects(invoke('str_replace_editor', { command: 'view' }), { code: 'ROUTER_TICKET_REQUIRED' });
  await invoke('assistant_config');
  for (const name of ['bash', 'mcp__read_fake', 'run_code', 'assistant_unregistered']) await assert.rejects(invoke(name), { code: 'ROUTER_TICKET_REQUIRED' });
  await assert.rejects(invoke('str_replace_editor', { command: 'create' }), { code: 'ROUTER_TICKET_REQUIRED' });
  await assert.rejects(invoke('bash', { ticketId: 'forged', readOnly: true }, { parent: Symbol('nested') }), { code: 'ROUTER_TICKET_REQUIRED' });
  definitions.set('read', { name: 'read' });
  await assert.rejects(invoke('read'), { code: 'ROUTER_TICKET_REQUIRED' });
  // A call routed to another agent is not this gate's to decide: it passes on.
  assert.equal(await invoke('assistant_config', {}, { agent: {} }), 2);
  assert.equal(executions, 2);
});

test('Router denies every investigation from the first call while coordination and delegation remain available', async () => {
  const agent = {};
  const investigations = ['read', 'read_image', 'glob', 'grep', 'web_search', 'web_fetch', 'skill', 'str_replace_editor'];
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
  for (const name of investigations) await assert.rejects(invoke(name, name), { code: 'ROUTER_TICKET_REQUIRED' });
  install();
  await assert.rejects(invoke('read', 'after-resume'), { code: 'ROUTER_TICKET_REQUIRED' });
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
  const reported = [];
  let guard, resultListener, dispatched = 0;
  installRouterPermissionGate({ tools, on: (event, fn) => { if (event === 'tools/result') { resultListener = fn; return () => {}; } guard = fn; } }, { agent, inherited, controlled: captureRouterTools(tools, agent), onToolFailure: failure => { reported.push(failure); } });
  const invoke = extra => guard({ agent, ...extra, signal: new AbortController().signal }, async () => ++dispatched);
  // Another router's delegate, inherited read and coordination call all pass through untouched here.
  await invoke({ agent: otherAgent, name: 'assistant_delegate' });
  await invoke({ agent: otherAgent, name: 'read' });
  await invoke({ agent: otherAgent, name: 'ask_user_question' });
  assert.equal(dispatched, 3);
  // Its own inherited execution tool is still denied.
  await assert.rejects(invoke({ name: 'read' }), { code: 'ROUTER_TICKET_REQUIRED' });
  assert.equal(dispatched, 3);
  // A denied own call reports the real code and name as a system note; another agent's does not.
  const deniedResult = { isError: true, error: { code: 'ROUTER_TICKET_REQUIRED', message: 'Router 不能直接调用 read' }, content: [{ type: 'text', text: 'Router 不能直接调用 read' }] };
  await resultListener({ agent, name: 'read' }, deniedResult);
  await resultListener({ agent: otherAgent, name: 'read' }, deniedResult);
  await resultListener({ agent, name: 'assistant_config' }, { isError: false, content: [] });
  assert.equal(reported.length, 1);
  assert.equal(reported[0].name, 'read');
  assert.equal(reported[0].code, 'ROUTER_TICKET_REQUIRED');
  assert.match(reported[0].note, /Router 工具 read 未能执行（ROUTER_TICKET_REQUIRED）/);
  assert.equal(toolFailureNote('assistant_delegate'), '系统状态：Router 工具 assistant_delegate 未能执行（ROUTER_TICKET_REQUIRED）。该操作须通过工单下发给 Worker，不能在 Router 回合里直接执行。');
});
