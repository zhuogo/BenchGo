import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { createDeviceCollaboration, collaborationPrincipal } from '../src/device-collaboration.mjs';
import { validateTaskMandate } from '../src/assessment-policy.mjs';
import { createTaskExpression } from '../src/router-task-expression.mjs';
import { attentionAnswer } from '../src/worker-attention.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantStore } from '../src/store.mjs';
import { createOrchestrationRuntime } from '../src/orchestration-runtime.mjs';

function fixture(t) {
  const database = createAssistantOrchestrationStore({ filename: ':memory:' });
  t.after(() => database.close());
  const policy = { desktopVersion: 'target-policy', workerModels: [{ providerId: 'Target/P', modelId: 'Opaque:Target/v1' }], projects: [{ id: 'same-project', path: '/target/repo' }] };
  const resolutions = [];
  const meta = new Map();
  const runtimeStore = { meta: key => structuredClone(meta.get(key)), setMeta: (key, value) => meta.set(key, structuredClone(value)) };
  const ctx = { llm: { resolveModelInfo: async (provider, id) => { resolutions.push({ provider, id }); return { provider, id }; } } };
  const service = createDeviceCollaboration({ ctx, store: { orchestration: database }, runtimeStore, readPolicy: async () => policy });
  const peer = { principal: { kind: 'device', deviceId: 'inbound-A', capabilities: ['collaboration'] } };
  const input = { operation: 'delegate', requestId: 'stable-request', projectId: 'same-project', text: '修复远端项目的登录错误', acceptance: '通过登录验证',
    origin: { sessionId: 'source-session', threadId: 'source-chat', messageId: 'source-message', instruction: '请修复服务器项目的登录错误' } };
  return { database, policy, resolutions, ctx, service, peer, input, runtimeStore, meta };
}

test('authenticated collaboration creates one real target execution with target configuration and exact origin', async t => {
  const f = fixture(t);
  const [a, b] = await Promise.all([f.service.receive(f.input, f.peer), f.service.receive(f.input, f.peer)]);
  assert.equal(a.task.id, b.task.id);
  assert.equal(f.database.listTasks().length, 1);
  const task = f.database.getTask(a.task.id), [assignment] = f.database.assignments(task.id);
  assert.deepEqual(assignment.model, f.policy.workerModels[0]);
  assert.equal(task.mandate.project.path, '/target/repo');
  assert.equal(task.mandate.actorId, 'device:inbound-A');
  assert.equal(task.mandate.source.channel, 'link');
  assert.equal(task.mandate.instruction, f.input.origin.instruction);
  assert.equal(validateTaskMandate(task.mandate, { policy: f.policy }), true);
  assert.equal(validateTaskMandate({ ...task.mandate, actorId: 'desktop-owner' }, { policy: f.policy }), false);
  assert.deepEqual(f.resolutions, [{ provider: 'Target/P', id: 'Opaque:Target/v1' }]);
  const recovered = await f.service.receive({ operation: 'lookup', requestId: f.input.requestId, origin: f.input.origin }, f.peer);
  assert.equal(recovered.task.id, task.id);
  await assert.rejects(f.service.receive({ ...f.input, text: '不同内容' }, f.peer), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('device identity, capabilities and source conversation cannot be supplied or widened by task parameters', async t => {
  const f = fixture(t);
  for (const principal of [{ kind: 'owner', deviceId: 'inbound-A', capabilities: ['collaboration'] }, { kind: 'device', deviceId: 'inbound-A' }])
    assert.throws(() => collaborationPrincipal({ principal }), { code: 'COLLABORATION_DENIED' });
  const result = await f.service.receive(f.input, f.peer);
  for (const [peer, origin] of [[{ principal: { ...f.peer.principal, deviceId: 'other-device' } }, f.input.origin], [f.peer, { ...f.input.origin, threadId: 'other-chat' }]])
    await assert.rejects(f.service.receive({ operation: 'get', taskId: result.task.id, origin }, peer), { code: 'TASK_SOURCE_DENIED' });
  await assert.rejects(f.service.receive({ ...f.input, requestId: 'unknown-project', projectId: 'not-on-target' }, f.peer), /项目不存在/);
  await assert.rejects(f.service.receive({ ...f.input, requestId: 'model-override', modelId: 'source-model' }, f.peer), { code: 'MODEL_OVERRIDE_UNSUPPORTED' });
  assert.equal(f.database.listTasks().length, 1);
});

test('remote follow-up keeps one source-owned task, stores unchanged input and revises with current version', async t => {
  const f = fixture(t), accepted = await f.service.receive(f.input, f.peer);
  const followup = { operation: 'control', taskId: accepted.task.id, control: 'supplement', requestId: 'followup-request',
    origin: { ...f.input.origin, messageId: 'followup-message', instruction: '补充：请附测试日志' } };
  await f.service.receive(followup, f.peer);
  const [input] = f.database.taskInputs(accepted.task.id);
  assert.equal(f.database.getTrigger(input.triggerId).content, '补充：请附测试日志');
  assert.equal(input.actor.id, 'device:inbound-A');
  const changed = await f.service.receive({ ...followup, operation: 'change', requestId: 'change-request',
    origin: { ...followup.origin, messageId: 'change-message', instruction: '修复并增加回归测试' },
    instructionRevision: 1, text: '修复远端项目登录错误并增加回归测试', acceptance: '登录与回归测试通过', reason: '补充回归验证' }, f.peer);
  assert.equal(changed.task.id, accepted.task.id);
  assert.equal(changed.task.instructionRevision, 2);
  assert.equal(f.database.assignments(accepted.task.id).length, 1);
  await f.service.receive({ ...followup, control: 'pause', origin: { ...followup.origin, messageId: 'pause-message', instruction: '暂停任务' } }, f.peer);
  const control = f.database.getTask(accepted.task.id).executionControl;
  assert.equal(control.pauseRequested || control.paused, true);
});

test('entry host binds original message and reconciles lost acceptance without creating another executor', async t => {
  const f = fixture(t), events = [{ type: 'turn/start' }, { type: 'user/message', data: { id: 'real-message', source: { kind: 'user' }, content: [{ type: 'text', text: '原始真人要求' }] } }];
  const agent = { id: 'entry-session', status: 'running', session: { header: {}, snapshotEvents: () => events } };
  const calls = [], updates = [];
  let lost = true, clock = 0;
  const link = { callDevice: async request => {
    calls.push(request);
    const value = await f.service.receive(request.input, f.peer);
    if (lost) { lost = false; throw new Error('connection lost after acceptance'); }
    return value;
  } };
  const ctx = { get: () => link, agents: { get: () => agent, currentInitiator: () => agent, turnBoundaryOf: () => ({ openTurnStartSeq: 0 }) } };
  const entry = createDeviceCollaboration({ ctx, store: { orchestration: f.database }, runtimeStore: f.runtimeStore,
    now: () => clock, onUpdate: async update => updates.push(update) });
  const receipt = await entry.call({ operation: 'delegate', deviceId: 'outbound-B', text: '修复远端登录错误' }, { agent }, { ownerAgent: agent, threadId: 'entry-chat' });
  assert.equal(receipt.status, 'uncertain');
  await entry.tick();
  assert.equal(calls[1].input.operation, 'lookup');
  assert.equal(calls[1].input.requestId, calls[0].input.requestId);
  assert.equal(calls[0].input.origin.instruction, '原始真人要求');
  assert.equal(f.database.listTasks().length, 1);
  const [reference] = f.runtimeStore.meta('remote-executions');
  assert.equal(reference.executionRef.deviceId, 'outbound-B');
  assert.equal(reference.state, 'accepted');
  // A saved target result and question travel back to the original entry scope.
  link.callDevice = async () => ({ task: { id: reference.executionRef.taskId, instructionRevision: 1, resultVersion: 1, status: 'completed' }, results: [{ version: 1, summary: '已修复，目标测试通过' }], attentions: [] });
  clock = 6000;
  await entry.tick();
  assert.equal(updates.length, 1);
  assert.equal(updates[0].origin.threadId, 'entry-chat');
  assert.equal(updates[0].executionRef.deviceId, 'outbound-B');
  assert.equal(f.runtimeStore.meta('remote-executions')[0].state, 'completed');
});

test('remote Attention answers preserve exact original text and device source without owner impersonation', async t => {
  const f = fixture(t), accepted = await f.service.receive(f.input, f.peer);
  const [assignment] = f.database.claimAssignments('worker', { validateMandate: () => true });
  const ownership = { owner: assignment.owner, fence: assignment.fence };
  const run = f.database.prepareRun(assignment.id, { ...ownership, sessionId: 'target-worker-session', directory: process.cwd() });
  f.database.updateRun(run.id, { ...ownership, state: 'submitted' });
  const [question] = f.database.openAttention(assignment.id, { ...ownership, sessionId: run.sessionId, callId: 'target-question',
    questions: [{ id: 'timezone', question: '采用什么时区？', options: [{ label: '北京时间' }] }] });
  const origin = { ...f.input.origin, messageId: 'exact-answer-message', instruction: '  使用北京时间\n保留原文  ' };
  const input = { operation: 'control', control: 'answer', taskId: accepted.task.id, attentionId: question.id,
    instructionRevision: 1, requestId: 'answer-request', origin };
  await assert.rejects(f.service.receive({ ...input, instructionRevision: 2 }, f.peer), /requirements changed/);
  await f.service.receive(input, f.peer);
  const saved = f.database.attentions(accepted.task.id)[0];
  const trigger = f.database.getTrigger(saved.answerTriggerId);
  assert.equal(trigger.actor.id, 'device:inbound-A');
  assert.equal(trigger.source.channel, 'link');
  assert.equal(trigger.source.messageId, 'exact-answer-message');
  assert.equal(trigger.content, origin.instruction);
  assert.deepEqual(attentionAnswer(f.database, saved), { id: 'timezone', selected: [], custom: origin.instruction });
  await f.service.receive(input, f.peer);
  assert.equal(f.database.taskInputs(accepted.task.id).length, 1);
});

test('remote result notices publish only for host-observed exact references in the original conversation lineage', async () => {
  const executionRef = { deviceId: 'outbound-B', kind: 'task', resourceId: 'target-task', taskId: 'target-task', executionId: 'target-assignment' };
  const reference = { origin: { threadId: 'source-chat', sessionId: 'old-session' }, executionRef, observedEventKey: 'result:1:1' };
  const expression = createTaskExpression({ store: {}, taskOwnerScope: async () => ({ sessionIds: ['old-session', 'new-session'] }),
    thread: async () => ({ archived: false }), readRemoteExecutions: () => [reference] });
  const message = { source: { kind: 'benchgo-execution-input', remoteExecution: executionRef, eventKey: 'result:1:1' } };
  assert.equal(await expression.mayReplyToExecutionInput('source-chat', message), true);
  assert.equal(await expression.mayReplyToExecutionInput('other-chat', message), false);
  assert.equal(await expression.mayReplyToExecutionInput('source-chat', { source: { ...message.source, eventKey: 'result:9:9' } }), false);
  assert.equal(await expression.mayReplyToExecutionInput('source-chat', { source: { ...message.source, remoteExecution: { ...executionRef, deviceId: 'other-device' } } }), false);
});

test('target orchestration executes the admitted Link task once and persists result without target-owner Router or transport', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-link-task-'));
  const store = await createAssistantStore({ dataDirectory: directory });
  const getConfig = store.getConfig;
  store.getConfig = async () => ({ ...await getConfig(), workerModels: [{ providerId: 'Target/Provider', modelId: 'Target:Model' }] });
  let executions = 0, routerReplies = 0;
  const ctx = { llm: { resolveModelInfo: async (provider, id) => ({ provider, id }) } };
  const service = createDeviceCollaboration({ ctx, store });
  const peer = { principal: { kind: 'device', deviceId: 'authenticated-entry', capabilities: ['collaboration'] } };
  const origin = { sessionId: 'source-session', threadId: 'original-chat', messageId: 'source-message', instruction: '请在目标设备完成任务' };
  const accepted = await service.receive({ operation: 'delegate', requestId: 'execution-request', text: '生成目标设备上的检查结果', origin }, peer);
  const runtime = createOrchestrationRuntime({ ctx, store,
    notifyTaskResult: async () => { routerReplies++; throw new Error('Incoming device cannot use target-owner Router'); },
    execute: async (assignment, { task }) => {
      executions++;
      assert.equal(task.mandate.source.deviceId, 'authenticated-entry');
      assert.deepEqual(assignment.model, { providerId: 'Target/Provider', modelId: 'Target:Model' });
      return { summary: '目标保存的结果', completion: { kind: 'completed' }, evidenceRefs: [] };
    } });
  t.after(async () => { await runtime.stop(); await store.close(); await rm(directory, { recursive: true, force: true }); });
  for (let count = 0; count < 30; count++) {
    await runtime.tick();
    await new Promise(resolve => setTimeout(resolve, 2));
    if (store.orchestration.getTask(accepted.task.id).status === 'completed') break;
  }
  await runtime.tick();
  const result = await service.receive({ operation: 'get', taskId: accepted.task.id, origin }, peer);
  assert.equal(result.task.status, 'completed');
  assert.equal(result.results.at(-1).summary, '目标保存的结果');
  assert.equal(executions, 1);
  assert.equal(routerReplies, 0);
  assert.deepEqual(store.orchestration.deliveries(accepted.task.id), []);
  assert.equal(store.orchestration.results(accepted.task.id).at(-1).notification.state, 'notified');
  assert.equal(store.orchestration.listTasks().length, 1);
});

test('definite remote rejection stops observation and unresolved acceptance has a bounded manual reconcile path', async t => {
  const f = fixture(t), events = [{ type: 'turn/start' }, { type: 'user/message', data: { id: 'real-message', source: { kind: 'user' }, content: [{ type: 'text', text: '真实请求' }] } }];
  const agent = { id: 'entry-session', status: 'running', session: { header: {}, snapshotEvents: () => events } };
  let calls = 0, mode = 'reject', clock = 0;
  const link = { callDevice: async () => { calls++; if (mode === 'reject') throw Object.assign(new Error('未授权'), { status: 403 });
    if (mode === 'network') throw new Error('network'); return { available: false, code: 'ACCEPTANCE_UNKNOWN' }; } };
  const ctx = { get: () => link, agents: { get: () => agent, currentInitiator: () => agent, turnBoundaryOf: () => ({ openTurnStartSeq: 0 }) } };
  const entry = createDeviceCollaboration({ ctx, store: { orchestration: f.database }, runtimeStore: f.runtimeStore, now: () => clock });
  const exec = { agent }, options = { ownerAgent: agent, threadId: 'main', ownerScope: { sessionIds: [agent.id] } };
  await assert.rejects(entry.call({ operation: 'delegate', deviceId: 'B', text: '目标任务' }, exec, options), /未授权/);
  assert.equal(f.runtimeStore.meta('remote-executions')[0].state, 'rejected');
  await entry.tick(); assert.equal(calls, 1);
  mode = 'network';
  const receipt = await entry.call({ operation: 'delegate', deviceId: 'B', text: '另一个明确任务' }, exec, options);
  assert.equal(receipt.status, 'uncertain');
  mode = 'unknown';
  for (let count = 0; count < 6; count++) { clock += 30001; await entry.tick(); }
  const unverified = f.runtimeStore.meta('remote-executions').find(row => row.requestId === receipt.requestId);
  assert.equal(unverified.state, 'unverified');
  const before = calls;
  clock += 30001; await entry.tick(); assert.equal(calls, before);
  const lookup = await entry.call({ operation: 'reconcile', deviceId: 'B', requestId: receipt.requestId }, exec, options);
  assert.equal(lookup.code, 'ACCEPTANCE_UNKNOWN');
  assert.equal(calls, before + 1);
  assert.equal(f.database.listTasks().length, 0);
});
