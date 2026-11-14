import test from 'node:test';
import assert from 'node:assert/strict';
import { executionApprovalOrigins, resolveApprovalOrigins } from '../src/execution-approval-origin.mjs';
import { channelSessionKey } from '../src/channel-policy.mjs';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';

const policy = { desktopVersion: 'desktop-v1', version: 'channel-v1' };
const mandate = (threadId = 'main', sessionId = 'router-main') => ({ policyVersion: policy.desktopVersion,
  source: { channel: 'desktop', sessionId, threadId, messageId: 'explicit-human' }, actorId: 'desktop-owner',
  admission: 'desktop-approved-delegation', controlledActions: 'require-current-policy-and-harness-approval' });
const main = { threadId: 'main', sessionIds: ['router-main'] };
function fixture() {
  const task = { id: 'task', title: '发送已备齐正文', status: 'running', mandate: mandate() };
  const assignment = { id: 'assignment', taskId: task.id, owner: 'worker', fence: 3, state: 'claimed', leaseUntil: 200 };
  const run = { id: 'run', sessionId: 'worker-session', owner: 'worker', fence: 3, state: 'running' };
  const database = { listTasks: () => [task], assignments: () => [assignment], runs: () => [run], getTask: () => task, appliedTaskSnapshot: () => ({}) };
  const origins = (extra = {}) => executionApprovalOrigins({ database, ownerScope: main, ownerSessionId: 'router-main', policy, now: 100, ...extra });
  return { task, assignment, run, database, origins };
}

test('approval origin comes only from the owned active Worker, including its original call session', () => {
  const f = fixture();
  assert.deepEqual(f.origins(), [{ taskId: 'task', title: '发送已备齐正文', assignmentId: 'assignment', runId: 'run',
    sessionId: 'worker-session', ownerSessionId: 'router-main', ownerThreadId: 'main' }]);
  for (const extra of [{ ownerScope: undefined }, { ownerScope: { threadId: 'side', sessionIds: ['router-main'] } },
    { ownerScope: { threadId: 'main', sessionIds: ['router-side'] } }, { ownerSessionId: 'forged-router' }]) assert.deepEqual(f.origins(extra), []);
  f.task.mandate = mandate('side', 'router-side');
  assert.deepEqual(f.origins(), []);
  assert.equal(f.origins({ ownerScope: { threadId: 'side', sessionIds: ['router-side'] }, ownerSessionId: 'router-side' }).length, 1);
});

test('inactive tasks, expired leases, stale fences and policy/tool revocation remove presentation links', () => {
  for (const change of [f => { f.task.executionControl = { stopRequested: true }; }, f => { f.task.executionControl = { stopped: true }; },
    f => { f.task.executionControl = { pauseRequested: true }; }, f => { f.task.executionControl = { paused: true }; },
    f => { f.task.status = 'completed'; }, f => { f.task.status = 'unknown'; },
    f => { f.assignment.state = 'uncertain'; }, f => { f.assignment.leaseUntil = 100; },
    f => { f.assignment.leaseUntil = undefined; }, f => { f.assignment.leaseUntil = NaN; },
    f => { f.run.fence++; }, f => { f.run.owner = 'another-worker'; }, f => { f.run.state = 'cancelled'; },
    f => { f.task.mandate.policyVersion = 'revoked-version'; }, f => { f.task.mandate.toolScope = ['read']; },
    f => { f.database.appliedTaskSnapshot = () => ({ mandate: { ...mandate(), policyVersion: 'old-version' } }); }]) {
    const f = fixture(); change(f); assert.deepEqual(f.origins(), []);
  }
});

test('profile-scoped owner API rejects remote principals, archived threads and stale Router sessions', async () => {
  const f = fixture(), state = { mainSessionId: 'router-main', threads: [{ id: 'side', sessionId: 'router-side', archived: true }] };
  const dependencies = { store: { getState: async () => state, orchestration: f.database },
    engine: { taskOwnerScope: async () => main }, readPolicy: async () => policy, peer: { principal: { kind: 'owner' } },
    input: { sessionId: 'worker-session', toolName: 'assistant_external_action' } };
  // Real leases use wall time; this fixture's lease remains current for this API call.
  f.assignment.leaseUntil = Date.now() + 60000;
  assert.equal((await resolveApprovalOrigins(dependencies)).origins.length, 1);
  for (const peer of [null, { principal: { kind: 'machine' } }]) await assert.rejects(resolveApprovalOrigins({ ...dependencies, peer }), { status: 403 });
  for (const input of [{ sessionId: 'old-router' }, { sessionId: 'router-side' },
    { sessionId: 'unknown-worker' }]) assert.deepEqual(await resolveApprovalOrigins({ ...dependencies, input }), { origins: [] });
});

test('review inbox lists existing Router and Worker sessions; decisions recheck the actual tool scope', async () => {
  const f = fixture(); f.assignment.leaseUntil = Date.now() + 60000;
  f.task.mandate.toolScope = ['ops_read'];
  const state = { mainSessionId: 'router-main', threads: [] };
  const dependencies = { store: { getState: async () => state, orchestration: f.database },
    engine: { taskOwnerScope: async () => main }, readPolicy: async () => policy, peer: { principal: { kind: 'owner' } } };
  const list = await resolveApprovalOrigins(dependencies);
  assert.deepEqual(list.origins.map(row => [row.kind, row.sessionId]), [['router', 'router-main'], ['worker', 'worker-session']]);
  assert.equal(list.origins[1].sourceTitle, '主聊天');
  const read = input => resolveApprovalOrigins({ ...dependencies, input });
  assert.equal((await read({ sessionId: 'worker-session', toolName: 'ops_read' })).origins.length, 1);
  assert.deepEqual(await read({ sessionId: 'worker-session', toolName: 'assistant_external_action' }), { origins: [] });
  for (const input of [{ toolName: 'ops_read' }, { sessionId: '' }, { sessionId: 'worker-session', toolName: '' }])
    await assert.rejects(read(input), { status: 400 });
  f.task.status = 'waiting'; f.task.executionControl = { paused: true };
  assert.deepEqual((await resolveApprovalOrigins(dependencies)).origins.map(row => row.kind), ['router']);
});

test('review source clear/archive during async policy lookup cannot authorize the old session', async () => {
  const f = fixture(); f.assignment.leaseUntil = Date.now() + 60000;
  const state = { mainSessionId: 'router-main', threads: [] };
  const dependencies = { store: { getState: async () => state, orchestration: f.database },
    engine: { taskOwnerScope: async () => main }, peer: { principal: { kind: 'owner' } },
    readPolicy: async () => { state.mainSessionId = 'new-router'; return policy; } };
  assert.deepEqual(await resolveApprovalOrigins(dependencies), { origins: [] });
});

test('channel Worker review candidates use the verified unified source mapping, without desktop impersonation', async () => {
  const f = fixture(); f.assignment.leaseUntil = Date.now() + 60000;
  const source = { channel: 'feishu', appId: 'trusted-app', connectionId: 'feishu', sourceType: 'direct', chatId: 'chat', conversationId: 'chat' };
  const thread = { id: 'channel-thread', title: '飞书私聊', sessionId: 'channel-router', source, sourceKey: channelSessionKey(source) };
  f.task.mandate = { ...mandate(), source, actorId: 'feishu-owner', policyVersion: policy.version, admission: 'explicit-owner' };
  const state = { mainSessionId: 'router-main', threads: [thread] };
  const currentPolicy = { ...policy, connection: { enabled: true, appId: 'trusted-app', ownerOpenIds: ['feishu-owner'] } };
  const dependencies = { store: { getState: async () => state, orchestration: f.database },
    engine: { taskOwnerScope: async id => ({ threadId: id, sessionIds: [id === 'main' ? 'router-main' : 'channel-router'] }) },
    readPolicy: async () => currentPolicy, peer: { principal: { kind: 'owner' } } };
  const workers = (await resolveApprovalOrigins(dependencies)).origins.filter(row => row.kind === 'worker');
  assert.equal(workers.length, 1); assert.equal(workers[0].ownerThreadId, 'channel-thread');
  assert.equal(workers[0].sourceTitle, '飞书私聊');
  thread.sourceKey = 'forged-source';
  assert.deepEqual((await resolveApprovalOrigins(dependencies)).origins.map(row => row.sessionId), ['router-main']);
});

test('real claimed assignment and official-run identity project without another approval store', t => {
  const database = createAssistantOrchestrationStore({ filename: ':memory:' });
  t.after(() => database.close());
  database.createThread({ id: 'thread', source: { type: 'desktop', id: 'thread' } });
  const task = database.createTask({ threadId: 'thread', title: 'send', target: 'send exact body', mandate: mandate() });
  database.createAssignment(task.id, { executor: 'harness' });
  const [assignment] = database.claimAssignments('worker', { validateMandate: () => true });
  const run = database.prepareRun(assignment.id, { owner: assignment.owner, fence: assignment.fence, sessionId: 'actual-worker', directory: 'workspace' });
  database.updateRun(run.id, { owner: assignment.owner, fence: assignment.fence, state: 'submitted' });
  const origins = executionApprovalOrigins({ database, ownerScope: main, ownerSessionId: 'router-main', policy });
  assert.equal(origins.length, 1); assert.equal(origins[0].runId, run.id); assert.equal(origins[0].sessionId, 'actual-worker');
});

test('incomplete historical channel tasks do not break or acquire identities in a mixed review inbox', async () => {
  const f = fixture(); f.assignment.leaseUntil = Date.now() + 60000;
  const source = { channel: 'feishu', appId: 'trusted-app', sourceType: 'direct', chatId: 'chat', conversationId: 'chat' };
  const channelMandate = { ...mandate(), source, actorId: 'feishu-owner', policyVersion: policy.version, admission: 'explicit-owner' };
  const valid = { ...f.task, id: 'channel-task', mandate: channelMandate };
  const broken = [undefined, {}, { channel: 'feishu' }, { ...source, sourceType: 'private' }].flatMap((badSource, i) =>
    ['completed', 'running', 'waiting'].map(status => ({ ...valid, id: `invalid-${i}-${status}`, status, mandate: { ...channelMandate, source: badSource } })));
  f.database.listTasks = () => [...broken, f.task, valid];
  const thread = { id: 'channel', sessionId: 'channel-router', source, sourceKey: channelSessionKey(source) };
  const state = { mainSessionId: 'router-main', threads: [thread,
    { id: 'bad-thread', sessionId: 'bad-router', sourceKey: 'channel:old', source: { channel: 'feishu' } },
    { id: 'unmapped-channel', sessionId: 'bad-router', source }] };
  const dependencies = { store: { getState: async () => state, orchestration: f.database },
    engine: { taskOwnerScope: async id => ({ threadId: id, sessionIds: [id === 'main' ? 'router-main' : 'channel-router'] }) },
    readPolicy: async () => ({ ...policy, connection: { enabled: true, appId: 'trusted-app', ownerOpenIds: ['feishu-owner'] } }),
    peer: { principal: { kind: 'owner' } } };
  const result = await resolveApprovalOrigins(dependencies);
  assert.deepEqual(result.origins.filter(row => row.kind === 'worker').map(row => [row.taskId, row.ownerThreadId]),
    [['task', 'main'], ['channel-task', 'channel']]);
  assert(!result.origins.some(row => row.sessionId === 'bad-router'));
  assert.equal(broken[0].mandate.source, undefined); // Never repair identities while reading.
  assert.deepEqual(f.origins({ channelSource: { channel: 'feishu' } }), []);
});

test('channel source becoming incomplete during lookup invalidates only that source', async () => {
  const f = fixture(); f.assignment.leaseUntil = Date.now() + 60000;
  const source = { channel: 'feishu', sourceType: 'direct', conversationId: 'chat' };
  const thread = { id: 'channel', sessionId: 'channel-router', source, sourceKey: channelSessionKey(source) };
  const state = { mainSessionId: 'router-main', threads: [thread] };
  const result = await resolveApprovalOrigins({ store: { getState: async () => state, orchestration: f.database },
    engine: { taskOwnerScope: async id => ({ threadId: id, sessionIds: [id === 'main' ? 'router-main' : 'channel-router'] }) },
    readPolicy: async id => { if (id === 'channel') delete thread.source.sourceType; return policy; },
    peer: { principal: { kind: 'owner' } } });
  assert.deepEqual(result.origins.map(row => row.ownerThreadId), ['main', 'main']);
});

for (const status of ['running', 'waiting']) test(`three-state ${status} work retains approval links only while execution controls permit it`, () => {
  const f = fixture(); f.task.status = status;
  for (const toolName of [null, 'assistant_external_action']) {
    assert.equal(f.origins({ toolName }).length, 1, 'active owned execution keeps its original official approval link');
    for (const control of ['pauseRequested', 'paused', 'stopRequested', 'stopped']) {
      f.task.executionControl = { [control]: true };
      assert.deepEqual(f.origins({ toolName }), [], `${control} removes both discovery and decision links`);
      f.task.executionControl = {};
    }
    assert.equal(f.origins({ toolName }).length, 1, 'cleared controls restore the valid same-execution link');
  }
});
