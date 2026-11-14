import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openExecutionSession, registerExecutionSessionDiscovery } from '../client/execution-session-navigation.mjs';

test('official AgentLoop disposal preserves a cold Worker in the catalog before closure and opens the same historical identity', { timeout: 15000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-execution-catalog-'));
  const requireHarness = createRequire(new URL('../../../deepseek-harness/packages/core/agent-loop/package.json', import.meta.url));
  const load = name => import(pathToFileURL(requireHarness.resolve(name)).href);
  // Read the official emitted classes; the package's bundle keeps them private.
  const { ApiSessionList } = await import('../../../deepseek-harness/packages/api/session-controller/lib/types/list.js');
  const { SessionManager } = await import('../../../deepseek-harness/packages/api/session-controller/lib/types/client/sessions/manager.js');
  const { Context } = await load('@deepseek-ai/cordis');
  const { default: LlmRuntime, LlmAdapter, createUserMessage } = await load('@deepseek-ai/dsh-llm');
  const ctx = new Context();
  let manager;
  t.after(async () => { await manager?.dispose(); await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }); });
  await ctx.plugin(LlmRuntime);
  for (const name of ['@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-projection', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-agent']) await ctx.plugin((await load(name)).default);
  await ctx.plugin(await load('@deepseek-ai/dsh-session-persistence-jsonl'), { root: join(directory, 'sessions'), compression: 'none' });
  await ctx.plugin((await import('../../../deepseek-harness/packages/session-query/session-query/lib/index.js')).default);
  await ctx.plugin((await load('@deepseek-ai/dsh-agent-loop')).default, { agents: [] });
  await ctx.plugin(await load('@deepseek-ai/dsh-tool-executor-native'));
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 131072 } }; }
    async *stream() {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: 'Verified result' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Verified result' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['catalog-test'], new Adapter());
  const list = new ApiSessionList(ctx, 10);
  await list.initialize();
  let listGate, listRead;
  manager = new SessionManager({ session: { list: async () => {
    const items = await list.list();
    if (listGate) { listRead.resolve(); await listGate; }
    return { ok: true, value: { items } };
  } } });
  const sessionId = 'official-worker-catalog';
  let removed, closeDiscovery, gate, refreshStarted, closed = false, refreshes = 0;
  const client = { sessions: { list: { getSnapshot: () => ({ ids: manager.getListSnapshot().items.map(row => row.sessionId) }) },
    refresh: async () => { refreshes++; refreshStarted?.resolve(); await manager.refreshList(); } },
    remote: { $on: (_name, listener) => { removed = listener; } }, effect: setup => { closeDiscovery = setup(); },
    uiWorkspace: { unarchiveSession: async () => assert.fail('opening execution never restores archive'), openSession: id => { assert.equal(manager.resolveTarget(id), sessionId); } } };
  registerExecutionSessionDiscovery(client, async () => {
    await gate;
    return (await ctx.sessionQuery.listSessions()).filter(row => row.header.id === sessionId).map(() => ({ sessionId, closed }));
  });
  t.after(() => closeDiscovery());
  let discovery;
  ctx.on('session/created', session => manager.handleSessionAdded(list.summaryFor(session)));
  ctx.on('session/disposed', session => { manager.handleSessionRemoved(session.id); discovery = removed(session.id); });
  const handle = await ctx.agents.create({ sessionId, meta: { cwd: directory } });
  handle.agent.model.select({ provider: 'catalog-test', model: 'opaque-model' });
  handle.agent.followup(createUserMessage({ source: { kind: 'benchgo-worker-instruction' }, content: [{ type: 'text', text: 'Complete the task' }] }));
  await handle.agent.whenIdle();
  assert.equal(handle.agent.session.snapshotEvents().findLast(event => event.type === 'turn/end').data.reason.kind, 'completed');
  await manager.refreshList();
  // A pull already in flight will apply the later removal even if it returned
  // this Session. The plugin must follow that shared pull with one fresh read.
  const heldPull = Promise.withResolvers();
  listGate = heldPull.promise; listRead = Promise.withResolvers();
  const stalePull = manager.refreshList();
  await listRead.promise;
  let release;
  gate = new Promise(resolve => { release = resolve; });
  await handle.dispose();
  assert.equal(ctx.sessions.get(sessionId), undefined);
  assert.throws(() => manager.resolveTarget(sessionId), /sessions.retain: unknown session/);
  const record = (await ctx.sessionQuery.listSessions()).find(row => row.header.id === sessionId);
  assert.equal(record.persisted, true); assert.equal(record.live, false);
  refreshStarted = Promise.withResolvers();
  release(); await refreshStarted.promise;
  listGate = undefined; heldPull.resolve();
  await stalePull; await discovery;
  const row = manager.getListSnapshot().items.find(item => item.sessionId === sessionId);
  assert.equal(row.cwd, directory); assert.equal(row.running, false); assert.equal(row.blank, false);
  assert.equal(manager.resolveTarget(sessionId), sessionId);
  assert.equal(refreshes, 2, 'unclosed Worker returns without a user click, even after joining a stale pull');
  assert.equal((await ctx.sessionQuery.readSession(sessionId)).events.findLast(event => event.type === 'turn/end').data.reason.kind, 'completed');
  closed = true;
  manager.handleSessionRemoved(sessionId);
  await removed(sessionId);
  assert.equal(refreshes, 3, 'completed Task remains discoverable');
  await openExecutionSession(client, { available: true, sessionId, closed: true });
  assert.equal(refreshes, 4);
  assert.equal(ctx.agents.get(sessionId), undefined, 'viewing history does not restart the Worker');
  assert.equal((await ctx.sessionQuery.listSessions()).filter(row => row.header.id === sessionId).length, 1);
});
