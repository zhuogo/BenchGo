import test from 'node:test';
import assert from 'node:assert/strict';
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
import { createRouterTools } from '../src/router-tools.mjs';
import { isDesktopTaskManagementScope } from '../src/desktop-task-management-authority.mjs';

function fixture({ threadId = 'main', query, read, taskManagement = {} } = {}) {
  const events = [{ type: 'turn/start' }, { type: 'user/message', data: { id: 'real-owner-message', source: { kind: 'user' },
    content: [{ type: 'text', text: '先停止并归档选中的两个工单，保留成果。' }] } }];
  const agent = { id: 'current-router', status: 'running', session: { header: {}, snapshotEvents: () => structuredClone(events) } };
  const state = { mainSessionId: agent.id, threads: [{ id: 'manual-side', sessionId: agent.id }] };
  const calls = [], approvals = [], definitions = new Map();
  let stateRead;
  const store = { getState: async () => { await stateRead?.(); return state; } };
  const ctx = { get: name => name === 'approval' ? { overrideOf: () => 'never', request: async input => { approvals.push(input); return 'rejected'; } } : undefined,
    agents: { get: id => id === agent.id ? agent : undefined, currentInitiator: () => agent, turnBoundaryOf: () => ({ openTurnStartSeq: 0 }) } };
  createRouterTools({ ctx, store, shutdown: new AbortController(), taskManagement,
    desktopTasks: {
      query(ownerScope, filters) { calls.push({ method: 'query', ownerScope, filters }); return query ? query(filters) : { tasks: [], nextOffset: null }; },
      read(id, ownerScope, options) { calls.push({ method: 'read', id, ownerScope, options }); return read ? read(id, options) : { id, section: options.section || 'overview', records: [], nextOffset: null }; },
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

const cleanupInputs = [
  { op: 'preview', ids: ['one'] },
  { op: 'commit', previewId: 'archive-preview', ids: ['one'] },
  { op: 'restore', receiptId: 'archive-receipt' },
  { op: 'restore', previewId: 'restore-preview', ids: ['one'] },
];

test('archive and restore reject retained Workers, external sources and machine-only turns', async () => {
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
  for (const input of cleanupInputs) for (const mutate of mutations) {
    const f = fixture({ threadId: 'manual-side' }); mutate(f);
    await assert.rejects(f.run('assistant_task_cleanup', input), { code: 'MANAGEMENT_OWNER_REQUIRED' });
    assert.deepEqual(f.calls, []);
  }
});

test('archive and restore reject forged host identity and stale instructions before forwarding', async () => {
  for (const input of cleanupInputs) {
    for (const key of ['source', 'agent', 'instruction', 'confirmedBy', 'scope']) {
      const f = fixture();
      const tool = f.definitions.get('assistant_task_cleanup');
      const forged = { ...input, [key]: 'model-provided' };
      assert.notEqual(validateJsonSchemaValue(tool.parameters, forged).length, 0);
      await assert.rejects(tool.execute(forged, f.exec), { code: 'MANAGEMENT_INPUT' });
      assert.deepEqual(f.calls, []);
    }
    const f = fixture();
    f.onStateRead(() => { f.events[1].data.content[0].text = '取消刚才的整理'; });
    await assert.rejects(f.run('assistant_task_cleanup', input), { code: 'MANAGEMENT_STALE_INSTRUCTION' });
    assert.deepEqual(f.calls, []);
  }
  for (const [prepare, commit] of [[cleanupInputs[0], cleanupInputs[1]], [cleanupInputs[2], cleanupInputs[3]]]) {
    const preview = { previewId: commit.previewId, type: commit.op === 'restore' ? 'restore' : 'archive', manifestHash: 'frozen', items: [{ id: 'one' }] };
    const f = fixture({ taskManagement: {
      previewCleanup: () => preview, previewRestore: () => preview, getCleanupPreview: () => preview,
      createCleanupConfirmation: () => assert.fail('a stale instruction must not receive a host confirmation'),
    } });
    assert.deepEqual(await f.run('assistant_task_cleanup', prepare), preview);
    f.events[1].data.content[0].text = '取消刚才的整理';
    await assert.rejects(f.run('assistant_task_cleanup', commit), { code: 'MANAGEMENT_STALE_INSTRUCTION' });
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
  for (const section of ['overview', 'progress', 'requirements', 'revisions', 'assignments', 'runs', 'attentions', 'deliveries']) {
    await f.run('assistant_tasks', { op: 'get', id: 'old-task', section });
    assert.deepEqual(f.calls.at(-1).options, { section });
  }
  const schema = f.definitions.get('assistant_tasks').parameters;
  assert.deepEqual(schema.properties.textOffset, { type: 'integer', minimum: 0 });
  assert.deepEqual(schema.properties.textLimit, { type: 'integer', minimum: 1, maximum: 12000 });
  assert.deepEqual(schema.properties.expectedHash, { type: 'string' });
  assert.deepEqual(schema.properties.section.enum, ['overview', 'progress', 'requirements', 'results', 'revisions', 'assignments', 'runs', 'attentions', 'deliveries']);
});

test('internal-only task reads fall back to logical ownership without inheriting global management', async () => {
  const f = fixture(); f.events[1].data.source = { kind: 'task-reply' };
  await f.run('assistant_tasks', { op: 'get', id: 'old-task', section: 'progress' });
  assert.deepEqual(f.calls.map(row => row.method), ['ownerScope', 'read']);
  assert.equal(isDesktopTaskManagementScope(f.calls[1].ownerScope), false);
  assert.deepEqual(f.calls[1].ownerScope, { threadId: 'main', sessionIds: ['original-router', f.agent.id] });
});

test('assistant_tasks suppresses repeated invalid reads and allows corrected input and a new turn', async () => {
  const f = fixture({ read(id, options) {
    if (options.textOffset) throw Object.assign(new Error('提供有效 expectedHash'), { code: 'TASK_QUERY_INPUT' });
    return { id, status: 'completed' };
  } });
  const query = { op: 'get', id: 'one', section: 'results', textOffset: 8, recordId: 'result:3', limit: 1 };
  await assert.rejects(f.run('assistant_tasks', query), { code: 'TASK_QUERY_INPUT' });
  await assert.rejects(f.run('assistant_tasks', { ...query, expectedHash: ' \t' }), /本回合已处理相同参数/);
  assert.equal(f.calls.length, 1);
  assert.equal((await f.run('assistant_tasks', { ...query, textOffset: 0 })).task.status, 'completed');
  f.events.push({ type: 'turn/end' }, { type: 'turn/start' }, { ...f.events[1], data: { ...f.events[1].data, id: 'next-owner-message' } });
  f.ctx.agents.turnBoundaryOf = () => ({ openTurnStartSeq: 3 });
  await assert.rejects(f.run('assistant_tasks', query), { message: '提供有效 expectedHash' });
  assert.equal(f.calls.length, 3);
});

test('assistant_tasks surfaces changed snapshots, flags duplicate polling and allows page and result pointers', async () => {
  let task = { id: 'one', status: 'running', result: null };
  const f = fixture({ query: ({ offset }) => offset ? { tasks: [], nextOffset: null } : { tasks: [task], nextOffset: 20 } });
  assert.equal((await f.run('assistant_tasks', {})).tasks[0].status, 'running');
  task = { ...task, status: 'completed', result: { taskId: 'one', version: 3 } };
  const completed = await f.run('assistant_tasks', { op: 'list' });
  assert.equal(completed.tasks[0].status, 'completed');
  const duplicate = await f.run('assistant_tasks', { op: 'list', offset: 0, limit: 20 });
  assert.equal(duplicate.code, 'TASK_QUERY_UNCHANGED');
  assert.deepEqual(duplicate.resultReads, [{ op: 'get', id: 'one', section: 'results', recordId: 'result:3', limit: 1 }]);
  assert.deepEqual(await f.run('assistant_tasks', {}), duplicate);
  assert.equal(f.calls.length, 4);
  assert.deepEqual(await f.run('assistant_tasks', { offset: completed.nextOffset }), { tasks: [], nextOffset: null });
  assert.equal((await f.run('assistant_tasks', duplicate.resultReads[0])).task.id, 'one');
  assert.equal(f.calls.length, 6);
  task = { ...task, result: { taskId: 'one', version: 4 } };
  assert.equal((await f.run('assistant_tasks', {})).tasks[0].result.version, 4);
});
