import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { createAssistantRuntimeStore } from '../src/runtime-store.mjs';
import { createTaskManagement } from '../src/task-management.mjs';
import { createExecutionSessionTitles } from '../src/execution-session-title.mjs';

const latestTitle = events => {
  const event = events.findLast(item => item.type === 'session/title');
  return event && { ...event.data, eventSeq: event.seq, updatedAt: event.time };
};
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-execution-titles-'));
  const database = createAssistantOrchestrationStore({ directory });
  let metadata = createAssistantRuntimeStore({ directory });
  const live = new Map(), stored = new Map(), listeners = new Map(), cached = new Map();
  const services = [], warnings = [], operations = [];
  const failures = {};
  const ctx = {
    get(name) { return this[name]; },
    logger: { warn: (...args) => warnings.push(args) },
    on(name, listener) {
      const rows = listeners.get(name) || new Set();
      rows.add(listener); listeners.set(name, rows);
      return () => rows.delete(listener);
    },
    async emit(name, ...args) { for (const listener of listeners.get(name) || []) await listener(...args); },
    sessions: {
      get: id => live.get(id),
      async flush(session) {
        operations.push(['live-flush', session.id]);
        if (failures.flush) throw failures.flush;
        stored.set(session.id, { header: session.header, inheritedEventCount: 0, events: structuredClone(session.snapshotEvents()) });
        return true;
      },
      prepare(id, input) {
        operations.push(['prepare', id]);
        assert.equal(live.has(id), false, 'cache preparation must not create a live execution');
        return { id, header: { ...input.meta, id }, inheritedEventCount: input.inheritedEventCount,
          snapshotEvents: () => input.seed, seq: input.seed.length };
      },
    },
    sessionTitle: {
      get: session => latestTitle(session.snapshotEvents()),
      rename(session, title) {
        assert.equal(live.get(session.id), session, 'official rename only accepts its live Session');
        operations.push(['rename', session.id, title]);
        session.append('session/title', { title, messageSeqs: [], source: { kind: 'user' } });
        return latestTitle(session.snapshotEvents());
      },
    },
    sessionPersistence: {
      async stat(id) { return stored.get(id)?.header; },
      async open(id, access) {
        operations.push(['open', id, access]);
        if (failures.open) throw failures.open;
        const row = stored.get(id);
        if (!row) throw Object.assign(new Error('missing session'), { code: 'SESSION_NOT_FOUND' });
        assert.equal(access, 'write');
        return {
          id, header: row.header, inheritedEventCount: row.inheritedEventCount,
          async read() {
            if (failures.readGate) await failures.readGate;
            return { events: structuredClone(row.events), eventState: 'shared-frozen' };
          },
          async append(events) {
            operations.push(['append', id]);
            assert.equal(events[0].seq, row.events.length);
            row.events.push(...structuredClone(events));
          },
          async flush() {
            operations.push(['cold-flush', id]);
            if (failures.flush) throw failures.flush;
          },
          async close() { operations.push(['close', id]); },
        };
      },
    },
    sessionProjectionCache: {
      async write(prepared) {
        operations.push(['cache-write', prepared.id]);
        if (failures.cache) throw failures.cache;
        cached.set(prepared.id, latestTitle(prepared.snapshotEvents())?.title);
      },
    },
  };
  database.createThread({ id: 'thread', source: { type: 'desktop', id: 'owner' } });
  let index = 0;
  function task({ title = '修复登录异常', project = false } = {}) {
    const n = ++index;
    const value = database.createTask({ threadId: 'thread', title, target: `inspect original requirement ${n}`,
      mandate: { source: { channel: 'desktop', sessionId: 'owner' }, ...(project ? { project: { id: 'project', path: join(directory, 'project') } } : {}) } });
    database.createAssignment(value.id, { id: `desktop:opaque-${n}`, text: value.target });
    const [assignment] = database.claimAssignments(`owner-${n}`, { validateMandate: () => true });
    const runDirectory = join(directory, 'workers', encodeURIComponent(assignment.id));
    const run = database.prepareRun(assignment.id, { owner: assignment.owner, fence: assignment.fence,
      sessionId: `worker-${n}`, directory: runDirectory, workingDirectory: project ? join(directory, 'project') : runDirectory });
    return { task: value, assignment, run };
  }
  function session(binding, { title, source = 'fallback', cold = false, id = binding.run.sessionId, parentSession, cwd } = {}) {
    const events = [];
    const header = { id, createdAt: Date.now(), cwd: cwd || binding.run.workingDirectory,
      ...(parentSession ? { parentSession, origin: 'subagent' } : {}) };
    const value = { id, header, snapshotEvents: () => events,
      append(type, data) { events.push({ seq: events.length, time: Date.now(), type, data }); } };
    if (title !== undefined) value.append('session/title', { title, messageSeqs: [],
      source: source === 'provider' ? { kind: 'provider', provider: 'existing-provider' } : { kind: source } });
    stored.set(id, { header, inheritedEventCount: 0, events: structuredClone(events) });
    if (!cold) live.set(id, value);
    return value;
  }
  function start() {
    const service = createExecutionSessionTitles({ ctx, database, metadata });
    services.push(service);
    return service;
  }
  async function rename(service, binding, title) {
    let pending;
    const management = createTaskManagement({ database: metadata, orchestration: database,
      onTaskRename: id => { pending = service.syncTask(id); } });
    const current = management.project('task', [database.getTask(binding.task.id)])[0];
    management.update({ kind: 'task', id: binding.task.id, operation: 'rename', title, version: current.taskMeta.version });
    assert.ok(pending, 'task management must notify the session-title synchronizer after rename');
    await pending;
  }
  t.after(async () => {
    for (const service of services) await service.dispose();
    database.close(); metadata.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { ctx, database, get metadata() { return metadata; }, directory, live, stored, cached, operations, warnings,
    failures, task, session, start, rename,
    reopenMetadata() { metadata.close(); metadata = createAssistantRuntimeStore({ directory }); } };
}

test('new root executions use the current task title before their first message', async t => {
  const f = await fixture(t), service = f.start();
  await service.ready;
  const binding = f.task(), session = f.session(binding);
  await f.ctx.emit('agent/created', { agent: { id: session.id, session } });
  assert.equal(f.ctx.sessionTitle.get(session).title, '修复登录异常');
  assert.equal(session.snapshotEvents().filter(event => event.type === 'user/message').length, 0);
  await f.rename(service, binding, '整理发布文档');
  assert.equal(f.ctx.sessionTitle.get(session).title, '整理发布文档');
  assert.equal(f.database.getTask(binding.task.id).target, binding.task.target);
  assert.equal(f.database.runs(binding.assignment.id)[0].directory, binding.run.directory);
});

test('initial titles prefer persisted task presentation and repeated sync is idempotent', async t => {
  const f = await fixture(t), binding = f.task(), session = f.session(binding);
  const management = createTaskManagement({ database: f.metadata, orchestration: f.database });
  management.update({ kind: 'task', id: binding.task.id, operation: 'rename', title: '处理保存故障', version: 0 });
  const service = f.start();
  await service.ready;
  assert.equal(f.ctx.sessionTitle.get(session).title, '处理保存故障');
  const count = session.snapshotEvents().length;
  await Promise.all([service.syncTask(binding.task.id), service.syncTask(binding.task.id)]);
  assert.equal(session.snapshotEvents().length, count);
  assert.equal(f.warnings.length, 0);
});

test('managed titles still follow task renames after service and metadata reopen', async t => {
  const f = await fixture(t), binding = f.task(), session = f.session(binding);
  const first = f.start(); await first.ready; await first.dispose();
  const count = session.snapshotEvents().length;
  f.reopenMetadata();
  const second = f.start(); await second.ready;
  assert.equal(session.snapshotEvents().length, count, 'restart must not append an identical managed title');
  await f.rename(second, binding, '完善错误提示');
  assert.equal(f.ctx.sessionTitle.get(session).title, '完善错误提示');
});

test('explicit titles and later manual renames, including identical text, always win', async t => {
  const f = await fixture(t);
  const existing = f.task(), existingSession = f.session(existing, { title: '人工保留标题', source: 'user' });
  const different = f.task(), differentSession = f.session(different);
  const same = f.task(), sameSession = f.session(same);
  const service = f.start(); await service.ready;
  f.ctx.sessionTitle.rename(differentSession, '我自己的名称');
  f.ctx.sessionTitle.rename(sameSession, f.ctx.sessionTitle.get(sameSession).title);
  await f.rename(service, existing, '工单重新命名');
  await f.rename(service, different, '工单重新命名');
  await f.rename(service, same, '工单重新命名');
  assert.equal(f.ctx.sessionTitle.get(existingSession).title, '人工保留标题');
  assert.equal(f.ctx.sessionTitle.get(differentSession).title, '我自己的名称');
  assert.equal(f.ctx.sessionTitle.get(sameSession).title, '修复登录异常');
});

test('legacy repair targets exact internal directory labels and preserves useful automatic titles', async t => {
  const f = await fixture(t), cases = [];
  for (const source of ['fallback', 'provider', 'user']) {
    const binding = f.task(), old = encodeURIComponent(binding.assignment.id);
    cases.push({ binding, old, source, session: f.session(binding, { title: old, source }) });
  }
  const useful = f.task(), usefulSession = f.session(useful, { title: '已有语义标题', source: 'provider' });
  const project = f.task({ project: true }), projectSession = f.session(project, { title: 'project', source: 'fallback' });
  const almost = f.task(), almostTitle = encodeURIComponent(almost.assignment.id) + '-other';
  const almostSession = f.session(almost, { title: almostTitle });
  const service = f.start(); await service.ready;
  for (const row of cases) assert.equal(f.ctx.sessionTitle.get(row.session).title, row.source === 'user' ? row.old : row.binding.task.title);
  assert.equal(f.ctx.sessionTitle.get(usefulSession).title, '已有语义标题');
  assert.equal(f.ctx.sessionTitle.get(projectSession).title, 'project');
  assert.equal(f.ctx.sessionTitle.get(almostSession).title, almostTitle);
});

test('cold repair and task rename flush the existing log and refresh the official cache', async t => {
  const f = await fixture(t), binding = f.task();
  f.session(binding, { cold: true });
  const service = f.start(); await service.ready;
  const row = f.stored.get(binding.run.sessionId);
  assert.equal(latestTitle(row.events).title, binding.task.title);
  assert.equal(f.cached.get(binding.run.sessionId), binding.task.title);
  await f.rename(service, binding, '冷会话新名称');
  assert.equal(latestTitle(row.events).title, '冷会话新名称');
  assert.equal(f.cached.get(binding.run.sessionId), '冷会话新名称');
  assert.equal(f.live.size, 0, 'cold title repair must not create an execution agent or live Session');
  const stages = f.operations.map(([name]) => name);
  assert.equal(stages.filter(name => name === 'open').length, stages.filter(name => name === 'close').length);
  assert.ok(stages.indexOf('cold-flush') < stages.indexOf('cache-write'));
});

test('cold ownership conflicts warn without preventing a task rename or retry', async t => {
  const f = await fixture(t), binding = f.task();
  f.session(binding, { cold: true });
  f.failures.open = Object.assign(new Error('writer already active'), { code: 'SESSION_WRITE_CONFLICT' });
  const service = f.start(); await service.ready;
  await f.rename(service, binding, '仍然保存任务名');
  assert.ok(f.warnings.length > 0);
  assert.equal(f.stored.get(binding.run.sessionId).events.length, 0);
  delete f.failures.open;
  await service.syncTask(binding.task.id);
  assert.equal(latestTitle(f.stored.get(binding.run.sessionId).events).title, '仍然保存任务名');
});

test('a failed cold flush closes its writer and never publishes an unflushed cache', async t => {
  const f = await fixture(t), binding = f.task();
  f.session(binding, { cold: true });
  f.failures.flush = new Error('disk unavailable');
  const service = f.start(); await service.ready;
  assert.ok(f.warnings.length > 0);
  assert.equal(f.cached.has(binding.run.sessionId), false);
  assert.equal(f.operations.filter(([name]) => name === 'open').length, f.operations.filter(([name]) => name === 'close').length);
  delete f.failures.flush;
  await service.syncTask(binding.task.id);
  assert.equal(f.cached.get(binding.run.sessionId), binding.task.title, 'an accepted append must stay managed across a flush retry');
  assert.equal(f.operations.filter(([name]) => name === 'append').length, 1, 'retry must flush the accepted title rather than append a duplicate');
  assert.equal(f.operations.filter(([name]) => name === 'cold-flush').length, 2);
  await f.rename(service, binding, '存储恢复后改名');
  assert.equal(f.cached.get(binding.run.sessionId), '存储恢复后改名');
});

test('native children and unrelated sessions retain their own titles', async t => {
  const f = await fixture(t), binding = f.task(), root = f.session(binding);
  const child = f.session(binding, { id: 'native-child', parentSession: root.id });
  const unrelated = f.session(binding, { id: 'ordinary-chat' });
  const service = f.start(); await service.ready;
  await f.ctx.emit('agent/created', { agent: { id: child.id, session: child } });
  await f.ctx.emit('agent/created', { agent: { id: unrelated.id, session: unrelated } });
  await service.syncTask(binding.task.id);
  assert.equal(f.ctx.sessionTitle.get(root).title, binding.task.title);
  assert.equal(f.ctx.sessionTitle.get(child), undefined);
  assert.equal(f.ctx.sessionTitle.get(unrelated), undefined);
});

test('dispose drains a cold read and prevents late writes and new subscriptions', async t => {
  const f = await fixture(t), binding = f.task();
  f.session(binding, { cold: true });
  let release;
  f.failures.readGate = new Promise(resolve => { release = resolve; });
  const service = f.start();
  for (let i = 0; i < 20 && !f.operations.some(([name]) => name === 'open'); i++) await tick();
  assert.ok(f.operations.some(([name]) => name === 'open'));
  let disposed = false;
  const closing = Promise.resolve(service.dispose()).then(() => { disposed = true; });
  await tick(); assert.equal(disposed, false, 'dispose must wait for its cold writer to close');
  release(); await closing; await service.ready;
  assert.equal(f.stored.get(binding.run.sessionId).events.length, 0);
  assert.equal(f.operations.filter(([name]) => name === 'close').length, 1);
  const next = f.task(), nextSession = f.session(next);
  await f.ctx.emit('agent/created', { agent: { id: nextSession.id, session: nextSession } });
  await service.syncTask(next.task.id);
  assert.equal(f.ctx.sessionTitle.get(nextSession), undefined);
});
