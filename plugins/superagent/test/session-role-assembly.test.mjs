import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { createSessionRoleAssembly } from '../src/session-role-assembly.mjs';
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

test('Router corrects blank preset and independent permission, records actual values and leaves ordinary sessions alone', async t => {
  const { ctx, database } = await host(t);
  const ordinary = await ctx.agents.create({ sessionId: 'ordinary', meta: { cwd: process.cwd(), agentPreset: 'other' }, setup: async scope => { await ctx.agentPresets.mount(scope, 'other'); } });
  ctx.permissionPresets.set(ordinary.agent.session, 'danger-full-access');
  const before = ordinary.agent.session.snapshotEvents();
  const role = await createSessionRoleAssembly({ ctx, database, identity: identity('router') });
  const handle = await ctx.agents.create({ sessionId: 'router', meta: { cwd: process.cwd(), agentPreset: 'other' }, setup: async (scope, agent) => {
    await ctx.agentPresets.mount(scope, 'other'); ctx.permissionPresets.set(agent.session, 'danger-full-access');
    await role.mount(scope, agent);
  } });
  assert.equal(ctx.agentPresets.presetForSession(handle.agent.session), 'standard');
  assert.equal(ctx.agentPresets.composedPreset(handle.agent.ctx), 'standard');
  assert.equal(ctx.permissionPresets.current(handle.agent.session), 'workspace-write');
  assert.equal(database.getSessionRole('router').actual.approval, 'ask');
  assert.equal(database.getSessionRole('router').actual.sandbox, 'workspace-write');
  assert.deepEqual(ordinary.agent.session.snapshotEvents(), before);
  assert.equal(database.getSessionRole('ordinary'), null);
  assert.equal(ctx.permissionPresets.current(ordinary.agent.session), 'danger-full-access');
  const size = handle.agent.session.snapshotEvents().length;
  await role.reconcile();
  assert.equal(handle.agent.session.snapshotEvents().length, size, 'idempotent assembly does not replay or duplicate permission events');
});

test('a started legacy Agent preset is blocked with durable evidence and no transcript rewrite', async t => {
  const { ctx, database } = await host(t);
  const legacy = await ctx.agents.create({ sessionId: 'legacy', meta: { cwd: process.cwd(), agentPreset: 'other' }, setup: async scope => { await ctx.agentPresets.mount(scope, 'other'); } });
  legacy.agent.session.append('turn/start', { turn: 1 });
  legacy.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  const events = legacy.agent.session.snapshotEvents();
  const role = await createSessionRoleAssembly({ ctx, database, identity: identity('legacy') });
  await assert.rejects(role.mount(legacy.agent.ctx, legacy.agent), { code: 'ROLE_MIGRATION_UNAVAILABLE' });
  assert.deepEqual(legacy.agent.session.snapshotEvents(), events);
  assert.equal(ctx.agentPresets.composedPreset(legacy.agent.ctx), 'other');
  assert.equal(database.getSessionRole('legacy').status, 'blocked');
  assert.equal(database.getSessionRole('legacy').reason.code, 'ROLE_MIGRATION_UNAVAILABLE');
});

test('mislabelled permission bundles are rejected rather than silently enabling full access or never', async t => {
  const { ctx, database } = await host(t, { permissionPresetConfig: { defaultPreset: 'workspace-write',
    presets: { 'workspace-write': { sandbox: 'danger-full-access', approval: 'never' } } } });
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
  await handle.dispose();
  const restoredRole = await createSessionRoleAssembly({ ctx, database, identity: identity('resume') });
  const restored = await ctx.agents.resume({ resumeSessionId: 'resume', setup: (scope, agent) => restoredRole.mount(scope, agent) });
  assert.equal(restored.agent.session.header.agentPreset, 'other');
  assert.equal(ctx.agentPresets.presetForSession(restored.agent.session), 'standard');
  assert.equal(ctx.agentPresets.composedPreset(restored.agent.ctx), 'standard');
  assert.equal(database.getSessionRole('resume').status, 'ready');
  assert.equal(restored.agent.session.snapshotEvents().filter(event => event.type === 'turn/start').length, 1);
  await restored.dispose();
});

test('permission correction retains an existing official approval identity and never decides it', async t => {
  const { ctx, database } = await host(t);
  const { agent, role } = await owned(ctx, database, 'approval');
  agent.session.append('turn/start', { turn: 1 });
  let answer, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  ctx.on('approval/request', () => { entered(); return new Promise(resolve => { answer = resolve; }); });
  const pending = ctx.approval.request({ agent, toolName: 'protected', callId: 'original-call', reason: 'original reason', signal: new AbortController().signal });
  await ready;
  const asked = agent.session.snapshotEvents().find(event => event.type === 'approval/asked');
  ctx.permissionPresets.set(agent.session, 'danger-full-access');
  await role.reconcile();
  assert.equal(ctx.approval.overrideOf(agent.session), 'ask');
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
  first.bindSessionRole({ ...identity('saved'), expected: { agentPreset: 'standard' } });
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
    assert.throws(() => database.bindSessionRole({ role: 'worker', sessionId: 'saved', runId: 'invented', assignmentId: 'invented', ticketId: 'invented', expected: {} }), { code: 'SESSION_ROLE_OWNERSHIP' });
  } finally { database.close(); }
});

test('official spawn inherits Worker sandbox, frozen model and narrowed never policy without exposing credentials or delegation', { timeout: 15000 }, async t => {
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
  const ticket = database.createTicket({ threadId: 'owner', target: 'test slice', mandate: { source: { channel: 'desktop' } } });
  database.createAssignment(ticket.id, {});
  const [assignment] = database.claimAssignments('owner', { validateMandate: () => true });
  const run = database.prepareRun(assignment.id, { owner: assignment.owner, fence: assignment.fence, sessionId: 'worker', directory: process.cwd() });
  for (const name of ['read', 'assistant_vault_execute', 'spawn_agent']) ctx.tools.register({ name, description: name, parameters: {}, output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] }, execute: () => 'ok' });
  const role = await createSessionRoleAssembly({ ctx, database, identity: { role: 'worker', sessionId: 'worker', ticketId: ticket.id, assignmentId: assignment.id, runId: run.id } });
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
  assert.equal(actual.actual.sandbox, 'workspace-write'); assert.equal(actual.actual.approval, 'never');
  assert.equal(actual.actual.delegationApproval, 'parent-required');
  assert.equal(request.model, 'Opaque Worker/7');
  assert.equal(actual.actual.requestModel.model, 'Opaque Worker/7');
  assert.deepEqual(actual.actual.requestTools, ['read']);
  assert.equal(child.session.inheritedEventCount, 0);
  let approvals = 0;
  ctx.on('approval/request', () => { approvals++; return 'allowed-once'; });
  assert.equal(await ctx.approval.request({ agent: child, toolName: 'write', callId: 'outside', reason: 'outside workspace', signal: new AbortController().signal }), 'rejected');
  assert.equal(approvals, 0);
  const approval = child.session.snapshotEvents().filter(event => event.type === 'approval/asked' || event.type === 'approval/decided');
  assert.equal(approval.at(-2).data.reason, 'outside workspace'); assert.equal(approval.at(-1).data.outcome, 'rejected');
  const blocked = database.getSessionRole(child.id);
  assert.equal(blocked.status, 'blocked'); assert.equal(blocked.reason.code, 'CHILD_APPROVAL_PARENT_REQUIRED');
  assert.equal(blocked.reason.requestId, approval.at(-1).data.id);
  release(); await child.whenIdle();
});
