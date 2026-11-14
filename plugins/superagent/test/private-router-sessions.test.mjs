import test from 'node:test';
import assert from 'node:assert/strict';
import { privateRouterSessionIds, superagentSessionInventory, readOwnedSessionRole } from '../src/execution-session.mjs';

test('private Router identities include historical and deleted side chats while preserving channels and unrelated Workers', () => {
 const state = { mainSessionId: 'main', threads: [
   { id: 'side', sessionId: 'side', archived: true },
   { id: 'im', sessionId: 'im', sourceKey: 'channel:real', source: { channel: 'feishu' } },
 ], sessionLineage: { main: ['old-main', 'main'], side: ['old-side', 'side'], deleted: ['deleted-side'], im: ['old-im', 'im'] } };
 assert.deepEqual(new Set(privateRouterSessionIds(state)), new Set(['main', 'side', 'old-main', 'old-side', 'deleted-side']));
 assert.deepEqual(privateRouterSessionIds({}), []);
});

function inventoryFixture() {
 const state = { mainSessionId: 'main', threads: [{ id: 'im', sessionId: 'im', sourceKey: 'channel' }, { id: 'side', sessionId: 'side', archived: true }], sessionLineage: { main: ['old-main'], deleted: ['deleted-side'] } };
 const task = { id: 't', title: 'Task', status: 'running', mandate: {} };
 const assignment = { id: 'a', owner: 'owner', fence: 2, state: 'claimed', leaseUntil: 200 };
 const run = { id: 'r', sessionId: 'worker', owner: 'owner', fence: 2, state: 'running' };
 const historical = { id: 'old-r', sessionId: 'old-worker', owner: 'old', fence: 1, state: 'uncertain' };
 const roles = [{ sessionId: 'forgotten-router', role: 'router', threadId: 'deleted' },
   { sessionId: 'child', role: 'child-worker', taskId: 't', assignmentId: 'a', runId: 'r', parentSessionId: 'worker' }];
 const projections = [{ sessionId: 'projected-only', rootSessionId: 'worker', parentSessionId: 'worker', taskId: 't', assignmentId: 'a', runId: 'r' }];
 const database = { listTasks: () => [task], assignments: () => [assignment], runs: () => [historical, run], listSessionRoles: () => roles, executionProjections: () => projections,
   getSessionRole: () => null }; // Cold sessions: no assembly audit has been saved yet.
 const records = [
   { id: 'grandchild', origin: 'subagent', parentSession: 'child' },
   { id: 'child', origin: 'subagent', parentSession: 'worker' },
   { id: 'legacy-child', origin: 'subagent', parentSession: 'old-worker' },
   { id: 'router-child', origin: 'subagent', parentSession: 'old-main' },
   { id: 'ordinary-fork', parentSession: 'worker' },
   { id: 'ordinary-subagent', origin: 'subagent', parentSession: 'ordinary' },
   { id: 'ordinary', title: 'SuperAgent Worker', cwd: '/same/project' },
   { id: 'worker' }, { id: 'old-worker' },
 ].map(header => ({ header, persisted: true, live: false }));
 const gate = { taskId: 't', assignmentId: 'a', runId: 'r', sessionId: 'worker', owner: 'owner', fence: 2 };
 const agents = { get: id => id === 'worker' ? { ctx: { get: () => gate } } : undefined };
 return { state, database, records, agents, now: 100, task, assignment, run, gate, roles, projections };
}

test('sidebar hides Router surfaces while exposing original Worker and official subagent sessions', () => {
 const f = inventoryFixture(), result = superagentSessionInventory(f);
 assert.deepEqual(new Set(result.privateSessionIds), new Set(['main', 'im', 'side', 'old-main', 'deleted-side', 'forgotten-router']));
 assert.deepEqual(new Set(result.sessions.map(row => row.sessionId)), new Set(['worker', 'old-worker', 'child', 'grandchild', 'legacy-child']));
 assert.equal(result.sessions.find(row => row.sessionId === 'worker').promptable, true);
 assert.equal(result.sessions.find(row => row.sessionId === 'child').parentSessionId, 'worker');
 assert.equal(result.sessions.find(row => row.sessionId === 'grandchild').parentSessionId, 'child');
 assert.equal(result.sessions.find(row => row.sessionId === 'child').role, 'child-worker');
 assert.equal(result.sessions.find(row => row.sessionId === 'child').promptable, true);
 assert.equal(result.sessions.find(row => row.sessionId === 'old-worker').promptable, true);
 assert.deepEqual(privateRouterSessionIds(f.state), ['main', 'side', 'old-main', 'deleted-side'], 'history-search scope does not gain Workers or channels');
});

for (const boundary of ['expired', 'fence', 'owner', 'unclaimed', 'completed', 'stopped', 'missing-agent', 'wrong-gate']) test(`official session retains input admission at ${boundary}`, () => {
 const f = inventoryFixture();
 if (boundary === 'expired') f.assignment.leaseUntil = 100;
 if (boundary === 'fence') f.run.fence = 1;
 if (boundary === 'owner') f.gate.owner = 'stale';
 if (boundary === 'unclaimed') f.assignment.state = 'uncertain';
 if (boundary === 'completed') f.task.status = 'completed';
 if (boundary === 'stopped') f.task.executionControl = { stopRequested: true };
 if (boundary === 'missing-agent') f.agents.get = () => undefined;
 if (boundary === 'wrong-gate') f.gate.runId = 'foreign';
 const row = superagentSessionInventory(f).sessions.find(row => row.sessionId === 'worker');
 assert.equal(row.promptable, true); assert.equal(row.reason, undefined);
});

test('a paused but live leased Worker can receive input without granting execution continuation', () => {
 const f = inventoryFixture(); f.task.executionControl = { paused: true };
 assert.equal(superagentSessionInventory(f).sessions.find(row => row.sessionId === 'worker').promptable, true);
});

test('conflicting role or execution projection cannot relabel a foreign child into a Task', () => {
 const f = inventoryFixture();
 f.roles.find(row => row.sessionId === 'child').runId = 'foreign';
 f.projections.push({ sessionId: 'legacy-child', parentSessionId: 'old-worker', runId: 'foreign' });
 const result = superagentSessionInventory(f);
 assert.ok(result.ownedSessionIds.includes('child'));
 assert.ok(!result.sessions.some(row => ['child', 'grandchild', 'legacy-child'].includes(row.sessionId)));
});

for (const sessionId of ['grandchild', 'legacy-child', 'router-child', 'projected-only', 'forgotten-router']) test(`cold sessionRole shares private ownership metadata for ${sessionId}`, async () => {
 const f = inventoryFixture(); let listings = 0;
 const store = { getState: async () => f.state, orchestration: f.database };
 const role = await readOwnedSessionRole({ store, sessionId, listSessions: async () => { listings++; return f.records; },
   readSession: () => assert.fail('ownership must not read transcript bodies') });
 assert.equal(listings, 1);
 assert.equal(role.sessionId, sessionId);
 assert.ok(['router', 'worker', 'child-worker'].includes(role.role));
 if (['grandchild', 'legacy-child'].includes(sessionId)) {
   assert.equal(role.role, 'child-worker'); assert.equal(role.taskId, 't');
   assert.equal(role.parentSessionId, sessionId === 'grandchild' ? 'child' : 'old-worker');
   assert.equal(role.status, 'ready'); assert.equal(role.actual, null);
 } else if (sessionId === 'projected-only') {
   assert.equal(role.role, 'child-worker'); assert.equal(role.taskId, 't');
   assert.equal(role.parentSessionId, 'worker'); assert.equal(role.status, 'blocked');
   assert.match(role.reason.message, /目录记录/);
 } else if (sessionId === 'router-child') {
   assert.equal(role.role, 'child-worker'); assert.equal(role.status, 'ready'); assert.equal(role.actual, null);
 } else {
   assert.equal(role.role, 'router'); assert.equal(role.threadId, sessionId === 'router-child' ? 'main' : 'deleted');
   assert.equal(role.status, 'blocked');
 }
});

test('historical Router descendants resolve to their original internal thread through arbitrary official depth', async () => {
 const f = inventoryFixture();
 f.records.unshift({ header: { id: 'router-grandchild', origin: 'subagent', parentSession: 'router-child' }, persisted: true });
 const role = await readOwnedSessionRole({ store: { orchestration: f.database, getState: async () => f.state }, sessionId: 'router-grandchild', listSessions: async () => f.records });
 assert.equal(role.role, 'child-worker'); assert.equal(role.status, 'ready'); assert.equal(role.actual, null);
});

for (const sessionId of ['ordinary-fork', 'ordinary', 'ordinary-subagent']) test(`metadata role fallback keeps ${sessionId} ordinary`, async () => {
 const f = inventoryFixture();
 assert.equal(await readOwnedSessionRole({ store: { orchestration: f.database, getState: async () => f.state }, sessionId, listSessions: async () => f.records }), null);
});
