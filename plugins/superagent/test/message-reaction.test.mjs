import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantRuntimeStore } from '../src/runtime-store.mjs';
import { reactionScope, setMessageReaction } from '../src/message-reaction.mjs';

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
