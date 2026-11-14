import test from 'node:test';
import assert from 'node:assert/strict';
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
import { createRouterTools } from '../src/router-tools.mjs';
import { isDesktopTaskManagementScope } from '../src/desktop-task-management-authority.mjs';

function fixture({ threadId = 'main' } = {}) {
  const events = [{ type: 'turn/start' }, { type: 'user/message', data: { id: 'real-owner-message', source: { kind: 'user' },
    content: [{ type: 'text', text: '先停止并归档选中的两个工单，保留成果。' }] } }];
  const agent = { id: 'current-router', status: 'running', session: { header: {}, snapshotEvents: () => structuredClone(events) } };
  const state = { mainSessionId: agent.id, threads: [{ id: 'manual-side', sessionId: agent.id }] };
  const calls = [], approvals = [], definitions = new Map();
  let stateRead;
  const store = { getState: async () => { await stateRead?.(); return state; } };
  const ctx = { get: name => name === 'approval' ? { overrideOf: () => 'never', request: async input => { approvals.push(input); return 'rejected'; } } : undefined,
    agents: { get: id => id === agent.id ? agent : undefined, currentInitiator: () => agent, turnBoundaryOf: () => ({ openTurnStartSeq: 0 }) } };
  const continuation = { operationId: 'durable-operation', items: [{ taskId: 'one', status: 'pending' }], nextOffset: null };
  createRouterTools({ ctx, store, shutdown: new AbortController(), taskManagement: {},
    cleanupContinuations: {
      start(args, owner) { calls.push({ method: 'start', args, owner }); return { operation: 'stop-and-archive', ...continuation }; },
      pending(args) { calls.push({ method: 'pending', args }); return continuation; },
      cancel(args) { calls.push({ method: 'cancel', args }); return { operationId: 'durable-operation', items: [{ taskId: 'one', status: 'cancelled' }] }; },
    },
    desktopTasks: {
      query(ownerScope, filters) { calls.push({ method: 'query', ownerScope, filters }); return { tasks: [], nextOffset: null }; },
      read(id, ownerScope, options) { calls.push({ method: 'read', id, ownerScope, options }); return { id, section: options.section || 'overview', records: [], nextOffset: null }; },
    },
    engine: { async taskOwnerScope(id) { calls.push({ method: 'ownerScope', threadId: id }); return { threadId: id, sessionIds: ['original-router', agent.id] }; } },
  })(
    { tools: { register(tool) { definitions.set(tool.name, tool); return () => definitions.delete(tool.name); } }, systemPrompt: { section() {}, context() {} } },
    { threadId, agent });
  const exec = { agent, callId: 'current-call', signal: new AbortController().signal };
  async function run(name, input, execution = exec) {
    const tool = definitions.get(name);
    assert.ok(tool, `missing registered Router tool ${name}`);
    assert.deepEqual(validateJsonSchemaValue(tool.parameters, input), []);
    const result = await tool.execute(input, execution);
    assert.deepEqual(validateJsonSchemaValue(tool.output.schema, result), []);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
    return result;
  }
  return { events, agent, state, ctx, exec, calls, approvals, definitions, run, onStateRead: hook => { stateRead = hook; } };
}

const continuationInputs = [
  { op: 'stop-and-archive', ids: ['one', 'two'] },
  { op: 'pending', operationId: 'durable-operation', taskId: 'one', status: 'pending', offset: 2, limit: 10 },
  { op: 'cancel', operationId: 'durable-operation', ids: ['one'] },
];

test('registered stop/archive follow-up operations bind the real local main or manual-side owner', async () => {
  for (const threadId of ['main', 'manual-side']) {
    const f = fixture({ threadId });
    for (const input of continuationInputs) await f.run('assistant_task_cleanup', input);
    assert.deepEqual(f.calls.map(row => row.method), ['start', 'pending', 'cancel']);
    assert.deepEqual(f.calls[0].args, { ids: ['one', 'two'] });
    assert.equal(f.calls[0].owner.agent, f.agent);
    assert.equal(f.calls[0].owner.threadId, threadId);
    assert.deepEqual(f.calls[0].owner.instruction, { turn: 0, message: f.events[1].data });
    assert.deepEqual(f.calls[1].args, { operationId: 'durable-operation', taskId: 'one', status: 'pending', offset: 2, limit: 10 });
    assert.deepEqual(f.calls[2].args, { operationId: 'durable-operation', ids: ['one'] });
    assert.deepEqual(f.approvals, [], 'reversible product organization never asks a business approval under never');
  }
});

test('stop/archive follow-up operations reject retained Workers, external sources and machine-only turns', async () => {
  const mutations = [
    f => { f.exec.agent = { ...f.agent, id: 'worker' }; },
    f => { f.agent.session.header.origin = 'subagent'; },
    f => { f.agent.status = 'idle'; },
    f => { f.events[1].data.source = { kind: 'task-reply' }; },
    f => { f.events.push({ type: 'turn/end' }); },
    f => { f.state.threads[0].source = { channel: 'feishu' }; f.state.threads[0].sourceKey = 'external-channel'; },
    f => { f.state.threads[0].archived = true; },
    f => { f.state.threads[0].sessionId = 'replaced-router'; },
  ];
  for (const input of continuationInputs) for (const mutate of mutations) {
    const f = fixture({ threadId: 'manual-side' }); mutate(f);
    await assert.rejects(f.run('assistant_task_cleanup', input), { code: 'MANAGEMENT_OWNER_REQUIRED' });
    assert.deepEqual(f.calls, []);
  }
});

test('new cleanup operations reject forged host identity and stale instructions before forwarding', async () => {
  for (const input of continuationInputs) {
    for (const key of ['source', 'agent', 'instruction', 'confirmedBy', 'scope', 'requestId']) {
      const f = fixture();
      const tool = f.definitions.get('assistant_task_cleanup');
      const forged = { ...input, [key]: 'model-provided' };
      // requestId belongs to commit/restore in the shared tool schema; the
      // operation-specific host guard still rejects it for continuation ops.
      if (key !== 'requestId') assert.notEqual(validateJsonSchemaValue(tool.parameters, forged).length, 0);
      await assert.rejects(tool.execute(forged, f.exec), { code: 'MANAGEMENT_INPUT' });
      assert.deepEqual(f.calls, []);
    }
    const f = fixture();
    f.onStateRead(() => { f.events[1].data.content[0].text = '取消刚才的整理'; });
    await assert.rejects(f.run('assistant_task_cleanup', input), { code: 'MANAGEMENT_STALE_INSTRUCTION' });
    assert.deepEqual(f.calls, []);
  }
});

test('assistant_tasks forwards literal historical filters with trusted owner scope before pagination', async () => {
  const f = fixture();
  const filters = { query: '发布%_文档', createdAfter: '2026-11-01T00:00:00+08:00', createdBefore: '2026-11-08T00:00:00+08:00',
    channel: 'opaque-channel', sessionId: 'source/session:1', projectId: 'project:1', status: 'waiting', archived: false, limit: 25, offset: 50 };
  assert.deepEqual(await f.run('assistant_tasks', { op: 'list', ...filters }), { tasks: [], nextOffset: null });
  assert.deepEqual(f.calls.map(row => row.method), ['query']);
  assert.equal(isDesktopTaskManagementScope(f.calls[0].ownerScope), true);
  assert.deepEqual(f.calls[0].filters, filters);
  await assert.rejects(f.run('assistant_tasks', { op: 'list' }, { ...f.exec, agent: { id: 'worker' } }), /只有总助手当前会话可查询任务/);
});

test('assistant_tasks get forwards section, exact record pointer, hash and character/page budgets losslessly', async () => {
  const f = fixture();
  const options = { section: 'results', offset: 2, limit: 1, textLimit: 257, textOffset: 514,
    recordId: 'result/opaque:version-9', expectedHash: 'a'.repeat(64) };
  const result = await f.run('assistant_tasks', { op: 'get', id: 'old-task', ...options });
  assert.equal(result.task.id, 'old-task');
  assert.equal(isDesktopTaskManagementScope(f.calls[0].ownerScope), true);
  assert.equal(f.calls[0].id, 'old-task');
  assert.deepEqual(f.calls[0].options, options);
  for (const section of ['overview', 'requirements', 'revisions', 'assignments', 'runs', 'attentions', 'deliveries']) {
    await f.run('assistant_tasks', { op: 'get', id: 'old-task', section });
    assert.deepEqual(f.calls.at(-1).options, { section });
  }
  const schema = f.definitions.get('assistant_tasks').parameters;
  assert.deepEqual(schema.properties.textOffset, { type: 'integer', minimum: 0 });
  assert.deepEqual(schema.properties.textLimit, { type: 'integer', minimum: 1, maximum: 12000 });
  assert.deepEqual(schema.properties.expectedHash, { type: 'string' });
  assert.deepEqual(schema.properties.section.enum, ['overview', 'requirements', 'results', 'revisions', 'assignments', 'runs', 'attentions', 'deliveries']);
});

test('internal-only task reads fall back to logical ownership without inheriting global management', async () => {
  const f = fixture(); f.events[1].data.source = { kind: 'task-reply' };
  await f.run('assistant_tasks', { op: 'get', id: 'old-task', section: 'requirements', textLimit: 120 });
  assert.deepEqual(f.calls.map(row => row.method), ['ownerScope', 'read']);
  assert.equal(isDesktopTaskManagementScope(f.calls[1].ownerScope), false);
  assert.deepEqual(f.calls[1].ownerScope, { threadId: 'main', sessionIds: ['original-router', f.agent.id] });
});
