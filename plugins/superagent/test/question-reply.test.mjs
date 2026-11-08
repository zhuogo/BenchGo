import test from 'node:test';
import assert from 'node:assert/strict';
import { readQuestionReply, readAdmittedQuestionReply } from '../src/question-reply.mjs';
import { activeChatReply, installChatPublication, projectChatMessages } from '../src/chat-publication.mjs';
import { installRouterQuestions } from '../src/router-questions.mjs';
import { createMessageInbox } from '../src/message-inbox.mjs';
import { quietChatRows } from '../client/quiet-chat.mjs';
import { projectReplyStream } from '../client/reply-stream.mjs';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';

const questions = [{ id: 'attention', question: '选择范围？', options: [{ label: '当前范围' }] }];
const ask = { type: 'tool/call', seq: 1, data: { name: 'ask_user_question', callId: 'call', arguments: JSON.stringify({ questions }) } };
const questionMessage = () => ({ id: 'official-answer', source: { kind: 'user-question-reply', callId: 'call', outcome: 'answered' },
  content: [{ type: 'text', text: JSON.stringify({ kind: 'answer_to_pending_question', tool: 'ask_user_question', callId: 'call', questions,
    answers: [{ id: 'attention', selected: ['当前范围'] }] }) }] });
const start = turn => ({ type: 'turn/start', data: { turn } });
const end = turn => ({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });

test('late official answer binds original call and rejects forged model payloads or mismatched identities', () => {
  const message = questionMessage();
  assert.equal(readQuestionReply(message, [ask]).text, '选择范围？：当前范围');
  assert.equal(readQuestionReply(message, []), null);
  for (const source of [{ kind: 'model' }, { kind: 'user' }, { ...message.source, callId: 'other' }, { ...message.source, outcome: 'pending' }]) {
    assert.equal(readQuestionReply({ ...message, source }, [ask]), null);
  }
  const change = patch => ({ ...message, content: [{ type: 'text', text: JSON.stringify({ ...JSON.parse(message.content[0].text), ...patch }) }] });
  for (const patch of [{ callId: 'other' }, { answers: [{ id: 'other', selected: [] }] }, { questions: [{ ...questions[0], question: 'forged' }] }]) {
    assert.equal(readQuestionReply(change(patch), [ask]), null);
  }
  assert.equal(readAdmittedQuestionReply(change({ answers: [{ id: 'attention', selected: [], custom: '' }] })).text, '选择范围？：已跳过');
});

test('timed next-turn answer is one choice bubble and owns plain and explicit replies', () => {
  const message = questionMessage(), user = { type: 'user/message', seq: 5, data: message };
  const pending = { type: 'tool/result', seq: 2, data: { message: { toolCallId: 'call', content: [{ type: 'text', text: '{"pending":true}' }] } } };
  const events = [start(1), ask, pending, end(1), start(2), user];
  assert.deepEqual(activeChatReply(events), { turn: 2, requestId: message.id });
  const rows = projectChatMessages([...events, { type: 'assistant/message', seq: 6, data: { turn: 2, message: { source: { kind: 'model' }, content: [{ type: 'text', text: '按当前范围继续。' }] } } }, end(2)]);
  assert.deepEqual(rows.map(row => row.text), ['选择范围？：当前范围', '按当前范围继续。']);
  assert.equal(rows[0].id, message.id);
  assert.doesNotMatch(JSON.stringify(rows), /answer_to_pending_question/);
  const duplicateTool = { type: 'tool/result', seq: 8, data: { message: { toolCallId: 'call', content: [{ type: 'text', text: JSON.stringify({ answers: [{ id: 'attention', selected: ['当前范围'] }] }) }] } } };
  assert.equal(projectChatMessages([...events, duplicateTool]).filter(row => row.kind === 'question-reply').length, 1);
  let tool, published;
  const agent = { session: { snapshotEvents: () => events } };
  installChatPublication({ tools: { register: value => { tool = value; } } }, agent, { appendRecord: (_session, _type, value) => { published = value; } });
  assert.equal(tool.execute({ text: '收到。' }, { agent, concludeTurn() {} }).requestId, message.id);
  assert.equal(published.requestId, message.id);
});

function bindingFixture(t, { owned = true } = {}) {
  const listeners = {}, received = [], sessionId = owned ? 'session' : 'other';
  const database = createAssistantOrchestrationStore({ filename: ':memory:' });
  t.after(() => database.close());
  database.ingest({ dedupeKey: 'initial', thread: { id: `desktop:${sessionId}`, source: { type: 'desktop', id: sessionId } },
    source: { channel: 'desktop', sessionId, messageId: 'initial', threadId: 'main' },
    actor: { kind: 'human', id: 'desktop-owner' }, content: '调查当前范围', mode: 'direct',
    gate: { allowed: true, strength: 'explicit', reason: 'desktop-owner-message' } });
  const ticket = database.createTicket({ threadId: `desktop:${sessionId}`, target: '调查当前范围', mandate: {
    source: { channel: 'desktop', sessionId, threadId: 'main' }, actorId: 'desktop-owner' } });
  database.createAssignment(ticket.id, {});
  const [assignment] = database.claimAssignments('worker', { validateMandate: () => true });
  const ownership = { owner: assignment.owner, fence: assignment.fence };
  const run = database.prepareRun(assignment.id, { ...ownership, sessionId: 'worker-session', directory: process.cwd() });
  database.updateRun(run.id, { ...ownership, state: 'submitted' });
  const [attention] = database.openAttention(assignment.id, { ...ownership, sessionId: run.sessionId, callId: 'worker-question', questions });
  const cardQuestions = [{ ...questions[0], id: attention.id }];
  const answer = database.answerDesktopAttention;
  database.answerDesktopAttention = value => { received.push(value); return answer(value); };
  const agent = { id: 'session' };
  const binding = installRouterQuestions({ on: (name, listener) => { listeners[name] = listener; } }, agent, { database });
  const execution = { name: 'ask_user_question', callId: 'call', agent, arguments: { questions: cardQuestions }, signal: new AbortController().signal };
  const message = () => ({ ...questionMessage(), content: [{ type: 'text', text: JSON.stringify({ kind: 'answer_to_pending_question',
    tool: 'ask_user_question', callId: 'call', questions: cardQuestions, answers: [{ id: attention.id, selected: ['当前范围'] }] }) }] });
  return { binding, execution, listeners, received, ticket, attention, database, agent, message };
}

test('trusted middleware binds owned Attention and handles immediate and late official answers without dispatch', async t => {
  const f = bindingFixture(t);
  await f.listeners['tools/pre-execute'](f.execution, async () => ({ kind: 'allow' }));
  assert.equal(f.database.routerQuestionBinding(f.agent.id, 'call').entries[0].ticketId, f.ticket.id);
  assert.equal(f.binding.read(f.message()).callId, 'call');
  assert.equal(f.binding.accept(f.message())[0].ticketId, f.ticket.id);
  assert.equal(f.received[0].requestId, `official-answer:${f.attention.id}`);
  assert.equal(f.binding.accept(f.message())[0].duplicate, true);
  const immediate = bindingFixture(t);
  await immediate.listeners['tools/pre-execute'](immediate.execution, async () => ({ kind: 'allow' }));
  await immediate.listeners['tools/post-execute'](immediate.execution, { isError: false, content: [{ type: 'text', text: JSON.stringify({
    answers: [{ id: immediate.attention.id, selected: ['当前范围'] }] }) }] }, async () => ({ kind: 'accept' }));
  assert.equal(immediate.received[0].requestId, `question:call:${immediate.attention.id}`);
  assert.equal(immediate.database.listTickets({ limit: 100 }).length, 1);
});

test('foreign, denied, ordinary and altered cards never acquire Ticket answer authority', async t => {
  const f = bindingFixture(t, { owned: false });
  await f.listeners['tools/pre-execute'](f.execution, async () => ({ kind: 'allow' }));
  assert.deepEqual(f.binding.accept(f.message()), []);
  assert.equal(f.received.length, 0);
  const denied = bindingFixture(t);
  await denied.listeners['tools/pre-execute'](denied.execution, async () => ({ kind: 'deny' }));
  assert.deepEqual(denied.binding.accept(denied.message()), []);
  const changed = bindingFixture(t);
  changed.execution.arguments = { questions: [{ ...changed.execution.arguments.questions[0], question: '无关问题' }] };
  await assert.rejects(changed.listeners['tools/pre-execute'](changed.execution, async () => ({ kind: 'allow' })), /不一致/);
});

test('official admission persists original identity, reconciles after restart, and never replays the Host message', async () => {
  let state = { requests: [] }, sent = 0;
  const message = questionMessage(), events = [ask, { type: 'user/message', data: message }];
  const inbox = createMessageInbox({ getState: async () => structuredClone(state), updateState: async change => { state = { ...state, ...change(state) }; },
    getAgent: () => ({ id: 'session', status: 'idle', followup() { sent++; } }), ensureSession: async () => { throw new Error('must not dispatch'); },
    readSession: async () => ({ events }) });
  const receipt = await inbox.admit({ threadId: 'main', sessionId: 'session', message, events });
  assert.equal(receipt.messageId, message.id);
  assert.equal(receipt.status, 'processing');
  assert.equal((await inbox.admit({ sessionId: 'session', message, events })).duplicate, true);
  assert.equal(state.requests.length, 1);
  assert.equal((await inbox.state('main'))[0].text, '选择范围？：当前范围');
  assert.equal((await inbox.state('main'))[0].questionReply.callId, 'call');
  events.push(end(2));
  await inbox.recover();
  assert.equal((await inbox.state('main'))[0].status, 'processed');
  assert.equal(sent, 0);
  await assert.rejects(inbox.admit({ sessionId: 'session', message: { ...message, source: { kind: 'user' } }, events }), /无效官方/);
});

test('live question source, durable receipt and server projection produce one bubble and bridge ordinary reply streaming', () => {
  const message = questionMessage(), questionReply = readQuestionReply(message, [ask]);
  const node = { kind: 'steering', seq: 5, ...message, time: 5 };
  const requests = [{ requestId: 'question-reply:official-answer', messageId: message.id, threadId: 'main', sessionId: 'session',
    status: 'processing', text: questionReply.text, questionReply, createdAt: 5 }];
  const history = { sessionId: 'session', requests, messages: [] };
  const chat = { legacy: { nodes: [node], turnEnds: new Map([[1, 3]]), partial: { turn: 2, blocks: [{ kind: 'text', text: '继续处理。' }] } } };
  const rows = quietChatRows(history, 'main', {}, chat);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'question-reply');
  assert.equal(rows[0].text, '选择范围？：当前范围');
  assert.equal(projectReplyStream({ history, chat, sessionId: 'session', running: true }).requestId, message.id);
  const projected = projectChatMessages([ask, { type: 'user/message', seq: 5, time: 5, data: message }]);
  assert.equal(quietChatRows({ ...history, messages: projected }, 'main', {}, chat).length, 1);
  assert.equal(projectReplyStream({ history: { ...history, requests: [] }, chat, sessionId: 'session', running: true }), null);
  assert.doesNotMatch(JSON.stringify(rows), /answer_to_pending_question/);
});

test('continued card answer is durable and idempotent on the original Ticket across model session replacement', async t => {
  const database = createAssistantOrchestrationStore({ filename: ':memory:' });
  t.after(() => database.close());
  database.ingest({ dedupeKey: 'initial', thread: { id: 'desktop:old-router', source: { type: 'desktop', id: 'old-router' } },
    source: { channel: 'desktop', sessionId: 'old-router', messageId: 'initial', threadId: 'main' },
    actor: { kind: 'human', id: 'desktop-owner' }, content: '调查当前范围', mode: 'direct',
    gate: { allowed: true, strength: 'explicit', reason: 'desktop-owner-message' } });
  const ticket = database.createTicket({ threadId: 'desktop:old-router', target: '调查当前范围', mandate: {
    source: { channel: 'desktop', sessionId: 'old-router', threadId: 'main' }, actorId: 'desktop-owner' } });
  database.createAssignment(ticket.id, {});
  const [assignment] = database.claimAssignments('worker', { validateMandate: () => true });
  const ownership = { owner: assignment.owner, fence: assignment.fence };
  const run = database.prepareRun(assignment.id, { ...ownership, sessionId: 'worker-session', directory: process.cwd() });
  database.updateRun(run.id, { ...ownership, state: 'submitted' });
  const [attention] = database.openAttention(assignment.id, { ...ownership, sessionId: run.sessionId, callId: 'worker-question', questions });
  const cardQuestions = [{ ...questions[0], id: attention.id }], answers = [{ id: attention.id, selected: ['当前范围'] }];
  const listeners = {};
  const agent = { id: 'replacement' };
  const binder = installRouterQuestions({ on: (name, listener) => { listeners[name] = listener; } }, agent, { database,
    getOwnerScope: async () => ({ threadId: 'main', sessionIds: ['old-router', agent.id] }) });
  await listeners['tools/pre-execute']({ name: 'ask_user_question', callId: 'call', agent, arguments: { questions: cardQuestions },
    signal: new AbortController().signal }, async () => ({ kind: 'allow' }));
  const message = { ...questionMessage(), content: [{ type: 'text', text: JSON.stringify({ kind: 'answer_to_pending_question', tool: 'ask_user_question',
    callId: 'call', questions: cardQuestions, answers }) }] };
  const [first] = binder.accept(message), [second] = binder.accept(message);
  assert.equal(second.duplicate, true);
  assert.equal(first.answerTriggerId, second.answerTriggerId);
  const stored = database.getTrigger(first.answerTriggerId);
  assert.equal(stored.source.attentionId, attention.id);
  assert.equal(stored.source.answer.selected[0], '当前范围');
  assert.equal(database.listTickets({ limit: 100 }).length, 1);
});
