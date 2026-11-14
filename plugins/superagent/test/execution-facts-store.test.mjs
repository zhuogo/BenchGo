import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { installExecutionFactsStore } from '../src/execution-facts-store.mjs';

const at = '2026-11-09T08:00:00.000Z';
function fixture(t, filename = ':memory:') {
  const db = new DatabaseSync(filename);
  db.exec(`CREATE TABLE IF NOT EXISTS sa_tasks(id TEXT PRIMARY KEY,status TEXT,instruction_revision INTEGER,target TEXT);
    CREATE TABLE IF NOT EXISTS sa_assignments(id TEXT PRIMARY KEY,task_id TEXT,payload TEXT,fence INTEGER,state TEXT,created_at TEXT);
    CREATE TABLE IF NOT EXISTS sa_runs(id TEXT PRIMARY KEY,assignment_id TEXT,payload TEXT,fence INTEGER,state TEXT,created_at TEXT);
    CREATE TABLE IF NOT EXISTS sa_results(task_id TEXT,version INTEGER,payload TEXT);
    CREATE TABLE IF NOT EXISTS sa_outbox(id TEXT PRIMARY KEY,task_id TEXT,payload TEXT,state TEXT);
    CREATE TABLE IF NOT EXISTS sa_attentions(id TEXT PRIMARY KEY,task_id TEXT,assignment_id TEXT,session_id TEXT,instruction_revision INTEGER,question TEXT);
    CREATE TABLE IF NOT EXISTS sa_attention_resolutions(id TEXT PRIMARY KEY,task_id TEXT,assignment_id TEXT,session_id TEXT,instruction_revision INTEGER,resolution TEXT);
    CREATE TABLE IF NOT EXISTS sa_task_inputs(id TEXT PRIMARY KEY,task_id TEXT,instruction_revision INTEGER,snapshot TEXT,state TEXT);
    CREATE TABLE IF NOT EXISTS sa_task_boundaries(assignment_id TEXT,run_id TEXT,boundary_id TEXT,snapshot TEXT);
    CREATE TABLE IF NOT EXISTS task_meta(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE IF NOT EXISTS assistant_goals(id TEXT PRIMARY KEY,payload TEXT,status TEXT);`);
  let store, closed = false;
  const tx = fn => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); store?.flushExecutionFactChanges(); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  store = installExecutionFactsStore({ db, tx });
  const close = () => { if (!closed) { closed = true; store.disposeExecutionFacts(); db.close(); } };
  t.after(close);
  const seed = (suffix = 'a') => tx(() => {
    db.prepare('INSERT INTO sa_tasks VALUES (?,?,?,?)').run(`task-${suffix}`, 'running', 1, 'PRIVATE TARGET');
    db.prepare('INSERT INTO sa_assignments VALUES (?,?,?,?,?,?)').run(`assignment-${suffix}`, `task-${suffix}`, JSON.stringify({ instructionRevision: 1, text: 'PRIVATE TASK' }), 1, 'claimed', at);
    db.prepare('INSERT INTO sa_runs VALUES (?,?,?,?,?,?)').run(`run-${suffix}`, `assignment-${suffix}`, JSON.stringify({ sessionId: `session-${suffix}`, instructionRevision: 1, directory: process.cwd() }), 1, 'running', at);
  });
  return { db, tx, store, seed, close };
}
function projection(suffix = 'a', patch = {}) {
  return { sessionId: `session-${suffix}`, cursor: 7, flushedCursor: -1, complete: true,
    state: { inheritedEventCount: 0, status: 'running', activity: '正在处理任务', updatedAt: at, turn: 1, step: 2,
      request: { state: 'settled', startedAt: at, settledAt: at },
      tools: { calls: 1, results: 1, errors: 0, active: [] }, children: [], milestones: [],
      lastEvent: { seq: 7, kind: 'tool/result', time: at, category: 'file' } },
    live: { status: 'running', observedAt: at, bootId: 'boot-1' },
    fact: { kind: 'tool/result', category: 'file', counts: { calls: 1, results: 1, errors: 0 }, evidenceRefs: [{ sessionId: `session-${suffix}`, seq: 7 }] },
    ...patch };
}

test('public chat identities share the durable journal without text and deduplicate per request', async t => {
  const f = fixture(t), observed = [];
  f.store.onExecutionFacts(cursor => observed.push(cursor));
  const input = { sessionId: 'router', sourceSeq: 3, threadId: 'main', requestId: 'request', text: 'PRIVATE REPLY', tool: 'PRIVATE TOOL' };
  assert.deepEqual(f.store.recordChatPublication(input), { seq: 1, duplicate: false });
  assert.deepEqual(f.store.recordChatPublication({ ...input, sourceSeq: 5 }), { seq: 1, duplicate: true });
  assert.equal(f.store.executionFactCursor(), 1);
  const page = f.store.executionFactPage({ after: 0 });
  assert.equal(page.entries[0].kind, 'chat'); assert.equal(page.entries[0].data.operation, 'insert');
  assert.equal(page.entries[0].data.requestId, 'request'); assert.doesNotMatch(JSON.stringify(page), /PRIVATE/);
  f.store.recordChatPublication({ sessionId: 'router', sourceSeq: 7, threadId: 'main', mirrorKey: 'request' });
  assert.equal(f.store.executionFactCursor(), 2, 'request and channel identities cannot collide');
  await new Promise(setImmediate); assert.deepEqual(observed, [2]);
});
test('domain changes share an atomic dense journal and omit every private domain payload', t => {
  const f = fixture(t); f.seed();
  const baseline = f.store.executionFactCursor();
  assert.equal(baseline, 3);
  assert.throws(() => f.tx(() => { f.db.prepare('UPDATE sa_tasks SET status=? WHERE id=?').run('waiting', 'task-a'); throw new Error('rollback'); }), /rollback/);
  assert.equal(f.store.executionFactCursor(), baseline);
  f.tx(() => f.db.exec("UPDATE sa_tasks SET status=status WHERE id='task-a'"));
  assert.equal(f.store.executionFactCursor(), baseline, 'no-op updates have no display event');
  f.tx(() => {
    f.db.exec("UPDATE sa_tasks SET status='waiting' WHERE id='task-a'");
    f.db.prepare('INSERT INTO sa_results VALUES (?,?,?)').run('task-a', 1, JSON.stringify({ summary: 'PRIVATE RESULT' }));
    f.db.prepare('INSERT INTO sa_outbox VALUES (?,?,?,?)').run('outbox', 'task-a', JSON.stringify({ text: 'PRIVATE DELIVERY' }), 'queued');
    f.db.prepare('INSERT INTO sa_attentions VALUES (?,?,?,?,?,?)').run('attention', 'task-a', 'assignment-a', 'session-a', 1, 'PRIVATE QUESTION');
    f.db.prepare('INSERT INTO sa_attention_resolutions VALUES (?,?,?,?,?,?)').run('answer', 'task-a', 'assignment-a', 'session-a', 1, 'PRIVATE ANSWER');
    f.db.prepare('INSERT INTO sa_task_inputs VALUES (?,?,?,?,?)').run('input', 'task-a', 1, 'PRIVATE INPUT', 'pending');
    f.db.prepare('INSERT INTO sa_task_boundaries VALUES (?,?,?,?)').run('assignment-a', 'run-a', 'boundary', JSON.stringify({ instructionRevision: 1, target: 'PRIVATE BOUNDARY' }));
  });
  const page = f.store.executionFactPage({ after: baseline });
  assert.deepEqual(page.entries.map(row => row.seq), Array.from({ length: 7 }, (_, index) => baseline + index + 1));
  assert.deepEqual(page.entries.map(row => row.kind), ['task', 'result', 'delivery', 'attention', 'attention', 'input', 'requirements']);
  assert.equal(page.entries.every(row => row.taskId === 'task-a'), true);
  assert.doesNotMatch(JSON.stringify(page), /PRIVATE/);
  assert.deepEqual(page.entries[0].data, { operation: 'update' });
  f.tx(() => f.db.exec("DELETE FROM sa_attentions WHERE id='attention'"));
  const removal = f.store.executionFactPage({ after: page.cursor }).entries[0];
  assert.equal(removal.kind, 'attention'); assert.equal(removal.data.operation, 'delete');
  assert.equal(removal.sessionId, 'session-a');
});

test('snapshot cursor then paginated replay covers intervening commits once', t => {
  const f = fixture(t); f.seed();
  const snapshotCursor = f.store.executionFactCursor();
  f.seed('b');
  f.tx(() => f.db.exec("UPDATE sa_tasks SET status='waiting' WHERE id='task-a'"));
  const through = f.store.executionFactCursor();
  const first = f.store.executionFactPage({ after: snapshotCursor, through, limit: 2 });
  assert.equal(first.cursor, snapshotCursor + 2); assert.equal(first.hasMore, true);
  f.tx(() => f.db.exec("UPDATE sa_tasks SET status='completed' WHERE id='task-a'"));
  const second = f.store.executionFactPage({ after: first.cursor, through, limit: 2 });
  assert.equal(second.cursor, through); assert.equal(second.hasMore, false);
  assert.deepEqual([...first.entries, ...second.entries].map(row => row.seq), [4, 5, 6, 7]);
  assert.equal(f.store.executionFactPage({ after: through }).entries[0].seq, through + 1);
  assert.deepEqual(f.store.executionFactPage({ after: through, through }), { cursor: through, through, entries: [], hasMore: false });
  for (const options of [{ after: -1 }, { after: 0.5 }, { after: 0, through: 999 }, { after: 5, through: 4 }, { limit: 0 }]) {
    assert.throws(() => f.store.executionFactPage(options), error => ['EXECUTION_FACT_INPUT', 'EXECUTION_FACT_CURSOR'].includes(error.code));
  }
});

test('projection binds the real run, drops private fields, deduplicates and rejects old cursors', t => {
  const f = fixture(t); f.seed();
  const input = projection();
  input.state.arguments = 'PRIVATE ARGUMENT'; input.state.tools.active = [{ callId: 'call', category: 'file', sourceSeq: 6, arguments: 'PRIVATE ARGUMENT' }];
  input.state.request.output = 'PRIVATE MODEL OUTPUT'; input.state.transcript = 'PRIVATE TRANSCRIPT';
  input.fact.output = 'PRIVATE TOOL OUTPUT'; input.fact.evidenceRefs[0].content = 'PRIVATE EVIDENCE';
  input.live.reasoning = 'PRIVATE REASONING'; input.target = 'PRIVATE TARGET';
  const saved = f.store.recordExecutionProjection(input);
  assert.equal(saved.taskId, 'task-a'); assert.equal(saved.runId, 'run-a'); assert.equal(saved.instructionRevision, 1);
  const current = f.store.executionFactCursor();
  assert.equal(f.store.recordExecutionProjection(input).duplicate, true);
  assert.equal(f.store.executionFactCursor(), current);
  assert.equal(f.store.recordExecutionProjection({ ...input, cursor: 2 }).stale, true);
  assert.equal(f.store.getExecutionProjection('session-a').cursor, 7);
  assert.equal(f.store.executionFactCursor(), current);
  assert.doesNotMatch(JSON.stringify(f.store.executionEvidence({ taskId: 'task-a' })), /PRIVATE|arguments|transcript|reasoning|"output"/);
  assert.deepEqual(f.store.executionFactPage({ after: current - 1 }).entries[0].data, {
    category: 'file', counts: { calls: 1, errors: 0, results: 1 }, evidenceRefs: [{ seq: 7, sessionId: 'session-a' }], kind: 'tool/result',
  });
  for (const patch of [{ taskId: 'task-b' }, { runId: 'run-b' }, { fence: 2 }, { instructionRevision: 2 }, { rootSessionId: 'missing' }, { flushedCursor: 8 }]) {
    assert.throws(() => f.store.recordExecutionProjection({ ...input, ...patch }), { code: 'EXECUTION_FACT_BINDING' });
  }
  assert.equal(f.store.executionFactCursor(), current);
});

test('child projection preserves one true parent and survives reconstruction without fake completion', t => {
  const f = fixture(t); f.seed(); f.seed('b');
  const input = projection('a', { sessionId: 'child-a', rootSessionId: 'session-a', parentSessionId: 'session-a',
    live: { status: 'disposed', observedAt: at, bootId: 'boot-1', activationId: 'activation-1', settledReason: 'error' } });
  const saved = f.store.recordExecutionProjection(input);
  assert.equal(saved.parentSessionId, 'session-a'); assert.equal(saved.runId, 'run-a');
  assert.equal(saved.live.settledReason, 'error');
  assert.throws(() => f.store.recordExecutionProjection({ ...input, rootSessionId: 'session-b', parentSessionId: 'session-b' }), { code: 'EXECUTION_FACT_BINDING' });
  assert.throws(() => f.store.recordExecutionProjection({ ...input, parentSessionId: 'grandchild-parent' }), { code: 'EXECUTION_FACT_BINDING' });
  const resumed = installExecutionFactsStore({ db: f.db, tx: f.tx });
  t.after(() => resumed.disposeExecutionFacts());
  assert.deepEqual(resumed.executionProjections({ runId: 'run-a' }), [saved]);
  assert.deepEqual(resumed.executionProjections({ taskId: 'task-b' }), []);
  assert.equal(resumed.executionBindings().length, 2);
  assert.equal(resumed.getExecutionBinding('missing'), null);
});

test('requirement and fence changes retain historical facts and reject stale writers', t => {
  const f = fixture(t); f.seed();
  f.store.recordExecutionProjection(projection());
  const before = f.store.executionFactCursor();
  f.tx(() => {
    f.db.exec("UPDATE sa_tasks SET instruction_revision=2 WHERE id='task-a'");
    f.db.prepare('UPDATE sa_assignments SET fence=2,payload=? WHERE id=?').run(JSON.stringify({ instructionRevision: 2 }), 'assignment-a');
    f.db.prepare('UPDATE sa_runs SET fence=2,payload=? WHERE id=?').run(JSON.stringify({ sessionId: 'session-a', instructionRevision: 2 }), 'run-a');
  });
  assert.throws(() => f.store.recordExecutionProjection(projection('a', { fence: 1, instructionRevision: 1 })), { code: 'EXECUTION_FACT_BINDING' });
  f.store.recordExecutionProjection(projection('a', { cursor: 8, fence: 2, instructionRevision: 2 }));
  const old = f.store.executionEvidence({ taskId: 'task-a', instructionRevision: 1 });
  assert.equal(old.entries.filter(row => row.kind === 'execution').length, 1);
  assert.equal(old.projections.length, 0);
  const next = f.store.executionEvidence({ taskId: 'task-a', runId: 'run-a', instructionRevision: 2, after: before, limit: 1 });
  assert.equal(next.hasMore, true); assert.equal(next.entries.length, 1);
  assert.equal(next.projections[0].fence, 2);
  assert.equal(f.store.executionEvidence({ taskId: 'task-b' }).entries.length, 0);
});

test('commit subscribers coalesce, ignore rollback, isolate observer errors and release cleanly', async t => {
  const f = fixture(t), calls = [];
  const unsubscribe = f.store.onExecutionFacts(value => calls.push(value));
  f.store.onExecutionFacts(() => { throw new Error('observer failed'); });
  f.seed(); f.seed('b');
  await Promise.resolve();
  assert.deepEqual(calls, [6]);
  assert.throws(() => f.tx(() => { f.db.exec("UPDATE sa_tasks SET status='waiting' WHERE id='task-a'"); throw new Error('rollback'); }));
  f.store.flushExecutionFactChanges(); await Promise.resolve();
  assert.deepEqual(calls, [6]);
  unsubscribe();
  f.tx(() => f.db.exec("UPDATE sa_tasks SET status='waiting' WHERE id='task-a'"));
  await Promise.resolve(); assert.deepEqual(calls, [6]);
  f.store.disposeExecutionFacts();
  assert.throws(() => f.store.onExecutionFacts(() => {}), { code: 'EXECUTION_FACT_CLOSED' });
});

test('presentation and goal events share the journal without copying task metadata', t => {
  const f = fixture(t); f.seed();
  const before = f.store.executionFactCursor();
  f.tx(() => {
    f.db.prepare('INSERT INTO task_meta VALUES (?,?)').run('task-presentation:task:task-a', JSON.stringify({ title: 'PRIVATE TITLE', version: 1 }));
    f.db.prepare('INSERT INTO task_meta VALUES (?,?)').run('scheduler', JSON.stringify({ credential: 'PRIVATE SECRET' }));
    f.db.prepare('INSERT INTO assistant_goals VALUES (?,?,?)').run('goal-a', JSON.stringify({ target: 'PRIVATE GOAL' }), 'running');
  });
  const entries = f.store.executionFactPage({ after: before }).entries;
  assert.equal(entries.length, 2); assert.equal(entries[0].taskId, 'task-a'); assert.equal(entries[0].kind, 'presentation');
  assert.equal(entries[1].taskId, null); assert.equal(entries[1].kind, 'goal'); assert.equal(entries[1].data.goalId, 'goal-a');
  assert.doesNotMatch(JSON.stringify(entries), /PRIVATE/);
});

test('runtime tables created later attach explicitly without polling or duplicate triggers', t => {
  const f = fixture(t); f.seed();
  f.db.exec('DROP TABLE task_meta; DROP TABLE assistant_goals');
  const later = installExecutionFactsStore({ db: f.db, tx: f.tx });
  t.after(() => later.disposeExecutionFacts());
  f.db.exec('CREATE TABLE task_meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE assistant_goals(id TEXT PRIMARY KEY,payload TEXT,status TEXT)');
  later.installExecutionFactRuntimeSources(); later.installExecutionFactRuntimeSources();
  const before = later.executionFactCursor();
  f.tx(() => f.db.prepare('INSERT INTO task_meta VALUES (?,?)').run('task-presentation:task:task-a', '{}'));
  assert.equal(later.executionFactCursor(), before + 1);
  assert.equal(later.executionFactPage({ after: before }).entries[0].kind, 'presentation');
});

test('summary publication only emits a display change and requires a real task', async t => {
  const f = fixture(t); f.seed();
  const before = f.store.executionFactCursor(), observed = [];
  f.store.onExecutionFacts(value => observed.push(value));
  const saved = f.store.recordExecutionDisplayChange({ taskId: 'task-a', kind: 'summary', text: 'PRIVATE SUMMARY' });
  assert.equal(saved.kind, 'summary'); assert.equal(saved.seq, before + 1);
  assert.equal(saved.runId, 'run-a'); assert.equal(saved.assignmentId, 'assignment-a');
  assert.equal(saved.instructionRevision, 1); assert.deepEqual(saved.data, {});
  await Promise.resolve(); assert.deepEqual(observed, [saved.seq]);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM sa_outbox').get().count, 0);
  assert.equal(f.db.prepare("SELECT status FROM sa_tasks WHERE id='task-a'").get().status, 'running');
  assert.equal(f.db.prepare("SELECT state FROM sa_runs WHERE id='run-a'").get().state, 'running');
  assert.doesNotMatch(JSON.stringify(f.store.executionFactPage({ after: before })), /PRIVATE/);
  assert.throws(() => f.store.recordExecutionDisplayChange({ taskId: 'task-a', kind: 'tool/result' }), { code: 'EXECUTION_FACT_INPUT' });
  assert.throws(() => f.store.recordExecutionDisplayChange({ taskId: 'missing', kind: 'summary' }), { code: 'EXECUTION_FACT_BINDING' });
  assert.equal(f.store.executionFactCursor(), saved.seq);
  f.tx(() => f.db.prepare('INSERT INTO sa_tasks VALUES (?,?,?,?)').run('unassigned', 'running', 2, 'PRIVATE TARGET'));
  const unassigned = f.store.recordExecutionDisplayChange({ taskId: 'unassigned', kind: 'summary' });
  assert.equal(unassigned.runId, null); assert.equal(unassigned.instructionRevision, 2);
});

test('a late runtime notification wakes the existing stream without leaking its contents', async t => {
  const f = fixture(t);
  f.db.exec('CREATE TABLE task_events(id TEXT PRIMARY KEY,payload TEXT)');
  f.store.installExecutionFactRuntimeSources();
  f.store.installExecutionFactRuntimeSources();
  const before = f.store.executionFactCursor(), observed = [];
  f.store.onExecutionFacts(value => observed.push(value));
  f.tx(() => f.db.prepare('INSERT INTO task_events VALUES (?,?)').run('notification-1', 'PRIVATE REPLY'));
  await Promise.resolve();
  const page = f.store.executionFactPage({ after: before });
  assert.equal(page.entries.length, 1);
  assert.equal(page.entries[0].kind, 'chat');
  assert.deepEqual(page.entries[0].data, { operation: 'insert', eventId: 'notification-1' });
  assert.deepEqual(observed, [page.cursor]);
  assert.doesNotMatch(JSON.stringify(page), /PRIVATE REPLY/);
});

test('notification trigger upgrades in place with identities only and no historical replay', t => {
  const f = fixture(t);
  f.db.exec(`CREATE TABLE task_events(id TEXT PRIMARY KEY,payload TEXT);
    CREATE TRIGGER sa_execution_fact_task_events_insert AFTER INSERT ON task_events
    BEGIN INSERT INTO sa_execution_facts(task_id,kind,observed_at,data) VALUES(NULL,'chat','old','{}'); END;`);
  f.db.prepare('INSERT INTO task_events VALUES (?,?)').run('old', '{}');
  const before = f.store.executionFactCursor();
  f.store.installExecutionFactRuntimeSources();
  assert.equal(f.store.executionFactCursor(), before);
  f.db.prepare('INSERT INTO task_events VALUES (?,?)').run('new', JSON.stringify({ threadId: 'side', requestId: 'request', taskStateEventKey: 'delivery', sourceEventId: 'source', text: 'PRIVATE REPLY', other: 'PRIVATE OTHER' }));
  const page = f.store.executionFactPage({ after: before });
  assert.equal(page.entries.length, 1);
  assert.deepEqual(page.entries[0].data, { operation: 'insert', eventId: 'new', threadId: 'side', requestId: 'request', taskStateEventKey: 'delivery', sourceEventId: 'source' });
  assert.doesNotMatch(JSON.stringify(page), /PRIVATE/);
});

test('counter scope is fixed to session and arbitrary scope or extra data is omitted', t => {
  const f = fixture(t); f.seed();
  const before = f.store.executionFactCursor();
  f.store.recordExecutionProjection(projection('a', { fact: { kind: 'tool/result', counterScope: 'session', counts: { calls: 1 }, output: 'PRIVATE OUTPUT' } }));
  const event = f.store.executionFactPage({ after: before }).entries[0];
  assert.equal(event.data.counterScope, 'session'); assert.equal(event.data.output, undefined);
  f.store.recordExecutionProjection(projection('a', { cursor: 8, fact: { kind: 'tool/result', counterScope: 'requirements', counts: { calls: 2 } } }));
  assert.equal(f.store.executionFactPage({ after: event.seq }).entries[0].data.counterScope, undefined);
});

test('persistent projection and journal reopen with the same cursor and bounded evidence', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-execution-facts-'));
  t.after(async () => {
    assert.equal(resolve(directory).startsWith(resolve(tmpdir()) + '\\') || resolve(directory).startsWith(resolve(tmpdir()) + '/'), true);
    await rm(directory, { recursive: true, force: true });
  });
  const filename = join(directory, 'assistant.db');
  const first = fixture(t, filename); first.seed();
  first.store.recordExecutionProjection(projection('a', { sourceDurability: 'persisted', flushedCursor: 7 }));
  const cursor = first.store.executionFactCursor(); first.close();
  const second = fixture(t, filename);
  assert.equal(second.store.executionFactCursor(), cursor);
  assert.equal(second.store.executionFactCursor(), cursor);
  assert.equal(second.store.getExecutionProjection('session-a').flushedCursor, 7);
  assert.equal(second.store.getExecutionProjection('session-a').sourceDurability, 'persisted');
  assert.equal(second.store.executionEvidence({ taskId: 'task-a', limit: 1 }).entries.length, 1);
  assert.equal(second.store.executionEvidence({ taskId: 'task-a', after: cursor }).cursor, cursor);
  second.close();
});
