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

test('native listing reads one project snapshot and preserves exact ownership, paths and source order', () => {
  const session = (id, projectId = 'project', cwd = '/project', extra = {}) => ({ id, projectId, cwd, ownerSessionId: 'commander-web:project', provider: 'codex', status: 'running', ...extra });
  const sessions = [
    session('second-path', 'project', '/alternate'),
    session('wrong-project', 'other'),
    session('wrong-case', 'project', '/Project'),
    session('trailing-slash', 'project', '/project/'),
    session('archived', 'project', '/project', { archived: true }),
    session('owned', 'project', '/project', { ownerSessionId: 'harness-session' }),
    session('wrong-owner', 'project', '/project', { ownerSessionId: 'commander-web' }),
    session('missing-owner', 'project', '/project', { ownerSessionId: undefined }),
    session('valid-separated', 'a', 'b:c'),
    session('collision', 'a:b', 'c'),
    ...Array.from({ length: 100 }, (_, i) => session(String(i))),
  ];
  let reads = 0;
  const adapter = createNativeAdapter({
    get: () => ({ list: () => sessions }),
    workspaceRegistry: { list: () => { reads++; return [{ id: 'project', path: '/project' }, { id: 'project', path: '/alternate' }, { id: 'a', path: 'b:c' }]; } },
  });
  const expected = ['second-path', 'valid-separated', ...Array.from({ length: 100 }, (_, i) => String(i))].map(id => `native:${id}`);
  assert.deepEqual(adapter.list().map(row => row.id), expected);
  assert.equal(reads, 1, 'project reads do not increase with the number of sessions');
});

test('native listing accepts a request snapshot while each operation rechecks current projects', async () => {
  const session = { id: 'direct', projectId: 'project', cwd: '/project', ownerSessionId: 'commander-web:project', provider: 'codex', status: 'running' };
  const snapshot = [{ id: 'project', path: '/project' }];
  let projects = snapshot, reads = 0, submissions = 0;
  const adapter = createNativeAdapter({
    get: () => ({ list: () => [session], snapshot: () => session, submit: () => { submissions++; return { accepted: true }; } }),
    workspaceRegistry: { list: () => { reads++; return projects; } },
  });
  assert.equal(adapter.list(snapshot)[0].id, 'native:direct');
  assert.equal(reads, 0, 'a shared request snapshot avoids another registry read');
  const send = () => adapter.dispatch({ action: 'send', id: 'native:direct', text: 'continue', requestId: 'same' });
  await send();
  projects = [{ id: 'project', path: '/moved' }];
  await assert.rejects(send(), /可用的直接工作区/);
  assert.equal(submissions, 1);
  assert.equal(reads, 2, 'each operation checks the live registry');
  assert.deepEqual(adapter.list(), [], 'later list calls also discard the previous request index');
  assert.equal(reads, 3);
  assert.deepEqual(adapter.list([]), [], 'an explicit empty snapshot does not fall back to the registry');
  assert.equal(reads, 3);
});

test('native listing skips project reads when no direct sessions are candidates', () => {
  let commander;
  const adapter = createNativeAdapter({
    get: () => commander,
    workspaceRegistry: { list: () => { throw new Error('unnecessary project read'); } },
  });
  assert.deepEqual(adapter.list(), []);
  commander = { list: () => [] };
  assert.deepEqual(adapter.list(), []);
  commander = { list: () => [
    { ownerSessionId: 'harness-session' },
    { ownerSessionId: 'commander-web:project', archived: true },
    undefined,
  ] };
  assert.deepEqual(adapter.list(), []);
});
