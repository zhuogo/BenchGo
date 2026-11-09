import test from 'node:test';
import assert from 'node:assert/strict';
import { executionApprovalOrigins, resolveExecutionApprovalOrigins } from '../src/execution-approval-origin.mjs';
import { executionApprovalResponse } from '../client/execution-approval.mjs';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';

const policy = { desktopVersion: 'desktop-v1', version: 'channel-v1' };
const mandate = (threadId = 'main', sessionId = 'router-main') => ({ policyVersion: policy.desktopVersion,
  source: { channel: 'desktop', sessionId, threadId, messageId: 'explicit-human' }, actorId: 'desktop-owner',
  admission: 'desktop-approved-delegation', controlledActions: 'require-current-policy-and-harness-approval' });
const main = { threadId: 'main', sessionIds: ['router-main'] };
function fixture() {
  const ticket = { id: 'ticket', title: '发送已备齐正文', status: 'open', mandate: mandate() };
  const assignment = { id: 'assignment', ticketId: ticket.id, owner: 'worker', fence: 3, state: 'claimed', leaseUntil: 200 };
  const run = { id: 'run', sessionId: 'worker-session', owner: 'worker', fence: 3, state: 'running' };
  const database = { listTickets: () => [ticket], assignments: () => [assignment], runs: () => [run], getTicket: () => ticket };
  const origins = (extra = {}) => executionApprovalOrigins({ database, ownerScope: main, ownerSessionId: 'router-main', policy, now: 100, ...extra });
  return { ticket, assignment, run, database, origins };
}

test('approval origin comes only from the owned active Worker, including its original call session', () => {
  const f = fixture();
  assert.deepEqual(f.origins(), [{ ticketId: 'ticket', title: '发送已备齐正文', assignmentId: 'assignment', runId: 'run',
    sessionId: 'worker-session', ownerSessionId: 'router-main', ownerThreadId: 'main' }]);
  for (const extra of [{ ownerScope: undefined }, { ownerScope: { threadId: 'side', sessionIds: ['router-main'] } },
    { ownerScope: { threadId: 'main', sessionIds: ['router-side'] } }, { ownerSessionId: 'forged-router' }]) assert.deepEqual(f.origins(extra), []);
  f.ticket.mandate = mandate('side', 'router-side');
  assert.deepEqual(f.origins(), []);
  assert.equal(f.origins({ ownerScope: { threadId: 'side', sessionIds: ['router-side'] }, ownerSessionId: 'router-side' }).length, 1);
});

test('inactive tickets, expired leases, stale fences and policy/tool revocation remove presentation links', () => {
  for (const change of [f => { f.ticket.status = 'cancelled'; }, f => { f.ticket.status = 'paused'; },
    f => { f.ticket.status = 'completed'; }, f => { f.ticket.status = 'failed'; },
    f => { f.assignment.state = 'uncertain'; }, f => { f.assignment.leaseUntil = 100; },
    f => { f.assignment.leaseUntil = undefined; }, f => { f.assignment.leaseUntil = NaN; },
    f => { f.run.fence++; }, f => { f.run.owner = 'another-worker'; }, f => { f.run.state = 'cancelled'; },
    f => { f.ticket.mandate.policyVersion = 'revoked-version'; }, f => { f.ticket.mandate.toolScope = ['read']; },
    f => { f.database.appliedTicketSnapshot = () => ({ mandate: { ...mandate(), policyVersion: 'old-version' } }); }]) {
    const f = fixture(); change(f); assert.deepEqual(f.origins(), []);
  }
});

test('profile-scoped owner API rejects remote principals, archived threads and stale Router sessions', async () => {
  const f = fixture(), state = { mainSessionId: 'router-main', threads: [{ id: 'side', sessionId: 'router-side', archived: true }] };
  const dependencies = { store: { getState: async () => state, orchestration: f.database },
    engine: { ticketOwnerScope: async () => main }, readPolicy: async () => policy, peer: { principal: { kind: 'owner' } },
    input: { ownerSessionId: 'router-main' } };
  // Real leases use wall time; this fixture's lease remains current for this API call.
  f.assignment.leaseUntil = Date.now() + 60000;
  assert.equal((await resolveExecutionApprovalOrigins(dependencies)).origins.length, 1);
  for (const peer of [null, { principal: { kind: 'machine' } }]) await assert.rejects(resolveExecutionApprovalOrigins({ ...dependencies, peer }), { status: 403 });
  for (const input of [{ ownerSessionId: 'old-router' }, { threadId: 'side', ownerSessionId: 'router-side' },
    { threadId: 'unknown', ownerSessionId: 'router-main' }]) assert.deepEqual(await resolveExecutionApprovalOrigins({ ...dependencies, input }), { origins: [] });
});

test('real claimed assignment and official-run identity project without another approval store', t => {
  const database = createAssistantOrchestrationStore({ filename: ':memory:' });
  t.after(() => database.close());
  database.createThread({ id: 'thread', source: { type: 'desktop', id: 'thread' } });
  const ticket = database.createTicket({ threadId: 'thread', title: 'send', target: 'send exact body', mandate: mandate() });
  database.createAssignment(ticket.id, { executor: 'harness' });
  const [assignment] = database.claimAssignments('worker', { validateMandate: () => true });
  const run = database.prepareRun(assignment.id, { owner: assignment.owner, fence: assignment.fence, sessionId: 'actual-worker', directory: 'workspace' });
  database.updateRun(run.id, { owner: assignment.owner, fence: assignment.fence, state: 'submitted' });
  const origins = executionApprovalOrigins({ database, ownerScope: main, ownerSessionId: 'router-main', policy });
  assert.equal(origins.length, 1); assert.equal(origins[0].runId, run.id); assert.equal(origins[0].sessionId, 'actual-worker');
});

test('one approval click answers the same pending only once and never grants always', async () => {
  const origin = fixture().origins()[0], answers = [];
  let release;
  const read = new Promise(resolve => { release = resolve; });
  const pending = { answerable: true, answer: async outcome => { answers.push(outcome); pending.answerable = false; } };
  const response = executionApprovalResponse({ origin, pending, readOrigins: () => read });
  const first = response.answer('allowed-once');
  await assert.rejects(response.answer('allowed-once'), /正在提交/);
  release([origin]); await first;
  assert.deepEqual(answers, ['allowed-once']); assert.equal(response.canAnswer(), false);
  await assert.rejects(response.answer('allowed-always'), /只允许本次/);
});

test('late decisions after stop, source switch, revocation or run replacement cannot settle original approval', async () => {
  const origin = fixture().origins()[0];
  for (const change of [() => [], () => [{ ...origin, runId: 'replacement' }], () => [{ ...origin, ownerThreadId: 'side' }]]) {
    let answered = false;
    const pending = { answerable: true, answer: async () => { answered = true; } };
    const response = executionApprovalResponse({ pending, origin, readOrigins: async () => change() });
    await assert.rejects(response.answer('allowed-once'), /已停止/); assert.equal(answered, false);
  }
  let current = true, answered = false;
  const pending = { answerable: true, answer: async () => { answered = true; } };
  const response = executionApprovalResponse({ pending, origin, isCurrent: () => current, readOrigins: async () => { current = false; return [origin]; } });
  await assert.rejects(response.answer('rejected'), /已停止/); assert.equal(answered, false);
  const aborted = executionApprovalResponse({ pending, origin, readOrigins: async () => { pending.answerable = false; return [origin]; } });
  await assert.rejects(aborted.answer('allowed-once'), /已停止/); assert.equal(answered, false);
});

test('transient read failure allows retry; rejection uses the original pending without publishing another request', async () => {
  const origin = fixture().origins()[0], answers = []; let reads = 0;
  const pending = { answerable: true, answer: async value => { answers.push(value); pending.answerable = false; } };
  const response = executionApprovalResponse({ pending, origin, readOrigins: async () => { if (++reads === 1) throw new Error('offline'); return [origin]; } });
  await assert.rejects(response.answer('rejected'), /offline/); assert.equal(response.canAnswer(), true);
  await response.answer('rejected'); assert.deepEqual(answers, ['rejected']);
});
