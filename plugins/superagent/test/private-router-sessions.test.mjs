import test from 'node:test';
import assert from 'node:assert/strict';
import { privateRouterSessionIds } from '../src/execution-session.mjs';

test('private Router identities include historical and deleted side chats while preserving channels and unrelated Workers', () => {
 const state = { mainSessionId: 'main', threads: [
   { id: 'side', sessionId: 'side', archived: true },
   { id: 'im', sessionId: 'im', sourceKey: 'channel:real', source: { channel: 'feishu' } },
 ], sessionLineage: { main: ['old-main', 'main'], side: ['old-side', 'side'], deleted: ['deleted-side'], im: ['old-im', 'im'] } };
 assert.deepEqual(new Set(privateRouterSessionIds(state)), new Set(['main', 'side', 'old-main', 'old-side', 'deleted-side']));
 assert.deepEqual(privateRouterSessionIds({}), []);
});
