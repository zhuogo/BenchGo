import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { createTicketRevisionService } from '../src/ticket-revision-service.mjs';
import { createOrchestrationRuntime } from '../src/orchestration-runtime.mjs';
import { readAssessmentPolicy, authorizeAssessment } from '../src/assessment-policy.mjs';
import { createAssessmentRunner } from '../src/assessment-runner.mjs';
import { ingestAssistantEvent } from '../src/intake.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ticket-revision-'));
  let db = createAssistantOrchestrationStore({ directory });
  t.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  const source = { channel: 'desktop', sessionId: 'owner', messageId: 'first', threadId: 'main' };
  const mandate = { actorId: 'desktop-owner', source, instruction: 'first', policyVersion: 'obsolete', admission: 'desktop-approved-delegation', controlledActions: 'require-current-policy-and-harness-approval' };
  const { trigger } = db.ingest({ dedupeKey: 'first', thread: { id: 'desktop:owner', source: { type: 'desktop', id: 'owner' } }, source, actor: { kind: 'human', id: 'desktop-owner' }, content: 'first', mode: 'direct' });
  const ticket = db.createTicket({ threadId: trigger.threadId, target: 'original target', acceptance: 'old checks', mandate });
  db.createAssignment(ticket.id, { model: { providerId: 'Opaque/P', modelId: 'Exact:M' }, text: ticket.target });
  const nextSource = { ...source, messageId: 'revision' };
  const next = db.ingest({ dedupeKey: 'revision', thread: { id: trigger.threadId, source: { type: 'desktop', id: 'owner' } }, source: nextSource, actor: { kind: 'human', id: 'desktop-owner' }, content: 'new request', mode: 'direct' });
  const input = { operation: 'revise', expectedInstructionRevision: 1, target: 'new target', acceptance: 'new checks', reason: 'correct requirements', requestKey: 'revision', mandate: { ...mandate, source: nextSource, instruction: 'new request', policyVersion: 'current' }, triggerId: next.trigger.id, model: { providerId: 'Opaque/P', modelId: 'Exact:M' }, validateMandate: m => m.policyVersion === 'current' };
  return { directory, get db() { return db; }, ticket, input, reopen() { db.close(); db = createAssistantOrchestrationStore({ directory }); } };
}

test('requirements change keeps immutable history, a fresh execution and CAS across database reopen', async t => {
  const f = await fixture(t), old = f.db.assignments(f.ticket.id)[0];
  const changed = f.db.changeTicket(f.ticket.id, f.input);
  assert.equal(changed.instructionRevision, 2);
  assert.equal(changed.mandate.policyVersion, 'current');
  assert.equal(f.db.getAssignment(old.id).state, 'cancelled');
  const next = f.db.assignments(f.ticket.id).find(row => row.id !== old.id);
  assert.equal(next.instructionRevision, 2);
  assert.equal(next.state, 'queued');
  assert.equal(next.pauseContinuation, undefined);
  assert.deepEqual(f.db.ticketRevisions(f.ticket.id).map(row => row.mandate.policyVersion), ['obsolete', 'current']);
  f.reopen();
  assert.equal(f.db.changeTicket(f.ticket.id, f.input).instructionRevision, 2);
  assert.equal(f.db.assignments(f.ticket.id).length, 2);
  assert.throws(() => f.db.changeTicket(f.ticket.id, { ...f.input, requestKey: 'stale' }), { code: 'INSTRUCTION_REVISION_CONFLICT' });
  assert.throws(() => f.db.changeTicket(f.ticket.id, { ...f.input, target: 'different' }), { code: 'IDEMPOTENCY_CONFLICT' });
  const claimed = f.db.claimAssignments('worker', { validateMandate: m => m.policyVersion === 'current' });
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].id, next.id);
  assert.equal(f.db.renewAssignment(next.id, { owner: 'worker', fence: claimed[0].fence, leaseMs: 60000, validateMandate: m => m.policyVersion === 'current' }).allowed, true);
});

test('completed work creates an idempotent linked adjustment and never changes its prior result', async t => {
  const f = await fixture(t);
  f.db.commitResult(f.ticket.id, { result: { summary: 'old result' }, uniqueKey: 'old-result', instructionRevision: 1 });
  const before = f.db.getTicket(f.ticket.id), results = f.db.results(f.ticket.id);
  assert.throws(() => f.db.changeTicket(f.ticket.id, { ...f.input, operation: 'reopen', validateMandate: () => false }), { code: 'MANDATE_REVOKED' });
  const next = f.db.changeTicket(f.ticket.id, { ...f.input, operation: 'reopen' });
  assert.notEqual(next.id, before.id);
  assert.equal(next.adjustmentOfTicketId, before.id);
  assert.equal(next.instructionRevision, 1);
  assert.equal(next.resultVersion, 0);
  assert.deepEqual(f.db.getTicket(f.ticket.id), before);
  assert.deepEqual(f.db.results(f.ticket.id), results);
  assert.equal(f.db.assignments(next.id)[0].sourceResultVersion, before.resultVersion);
  f.reopen();
  assert.equal(f.db.changeTicket(f.ticket.id, { ...f.input, operation: 'reopen' }).id, next.id);
  assert.throws(() => f.db.changeTicket(f.ticket.id, { ...f.input, operation: 'adjustment', requestKey: 'duplicate-adjustment' }), { code: 'TRIGGER_ALREADY_ASSIGNED' });
});

test('live or uncertain executions and forged authorization cannot be revised', async t => {
  const f = await fixture(t);
  assert.throws(() => f.db.changeTicket(f.ticket.id, { ...f.input, mandate: { ...f.input.mandate, actorId: 'imposter' } }), { code: 'MANDATE_REVOKED' });
  const [claimed] = f.db.claimAssignments('worker', { validateMandate: () => true });
  assert.throws(() => f.db.changeTicket(f.ticket.id, f.input), { code: 'EXECUTION_PENDING' });
  f.db.renewAssignment(claimed.id, { owner: 'worker', fence: claimed.fence, leaseMs: 60000, validateMandate: () => false });
  assert.throws(() => f.db.changeTicket(f.ticket.id, f.input), { code: 'EXECUTION_PENDING' });
  assert.equal(f.db.ticketRevisions(f.ticket.id).length, 0);
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

test('host revision uses exact model, current root instruction and revalidates authority after approval', async t => {
  const f = await fixture(t);
  const events = [{ type: 'turn/start' }, { type: 'user/message', data: { id: 'new-owner-message', source: { kind: 'user' }, content: [{ type: 'text', text: '请修改验收条件' }] } }];
  const ownerAgent = { id: 'owner', status: 'running', session: { header: {}, snapshotEvents: () => events } };
  const policy = { desktopVersion: 'current', projects: [] };
  const ctx = { agents: { get: () => ownerAgent, currentInitiator: () => ownerAgent, turnBoundaryOf: () => ({ openTurnStartSeq: 0 }) }, sessionProjections: { stateOf: () => ({ openTurnStartSeq: 0 }) }, llm: { resolveModelInfo: async (provider, id) => ({ provider, id }) }, get: () => ({ request: async () => true }) };
  const service = createTicketRevisionService({ ctx, database: f.db, readPolicy: async () => policy });
  const input = { id: f.ticket.id, operation: 'revise', expectedInstructionRevision: 1, requestId: 'host', reason: '验收要求更新', acceptance: 'new checks' };
  await assert.rejects(service.change(input, { agent: { id: 'other' } }, { ownerAgent }), /当前主人会话/);
  ctx.get = () => ({ request: async () => { policy.desktopVersion = 'changed'; return true; } });
  await assert.rejects(service.change(input, { agent: ownerAgent }, { ownerAgent }), /授权规则已变化/);
  ctx.get = () => ({ request: async () => true });
  const changed = await service.change(input, { agent: ownerAgent }, { ownerAgent });
  assert.equal(changed.mandate.instruction, '请修改验收条件');
  assert.equal(changed.mandate.policyVersion, 'changed');
  assert.deepEqual(f.db.assignments(f.ticket.id).at(-1).model, f.input.model);
});

test('a reopened Ticket executes, reviews and delivers the fresh revision while its revoked original stays historical', async t => {
  const f = await fixture(t);
  const store = { orchestration: f.db, paths: { workspace: f.directory }, getConfig: async () => ({ models: [] }), connections: { read: () => ({ revision: 0, config: { enabled: false } }) }, documents: { read: async () => ({ hash: 'rules', content: '' }) } };
  const policy = await readAssessmentPolicy(store);
  f.db.commitResult(f.ticket.id, { result: { summary: 'historical' }, uniqueKey: 'historical', instructionRevision: 1 });
  const adjustment = f.db.changeTicket(f.ticket.id, { ...f.input, operation: 'reopen', mandate: { ...f.input.mandate, policyVersion: policy.desktopVersion }, validateMandate: m => m.policyVersion === policy.desktopVersion });
  let executions = 0, freshDelivery = false;
  const runtime = createOrchestrationRuntime({ ctx: {}, store,
    execute: async (assignment, { ticket }) => { executions++; assert.equal(assignment.instructionRevision, 1); assert.equal(ticket.adjustmentOfTicketId, f.ticket.id); assert.equal(ticket.mandate.policyVersion, policy.desktopVersion); return { summary: 'fresh', evidenceRefs: [] }; },
    review: async ({ ticket }) => { assert.equal(ticket.acceptance, 'new checks'); return { verdict: 'passed', reason: 'new requirements verified', delivery: { action: 'deliver', text: 'fresh revision verified' } }; },
    deliverDesktop: async delivery => { if (delivery.payload.text?.includes('fresh')) { freshDelivery = true; assert.equal(delivery.payload.source.messageId, 'revision'); } return { status: 'accepted', messageId: delivery.id }; },
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

test('Feishu owner reopens a completed subscribed Ticket through fresh Eval and preserves its original channel', async t => {
  const f = await fixture(t), db = f.db;
  const policy = { version: 'feishu-current', model: f.input.model, projects: [], connection: { enabled: true, appId: 'app', chatIds: ['chat'], ownerOpenIds: ['human'] } };
  const sourcePolicy = { version: policy.version, ownerIds: ['human'], threadIds: ['chat'] };
  const event = (key, text) => ({ sourceKey: key, threadId: 'feishu-thread', channel: 'feishu', kind: 'group', mentioned: true, actor: { kind: 'human', id: 'human' }, source: { channel: 'feishu', appId: 'app', chatId: 'chat', messageId: key }, text });
  const original = ingestAssistantEvent(db, event('initial', 'execute original'), sourcePolicy);
  let targetTicket;
  const runner = createAssessmentRunner({ database: db, readPolicy: async () => policy, authorize: authorizeAssessment,
    assess: async ({ candidates }) => candidates.map(row => targetTicket ? { candidateId: row.candidateId, outcome: 'reopen', ticketId: targetTicket.id, expectedInstructionRevision: 1, reason: '主人要求重新执行' } : { candidateId: row.candidateId, outcome: 'accept', target: 'original task', acceptance: 'original check', reason: '主人明确要求' }) });
  t.after(() => runner.stop());
  await runner.tick();
  targetTicket = db.listTickets({ threadId: original.trigger.threadId })[0];
  db.commitResult(targetTicket.id, { uniqueKey: 'feishu-old', instructionRevision: 1, result: { summary: 'finished' } });
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
  assert.equal(db.getDecision(reopened.candidate.id).outcome, 'reopen');
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
