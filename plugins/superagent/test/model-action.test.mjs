import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { createModelActionExecutor } from '../src/model-action.mjs';

test('model persistent action records one verified receipt without creating a task', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'superagent-model-action-'));
  const database = createAssistantOrchestrationStore({ directory });
  t.after(() => { database.close(); return rm(directory, { recursive: true, force: true }); });
  const message = { id: 'message-1', source: { kind: 'user' }, content: [{ type: 'text', text: '更新助手身份文档' }] };
  const ownerAgent = { id: 'router-session', status: 'running', session: { header: {}, snapshotEvents: () => [{ type: 'turn/start', seq: 0 }, { type: 'user/message', seq: 1, data: message }] } }, calls = [];
  const ctx = { agents: { get: id => id === ownerAgent.id ? ownerAgent : undefined, currentInitiator: () => ownerAgent, turnBoundaryOf: () => ({ openTurnStartSeq: 0 }) },
    get: name => name === 'approval' ? { request: async () => 'allowed-once' } : undefined };
  const executor = createModelActionExecutor({
    ctx, database, readPolicy: async () => ({ desktopVersion: 'desktop-v1' }),
    perform: async ({ name, args }) => { calls.push({ name, args }); return { revision: 3, value: args.value }; },
    verify: async ({ result }) => ({ verified: true, evidence: { kind: 'document-revision', revision: result.revision } }),
  });
  const input = { name: 'assistant_profile', args: { value: 'one' }, ownerAgent, threadId: 'main', exec: { agent: ownerAgent, callId: 'call-1', signal: new AbortController().signal } };
  const first = await executor.execute(input);
  const second = await executor.execute(input);
  assert.deepEqual(second, first);
  assert.equal(calls.length, 1);
  const action = database.getRouterAction(ownerAgent.id, 'call-1');
  assert.equal(action.state, 'completed');
  assert.deepEqual(action.receipt.value, first);
  assert.deepEqual(action.readback, { kind: 'document-revision', revision: 3 });
  assert.equal(action.action.messageId, message.id);
  assert.deepEqual(database.listTasks(), []);
  assert.deepEqual(database.pendingResultNotifications(), []);
});

test('media tools cannot enter the Router persistent action path', t => {
  const database = createAssistantOrchestrationStore({ filename: ':memory:' });
  t.after(() => database.close());
  const executor = createModelActionExecutor({ ctx: { agents: {} }, database,
    readPolicy: async () => assert.fail('media must be rejected before taking a reservation'),
    perform: async () => assert.fail('media must run on a Worker'),
    verify: async () => assert.fail('no Router media result') });
  return Promise.all(['generate_image', 'generate_video', 'generate_audio'].map(name =>
    assert.rejects(executor.execute({ name }), /Unsupported model persistent action/)));
});

test('same callId with different arguments is rejected without a second action', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'superagent-model-action-conflict-'));
  const database = createAssistantOrchestrationStore({ directory });
  t.after(() => { database.close(); return rm(directory, { recursive: true, force: true }); });
  const message = { id: 'message-1', source: { kind: 'user' }, content: [{ type: 'text', text: '请保存' }] };
  const ownerAgent = { id: 'router-session', status: 'running', session: { header: {}, snapshotEvents: () => [{ type: 'turn/start', seq: 0 }, { type: 'user/message', seq: 1, data: message }] } };
  const ctx = { agents: { get: id => id === ownerAgent.id ? ownerAgent : undefined, currentInitiator: () => ownerAgent, turnBoundaryOf: () => ({ openTurnStartSeq: 0 }) }, get: name => name === 'approval' ? { request: async () => 'allowed-once' } : undefined };
  const executor = createModelActionExecutor({ ctx, database, readPolicy: async () => ({ desktopVersion: 'desktop-v1' }), perform: async ({ args }) => args, verify: async () => ({ verified: true, evidence: { kind: 'document' } }) });
  const base = { name: 'assistant_profile', ownerAgent, threadId: 'main', exec: { agent: ownerAgent, callId: 'call-1', signal: new AbortController().signal } };
  await executor.execute({ ...base, args: { content: 'one' } });
  await assert.rejects(executor.execute({ ...base, args: { content: 'two' } }), /identity conflict/);
  await assert.rejects(executor.execute({ ...base, name: 'assistant_pet', args: { content: 'one' } }), /identity conflict/);
});

test('Router persistent action needs no approval card; a changed root instruction reserves no call', async t => {
  const database = createAssistantOrchestrationStore({ filename: ':memory:' });
  t.after(() => database.close());
  const message = { id: 'message-1', source: { kind: 'user' }, content: [{ type: 'text', text: '请记住' }] };
  const ownerAgent = { id: 'router-session', status: 'running', session: { header: {}, snapshotEvents: () => [{ type: 'turn/start', seq: 0 }, { type: 'user/message', seq: 1, data: message }] } };
  let calls = 0, approvalCalls = 0, changeInstruction = false;
  const ctx = { agents: { get: id => id === ownerAgent.id ? ownerAgent : undefined, currentInitiator: () => ownerAgent, turnBoundaryOf: () => ({ openTurnStartSeq: 0 }) }, get: name => name === 'approval' ? { request: async () => { approvalCalls++; return 'rejected'; } } : undefined };
  const readPolicy = async () => { if (changeInstruction) message.id = 'changed'; return { desktopVersion: 'desktop-v1' }; };
  const executor = createModelActionExecutor({ ctx, database, readPolicy, perform: async () => { calls++; return { id: 'm1' }; }, verify: async () => ({ verified: true, evidence: { kind: 'document', revision: 1 } }) });
  const input = { name: 'assistant_profile', args: { content: 'fact' }, ownerAgent, exec: { agent: ownerAgent, callId: 'direct', signal: new AbortController().signal } };
  assert.deepEqual(await executor.execute(input), { id: 'm1' });
  assert.equal(approvalCalls, 0);
  assert.equal(calls, 1);
  changeInstruction = true;
  await assert.rejects(executor.execute({ ...input, exec: { ...input.exec, callId: 'changed' } }), { code: 'MODEL_ACTION_INSTRUCTION_CHANGED' });
  assert.equal(calls, 1);
  assert.equal(database.getRouterAction(ownerAgent.id, 'changed'), null);
  assert.deepEqual(database.listTasks(), []);
});

test('arguments are frozen before dispatch and failed readback becomes non-replayable uncertain', async t => {
  const database = createAssistantOrchestrationStore({ filename: ':memory:' });
  t.after(() => database.close());
  const message = { id: 'message-1', source: { kind: 'user' }, content: [{ type: 'text', text: '请修改身份文档' }] };
  const ownerAgent = { id: 'router-session', status: 'running', session: { header: {}, snapshotEvents: () => [{ type: 'turn/start', seq: 0 }, { type: 'user/message', seq: 1, data: message }] } };
  const ctx = { agents: { get: id => id === ownerAgent.id ? ownerAgent : undefined, currentInitiator: () => ownerAgent, turnBoundaryOf: () => ({ openTurnStartSeq: 0 }) }, get: name => name === 'approval' ? { request: async () => 'allowed-once' } : undefined };
  let calls = 0;
  const executor = createModelActionExecutor({ ctx, database, readPolicy: async () => ({ desktopVersion: 'desktop-v1' }),
    perform: async ({ args }) => { calls++; assert.ok(Object.isFrozen(args) && Object.isFrozen(args.patch)); return { revision: 4 }; },
    verify: async () => ({ verified: false, evidence: { kind: 'missing-readback' } }) });
  const input = { name: 'assistant_profile', args: { patch: { name: 'Bench' } }, ownerAgent, exec: { agent: ownerAgent, callId: 'uncertain', signal: new AbortController().signal } };
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
  const message = { id: 'message-1', source: { kind: 'user' }, content: [{ type: 'text', text: '更新身份文档' }] };
  const ownerAgent = { id: 'router-session', status: 'running', session: { header: {}, snapshotEvents: () => [{ type: 'turn/start', seq: 0 }, { type: 'user/message', seq: 1, data: message }] } };
  const ctx = { agents: { get: id => id === ownerAgent.id ? ownerAgent : undefined, currentInitiator: () => ownerAgent, turnBoundaryOf: () => ({ openTurnStartSeq: 0 }) }, get: name => name === 'approval' ? { request: async () => 'allowed-once' } : undefined };
  let finish, calls = 0;
  const executor = createModelActionExecutor({ ctx, database, readPolicy: async () => ({ desktopVersion: 'desktop-v1' }),
    perform: async ({ args }) => { calls++; await new Promise(resolve => { finish = resolve; }); return args; },
    verify: async () => ({ verified: true, evidence: { kind: 'readback' } }) });
  const base = { name: 'assistant_profile', ownerAgent, exec: { agent: ownerAgent, callId: 'concurrent', signal: new AbortController().signal } };
  const first = executor.execute({ ...base, args: { content: 'first' } });
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(executor.execute({ ...base, args: { content: 'changed' } }), { code: 'IDEMPOTENCY_CONFLICT' });
  const retry = executor.execute({ ...base, args: { content: 'first' } });
  finish();
  assert.deepEqual(await retry, await first);
  assert.equal(calls, 1);
});

test('removed assistant_config cannot enter the model-action path', async t => {
  const database = createAssistantOrchestrationStore({ filename: ':memory:' });
  t.after(() => database.close());
  let approvalCalls = 0, actionCalls = 0;
  const executor = createModelActionExecutor({ ctx: { agents: {}, get: () => ({ request: async () => { approvalCalls++; return 'allowed-once'; } }) },
    database, readPolicy: async () => ({ desktopVersion: 'desktop-v1' }),
    perform: async () => { actionCalls++; return {}; }, verify: async () => ({ verified: true, evidence: {} }) });
  await assert.rejects(executor.execute({ name: 'assistant_config', args: { patch: { name: 'obsolete' } } }), /Unsupported model persistent action/);
  assert.equal(approvalCalls, 0);
  assert.equal(actionCalls, 0);
  assert.equal(database.listTasks().length, 0);
});
