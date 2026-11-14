import test from 'node:test';
import assert from 'node:assert/strict';
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { createTaskRevisionService } from '../src/task-revision-service.mjs';
import { createRouterTools } from '../src/router-tools.mjs';

function fixture(t) {
  const database = createAssistantOrchestrationStore({ filename: ':memory:' });
  t.after(() => database.close());
  const events = [{ type: 'turn/start' }, { type: 'user/message', data: { id: 'current-human', source: { kind: 'user' },
    content: [{ type: 'text', text: '把之前的发布文档补上兼容性说明。' }] } }];
  const agent = { id: 'new-model-session', status: 'running', session: { header: {}, snapshotEvents: () => structuredClone(events) } };
  const ctx = { get: () => undefined, agents: { get: id => id === agent.id ? agent : undefined,
    currentInitiator: () => agent, turnBoundaryOf: () => ({ openTurnStartSeq: 0 }) } };
  const oldSource = { channel: 'desktop', sessionId: 'old-model-session', messageId: 'original-human', threadId: 'main' };
  const mandate = { actorId: 'desktop-owner', source: oldSource, instruction: '整理发布文档', policyVersion: 'current',
    admission: 'desktop-approved-delegation', controlledActions: 'require-current-policy-and-harness-approval' };
  database.createThread({ id: 'desktop:old-model-session', source: { type: 'desktop', id: 'old-model-session' } });
  const task = database.createTask({ id: 'original-task', threadId: 'desktop:old-model-session', target: '整理发布文档', acceptance: '保留完整操作步骤', mandate });
  database.createAssignment(task.id, { model: { providerId: 'opaque-provider', modelId: 'Opaque/Model:1' }, text: task.target });
  const side = database.createTask({ id: 'side-task', threadId: task.threadId, target: '旁聊任务', mandate: { ...mandate, source: { ...oldSource, threadId: 'unrelated-side' } } });
  const policy = { desktopVersion: 'current', projects: [], workerModels: [{ providerId: 'opaque-provider', modelId: 'Opaque/Model:1' }] };
  let onPolicy;
  const taskChanges = createTaskRevisionService({ ctx, database, readPolicy: async () => { await onPolicy?.(); return policy; } });
  const tools = new Map(), scopeRequests = [];
  createRouterTools({ ctx, store: { getState: async () => ({ mainSessionId: agent.id, threads: [] }) },
    taskChanges, shutdown: new AbortController(), engine: { taskOwnerScope: async threadId => {
      scopeRequests.push(threadId); return { threadId, sessionIds: ['old-model-session', agent.id] };
    } } })(
    { tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } }, systemPrompt: { section() {}, context() {} } },
    { threadId: 'main', agent });
  const input = { id: task.id, operation: 'revise', reason: '按当前要求补充说明', target: '整理发布文档，补充兼容性说明' };
  const exec = { agent, callId: 'revision-call', signal: new AbortController().signal };
  const run = (args = input, execution = exec) => {
    const tool = tools.get('assistant_task_change');
    assert.deepEqual(validateJsonSchemaValue(tool.parameters, args), []);
    return tool.execute(args, execution);
  };
  return { database, task, side, agent, events, input, exec, run, scopeRequests, onPolicy: fn => { onPolicy = fn; } };
}

test('registered Router revision follows logical main-chat lineage after model-session reset', async t => {
  const f = fixture(t), before = f.database.getTask(f.task.id), assignment = f.database.assignments(f.task.id)[0];
  const changed = await f.run();
  assert.deepEqual(f.scopeRequests, ['main']);
  assert.equal(changed.id, before.id); assert.equal(changed.instructionRevision, 2);
  assert.equal(changed.target, f.input.target); assert.equal(changed.acceptance, before.acceptance);
  assert.deepEqual(changed.mandate, { ...before.mandate, target: f.input.target }, 'a model-session reset preserves original authority while projecting the revised requirement');
  assert.equal(f.database.assignments(f.task.id)[0].id, assignment.id);
  const revision = f.database.taskRevisions(f.task.id).at(-1);
  assert.equal(revision.context.at(-1).source.sessionId, f.agent.id);
  assert.equal(revision.context.at(-1).source.messageId, 'current-human');
  assert.equal(revision.context.at(-1).text, f.events[1].data.content[0].text);
  assert.equal((await f.run()).instructionRevision, 2, 'retry reuses the current-human receipt');
});

test('logical lineage does not grant revision authority to unrelated side chats or Worker handles', async t => {
  const f = fixture(t);
  await assert.rejects(f.run({ ...f.input, id: f.side.id }), /任务不属于当前主人会话/);
  await assert.rejects(f.run(f.input, { ...f.exec, agent: { id: 'worker' } }), /任务不属于当前主人会话/);
  assert.equal(f.database.getTask(f.task.id).instructionRevision, 1);
  assert.equal(f.database.getTask(f.side.id).instructionRevision, 1);
});

test('lineage revisions retain current-human and concurrent-revision protection', async t => {
  const changedInstruction = fixture(t);
  changedInstruction.onPolicy(() => { changedInstruction.events[1].data.content[0].text = '取消刚才的调整'; });
  await assert.rejects(changedInstruction.run(), /主人指令或授权规则已变化/);
  assert.equal(changedInstruction.database.getTask(changedInstruction.task.id).instructionRevision, 1);
  const concurrent = fixture(t); let reads = 0;
  concurrent.onPolicy(() => { if (++reads === 3) concurrent.database.updateTask(concurrent.task.id, { target: '其他入口已修改要求' }); });
  await assert.rejects(concurrent.run(), { code: 'TASK_CHANGE_STALE' });
  assert.equal(concurrent.database.getTask(concurrent.task.id).target, '其他入口已修改要求');
  assert.equal(concurrent.database.getTask(concurrent.task.id).instructionRevision, 2);
});
