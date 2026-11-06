import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { createModelActionTicketExecutor } from '../src/model-action-ticket.mjs';

test('model persistent action is fenced, committed once and idempotent by callId', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'superagent-model-action-'));
  const database = createAssistantOrchestrationStore({ directory });
  t.after(() => { database.close(); return rm(directory, { recursive: true, force: true }); });
  const message = { id: 'message-1', source: { kind: 'user' }, content: [{ type: 'text', text: '记住这个配置' }] };
  const ownerAgent = { id: 'router-session', status: 'running', session: { header: {}, snapshotEvents: () => [{ type: 'turn/start', seq: 0 }, { type: 'user/message', seq: 1, data: message }] } }, calls = [];
  const ctx = { agents: { get: id => id === ownerAgent.id ? ownerAgent : undefined, currentInitiator: () => ownerAgent, turnBoundaryOf: () => ({ openTurnStartSeq: 0 }) },
    get: name => name === 'approval' ? { request: async () => true } : undefined };
  const executor = createModelActionTicketExecutor({
    ctx, database, workspace: directory, readPolicy: async () => ({ desktopVersion: 'desktop-v1' }),
    perform: async ({ name, args, run }) => { calls.push({ name, args, run }); return { revision: 3, value: args.value }; },
    verify: async ({ result }) => ({ verified: true, evidence: { kind: 'config-revision', revision: result.revision } }),
  });
  const input = { name: 'assistant_config', args: { value: 'one' }, ownerAgent, threadId: 'main', exec: { agent: ownerAgent, callId: 'call-1', signal: new AbortController().signal } };
  const first = await executor.execute(input);
  const second = await executor.execute(input);
  assert.deepEqual(second, first);
  assert.equal(calls.length, 1);
  const ticket = database.listTickets()[0], assignment = database.assignments(ticket.id)[0], run = database.runs(assignment.id)[0];
  assert.equal(ticket.status, 'completed');
  assert.equal(assignment.state, 'completed');
  assert.equal(run.state, 'completed');
  assert.equal(database.results(ticket.id).length, 1);
  assert.deepEqual(run.evidence.readback, { kind: 'config-revision', revision: 3 });
});

test('same callId with different arguments is rejected without a second action', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'superagent-model-action-conflict-'));
  const database = createAssistantOrchestrationStore({ directory });
  t.after(() => { database.close(); return rm(directory, { recursive: true, force: true }); });
  const message = { id: 'message-1', source: { kind: 'user' }, content: [{ type: 'text', text: '请保存' }] };
  const ownerAgent = { id: 'router-session', status: 'running', session: { header: {}, snapshotEvents: () => [{ type: 'turn/start', seq: 0 }, { type: 'user/message', seq: 1, data: message }] } };
  const ctx = { agents: { get: id => id === ownerAgent.id ? ownerAgent : undefined, currentInitiator: () => ownerAgent, turnBoundaryOf: () => ({ openTurnStartSeq: 0 }) }, get: name => name === 'approval' ? { request: async () => true } : undefined };
  const executor = createModelActionTicketExecutor({ ctx, database, workspace: directory, readPolicy: async () => ({ desktopVersion: 'desktop-v1' }), perform: async ({ args }) => args, verify: async () => ({ verified: true, evidence: { kind: 'config' } }) });
  const base = { name: 'assistant_config', ownerAgent, threadId: 'main', exec: { agent: ownerAgent, callId: 'call-1', signal: new AbortController().signal } };
  await executor.execute({ ...base, args: { content: 'one' } });
  await assert.rejects(executor.execute({ ...base, args: { content: 'two' } }), /identity conflict/);
  await assert.rejects(executor.execute({ ...base, name: 'assistant_profile', args: { content: 'one' } }), /identity conflict/);
});

test('approval denial and changed root instruction reserve no Ticket or execute no action', async t => {
  const database = createAssistantOrchestrationStore({ filename: ':memory:' });
  t.after(() => database.close());
  const message = { id: 'message-1', source: { kind: 'user' }, content: [{ type: 'text', text: '请记住' }] };
  const ownerAgent = { id: 'router-session', status: 'running', session: { header: {}, snapshotEvents: () => [{ type: 'turn/start', seq: 0 }, { type: 'user/message', seq: 1, data: message }] } };
  let approve = async () => true, calls = 0, approvalCalls = 0;
  const ctx = { agents: { get: id => id === ownerAgent.id ? ownerAgent : undefined, currentInitiator: () => ownerAgent, turnBoundaryOf: () => ({ openTurnStartSeq: 0 }) }, get: name => name === 'approval' ? { request: (...args) => { approvalCalls++; return approve(...args); } } : undefined };
  const executor = createModelActionTicketExecutor({ ctx, database, readPolicy: async () => ({ desktopVersion: 'desktop-v1' }), perform: async () => { calls++; return { id: 'm1' }; }, verify: async () => ({ verified: true, evidence: { kind: 'config', revision: 1 } }) });
  const input = { name: 'assistant_config', args: { content: 'fact' }, ownerAgent, exec: { agent: ownerAgent, callId: 'deny', authorized: true, signal: new AbortController().signal } };
  approve = async () => false;
  await assert.rejects(executor.execute(input), { code: 'MODEL_ACTION_DENIED' });
  assert.equal(approvalCalls, 1, 'Harness generic authorization does not skip action-specific approval');
  assert.equal(database.listTickets().length, 0);
  approve = async () => { message.id = 'changed'; return true; };
  await assert.rejects(executor.execute({ ...input, exec: { ...input.exec, callId: 'changed' } }), { code: 'MODEL_ACTION_INSTRUCTION_CHANGED' });
  assert.equal(calls, 0);
  assert.equal(database.listTickets().length, 0);
});

test('arguments are frozen before dispatch and failed readback becomes non-replayable uncertain', async t => {
  const database = createAssistantOrchestrationStore({ filename: ':memory:' });
  t.after(() => database.close());
  const message = { id: 'message-1', source: { kind: 'user' }, content: [{ type: 'text', text: '请修改配置' }] };
  const ownerAgent = { id: 'router-session', status: 'running', session: { header: {}, snapshotEvents: () => [{ type: 'turn/start', seq: 0 }, { type: 'user/message', seq: 1, data: message }] } };
  const ctx = { agents: { get: id => id === ownerAgent.id ? ownerAgent : undefined, currentInitiator: () => ownerAgent, turnBoundaryOf: () => ({ openTurnStartSeq: 0 }) }, get: name => name === 'approval' ? { request: async () => true } : undefined };
  let calls = 0;
  const executor = createModelActionTicketExecutor({ ctx, database, readPolicy: async () => ({ desktopVersion: 'desktop-v1' }),
    perform: async ({ args }) => { calls++; assert.ok(Object.isFrozen(args) && Object.isFrozen(args.patch)); return { revision: 4 }; },
    verify: async () => ({ verified: false, evidence: { kind: 'missing-readback' } }) });
  const input = { name: 'assistant_config', args: { patch: { name: 'Bench' } }, ownerAgent, exec: { agent: ownerAgent, callId: 'uncertain', signal: new AbortController().signal } };
  await assert.rejects(executor.execute(input));
  const uncertain = database.getRouterAction(ownerAgent.id, 'uncertain');
  assert.equal(uncertain.state, 'uncertain');
  assert.deepEqual(uncertain.receipt, { value: { revision: 4 } }, 'known canonical result is retained if readback fails');
  await assert.rejects(executor.execute(input), { code: 'MODEL_ACTION_UNCERTAIN' });
  assert.equal(calls, 1);
});

test('concurrent retry joins one identical operation and rejects changed inputs', async t => {
  const database = createAssistantOrchestrationStore({ filename: ':memory:' });
  t.after(() => database.close());
  const message = { id: 'message-1', source: { kind: 'user' }, content: [{ type: 'text', text: '设置名称' }] };
  const ownerAgent = { id: 'router-session', status: 'running', session: { header: {}, snapshotEvents: () => [{ type: 'turn/start', seq: 0 }, { type: 'user/message', seq: 1, data: message }] } };
  const ctx = { agents: { get: id => id === ownerAgent.id ? ownerAgent : undefined, currentInitiator: () => ownerAgent, turnBoundaryOf: () => ({ openTurnStartSeq: 0 }) }, get: name => name === 'approval' ? { request: async () => true } : undefined };
  let finish, calls = 0;
  const executor = createModelActionTicketExecutor({ ctx, database, readPolicy: async () => ({ desktopVersion: 'desktop-v1' }),
    perform: async ({ args }) => { calls++; await new Promise(resolve => { finish = resolve; }); return args; },
    verify: async () => ({ verified: true, evidence: { kind: 'readback' } }) });
  const base = { name: 'assistant_config', ownerAgent, exec: { agent: ownerAgent, callId: 'concurrent', signal: new AbortController().signal } };
  const first = executor.execute({ ...base, args: { content: 'first' } });
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(executor.execute({ ...base, args: { content: 'changed' } }), { code: 'IDEMPOTENCY_CONFLICT' });
  const retry = executor.execute({ ...base, args: { content: 'first' } });
  finish();
  assert.deepEqual(await retry, await first);
  assert.equal(calls, 1);
});

test('ordinary workers cannot claim a reserved model-action assignment', () => {
  const database = createAssistantOrchestrationStore({ filename: ':memory:' });
  try {
    const thread = database.createThread({ source: { type: 'desktop', id: 'reserved-session' } });
    const ticket = database.createTicket({ threadId: thread.id, target: 'reserved action', mandate: { policyVersion: 'v1', admission: 'desktop-model-action' } });
    database.createAssignment(ticket.id, { id: 'reserved-assignment', executor: 'model-action', actionKey: 'reserved', instructionRevision: 1 });
    assert.deepEqual(database.claimAssignments('ordinary-worker', { validateMandate: () => true }), []);
    const [claimed] = database.claimAssignments('model-owner', { assignmentId: 'reserved-assignment', includeReserved: true, validateMandate: () => true });
    assert.equal(claimed.id, 'reserved-assignment');
  } finally { database.close(); }
});
