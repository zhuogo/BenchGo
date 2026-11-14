import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const checkout = fileURLToPath(new URL('../../../deepseek-harness/', import.meta.url));
const official = existsSync(join(checkout, 'packages/core/agent-loop/lib/index.js'))
  ? checkout : dirname(realpathSync(join(checkout, 'node_modules')));
const requireOfficial = createRequire(join(official, 'packages/core/agent-loop/package.json'));
const requireQuery = createRequire(join(official, 'packages/session-query/session-query-sqlite/package.json'));
const pinned = new Map(['@deepseek-ai/cordis', 'zod'].map(name => [name, pathToFileURL(requireOfficial.resolve(name)).href]));
const resolver = registerHooks({ resolve(specifier, context, next) {
  return pinned.has(specifier) ? { url: pinned.get(specifier), shortCircuit: true } : next(specifier, context);
} });
test.after(() => resolver.deregister());
const load = name => import(pathToFileURL(requireOfficial.resolve(name)).href);
const { Context } = await load('@deepseek-ai/cordis');
const llm = await load('@deepseek-ai/dsh-llm');
const modules = await Promise.all(['@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-projection', '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-tool-executor-native', '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-session-persistence-jsonl', '@deepseek-ai/dsh-agent-loop'].map(load));
const Query = await import(pathToFileURL(requireQuery.resolve('@deepseek-ai/dsh-session-query-sqlite')).href);
const { createTaskExecutionProgress } = await import('../src/task-execution-progress.mjs');
const { publicExecutionActivity } = await import('../src/worker-progress.mjs');
const { createAssistantOrchestrationStore } = await import('../src/orchestration-store.mjs');

async function fixture(t, { begin = true, target = 'PRIVATE TARGET', acceptance = 'PRIVATE ACCEPTANCE' } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-execution-observation-'));
  let database = createAssistantOrchestrationStore({ directory }), host, progress, eventObserver;
  const source = { channel: 'desktop', sessionId: 'owner', messageId: 'first', threadId: 'main' };
  const mandate = { actorId: 'desktop-owner', source, instruction: 'first', policyVersion: 'current', admission: 'desktop-approved-delegation', controlledActions: 'require-current-policy-and-harness-approval' };
  const { trigger } = database.ingest({ dedupeKey: 'first', thread: { id: 'desktop:owner', source: { type: 'desktop', id: 'owner' } }, source, actor: { kind: 'human', id: 'desktop-owner' }, content: 'first', mode: 'direct' });
  const task = database.createTask({ threadId: trigger.threadId, target, acceptance, mandate });
  database.createAssignment(task.id, { id: 'assignment', text: task.target });
  const [assignment] = database.claimAssignments('test-owner', { validateMandate: () => true });
  const ownership = { owner: assignment.owner, fence: assignment.fence };
  const run = database.prepareRun(assignment.id, { ...ownership, sessionId: 'worker', directory });
  database.updateRun(run.id, { ...ownership, state: 'submitted' });
  const contexts = [], observers = [];
  t.after(async () => {
    for (const observer of observers.reverse()) await observer.dispose();
    for (const context of contexts.reverse()) await context.close();
    database.close();
    assert.equal(resolve(directory).startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/')), true);
    await rm(directory, { recursive: true, force: true });
  });
  async function newHost() {
    const ctx = new Context(), handles = []; let closed = false;
    const value = { ctx, handles, async close() {
      if (closed) return; closed = true;
      for (const handle of handles.splice(0).reverse()) await handle.dispose();
      await ctx.fiber.dispose();
    } };
    contexts.push(value); host = value;
    await ctx.plugin(llm.default);
    for (let index = 0; index < modules.length; index++) await ctx.plugin(modules[index].default || modules[index],
      index === 6 ? { root: join(directory, 'official-sessions'), compression: 'none' } : index === 7 ? { agents: [] } : undefined);
    await ctx.plugin(Query.default || Query, { path: ':memory:', openAt: 'never' });
  }
  async function createAgent(sessionId, meta = {}) {
    const handle = await host.ctx.agents.create({ sessionId, meta: { cwd: directory, ...meta } });
    host.handles.push(handle); return handle;
  }
  async function start() {
    const on = host.ctx.on.bind(host.ctx);
    host.ctx.on = (name, callback, options) => { if (name === 'session/event') eventObserver = callback; return on(name, callback, options); };
    progress = createTaskExecutionProgress({ ctx: host.ctx, database, bootId: `test-boot-${observers.length}` });
    observers.push(progress); try { await progress.ready; } finally { host.ctx.on = on; }
  }
  await newHost(); const worker = await createAgent(run.sessionId); if (begin) await start();
  return { directory, source, mandate, task, assignment, run, ownership, worker, createAgent, start,
    get database() { return database; }, get host() { return host; }, get progress() { return progress; },
    notify: (...args) => eventObserver(...args),
    read: () => progress.batch()(database.getTask(task.id), database.assignments(task.id)),
    async restart({ clearProjection = false } = {}) {
      await progress?.dispose(); await host.close(); database.close();
      if (clearProjection) { const raw = new DatabaseSync(join(directory, 'assistant.db')); try { raw.exec('DELETE FROM sa_execution_projection'); } finally { raw.close(); } }
      database = createAssistantOrchestrationStore({ directory }); await newHost(); await start();
    } };
}
function turn(session, number = 1) { session.append('turn/start', { turn: number }); session.append('step/start', { turn: number, step: 1 }); }
function call(session, name = 'web_search') {
  session.append('assistant/message', { turn: 1, step: 1, stream: [], message: llm.createMessage({ role: 'assistant',
    content: [{ type: 'text', text: 'PRIVATE MODEL OUTPUT' }, { type: 'tool-call', id: 'call', name, arguments: '{"token":"PRIVATE ARGUMENT"}' }],
    source: { kind: 'model', provider: 'opaque-provider', model: 'opaque/model' } }) }, { surfaceOp: 'append' });
  return session.append('tool/call', { turn: 1, step: 1, callId: 'call', name, arguments: '{"token":"PRIVATE ARGUMENT"}' });
}
function result(session, isError = false) { return session.append('tool/result', { turn: 1, step: 1,
  message: llm.createToolResultMessage({ callId: 'call', content: [{ type: 'text', text: 'PRIVATE TOOL OUTPUT' }], isError }),
  ...(isError ? { error: { name: 'ToolError', code: 'OPAQUE_CODE', reason: 'PRIVATE ERROR' } } : {}) }, { surfaceOp: 'append' }); }
function end(session, number = 1) { session.append('step/end', { turn: number, step: 1 }); session.append('turn/end', { turn: number, reason: { kind: 'completed' } }); }
function catalog(parent, childId) { return parent.append('subagent/catalog', { version: 3, childId, childCreatedAt: Date.now(), mode: 'continuable', name: 'private-child-name', label: 'PRIVATE CHILD TASK' }); }
function notice(parent, childId) { return parent.append('user/message', llm.createUserMessage({ source: { kind: 'subagent-settled', form: 'notice', senderSessionId: childId,
  stopReason: 'completed', summary: 'PRIVATE SUMMARY' }, content: [{ type: 'text', text: 'PRIVATE CHILD OUTPUT' }] }), { surfaceOp: 'append' }); }

test('real Session events project phases and safe counters without private tool/model bodies', async t => {
  const f = await fixture(t), session = f.worker.agent.session;
  turn(session); call(session); assert.equal(f.read().worker.activity, '正在搜索网页');
  const last = result(session, true); assert.equal(f.read().worker.activity, '工具调用失败，正在处理');
  const projection = f.database.getExecutionProjection(session.id);
  assert.deepEqual(projection.state.tools, { calls: 1, results: 1, errors: 1, active: [], incomplete: false });
  assert.equal(projection.cursor, last.seq); assert.equal(projection.state.lastEvent.category, 'search');
  assert.equal(f.database.getTask(f.task.id).status, 'running');
  assert.doesNotMatch(JSON.stringify([f.read(), projection, f.database.executionEvidence({ taskId: f.task.id })]), /PRIVATE|web_search|OPAQUE_CODE|arguments/);
  end(session); assert.equal(f.read().worker.activity, '本轮执行已结束'); assert.equal(f.read().watermark.sessionSeq, session.seq - 1);
});

test('persisted completion overrides stale session activity and exposes no saving stage', async t => {
  const f = await fixture(t), session = f.worker.agent.session;
  turn(session); call(session);
  const evidence = { outcome: 'completed', completion: { kind: 'completed' }, instructionRevision: 1, runId: f.run.id, sessionId: session.id, summary: '完成结果' };
  f.database.updateRun(f.run.id, { ...f.ownership, state: 'verifying', evidence });
  assert.notEqual(f.read().phase, 'verifying');
  assert.doesNotMatch(f.read().worker.activity, /正在保存执行结果/);
  f.database.commitResult(f.task.id, { assignment: f.assignment, uniqueKey: 'completed-projection',
    status: 'completed', result: evidence });
  const projection = f.read();
  assert.equal(projection.phase, 'finished');
  assert.equal(projection.worker.status, 'completed');
  assert.equal(projection.worker.activity, '执行已结束');
});

test('worker activity retains ordered changes, deduplicates resets and replays cold official history', async t => {
  const f = await fixture(t), session = f.worker.agent.session;
  turn(session); call(session, 'read'); result(session); call(session, 'read'); result(session);
  call(session, 'write'); result(session, true); end(session);
  const history = f.read().worker.history;
  assert.deepEqual(history.map(row => row.activity), ['正在处理任务', '正在读取文件', '正在修改文件', '工具调用失败，正在处理', '本轮执行已结束']);
  assert(history.every((row, index) => Number.isSafeInteger(row.seq) && row.time && (!index || row.seq > history[index - 1].seq)));
  assert.equal(f.read().worker.historyTruncated, false);
  assert.doesNotMatch(JSON.stringify(history), /PRIVATE|arguments|read_file|write_file/);
  await f.restart({ clearProjection: true });
  assert.deepEqual(f.read().worker.history, history, 'a discarded display projection is rebuilt from the official log');
  assert.equal(f.database.getTask(f.task.id).status, 'running', 'a completed turn never completes the domain task');
});

test('executor public status survives tool and step resets, redacts secrets and replays from official history', async t => {
  const f = await fixture(t), session = f.worker.agent.session;
  let step = 1;
  const report = (text, extra = {}, type = 'assistant/message') => session.append(type, { turn: 1, step, stream: [],
    message: llm.createMessage({ role: 'assistant', content: [{ type: 'text', text }],
      source: { kind: 'model', provider: 'opaque-provider', model: 'opaque/model' } }), ...extra }, type === 'assistant/message' ? { surfaceOp: 'append' } : undefined);
  turn(session);
  report('进展：检查注册邮箱是否收到验证邮件');
  call(session, 'read'); result(session); session.append('step/end', { turn: 1, step });
  step = 2; session.append('step/start', { turn: 1, step });
  assert.equal(f.read().worker.activity, '检查注册邮箱是否收到验证邮件');
  assert.equal(f.read().worker.activitySource, 'report');
  report('进展：检查注册邮箱是否收到验证邮件');
  assert.equal(f.read().worker.history.filter(row => row.activitySource === 'report').length, 1);
  report('PRIVATE LONG OUTPUT\n' + '进展：' + '长'.repeat(121));
  assert.equal(f.read().worker.activity, '检查注册邮箱是否收到验证邮件');
  report('进展: 检查接口 token=PRIVATE_TOKEN\nPRIVATE OTHER BODY');
  assert.equal(f.read().worker.activity, '检查接口 token=[秘密已隐藏]');
  assert.doesNotMatch(JSON.stringify(f.database.getExecutionProjection(session.id)), /PRIVATE/);
  session.append('assistant/message', { turn: 1, step, stream: [], message: llm.createMessage({ role: 'assistant',
    content: [{ type: 'tool-call', id: 'failed-call', name: 'read', arguments: '{}' }],
    source: { kind: 'model', provider: 'opaque', model: 'opaque' } }) }, { surfaceOp: 'append' });
  session.append('tool/call', { turn: 1, step, callId: 'failed-call', name: 'read', arguments: '{}' });
  session.append('tool/result', { turn: 1, step, message: llm.createToolResultMessage({ callId: 'failed-call',
    content: [{ type: 'text', text: 'PRIVATE FAILURE' }], isError: true }) }, { surfaceOp: 'append' });
  assert.equal(f.read().worker.activity, '工具调用失败，正在处理');
  assert.equal(f.read().worker.activitySource, 'runtime');
  report('进展：验证邮件尚未收到，等待重试');
  session.append('step/end', { turn: 1, step }); session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  const history = f.read().worker.history;
  assert.equal(history.at(-1).activitySource, 'runtime');
  await f.restart({ clearProjection: true });
  const recovered = await f.host.ctx.sessionQuery.observeSession('worker'); recovered[Symbol.dispose]();
  assert.deepEqual(f.read().worker.history, history);
});

test('only explicit complete public status lines enter the projection', () => {
  const event = { type: 'assistant/message', data: { message: { role: 'assistant', source: { kind: 'model' },
    content: [{ type: 'text', text: '进展：检查验证邮件' }] } } };
  assert.equal(publicExecutionActivity(event), '检查验证邮件');
  for (const patch of [{ parentCallId: 'nested' }, { interrupted: true }]) {
    assert.equal(publicExecutionActivity({ ...event, data: { ...event.data, ...patch } }), '');
  }
  assert.equal(publicExecutionActivity({ ...event, type: 'assistant/attempt' }), '');
  assert.equal(publicExecutionActivity({ type: 'assistant/message' }), '');
  for (const content of [[{ type: 'reasoning', text: '进展：PRIVATE REASONING' }],
    [{ type: 'text', text: '普通正文与最终结果' }], [{ type: 'text', text: '进展：' + '长'.repeat(121) }],
    [{ type: 'text', text: '```text\n进展：文档中的示例\n```' }], [{ type: 'text', text: '~~~\n进展：文档中的示例\n~~~' }]]) {
    assert.equal(publicExecutionActivity({ ...event, data: { ...event.data, message: { ...event.data.message, content } } }), '');
  }
});

test('new turns reset the prior report and child reports use the same projection', async t => {
  const f = await fixture(t), parent = f.worker.agent.session;
  turn(parent); catalog(parent, 'report-child');
  const child = await f.createAgent('report-child', { origin: 'subagent', parentSession: parent.id, delegationDepth: 1 });
  const session = child.agent.session;
  turn(session);
  session.append('assistant/message', { turn: 1, step: 1, stream: [], message: llm.createMessage({ role: 'assistant',
    content: [{ type: 'reasoning', text: '进展：PRIVATE REASONING' }, { type: 'text', text: '进展：验证项目构建结果' }],
    source: { kind: 'model', provider: 'opaque', model: 'opaque' } }) }, { surfaceOp: 'append' });
  assert.equal(f.database.getExecutionProjection(session.id).state.activity, '验证项目构建结果');
  assert.equal(f.read().children[0].history.at(-1).activitySource, 'report');
  end(session); turn(session, 2);
  assert.equal(f.database.getExecutionProjection(session.id).state.activitySource, 'runtime');
  assert.equal(f.database.getExecutionProjection(session.id).state.activity, '正在处理任务');
  assert.doesNotMatch(JSON.stringify(f.database.getExecutionProjection(session.id)), /PRIVATE REASONING/);
});

test('bounded main and child history exposes truncation and excludes history before the current run', async t => {
  const f = await fixture(t), parent = f.worker.agent.session;
  turn(parent);
  for (let index = 0; index < 70; index++) { call(parent, index % 2 ? 'write' : 'read'); result(parent); }
  const worker = f.read().worker;
  assert.equal(worker.history.length, 64); assert.equal(worker.historyTruncated, true);
  assert.equal(worker.history.at(-1).activity, '正在修改文件');
  catalog(parent, 'history-child');
  const child = await f.createAgent('history-child', { origin: 'subagent', parentSession: parent.id, delegationDepth: 1 });
  turn(child.agent.session); call(child.agent.session, 'web_fetch'); result(child.agent.session); end(child.agent.session);
  const childHistory = f.read().children[0].history;
  assert.deepEqual(childHistory.map(row => row.activity), ['正在处理任务', '正在读取网页', '本轮执行已结束']);
  assert.equal(f.read().children[0].historyTruncated, false);
  const projection = f.database.getExecutionProjection(parent.id);
  const earliest = '2000-01-01T00:00:00.000Z';
  f.database.recordExecutionProjection({ ...projection, state: { ...projection.state,
    activityHistory: [{ seq: 0, time: earliest, status: 'running', activity: '旧执行活动' }, ...projection.state.activityHistory.slice(-63)] } });
  assert.equal(f.read().worker.history.some(row => row.activity === '旧执行活动'), false);
  assert.doesNotMatch(JSON.stringify([f.read(), f.database.getExecutionProjection(parent.id)]), /PRIVATE|arguments/);
});

test('events arriving after the immutable recovery cut survive startup and duplicate/late notifications', async t => {
  const f = await fixture(t, { begin: false }), session = f.worker.agent.session;
  turn(session); const old = call(session);
  const original = f.host.ctx.sessionQuery.observeSession.bind(f.host.ctx.sessionQuery);
  let cut, newest;
  f.host.ctx.sessionQuery.observeSession = async (...args) => {
    const observation = await original(...args);
    if (!newest && args[0] === session.id) { cut = observation.cursor; newest = result(session); }
    return observation;
  };
  await f.start();
  assert.equal(f.read().watermark.sessionSeq > cut, true); assert.equal(f.database.getExecutionProjection(session.id).state.tools.results, 1);
  const before = f.database.executionFactCursor();
  f.notify(session, newest); f.notify(session, old); f.notify(session, newest);
  assert.equal(f.database.getExecutionProjection(session.id).cursor, newest.seq);
  assert.equal(f.database.getExecutionProjection(session.id).state.tools.calls, 1);
  assert.equal(f.database.executionFactCursor(), before);
});

test('child lifecycle outcome survives a real host and DB restart without replaying work', async t => {
  const f = await fixture(t), parent = f.worker.agent.session;
  turn(parent); catalog(parent, 'child');
  const child = await f.createAgent('child', { origin: 'subagent', parentSession: parent.id, delegationDepth: 1 });
  turn(child.agent.session); end(child.agent.session);
  f.host.ctx.emit('subagent/start', { id: 'child', parentSessionId: parent.id, runId: 'activation' });
  f.host.ctx.emit('subagent/end', { id: 'child', parentSessionId: parent.id, runId: 'activation', stopReason: 'error' });
  notice(parent, 'child'); end(parent); assert.equal(f.read().children[0].status, 'failed');
  await f.restart();
  assert.equal(f.read().children[0].id, 'child'); assert.equal(f.read().children[0].status, 'failed');
  assert.equal(f.read().children[0].activationId, 'activation'); assert.equal(f.read().completeness, 'complete', JSON.stringify({ diagnostics: f.progress.diagnostics(), projections: f.database.executionProjections() }));
  assert.equal(f.database.getExecutionProjection('worker').sourceDurability, 'persisted');
  assert.equal(f.host.ctx.agents.list().length, 0); assert.doesNotMatch(JSON.stringify(f.read()), /PRIVATE/);
});

test('official cold logs rebuild a discarded projection and historical child without a transcript copy', async t => {
  const f = await fixture(t), parent = f.worker.agent.session;
  turn(parent); call(parent, 'read'); result(parent); catalog(parent, 'historical-child');
  const child = await f.createAgent('historical-child', { origin: 'subagent', parentSession: parent.id, delegationDepth: 1 });
  turn(child.agent.session); end(child.agent.session); notice(parent, child.agent.id); end(parent);
  await f.restart({ clearProjection: true });
  const observation = await f.host.ctx.sessionQuery.observeSession('worker'); observation[Symbol.dispose]();
  assert.equal(f.read().children[0].id, 'historical-child'); assert.equal(f.read().children[0].status, 'completed');
  assert.equal(f.read().completeness, 'complete'); assert.equal(f.database.getExecutionProjection('worker').state.tools.calls, 1);
  const raw = new DatabaseSync(f.database.path, { readOnly: true });
  try { assert.doesNotMatch(JSON.stringify(raw.prepare('SELECT payload FROM sa_execution_projection').all()), /PRIVATE|transcript|arguments/); }
  finally { raw.close(); }
  assert.equal(f.host.ctx.sessions.get('worker'), undefined);
});

test('missing child history stays visible and incomplete', async t => {
  const f = await fixture(t), parent = f.worker.agent.session;
  turn(parent); catalog(parent, 'missing-child'); end(parent); await f.progress.recover(parent.id);
  assert.equal(f.read().childCounts.total, 1); assert.equal(f.read().children[0].id, 'missing-child');
  assert.equal(f.read().children[0].status, 'unknown'); assert.equal(f.read().completeness, 'partial');
  assert.match(f.read().limitation, /不可恢复/); assert.equal(f.progress.diagnostics().recoveryFailures, 1);
});

test('current requirements and applied requirements remain distinct on the same Run', async t => {
  const f = await fixture(t), session = f.worker.agent.session; turn(session); call(session); result(session);
  const source = { ...f.source, messageId: 'revision' };
  const { trigger } = f.database.ingest({ dedupeKey: 'revision', thread: { id: f.task.threadId, source: { type: 'desktop', id: 'owner' } }, source,
    actor: { kind: 'human', id: 'desktop-owner' }, content: 'revision', mode: 'direct' });
  f.database.changeTask(f.task.id, { operation: 'revise', expectedInstructionRevision: 1, target: 'PRIVATE REVISED TARGET', acceptance: 'PRIVATE REVISED CHECK',
    reason: 'correction', requestKey: 'revision', triggerId: trigger.id, model: { providerId: 'opaque', modelId: 'Opaque/ID' },
    mandate: { ...f.mandate, source, instruction: 'revision' }, validateMandate: () => true });
  assert.equal(f.read().instructionRevision, 2); assert.equal(f.read().appliedInstructionRevision, 1); assert.equal(f.read().runId, f.run.id);
  assert.equal(f.database.pendingTaskInputs(f.task.id).length, 1);
  f.database.applyTaskRevision(f.assignment.id, { ...f.ownership, runId: f.run.id, boundaryId: 'next-step' });
  assert.equal(f.read().appliedInstructionRevision, 2); assert.equal(f.read().runId, f.run.id);
});

test('ordinary fork lineage, stale child activation and disposed observers cannot create false progress', async t => {
  const f = await fixture(t), parent = f.worker.agent.session;
  const fork = await f.createAgent('ordinary-fork', { parentSession: parent.id }); turn(fork.agent.session); end(fork.agent.session);
  assert.equal(f.database.getExecutionProjection(fork.agent.id), null); assert.equal(f.read().childCounts.total, 0);
  const child = await f.createAgent('child', { origin: 'subagent', parentSession: parent.id, delegationDepth: 1 }); catalog(parent, child.agent.id);
  f.host.ctx.emit('subagent/start', { id: 'child', parentSessionId: parent.id, runId: 'old' });
  f.host.ctx.emit('subagent/start', { id: 'child', parentSessionId: parent.id, runId: 'new' });
  const before = f.database.executionFactCursor();
  f.host.ctx.emit('subagent/end', { id: 'child', parentSessionId: parent.id, runId: 'old', stopReason: 'completed' });
  assert.equal(f.database.executionFactCursor(), before); assert.equal(f.database.getExecutionProjection('child').live.activationId, 'new');
  f.host.ctx.emit('subagent/end', { id: 'child', parentSessionId: parent.id, runId: 'new', stopReason: 'aborted' });
  assert.equal(f.read().children[0].status, 'cancelled');
  await f.progress.dispose(); const stopped = f.database.executionFactCursor(); turn(parent); end(parent);
  f.host.ctx.emit('subagent/start', { id: 'unseen-child', parentSessionId: parent.id, runId: 'late' });
  assert.equal(f.database.executionFactCursor(), stopped); assert.equal(f.database.getExecutionProjection('unseen-child'), null);
});

test('cold interrupted-turn repair is observation evidence and never a completed Task or flush claim', async t => {
  const f = await fixture(t), session = f.worker.agent.session;
  turn(session); call(session, 'read');
  const sourceEnd = session.seq - 1;
  await f.restart({ clearProjection: true });
  const saved = f.database.getExecutionProjection('worker');
  assert.equal(saved.cursor > sourceEnd, true, 'official observation adds interrupted-turn closers');
  assert.equal(saved.sourceDurability, 'persisted'); assert.equal(saved.flushedCursor, -1);
  assert.equal(f.read().worker.status, 'unknown'); assert.notEqual(f.read().phase, 'finished');
  assert.equal(f.database.getTask(f.task.id).status, 'running');
  assert.equal(f.database.runs(f.assignment.id)[0].state, 'submitted');
  assert.equal(f.host.ctx.agents.list().length, 0);
});

test('runtime evidence uses the shared source and domain commit signals with redacted requirements', async t => {
  const f = await fixture(t, { target: '检查执行 token=PRIVATE_TARGET', acceptance: '验证结果 api_key=PRIVATE_ACCEPTANCE' }), session = f.worker.agent.session;
  turn(session); call(session); result(session); end(session); await f.progress.dispose();
  const { createOrchestrationRuntime } = await import('../src/orchestration-runtime.mjs');
  const runtime = createOrchestrationRuntime({ ctx: f.host.ctx,
    store: { orchestration: f.database, paths: { workspace: f.directory }, getConfig: async () => ({ workerConcurrency: 1 }) },
    execute: async () => { throw new Error('Evidence reads must not execute a Worker'); } });
  try {
    await runtime.executionFacts.ready;
    const snapshot = runtime.executionFacts.evidenceSnapshot();
    assert.equal(snapshot.executions.length, 1); assert.equal(snapshot.schedulerHeartbeat, null);
    const evidence = snapshot.executions[0];
    assert.equal(evidence.task.id, f.task.id); assert.equal(evidence.run.id, f.run.id);
    assert.equal(evidence.assignment.fence, f.assignment.fence); assert.equal(typeof evidence.assignment.leaseUntil, 'number');
    assert.equal(evidence.executionAlive.status, 'idle'); assert.equal(evidence.request.state, 'unknown');
    assert.equal(evidence.request.deadline, null);
    assert.equal(evidence.watermarks[0].sourceSeq, session.seq - 1);
    assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE|arguments|opaque-provider|opaque\/model/);
    assert.throws(() => runtime.executionFacts.evidence({ taskId: f.task.id, runId: 'foreign-run' }), { code: 'EXECUTION_FACT_BINDING' });
    const before = runtime.executionFacts.currentCursor(), committed = [];
    const unsubscribe = runtime.executionFacts.subscribe(value => committed.push(value));
    f.database.pauseTask(f.task.id);
    await Promise.resolve(); unsubscribe();
    assert.equal(committed.length, 1); assert.equal(committed[0] > before, true);
    assert.equal(runtime.executionFacts.page({ after: before }).entries.some(row => row.kind === 'task' && row.taskId === f.task.id), true);
    assert.equal(runtime.executionFacts.evidenceSnapshot().executions[0].wait.kind, 'paused');
    assert.equal(runtime.executionFacts.snapshot({ taskId: f.task.id }).tasks[0].execution.watermark.sessionSeq, session.seq - 1);
  } finally { await runtime.stop(); }
});

test('official live jobs prove only execution-owned background work, without inventing deadlines or artifact progress', async t => {
  const f = await fixture(t, { target: '检查执行 token=PRIVATE_TARGET', acceptance: '验证结果 api_key=PRIVATE_ACCEPTANCE' });
  await f.progress.dispose();
  const Jobs = await import(pathToFileURL(join(official, 'packages/jobs/jobs-local/lib/index.js')).href);
  await f.host.ctx.plugin(Jobs.default || Jobs);
  f.host.ctx.jobs.attachController('execution-facts-test');
  const { createOrchestrationRuntime } = await import('../src/orchestration-runtime.mjs');
  const runtime = createOrchestrationRuntime({ ctx: f.host.ctx,
    store: { orchestration: f.database, paths: { workspace: f.directory }, getConfig: async () => ({ workerConcurrency: 1 }) },
    execute: async () => { throw new Error('Evidence reads must not execute a Worker'); } });
  function start(owner) {
    const done = Promise.withResolvers();
    const id = f.host.ctx.jobs.start({ kind: 'bash', label: 'PRIVATE COMMAND', ...(owner ? { owner } : {}),
      run(job) { job.append('PRIVATE OUTPUT'); job.updateProgress('PRIVATE PROGRESS');
        return { done: done.promise, cancel() { done.resolve({ status: 'killed' }); } }; } });
    return { id, async settle() { done.resolve({ status: 'completed' }); await done.promise; await Promise.resolve(); } };
  }
  const read = () => runtime.executionFacts.evidence({ taskId: f.task.id }).runtime;
  try {
    await runtime.executionFacts.ready;
    start(); // Official list(owner) includes this unowned job: explicitly exclude it.
    const foreign = await f.createAgent('foreign'); start(foreign.agent.id);
    assert.equal(read().wait.kind, 'none');
    const own = start(f.run.sessionId), expectedSince = new Date(f.host.ctx.jobs.get(own.id, f.run.sessionId).startedAt).toISOString();
    assert.deepEqual(read().wait, { kind: 'background-job', since: expectedSince, expectedUntil: null });
    const evidence = read();
    assert.equal(evidence.request.deadline, null);
    assert.doesNotMatch(JSON.stringify(read()), /PRIVATE|label|progress|spillPaths/);
    await own.settle();
    assert.equal(read().wait.kind, 'none');
    const child = await f.createAgent('job-child', { origin: 'subagent', parentSession: f.run.sessionId, delegationDepth: 1 });
    catalog(f.worker.agent.session, child.agent.id); start(child.agent.id);
    assert.equal(read().wait.kind, 'background-job');
    f.database.pauseTask(f.task.id);
    assert.equal(read().wait.kind, 'paused', 'explicit waits retain priority over background work');
  } finally { await runtime.stop(); }
});
