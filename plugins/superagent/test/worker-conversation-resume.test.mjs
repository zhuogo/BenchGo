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
import { recordDesktopTrigger } from '../src/desktop-trigger.mjs';
import { executionEvidence } from '../src/execution-evidence.mjs';
import { createDesktopTaskControl } from '../src/desktop-task-control.mjs';
import { desktopTaskManagementScope } from '../src/desktop-task-management-authority.mjs';
import { createOrchestrationRuntime } from '../src/orchestration-runtime.mjs';
import { readAssessmentPolicy } from '../src/assessment-policy.mjs';
import { taskReplySignal } from '../src/task-reply.mjs';

test('human conversation continuation reclaims the original run with an unknown tool outcome', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-native-resume-'));
  const database = createAssistantOrchestrationStore({ directory });
  t.after(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
  database.createThread({ id: 'thread', source: { type: 'desktop', id: 'desktop' } });
  const task = database.createTask({ threadId: 'thread', target: 'Original work', mandate: {} });
  database.createAssignment(task.id, { id: 'assignment' });
  const [initial] = database.claimAssignments('first', { now: 100, leaseMs: 100, validateMandate: () => true });
  const run = database.prepareRun(initial.id, { owner: initial.owner, fence: initial.fence, sessionId: 'original-session', directory: '/original', now: 100 });
  assert.throws(() => database.resumeWorkerConversation('original-session', { owner: 'second', now: 150, validateMandate: () => true }), /active execution owner/);
  const raw = new DatabaseSync(database.path);
  raw.prepare("UPDATE sa_assignments SET state='uncertain',owner=NULL,lease_until=NULL WHERE id=?").run(initial.id);
  raw.prepare("UPDATE sa_tasks SET status='waiting' WHERE id=?").run(task.id);
  raw.prepare("UPDATE sa_runs SET state='uncertain',payload=json_set(payload,'$.evidence',json(?)) WHERE id=?")
    .run(JSON.stringify({ transcript: { hash: 'saved-hash', lastSeq: 7 }, executionEffects: { effectsVerified: false } }), run.id);
  raw.close();
  assert.throws(() => database.resumeWorkerConversation('original-session', { owner: 'second', now: 201, validateMandate: () => false }), /authorization changed/);
  const resumed = database.resumeWorkerConversation('original-session', { owner: 'second', now: 201, validateMandate: () => true });
  assert.equal(resumed.id, initial.id);
  assert.equal(resumed.taskId, task.id);
  assert.equal(resumed.fence, initial.fence + 1);
  assert.deepEqual(resumed.nativeContinuation, { runId: run.id });
  assert.equal(database.getTask(task.id).status, 'running');
  const runs = database.runs(initial.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].id, run.id);
  assert.equal(runs[0].sessionId, 'original-session');
  assert.equal(runs[0].state, 'prepared');
  assert.equal(runs[0].owner, resumed.owner);
  assert.equal(runs[0].fence, resumed.fence);
  assert.throws(() => database.resumeWorkerConversation('original-session', { owner: 'third', now: 202, validateMandate: () => true }), /active execution owner/);
});

test('two completed official Workers accept concurrent native prompts without crossing tasks or transcripts', { timeout: 45000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-two-workers-'));
  const store = await createAssistantStore({ dataDirectory: directory });
  const load = name => loadRolePackage('core/agent-loop', name);
  const { Context } = await load('@deepseek-ai/cordis');
  const { default: LlmRuntime, LlmAdapter, createUserMessage } = await load('@deepseek-ai/dsh-llm');
  const ctx = new Context(), reached = new Set(), bothRunning = Promise.withResolvers(), release = Promise.withResolvers();
  let worker, engine, warm;
  t.after(async () => { release.resolve(); await worker?.stop(); await engine?.dispose(); await warm?.dispose(); await ctx.fiber.dispose(); await store.close(); await rm(directory, { recursive: true, force: true }); });
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
      assert.notEqual(request.purpose, 'superagent-assessment');
      let answer = 'Verified original work';
      const agent = ctx.agents.get(request.sessionId);
      if (agent && workerExecutionBinding(agent)) {
        const messageText = JSON.stringify(request.messages);
        if (messageText.includes('FOLLOWUP_ONLY_')) {
          reached.add(agent.id);
          if (reached.size === 2) bothRunning.resolve();
          await release.promise;
          answer = `Continued ${agent.id}`;
        }
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
  const tasks = ['A', 'B'].map(label => database.createTask({ threadId: 'thread', target: `TASK_ONLY_${label}`, mandate: {} }));
  tasks.forEach(task => database.createAssignment(task.id, {}));
  const assignments = database.claimAssignments('initial', { limit: 2, validateMandate: () => true });
  const executor = createAssignmentExecutor({ ctx, database, workspaceRoot: join(directory, 'workers'), readPolicy: async () => policy });
  const initial = await Promise.all(assignments.map(async assignment => {
    const result = await executor(assignment, { task: database.getTask(assignment.taskId), signal: AbortSignal.timeout(15000), renew: async () => {} });
    database.commitResult(assignment.taskId, { assignment, result, uniqueKey: `initial:${assignment.id}` });
    assert.equal(ctx.agents.get(result.sessionId), undefined);
    return result;
  }));
  const completed = Promise.withResolvers(); let commits = 0;
  warm = await ctx.agents.resume({ resumeSessionId: initial[0].sessionId });
  worker = createAssistantAssignmentWorker({ database, execute: executor, readPolicy: async () => policy, validateMandate: () => true,
    onResult: async (result, context) => {
      await context.beforeCommit();
      database.commitResult(context.task.id, { assignment: context.assignment, result, uniqueKey: `continued:${context.assignment.id}:${context.assignment.fence}` });
      if (++commits === 2) completed.resolve();
    } });
  engine = await createAssistantEngine({ ctx, store, resumeExecutionSession: input => worker.resumeExecutionSession(input) });
  await Promise.all(initial.map((original, index) => engine.nativePrompt({
    request: { sessionId: original.sessionId, requestId: `native-${index}`, mode: 'followup', content: [{ type: 'text', text: `FOLLOWUP_ONLY_${index}` }] },
    signal: AbortSignal.timeout(15000), dispatch: async () => {
      const agent = ctx.agents.get(original.sessionId);
      if (index === 0) assert.equal(agent, warm.agent);
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
    const taskId = assignments[index].taskId;
    assert.equal(database.getTask(taskId).resultVersion, 2);
    assert.equal(database.getTask(taskId).status, 'completed');
    const runs = database.runs(assignments[index].id);
    assert.equal(runs.length, 1); assert.equal(runs[0].id, original.runId); assert.equal(runs[0].sessionId, original.sessionId);
    const inputs = database.taskInputs(taskId).map(input => database.getTrigger(input.triggerId).content);
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

test('Router messages recover and redirect the same official Worker without an execution assessment', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-router-worker-message-'));
  const store = await createAssistantStore({ dataDirectory: directory });
  const database = store.orchestration;
  const load = name => loadRolePackage('core/agent-loop', name);
  const { Context } = await load('@deepseek-ai/cordis');
  const { default: LlmRuntime, LlmAdapter } = await load('@deepseek-ai/dsh-llm');
  const ctx = new Context(), firstRequest = Promise.withResolvers(), release = Promise.withResolvers();
  let warm, runtime;
  t.after(async () => { release.resolve(); await runtime?.stop(); await warm?.dispose(); await ctx.fiber.dispose(); await store.close(); await rm(directory, { recursive: true, force: true }); });
  await ctx.plugin(LlmRuntime);
  for (const name of ['session', 'session-projection', 'system-prompt', 'tools', 'agent', 'agent-loop'])
    await ctx.plugin((await load(`@deepseek-ai/dsh-${name}`)).default, name === 'agent-loop' ? { agents: [] } : undefined);
  await ctx.plugin(await loadRolePackage('core/tool-executor-native', '@deepseek-ai/dsh-tool-executor-native'));
  await ctx.plugin((await loadRolePackage('llm/token-meter', '@deepseek-ai/dsh-token-meter')).default);
  await installRoleHost(ctx);
  await ctx.plugin(await loadRolePackage('session/session-persistence-jsonl', '@deepseek-ai/dsh-session-persistence-jsonl'), { root: join(directory, 'sessions'), compression: 'none' });
  ctx.provide('sessionQuery', {
    readSession: async id => ({ events: ctx.sessions.get(id).snapshotEvents() }),
    async observeSession() { return null; },
  });
  const model = { providerId: 'fixture', modelId: 'exact-model' };
  await store.updateConfig({ models: [model], workerModels: [model] });
  const policy = await readAssessmentPolicy(store);
  let requests = 0, currentGoal, changedRequest, task;
  const reply = answer => [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text: answer },
    { type: 'block-end', index: 0, block: { type: 'text', text: answer } }, { type: 'finish', reason: { kind: 'stop' } }];
  class Adapter extends LlmAdapter {
    async resolveModel(provider, id) { return { provider, id, name: id, context: { contextWindow: 131072 } }; }
    async *stream(request) {
      assert.notEqual(request.purpose, 'superagent-assessment');
      const message = request.messages.findLast(message => message.role === 'user')?.content[0]?.text;
      if (requests === 1 && message?.includes('改搜范冰冰') && message.includes('New instruction for this Task')) {
        requests++;
        const { triggerId } = JSON.parse(message.slice(message.indexOf('\n') + 1));
        assert.equal(database.getTask(task.id).target, '搜索吴亦凡公开资料');
        const args = { triggerId, target: '搜索范冰冰公开资料', title: '搜索范冰冰资料', reason: '按已确认的变更执行' };
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'adopt', name: 'benchgo_adopt_task_message', arguments: JSON.stringify(args) } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      if (++requests === 1) {
        assert.match(JSON.stringify(request.messages), /继续/);
        firstRequest.resolve();
        await release.promise;
      } else {
        currentGoal = database.getTask(task.id).target;
        changedRequest = JSON.stringify(request.messages);
      }
      yield* reply(requests === 1 ? '旧回合收尾' : '范冰冰资料已整理');
    }
  }
  ctx.llm.registerAdapter(['fixture'], new Adapter());
  const text = (id, value) => ({ id, source: { kind: 'user' }, content: [{ type: 'text', text: value }] });
  const origin = recordDesktopTrigger(database, { sessionId: 'router', message: text('original', '搜索吴亦凡') }).trigger;
  task = database.createTask({ threadId: origin.threadId, title: '搜索吴亦凡', target: '搜索吴亦凡公开资料', mandate: { actorId: 'desktop-owner',
    source: origin.source, policyVersion: policy.desktopVersion, admission: 'desktop-approved-delegation', instruction: origin.content,
    controlledActions: 'require-current-policy-and-harness-approval' } });
  database.createAssignment(task.id, { executor: 'harness', model });
  const [initial] = database.claimAssignments('original-worker', { validateMandate: () => true });
  const ownership = { owner: initial.owner, fence: initial.fence };
  const sessionId = 'worker-original';
  const run = database.prepareRun(initial.id, { ...ownership, sessionId, directory });
  database.freezeWorkerModelRoute({ assignmentId: initial.id, runId: run.id, ...ownership, models: [model], index: 0 });
  warm = await ctx.agents.create({ sessionId, meta: { cwd: directory } });
  warm.agent.session.append('turn/start', { turn: 1 });
  warm.agent.session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'disposed' } } });
  database.updateRun(run.id, { ...ownership, state: 'submitted' });
  database.updateRun(run.id, { ...ownership, state: 'uncertain' });
  database.renewAssignment(initial.id, { ...ownership, validateMandate: () => false });
  const routerEvents = [{ type: 'turn/start' }, { type: 'user/message', data: text('historical', '旧消息') }];
  let router = { id: 'router', status: 'running', session: { header: {}, snapshotEvents: () => routerEvents } };
  const routerCtx = { agents: { get: () => router, currentInitiator: () => router, turnBoundaryOf: () => ({ openTurnStartSeq: 0 }) } };
  const control = createDesktopTaskControl({ database, ctx: routerCtx });
  const send = async text => control.control({ id: task.id, operation: 'supplement', text }, { agent: router }, { ownerAgent: router,
    managementScope: await desktopTaskManagementScope({ ctx: routerCtx, agent: router, store: { getState: () => ({ mainSessionId: router.id }) } }) });
  assert.equal((await send()).duplicate, false);
  database.markWorkerMessageBlocked(task.id, { code: 'EXECUTION_EFFECTS_UNKNOWN', reason: 'Legacy effects gate', now: Date.now() - 60000 });
  assert.deepEqual(database.interruptedWorkerMessages(), []);
  routerEvents[1].data = text('continue', '继续');
  assert.equal((await send()).duplicate, false);
  assert.equal(database.interruptedWorkerMessages()[0].id, initial.id);
  const changedTitles = [], notification = Promise.withResolvers();
  runtime = createOrchestrationRuntime({ ctx, store, intervalMs: 25,
    notifyTaskResult: delivery => {
      const reply = taskReplySignal(database, delivery);
      if (reply?.kind === 'result') notification.resolve(reply);
      return { status: 'accepted', messageId: 'router-inbox' };
    },
    onTaskTitleChanged: id => changedTitles.push(database.getTask(id).title) });
  await runtime.start();
  const signal = AbortSignal.timeout(12000);
  const deadline = new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  try {
    await Promise.race([firstRequest.promise, deadline]);
    assert.equal(ctx.agents.get(sessionId), warm.agent);
    router = { ...router, id: 'new-router-session' };
    routerEvents[1].data = text('change', '按刚才说的改');
    const sent = await send('不搜吴亦凡了，改搜范冰冰');
    assert.equal(sent.duplicate, false);
    assert.equal(database.getTrigger(sent.triggerId).content, '按刚才说的改');
    assert.equal((await send('不搜吴亦凡了，改搜范冰冰')).duplicate, true);
    assert.equal(database.getTask(task.id).title, '搜索吴亦凡');
  } finally { release.resolve(); }
  const delivered = await Promise.race([notification.promise, deadline]);
  const result = database.results(task.id).at(-1);
  assert.equal(result.sessionId, sessionId);
  assert.equal(result.runId, run.id);
  assert.equal(result.summary, '范冰冰资料已整理');
  assert.equal(delivered.source.sessionId, 'new-router-session');
  assert.equal(delivered.source.messageId, 'change');
  assert.equal(delivered.text, result.summary);
  assert.equal(currentGoal, '搜索范冰冰公开资料');
  assert.match(changedRequest, /不搜吴亦凡了，改搜范冰冰/);
  assert.match(changedRequest, /搜索范冰冰公开资料/);
  assert.deepEqual(changedTitles, ['搜索范冰冰资料']);
  assert.equal(database.taskInputs(task.id).filter(input => input.state === 'applied').length, 3);
  assert.equal(database.pendingSubscriptionMessages(task.id).length, 0);
  assert.ok(executionEvidence({ events: warm.agent.session.snapshotEvents() }).transcript.lastSeq > 2);
});
