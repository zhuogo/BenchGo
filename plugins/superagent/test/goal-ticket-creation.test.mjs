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
import { commitWorkerResult } from '../src/result-commit.mjs';

function commitAndDeliver(database, ticket) {
  const saved = commitWorkerResult({ database, ticket, uniqueKey: `result:${ticket.id}`, result: {
    outcome: 'completed', summary: '原文结果', selfCheck: { summary: '已检查当前要求和执行结果' }, evidenceRefs: [],
  } });
  const delivery = database.claimOutbox('goal-test').find(row => row.id === saved.outbox.id);
  assert.ok(delivery);
  database.saveOutboxReply(delivery.id, { owner: 'goal-test',
    publication: { action: 'deliver', origin: 'router', text: '这部分工作已经完成。' } });
  database.finishOutbox(delivery.id, { owner: 'goal-test', sent: true, receipt: { status: 'accepted', messageId: `sent:${ticket.id}` } });
}

for (const budgeted of [false, true]) test(`Ticket goal survives partial creation and restart without duplicate dispatch or changed retry (aggregateInterrupted=${budgeted})`, async t => {
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
  const ownerAgent = { id: 'owner', status: 'running', session: { header: {}, snapshotEvents: () => [{ type: 'turn/start' }, { type: 'user/message', data: { id: 'original', source: { kind: 'user' }, content: [{ type: 'text', text: 'complete work' }] } }] } };
  const ctx = { workspaceRegistry: { list: () => [{ id: 'project', path: directory }] }, llm: { resolveModelInfo: async (provider, id) => ({ provider, id }) } };
  ctx.agents = { get: () => ownerAgent, currentInitiator: () => ownerAgent, turnBoundaryOf: () => ({ openTurnStartSeq: 0 }) };
  const service = createDesktopDelegationService({ ctx, database, readPolicy: async () => ({ desktopVersion: 'policy', workerModels: [{ providerId: 'opaque', modelId: 'exact' }], projects: ctx.workspaceRegistry.list() }),
    assessScope: async () => ({ decision: { outcome: 'delegate', reason: 'Fixture confirms the Goal leaf scope' }, routing: null }) });
  let calls = 0, fail = true;
  const delegation = { delegate: async (...args) => { calls++; if (fail && calls === 2) throw new Error('interrupted'); return service.delegate(...args); } };
  const child = { objective: 'leaf', projectId: 'project', text: 'work', ...(budgeted ? { acceptance: 'evidence' } : {}) };
  const goal = { requestId: 'root-request', ownerSessionId: 'owner', objective: 'root', children: [child, { ...child, text: 'second' }] };
  const create = input => createGoalTickets({ goal: input, ctx, ownerAgent, exec: { agent: ownerAgent, authorized: true }, threadId: 'main', delegation, scheduler, database });
  for (const key of ['provider', 'model', 'providerId', 'modelId', 'workerModel']) {
    await assert.rejects(create({ ...goal, children: [{ ...child, [key]: 'override' }] }), { code: 'MODEL_OVERRIDE_UNSUPPORTED' });
    await assert.rejects(scheduler.createGoal({ ...goal, [key]: 'override' }, {}), { code: 'MODEL_OVERRIDE_UNSUPPORTED' });
  }
  await assert.rejects(create({ ...goal, children: [{ ...child, requestId: goal.requestId }] }), /请求标识/);
  await assert.rejects(create({ ...goal, budget: { requests: 1 } }), /目标预算已移除/);
  assert.equal(database.listTickets().length, 0, 'invalid tree cannot dispatch before validation');
  await assert.rejects(create(goal), /interrupted/);
  assert.equal(database.listTickets().length, 1);
  if (budgeted) {
    const first = database.listTickets()[0];
    assert.ok(database.ticketGoalBudget(first.id), 'first runnable Ticket already has its ancestor usage ledger');
    assert.equal(database.reserveGoalRequest({ ticketId: first.id, requestId: 'first-request' }).allowed, true);
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
    await scheduler.dispose(); scheduler = createAssistantScheduler({ store, database: runtimeDatabase });
  }
  const parent = await create(goal);
  assert.equal(database.listTickets().length, 2);
  // Each Goal leaf is its own Trigger over the same original instruction; one Trigger still opens one Ticket.
  const sources = database.listTickets().map(ticket => ticket.mandate.source);
  assert.equal(new Set(sources.map(source => source.messageId)).size, 2);
  assert.ok(sources.every(source => /#goal:root:\d$/.test(source.messageId)));
  assert.equal(new Set(database.listTickets().map(ticket => ticket.mandate.instruction)).size, 1);
  if (!budgeted) {
    for (const ticket of database.listTickets()) assert.equal(ticket.acceptance, ticket.target, 'each legacy leaf uses its own full instruction, not the parent message');
    assert.equal(child.acceptance, undefined, 'normalization must not mutate submitted input');
  }
  assert.equal(parent.executionKind, 'ticket');
  assert.equal(parent.childGoalIds.length, 2);
  assert.deepEqual(scheduler.getGoal(parent.childGoalIds[0]).workerModel, { providerId: 'opaque', modelId: 'exact' });
  assert.equal((await create(goal)).id, parent.id);
  if (budgeted) {
    const second = database.listTickets().find(ticket => ticket.target === 'second');
    assert.equal(database.reserveGoalRequest({ ticketId: second.id, requestId: 'second-request' }).allowed, true, 'shared usage never refuses a request');
    const ledger = scheduler.getGoal(parent.id).budgetState;
    assert.equal(ledger.usage.requests, 2, 'retry creation does not reset shared usage');
  }
  await scheduler.tick();
  assert.equal(scheduler.getGoal(parent.id).status, 'waiting');
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
  assert.ok(database.listTickets().every(ticket => ticket.status === 'waiting'));

  for (const ticket of database.listTickets()) commitWorkerResult({ database, ticket, uniqueKey: `result:${ticket.id}`, result: {
    outcome: 'completed', summary: '原文结果', selfCheck: { summary: '已检查当前要求和执行结果' }, evidenceRefs: [],
  } });
  assert.equal((await scheduler.advanceGoal(parent.id)).status, 'waiting', 'result persistence alone cannot complete a Goal');
  const deliveries = database.claimOutbox('goal-test');
  for (const delivery of deliveries) {
    assert.equal(delivery.payload.text, undefined);
    assert.equal(delivery.payload.publication, undefined);
    database.saveOutboxReply(delivery.id, { owner: 'goal-test',
      publication: { action: 'deliver', origin: 'router', text: '这部分工作已经完成。' } });
  }
  assert.equal((await scheduler.advanceGoal(parent.id)).status, 'waiting', 'a persisted Router draft still needs its source receipt');
  for (const delivery of deliveries) database.finishOutbox(delivery.id, { owner: 'goal-test', sent: true,
    receipt: { status: 'accepted', messageId: `sent:${delivery.ticketId}` } });
  assert.equal((await scheduler.advanceGoal(parent.id)).status, 'completed');
  assert.equal(database.listTickets().length, 2);
});

test('a changed Ticket cannot complete the original Goal even after delivering its new result', async t => {
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
  const goal = await scheduler.createGoal({ requestId: 'goal', ownerSessionId: 'owner', objective: 'original objective', projectId: 'project', text: ticket.target, acceptance: ticket.acceptance }, { ticketId: ticket.id });
  assert.equal(goal.ticketRevisions[ticket.id], 1);
  database.updateTicket(ticket.id, { target: 'different work' }, { expectedInstructionRevision: 1 });
  commitAndDeliver(database, database.getTicket(ticket.id));
  const checked = await scheduler.advanceGoal(goal.id);
  assert.equal(checked.status, 'waiting');
  assert.equal(checked.waitReason, 'requirements');
  assert.equal(database.assignments(ticket.id).length, 1);
});

test('creation captures the full input before delegation and rejects invalid later leaves before dispatch', async () => {
  const ownerAgent = { id: 'owner' };
  const goal = { requestId: 'stable', objective: 'root', children: [
    { objective: 'one', projectId: 'project', text: 'original' },
    { objective: 'two', projectId: 'project', text: 'second' },
  ] };
  const dispatched = [];
  const scheduler = { matchGoalRequest: () => null, reserveGoalRequest: () => {}, createGoal: async value => value };
  const ctx = { workspaceRegistry: { list: () => [{ id: 'project' }] } };
  const delegation = { delegate: async input => { goal.children[0].text = 'changed during delegation'; dispatched.push(input); return { id: `ticket-${dispatched.length}` }; } };
  const result = await createGoalTickets({ goal, ownerAgent, exec: { agent: ownerAgent }, scheduler, ctx, delegation });
  assert.deepEqual(dispatched.map(row => [row.text, row.model]), [['original', undefined], ['second', undefined]]);
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
  const goal = await scheduler.createGoal({ requestId: 'cancel', ownerSessionId: 'owner', objective: 'stop', projectId: 'project', text: 'work' }, { ticketId: ticket.id });
  await assert.rejects(scheduler.cancelGoal(goal.id, { rowVersion: goal.rowVersion + 1 }), { code: 'ROW_CONFLICT' });
  assert.equal(database.getTicket(ticket.id).status, 'waiting');
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
  assert.equal(database.getTicket(ticket.id).status, 'waiting');
  assert.equal(database.getTicket(ticket.id).executionControl.stopRequested, true);
  await scheduler.dispose(); scheduler = createAssistantScheduler({ store, database: runtimeDatabase });
  await scheduler.tick();
  assert.equal(scheduler.getGoal(goal.id).status, 'cancelling');
  database.confirmExecutionStopped(active.id, active);
  await scheduler.tick();
  assert.equal(scheduler.getGoal(goal.id).status, 'cancelled');
  assert.equal(database.getTicket(ticket.id).status, 'waiting');
  assert.equal(database.getTicket(ticket.id).executionControl.stopped, true);
  assert.equal(database.assignments(ticket.id)[0].state, 'cancelled');
  assert.equal((await scheduler.cancelGoal(goal.id)).status, 'cancelled');
});


