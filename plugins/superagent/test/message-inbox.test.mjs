import test from 'node:test';
import assert from 'node:assert/strict';
import { createMessageInbox, messageReceiptFromEvents } from '../src/message-inbox.mjs';

function fixture(initial = {}, options = {}) {
  let state = { requests: [], ...structuredClone(initial) }, chain = Promise.resolve();
  const events = options.events || [], sent = [];
  const agent = { id: 'session', status: 'idle', followup(message) {
    sent.push(message); agent.status = 'running';
    events.push({ type: 'user/message', data: message });
  } };
  const inbox = createMessageInbox({
    getState: async () => structuredClone(state),
    updateState: change => { const result = chain.then(() => { state = { ...state, ...change(state) }; return state; }); chain = result.catch(() => {}); return result; },
    ensureSession: async () => agent, getAgent: () => agent,
    readSession: async () => ({ events }), ...options,
  });
  return { inbox, sent, events, state: () => state, agent,
    async finish(reason = { kind: 'stop' }) { events.push({ type: 'turn/end', data: { reason } }); agent.status = 'idle'; await inbox.settle('main'); },
  };
}

test('three consecutive requests persist, then dispatch once in order without blocking acceptance', async () => {
  const f = fixture();
  const receipts = await Promise.all(['A', 'B', 'C'].map(text => f.inbox.enqueue({ threadId: 'main', text, requestId: text })));
  assert.equal(f.state().requests.length, 3);
  assert.equal(f.sent.length, 1);
  assert.deepEqual(receipts.map(row => row.status), ['processing', 'queued', 'queued']);
  await f.finish(); await f.finish(); await f.finish();
  assert.deepEqual(f.sent.map(message => message.content[0].text), ['A', 'B', 'C']);
  assert.deepEqual((await f.inbox.state('main')).map(row => row.status), ['processed', 'processed', 'processed']);
});

test('duplicate pending IDs are acknowledged and mismatched content is rejected', async () => {
  const f = fixture();
  await f.inbox.enqueue({ text: 'A', requestId: 'same' });
  const receipt = await f.inbox.enqueue({ text: 'A', requestId: 'same' });
  assert.equal(receipt.duplicate, true);
  assert.equal(f.sent.length, 1);
  await assert.rejects(f.inbox.enqueue({ text: 'B', requestId: 'same' }), /请求标识/);
});

test('notification replies persist the authoritative question and reject changed associations under the same request id', async () => {
  const f = fixture();
  const replyContext = { eventId: 'delivery', ticketId: 'ticket', instructionRevision: 1, resultVersion: 2, question: '应采用哪个范围？' };
  await f.inbox.enqueue({ text: '采用第一种', requestId: 'answer', replyContext });
  assert.deepEqual(f.sent[0].source.replyContext, replyContext);
  assert.equal(f.sent[0].source.rpcId, 'answer');
  assert.deepEqual(f.state().requests[0].message.source.replyContext, replyContext);
  assert.equal((await f.inbox.enqueue({ text: '采用第一种', requestId: 'answer', replyContext })).duplicate, true);
  await assert.rejects(f.inbox.enqueue({ text: '采用第一种', requestId: 'answer', replyContext: { ...replyContext, ticketId: 'other' } }), /请求标识/);
});

test('restart resumes queued messages but reconciles dispatched IDs without replay', async () => {
  const first = fixture();
  await first.inbox.enqueue({ text: 'A', requestId: 'A' });
  await first.inbox.enqueue({ text: 'B', requestId: 'B' });
  first.events.push({ type: 'turn/end', data: { reason: { kind: 'stop' } } });
  const second = fixture(first.state(), { events: first.events });
  await second.inbox.recover();
  assert.deepEqual(second.sent.map(message => message.content[0].text), ['B']);
  assert.equal(second.state().requests[0].status, 'processed');
});

test('ambiguous prepared handoff is retained as uncertain, never silently replayed', async () => {
  const f = fixture({ requests: [{ requestId: 'old', threadId: 'main', sessionId: 'session', messageId: 'missing', status: 'prepared' }] });
  await f.inbox.recover();
  assert.equal(f.sent.length, 0);
  assert.equal(f.state().requests[0].status, 'uncertain');
  assert.match(f.state().requests[0].error, /未自动重放/);
});

test('cancel terminates accepted queued requests and keeps idempotency tombstones', async () => {
  const f = fixture();
  await f.inbox.enqueue({ text: 'A', requestId: 'A' });
  await f.inbox.enqueue({ text: 'B', requestId: 'B' });
  await f.inbox.cancel('main');
  await f.finish();
  assert.equal(f.sent.length, 1);
  assert.deepEqual((await f.inbox.state('main')).map(row => row.status), ['cancelled', 'cancelled']);
  assert.equal((await f.inbox.enqueue({ text: 'B', requestId: 'B' })).duplicate, true);
});

test('session startup failure is durable and visible instead of forever prepared', async () => {
  const f = fixture({}, { getAgent: () => undefined, ensureSession: async () => { throw new Error('Unavailable'); } });
  const receipt = await f.inbox.enqueue({ text: 'A', requestId: 'A' });
  assert.equal(receipt.status, 'failed');
  assert.match(receipt.error, /Unavailable/);
});

test('transcript matching uses the exact message ID and records processing errors', () => {
  const request = { messageId: 'actual' };
  assert.equal(messageReceiptFromEvents(request, [{ type: 'user/message', data: { id: 'other' } }, { type: 'turn/end', data: { reason: { kind: 'stop' } } }]).status, 'uncertain');
  const result = messageReceiptFromEvents(request, [{ type: 'user/message', data: { id: 'actual' } }, { type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'model unavailable' } } } }]);
  assert.deepEqual(result, { status: 'failed', error: 'model unavailable' });
});
