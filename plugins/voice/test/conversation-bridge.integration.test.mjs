import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createConversationBridge } from '../src/conversation-bridge.mjs';

// The checked-out official engine supplies production runtime services; no source is patched.
const upstream = createRequire(new URL('../../../deepseek-harness/packages/core/agent-loop/package.json', import.meta.url));
const load = async name => import(pathToFileURL(upstream.resolve(name)).href);
const { Context } = await load('@deepseek-ai/cordis');
const { default: LlmRuntime, LlmAdapter, createUserMessage } = await load('@deepseek-ai/dsh-llm');
const { default: SessionStore, SessionId, appendPluginRecord } = await load('@deepseek-ai/dsh-session');
const { default: SessionProjections } = await load('@deepseek-ai/dsh-session-projection');
const { default: SystemPrompt } = await load('@deepseek-ai/dsh-system-prompt');
const { default: Tools } = await load('@deepseek-ai/dsh-tools');
const { default: Agents } = await load('@deepseek-ai/dsh-agent');
const { default: AgentLoop } = await import('../../../deepseek-harness/packages/core/agent-loop/lib/index.js');
const nativeExecutor = await import('../../../deepseek-harness/packages/core/tool-executor-native/lib/index.js');

test('真实 Cordis + 官方 AgentLoop/Session 运行交接、引用上下文与完成事件（本地 LLM，无外网）', { timeout: 10000 }, async t => {
  class LocalAdapter extends LlmAdapter {
    requests = [];
    async resolveModel(provider, model) { return { provider, id: model, name: model }; }
    async *stream(options) {
      this.requests.push(options);
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: '首页标题已调整。' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '首页标题已调整。' } };
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 8 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(SessionStore);
  await ctx.plugin(SessionProjections);
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(Tools);
  await ctx.plugin(nativeExecutor);
  await ctx.plugin(Agents);
  await ctx.plugin(AgentLoop, { agents: [] });
  const adapter = new LocalAdapter();
  ctx.llm.registerAdapter(['local-test'], adapter);
  const agent = await ctx.agentLoop.create(SessionId('voice-integration'), { provider: 'local-test', model: 'opaque/model' });
  // Only the HTTP/RPC admission boundary is a small local fixture. Execution,
  // inbox injection, persistence events and terminal transitions are production code.
  let submissions = 0;
  ctx.provide('sessionController', { async prompt(request) {
    submissions++;
    agent.followup(createUserMessage({ content: request.content, source: { kind: 'user', rpcId: request.requestId } }));
    return { accepted: true };
  } });
  const bridge = createConversationBridge(ctx, { appendRecord: appendPluginRecord });
  t.after(() => bridge.dispose());
  const updates = []; bridge.subscribe(agent.id, event => updates.push(event));
  const input = { sessionId: agent.id, requestId: 'do-it', text: '就按这个做', context: [
    { role: 'user', text: '首页标题缩小一点' }, { role: 'assistant', text: '可以改成二十四像素。' },
  ] };
  const receipt = await bridge.execute(input);
  assert.ok(receipt.userMessageId);
  await agent.whenIdle();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(adapter.requests.length, 1);
  assert.equal(adapter.requests[0].model, 'opaque/model');
  const messages = adapter.requests[0].messages;
  assert.ok(messages.some(message => message.role === 'user' && message.content.some(block => block.type === 'text' && block.text === '就按这个做')));
  assert.match(JSON.stringify(messages), /首页标题缩小一点/);
  assert.match(JSON.stringify(messages), /不是用户授权/);
  assert.equal(updates.find(event => event.type === 'result')?.text, '首页标题已调整。');
  assert.equal(bridge.status(agent.id, input.requestId).state, 'completed');
  const events = agent.session.snapshotEvents();
  assert.equal(events.filter(event => event.type === 'turn/end' && event.data.reason.kind === 'completed').length, 1);
  assert.equal((await bridge.execute(input)).duplicate, true);
  assert.equal(submissions, 1);
});
