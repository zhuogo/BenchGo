import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantDispatch } from '../src/assistant-dispatch.mjs';

function fixture() {
  const source = { kind: 'user' }, events = [{ type: 'user/message', data: { id: 'message', source } }];
  const state = { mainSessionId: 'router', threads: [{ id: 'side', sessionId: 'side-router' }],
    sessionLineage: { main: ['old-router'] }, requests: [] };
  const reads = [], runtime = { shutdown: new AbortController(), store: { getState: async () => state, orchestration: {} },
    ctx: { sessions: { get: () => undefined }, sessionQuery: { async readSession(id) { reads.push(id); return { events }; } } } };
  return { source, events, state, reads, runtime, dispatch: createAssistantDispatch(runtime),
    input: { action: 'replyFileSource', sessionId: 'router', requestId: 'message' } };
}

test('file source dispatch reads only the requested original message in the authorized chat', async () => {
  const f = fixture();
  assert.deepEqual(await f.dispatch(f.input), { remote: false });
  assert.deepEqual(f.reads, ['router']);
  f.reads.length = 0;
  f.runtime.ctx.sessions.get = id => { assert.equal(id, 'router'); return { snapshotEvents: () => f.events }; };
  assert.deepEqual(await f.dispatch(f.input), { remote: false });
  assert.deepEqual(f.reads, [], 'a live session does not trigger a second disk read');
});

test('a frozen admitted request avoids rereading the transcript on file click', async () => {
  const f = fixture();
  f.state.requests.push({ threadId: 'main', sessionId: 'router', messageId: 'message', message: { id: 'message', source: f.source } });
  assert.deepEqual(await f.dispatch(f.input), { remote: false });
  assert.deepEqual(f.reads, []);
});

test('file source dispatch rejects cross-chat or unknown message references before navigating', async () => {
  const f = fixture();
  for (const input of [{ ...f.input, sessionId: 'other' }, { ...f.input, threadId: 'side' },
    { ...f.input, requestId: '' }, { ...f.input, sessionId: 'router\n' }]) await assert.rejects(f.dispatch(input));
  assert.deepEqual(f.reads, []);
  await assert.rejects(f.dispatch({ ...f.input, requestId: 'missing' }), { code: 'REPLY_FILE_SOURCE_UNAVAILABLE' });
  assert.deepEqual(await f.dispatch({ ...f.input, sessionId: 'old-router' }), { remote: false });
  assert.deepEqual(await f.dispatch({ ...f.input, threadId: 'side', sessionId: 'side-router' }), { remote: false });
});

test('cancelled source resolution cannot return a target after its transcript read', async () => {
  const f = fixture(), controller = new AbortController();
  f.runtime.ctx.sessionQuery.readSession = async () => { controller.abort(new Error('聊天已离开')); return { events: f.events }; };
  await assert.rejects(f.dispatch(f.input, undefined, { signal: controller.signal }), /聊天已离开/);
});
