import test from 'node:test';
import assert from 'node:assert/strict';
import { executionSessionProjection, findExecutionSessionOwner, superagentSessionInventory, attachExecutionSession } from '../src/execution-session.mjs';
import { openExecutionSession } from '../client/execution-session-navigation.mjs';
import { installResourceOpener } from '../../link/client/resource-navigation-store.mjs';

function fixture() {
  const task = { id: 'task-a', title: 'A 的任务', ownerHostId: 'host-a', status: 'running', mandate: {
    project: { path: '/b/project', deviceId: 'b' }, execution: { deviceId: 'b', hostId: 'host-b', authorizationId: 'auth-b' } } };
  const assignment = { id: 'assignment', fence: 1 };
  const run = { id: 'run-a', fence: 1, sessionId: 'same-session', state: 'running' };
  const remote = { ...task.mandate.execution, runId: run.id, executionId: 'execution-b', sessionId: run.sessionId,
    phase: 'running', available: true, observed: { phase: 'running' }, observedAt: '2026-11-15T01:00:00Z' };
  const database = { ownerHostId: () => 'host-a', getTask: () => task, listTasks: () => [task],
    assignments: () => [assignment], runs: () => [run], remoteExecution: () => remote,
    listSessionRoles: () => [], executionProjections: () => [] };
  return { task, assignment, run, remote, database };
}

test('A projects B execution identity without using A same-name session, role, child or workspace', async () => {
  const f = fixture();
  const projection = executionSessionProjection(f.database, f.task.id);
  assert.equal(projection.sessionId, 'same-session');
  assert.equal(projection.hostId, 'host-b'); assert.equal(projection.ownerHostId, 'host-a');
  assert.equal(projection.executionId, 'execution-b'); assert.equal(projection.promptable, false);
  assert.equal(projection.remote, true); assert.equal(projection.available, true);
  assert.equal(projection.observed, true);
  f.remote.available = false;
  assert.equal(executionSessionProjection(f.database, f.task.id).observed, false, 'retained B snapshot is not a current observation');
  assert.equal(findExecutionSessionOwner(f.database, 'same-session'), null);
  const inventory = superagentSessionInventory({ state: {}, database: f.database,
    records: [{ header: { id: 'same-session' } }, { header: { id: 'local-child', origin: 'subagent', parentSession: 'same-session' } }] });
  assert.deepEqual(inventory.ownedSessionIds, []); assert.equal(inventory.executions.size, 0);
  assert.equal(inventory.sessions.length, 1); assert.equal(inventory.sessions[0].remote, true);
  await assert.rejects(attachExecutionSession({ workspaceRegistry: { resolveByPath: () => assert.fail('must not resolve B path on A') } }, {}, f), /远端执行会话/);
});

test('prepared remote tasks retain their location before a session or first observation exists', () => {
  const f = fixture(); f.database.remoteExecution = () => null; f.database.runs = () => [];
  const projection = executionSessionProjection(f.database, f.task.id);
  assert.equal(projection.remote, true); assert.equal(projection.available, false);
  assert.equal(projection.deviceId, 'b'); assert.equal(projection.sessionId, null);
  assert.equal(projection.phase, 'prepared'); assert.equal(projection.promptable, false);
  f.database.assignments = () => [];
  assert.equal(executionSessionProjection(f.database, f.task.id).deviceId, 'b');
});

test('remote navigation validates current device identity and opens only the shared readonly resource entry', async t => {
  const f = fixture(), calls = [], originalLocation = globalThis.location, originalDocument = globalThis.document;
  globalThis.location = { origin: 'http://127.0.0.1:17880' };
  globalThis.document = new EventTarget();
  t.after(() => { if (originalLocation === undefined) delete globalThis.location; else globalThis.location = originalLocation; });
  t.after(() => { if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument; });
  const device = { id: 'b', hostId: 'host-b', authorizationId: 'auth-b', name: 'B', kind: 'remote' };
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    calls.push(JSON.parse(options.body)); return new Response(JSON.stringify({ devices: [device] }), { headers: { 'content-type': 'application/json' } });
  });
  const stop = installResourceOpener((device, resource, onReturn) => calls.push({ device, resource, onReturn })); t.after(stop);
  const ctx = { sessions: { refresh: () => assert.fail('must not refresh A catalog') },
    uiWorkspace: { openSession: () => assert.fail('must not open A same-name session') } };
  await openExecutionSession(ctx, executionSessionProjection(f.database, f.task.id));
  assert.equal(calls[0].action, 'devices');
  assert.deepEqual(calls[1].resource, { kind: 'sessions', resourceId: 'same-session',
    ownerTask: { taskId: 'task-a', ownerHostId: 'host-a', executionId: 'execution-b' } });
  let returnedTask;
  document.addEventListener('benchgo:assistant-open-task', event => { returnedTask = event.detail; });
  calls[1].onReturn(); assert.equal(returnedTask, 'task-a');
  device.authorizationId = 'rebound';
  await assert.rejects(openExecutionSession(ctx, executionSessionProjection(f.database, f.task.id)), /身份或授权已变化/);
  assert.equal(calls.length, 3, 'identity change does not navigate or fall back to A');
  stop();
  await assert.rejects(openExecutionSession(ctx, executionSessionProjection(f.database, f.task.id)), /跨设备工作台入口不可用/);
});
