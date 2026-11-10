import test from 'node:test';
import assert from 'node:assert/strict';
import { channelSessionKey } from '../src/channel-policy.mjs';
import { sidebarThreads, channelIsConnected, sourceConnectionMismatch, readSidebarList } from '../client/sidebar-lists.mjs';

const status = { enabled: true, authentication: 'verified', connection: { state: 'connected' } };
const fixed = (id, source) => ({ id, sessionId: `session-${id}`, source, sourceKey: channelSessionKey(source) });
test('sidebar lists preserve existing source sessions and never merge real conversations', () => {
  const source = { channel: 'feishu', appId: 'opaque-app', sourceType: 'group', conversationId: 'same-chat' };
  const rows = [{ id: 'main' }, { id: 'manual', title: 'feishu · same-chat' },
    fixed('group', source), fixed('other-app', { ...source, appId: 'another-app' }),
    fixed('topic', { ...source, sourceType: 'topic', topicId: 'topic-1' }),
    fixed('other-channel', { ...source, channel: 'telegram' }),
    { ...fixed('not-created', source), sessionId: undefined },
    { id: 'untrusted-key', sourceKey: 'other-source' }];
  const before = structuredClone(rows), channels = [{ id: 'feishu', status }];
  assert.deepEqual(sidebarThreads(rows).map(row => row.id), ['manual']);
  const im = sidebarThreads(rows, { list: 'im', channels });
  assert.deepEqual(im.map(row => row.id), ['group', 'other-app', 'topic']);
  assert.equal(new Set(im.map(row => row.sourceKey)).size, 3);
  assert.ok(im.every(row => rows.includes(row)), 'navigation keeps the persisted thread/session identity');
  assert.deepEqual(rows, before);
  assert.deepEqual(sidebarThreads(rows, { list: 'im', channels: [{ id: 'feishu', status: { ...status, appId: 'opaque-app' } }] }).map(row => row.id), ['group', 'topic']);
  assert.equal(sourceConnectionMismatch(rows[2], channels[0]), false, 'missing account facts do not invent a mismatch');
});

test('IM service availability requires live authenticated transport and preserves opaque identifiers', () => {
  for (const change of [{ enabled: false }, { authentication: 'unverified' }, { error: 'unavailable' }, { connection: { state: 'connecting' } }]) {
    assert.equal(channelIsConnected({ ...status, ...change }), false);
  }
  assert.equal(channelIsConnected({ ...status, authentication: 'host-authenticated', connection: { state: 'listening' } }), true);
  assert.equal(channelIsConnected({ ...status, authentication: 'unverified', connection: { state: 'connected', authenticated: true } }), true);
  assert.equal(sourceConnectionMismatch({ source: { appId: 'App:Exact/A' } }, { status: { appId: 'App:Exact/a' } }), true);
  assert.equal(readSidebarList({ getItem: () => 'im' }), 'im');
  assert.equal(readSidebarList({ getItem: () => 'obsolete' }), 'side');
  assert.equal(readSidebarList({ getItem() { throw new Error('blocked'); } }), 'side');
});
