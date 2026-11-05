import test from 'node:test';
import assert from 'node:assert/strict';
import { createFeishuStream } from '../src/feishu-stream.mjs';

test('long connection persists authenticated events and stops old callbacks after disable', async () => {
  let handler, closed = 0;
  const config = { enabled: true, appId: 'app', appSecretRef: 'SECRET', botOpenId: 'bot', ownerOpenIds: ['owner'], chatIds: ['chat'] };
  const events = [];
  const stream = createFeishuStream({ getConfig: () => config, credentials: { resolve: async () => ({ value: 'private' }) }, ingest: async e => events.push(e), loadSDK: async () => ({
    EventDispatcher: class { register(callbacks) { handler = callbacks['im.message.receive_v1']; return this; } },
    WSClient: class { constructor(options) { this.options = options; } async start() { this.options.onReady(); } close() { closed++; } },
  }) });
  await stream.start();
  assert.equal(stream.status().state, 'connected');
  const data = { sender: { sender_type: 'user', sender_id: { open_id: 'owner' } }, message: { message_id: 'm', chat_id: 'chat', chat_type: 'group', create_time: '1780000000000', message_type: 'text', content: '{"text":"hello"}', mentions: [{ id: { open_id: 'bot' } }] } };
  await handler(data);
  assert.equal(events.length, 1); assert.equal(events[0].mentioned, true);
  assert.equal(stream.status().events, 'verified');
  stream.stop();
  await assert.rejects(handler(data), /停用/);
  assert.equal(events.length, 1); assert.equal(closed, 1);
});

test('official dispatcher payload is normalized and disposal drains accepted ingestion', async () => {
  const { EventDispatcher } = await import('../../benchgo/node_modules/@larksuiteoapi/node-sdk/lib/index.js');
  let dispatcher, release, ingested;
  const stream = createFeishuStream({
    getConfig: () => ({ enabled: true, appId: 'app', appSecretRef: 'SECRET', chatIds: ['chat'] }),
    credentials: { resolve: async () => ({ value: 'private' }) },
    ingest: event => { ingested = event; return new Promise(resolve => { release = resolve; }); },
    loadSDK: async () => ({ EventDispatcher, WSClient: class {
      async start(options) { dispatcher = options.eventDispatcher; }
      close() {}
    } }),
  });
  await stream.start();
  const receiving = dispatcher.invoke({ schema: '2.0', header: { event_id: 'event', event_type: 'im.message.receive_v1', app_id: 'app' }, event: {
    sender: { sender_type: 'user', sender_id: { open_id: 'owner' } },
    message: { message_id: 'message', chat_id: 'chat', chat_type: 'group', create_time: '1780000000000', message_type: 'text', content: '{"text":"hello"}' },
  } }, { needCheck: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ingested.raw.eventId, 'event');
  let disposed = false;
  const disposing = stream.dispose().then(() => { disposed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(disposed, false);
  release(); await receiving; await disposing;
  assert.equal(stream.status().state, 'stopped');
  assert.equal(stream.status().events, 'unverified');
});

test('stop during credential resolution cannot resurrect connection', async () => {
  let release, constructed = 0;
  const stream = createFeishuStream({ getConfig: () => ({ enabled: true, appId: 'app', appSecretRef: 'SECRET' }), credentials: { resolve: () => new Promise(resolve => { release = resolve; }) }, ingest: async () => {}, loadSDK: async () => ({ WSClient: class { constructor() { constructed++; } } }) });
  const starting = stream.start();
  await new Promise(resolve => setImmediate(resolve));
  stream.stop(); release({ value: 'private' }); await starting;
  assert.equal(constructed, 0); assert.equal(stream.status().state, 'stopped');
});
