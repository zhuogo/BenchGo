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
const { titleProjectionDefinition } = await import('../../../deepseek-harness/packages/session/session-title/lib/index.js');

test('真实官方会话摘要投影接收纯语音标题，不发送正式用户消息或启动执行（本地 LLM）', { timeout: 10000 }, async t => {
  class TitleAdapter extends LlmAdapter {
    requests = [];
    async resolveModel(provider, model) { return { provider, id: model, name: model, reasoning: { efforts: [{ id: 'off', name: 'Off' }] } }; }
    async *stream(options) {
      this.requests.push(options);
      yield { type: 'text-delta', index: 0, text: '实时语音优化讨论' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore); await ctx.plugin(SessionProjections);
  await ctx.sessionProjections.register(titleProjectionDefinition);
  const adapter = new TitleAdapter(); ctx.llm.registerAdapter(['voice-title-local'], adapter);
  const session = ctx.sessions.create(SessionId('voice-title-integration'));
  const bridge = createConversationBridge(ctx, { appendRecord: appendPluginRecord });
  t.after(() => bridge.dispose());
  assert.equal(ctx.sessionProjections.snapshot(session, ctx.sessionProjections.summaryKeys()).values.title, null);
  await bridge.startCall(session.id, { callId: 'first-call', mode: 'enhanced', startedAt: Date.now() });
  await bridge.append(session.id, { kind: 'user', requestId: 'utterance', text: '讨论一下实时语音的优化方式。' });
  await bridge.append(session.id, { kind: 'assistant', text: '可以先优化开头卡顿。' });
  await bridge.refreshTitle(session.id, { providerId: 'voice-title-local', model: 'opaque/title-model' });
  const snapshot = ctx.sessionProjections.snapshot(session, ctx.sessionProjections.summaryKeys());
  assert.equal(snapshot.values.title, '实时语音优化讨论');
  assert.equal(adapter.requests.length, 1);
  assert.equal(adapter.requests[0].provider, 'voice-title-local');
  assert.equal(adapter.requests[0].model, 'opaque/title-model');
  assert.equal(adapter.requests[0].purpose, 'session-title');
  assert.equal(adapter.requests[0].maxTokens, 64);
  assert.equal(session.snapshotEvents().filter(event => event.type === 'session/title').length, 1);
  assert.equal(session.snapshotEvents().some(event => ['user/message', 'turn/start'].includes(event.type)), false);
  await bridge.refreshTitle(session.id, { providerId: 'voice-title-local', model: 'opaque/title-model' });
  assert.equal(adapter.requests.length, 1);
});

test('真实 Cordis + 官方 AgentLoop/Session 运行有界任务交接与完成事件（本地 LLM，无外网）', { timeout: 10000 }, async t => {
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
  const source = await bridge.append(agent.id, { kind: 'user', requestId: 'earlier', text: '首页标题缩小一点' });
  await bridge.append(agent.id, { kind: 'assistant', text: '可以改成二十四像素。' });
  await bridge.append(agent.id, { kind: 'user', requestId: 'do-it', text: '就按这个做' });
  const input = { sessionId: agent.id, requestId: 'do-it', text: '就按这个做', task: '将首页标题字号缩小至二十四像素。', contextSourceSeqs: [source.seq] };
  const receipt = await bridge.execute(input);
  assert.ok(receipt.userMessageId);
  await agent.whenIdle();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(adapter.requests.length, 1);
  assert.equal(adapter.requests[0].model, 'opaque/model');
  const messages = adapter.requests[0].messages;
  assert.ok(messages.some(message => message.role === 'user' && message.source?.kind === 'user' && message.content.some(block => block.type === 'text' && block.text === input.task)));
  assert.match(JSON.stringify(messages), /首页标题缩小一点/);
  assert.doesNotMatch(JSON.stringify(messages), /就按这个做|不是新的真人授权|以下是语音层/);
  assert.match(JSON.stringify(messages), /将首页标题字号缩小至二十四像素/);
  assert.ok(messages.some(message => message.source?.kind === 'benchgo-voice-evidence'));
  assert.ok(!messages.some(message => message.source?.kind === 'benchgo-voice-task'));
  const restoredSpeech = await bridge.history(agent.id);
  assert.ok(restoredSpeech.some(message => message.role === 'user' && message.text === input.text));
  assert.ok(!restoredSpeech.some(message => message.text === input.task));
  assert.equal(updates.find(event => event.type === 'result')?.text, '首页标题已调整。');
  assert.equal(bridge.status(agent.id, input.requestId).state, 'completed');
  const events = agent.session.snapshotEvents();
  const officialInput = events.filter(event => event.type === 'user/message' && event.data.source?.kind === 'user' && event.data.source.rpcId === 'voice:do-it');
  assert.equal(officialInput.length, 1);
  assert.deepEqual(officialInput[0].data.content, [{ type: 'text', text: input.task }]);
  const work = await bridge.readRecords(agent.id, { mode: 'direct' });
  assert.ok(work.events.some(event => event.type === 'user/message' && event.data.content[0]?.text === input.task));
  assert.ok(!work.events.some(event => event.type === 'user/message' && event.data.content[0]?.text === input.text));
  assert.equal(events.filter(event => event.type === 'turn/end' && event.data.reason.kind === 'completed').length, 1);
  assert.equal((await bridge.execute(input)).duplicate, true);
  assert.equal(submissions, 1);
});
