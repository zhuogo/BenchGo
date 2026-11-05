import test from 'node:test';
import assert from 'node:assert/strict';
import { installWorkerSubagents } from '../src/worker-subagents.mjs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

function fixture() {
  const listeners = new Map(), effects = [];
  const scope = { effect: fn => effects.push(fn()), on() {} };
  const worker = { id: 'worker' };
  const ctx = { agents: { get: id => id === worker.id ? worker : undefined }, on: (event, fn) => { listeners.set(event, fn); return () => listeners.delete(event); } };
  let version = 'one', allowed = true, fence = 4;
  const options = { ctx, assignment: { id: 'assignment', ticketId: 'ticket', owner: 'owner', fence: 4 },
    database: { getTicket: () => ({ mandate: { source: { channel: 'desktop' } } }), ticketGoalBudget: () => null,
      renewAssignment: (_id, input) => ({ allowed: input.fence === fence && input.validateMandate() }) },
    readPolicy: async () => ({ desktopVersion: version }), authorizeAction: async () => ({ allowed }),
  };
  installWorkerSubagents(scope, worker, { ...options, authorizeAction: (...args) => options.authorizeAction(...args) });
  const makeChild = (id, parentSession) => {
    const hooks = new Map();
    const child = { id, session: { header: { origin: 'subagent', parentSession }, snapshotEvents: () => [] }, ctx: {
      on: (event, fn) => { hooks.set(event, [...(hooks.get(event) || []), fn]); return () => {}; }, effect: fn => effects.push(fn()),
      systemPrompt: { section: item => { child.prompt = item.text; } },
    } };
    listeners.get('agent/created')({ agent: child });
    return { child, async execute(name, action = () => 'ok') {
      const wrappers = hooks.get('tools/execute') || [];
      const execution = { name, agent: child, signal: new AbortController().signal };
      return wrappers.reduceRight((next, wrapper) => () => wrapper(execution, next), action)();
    } };
  };
  return { makeChild, effects, listeners, options, setAllowed: value => { allowed = value; }, setFence: value => { fence = value; }, setVersion: value => { version = value; } };
}

test('official child inherits live permission and fence, keeps questions/results with Worker, and cannot spawn a grandchild', async () => {
  const f = fixture(), child = f.makeChild('child', 'worker');
  assert.equal(await child.execute('web_fetch'), 'ok');
  assert.match(child.child.prompt, /questions, blockers and results to your direct parent Worker/);
  assert.throws(() => f.makeChild('grandchild', 'child'), { code: 'WORKER_SUBAGENT_DEPTH' });
  await assert.rejects(child.execute('assistant_vault_execute'), { code: 'WORKER_SUBAGENT_VAULT' });
  f.setAllowed(false);
  await assert.rejects(child.execute('web_fetch'), /权限/);
  f.setAllowed(true); f.setFence(5);
  await assert.rejects(child.execute('web_fetch'), /权限/);
  for (const dispose of f.effects) dispose();
  assert.equal(f.listeners.size, 0);
});

test('policy tightening while a child awaits authorization prevents its dispatch', async () => {
  const f = fixture();
  f.options.authorizeAction = async () => { f.setVersion('two'); return { allowed: true }; };
  const child = f.makeChild('child', 'worker');
  await assert.rejects(child.execute('write', () => assert.fail('revoked dispatch')), /权限/);
});

test('official agent creation installs child scope gates before tool dispatch and vetoes a grandchild', async t => {
  const requireHarness = createRequire(new URL('../../../deepseek-harness/packages/core/agent-loop/package.json', import.meta.url));
  const load = name => import(pathToFileURL(requireHarness.resolve(name)).href);
  const { Context } = await load('@deepseek-ai/cordis');
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  for (const name of ['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-projection', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-agent-loop']) {
    await ctx.plugin((await load(name)).default, name.endsWith('agent-loop') ? { agents: [] } : undefined);
  }
  await ctx.plugin(await load('@deepseek-ai/dsh-tool-executor-native'));
  let allowed = true, dispatched = 0;
  ctx.tools.register({ name: 'read', description: 'Test read', parameters: {}, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => { dispatched++; return 'read'; } });
  const database = { getTicket: () => ({ mandate: { source: { channel: 'desktop' } } }), ticketGoalBudget: () => null,
    renewAssignment: (_id, input) => ({ allowed: input.validateMandate() }) };
  const parent = await ctx.agents.create({ sessionId: 'benchgo-test-worker', meta: { cwd: process.cwd() }, setup: (scope, agent) => { installWorkerSubagents(scope, agent, {
    ctx, database, assignment: { id: 'assignment', ticketId: 'ticket' }, readPolicy: async () => ({ desktopVersion: 'one' }), authorizeAction: async () => ({ allowed }),
  }); } });
  const child = await ctx.agents.create({ sessionId: 'benchgo-test-child', meta: { cwd: process.cwd(), origin: 'subagent', parentSession: parent.agent.id, delegationDepth: 1 } });
  const execute = () => child.agent.ctx.tools.execute({ agent: child.agent, signal: new AbortController().signal, calls: [{ type: 'tool-call', id: `read-${dispatched}`, name: 'read', arguments: '{}' }] });
  assert.equal((await execute()).results[0].result.isError, false);
  allowed = false;
  assert.equal((await execute()).results[0].result.isError, true);
  assert.equal(dispatched, 1);
  await assert.rejects(ctx.agents.create({ sessionId: 'benchgo-test-grandchild', meta: { cwd: process.cwd(), origin: 'subagent', parentSession: child.agent.id, delegationDepth: 2 } }), /一层子代理/);
  assert.equal(ctx.agents.get('benchgo-test-grandchild'), undefined);
  await child.dispose(); await parent.dispose();
});
