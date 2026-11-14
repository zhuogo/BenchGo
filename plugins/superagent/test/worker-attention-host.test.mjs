import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { installWorkerAttention } from '../src/worker-attention.mjs';

const requireHarness = createRequire(new URL('../../../deepseek-harness/packages/core/agent-loop/package.json', import.meta.url));
const hostPackages = { 'dsh-typert-registry': 'typert/registry', 'dsh-api-remote-access': 'api/remote-access',
  'dsh-api-gateway': 'api/gateway', 'dsh-api-remotes': 'api/remotes', 'dsh-user-questions': 'interaction/user-questions' };
const load = name => hostPackages[name.replace('@deepseek-ai/', '')]
  ? import(new URL(`../../../deepseek-harness/packages/${hostPackages[name.replace('@deepseek-ai/', '')]}/lib/index.js`, import.meta.url))
  : import(pathToFileURL(requireHarness.resolve(name)).href);

test('Worker Attention precedes official Remote forwarding without an owner Client and releases its scope', { timeout: 10000 }, async t => {
  const { Context } = await load('@deepseek-ai/cordis');
  const { scopeTarget } = await load('@deepseek-ai/dsh-scope');
  const ctx = new Context(), database = createAssistantOrchestrationStore({ filename: ':memory:' });
  const controller = new AbortController();
  t.after(async () => { controller.abort(); await ctx.fiber.dispose(); database.close(); });
  for (const name of ['@deepseek-ai/dsh-typert-registry', '@deepseek-ai/dsh-api-remote-access', '@deepseek-ai/dsh-api-gateway',
    '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-projection', '@deepseek-ai/dsh-system-prompt',
    '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-agent-loop', '@deepseek-ai/dsh-user-questions']) {
    await ctx.plugin((await load(name)).default, name.endsWith('agent-loop') ? { agents: [] } : undefined);
  }
  // Match the app: its Remote answerer exists before any assignment Worker.
  await ctx.plugin(await load('@deepseek-ai/dsh-api-remotes'));
  assert.equal(ctx.typertGateway.hasLiveClient(), false);
  database.createThread({ id: 'thread', source: { type: 'desktop', id: 'owner' } });
  const task = database.createTask({ threadId: 'thread', target: 'Answer', mandate: {
    instruction: '使用简体中文。展示格式由用户决定。', actorId: 'desktop-owner', source: { channel: 'desktop', sessionId: 'owner' },
  } });
  database.createAssignment(task.id, {});
  const [assignment] = database.claimAssignments('worker', { validateMandate: () => true });
  const ownership = { owner: assignment.owner, fence: assignment.fence };
  const run = database.prepareRun(assignment.id, { ...ownership, sessionId: 'attention-host-worker', directory: process.cwd() });
  database.updateRun(run.id, { ...ownership, state: 'submitted' });
  let triaged = 0;
  const worker = await ctx.agents.create({ sessionId: run.sessionId, meta: { cwd: process.cwd() }, setup(scope, agent) {
    installWorkerAttention(scope, agent, { database, assignment, signal: controller.signal, pollMs: 1,
      readPolicy: async () => ({ models: [{ providerId: 'fixture', modelId: 'Opaque Router' }] }),
      llm: { async *stream() {
        triaged++;
        yield { type: 'text-delta', text: JSON.stringify({ decisions: [
          { questionId: 'known', route: 'self', basis: '原指令明确语言', evidence: '简体中文' },
          { questionId: 'format', route: 'user', basis: '用户保留格式选择' },
        ] }) };
        yield { type: 'finish', reason: { kind: 'stop' } };
      } },
    });
  } });
  const questions = [{ id: 'known', question: '交付语言？' }, { id: 'format', question: '列表还是短句？', options: [{ label: '列表' }, { label: '短句' }] }];
  const answer = ctx.userQuestions.ask({ agent: worker.agent, questions, wait: { callId: 'blocking-call' }, signal: controller.signal });
  answer.catch(() => {});
  for (let i = 0; i < 1000 && !database.attentions(task.id).length && !ctx.typertGateway.getPendingRemoteEvents().length; i++) await nextTurn();
  assert.equal(triaged, 1);
  assert.deepEqual(ctx.typertGateway.getPendingRemoteEvents(), [], 'owned Worker questions never wait for a Remote Client');
  const [attention] = database.attentions(task.id);
  assert.equal(attention?.question.id, 'format');
  database.answerDesktopAttention({ taskId: task.id, attentionId: attention.id, instructionRevision: 1,
    requestId: 'real-user-answer', answer: { selected: ['列表'] } });
  assert.deepEqual(await answer, { answers: [{ id: 'known', selected: [], custom: '简体中文' }, { id: 'format', selected: ['列表'] }] });

  const foreign = await ctx.agents.create({ sessionId: 'foreign-worker', meta: { cwd: process.cwd() } });
  // A different live Agent, even on the owned dispatch scope, must delegate.
  await assert.rejects(async () => ctx.waterfall(scopeTarget(worker.agent, worker.agent), 'user-questions/request',
    { agent: foreign.agent, questions, signal: controller.signal }, () => assert.fail('Remote forwarding should reject the mismatched subject')),
  /must carry its Agent directly/);
  assert.equal(triaged, 1);

  await worker.dispose();
  installWorkerAttention(foreign.agent.ctx, foreign.agent, { assignment, signal: controller.signal,
    database: { ...database, getTask: () => ({ ...task, mandate: { ...task.mandate, source: { channel: 'unsupported' } } }) },
    llm: { async *stream() { assert.fail('unsupported channels must delegate'); } },
  });
  const foreignAbort = new AbortController();
  const unowned = ctx.userQuestions.ask({ agent: foreign.agent, questions, signal: foreignAbort.signal });
  unowned.catch(() => {});
  for (let i = 0; i < 1000 && !ctx.typertGateway.getPendingRemoteEvents().length; i++) await nextTurn();
  assert.deepEqual(ctx.typertGateway.getPendingRemoteEvents(), [{ event: 'user-questions/request', agentId: foreign.agent.id }]);
  assert.equal(triaged, 1, 'disposing the Worker removes its answerer');
  foreignAbort.abort(new Error('fixture request ended'));
  await assert.rejects(unowned, { code: 'ASK_ABORTED' });
  await foreign.dispose();
});
