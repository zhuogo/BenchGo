import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantRuntimeStore } from '../src/runtime-store.mjs';
import { reactionScope, setMessageReaction } from '../src/message-reaction.mjs';
import { createRouterTools } from '../src/router-tools.mjs';

test('reactions persist, clear and remain isolated by session and thread', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'reaction-test-'));
  let database = createAssistantRuntimeStore({ directory });
  t.after(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
  const scope = reactionScope('main', 'session-1');
  database.setMessageReaction(scope, 'message:1', '👍');
  database.close(); database = createAssistantRuntimeStore({ directory });
  assert.deepEqual(database.messageReactions(scope), { 'message:1': '👍' });
  assert.deepEqual(database.messageReactions(reactionScope('main', 'session-2')), {});
  assert.deepEqual(database.messageReactions(reactionScope('side', 'session-1')), {});
  database.setMessageReaction(scope, 'message:1', null);
  assert.deepEqual(database.messageReactions(scope), {});
  assert.throws(() => database.setMessageReaction(scope, 'message:1', 'unknown'));
});

test('reaction validates actual paginated messages and notification source', async () => {
  const writes = [];
  const engine = { history: async (threadId, { before }) => ({ sessionId: 's', messages: [{ id: before ? 'old' : 'recent' }], hasMore: !before, nextBefore: before ? null : 10 }) };
  const database = { setMessageReaction: (...args) => writes.push(args), notifications: () => ({ events: [{ eventId: 'event', threadId: 'side' }], hasMore: false }) };
  await setMessageReaction({ engine, database }, { threadId: 'main', messageKey: 'message:old', emoji: '❤️' });
  assert.equal(writes.length, 1);
  await assert.rejects(setMessageReaction({ engine, database }, { threadId: 'main', messageKey: 'message:foreign', emoji: '👍' }));
  await assert.rejects(setMessageReaction({ engine, database }, { threadId: 'main', messageKey: 'notification:event', emoji: '👍' }));
  await assert.rejects(setMessageReaction({ engine, database }, { threadId: 'main', messageKey: 'message:old', emoji: 'bad' }));
  await setMessageReaction({ engine, database }, { threadId: 'side', messageKey: 'notification:event', emoji: null });
  assert.equal(writes.length, 2);
});

test('assistant reactions keep their own lane beside the user reaction on the same message', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'reaction-test-'));
  let database = createAssistantRuntimeStore({ directory });
  t.after(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
  const scope = reactionScope('main', 'session-1');
  database.setMessageReaction(scope, 'message:1', '🤔');
  database.setAssistantReaction(scope, 'message:1', '❤️');
  database.setAssistantReaction(scope, 'message:1', '👍');
  database.close(); database = createAssistantRuntimeStore({ directory });
  assert.deepEqual(database.assistantReactions(scope), { 'message:1': '👍' });
  assert.deepEqual(database.messageReactions(scope), { 'message:1': '🤔' });
  assert.deepEqual(database.assistantReactions(reactionScope('side', 'session-1')), {});
  assert.throws(() => database.setAssistantReaction(scope, 'message:1', 'unknown'));
  database.setAssistantReaction(scope, 'message:1', null);
  assert.deepEqual(database.assistantReactions(scope), {});
  assert.deepEqual(database.messageReactions(scope), { 'message:1': '🤔' });
});

test('assistant_react targets only the current human message in a local conversation and may end the turn', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'reaction-test-'));
  const database = createAssistantRuntimeStore({ directory });
  t.after(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
  const events = [{ type: 'turn/start' }, { type: 'user/message', data: { id: 'm-1', source: { kind: 'user' }, content: [{ type: 'text', text: '谢谢！' }] } }];
  const agent = { id: 'router', status: 'running', session: { header: {}, snapshotEvents: () => events } };
  const ctx = { agents: { get: id => id === agent.id ? agent : undefined, currentInitiator: () => agent, turnBoundaryOf: () => ({ openTurnStartSeq: 0 }) } };
  const state = { mainSessionId: agent.id, threads: [{ id: 'feishu', sessionId: agent.id, sourceKey: 'feishu:chat' }] };
  const setup = createRouterTools({ ctx, commander: { list: () => [] }, store: { getState: async () => state }, database, shutdown: new AbortController() });
  const install = threadId => {
    const tools = new Map();
    setup({ tools: { register(tool) { tools.set(tool.name, tool); return () => {}; } }, systemPrompt: { section() {}, context() {} } }, { threadId, agent });
    return tools.get('assistant_react');
  };
  const react = install('main'), scope = reactionScope('main', 'router');
  assert.deepEqual(react.parameters.properties.emoji.enum, ['👍', '❤️', '😂', '🎉', '🤔', '👎']);
  assert.deepEqual(react.parameters.required, ['emoji']);
  let concluded = 0;
  const exec = { agent, signal: new AbortController().signal, concludeTurn: () => { concluded += 1; } };
  database.setMessageReaction(scope, 'message:m-1', '🤔');
  assert.deepEqual(await react.execute({ emoji: '❤️' }, exec), { reacted: '❤️' });
  assert.equal(concluded, 0);
  assert.deepEqual(await react.execute({ emoji: '👍', endTurn: true }, exec), { reacted: '👍', turnEnded: true });
  assert.equal(concluded, 1);
  assert.deepEqual(database.assistantReactions(scope), { 'message:m-1': '👍' });
  assert.deepEqual(database.messageReactions(scope), { 'message:m-1': '🤔' });
  await assert.rejects(react.execute({ emoji: '🎉' }, { ...exec, agent: { id: 'worker' } }), /本机主聊或手动旁聊/);
  await assert.rejects(install('feishu').execute({ emoji: '🎉' }, exec), /本机主聊或手动旁聊/);
  events[1] = { type: 'user/message', data: { id: 'notice', source: { kind: 'task' }, content: [{ type: 'text', text: 'result' }] } };
  await assert.rejects(react.execute({ emoji: '🎉' }, exec), /当前没有可回应的用户消息/);
  assert.equal(concluded, 1);
  assert.deepEqual(database.assistantReactions(scope), { 'message:m-1': '👍' });
  assert.deepEqual(database.assistantReactions(reactionScope('feishu', 'router')), {});
});
