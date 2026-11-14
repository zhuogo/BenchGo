import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { createSessionRoleAssembly, SUPERAGENT_ROLE_PROFILE } from '../src/session-role-assembly.mjs';
import { readOwnedSessionRole } from '../src/execution-session.mjs';
import { installWorkerSubagents } from '../src/worker-subagents.mjs';
import { installRoleHost, loadRolePackage } from './role-host-fixture.mjs';

const req = createRequire(new URL('../../../deepseek-harness/packages/core/agent-loop/package.json', import.meta.url));
const load = name => import(pathToFileURL(req.resolve(name)).href);
const { Context } = await load('@deepseek-ai/cordis');
const { LlmAdapter } = await load('@deepseek-ai/dsh-llm');
async function host(t, { directory, persistence = false, permissionPresetConfig } = {}) {
  const ctx = new Context();
  for (const name of ['llm', 'session', 'session-projection', 'system-prompt', 'tools', 'agent', 'agent-loop', 'tool-executor-native'])
    await ctx.plugin((await load(`@deepseek-ai/dsh-${name}`)).default ?? await load(`@deepseek-ai/dsh-${name}`), name === 'agent-loop' ? { agents: [] } : undefined);
  await installRoleHost(ctx, { permissionPresetConfig });
  const logs = persistence ? await mkdtemp(join(tmpdir(), 'benchgo-role-session-')) : null;
  if (logs) await ctx.plugin(await loadRolePackage('session/session-persistence-jsonl', '@deepseek-ai/dsh-session-persistence-jsonl'), { root: logs, compression: 'none' });
  const database = createAssistantOrchestrationStore(directory ? { directory } : { filename: ':memory:' });
  t.after(async () => { await ctx.fiber.dispose(); database.close(); if (logs) await rm(logs, { recursive: true, force: true, maxRetries: 5 }); });
  return { ctx, database };
}
const identity = sessionId => ({ role: 'router', sessionId, threadId: 'main' });
async function owned(ctx, database, id) {
  const role = await createSessionRoleAssembly({ ctx, database, identity: identity(id) });
  const handle = await ctx.agents.create({ sessionId: id, meta: { cwd: process.cwd(), agentPreset: 'standard' }, setup: (scope, agent) => role.mount(scope, agent) });
  return { ...handle, role };
}

test('Router pins official Full on creation and reconciliation without changing ordinary sessions', async t => {
  const { ctx, database } = await host(t);
  const ordinary = await ctx.agents.create({ sessionId: 'ordinary', meta: { cwd: process.cwd(), agentPreset: 'other' }, setup: async scope => { await ctx.agentPresets.mount(scope, 'other'); } });
  ctx.permissionPresets.set(ordinary.agent.session, 'workspace-write');
  const before = ordinary.agent.session.snapshotEvents();
  const role = await createSessionRoleAssembly({ ctx, database, identity: identity('router') });
  const handle = await ctx.agents.create({ sessionId: 'router', meta: { cwd: process.cwd(), agentPreset: 'other' }, setup: async (scope, agent) => {
    await ctx.agentPresets.mount(scope, 'other'); ctx.permissionPresets.set(agent.session, 'workspace-write');
    await role.mount(scope, agent);
  } });
  assert.equal(ctx.agentPresets.presetForSession(handle.agent.session), 'standard');
  assert.equal(ctx.agentPresets.composedPreset(handle.agent.ctx), 'standard');
  assert.equal(ctx.permissionPresets.current(handle.agent.session), 'danger-full-access');
  assert.equal(database.getSessionRole('router').actual.approval, 'never');
  assert.equal(database.getSessionRole('router').actual.sandbox, 'danger-full-access');
  assert.deepEqual(database.getSessionRole('router').expected, SUPERAGENT_ROLE_PROFILE);
  assert.deepEqual(ordinary.agent.session.snapshotEvents(), before);
  assert.equal(database.getSessionRole('ordinary'), null);
  assert.equal(ctx.permissionPresets.current(ordinary.agent.session), 'workspace-write');
  const size = handle.agent.session.snapshotEvents().length;
  const observation = database.getSessionRole('router').updatedAt;
  await role.reconcile();
  assert.equal(database.getSessionRole('router').updatedAt, observation, 'unchanged configuration does not rewrite its observation');
  assert.equal(handle.agent.session.snapshotEvents().length, size, 'idempotent assembly does not replay or duplicate permission events');
  ctx.permissionPresets.set(handle.agent.session, 'workspace-write');
  await role.reconcile();
  assert.equal(ctx.permissionPresets.current(handle.agent.session), 'danger-full-access');
  assert.equal(ctx.approval.overrideOf(handle.agent.session), 'never');
});

test('a started Agent preset keeps its history while applying official Full', async t => {
  const { ctx, database } = await host(t);
  const legacy = await ctx.agents.create({ sessionId: 'legacy', meta: { cwd: process.cwd(), agentPreset: 'other' }, setup: async scope => { await ctx.agentPresets.mount(scope, 'other'); } });
  legacy.agent.session.append('turn/start', { turn: 1 });
  legacy.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  const events = legacy.agent.session.snapshotEvents();
  const role = await createSessionRoleAssembly({ ctx, database, identity: identity('legacy') });
  await role.mount(legacy.agent.ctx, legacy.agent);
  assert.deepEqual(legacy.agent.session.snapshotEvents().slice(0, events.length), events);
  assert.equal(ctx.agentPresets.composedPreset(legacy.agent.ctx), 'other');
  assert.equal(database.getSessionRole('legacy').status, 'ready');
  assert.equal(database.getSessionRole('legacy').actual.agentPreset, 'other');
  assert.equal(database.getSessionRole('legacy').actual.permissionPreset, 'danger-full-access');
  assert.equal(database.getSessionRole('legacy').actual.approval, 'never');
});

test('a mislabelled Full bundle cannot silently narrow the fixed role permissions', async t => {
  const { ctx, database } = await host(t, { permissionPresetConfig: { defaultPreset: 'workspace-write',
    presets: { 'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
      'danger-full-access': { sandbox: 'workspace-write', approval: 'ask' } } } });
  await assert.rejects(owned(ctx, database, 'wrong-bundle'), { code: 'ROLE_PERMISSION_BUNDLE_INVALID' });
  assert.equal(database.getSessionRole('wrong-bundle').reason.code, 'ROLE_PERMISSION_BUNDLE_INVALID');
  assert.equal(ctx.agents.get('wrong-bundle'), undefined);
});

test('official resume uses the durable blank-session selection instead of its stale creation header', async t => {
  const { ctx, database } = await host(t, { persistence: true });
  const role = await createSessionRoleAssembly({ ctx, database, identity: identity('resume') });
  const handle = await ctx.agents.create({ sessionId: 'resume', meta: { cwd: process.cwd(), agentPreset: 'other' }, setup: (scope, agent) => role.mount(scope, agent) });
  handle.agent.session.append('turn/start', { turn: 1 });
  handle.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  ctx.permissionPresets.set(handle.agent.session, 'workspace-write');
  await handle.dispose();
  const restoredRole = await createSessionRoleAssembly({ ctx, database, identity: identity('resume') });
  const restored = await ctx.agents.resume({ resumeSessionId: 'resume', setup: (scope, agent) => restoredRole.mount(scope, agent) });
  assert.equal(restored.agent.session.header.agentPreset, 'other');
  assert.equal(ctx.agentPresets.presetForSession(restored.agent.session), 'standard');
  assert.equal(ctx.agentPresets.composedPreset(restored.agent.ctx), 'standard');
  assert.equal(database.getSessionRole('resume').status, 'ready');
  assert.equal(database.getSessionRole('resume').actual.sandbox, 'danger-full-access');
  assert.equal(database.getSessionRole('resume').actual.approval, 'never');
  assert.equal(restored.agent.session.snapshotEvents().filter(event => event.type === 'turn/start').length, 1);
  await restored.dispose();
});

test('Worker resume refreshes expected permissions and observes Full without replaying work', async t => {
  const { ctx, database } = await host(t, { persistence: true });
  database.createThread({ id: 'owner', source: { type: 'desktop', id: 'main' } });
  const task = database.createTask({ threadId: 'owner', target: 'continue saved work', mandate: { source: { channel: 'desktop' } } });
  database.createAssignment(task.id, {});
  const [assignment] = database.claimAssignments('owner', { validateMandate: () => true });
  const run = database.prepareRun(assignment.id, { owner: assignment.owner, fence: assignment.fence,
    sessionId: 'saved-worker', directory: process.cwd() });
  const workerIdentity = { role: 'worker', sessionId: run.sessionId, taskId: task.id, assignmentId: assignment.id, runId: run.id };
  const previousPermissions = { agentPreset: 'standard', permissionPreset: 'workspace-write', sandbox: 'workspace-write', approval: 'ask' };
  database.bindSessionRole({ ...workerIdentity, expected: previousPermissions });
  database.recordSessionRole(run.sessionId, { status: 'ready', actual: previousPermissions });
  const handle = await ctx.agents.create({ sessionId: run.sessionId, meta: { cwd: process.cwd(), agentPreset: 'standard' },
    setup: async (scope, agent) => {
      await ctx.agentPresets.mount(scope, 'standard');
      ctx.permissionPresets.set(agent.session, 'workspace-write');
    } });
  handle.agent.session.append('turn/start', { turn: 1 });
  handle.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  const history = handle.agent.session.snapshotEvents();
  await handle.dispose();
  const role = await createSessionRoleAssembly({ ctx, database, identity: workerIdentity });
  assert.deepEqual(database.getSessionRole(run.sessionId).expected, SUPERAGENT_ROLE_PROFILE);
  assert.equal(database.getSessionRole(run.sessionId).actual, null, 'a changed contract invalidates the previous observation');
  assert.equal(database.getSessionRole(run.sessionId).status, 'pending');
  assert.equal(database.getSessionRole(run.sessionId).reason, null);
  const restored = await ctx.agents.resume({ resumeSessionId: run.sessionId, setup: (scope, agent) => role.mount(scope, agent) });
  assert.deepEqual(restored.agent.session.snapshotEvents().slice(0, history.length), history);
  assert.equal(restored.agent.session.snapshotEvents().filter(event => event.type === 'turn/start').length, 1);
  assert.equal(ctx.permissionPresets.current(restored.agent.session), 'danger-full-access');
  assert.equal(ctx.approval.overrideOf(restored.agent.session), 'never');
  assert.equal(database.getSessionRole(run.sessionId).actual.sandbox, 'danger-full-access');
  ctx.permissionPresets.set(restored.agent.session, 'workspace-write');
  await role.reconcile();
  assert.equal(ctx.permissionPresets.current(restored.agent.session), 'danger-full-access');
  assert.equal(ctx.approval.overrideOf(restored.agent.session), 'never');
  assert.throws(() => database.bindSessionRole({ ...workerIdentity, taskId: 'unrelated', expected: {} }), { code: 'SESSION_ROLE_OWNERSHIP' });
  assert.deepEqual(database.getSessionRole(run.sessionId).expected, SUPERAGENT_ROLE_PROFILE);
  await restored.dispose();
});

test('permission correction retains an existing official approval identity and never decides it', async t => {
  const { ctx, database } = await host(t);
  const { agent, role } = await owned(ctx, database, 'approval');
  agent.session.append('turn/start', { turn: 1 });
  ctx.permissionPresets.set(agent.session, 'workspace-write');
  let answer, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  ctx.on('approval/request', () => { entered(); return new Promise(resolve => { answer = resolve; }); });
  const pending = ctx.approval.request({ agent, toolName: 'protected', callId: 'original-call', reason: 'original reason', signal: new AbortController().signal });
  await ready;
  const asked = agent.session.snapshotEvents().find(event => event.type === 'approval/asked');
  await role.reconcile();
  assert.equal(ctx.approval.overrideOf(agent.session), 'never');
  assert.deepEqual(agent.session.snapshotEvents().filter(event => event.type === 'approval/asked'), [asked]);
  assert.equal(agent.session.snapshotEvents().some(event => event.type === 'approval/decided'), false);
  answer('rejected');
  assert.equal(await pending, 'rejected');
  assert.deepEqual(agent.session.snapshotEvents().filter(event => event.type === 'approval/decided').map(event => event.data), [{ id: asked.data.id, outcome: 'rejected' }]);
  agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
});

test('persisted ownership and cold legacy ownership remain distinct from ordinary sessions', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-role-store-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  const first = createAssistantOrchestrationStore({ directory });
  first.bindSessionRole({ ...identity('saved'), expected: SUPERAGENT_ROLE_PROFILE });
  first.recordSessionRole('saved', { status: 'blocked', actual: null, reason: { code: 'ROLE_MIGRATION_UNAVAILABLE', message: 'blocked' } });
  first.close();
  const database = createAssistantOrchestrationStore({ directory });
  try {
    const store = { orchestration: database, getState: async () => ({ mainSessionId: 'cold-main', threads: [{ id: 'side', sessionId: 'cold-side' }], sessionLineage: { main: ['history'] } }) };
    assert.equal((await readOwnedSessionRole({ store, sessionId: 'saved' })).reason.code, 'ROLE_MIGRATION_UNAVAILABLE');
    for (const id of ['cold-main', 'cold-side', 'history']) {
      const role = await readOwnedSessionRole({ store, sessionId: id });
      assert.equal(role.role, 'router'); assert.equal(role.status, 'pending'); assert.equal(role.actual, null);
    }
    assert.equal(await readOwnedSessionRole({ store, sessionId: 'ordinary' }), null);
    assert.throws(() => database.bindSessionRole({ role: 'worker', sessionId: 'saved', runId: 'invented', assignmentId: 'invented', taskId: 'invented', expected: {} }), { code: 'SESSION_ROLE_OWNERSHIP' });
  } finally { database.close(); }
});

test('opening the role store invalidates obsolete cold observations without changing ownership or child inheritance', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-role-cache-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  const first = createAssistantOrchestrationStore({ directory });
  const previousPermissions = { agentPreset: 'standard', permissionPreset: 'workspace-write', sandbox: 'workspace-write', approval: 'ask' };
  first.bindSessionRole({ ...identity('cold-router'), expected: previousPermissions });
  first.recordSessionRole('cold-router', { status: 'ready', actual: previousPermissions });
  first.createThread({ id: 'owner', source: { type: 'desktop', id: 'main' } });
  const task = first.createTask({ threadId: 'owner', target: 'saved task', mandate: { source: { channel: 'desktop' } } });
  first.createAssignment(task.id, {});
  const [assignment] = first.claimAssignments('owner', { validateMandate: () => true });
  const run = first.prepareRun(assignment.id, { owner: assignment.owner, fence: assignment.fence, sessionId: 'cold-worker', directory: process.cwd() });
  const worker = { role: 'worker', sessionId: run.sessionId, taskId: task.id, assignmentId: assignment.id, runId: run.id };
  first.bindSessionRole({ ...worker, expected: previousPermissions });
  first.recordSessionRole(run.sessionId, { status: 'blocked', actual: previousPermissions, reason: { code: 'OLD_OBSERVATION' } });
  first.bindSessionRole({ ...worker, role: 'child-worker', sessionId: 'cold-child', parentSessionId: run.sessionId, expected: {} });
  const child = first.recordSessionRole('cold-child', { status: 'ready', actual: null });
  const ownership = first.listSessionRoles();
  first.close();
  const database = createAssistantOrchestrationStore({ directory });
  let refreshed;
  try {
    assert.deepEqual(database.listSessionRoles(), ownership);
    for (const id of ['cold-router', 'cold-worker']) {
      const role = database.getSessionRole(id);
      assert.deepEqual(role.expected, SUPERAGENT_ROLE_PROFILE);
      assert.equal(role.status, 'pending');
      assert.equal(role.actual, null);
      assert.equal(role.reason, null);
    }
    assert.deepEqual(database.getSessionRole('cold-child'), child);
    refreshed = ownership.map(({ sessionId }) => database.getSessionRole(sessionId));
  } finally { database.close(); }
  const reopened = createAssistantOrchestrationStore({ directory });
  try {
    assert.deepEqual(ownership.map(({ sessionId }) => reopened.getSessionRole(sessionId)), refreshed, 'reopening an unchanged contract is a no-op');
  } finally { reopened.close(); }
});

test('official spawn inherits Worker Full, model and native tools without BenchGo child gates', { timeout: 15000 }, async t => {
  const { ctx, database } = await host(t, { persistence: true });
  ctx.provide('workingDirectory', { get: session => session.header.cwd, ensure: async agent => agent.session.header.cwd, set: async (_agent, cwd) => cwd });
  ctx.provide('sessionQuery', { listSessions: async () => ctx.sessions.list().map(session => ({ header: session.header })), readSession: async id => {
    const session = ctx.sessions.get(id); return { header: session.header, events: session.snapshotEvents() };
  } });
  await ctx.plugin((await loadRolePackage('subagent/subagent', '@deepseek-ai/dsh-subagent')).default);
  await ctx.plugin(await loadRolePackage('subagent/subagent-spawn-in-process', '@deepseek-ai/dsh-subagent-spawn-in-process'), { providerName: 'spawn' });
  let release, entered;
  const waiting = new Promise(resolve => { release = resolve; }), requested = new Promise(resolve => { entered = resolve; });
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 32768 } }; }
    async *stream(options) {
      options.signal?.addEventListener('abort', release, { once: true });
      entered(options); await waiting;
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['role-test'], new Adapter());
  database.createThread({ id: 'owner', source: { type: 'desktop', id: 'main' } });
  const task = database.createTask({ threadId: 'owner', target: 'test slice', mandate: { source: { channel: 'desktop' } } });
  database.createAssignment(task.id, {});
  const [assignment] = database.claimAssignments('owner', { validateMandate: () => true });
  const run = database.prepareRun(assignment.id, { owner: assignment.owner, fence: assignment.fence, sessionId: 'worker', directory: process.cwd() });
  for (const name of ['read', 'assistant_vault_execute', 'spawn_agent']) ctx.tools.register({ name, description: name, parameters: {}, output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] }, execute: () => 'ok' });
  const role = await createSessionRoleAssembly({ ctx, database, identity: { role: 'worker', sessionId: 'worker', taskId: task.id, assignmentId: assignment.id, runId: run.id } });
  const parent = await ctx.agents.create({ sessionId: 'worker', meta: { cwd: process.cwd(), agentPreset: 'standard' }, agentOptions: { provider: 'role-test', model: 'Opaque Worker/7' }, setup: async (scope, agent) => {
    await role.mount(scope, agent);
    installWorkerSubagents(scope, agent, { ctx, database, assignment, parentRole: role,
      models: [{ providerId: 'role-test', modelId: 'Opaque Worker/7' }], currentModel: () => ({ providerId: 'role-test', modelId: 'Opaque Worker/7' }),
      readPolicy: async () => ({ desktopVersion: 'one' }), authorizeAction: async () => ({ allowed: true }) });
  } });
  ctx.on('agent/pre-step', ({ agent }, next) => agent === parent.agent ? { kind: 'reject' } : next());
  t.after(() => release());
  const activation = await ctx.subagents.startActivation({ parent: parent.agent, provider: 'spawn', label: 'slice', prompt: [{ type: 'text', text: 'only slice' }], signal: new AbortController().signal });
  const request = await requested;
  const child = ctx.agents.get(activation.childId), actual = database.getSessionRole(activation.childId);
  assert.equal(actual.role, 'child-worker'); assert.equal(actual.parentSessionId, 'worker');
  const identities = database.listSessionRoles();
  assert.ok(identities.some(row => row.sessionId === 'worker' && row.role === 'worker' && row.runId === run.id));
  assert.ok(identities.some(row => row.sessionId === activation.childId && row.role === 'child-worker' && row.parentSessionId === 'worker'));
  assert.ok(identities.every(row => !('actual' in row) && !('expected' in row)), 'sidebar enumeration returns only ownership metadata');
  const nested = database.bindSessionRole({ role: 'child-worker', sessionId: 'nested-child', parentSessionId: child.id,
    taskId: task.id, assignmentId: assignment.id, runId: run.id, expected: {} });
  assert.equal(nested.parentSessionId, child.id);
  assert.throws(() => database.bindSessionRole({ ...nested, sessionId: 'foreign-child', taskId: 'foreign' }), { code: 'SESSION_ROLE_OWNERSHIP' });
  assert.equal(actual.status, 'ready');
  assert.equal(actual.actual, null, 'ownership does not invent a second child assembly');
  assert.equal(ctx.sandboxPolicy.resolve({ session: parent.agent.session }).mode, 'danger-full-access');
  assert.equal(ctx.sandboxPolicy.resolve({ session: child.session }).mode, 'danger-full-access');
  assert.equal(ctx.permissionPresets.current(child.session), 'danger-full-access');
  assert.equal(ctx.approval.overrideOf(child.session), 'never');
  assert.equal(request.model, 'Opaque Worker/7');
  assert.ok(request.tools.some(tool => tool.name === 'read'));
  assert.ok(request.tools.some(tool => tool.name === 'spawn_agent'), 'official tools are not restricted by BenchGo');
  assert.equal(child.session.inheritedEventCount, 0);
  let approvals = 0;
  ctx.on('approval/request', () => { approvals++; return 'allowed-once'; });
  assert.equal(await ctx.approval.request({ agent: child, toolName: 'write', callId: 'outside', reason: 'outside workspace', signal: new AbortController().signal }), 'rejected');
  assert.equal(approvals, 0);
  const approval = child.session.snapshotEvents().filter(event => event.type === 'approval/asked' || event.type === 'approval/decided');
  assert.equal(approval.at(-2).data.reason, 'outside workspace'); assert.equal(approval.at(-1).data.outcome, 'rejected');
  assert.equal(database.getSessionRole(child.id).status, 'ready', 'official rejection does not create a permanent BenchGo child blocker');
  release(); await child.whenIdle();
});
