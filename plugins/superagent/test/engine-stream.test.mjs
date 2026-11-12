import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createAssistantEngine } from '../src/engine.mjs';
import { projectReplyStream } from '../client/reply-stream.mjs';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { installRoleHost } from './role-host-fixture.mjs';

const requireHarness = createRequire(new URL('../../../deepseek-harness/packages/core/agent-loop/package.json', import.meta.url));
const load = name => import(pathToFileURL(requireHarness.resolve(name)).href);
const { Context } = await load('@deepseek-ai/cordis');
const { default: LlmRuntime, LlmAdapter, BlockAssembler } = await load('@deepseek-ai/dsh-llm');
const modules = await Promise.all(['@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-projection', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-agent-loop'].map(load));
const compactRequire = createRequire(new URL('../../../deepseek-harness/packages/compaction/compaction-basic/package.json', import.meta.url));
const { default: Compaction } = await import(pathToFileURL(compactRequire.resolve('@deepseek-ai/dsh-compaction-basic')).href);
const tokenRequire = createRequire(new URL('../../../deepseek-harness/packages/llm/token-meter/package.json', import.meta.url));
const { default: TokenMeter } = await import(pathToFileURL(tokenRequire.resolve('@deepseek-ai/dsh-token-meter')).href);
const latch = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

for (const cancelled of [false, true]) test(`ordinary Router text uses live official frames before final persistence (cancelled=${cancelled})`, async t => {
  const ctx = new Context(), first = latch(), second = latch(), finish = latch(), observed = [];
  await ctx.plugin(LlmRuntime);
  for (let index = 0; index < modules.length; index++) await ctx.plugin(modules[index].default, index === modules.length - 1 ? { agents: [] } : undefined);
  await ctx.plugin(TokenMeter);
  await installRoleHost(ctx);
  class Adapter extends LlmAdapter {
    async resolveModel(provider, id) { return { provider, id, name: id }; }
    async *stream() {
      yield { type: 'block-start', index: 0, blockType: 'reasoning' };
      yield { type: 'reasoning-delta', index: 0, text: 'PRIVATE_REASONING' };
      yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'PRIVATE_REASONING' } };
      yield { type: 'block-start', index: 1, blockType: 'text' };
      yield { type: 'text-delta', index: 1, text: '第一段' };
      await second.promise;
      yield { type: 'text-delta', index: 1, text: '，第二段' };
      await finish.promise;
      yield { type: 'block-end', index: 1, block: { type: 'text', text: '第一段，第二段' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['stream-test'], new Adapter());
  let state = { revision: 0, mainSessionId: null, threads: [], requests: [] };
  const store = { paths: { workspace: process.cwd() }, orchestration: createAssistantOrchestrationStore({ filename: ':memory:' }), getState: async () => structuredClone(state),
    updateState: async (patch, { revision }) => { assert.equal(revision, state.revision); state = { ...state, ...structuredClone(patch), revision: revision + 1 }; return state; },
    getConfig: async () => ({ models: [{ providerId: 'stream-test', modelId: 'opaque' }] }),
    memory: { forgottenRevision: () => 0, redactForgottenContext: value => value }, ledger: { append: () => ({}) }, getSessionContext: async () => ({ documents: [], memories: [] }),
  };
  ctx.provide('sessionQuery', { listSessions: async () => ctx.sessions.list().map(session => ({ header: session.header })), readSession: async id => ({ events: ctx.sessions.get(id).snapshotEvents() }) });
  const engine = await createAssistantEngine({ ctx, store, compactionPlugin: Compaction, appendChatRecord: modules[0].appendPluginRecord });
  t.after(async () => { second.resolve(); finish.resolve(); await engine.dispose(); await ctx.fiber.dispose(); store.orchestration.close(); });
  const assembler = new BlockAssembler();
  let current, textCount = 0;
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (agent.id !== state.mainSessionId) return;
    observed.push(frame);
    if (frame.type === 'start') current = frame;
    if (frame.type === 'chunk') {
      assembler.push(frame.chunk);
      if (frame.chunk.type === 'text-delta' && ++textCount === 1) first.resolve();
    }
  }, { global: true });
  await engine.send({ text: '请解释一下', requestId: 'stream-request' });
  const agent = await engine.ensureSession();
  await first.promise;
  const history = await engine.history();
  assert.equal(history.running, true);
  assert.equal(history.messages.some(row => row.role === 'assistant'), false, 'unfinished text is not a persisted final reply');
  const render = () => projectReplyStream({ history, sessionId: agent.id, running: agent.status === 'running', chat: { legacy: {
    partial: { turn: current.turn, step: current.step, blocks: assembler.blocks().map(block => ({ ...block, kind: block.type })) },
  } } });
  const initial = render();
  assert.equal(initial.text, '第一段');
  assert.equal(initial.streaming, true);
  assert.doesNotMatch(JSON.stringify(initial), /PRIVATE_REASONING/);
  assert.equal(observed.some(frame => frame.type === 'end'), false, 'first visible content precedes official stream settlement');
  second.resolve();
  for (let attempt = 0; attempt < 20 && textCount < 2; attempt++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(render().text, '第一段，第二段');
  assert.equal(render().key, initial.key);
  if (cancelled) await engine.cancel();
  finish.resolve();
  await agent.whenIdle();
  const final = await engine.history();
  assert.equal(render(), null);
  assert.equal(final.messages.filter(row => row.role === 'assistant').length, cancelled ? 0 : 1);
  if (!cancelled) assert.equal(final.messages.at(-1).text, '第一段，第二段');
  assert.doesNotMatch(JSON.stringify(final.messages), /PRIVATE_REASONING/);
});
