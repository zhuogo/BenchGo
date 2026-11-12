import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { createAssistantStore } from '../src/store.mjs';
import { createAssistantEngine } from '../src/engine.mjs';
import { createAssignmentExecutor, workerExecutionBinding } from '../src/assignment-executor.mjs';
import { createAssistantAssignmentWorker } from '../src/assignment-worker.mjs';
import { installRoleHost, loadRolePackage } from './role-host-fixture.mjs';

test('human conversation continuation atomically reclaims the original completed run and preserves its ticket', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-native-resume-'));
  const database = createAssistantOrchestrationStore({ directory });
  t.after(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
  database.createThread({ id: 'thread', source: { type: 'desktop', id: 'desktop' } });
  const ticket = database.createTicket({ threadId: 'thread', target: 'Original work', mandate: {} });
  database.createAssignment(ticket.id, { id: 'assignment' });
  const [initial] = database.claimAssignments('first', { now: 100, leaseMs: 100, validateMandate: () => true });
  const run = database.prepareRun(initial.id, { owner: initial.owner, fence: initial.fence, sessionId: 'original-session', directory: '/original', now: 100 });
  assert.throws(() => database.resumeWorkerConversation('original-session', { owner: 'second', now: 150, validateMandate: () => true }), /active execution owner/);
  const raw = new DatabaseSync(database.path);
  raw.prepare("UPDATE sa_assignments SET state='completed',owner=NULL,lease_until=NULL WHERE id=?").run(initial.id);
  raw.prepare("UPDATE sa_tickets SET status='completed' WHERE id=?").run(ticket.id);
  assert.throws(() => database.resumeWorkerConversation('original-session', { owner: 'second', now: 201, validateMandate: () => true }), /verified effects/);
  raw.prepare("UPDATE sa_runs SET state='completed',payload=json_set(payload,'$.evidence',json(?)) WHERE id=?")
    .run(JSON.stringify({ transcript: { hash: 'saved-hash', lastSeq: 7 }, executionEffects: { effectsVerified: false } }), run.id);
  raw.close();
  assert.throws(() => database.resumeWorkerConversation('original-session', { owner: 'second', now: 201, validateMandate: () => false }), /authorization changed/);
  const resumed = database.resumeWorkerConversation('original-session', { owner: 'second', now: 201, validateMandate: () => true });
  assert.equal(resumed.id, initial.id);
  assert.equal(resumed.ticketId, ticket.id);
  assert.equal(resumed.fence, initial.fence + 1);
  assert.deepEqual(resumed.nativeContinuation, { runId: run.id });
  assert.equal(database.getTicket(ticket.id).status, 'running');
  const runs = database.runs(initial.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].id, run.id);
  assert.equal(runs[0].sessionId, 'original-session');
  assert.equal(runs[0].state, 'prepared');
  assert.equal(runs[0].owner, resumed.owner);
  assert.equal(runs[0].fence, resumed.fence);
  assert.throws(() => database.resumeWorkerConversation('original-session', { owner: 'third', now: 202, validateMandate: () => true }), /active execution owner/);
});

test('two completed official Workers accept concurrent native prompts without crossing tickets or transcripts', { timeout: 45000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-two-workers-'));
  const store = await createAssistantStore({ dataDirectory: directory });
  const load = name => loadRolePackage('core/agent-loop', name);
  const { Context } = await load('@deepseek-ai/cordis');
  const { default: LlmRuntime, LlmAdapter, createUserMessage } = await load('@deepseek-ai/dsh-llm');
  const ctx = new Context(), reached = new Set(), bothRunning = Promise.withResolvers(), release = Promise.withResolvers();
  let worker, engine;
  t.after(async () => { release.resolve(); await worker?.stop(); await engine?.dispose(); await ctx.fiber.dispose(); await store.close(); await rm(directory, { recursive: true, force: true }); });
  await ctx.plugin(LlmRuntime);
  for (const name of ['session', 'session-projection', 'system-prompt', 'tools', 'agent', 'agent-loop'])
    await ctx.plugin((await load(`@deepseek-ai/dsh-${name}`)).default, name === 'agent-loop' ? { agents: [] } : undefined);
  await ctx.plugin(await loadRolePackage('core/tool-executor-native', '@deepseek-ai/dsh-tool-executor-native'));
  await ctx.plugin((await loadRolePackage('llm/token-meter', '@deepseek-ai/dsh-token-meter')).default);
  await installRoleHost(ctx);
  await ctx.plugin(await loadRolePackage('session/session-persistence-jsonl', '@deepseek-ai/dsh-session-persistence-jsonl'), { root: join(directory, 'sessions'), compression: 'none' });
  ctx.provide('sessionQuery', { listSessions: () => ctx.sessionPersistence.list(), readSession: async id => {
    const live = ctx.sessions.get(id);
    if (live) return { events: live.snapshotEvents() };
    const handle = await ctx.sessionPersistence.open(id, 'read');
    try { return await handle.read(); } finally { await handle.close(); }
  } });
  const requests = [];
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 131072 } }; }
    async *stream(request) {
      requests.push(request);
      const body = request.messages.findLast(message => message.role === 'user')?.content?.find(block => block.type === 'text')?.text;
      let intake; try { intake = JSON.parse(body); } catch {}
      let answer = 'Verified original work';
      if (intake?.candidates) answer = JSON.stringify({ decisions: [{ candidateId: intake.candidates[0].candidateId, outcome: 'attach', ticketId: intake.tickets[0].id, reason: 'Original Worker conversation input' }] });
      const agent = ctx.agents.get(request.sessionId);
      if (agent && workerExecutionBinding(agent)) {
        const messageText = JSON.stringify(request.messages);
        if (messageText.includes('FOLLOWUP_ONLY_')) {
          reached.add(agent.id);
          if (reached.size === 2) bothRunning.resolve();
          await release.promise;
          answer = `Continued ${agent.id}`;
        }
        const checked = await ctx.tools.execute({ agent, signal: new AbortController().signal, calls: [{ type: 'tool-call', id: `check-${requests.length}`, name: 'assistant_task_result', arguments: JSON.stringify({ selfCheck: { summary: 'Verified independent result', checks: ['Original session identity'] }, outcome: 'completed' }) }] });
        assert.equal(checked.results[0].result.isError, false);
      }
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: answer };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: answer } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['isolation-test'], new Adapter());
  const models = [{ providerId: 'isolation-test', modelId: 'opaque-model' }];
  await store.updateConfig({ models, workerModels: models });
  const database = store.orchestration, policy = { model: models[0], workerModels: models };
  database.createThread({ id: 'thread', source: { type: 'desktop', id: 'owner' } });
  const tickets = ['A', 'B'].map(label => database.createTicket({ threadId: 'thread', target: `TASK_ONLY_${label}`, mandate: {} }));
  tickets.forEach(ticket => database.createAssignment(ticket.id, {}));
  const assignments = database.claimAssignments('initial', { limit: 2, validateMandate: () => true });
  const executor = createAssignmentExecutor({ ctx, database, workspaceRoot: join(directory, 'workers'), readPolicy: async () => policy, authorizeAction: async () => ({ allowed: true }) });
  const initial = await Promise.all(assignments.map(async assignment => {
    const result = await executor(assignment, { ticket: database.getTicket(assignment.ticketId), signal: AbortSignal.timeout(15000), renew: async () => {} });
    database.commitResult(assignment.ticketId, { assignment, result, uniqueKey: `initial:${assignment.id}` });
    assert.equal(ctx.agents.get(result.sessionId), undefined);
    return result;
  }));
  const completed = Promise.withResolvers(); let commits = 0;
  worker = createAssistantAssignmentWorker({ database, execute: executor, readPolicy: async () => policy, validateMandate: () => true,
    onResult: async (result, context) => {
      await context.beforeCommit();
      database.commitResult(context.ticket.id, { assignment: context.assignment, result, uniqueKey: `continued:${context.assignment.id}:${context.assignment.fence}` });
      if (++commits === 2) completed.resolve();
    } });
  engine = await createAssistantEngine({ ctx, store, resumeExecutionSession: input => worker.resumeExecutionSession(input) });
  await Promise.all(initial.map((original, index) => engine.nativePrompt({
    request: { sessionId: original.sessionId, requestId: `native-${index}`, mode: 'followup', content: [{ type: 'text', text: `FOLLOWUP_ONLY_${index}` }] },
    signal: AbortSignal.timeout(15000), dispatch: async () => {
      const agent = ctx.agents.get(original.sessionId);
      assert.equal(workerExecutionBinding(agent).runId, original.runId);
      agent.followup(createUserMessage({ source: { kind: 'user', rpcId: `native-${index}` }, content: [{ type: 'text', text: `FOLLOWUP_ONLY_${index}` }] }));
      return { requestId: `native-${index}` };
    },
  })));
  await Promise.race([bothRunning.promise, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Both Worker turns did not overlap')), 10000); timer.unref(); })]);
  assert.equal(reached.size, 2, 'both official loops reached the model before either completed');
  initial.forEach(row => assert.equal(ctx.agents.get(row.sessionId).status, 'running'));
  release.resolve();
  await completed.promise;
  for (const [index, original] of initial.entries()) {
    const ticketId = assignments[index].ticketId;
    assert.equal(database.getTicket(ticketId).resultVersion, 2);
    assert.equal(database.getTicket(ticketId).status, 'completed');
    const runs = database.runs(assignments[index].id);
    assert.equal(runs.length, 1); assert.equal(runs[0].id, original.runId); assert.equal(runs[0].sessionId, original.sessionId);
    const inputs = database.ticketInputs(ticketId).map(input => database.getTrigger(input.triggerId).content);
    assert.ok(inputs.includes(`FOLLOWUP_ONLY_${index}`));
    assert.ok(!inputs.includes(`FOLLOWUP_ONLY_${1 - index}`));
    const transcript = JSON.stringify((await ctx.sessionQuery.readSession(original.sessionId)).events);
    assert.ok(transcript.includes(`FOLLOWUP_ONLY_${index}`));
    assert.ok(!transcript.includes(`FOLLOWUP_ONLY_${1 - index}`));
    const ownRequests = requests.filter(request => request.sessionId === original.sessionId);
    assert.ok(ownRequests.length >= 2);
    assert.ok(ownRequests.every(request => !JSON.stringify(request.messages).includes(`FOLLOWUP_ONLY_${1 - index}`)));
  }
});
