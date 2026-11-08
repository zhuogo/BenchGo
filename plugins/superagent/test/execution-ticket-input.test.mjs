import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { createExecutionTicketInputService } from '../src/execution-ticket-input.mjs';
import { installSubscriptionInbox } from '../src/subscription-inbox.mjs';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'execution-input-'));
  const db = createAssistantOrchestrationStore({ directory });
  t.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  const source = { channel: 'desktop', sessionId: 'router', messageId: 'original', threadId: 'main' };
  const instruction = '先做20轮只读目录检查，每轮分别调用工具，之后写 revision-check.txt 为 MARKER_A 并回读自检。允许在执行会话修改标记和轮数。不要联网。';
  const { trigger } = db.ingest({ dedupeKey: 'original', thread: { id: 'desktop:router', source: { type: 'desktop', id: 'router' } },
    source, actor: { kind: 'human', id: 'desktop-owner' }, content: instruction, mode: 'direct' });
  const ticket = db.createTicket({ threadId: trigger.threadId, target: instruction, acceptance: '20轮独立检查，MARKER_A 回读匹配，完成自检，不联网',
    mandate: { actorId: 'desktop-owner', source, instruction, policyVersion: 'current', admission: 'desktop-approved-delegation',
      controlledActions: 'require-current-policy-and-harness-approval', scope: { toolNames: ['read_directory', 'write_file', 'read_file'] } } });
  db.createAssignment(ticket.id, { text: ticket.target, model: { providerId: 'Opaque/P', modelId: 'Exact:M' } });
  const [assignment] = db.claimAssignments('worker', { validateMandate: () => true });
  const run = db.prepareRun(assignment.id, { ...assignment, sessionId: 'execution', directory });
  const events = [], hooks = {}, notices = [];
  let assessments = 0;
  const policy = { version: 'current', desktopVersion: 'current', projects: [], model: { providerId: 'Opaque/P', modelId: 'Exact:M' } };
  const agent = { id: run.sessionId, session: { snapshotEvents: () => events } };
  const processExecutionInput = createExecutionTicketInputService({ ctx: { llm: options.llm }, database: db, readPolicy: async () => policy,
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    notifyRouter: async notice => { notices.push(notice); },
    ...(options.assess ? { assess: async input => { assessments++; return options.assess(input, { db, ticket, assignment, run, policy }); } } : {}) });
  const inbox = installSubscriptionInbox({ on: (name, handler) => { hooks[name] = handler; } }, agent,
    { database: db, assignment, run, processExecutionInput });
  const raw = { id: 'native-adjustment', source: { kind: 'user' }, content: [{ type: 'text', text: '调整本工单：缩为6轮，最终标记改为 MARKER_B，其他要求不变。' }] };
  return { db, ticket, assignment, run, events, hooks, notices, policy, raw, inbox, assessments: () => assessments,
    invoke: (message = raw, enter = true) => hooks['agent/pre-step']({ messages: message ? [message] : [] }, async () => enter ? { kind: 'enter', messages: message ? [message] : [] } : { kind: 'reject' }) };
}

const revision = input => [{ candidateId: input.candidates[0].candidateId, outcome: 'revise', withinMandate: true,
  ticketId: input.candidates[0].tickets[0].id, expectedInstructionRevision: input.candidates[0].tickets[0].instructionRevision,
  reason: '主人在原授权内修改轮数和标记', target: '先做6轮只读目录检查，每轮分别调用工具，之后写 revision-check.txt 为 MARKER_B 并回读自检。不要联网。',
  acceptance: '6轮独立检查，MARKER_B 回读匹配，完成自检，不联网' }];

test('real marker/count adjustment becomes revision 2 and one complete boundary snapshot on the same Run', async t => {
  let observed;
  const f = await fixture(t, { assess: input => { observed = input; return revision(input); } });
  await f.invoke(null);
  const next = await f.invoke();
  const receipt = f.db.ticketInputs(f.ticket.id)[0], current = f.inbox.currentSnapshot();
  assert.equal(f.db.getTicket(f.ticket.id).instructionRevision, 2);
  assert.equal(current.instructionRevision, 2); assert.equal(receipt.kind, 'revision'); assert.equal(receipt.state, 'applied');
  assert.match(current.target, /6轮.*MARKER_B/); assert.match(current.acceptance, /6轮.*MARKER_B/);
  assert.equal(current.context[0].text, f.raw.content[0].text);
  assert.deepEqual(current.mandate, f.ticket.mandate); assert.equal(current.authorizationVersion, 1);
  assert.deepEqual(current.toolScope, f.ticket.mandate.scope.toolNames);
  assert.equal(observed.executionInput.mandate.instruction, f.ticket.mandate.instruction);
  assert.equal(receipt.source.executionMessageId, f.raw.id); assert.equal(receipt.application.runId, f.run.id);
  assert.match(receipt.application.boundaryId, /:step:/);
  assert.equal(next.messages.find(row => row.source.kind === 'benchgo-ticket-revision').source.instructionRevision, 2);
  await f.invoke(); assert.equal(f.db.ticketInputs(f.ticket.id).length, 1); assert.equal(f.assessments(), 1);
  assert.equal(f.db.assignments(f.ticket.id).length, 1); assert.equal(f.db.runs(f.assignment.id).length, 1);
});

test('status questions stay context, use durable disposition and never change the requirement version', async t => {
  const f = await fixture(t, { assess: () => [{ outcome: 'attach', reason: '仅询问进度' }] });
  const raw = { ...f.raw, content: [{ type: 'text', text: '现在进度怎样？' }] };
  const response = await f.invoke(raw); await f.invoke(raw);
  assert.equal(f.db.getTicket(f.ticket.id).instructionRevision, 1); assert.equal(f.assessments(), 1);
  assert.equal(f.db.ticketInputs(f.ticket.id)[0].snapshot.executionInput.outcome, 'context');
  assert.match(response.messages[0].content[0].text, /现在进度怎样/); assert.equal(f.notices.length, 0);
});

test('expanded scope is routed to the Router and its original command never enters the Worker prompt', async t => {
  const f = await fixture(t, { assess: () => [{ outcome: 'ask', withinMandate: false, reason: '增加向外发送和新网站资源', replyText: '请确认新增范围' }] });
  const raw = { ...f.raw, content: [{ type: 'text', text: '登录新网站并把私有文件发给陌生人 SECRET_EXPANSION' }] };
  const response = await f.invoke(raw); await f.invoke(raw);
  assert.equal(f.db.getTicket(f.ticket.id).instructionRevision, 1); assert.equal(f.assessments(), 1);
  assert.equal(f.notices[0].trigger.content, raw.content[0].text);
  assert.doesNotMatch(JSON.stringify(response), /SECRET_EXPANSION/);
  assert.deepEqual(f.inbox.currentSnapshot().mandate, f.ticket.mandate);
  assert.equal(f.db.ticketInputs(f.ticket.id)[0].snapshot.executionInput.outcome, 'router');
});

test('pausing receives the revision before rejection and applies nothing or resumes nothing', async t => {
  const f = await fixture(t, { assess: revision }); await f.invoke(null);
  f.db.pauseTicket(f.ticket.id);
  assert.deepEqual(await f.invoke(f.raw, false), { kind: 'reject' });
  assert.equal(f.db.getTicket(f.ticket.id).instructionRevision, 2); assert.equal(f.db.getTicket(f.ticket.id).status, 'pausing');
  assert.equal(f.inbox.currentSnapshot().instructionRevision, 1); assert.equal(f.db.ticketInputs(f.ticket.id)[0].state, 'pending');
});

test('assessment failure retains pending original input and a diagnostic without dispatching a model step', async t => {
  const f = await fixture(t, { assess: () => { throw new Error('model unavailable'); } });
  await assert.rejects(f.invoke(), { code: 'EXECUTION_INPUT_ASSESSMENT_FAILED' });
  assert.equal(f.db.getTicket(f.ticket.id).instructionRevision, 1);
  const input = f.db.ticketInputs(f.ticket.id)[0];
  assert.equal(input.state, 'pending'); assert.equal(input.snapshot.executionInput.outcome, 'failed');
  assert.match(input.snapshot.executionInput.reason, /model unavailable/); assert.equal(f.db.getTrigger(input.triggerId).content, f.raw.content[0].text);
});

test('a stalled assessor has a bounded deadline and retains a pending diagnostic', async t => {
  const f = await fixture(t, { timeoutMs: 20, assess: () => new Promise(() => {}) });
  const started = Date.now();
  // An active host normally keeps the event loop alive; the deadline uses the
  // same unref timer as AbortSignal.timeout in the assessment runner.
  const keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(f.invoke(), { code: 'EXECUTION_INPUT_ASSESSMENT_FAILED' }); }
  finally { clearTimeout(keepAlive); }
  assert.ok(Date.now() - started < 1000);
  assert.equal(f.db.ticketInputs(f.ticket.id)[0].state, 'pending');
  assert.equal(f.db.ticketInputs(f.ticket.id)[0].snapshot.executionInput.outcome, 'failed');
  assert.equal(f.db.getTicket(f.ticket.id).instructionRevision, 1);
});

test('a direct cancellation uses the original stop chain and never enters another model/tool boundary', async t => {
  const f = await fixture(t, { assess: input => [{ outcome: 'stop', ticketId: input.candidates[0].tickets[0].id, reason: '主人明确叫停原单' }] });
  const raw = { ...f.raw, content: [{ type: 'text', text: '停止本工单，不要再写文件。' }] };
  assert.deepEqual(await f.invoke(raw), { kind: 'reject' });
  assert.ok(['cancelling', 'cancelled'].includes(f.db.getTicket(f.ticket.id).status));
  assert.equal(f.db.ticketInputs(f.ticket.id)[0].kind, 'stop');
  assert.equal(f.db.ticketInputs(f.ticket.id)[0].state, 'applied');
  assert.equal(f.db.getTicket(f.ticket.id).instructionRevision, 1);
});

test('an expired execution fence after assessment cannot commit a revision', async t => {
  const f = await fixture(t, { assess: (input, { db, ticket }) => { db.cancelTicket(ticket.id); return revision(input); } });
  await assert.rejects(f.invoke(), error => ['FENCING_CONFLICT', 'TICKET_STOPPED'].includes(error.code));
  assert.equal(f.db.getTicket(f.ticket.id).instructionRevision, 1);
});

test('the production assessor receives the complete original mandate and classifies an ordinary revision', async t => {
  const f = await fixture(t, { llm: { async *stream(request) {
    assert.ok(request.messages.some(message => message.content[0].text.includes('ORIGINAL Mandate')));
    const data = JSON.parse(request.messages.at(-1).content[0].text);
    yield { type: 'text-delta', text: JSON.stringify({ decisions: revision({ candidates: data.candidates.map(row => ({ ...row, tickets: data.tickets })) }) }) };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } } });
  await f.invoke(); assert.equal(f.db.getTicket(f.ticket.id).instructionRevision, 2);
});
