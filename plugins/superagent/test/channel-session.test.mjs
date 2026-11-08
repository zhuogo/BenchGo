import test from 'node:test';
import assert from 'node:assert/strict';
import { createChannelSessionHost, applyChannelSessionSource, registerChannelSessionProjection } from '../src/channel-session.mjs';
import { channelSessionKey } from '../src/channel-policy.mjs';

const source = { channel: 'telegram', sourceType: 'topic', conversationId: 'group', chatId: 'group', topicId: 'topic', connectionId: 'bot' };
function fixture() {
  const events = [], threads = []; let flushes = 0, calls = 0;
  const agent = { session: { id: 'official-session', append(type, data, options) { assert.deepEqual(options, { surfaceOp: 'append' }); events.push({ type, data }); } } };
  const ctx = { sessionQuery: { async readSession() { return { events }; } }, sessions: { async flush() { flushes++; } } };
  const store = { async getState() { return { threads }; } };
  const engine = { async ensureSourceThread(input) { let thread = threads.find(row => row.sourceKey === input.sourceKey); if (!thread) threads.push(thread = { ...input, id: 'thread', sessionId: agent.session.id }); return thread; }, async ensureSession() { return agent; } };
  const host = createChannelSessionHost({ ctx, store, engine, receiveOwnerMessage: async input => { calls++; return input.message.id; } });
  return { host, events, threads, counts: () => ({ flushes, calls }) };
}
test('persisted inbound and confirmed outbox mirror to one official session without re-enqueueing', async () => {
  const f = fixture(), event = { source, threadId: 'remote-thread', text: '原文' }, result = { trigger: null, intakeEvent: { id: 'trigger' } };
  await Promise.all([f.host.onInbound(event, result), f.host.onInbound(event, result)]);
  assert.equal(f.threads.length, 1); assert.equal(f.events.length, 1);
  assert.equal(f.threads[0].source.threadId, 'remote-thread');
  assert.equal(f.threads[0].sourceKey, channelSessionKey(source));
  const delivery = { id: 'outbox', state: 'sent', payload: { source, publication: { text: '结果' } } };
  await f.host.onDelivery(delivery); await f.host.onDelivery(delivery);
  assert.equal(f.events.length, 2); assert.equal(f.events[1].data.content[0].text, '已送达\n结果');
  assert.equal(f.counts().calls, 0); assert.equal(f.counts().flushes, 4);
  assert.equal(await f.host.onDelivery({ ...delivery, receipt: { status: 'suppressed' } }), null);
  assert.equal(await f.host.onDelivery({ ...delivery, state: 'uncertain' }), null);
  assert.equal(await f.host.onDelivery({ ...delivery, payload: { source: { channel: 'desktop' }, text: 'local notification' } }), null);
  await assert.rejects(f.host.onInbound(event, result, { sessionKey: 'another-source' }), /标识不匹配/);
});
test('owner input delegates only for the current official session and genuine user source', async () => {
  const f = fixture(); await f.host.onInbound({ source, text: 'hello', threadId: 'remote' }, { trigger: null, intakeEvent: { id: 't' } });
  const input = { thread: f.threads[0], sessionId: 'official-session', message: { id: 'message', source: { kind: 'user' } } };
  assert.equal(await f.host.onSourceMessage(input), 'message');
  await assert.rejects(f.host.onSourceMessage({ ...input, sessionId: 'another' }), /来源不匹配/);
  await assert.rejects(f.host.onSourceMessage({ ...input, message: f.events[0].data }), /来源不匹配/);
});
test('official summary projection derives source from standard message events', async () => {
  let definition; await registerChannelSessionProjection({ sessionProjections: { async register(value) { definition = value; return value; } } });
  assert.equal(definition.init(), null);
  const f = fixture(); await f.host.onInbound({ source, text: 'hi' }, { trigger: null, intakeEvent: { id: 't' } });
  assert.deepEqual(applyChannelSessionSource(null, f.events[0]), { channel: 'telegram', sourceType: 'topic', conversationId: 'group', topicId: 'topic' });
  const existing = { channel: 'telegram' }; assert.equal(applyChannelSessionSource(existing, { type: 'turn/start' }), existing);
  assert.equal(definition.wire.summary, undefined);
});
