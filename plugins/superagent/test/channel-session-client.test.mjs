import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const require = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url));
const { build } = createRequire(new URL('../../benchgo/package.json', import.meta.url))('esbuild');
const result = await build({ entryPoints: [fileURLToPath(new URL('../client/channel-session.jsx', import.meta.url))], bundle: true, write: false,
  platform: 'node', format: 'esm', alias: { react: dirname(require.resolve('react/package.json')) }, nodePaths: [fileURLToPath(new URL('../../benchgo/node_modules/', import.meta.url))], logLevel: 'silent' });
const { channelMessageDefinition: definition, registerChannelMessages } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
const source = { channel: 'feishu', sourceType: 'direct', conversationId: 'private-chat', senderId: 'owner', identityEvidence: { account: 'bot' } };
const record = (direction = 'inbound') => ({ type: 'plugin:benchgo-plugin/channel-message', ignorable: true, seq: 4, time: 1731000000000,
  data: { mirrorKey: direction === 'inbound' ? 'intake:id' : 'delivery:task:id', direction, source, text: direction === 'inbound' ? '收到消息' : '已交付结果' } });

test('channel mirror Definition builds the same official context data without a message write or model turn', () => {
  for (const direction of ['inbound', 'delivery']) {
    const event = record(direction), identity = definition.match(event);
    assert.deepEqual(identity, { id: event.data.mirrorKey, role: 'start' });
    const match = { ...identity, event, location: { kind: 'session' } };
    const state = definition.start({}, match), context = { key: 'context-key', id: identity.id, start: match, state };
    const node = definition.buildViewNode(context);
    assert.equal(definition.kind, 'benchgo-channel-message'); assert.equal(node.kind, 'context'); assert.equal(node.target, 'chat');
    assert.equal(node.key, 'context-key'); assert.equal(node.id, identity.id); assert.equal(node.anchorSeq, event.seq);
    assert.equal(node.location, match.location); assert.equal(node.data.seq, event.seq); assert.equal(node.data.time, event.time);
    assert.deepEqual(node.data.content, [{ type: 'text', text: event.data.text }]);
    assert.deepEqual(node.data.producer, { role: 'inject', label: 'benchgo-channel' }); assert.equal(node.data.form, 'notice');
    assert.equal(node.data.source.channelSource, source); assert.equal(node.data.source.direction, direction);
    assert.equal(node.data.source.summary, direction === 'inbound' ? '渠道消息' : '渠道交付回执');
    assert.equal(definition.update(context, { event: record(direction) }), state);
  }
  assert.equal(definition.buildViewNode({}), null);
  for (const event of [{ ...record(), ignorable: false }, { ...record(), type: 'user/message' }, { ...record(), data: {} },
    { ...record(), data: { ...record().data, direction: 'outbound' } }]) assert.equal(definition.match(event), null);
});

test('channel registration owns the official Definition lifecycle without modifying sidebar metadata', () => {
  const disposed = [], effects = [];
  const dispose = () => disposed.push('definition');
  const ctx = { effect(register) { effects.push(register); return register(); },
    uiConversation: { events: { register(value) { assert.equal(value, definition); return dispose; } } },
    slots: { inject() { assert.fail('Channel messages do not add sidebar badges'); }, register() { assert.fail('Channel messages do not replace sidebar rows'); } } };
  const cleanup = registerChannelMessages(ctx);
  assert.equal(effects.length, 1);
  assert.equal(cleanup, dispose);
  cleanup(); assert.deepEqual(disposed, ['definition']);
});
