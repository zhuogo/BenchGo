import test from 'node:test';
import assert from 'node:assert/strict';
import { installWorkerSubagents } from '../src/worker-subagents.mjs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

function fixture() {
  const listeners = new Map(), effects = [];
  const definitions = new Map(['web_fetch', 'write', 'assistant_vault_execute', 'assistant_vault_list', 'subagent', 'ask_user_question', 'assistant_memory', 'assistant_task_result', 'send_message'].map(name => [name, { name }]));
  const tools = { schemas: () => [...definitions.keys()].map(name => ({ name })), get: name => definitions.get(name), restrict: () => () => {} };
  const scope = { tools, effect: fn => effects.push(fn()), on() {} };
  const worker = { id: 'worker' };
  const ctx = { agents: { get: id => id === worker.id ? worker : undefined }, on: (event, fn) => { listeners.set(event, fn); return () => listeners.delete(event); } };
  let version = 'one', allowed = true, fence = 4;
  const options = { ctx, assignment: { id: 'assignment', ticketId: 'ticket', owner: 'owner', fence: 4 },
    database: { getTicket: () => ({ mandate: { source: { channel: 'desktop' } } }), ticketGoalBudget: () => null,
      renewAssignment: (_id, input) => ({ allowed: input.fence === fence && input.validateMandate() }) },
    readPolicy: async () => ({ desktopVersion: version }), authorizeAction: async () => ({ allowed }),
  };
  installWorkerSubagents(scope, worker, { ...options, authorizeAction: (...args) => options.authorizeAction(...args) });
  const makeChild = (id, parentSession, { isSeeded, inheritedEventCount } = {}) => {
    const hooks = new Map();
    const child = { id, session: { header: { origin: 'subagent', parentSession, isSeeded }, inheritedEventCount, snapshotEvents: () => [] }, ctx: {
      tools, on: (event, fn) => { hooks.set(event, [...(hooks.get(event) || []), fn]); return () => {}; }, effect: fn => effects.push(fn()),
      systemPrompt: { section: item => { child.prompt = item.text; } },
    } };
    listeners.get('agent/created')({ agent: child });
    return { child, hooks, async execute(name, action = () => 'ok') {
      const wrappers = hooks.get('tools/execute') || [];
      const execution = { name, agent: child, signal: new AbortController().signal };
      return wrappers.reduceRight((next, wrapper) => () => wrapper(execution, next), action)();
    } };
  };
  return { makeChild, effects, listeners, options, definitions, setAllowed: value => { allowed = value; }, setFence: value => { fence = value; }, setVersion: value => { version = value; } };
}

test('official child inherits live permission and fence, keeps questions/results with Worker, and cannot spawn a grandchild', async () => {
  const f = fixture(), child = f.makeChild('child', 'worker');
  assert.equal(await child.execute('web_fetch'), 'ok');
  assert.match(child.child.prompt, /questions, blockers and results to your direct parent Worker/);
  assert.throws(() => f.makeChild('grandchild', 'child'), { code: 'WORKER_SUBAGENT_DEPTH' });
  await assert.rejects(child.execute('assistant_vault_execute'), { code: 'WORKER_SUBAGENT_VAULT' });
  for (const name of ['subagent', 'ask_user_question', 'assistant_memory', 'assistant_task_result']) await assert.rejects(child.execute(name), { code: 'WORKER_SUBAGENT_TOOL' });
  const sibling = f.makeChild('sibling', 'worker');
  assert.equal(await sibling.execute('web_fetch'), 'ok');
  f.setAllowed(false);
  await assert.rejects(child.execute('web_fetch'), /权限/);
  f.setAllowed(true); f.setFence(5);
  await assert.rejects(child.execute('web_fetch'), /权限/);
  for (const dispose of f.effects) dispose();
  assert.equal(f.listeners.size, 0);
});

test('child pre-execute rejects same-name replacement and later capability additions', async () => {
  const f = fixture(), child = f.makeChild('child', 'worker');
  f.definitions.set('web_fetch', { name: 'web_fetch', replaced: true });
  const hooks = child.hooks.get('tools/pre-execute');
  const execution = { name: 'web_fetch', agent: child.child, signal: new AbortController().signal };
  await assert.rejects(hooks.reduceRight((next, hook) => () => hook(execution, next), () => assert.fail('replaced tool dispatched'))(), { code: 'WORKER_SUBAGENT_TOOL' });
  f.definitions.set('new_tool', { name: 'new_tool' });
  await assert.rejects(child.execute('new_tool'), { code: 'WORKER_SUBAGENT_TOOL' });
});

test('policy tightening while a child awaits authorization prevents its dispatch', async () => {
  const f = fixture();
  f.options.authorizeAction = async () => { f.setVersion('two'); return { allowed: true }; };
  const child = f.makeChild('child', 'worker');
  await assert.rejects(child.execute('write', () => assert.fail('revoked dispatch')), /权限/);
});

test('child creation rejects inherited context by exact session marker or prefix count', () => {
  const f = fixture();
  for (const metadata of [{ isSeeded: true, inheritedEventCount: 0 }, { isSeeded: false, inheritedEventCount: 4 }, { inheritedEventCount: 1 }]) {
    assert.throws(() => f.makeChild('fork', 'worker', metadata), { code: 'WORKER_SUBAGENT_CONTEXT' });
  }
  f.makeChild('spawn-one', 'worker', { isSeeded: false, inheritedEventCount: 0 });
  f.makeChild('spawn-two', 'worker', { isSeeded: false, inheritedEventCount: 0 });
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
  let allowed = true, dispatched = 0, modelRequests = 0;
  ctx.on('agent/request', (_request, next) => { modelRequests++; return next(); });
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
  await assert.rejects(ctx.agents.create({ sessionId: 'benchgo-test-history-fork', seed: prepared.seed, inheritedEventCount: prepared.seed.length,
    meta: { cwd: process.cwd(), origin: 'subagent', parentSession: parent.agent.id, delegationDepth: 1, isSeeded: true } }), { code: 'WORKER_SUBAGENT_CONTEXT' });
  assert.equal(ctx.agents.get('benchgo-test-history-fork'), undefined);
  assert.equal(modelRequests, 0);
  const sibling = await ctx.agents.create({ sessionId: 'benchgo-test-sibling', meta: { cwd: process.cwd(), origin: 'subagent', parentSession: parent.agent.id, delegationDepth: 1, isSeeded: false } });
  await sibling.dispose();
  await child.dispose(); await parent.dispose();
});
