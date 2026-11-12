import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantStore } from '../src/store.mjs';
import { createAssignmentExecutor } from '../src/assignment-executor.mjs';
import { installRoleHost, loadRolePackage } from './role-host-fixture.mjs';

test('official Worker requests carry context once in the applied task package, including live revisions', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-worker-context-'));
  const store = await createAssistantStore({ dataDirectory: directory });
  const load = name => loadRolePackage('core/agent-loop', name);
  const { Context } = await load('@deepseek-ai/cordis');
  const { default: LlmRuntime, LlmAdapter } = await load('@deepseek-ai/dsh-llm');
  const ctx = new Context();
  t.after(async () => { await ctx.fiber.dispose(); await store.close(); await rm(directory, { recursive: true, force: true }); });
  await ctx.plugin(LlmRuntime);
  for (const name of ['session', 'session-projection', 'system-prompt', 'tools', 'agent', 'agent-loop'])
    await ctx.plugin((await load(`@deepseek-ai/dsh-${name}`)).default, name === 'agent-loop' ? { agents: [] } : undefined);
  await ctx.plugin(await loadRolePackage('core/tool-executor-native', '@deepseek-ai/dsh-tool-executor-native'));
  await ctx.plugin((await loadRolePackage('llm/token-meter', '@deepseek-ai/dsh-token-meter')).default);
  await installRoleHost(ctx);
  await ctx.plugin(await loadRolePackage('session/session-persistence-jsonl', '@deepseek-ai/dsh-session-persistence-jsonl'), { root: join(directory, 'sessions'), compression: 'none' });
  ctx.provide('sessionQuery', { readSession: async id => {
    const live = ctx.sessions.get(id);
    if (live) return { events: live.snapshotEvents() };
    const handle = await ctx.sessionPersistence.open(id, 'read');
    try { return await handle.read(); } finally { await handle.close(); }
  } });

  ctx.tools.register({ name: 'inspect_requirements', description: 'Test inspection', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => 'inspected' });
  const database = store.orchestration;
  const source = { channel: 'desktop', sessionId: 'owner', messageId: 'original' };
  const mandate = { actorId: 'desktop-owner', source, instruction: 'Original explicit user requirements', policyVersion: 'current', admission: 'desktop-approved-delegation', controlledActions: 'require-current-policy-and-harness-approval' };
  database.createThread({ id: 'thread', source: { type: 'desktop', id: 'owner' } });
  const ticket = database.createTicket({ threadId: 'thread', target: 'Original target', acceptance: 'Original checks', mandate });
  database.createAssignment(ticket.id, { text: 'Assigned leaf scope' });
  const revise = (revision, text) => {
    const revisedSource = { ...source, messageId: `revision-${revision}` };
    const { trigger } = database.ingest({ dedupeKey: `revision-${revision}`, thread: { id: 'thread', source: { type: 'desktop', id: 'owner' } }, source: revisedSource,
      actor: { kind: 'human', id: 'desktop-owner' }, content: text, mode: 'direct' });
    return database.changeTicket(ticket.id, { operation: 'revise', expectedInstructionRevision: revision - 1, target: `Target ${revision}`, acceptance: `Checks ${revision}`,
      reason: 'User updated requirements', requestKey: `revision-${revision}`, mandate: { ...mandate, source: revisedSource, instruction: text },
      triggerId: trigger.id, model: { providerId: 'context-test', modelId: 'opaque-worker' }, validateMandate: () => true });
  };
  revise(2, 'FIRST_CONTEXT_INPUT');
  const requests = [];
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 131072 } }; }
    async *stream(request) {
      requests.push(structuredClone(request));
      if (requests.length === 1) {
        revise(3, 'LIVE_CONTEXT_INPUT');
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'inspect', name: 'inspect_requirements', arguments: '{}' } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: 'Completed revised task' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Completed revised task' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['context-test'], new Adapter());
  const models = [{ providerId: 'context-test', modelId: 'opaque-worker' }];
  await store.updateConfig({ models, workerModels: models });
  const [assignment] = database.claimAssignments('worker', { validateMandate: () => true });
  const executor = createAssignmentExecutor({ ctx, database, workspaceRoot: join(directory, 'workers'), readPolicy: async () => ({ model: models[0], workerModels: models }), authorizeAction: async () => ({ allowed: true }) });
  const result = await executor(assignment, { ticket: database.getTicket(ticket.id), signal: AbortSignal.timeout(15000), renew: async () => {} });
  assert.equal(result.summary, 'Completed revised task');
  assert.equal(result.completion.kind, 'completed');
  assert.equal(requests.length, 2);
  for (const [index, request] of requests.entries()) {
    const runtime = request.messages.findLast(message => message.source?.kind === 'runtime-context');
    assert.ok(runtime, 'the real request contains an official runtime context snapshot');
    const sections = runtime.source.sections;
    assert.ok(!sections.some(section => section.name === 'benchgo-worker-context'));
    const packages = sections.filter(section => section.name === 'benchgo-assignment');
    assert.equal(packages.length, 1);
    const snapshot = JSON.parse(packages[0].text.split('\nTask package:\n')[1]);
    assert.equal(snapshot.instructionRevision, index + 2);
    assert.equal(snapshot.target, `Target ${index + 2}`);
    assert.equal(snapshot.acceptance, `Checks ${index + 2}`);
    assert.equal(snapshot.executionScope, 'Assigned leaf scope');
    assert.equal(snapshot.mandate.instruction, mandate.instruction);
    assert.deepEqual(snapshot.mandate.source, source);
    assert.deepEqual(snapshot.context.map(input => input.text), index ? ['FIRST_CONTEXT_INPUT', 'LIVE_CONTEXT_INPUT'] : ['FIRST_CONTEXT_INPUT']);
    assert.equal(snapshot.context[0].source.messageId, 'revision-2');
    assert.equal(snapshot.assignmentId, assignment.id);
    assert.equal(snapshot.ticketId, ticket.id);
  }
});
