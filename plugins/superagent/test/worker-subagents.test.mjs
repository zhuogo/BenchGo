import test from 'node:test';
import assert from 'node:assert/strict';
import { installWorkerSubagents } from '../src/worker-subagents.mjs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

test('official child and fork preserve native tools, history and nested delegation', async t => {
  const requireHarness = createRequire(new URL('../../../deepseek-harness/packages/core/agent-loop/package.json', import.meta.url));
  const load = name => import(pathToFileURL(requireHarness.resolve(name)).href);
  const { Context } = await load('@deepseek-ai/cordis');
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  for (const name of ['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-projection', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-agent-loop']) {
    await ctx.plugin((await load(name)).default, name.endsWith('agent-loop') ? { agents: [] } : undefined);
  }
  await ctx.plugin(await load('@deepseek-ai/dsh-tool-executor-native'));
  let dispatched = 0, modelRequests = 0;
  ctx.on('agent/request', (_request, next) => { modelRequests++; return next(); });
  ctx.tools.register({ name: 'read', description: 'Test read', parameters: {}, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => { dispatched++; return 'read'; } });
  const database = { getTicket: () => ({ mandate: { source: { channel: 'desktop' } } }), ticketGoalBudget: () => null,
    renewAssignment: (_id, input) => ({ allowed: input.validateMandate() }) };
  const parent = await ctx.agents.create({ sessionId: 'benchgo-test-worker', meta: { cwd: process.cwd() }, setup: (scope, agent) => { installWorkerSubagents(scope, agent, {
    ctx, database, assignment: { id: 'assignment', ticketId: 'ticket' },
  }); } });
  const child = await ctx.agents.create({ sessionId: 'benchgo-test-child', meta: { cwd: process.cwd(), origin: 'subagent', parentSession: parent.agent.id, delegationDepth: 1 } });
  const execute = () => child.agent.ctx.tools.execute({ agent: child.agent, signal: new AbortController().signal, calls: [{ type: 'tool-call', id: `read-${dispatched}`, name: 'read', arguments: '{}' }] });
  assert.equal((await execute()).results[0].result.isError, false);
  assert.equal((await execute()).results[0].result.isError, false);
  assert.equal(dispatched, 2);
  const grandchild = await ctx.agents.create({ sessionId: 'benchgo-test-grandchild', meta: { cwd: process.cwd(), origin: 'subagent', parentSession: child.agent.id, delegationDepth: 2 } });
  assert.ok(ctx.agents.get('benchgo-test-grandchild'));
  await grandchild.dispose();
  // Exercise the real official fork provider's completed-turn history preparation,
  // then the same official Agent factory used by its local child runtime.
  const { createUserMessage } = await load('@deepseek-ai/dsh-llm');
  parent.agent.session.append('turn/start', { turn: 1 });
  parent.agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'private parent history outside the child task slice' }], source: { kind: 'user' } }), { surfaceOp: 'append' });
  parent.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  const requireFork = createRequire(new URL('../../../deepseek-harness/packages/subagent/subagent-fork-in-process/package.json', import.meta.url));
  const forkModule = await import(pathToFileURL(requireFork.resolve('@deepseek-ai/dsh-subagent-fork-in-process')).href);
  let forkProvider;
  forkModule.apply({ subagents: { registerProvider: provider => { forkProvider = provider; } } }, { providerName: 'official-fork' });
  const prepared = await forkProvider.prepareContinuable({ parent: parent.agent });
  assert.equal(forkProvider.inheritsParentContext, true);
  assert.equal(prepared.seed.at(-1).type, 'turn/end');
  assert.match(JSON.stringify(prepared.seed), /private parent history outside the child task slice/);
  const fork = await ctx.agents.create({ sessionId: 'benchgo-test-history-fork', seed: prepared.seed, inheritedEventCount: prepared.seed.length,
    meta: { cwd: process.cwd(), origin: 'subagent', parentSession: parent.agent.id, delegationDepth: 1, isSeeded: true } });
  assert.equal(fork.agent.session.inheritedEventCount, prepared.seed.length);
  await fork.dispose();
  assert.equal(modelRequests, 0);
  const sibling = await ctx.agents.create({ sessionId: 'benchgo-test-sibling', meta: { cwd: process.cwd(), origin: 'subagent', parentSession: parent.agent.id, delegationDepth: 1, isSeeded: false } });
  await sibling.dispose();
  await child.dispose(); await parent.dispose();
});
