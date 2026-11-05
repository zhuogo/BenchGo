import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssignmentExecutor } from '../src/assignment-executor.mjs';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';

for (const projectMode of [false, true]) test(`host execution is persisted, isolated and permission-gated (project=${projectMode})`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-executor-'));
  const database = createAssistantOrchestrationStore({ directory });
  t.after(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
  database.createThread({ id: 'thread', source: { type: 'desktop', id: 'main' } });
  const project = { id: 'opaque-project', path: join(directory, 'source') };
  const ticket = database.createTicket({ threadId: 'thread', target: 'inspect', mandate: { scope: ['read'], source: { channel: 'feishu', chatId: 'chat' }, ...(projectMode ? { project } : {}) } });
  database.createAssignment(ticket.id, { model: { providerId: 'provider', modelId: 'opaque/model' } });
  const [assignment] = database.claimAssignments('worker', { validateMandate: () => true });
  const events = new Map(); let disposed = false, meta, submitted = false, sourceReference;
  const environment = { path: join(directory, 'isolated'), branch: 'branch', baseCommit: 'commit', repositoryRoot: project.path };
  const worktrees = { create: async (agent, request) => {
    assert.equal(submitted, false);
    assert.equal(meta.cwd, project.path);
    assert.equal(database.runs(assignment.id)[0].state, 'prepared');
    assert.equal(request.from, 'HEAD');
    return environment;
  } };
  const ctx = {
    llm: { prepareCall: async request => assert.equal(request.model, 'opaque/model') },
    sessionQuery: { readSession: async () => ({ events: [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Evidence found' }] } } }] }) },
    agents: { create: async input => {
      meta = input.meta;
      assert.equal(database.runs(assignment.id)[0].state, 'prepared');
      const agent = { followup() {
        assert.equal(database.runs(assignment.id)[0].state, 'submitted');
        submitted = true;
        events.get('agent/status')({ status: 'running' });
        queueMicrotask(() => events.get('agent/status')({ status: 'idle' }));
      } };
      await input.setup({ get: name => name === 'worktrees' ? worktrees : undefined, systemPrompt: { section() {}, context(entry) { if (entry.name === 'benchgo-worker-source-reference') sourceReference = JSON.parse(entry.text()); } }, on: (name, listener) => events.set(name, listener) }, agent);
      return { agent, dispose: async () => { disposed = true; } };
    } },
  };
  const executor = createAssignmentExecutor({ ctx, database, workspaceRoot: join(directory, 'workers'), readSourceContext: async () => ({ status: 'available', messages: [{ text: 'Earlier discussion' }] }), readPolicy: async () => ({ version: 'p1', projects: [project] }), authorizeAction: async () => ({ allowed: true }), captureCheckpoint: async input => { assert.deepEqual(input, projectMode ? environment : meta.cwd); return { version: 1, manifestHash: 'mock-checkpoint' }; } });
  const signal = new AbortController().signal;
  const result = await executor(assignment, { ticket, signal, renew: async () => {} });
  assert.equal(submitted, true); assert.equal(disposed, true);
  assert.equal(sourceReference.kind, 'untrusted-source-reference');
  assert.equal(sourceReference.messages[0].content, 'Earlier discussion');
  assert.equal(result.summary, 'Evidence found');
  assert.equal(result.directory, projectMode ? environment.path : meta.cwd);
  if (projectMode) {
    assert.deepEqual(database.runs(assignment.id)[0].environment, environment);
    assert.equal(result.checkpoint.manifestHash, 'mock-checkpoint');
    assert.throws(() => database.setRunEnvironment(result.runId, { owner: assignment.owner, fence: assignment.fence, environment }), /cannot change/);
  }
  assert.equal(database.runs(assignment.id)[0].state, 'verifying');
  assert.equal(typeof events.get('tools/execute'), 'function');
  const request = await events.get('agent/request')({ signal }, async () => ({ temperature: 0.2, provider: 'inherited', model: 'inherited' }));
  assert.equal(request.temperature, 0.2);
  assert.equal(request.provider, 'provider');
  assert.equal(request.model, 'opaque/model');
  await assert.rejects(executor(assignment, { ticket, signal, renew: async () => {} }), /reconciliation/);
});

test('deadline interrupts stalled execution and keeps its submitted run uncertain', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-executor-timeout-'));
  const database = createAssistantOrchestrationStore({ directory });
  t.after(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
  database.createThread({ id: 'thread', source: { type: 'desktop', id: 'main' } });
  const ticket = database.createTicket({ threadId: 'thread', target: 'inspect', mandate: { scope: ['read'] } });
  database.createAssignment(ticket.id, { model: { providerId: 'provider', modelId: 'opaque/model' } });
  const [assignment] = database.claimAssignments('worker', { validateMandate: () => true });
  let interrupted = 0, disposed = 0;
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  const ctx = {
    sessionQuery: { readSession: async () => { throw new Error('must not read a successful transcript'); } },
    agents: { create: async () => ({ agent: { followup() {}, cancel() { interrupted++; } }, dispose: async () => { disposed++; } }) },
  };
  const executor = createAssignmentExecutor({ ctx, database, workspaceRoot: join(directory, 'workers'), readPolicy: async () => ({}), authorizeAction: async () => ({ allowed: true }), executionTimeoutMs: 20, executionPauseGraceMs: 20 });
  await assert.rejects(executor(assignment, { ticket, signal: new AbortController().signal, renew: async () => {} }), /deadline exceeded/);
  assert.equal(interrupted, 1);
  assert.equal(disposed, 1);
  assert.equal(database.runs(assignment.id)[0].state, 'uncertain');
});

for (const cleanupFails of [false, true]) test(`cancel waits for confirmed host disposal (cleanupFails=${cleanupFails})`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-executor-cancel-'));
  const database = createAssistantOrchestrationStore({ directory });
  t.after(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
  database.createThread({ id: 'thread', source: { type: 'desktop', id: 'main' } });
  const ticket = database.createTicket({ threadId: 'thread', target: 'inspect', mandate: {} });
  database.createAssignment(ticket.id, { model: { providerId: 'provider', modelId: 'opaque/model' } });
  const [assignment] = database.claimAssignments('worker', { validateMandate: () => true });
  let submitted, disposing, release;
  const started = new Promise(resolve => { submitted = resolve; });
  const cleanupStarted = new Promise(resolve => { disposing = resolve; });
  const cleanup = new Promise(resolve => { release = resolve; });
  const ctx = { sessionQuery: { readSession: async () => assert.fail('cancel must not read result') }, agents: { create: async () => ({ agent: { followup() { submitted(); }, cancel() {} }, dispose: async () => { disposing(); await cleanup; if (cleanupFails) throw new Error('cleanup failed'); } }) } };
  const executor = createAssignmentExecutor({ ctx, database, workspaceRoot: join(directory, 'workers'), readPolicy: async () => ({}), authorizeAction: async () => ({ allowed: true }) });
  const controller = new AbortController();
  const work = executor(assignment, { ticket, signal: controller.signal, renew: async () => {} });
  const rejected = assert.rejects(work, cleanupFails ? /cleanup failed/ : /requested stop/);
  await started;
  assert.equal(database.cancelTicket(ticket.id).status, 'cancelling');
  controller.abort(new Error('requested stop'));
  await cleanupStarted;
  assert.equal(database.getTicket(ticket.id).status, 'cancelling');
  release(); await rejected;
  assert.equal(database.getTicket(ticket.id).status, cleanupFails ? 'cancelling' : 'cancelled');
});
