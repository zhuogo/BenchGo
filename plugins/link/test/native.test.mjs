import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeAdapter } from '../src/session/native.mjs';

test('direct native sessions share input receipts and approvals but never control Harness-owned engines', async () => {
  const records = new Map([
    ['direct', { id: 'direct', ownerSessionId: 'commander-web:project', projectId: 'project', cwd: '/project', provider: 'codex', status: 'running', pendingApprovals: [{ id: 'approval', kind: 'permission' }], events: [{ seq: 1, type: 'input.accepted', data: { text: 'first' } }, { seq: 2, type: 'text.delta', turnId: 'turn', data: { text: 'hello ' } }, { seq: 3, type: 'text.delta', turnId: 'turn', data: { text: 'world' } }] }],
    ['owned', { id: 'owned', ownerSessionId: 'harness-session', projectId: 'project', cwd: '/project', provider: 'codex' }],
  ]);
  const calls = [];
  const commander = { snapshot: id => records.get(id), get: id => records.get(id), list: () => [...records.values()], submit: (...args) => { calls.push(args); return { accepted: true }; }, approve: (...args) => calls.push(args) };
  const adapter = createNativeAdapter({ get: () => commander, workspaceRegistry: { list: () => [{ id: 'project', path: '/project' }] } });
  assert.deepEqual(adapter.list().map(s => s.id), ['native:direct']);
  const history = await adapter.dispatch({ action: 'history', id: 'native:direct' });
  assert.deepEqual(history.messages.map(m => m.text), ['first', 'hello world']);
  await adapter.dispatch({ action: 'send', id: 'native:direct', text: 'continue', requestId: 'same' });
  assert.deepEqual(calls[0], ['direct', 'continue', { requestId: 'same' }]);
  await assert.rejects(adapter.dispatch({ action: 'send', id: 'native:owned', text: 'forbidden', requestId: 'no' }), /Harness/);
  await assert.rejects(adapter.dispatch({ action: 'respond', id: 'native:direct', interactionId: 'approval', answer: {} }), /明确/);
  await adapter.dispatch({ action: 'respond', id: 'native:direct', interactionId: 'approval', answer: { allow: true } });
  assert.deepEqual(calls.at(-1), ['direct', 'approval', { allow: true }]);
});

test('native sessions follow Harness module enable, disable and replacement without retaining the runtime', async () => {
  let commander;
  const session = { id: 'direct', ownerSessionId: 'commander-web:project', projectId: 'project', cwd: '/project', provider: 'codex', status: 'running' };
  const calls = [];
  const runtime = label => ({ list: () => [session], snapshot: () => session, submit: () => { calls.push(label); return { accepted: true }; } });
  const adapter = createNativeAdapter({ get: name => name === 'commander' ? commander : undefined, workspaceRegistry: { list: () => [{ id: 'project', path: '/project' }] } });
  const send = () => adapter.dispatch({ action: 'send', id: 'native:direct', text: 'continue', requestId: 'same' });
  const unavailable = error => error.status === 503 && /Harness.*不可用/.test(error.message);
  assert.deepEqual(adapter.list(), []);
  await assert.rejects(send(), unavailable);
  commander = runtime('first');
  assert.equal(adapter.list()[0].id, 'native:direct');
  await send();
  commander = undefined;
  assert.deepEqual(adapter.list(), []);
  await assert.rejects(send(), unavailable);
  commander = runtime('replacement');
  await send();
  assert.deepEqual(calls, ['first', 'replacement']);
  session.status = 'disconnected';
  commander.connect = async () => { commander = undefined; };
  await assert.rejects(send(), unavailable);
  assert.deepEqual(calls, ['first', 'replacement'], 'unloading during connection never submits through a stale runtime');
});
