import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { createAssistantScheduler } from '../src/scheduler.mjs';
import { createDesktopDelegationService } from '../src/desktop-delegation-service.mjs';
import { createGoalTickets } from '../src/goal-ticket-creation.mjs';
import { createAssistantRuntimeStore } from '../src/runtime-store.mjs';

for (const budgeted of [false, true]) test(`Ticket goal survives partial creation and restart without duplicate dispatch or changed retry (budget=${budgeted})`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-goal-tickets-'));
  const database = createAssistantOrchestrationStore({ directory });
  const store = { orchestration: database, paths: { database: join(directory, 'assistant.db') } };
  const runtimeDatabase = createAssistantRuntimeStore({ filename: store.paths.database });
  let aggregateFail = budgeted;
  const insertGoal = runtimeDatabase.insertGoal;
  runtimeDatabase.insertGoal = input => {
    if (aggregateFail && input.text === 'second') { aggregateFail = false; throw new Error('aggregate interrupted'); }
    return insertGoal(input);
  };
  let scheduler = createAssistantScheduler({ store, database: runtimeDatabase });
  t.after(async () => { await scheduler.dispose(); runtimeDatabase.close(); database.close(); await rm(directory, { recursive: true, force: true }); });
  const ownerAgent = { id: 'owner', status: 'running', session: { snapshotEvents: () => [{ type: 'turn/start' }, { type: 'user/message', data: { id: 'original', source: { kind: 'user' }, content: [{ type: 'text', text: 'complete work' }] } }] } };
  const ctx = { workspaceRegistry: { list: () => [{ id: 'project', path: directory }] }, llm: { resolveModelInfo: async (provider, id) => ({ provider, id }) } };
  ctx.agents = { get: () => ownerAgent, currentInitiator: () => ownerAgent, roots: () => [ownerAgent] };
  ctx.sessionProjections = { stateOf: () => ({ openTurnStartSeq: 0 }) };
  const service = createDesktopDelegationService({ ctx, database, readPolicy: async () => ({ desktopVersion: 'policy', projects: ctx.workspaceRegistry.list() }) });
  let calls = 0, fail = true;
  const delegation = { delegate: async (...args) => { calls++; if (fail && calls === 2) throw new Error('interrupted'); return service.delegate(...args); } };
  const child = { objective: 'leaf', projectId: 'project', provider: 'opaque', model: 'exact', text: 'work', ...(budgeted ? { acceptance: 'evidence' } : {}) };
  const goal = { requestId: 'root-request', ownerSessionId: 'owner', objective: 'root', ...(budgeted ? { budget: { requests: 1 } } : {}), children: [child, { ...child, text: 'second' }] };
  const create = input => createGoalTickets({ goal: input, ctx, ownerAgent, exec: { agent: ownerAgent, authorized: true }, threadId: 'main', delegation, scheduler, database });
  await assert.rejects(create({ ...goal, children: [{ ...child, requestId: goal.requestId }] }), /请求标识/);
  assert.equal(database.listTickets().length, 0, 'invalid tree cannot dispatch before validation');
  await assert.rejects(create(goal), /interrupted/);
  assert.equal(database.listTickets().length, 1);
  if (budgeted) {
    const first = database.listTickets()[0];
    assert.ok(database.ticketGoalBudget(first.id), 'first runnable Ticket already has its ancestor budget');
    assert.equal(database.reserveGoalRequest({ ticketId: first.id, requestId: 'first-request' }).allowed, true);
    await assert.rejects(create({ ...goal, budget: { requests: 2 } }), { code: 'IDEMPOTENCY_CONFLICT' });
  }
  await scheduler.dispose(); scheduler = createAssistantScheduler({ store, database: runtimeDatabase });
  fail = false;
  await assert.rejects(create({ ...goal, children: [...goal.children, { ...child }] }), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.equal(database.listTickets().length, 1);
  if (budgeted) {
    await assert.rejects(create(goal), /aggregate interrupted/);
    const partial = scheduler.matchGoalRequest(goal);
    assert.equal(partial.nextStep, 'building_children');
    assert.equal(partial.childGoalIds.length, 1);
    assert.throws(() => scheduler.updateGoalBudget(partial.id, { budget: { requests: 8 }, expectedVersion: 1 }), /创建尚未完成/);
    await scheduler.dispose(); scheduler = createAssistantScheduler({ store, database: runtimeDatabase });
  }
  const parent = await create(goal);
  assert.equal(database.listTickets().length, 2);
  if (!budgeted) {
    for (const ticket of database.listTickets()) assert.equal(ticket.acceptance, ticket.target, 'each legacy leaf uses its own full instruction, not the parent message');
    assert.equal(child.acceptance, undefined, 'normalization must not mutate submitted input');
  }
  assert.equal(parent.executionKind, 'ticket');
  assert.equal(parent.childGoalIds.length, 2);
  assert.equal((await create(goal)).id, parent.id);
  if (budgeted) {
    const second = database.listTickets().find(ticket => ticket.target === 'second');
    const rejected = database.reserveGoalRequest({ ticketId: second.id, requestId: 'second-request' });
    assert.equal(rejected.allowed, false);
    assert.equal(rejected.reason, 'requests');
    assert.equal(database.goalBudget(rejected.goalId).usage.requests, 1, 'retry creation does not reset shared usage');
    assert.equal(scheduler.getGoal(parent.id).budgetState.goalId, rejected.goalId);
    assert.equal(scheduler.getGoal(parent.id).budgetState.usage.requests, 1);
    scheduler.updateGoalBudget(parent.id, { expectedVersion: 1, budget: { requests: 3 } });
  }
  await scheduler.tick();
  assert.equal(scheduler.getGoal(parent.id).status, 'active');
  const paused = await scheduler.updateGoal(parent.id, { status: 'paused' });
  assert.equal(paused.status, 'paused');
  assert.ok(parent.childGoalIds.every(id => scheduler.getGoal(id).status === 'paused'));
  assert.throws(() => scheduler.updateGoal(parent.childGoalIds[0], { status: 'active' }), /parent Goal/);
  assert.deepEqual(database.claimAssignments('must-not-run', { validateMandate: () => true }), []);
  await scheduler.dispose(); scheduler = createAssistantScheduler({ store, database: runtimeDatabase });
  await scheduler.tick();
  assert.equal(scheduler.getGoal(parent.id).status, 'paused');
  assert.ok(parent.childGoalIds.every(id => scheduler.getGoal(id).status === 'paused'));
  await assert.rejects(scheduler.updateGoal(parent.id, { status: 'active' }, { rowVersion: paused.rowVersion - 1 }), { code: 'ROW_CONFLICT' });
  assert.equal((await scheduler.updateGoal(parent.id, { status: 'active' }, { rowVersion: paused.rowVersion })).status, 'active');
  assert.ok(database.listTickets().every(ticket => ticket.status === 'open'));

  for (const ticket of database.listTickets()) database.commitResult(ticket.id, { uniqueKey: `result:${ticket.id}`, result: { review: { verdict: 'passed' }, evidenceRefs: [{ sessionId: 'worker' }] } });
  assert.equal((await scheduler.advanceGoal(parent.id)).status, 'completed');
  assert.equal(database.listTickets().length, 2);
});

test('a changed Ticket cannot complete the original Goal even after passing its new review', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-goal-revision-'));
  const database = createAssistantOrchestrationStore({ directory });
  const store = { orchestration: database, paths: { database: join(directory, 'assistant.db') } };
  const runtimeDatabase = createAssistantRuntimeStore({ filename: store.paths.database });
  const scheduler = createAssistantScheduler({ store, database: runtimeDatabase });
  t.after(async () => { await scheduler.dispose(); runtimeDatabase.close(); database.close(); await rm(directory, { recursive: true, force: true }); });
  database.createThread({ id: 'thread', source: { type: 'desktop', id: 'owner' } });
  const ticket = database.createTicket({ threadId: 'thread', target: 'original work', acceptance: 'original acceptance', mandate: {
    actorId: 'desktop-owner', admission: 'desktop-approved-delegation', source: { channel: 'desktop', sessionId: 'owner' }, project: { id: 'project' },
  } });
  database.createAssignment(ticket.id, { model: { providerId: 'provider', modelId: 'exact' } });
  const goal = await scheduler.createGoal({ requestId: 'goal', ownerSessionId: 'owner', objective: 'original objective', projectId: 'project', provider: 'provider', model: 'exact', text: ticket.target, acceptance: ticket.acceptance }, { ticketId: ticket.id });
  assert.equal(goal.ticketRevisions[ticket.id], 1);
  database.updateTicket(ticket.id, { target: 'different work' }, { expectedInstructionRevision: 1 });
  database.commitResult(ticket.id, { instructionRevision: 2, uniqueKey: 'changed-result', result: { review: { verdict: 'passed' }, evidenceRefs: [{ sessionId: 'worker' }] } });
  const checked = await scheduler.advanceGoal(goal.id);
  assert.equal(checked.status, 'waiting');
  assert.equal(checked.waitReason, 'requirements');
  assert.equal(database.assignments(ticket.id).length, 1);
});

test('creation captures the full input before model validation and rejects invalid later leaves before dispatch', async () => {
  const ownerAgent = { id: 'owner' };
  const goal = { requestId: 'stable', objective: 'root', children: [
    { objective: 'one', projectId: 'project', provider: 'provider', model: 'exact', text: 'original' },
    { objective: 'two', projectId: 'project', provider: 'provider', model: 'exact', text: 'second' },
  ] };
  const dispatched = [];
  const scheduler = { matchGoalRequest: () => null, reserveGoalRequest: () => {}, createGoal: async value => value };
  const ctx = { workspaceRegistry: { list: () => [{ id: 'project' }] }, llm: { resolveModelInfo: async (provider, id) => {
    goal.children[0].text = 'changed during validation';
    goal.children[1].model = 'changed model';
    return { provider, id };
  } } };
  const delegation = { delegate: async input => { dispatched.push(input); return { id: `ticket-${dispatched.length}` }; } };
  const result = await createGoalTickets({ goal, ownerAgent, exec: { agent: ownerAgent }, scheduler, ctx, delegation });
  assert.deepEqual(dispatched.map(row => [row.text, row.model]), [['original', 'exact'], ['second', 'exact']]);
  assert.deepEqual(dispatched.map(row => row.acceptance), ['original', 'second']);
  assert.equal(result.children[0].text, 'original');
  assert.equal(result.children[0].acceptance, 'original');
  dispatched.length = 0;
  await assert.rejects(createGoalTickets({ goal: { ...goal, children: [goal.children[0], { ...goal.children[1], acceptance: 'x'.repeat(100001) }] }, ownerAgent, exec: { agent: ownerAgent }, scheduler, ctx, delegation }), /100000/);
  assert.equal(dispatched.length, 0);
});

test('cancellation persists before effects and resumes after restart without dispatch', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-goal-cancel-'));
  const database = createAssistantOrchestrationStore({ directory });
  const store = { orchestration: database, paths: { database: join(directory, 'assistant.db') } };
  const runtimeDatabase = createAssistantRuntimeStore({ filename: store.paths.database });
  let scheduler = createAssistantScheduler({ store, database: runtimeDatabase });
  t.after(async () => { await scheduler.dispose(); runtimeDatabase.close(); database.close(); await rm(directory, { recursive: true, force: true }); });
  database.createThread({ id: 'thread', source: { type: 'desktop', id: 'owner' } });
  const ticket = database.createTicket({ threadId: 'thread', target: 'work', acceptance: '', mandate: {
    actorId: 'desktop-owner', admission: 'desktop-approved-delegation', source: { channel: 'desktop', sessionId: 'owner' }, project: { id: 'project' },
  } });
  database.createAssignment(ticket.id, { model: { providerId: 'provider', modelId: 'exact' } });
  const goal = await scheduler.createGoal({ requestId: 'cancel', ownerSessionId: 'owner', objective: 'stop', projectId: 'project', provider: 'provider', model: 'exact', text: 'work' }, { ticketId: ticket.id });
  await assert.rejects(scheduler.cancelGoal(goal.id, { rowVersion: goal.rowVersion + 1 }), { code: 'ROW_CONFLICT' });
  assert.equal(database.getTicket(ticket.id).status, 'open');
  const [active] = database.claimAssignments('worker', { validateMandate: () => true });
  const original = database.cancelTicket;
  database.cancelTicket = () => { throw new Error('interrupted'); };
  await assert.rejects(scheduler.cancelGoal(goal.id), /interrupted/);
  assert.equal(scheduler.getGoal(goal.id).status, 'cancelling');
  assert.throws(() => scheduler.updateGoal(goal.id, { status: 'active' }), /正在停止/);
  await scheduler.dispose(); scheduler = createAssistantScheduler({ store, database: runtimeDatabase });
  database.cancelTicket = original;
  await scheduler.tick();
  assert.equal(scheduler.getGoal(goal.id).status, 'cancelling');
  assert.equal(database.getTicket(ticket.id).status, 'cancelling');
  await scheduler.dispose(); scheduler = createAssistantScheduler({ store, database: runtimeDatabase });
  await scheduler.tick();
  assert.equal(scheduler.getGoal(goal.id).status, 'cancelling');
  database.confirmExecutionStopped(active.id, active);
  await scheduler.tick();
  assert.equal(scheduler.getGoal(goal.id).status, 'cancelled');
  assert.equal(database.getTicket(ticket.id).status, 'cancelled');
  assert.equal(database.assignments(ticket.id)[0].state, 'cancelled');
  assert.equal((await scheduler.cancelGoal(goal.id)).status, 'cancelled');
});


