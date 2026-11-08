import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { createTicketRevisionService } from '../src/ticket-revision-service.mjs';
import { createOrchestrationRuntime } from '../src/orchestration-runtime.mjs';
import { readAssessmentPolicy, authorizeAssessment } from '../src/assessment-policy.mjs';
import { createAssessmentRunner } from '../src/assessment-runner.mjs';
import { ingestAssistantEvent } from '../src/intake.mjs';
import { installSubscriptionInbox } from '../src/subscription-inbox.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ticket-revision-'));
  let db = createAssistantOrchestrationStore({ directory });
  t.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  const source = { channel: 'desktop', sessionId: 'owner', messageId: 'first', threadId: 'main' };
  const mandate = { actorId: 'desktop-owner', source, instruction: 'first', policyVersion: 'current', admission: 'desktop-approved-delegation', controlledActions: 'require-current-policy-and-harness-approval' };
  const { trigger } = db.ingest({ dedupeKey: 'first', thread: { id: 'desktop:owner', source: { type: 'desktop', id: 'owner' } }, source, actor: { kind: 'human', id: 'desktop-owner' }, content: 'first', mode: 'direct' });
  const ticket = db.createTicket({ threadId: trigger.threadId, target: 'original target', acceptance: 'old checks', mandate });
  db.createAssignment(ticket.id, { model: { providerId: 'Opaque/P', modelId: 'Exact:M' }, text: ticket.target });
  const nextSource = { ...source, messageId: 'revision' };
  const next = db.ingest({ dedupeKey: 'revision', thread: { id: trigger.threadId, source: { type: 'desktop', id: 'owner' } }, source: nextSource, actor: { kind: 'human', id: 'desktop-owner' }, content: 'new request', mode: 'direct' });
  const input = { operation: 'revise', expectedInstructionRevision: 1, target: 'new target', acceptance: 'new checks', reason: 'correct requirements', requestKey: 'revision', mandate: { ...mandate, source: nextSource, instruction: 'new request', policyVersion: 'current' }, triggerId: next.trigger.id, model: { providerId: 'Opaque/P', modelId: 'Exact:M' }, validateMandate: m => m.policyVersion === 'current' };
  return { directory, get db() { return db; }, ticket, input, reopen() { db.close(); db = createAssistantOrchestrationStore({ directory }); } };
}

function deliverCommitted(database) {
  for (const delivery of database.claimOutbox('test-delivery')) {
    database.saveOutboxReply(delivery.id, { owner: 'test-delivery',
      publication: { action: 'deliver', origin: 'router', text: '这项工作已经完成。' } });
    database.finishOutbox(delivery.id,
      { owner: 'test-delivery', sent: true, receipt: { status: 'accepted', messageId: `sent:${delivery.id}` } });
  }
}

function hostRevision(f, requestExpansion) {
  const events = [{ type: 'turn/start' }, { type: 'user/message', data: { id: 'scope-change', source: { kind: 'user' }, content: [{ type: 'text', text: '将工单移到选定项目' }] } }];
  const ownerAgent = { id: 'owner', status: 'running', session: { header: {}, snapshotEvents: () => events } };
  const policy = { desktopVersion: 'current', projects: [{ id: 'project', path: f.directory }] };
  const ctx = { agents: { get: () => ownerAgent, currentInitiator: () => ownerAgent, turnBoundaryOf: () => ({ openTurnStartSeq: 0 }) },
    llm: { resolveModelInfo: async (provider, id) => ({ provider, id }) } };
  const service = createTicketRevisionService({ ctx, database: f.db, readPolicy: async () => policy, requestExpansion });
  const input = { id: f.ticket.id, operation: 'revise', expectedInstructionRevision: 1, requestId: 'host-expansion', reason: '使用明确选择的项目', projectId: 'project' };
  return { events, policy, ownerAgent, input, change: () => service.change(input, { agent: ownerAgent }, { ownerAgent }) };
}

test('requirements change preserves Assignment and source Mandate with durable CAS', async t => {
  const f = await fixture(t), old = f.db.assignments(f.ticket.id)[0];
  const changed = f.db.changeTicket(f.ticket.id, f.input);
  assert.equal(changed.instructionRevision, 2);
  assert.equal(changed.mandate.policyVersion, 'current');
  assert.equal(f.db.getAssignment(old.id).state, 'queued');
  const next = f.db.assignments(f.ticket.id)[0];
  assert.equal(next.instructionRevision, 1);
  assert.equal(next.state, 'queued');
  assert.equal(next.pauseContinuation, undefined);
  assert.deepEqual(f.db.ticketRevisions(f.ticket.id).map(row => row.mandate.policyVersion), ['current', 'current']);
  assert.equal(changed.mandate.instruction, 'first');
  assert.equal(changed.mandate.source.messageId, 'first');
  f.reopen();
  assert.equal(f.db.changeTicket(f.ticket.id, f.input).instructionRevision, 2);
  assert.equal(f.db.assignments(f.ticket.id).length, 1);
  assert.throws(() => f.db.changeTicket(f.ticket.id, { ...f.input, requestKey: 'stale' }), { code: 'INSTRUCTION_REVISION_CONFLICT' });
  assert.throws(() => f.db.changeTicket(f.ticket.id, { ...f.input, target: 'different' }), { code: 'IDEMPOTENCY_CONFLICT' });
  const claimed = f.db.claimAssignments('worker', { validateMandate: m => m.policyVersion === 'current' });
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].id, next.id);
  assert.equal(f.db.renewAssignment(next.id, { owner: 'worker', fence: claimed[0].fence, leaseMs: 60000, validateMandate: m => m.policyVersion === 'current' }).allowed, true);
});

test('completed work creates an idempotent linked adjustment and never changes its prior result', async t => {
  const f = await fixture(t);
  f.db.commitResult(f.ticket.id, { result: { summary: 'old result', outcome: 'completed' }, uniqueKey: 'old-result', instructionRevision: 1 });
  deliverCommitted(f.db);
  const before = f.db.getTicket(f.ticket.id), results = f.db.results(f.ticket.id);
  assert.throws(() => f.db.changeTicket(f.ticket.id, { ...f.input, operation: 'adjustment', validateMandate: () => false }), { code: 'MANDATE_REVOKED' });
  const next = f.db.changeTicket(f.ticket.id, { ...f.input, operation: 'adjustment' });
  assert.notEqual(next.id, before.id);
  assert.equal(next.adjustmentOfTicketId, before.id);
  assert.equal(next.instructionRevision, 1);
  assert.equal(next.resultVersion, 0);
  assert.deepEqual(f.db.getTicket(f.ticket.id), before);
  assert.deepEqual(f.db.results(f.ticket.id), results);
  assert.equal(f.db.assignments(next.id)[0].sourceResultVersion, before.resultVersion);
  f.reopen();
  assert.equal(f.db.changeTicket(f.ticket.id, { ...f.input, operation: 'adjustment' }).id, next.id);
  assert.throws(() => f.db.changeTicket(f.ticket.id, { ...f.input, operation: 'adjustment', requestKey: 'duplicate-adjustment' }), { code: 'TRIGGER_ALREADY_ASSIGNED' });
});

test('live execution accepts a revision without cancelling its run; forged sources are rejected', async t => {
  const f = await fixture(t);
  assert.throws(() => f.db.changeTicket(f.ticket.id, { ...f.input, mandate: { ...f.input.mandate, actorId: 'imposter' } }), { code: 'MANDATE_REVOKED' });
  const [claimed] = f.db.claimAssignments('worker', { validateMandate: () => true });
  const run = f.db.prepareRun(claimed.id, { owner: 'worker', fence: claimed.fence, sessionId: 'same-session', directory: f.directory });
  f.db.changeTicket(f.ticket.id, f.input);
  assert.equal(f.db.getAssignment(claimed.id).state, 'claimed');
  assert.equal(f.db.getAssignment(claimed.id).instructionRevision, 1);
  assert.equal(f.db.runs(claimed.id)[0].id, run.id);
  assert.equal(f.db.appliedTicketSnapshot(claimed.id).target, 'original target');
  const latest = f.db.applyTicketRevision(claimed.id, { owner: 'worker', fence: claimed.fence, runId: run.id, boundaryId: 'batch-2' });
  assert.equal(latest.target, 'new target');
  assert.equal(latest.acceptance, 'new checks');
  assert.equal(latest.instructionRevision, 2);
  assert.equal(latest.authorizationVersion, 1);
  assert.equal(f.db.ticketInputs(f.ticket.id)[0].state, 'applied');
  assert.equal(f.db.ticketInputs(f.ticket.id)[0].application.runId, run.id);
});

test('one tool batch pins a complete snapshot while the next boundary applies the newest revision', async t => {
  const f = await fixture(t), [assignment] = f.db.claimAssignments('worker', { validateMandate: () => true });
  const ownership = { owner: assignment.owner, fence: assignment.fence };
  const run = f.db.prepareRun(assignment.id, { ...ownership, sessionId: 'worker-session', directory: f.directory });
  const first = f.db.applyTicketRevision(assignment.id, { ...ownership, runId: run.id, boundaryId: 'batch-one' });
  f.db.changeTicket(f.ticket.id, f.input);
  assert.deepEqual(f.db.applyTicketRevision(assignment.id, { ...ownership, runId: run.id, boundaryId: 'batch-one' }), first);
  assert.equal(f.db.appliedTicketSnapshot(assignment.id).instructionRevision, 1);
  const next = f.db.applyTicketRevision(assignment.id, { ...ownership, runId: run.id, boundaryId: 'batch-two' });
  assert.equal(next.instructionRevision, 2);
  assert.equal(next.target, 'new target'); assert.equal(next.acceptance, 'new checks');
  assert.equal(next.context[0].triggerId, f.input.triggerId);
  assert.equal(f.db.assignments(f.ticket.id).length, 1);
  assert.equal(f.db.runs(assignment.id).length, 1);
  assert.equal(f.db.runs(assignment.id)[0].sessionId, 'worker-session');
  assert.throws(() => f.db.applyTicketRevision(assignment.id, { ...ownership, fence: assignment.fence + 1, runId: run.id, boundaryId: 'forged' }), { code: 'FENCING_CONFLICT' });
  f.reopen();
  assert.equal(f.db.ticketInputs(f.ticket.id)[0].application.boundaryId, 'batch-two');
  assert.deepEqual(f.db.appliedTicketSnapshot(assignment.id), next);
});

test('the official pre-step inbox hook applies one snapshot for a model tool batch and refuses pause', async t => {
  const f = await fixture(t), [assignment] = f.db.claimAssignments('worker', { validateMandate: () => true });
  const run = f.db.prepareRun(assignment.id, { owner: assignment.owner, fence: assignment.fence, sessionId: 'worker-session', directory: f.directory });
  const hooks = {}, agent = { id: run.sessionId, session: { snapshotEvents: () => [] } };
  const inbox = installSubscriptionInbox({ on: (name, handler) => { hooks[name] = handler; } }, agent, { database: f.db, assignment, run });
  const enter = () => Promise.resolve({ kind: 'enter', messages: [] });
  assert.equal((await hooks['agent/pre-step']({}, enter)).messages.length, 0);
  f.db.changeTicket(f.ticket.id, f.input);
  assert.equal(inbox.currentSnapshot().instructionRevision, 1);
  const next = await hooks['agent/pre-step']({}, enter);
  assert.equal(inbox.currentSnapshot().instructionRevision, 2);
  assert.equal(next.messages.length, 1);
  assert.match(next.messages[0].content[0].text, /new target/);
  f.db.pauseTicket(f.ticket.id);
  assert.deepEqual(await hooks['agent/pre-step']({}, enter), { kind: 'reject' });
});

test('native execution input is durably received once, filtered and projected through the same inbox', async t => {
  const f = await fixture(t), [assignment] = f.db.claimAssignments('worker', { validateMandate: () => true });
  const run = f.db.prepareRun(assignment.id, { owner: assignment.owner, fence: assignment.fence, sessionId: 'worker-session', directory: f.directory });
  f.db.updateRun(run.id, { owner: assignment.owner, fence: assignment.fence, state: 'submitted' });
  const hooks = {}, events = [], agent = { id: run.sessionId, session: { snapshotEvents: () => events } };
  installSubscriptionInbox({ on: (name, handler) => { hooks[name] = handler; } }, agent, { database: f.db, assignment, run });
  const raw = { id: 'native-user-input', source: { kind: 'user' }, content: [{ type: 'text', text: '补充原文链接' }] };
  const invoke = () => hooks['agent/pre-step']({ messages: [raw] }, async () => ({ kind: 'enter', messages: [raw] }));
  const next = await invoke();
  assert.equal(next.messages.length, 1);
  assert.equal(next.messages[0].source.kind, 'benchgo-subscription');
  assert.equal(f.db.ticketInputs(f.ticket.id).length, 1);
  const input = f.db.ticketInputs(f.ticket.id)[0];
  assert.equal(input.source.executionSessionId, run.sessionId);
  assert.equal(input.source.executionMessageId, raw.id);
  assert.equal(input.state, 'pending');
  await invoke(); assert.equal(f.db.ticketInputs(f.ticket.id).length, 1);
  events.push({ type: 'user/message', data: next.messages[0] });
  hooks['agent/assistant-stream']({ frame: { type: 'start' } });
  const applied = f.db.ticketInputs(f.ticket.id)[0];
  assert.equal(applied.state, 'applied'); assert.equal(applied.application.runId, run.id);
  f.db.pauseTicket(f.ticket.id);
  const pausedRaw = { ...raw, id: 'paused-input' };
  assert.deepEqual(await hooks['agent/pre-step']({ messages: [pausedRaw] }, async () => ({ kind: 'reject' })), { kind: 'reject' });
  assert.equal(f.db.ticketInputs(f.ticket.id).length, 2);
  assert.equal(f.db.ticketInputs(f.ticket.id)[1].state, 'pending');
});

test('a leaf Assignment retains its original execution scope when Ticket requirements change', async t => {
  const f = await fixture(t), leaf = f.db.createAssignment(f.ticket.id, { text: 'only this leaf' });
  const [assignment] = f.db.claimAssignments('leaf-worker', { assignmentId: leaf.id, validateMandate: () => true });
  const ownership = { owner: assignment.owner, fence: assignment.fence };
  const run = f.db.prepareRun(assignment.id, { ...ownership, sessionId: 'leaf-session', directory: f.directory });
  assert.equal(f.db.applyTicketRevision(assignment.id, { ...ownership, runId: run.id, boundaryId: 'first' }).executionScope, 'only this leaf');
  f.db.changeTicket(f.ticket.id, f.input);
  const current = f.db.applyTicketRevision(assignment.id, { ...ownership, runId: run.id, boundaryId: 'next' });
  assert.equal(current.target, 'new target'); assert.equal(current.executionScope, 'only this leaf');
  assert.equal(f.db.getAssignment(assignment.id).text, 'only this leaf');
});

test('pause receives revisions without applying or resuming, and stop blocks new boundaries', async t => {
  const f = await fixture(t), [assignment] = f.db.claimAssignments('worker', { validateMandate: () => true });
  const ownership = { owner: assignment.owner, fence: assignment.fence };
  const run = f.db.prepareRun(assignment.id, { ...ownership, sessionId: 'worker-session', directory: f.directory });
  f.db.pauseTicket(f.ticket.id);
  const changed = f.db.changeTicket(f.ticket.id, f.input);
  assert.equal(changed.status, 'pausing');
  assert.equal(f.db.pendingTicketInputs(f.ticket.id).length, 1);
  assert.equal(f.db.getAssignment(assignment.id).instructionRevision, 1);
  assert.throws(() => f.db.applyTicketRevision(assignment.id, { ...ownership, runId: run.id, boundaryId: 'paused' }), { code: 'TICKET_PAUSED' });
  f.db.cancelTicket(f.ticket.id);
  assert.throws(() => f.db.applyTicketRevision(assignment.id, { ...ownership, runId: run.id, boundaryId: 'stopped' }), error => ['TICKET_STOPPED', 'FENCING_CONFLICT'].includes(error.code));
});

test('a queued paused execution applies its latest complete requirements only after explicit resume', async t => {
  const f = await fixture(t), assignment = f.db.assignments(f.ticket.id)[0];
  f.db.pauseTicket(f.ticket.id);
  f.db.changeTicket(f.ticket.id, f.input);
  assert.equal(f.db.getTicket(f.ticket.id).status, 'paused');
  assert.deepEqual(f.db.claimAssignments('worker', { validateMandate: () => true }), []);
  assert.equal(f.db.getAssignment(assignment.id).instructionRevision, 1);
  f.db.resumeTicket(f.ticket.id);
  const [claimed] = f.db.claimAssignments('worker', { validateMandate: () => true });
  assert.equal(claimed.id, assignment.id);
  assert.equal(claimed.instructionRevision, 2);
  assert.equal(claimed.appliedSnapshot.target, 'new target');
  assert.equal(claimed.appliedSnapshot.acceptance, 'new checks');
});

test('structured expansion needs a trusted approval and increments authority separately from requirements', async t => {
  const f = await fixture(t), mandate = { ...f.input.mandate, project: { id: 'new-project', path: 'C:/new' } };
  assert.throws(() => f.db.changeTicket(f.ticket.id, { ...f.input, mandate }), { code: 'MANDATE_EXPANSION_REQUIRED' });
  const changed = f.db.changeTicket(f.ticket.id, { ...f.input, mandate,
    authorizeExpansion: () => ({ approved: true, id: 'real-user-approval', triggerId: f.input.triggerId, actorId: mandate.actorId }) });
  assert.equal(changed.instructionRevision, 2); assert.equal(changed.mandate.authorizationVersion, 2);
  assert.equal(changed.mandate.authorizationApproval.id, 'real-user-approval');
  assert.equal(f.db.ticketInputs(f.ticket.id)[0].authorizationVersion, 2);
});

test('a structured tool restriction becomes the current hard boundary without waiting for ordinary revision application', async t => {
  const f = await fixture(t), [assignment] = f.db.claimAssignments('worker', { validateMandate: () => true });
  const run = f.db.prepareRun(assignment.id, { owner: assignment.owner, fence: assignment.fence, sessionId: 'worker-session', directory: f.directory });
  const first = f.db.applyTicketRevision(assignment.id, { owner: assignment.owner, fence: assignment.fence, runId: run.id, boundaryId: 'in-flight' });
  const changed = f.db.changeTicket(f.ticket.id, { ...f.input, mandate: { ...f.input.mandate, scope: { toolNames: ['read_file'] } } });
  assert.equal(changed.mandate.authorizationVersion ?? 1, 1);
  assert.deepEqual(changed.mandate.scope.toolNames, ['read_file']);
  assert.deepEqual(f.db.appliedTicketSnapshot(assignment.id), first);
});

test('host scope expansion awaits the real approval once and binds the receipt to one exact change', async t => {
  const f = await fixture(t); let approvals = 0;
  const host = hostRevision(f, async ({ trigger, mandate, difference, ownerAgent }) => {
    approvals++; assert.equal(ownerAgent.id, 'owner');
    assert.equal(mandate.project.id, 'project'); assert.equal(difference.requested[0].id, 'project');
    return { approved: true, id: 'host-approval', triggerId: trigger.id, actorId: trigger.actor.id };
  });
  const changed = await host.change();
  assert.equal(changed.mandate.authorizationVersion, 2);
  assert.equal(changed.mandate.authorizationApproval.id, 'host-approval');
  assert.equal(changed.mandate.project.id, 'project');
  assert.equal(f.db.assignments(f.ticket.id).length, 1);
  assert.equal((await host.change()).instructionRevision, 2);
  assert.equal(approvals, 1);
  host.input.reason = 'different change';
  await assert.rejects(host.change(), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('denied or stale real scope approval never changes the Ticket or its Mandate', async t => {
  const denied = await fixture(t), deniedHost = hostRevision(denied, async () => ({ approved: false }));
  await assert.rejects(deniedHost.change(), { code: 'MANDATE_EXPANSION_DENIED' });
  assert.equal(denied.db.getTicket(denied.ticket.id).instructionRevision, 1);
  const stale = await fixture(t);
  const staleHost = hostRevision(stale, async ({ trigger }) => {
    staleHost.policy.desktopVersion = 'newer-policy';
    return { approved: true, id: 'stale', triggerId: trigger.id, actorId: trigger.actor.id };
  });
  await assert.rejects(staleHost.change(), { code: 'TICKET_CHANGE_STALE' });
  assert.equal(stale.db.getTicket(stale.ticket.id).instructionRevision, 1);
});

test('an established execution cannot claim a changed project without moving its real session', async t => {
  const f = await fixture(t), [assignment] = f.db.claimAssignments('worker', { validateMandate: () => true });
  f.db.prepareRun(assignment.id, { owner: assignment.owner, fence: assignment.fence, sessionId: 'old-workspace-session', directory: f.directory });
  const host = hostRevision(f, async () => assert.fail('unsupported live workspace move must be explicit before approval'));
  await assert.rejects(host.change(), { code: 'PROJECT_REQUIRES_ADJUSTMENT' });
  assert.equal(f.db.getTicket(f.ticket.id).instructionRevision, 1);
});

test('a source message shared by context and revision has one durable input receipt', async t => {
  const f = await fixture(t);
  const context = f.db.recordTicketInput({ ticketId: f.ticket.id, triggerId: f.input.triggerId, kind: 'context', idempotencyKey: `trigger:${f.input.triggerId}` });
  f.db.changeTicket(f.ticket.id, f.input);
  assert.equal(f.db.ticketInputs(f.ticket.id).length, 1);
  assert.equal(f.db.ticketInputs(f.ticket.id)[0].id, context.id);
  assert.equal(f.db.ticketInputs(f.ticket.id)[0].kind, 'revision');
  assert.equal(f.db.recordTicketInput({ ticketId: f.ticket.id, triggerId: f.input.triggerId, kind: 'context', idempotencyKey: 'another-entry' }).id, context.id);
});

test('an old subscription receipt migrates into the one input ledger without replaying its message', async t => {
  const f = await fixture(t);
  f.db.subscribe(f.ticket.id, f.ticket.threadId, { beforeTriggerId: f.input.triggerId });
  f.db.deliverSubscribedMessage(f.input.triggerId, { ticketId: f.ticket.id });
  const [assignment] = f.db.claimAssignments('worker', { validateMandate: () => true });
  const ownership = { owner: assignment.owner, fence: assignment.fence };
  const run = f.db.prepareRun(assignment.id, { ...ownership, sessionId: 'migration-session', directory: f.directory });
  f.db.acknowledgeSubscriptionMessage(assignment.id, { ...ownership, triggerId: f.input.triggerId, sessionId: run.sessionId, messageId: 'original-receipt' });
  const path = f.db.path; f.db.close();
  const legacy = new DatabaseSync(path);
  legacy.exec('DROP TABLE sa_ticket_inputs; DROP TABLE sa_ticket_boundaries'); legacy.close();
  f.reopen();
  const receipt = f.db.ticketInputs(f.ticket.id)[0];
  assert.equal(receipt.state, 'applied'); assert.equal(receipt.application.runId, run.id);
  assert.equal(receipt.application.messageId, 'original-receipt');
  assert.equal(receipt.application.migrated, true);
  assert.deepEqual(f.db.pendingSubscriptionMessages(f.ticket.id), []);
});

test('live summary follows current goal, actual assignment progress and blocker without reusing old revision results', async t => {
  const f = await fixture(t);
  assert.equal(f.db.getTicket(f.ticket.id).liveSummary.progress, '等待执行');
  const [assignment] = f.db.claimAssignments('worker', { validateMandate: () => true });
  assert.equal(f.db.getTicket(f.ticket.id).liveSummary.progress, '执行中');
  f.db.renewAssignment(assignment.id, { owner: assignment.owner, fence: assignment.fence, leaseMs: 60000, validateMandate: () => false });
  assert.match(f.db.getTicket(f.ticket.id).liveSummary.blocker, /核实/);
  const other = await fixture(t);
  other.db.commitResult(other.ticket.id, { result: { summary: 'stale old result' }, uniqueKey: 'old-summary', instructionRevision: 1, status: 'waiting' });
  other.db.updateTicket(other.ticket.id, { target: 'updated goal' });
  const summary = other.db.getTicket(other.ticket.id).liveSummary;
  assert.equal(summary.goal, 'updated goal');
  assert.doesNotMatch(summary.progress, /stale old result/);
});

test('host revision preserves its run model and rejects per-Ticket model fields without another approval', async t => {
  const f = await fixture(t);
  const events = [{ type: 'turn/start' }, { type: 'user/message', data: { id: 'new-owner-message', source: { kind: 'user' }, content: [{ type: 'text', text: '请修改验收条件' }] } }];
  const ownerAgent = { id: 'owner', status: 'running', session: { header: {}, snapshotEvents: () => events } };
  const policy = { desktopVersion: 'current', projects: [] };
  const ctx = { agents: { get: () => ownerAgent, currentInitiator: () => ownerAgent, turnBoundaryOf: () => ({ openTurnStartSeq: 0 }) }, sessionProjections: { stateOf: () => ({ openTurnStartSeq: 0 }) }, llm: { resolveModelInfo: async (provider, id) => ({ provider, id }) }, get: () => ({ request: async () => true }) };
  const service = createTicketRevisionService({ ctx, database: f.db, readPolicy: async () => policy });
  const input = { id: f.ticket.id, operation: 'revise', expectedInstructionRevision: 1, requestId: 'host', reason: '验收要求更新', acceptance: 'new checks' };
  for (const field of ['provider', 'model', 'providerId', 'modelId', 'workerModel']) {
    await assert.rejects(service.change({ ...input, [field]: 'override' }, { agent: ownerAgent }, { ownerAgent }), { code: 'MODEL_OVERRIDE_UNSUPPORTED' });
  }
  await assert.rejects(service.change(input, { agent: { id: 'other' } }, { ownerAgent }), /当前主人会话/);
  let approvals = 0;
  ctx.get = () => ({ request: async () => { approvals++; return false; } });
  policy.desktopVersion = 'changed';
  const changed = await service.change(input, { agent: ownerAgent }, { ownerAgent });
  assert.equal(changed.mandate.instruction, 'first');
  assert.equal(changed.mandate.policyVersion, 'current');
  assert.equal(approvals, 0);
  assert.deepEqual(f.db.assignments(f.ticket.id).at(-1).model, f.input.model);
});

test('a linked adjustment Ticket saves new work and delivers its Router reply while the original stays historical', async t => {
  const f = await fixture(t);
  const store = { orchestration: f.db, paths: { workspace: f.directory }, getConfig: async () => ({ models: [] }), connections: { read: () => ({ revision: 0, config: { enabled: false } }) }, documents: { read: async () => ({ hash: 'rules', content: '' }) } };
  const policy = await readAssessmentPolicy(store);
  f.db.commitResult(f.ticket.id, { result: { summary: 'historical', outcome: 'completed' }, uniqueKey: 'historical', instructionRevision: 1 });
  deliverCommitted(f.db);
  const adjustment = f.db.changeTicket(f.ticket.id, { ...f.input, operation: 'adjustment', mandate: { ...f.input.mandate, policyVersion: policy.desktopVersion }, validateMandate: m => m.policyVersion === policy.desktopVersion });
  let executions = 0, freshDelivery = false;
  const runtime = createOrchestrationRuntime({ ctx: {}, store,
    execute: async (assignment, { ticket }) => { executions++; assert.equal(assignment.instructionRevision, 1); assert.equal(ticket.adjustmentOfTicketId, f.ticket.id); assert.equal(ticket.mandate.policyVersion, policy.desktopVersion); return { summary: 'fresh', evidenceRefs: [], selfCheck: { summary: 'new checks completed', instructionRevision: 1 } }; },
    prepareTicketReply: async delivery => {
      assert.equal(delivery.payload.text, undefined);
      assert.equal(delivery.payload.publication, undefined);
      assert.equal(f.db.results(delivery.ticketId).at(-1).summary, 'fresh');
      return { status: 'ready', text: '调整后的工作已完成。' };
    },
    deliverDesktop: async delivery => { freshDelivery = true; assert.equal(delivery.payload.text, '调整后的工作已完成。'); assert.equal(delivery.payload.publication.origin, 'router'); assert.equal(delivery.payload.source.messageId, 'revision'); return { status: 'accepted', messageId: delivery.id }; },
  });
  t.after(() => runtime.stop());
  for (let i = 0; i < 40 && !freshDelivery; i++) { await runtime.tick(); await new Promise(resolve => setTimeout(resolve, 5)); }
  await runtime.stop();
  assert.equal(freshDelivery, true);
  assert.equal(executions, 1);
  assert.deepEqual(f.db.results(f.ticket.id).map(row => [row.summary, row.instructionRevision]), [['historical', 1]]);
  assert.deepEqual(f.db.results(adjustment.id).map(row => [row.summary, row.instructionRevision]), [['fresh', 1]]);
  assert.equal(f.db.getTicket(f.ticket.id).status, 'completed');
});

test('Feishu owner adjusts a completed subscribed Ticket through fresh Eval and preserves its original channel', async t => {
  const f = await fixture(t), db = f.db;
  const policy = { version: 'feishu-current', model: f.input.model, projects: [], connection: { enabled: true, appId: 'app', chatIds: ['chat'], ownerOpenIds: ['human'] } };
  const sourcePolicy = { version: policy.version, ownerIds: ['human'], threadIds: ['chat'] };
  const event = (key, text) => ({ sourceKey: key, threadId: 'feishu-thread', channel: 'feishu', kind: 'group', mentioned: true, actor: { kind: 'human', id: 'human' }, source: { channel: 'feishu', sourceType: 'group', connectionId: 'feishu', conversationId: 'chat', appId: 'app', chatId: 'chat', messageId: key }, text });
  const original = ingestAssistantEvent(db, event('initial', 'execute original'), sourcePolicy);
  let targetTicket;
  const runner = createAssessmentRunner({ database: db, readPolicy: async () => policy, authorize: authorizeAssessment,
    assess: async ({ candidates }) => candidates.map(row => targetTicket ? { candidateId: row.candidateId, outcome: 'adjustment', ticketId: targetTicket.id, expectedInstructionRevision: 1, reason: '主人要求重新执行' } : { candidateId: row.candidateId, outcome: 'accept', target: 'original task', acceptance: 'original check', reason: '主人明确要求' }) });
  t.after(() => runner.stop());
  await runner.tick();
  targetTicket = db.listTickets({ threadId: original.trigger.threadId })[0];
  db.commitResult(targetTicket.id, { uniqueKey: 'feishu-old', instructionRevision: 1, result: { summary: 'finished', outcome: 'completed' } });
  deliverCommitted(db);
  const reopened = ingestAssistantEvent(db, event('reopen-message', '重新执行刚才的工单'), sourcePolicy);
  assert.equal(reopened.requiresEval, true);
  assert.equal(reopened.delivery, null);
  await runner.tick();
  const current = db.listTickets().find(row => row.adjustmentOfTicketId === targetTicket.id);
  assert.equal(db.getTicket(targetTicket.id).status, 'completed');
  assert.equal(current.status, 'open');
  assert.equal(current.instructionRevision, 1);
  assert.equal(current.mandate.source.channel, 'feishu');
  assert.equal(current.mandate.source.messageId, 'reopen-message');
  assert.equal(db.getDecision(reopened.candidate.id).outcome, 'adjustment');
  assert.equal(db.results(targetTicket.id).length, 1);
  const repeated = ingestAssistantEvent(db, event('reopen-message', '重新执行刚才的工单'), sourcePolicy);
  await runner.tick();
  assert.equal(repeated.duplicate, true);
  assert.equal(repeated.delivery, null);
  assert.equal(db.assignments(targetTicket.id).length, 0);
  assert.equal(db.assignments(current.id).length, 1);
  assert.equal(db.ticketRevisions(targetTicket.id).length, 0);
  assert.equal(db.ticketRevisions(current.id).length, 1);
});
