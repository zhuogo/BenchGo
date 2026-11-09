import test from 'node:test';
import assert from 'node:assert/strict';
import { createChannelSessionHost, applyChannelSessionSource, registerChannelSessionProjection } from '../src/channel-session.mjs';
import { channelSessionKey } from '../src/channel-policy.mjs';
import { channelMessageRecordOf, channelMessageRecordType } from '../src/channel-session-record.mjs';

const source = { channel: 'telegram', sourceType: 'topic', conversationId: 'group', chatId: 'group', topicId: 'topic', connectionId: 'bot' };
function fixture() {
  const events = [], threads = []; let flushes = 0, calls = 0;
  const agent = { session: { id: 'official-session', append() { assert.fail('channel display mirrors must never append model-surface messages'); } } };
  const ctx = { sessionQuery: { async readSession() { return { events }; } }, sessions: { async flush() { flushes++; } } };
  const store = { async getState() { return { threads }; } };
  const engine = { async ensureSourceThread(input) { let thread = threads.find(row => row.sourceKey === input.sourceKey); if (!thread) threads.push(thread = { ...input, id: 'thread', sessionId: agent.session.id }); return thread; }, async ensureSession() { return agent; } };
  const host = createChannelSessionHost({ ctx, store, engine, appendRecord(session, type, data) {
    assert.equal(session, agent.session); assert.equal(type, channelMessageRecordType);
    events.push({ type, data, ignorable: true });
  }, receiveOwnerMessage: async input => { calls++; return input.message.id; } });
  return { host, events, threads, counts: () => ({ flushes, calls }) };
}
test('persisted inbound and confirmed outbox mirror to one official session without re-enqueueing', async () => {
  const f = fixture(), event = { source, threadId: 'remote-thread', text: '原文' }, result = { trigger: null, intakeEvent: { id: 'trigger' } };
  await Promise.all([f.host.onInbound(event, result), f.host.onInbound(event, result)]);
  assert.equal(f.threads.length, 1); assert.equal(f.events.length, 1);
  assert.equal(f.threads[0].source.threadId, 'remote-thread');
  assert.equal(f.threads[0].sourceKey, channelSessionKey(source));
  const delivery = { id: 'outbox', state: 'sent', receipt: { status: 'accepted', messageId: 'remote-message' }, payload: { source, publication: { origin: 'router', text: '结果' } } };
  await f.host.onDelivery(delivery); await f.host.onDelivery(delivery);
  assert.equal(f.events.length, 2); assert.equal(f.events[1].data.text, '结果');
  assert.equal(channelMessageRecordOf(f.events[0]).direction, 'inbound');
  assert.equal(channelMessageRecordOf(f.events[1]).direction, 'delivery');
  assert.equal(f.counts().calls, 0); assert.equal(f.counts().flushes, 4);
  assert.equal(await f.host.onDelivery({ ...delivery, receipt: { status: 'suppressed' } }), null);
  assert.equal(await f.host.onDelivery({ ...delivery, receipt: undefined }), null);
  assert.equal(await f.host.onDelivery({ ...delivery, receipt: { status: 'accepted' } }), null);
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
test('official summary projection derives source from the display record and valid historical raw mirrors', async () => {
  let definition; await registerChannelSessionProjection({ sessionProjections: { async register(value) { definition = value; return value; } } });
  assert.equal(definition.init(), null);
  const f = fixture(); await f.host.onInbound({ source, text: 'hi' }, { trigger: null, intakeEvent: { id: 't' } });
  assert.deepEqual(applyChannelSessionSource(null, f.events[0]), { channel: 'telegram', sourceType: 'topic', conversationId: 'group', topicId: 'topic' });
  const existing = { channel: 'telegram' }; assert.equal(applyChannelSessionSource(existing, { type: 'turn/start' }), existing);
  assert.equal(definition.wire.summary, undefined);
  const historical = { type: 'user/message', data: { source: { kind: 'benchgo-channel', channelSource: source } } };
  assert.deepEqual(applyChannelSessionSource(null, historical), applyChannelSessionSource(null, f.events[0]));
  assert.equal(applyChannelSessionSource(null, { ...f.events[0], ignorable: false }), null);
});

test('historical raw mirror keys prevent duplicate new records without writing a second format', async () => {
  const f = fixture();
  f.events.push({ type: 'user/message', data: { source: { kind: 'benchgo-channel', mirrorKey: 'intake:old', channelSource: source } } });
  await f.host.onInbound({ source, text: 'historical input', threadId: 'remote' }, { intakeEvent: { id: 'old' } });
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].type, 'user/message');
  assert.equal(f.counts().flushes, 1);
});

test('channel display record rejects foreign, malformed and capability-looking payloads as protocol identities', () => {
  const event = { type: channelMessageRecordType, ignorable: true, data: { mirrorKey: 'k', direction: 'inbound', text: 'hello', source } };
  assert.equal(channelMessageRecordOf(event), event.data);
  for (const changed of [null, {}, { ...event, type: 'user/message' }, { ...event, ignorable: false },
    { ...event, data: { ...event.data, mirrorKey: '' } }, { ...event, data: { ...event.data, direction: 'approved' } },
    { ...event, data: { ...event.data, source: null } }, { ...event, data: { ...event.data, text: {} } }])
    assert.equal(channelMessageRecordOf(changed), null);
});
