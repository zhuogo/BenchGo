import test from 'node:test';
import assert from 'node:assert/strict';
import { installRouterPermissionGate, captureRouterTools } from '../../superagent/src/router-permissions.mjs';

test('Router admits only efficiency-owned context definitions and tracks hot enable/disable', async () => {
  const agent = {}, definitions = new Map([['read', {}], ['ask_user_question', {}]]);
  const listeners = new Map(), restrictions = [];
  let owned = [];
  const tools = {
    schemas: () => [...definitions].map(([name]) => ({ name })), get: name => definitions.get(name),
    restrict(filter) { restrictions.push(filter.allow); return () => {}; },
  };
  const inherited = captureRouterTools(tools, agent);
  const scope = { tools, get: name => name === 'benchgoEfficiency' ? { contextTools: () => owned } : undefined,
    on(name, listener) { listeners.set(name, listener); }, effect() {} };
  installRouterPermissionGate(scope, { agent, inherited, controlled: new Map() });
  const invoke = name => listeners.get('tools/execute')({ name, agent, signal: new AbortController().signal }, async () => 'executed');
  const compact = {}, status = {};
  definitions.set('compact_now', compact); definitions.set('context_status', status);
  owned = [{ name: 'compact_now', definition: compact }, { name: 'context_status', definition: status }];
  listeners.get('tools/change')();
  assert.deepEqual(restrictions.at(-1), ['ask_user_question', 'compact_now', 'context_status']);
  assert.equal(await invoke('compact_now'), 'executed');
  assert.equal(await invoke('context_status'), 'executed');
  await assert.rejects(invoke('read'), { code: 'ROUTER_TASK_REQUIRED' });
  definitions.set('context_status', {});
  await assert.rejects(invoke('context_status'), { code: 'ROUTER_TASK_REQUIRED' });
  owned = []; listeners.get('tools/change')();
  assert.deepEqual(restrictions.at(-1), ['ask_user_question']);
  await assert.rejects(invoke('compact_now'), { code: 'ROUTER_TASK_REQUIRED' });
});
