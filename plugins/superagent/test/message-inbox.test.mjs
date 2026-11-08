import test from 'node:test';
import assert from 'node:assert/strict';
import { createMessageInbox, messageReceiptFromEvents } from '../src/message-inbox.mjs';
import { ticketReplySource } from '../src/ticket-reply.mjs';

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

const ticketSignal = { kind: 'state', eventKey: 'notice:1', ticketId: 'ticket', title: '整理资料', status: 'open', instructionRevision: 1,
  resultVersion: 0, state: 'continuation_wait', code: 'WORKER_TURN_INCOMPLETE', stage: 'execution', assignmentId: 'assignment', fence: 1 };

test('queued human messages take priority over state notices, which stay out of the user inbox', async () => {
  const f = fixture();
  f.agent.status = 'running';
  await f.inbox.enqueueTicketReply({ threadId: 'main', signal: ticketSignal });
  await f.inbox.enqueue({ text: '先回答我的问题', requestId: 'human' });
  assert.deepEqual((await f.inbox.state('main')).map(row => row.requestId), ['human']);
  assert.equal(f.sent.length, 0);
  f.agent.status = 'idle';
  await f.inbox.settle('main');
  assert.equal(f.sent[0].source.kind, 'user');
  assert.equal(f.sent[0].content[0].text, '先回答我的问题');
  await f.finish();
  assert.equal(f.sent[1].source.kind, ticketReplySource);
  assert.deepEqual(f.sent[1].source, { kind: ticketReplySource, replyKind: 'state', eventKey: ticketSignal.eventKey, ticketId: ticketSignal.ticketId });
  assert.match(f.sent[1].content[0].text, /不是用户新指令/);
  assert.match(f.sent[1].content[0].text, /本回合仅能使用 assistant_reply 或自然正文/);
  assert.ok(f.sent[1].content[0].text.endsWith(JSON.stringify(ticketSignal)));
  await f.finish();
  assert.deepEqual((await f.inbox.state('main')).map(row => row.requestId), ['human']);
});

test('a state notice waits for the current human turn instead of stealing its response', async () => {
  const f = fixture();
  await f.inbox.enqueue({ text: '请先回答这个问题', requestId: 'human-active' });
  await f.inbox.enqueueTicketReply({ threadId: 'main', signal: ticketSignal });
  await f.inbox.settle('main');
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].source.requestId, 'human-active');
  assert.equal(f.state().requests.find(row => row.ticketReply).status, 'queued');
  await f.finish();
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[1].source.kind, ticketReplySource);
  assert.equal(f.state().requests.find(row => row.requestId === 'human-active').status, 'processed');
  await f.finish();
});

test('state notices retain one durable identity while refreshing queued facts and reject conflicting ownership', async () => {
  const f = fixture();
  f.agent.status = 'running';
  const first = await f.inbox.enqueueTicketReply({ threadId: 'main', signal: ticketSignal });
  const duplicate = await f.inbox.enqueueTicketReply({ threadId: 'main', signal: structuredClone(ticketSignal) });
  assert.equal(first.messageId, duplicate.messageId);
  assert.equal(f.state().requests.length, 1);
  const refreshedSignal = { ...ticketSignal, title: '整理最新资料', status: 'waiting' };
  const refreshed = await f.inbox.enqueueTicketReply({ threadId: 'main', signal: refreshedSignal });
  assert.equal(refreshed.messageId, first.messageId);
  assert.deepEqual(refreshed.ticketReply, refreshedSignal);
  assert.ok(refreshed.message.content[0].text.endsWith(JSON.stringify(refreshedSignal)));
  await assert.rejects(f.inbox.enqueueTicketReply({ threadId: 'main', signal: { ...ticketSignal, ticketId: 'other-ticket' } }), /回复标识冲突/);
  await assert.rejects(f.inbox.enqueueTicketReply({ threadId: 'other', signal: ticketSignal }), /回复标识冲突/);
  f.agent.status = 'idle';
  await f.inbox.settle('main');
  await f.finish();
  await f.inbox.enqueueTicketReply({ threadId: 'main', signal: ticketSignal });
  await f.inbox.settle('main');
  assert.equal(f.sent.length, 1);
  assert.equal(f.state().requests[0].status, 'processed');
  assert.deepEqual(await f.inbox.state('main'), []);
});

test('revalidation suppresses a stale queued notice without dispatching or exposing a user bubble', async () => {
  const checked = [], f = fixture({}, { beforeDispatch: row => { checked.push(row.ticketReply); return false; } });
  f.agent.status = 'running';
  await f.inbox.enqueueTicketReply({ threadId: 'main', signal: ticketSignal });
  f.agent.status = 'idle';
  await f.inbox.settle('main');
  assert.deepEqual(checked, [ticketSignal]);
  assert.equal(f.sent.length, 0);
  assert.equal(f.state().requests[0].status, 'processed');
  assert.equal(f.state().requests[0].suppressed, true);
  assert.deepEqual(await f.inbox.state('main'), []);
});
