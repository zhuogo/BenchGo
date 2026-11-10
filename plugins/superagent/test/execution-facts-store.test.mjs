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
  db.exec(`CREATE TABLE IF NOT EXISTS sa_tickets(id TEXT PRIMARY KEY,status TEXT,instruction_revision INTEGER,target TEXT);
    CREATE TABLE IF NOT EXISTS sa_assignments(id TEXT PRIMARY KEY,ticket_id TEXT,payload TEXT,fence INTEGER,state TEXT,created_at TEXT);
    CREATE TABLE IF NOT EXISTS sa_runs(id TEXT PRIMARY KEY,assignment_id TEXT,payload TEXT,fence INTEGER,state TEXT,created_at TEXT);
    CREATE TABLE IF NOT EXISTS sa_results(ticket_id TEXT,version INTEGER,payload TEXT);
    CREATE TABLE IF NOT EXISTS sa_outbox(id TEXT PRIMARY KEY,ticket_id TEXT,payload TEXT,state TEXT);
    CREATE TABLE IF NOT EXISTS sa_attentions(id TEXT PRIMARY KEY,ticket_id TEXT,assignment_id TEXT,session_id TEXT,instruction_revision INTEGER,question TEXT);
    CREATE TABLE IF NOT EXISTS sa_attention_resolutions(id TEXT PRIMARY KEY,ticket_id TEXT,assignment_id TEXT,session_id TEXT,instruction_revision INTEGER,resolution TEXT);
    CREATE TABLE IF NOT EXISTS sa_ticket_inputs(id TEXT PRIMARY KEY,ticket_id TEXT,instruction_revision INTEGER,snapshot TEXT,state TEXT);
    CREATE TABLE IF NOT EXISTS sa_ticket_boundaries(assignment_id TEXT,run_id TEXT,boundary_id TEXT,snapshot TEXT);
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
    db.prepare('INSERT INTO sa_tickets VALUES (?,?,?,?)').run(`ticket-${suffix}`, 'running', 1, 'PRIVATE TARGET');
    db.prepare('INSERT INTO sa_assignments VALUES (?,?,?,?,?,?)').run(`assignment-${suffix}`, `ticket-${suffix}`, JSON.stringify({ instructionRevision: 1, text: 'PRIVATE TASK' }), 1, 'claimed', at);
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
function observation(patch = {}) {
  return { observationId: 'checkpoint-a', ticketId: 'ticket-a', assignmentId: 'assignment-a', runId: 'run-a', fence: 1, instructionRevision: 1,
    directory: process.cwd(), callId: 'call-a', sequence: 0, startedAt: at, completedAt: at,
    coverage: { kind: 'protected-workspace-files', complete: true, truncated: false, exclusionsVersion: 1,
      externalEffects: 'not-observed', conversationOutputs: 'not-observed' },
    comparison: { beforeFiles: 0, afterFiles: 0, added: 0, modified: 0, deleted: 0, unchanged: 0, netChanged: false }, ...patch };
}

test('artifact observations bind the persisted execution and publish only complete file comparison metadata', t => {
  const f = fixture(t); f.seed();
  const before = f.store.executionFactCursor(), input = observation({ paths: ['PRIVATE PATH'], hash: 'PRIVATE HASH', blob: 'PRIVATE BLOB' });
  input.coverage.secret = 'PRIVATE COVERAGE'; input.comparison.path = 'PRIVATE PATH';
  const saved = f.store.recordExecutionArtifactObservation(input);
  assert.equal(saved.seq, before + 1); assert.equal(saved.kind, 'artifact-observation'); assert.equal(saved.sessionId, 'session-a');
  assert.equal(saved.instructionRevision, 1); assert.equal(saved.fence, 1);
  assert.equal(saved.data.observationId, input.observationId); assert.equal(saved.data.comparison.netChanged, false);
  assert.equal(f.store.recordExecutionArtifactObservation(input).duplicate, true); assert.equal(f.store.executionFactCursor(), saved.seq);
  assert.doesNotMatch(JSON.stringify(saved), /PRIVATE|directory|"paths"|"path"|"hash"|"blob"/);
  const changed = observation({ observationId: 'checkpoint-b', sequence: 1,
    comparison: { beforeFiles: 4, afterFiles: 5, added: 2, modified: 1, deleted: 1, unchanged: 2, netChanged: true } });
  assert.deepEqual(f.store.recordExecutionArtifactObservation(changed).data.comparison, changed.comparison);
  const evidence = f.store.executionEvidence({ ticketId: 'ticket-a', runId: 'run-a', instructionRevision: 1, after: before });
  assert.equal(evidence.entries.length, 2); assert.deepEqual(evidence.entries.map(row => row.data.sequence), [0, 1]);
});

test('artifact observations reject identity conflicts, stale fences or applied revisions and untrusted directories', t => {
  const f = fixture(t); f.seed(); f.seed('b');
  f.store.recordExecutionArtifactObservation(observation());
  assert.throws(() => f.store.recordExecutionArtifactObservation(observation({ sequence: 1 })), { code: 'EXECUTION_FACT_CONFLICT' });
  assert.throws(() => f.store.recordExecutionArtifactObservation(observation({ ticketId: 'ticket-b', assignmentId: 'assignment-b', runId: 'run-b' })), { code: 'EXECUTION_FACT_CONFLICT' });
  for (const patch of [{ ticketId: 'missing' }, { assignmentId: 'missing' }, { runId: 'missing' }, { fence: 2 }, { instructionRevision: 2 },
    { directory: join(process.cwd(), 'other') }, { directory: 'relative/path' }]) {
    assert.throws(() => f.store.recordExecutionArtifactObservation(observation({ observationId: 'another', ...patch })), { code: 'EXECUTION_FACT_BINDING' });
  }
  f.tx(() => f.db.exec("UPDATE sa_tickets SET instruction_revision=2 WHERE id='ticket-a'"));
  assert.equal(f.store.recordExecutionArtifactObservation(observation({ observationId: 'old-applied' })).instructionRevision, 1,
    'a queued Ticket revision does not rewrite the actual applied tool requirements');
  f.tx(() => {
    f.db.prepare('UPDATE sa_assignments SET payload=? WHERE id=?').run(JSON.stringify({ instructionRevision: 2 }), 'assignment-a');
    f.db.prepare('UPDATE sa_runs SET payload=? WHERE id=?').run(JSON.stringify({ sessionId: 'session-a', instructionRevision: 2, directory: process.cwd() }), 'run-a');
  });
  assert.throws(() => f.store.recordExecutionArtifactObservation(observation({ observationId: 'frozen-old' })), { code: 'EXECUTION_FACT_BINDING' });
  assert.equal(f.store.recordExecutionArtifactObservation(observation({ observationId: 'new-applied', instructionRevision: 2 })).instructionRevision, 2);
  f.tx(() => f.db.exec("UPDATE sa_assignments SET fence=2 WHERE id='assignment-a'"));
  assert.throws(() => f.store.recordExecutionArtifactObservation(observation({ observationId: 'old-fence', instructionRevision: 2 })), { code: 'EXECUTION_FACT_BINDING' });
});

test('incomplete or inconsistent artifact coverage cannot be negative file-change evidence', t => {
  const f = fixture(t); f.seed();
  const input = observation(), before = f.store.executionFactCursor();
  for (const patch of [{ coverage: { ...input.coverage, complete: false } }, { coverage: { ...input.coverage, truncated: true } },
    { coverage: { ...input.coverage, exclusionsVersion: 2 } }, { comparison: { ...input.comparison, netChanged: true } },
    { comparison: { ...input.comparison, beforeFiles: 1 } }, { comparison: { ...input.comparison, added: -1 } },
    { startedAt: 'invalid' }, { completedAt: '2026-11-08T00:00:00.000Z' }]) {
    assert.throws(() => f.store.recordExecutionArtifactObservation({ ...input, ...patch }), { code: 'EXECUTION_FACT_INPUT' });
  }
  assert.equal(f.store.executionFactCursor(), before);
});

test('domain changes share an atomic dense journal and omit every private domain payload', t => {
  const f = fixture(t); f.seed();
  const baseline = f.store.executionFactCursor();
  assert.equal(baseline, 3);
  assert.throws(() => f.tx(() => { f.db.prepare('UPDATE sa_tickets SET status=? WHERE id=?').run('waiting', 'ticket-a'); throw new Error('rollback'); }), /rollback/);
  assert.equal(f.store.executionFactCursor(), baseline);
  f.tx(() => f.db.exec("UPDATE sa_tickets SET status=status WHERE id='ticket-a'"));
  assert.equal(f.store.executionFactCursor(), baseline, 'no-op updates have no display event');
  f.tx(() => {
    f.db.exec("UPDATE sa_tickets SET status='waiting' WHERE id='ticket-a'");
    f.db.prepare('INSERT INTO sa_results VALUES (?,?,?)').run('ticket-a', 1, JSON.stringify({ summary: 'PRIVATE RESULT' }));
    f.db.prepare('INSERT INTO sa_outbox VALUES (?,?,?,?)').run('outbox', 'ticket-a', JSON.stringify({ text: 'PRIVATE DELIVERY' }), 'queued');
    f.db.prepare('INSERT INTO sa_attentions VALUES (?,?,?,?,?,?)').run('attention', 'ticket-a', 'assignment-a', 'session-a', 1, 'PRIVATE QUESTION');
    f.db.prepare('INSERT INTO sa_attention_resolutions VALUES (?,?,?,?,?,?)').run('answer', 'ticket-a', 'assignment-a', 'session-a', 1, 'PRIVATE ANSWER');
    f.db.prepare('INSERT INTO sa_ticket_inputs VALUES (?,?,?,?,?)').run('input', 'ticket-a', 1, 'PRIVATE INPUT', 'pending');
    f.db.prepare('INSERT INTO sa_ticket_boundaries VALUES (?,?,?,?)').run('assignment-a', 'run-a', 'boundary', JSON.stringify({ instructionRevision: 1, target: 'PRIVATE BOUNDARY' }));
  });
  const page = f.store.executionFactPage({ after: baseline });
  assert.deepEqual(page.entries.map(row => row.seq), Array.from({ length: 7 }, (_, index) => baseline + index + 1));
  assert.deepEqual(page.entries.map(row => row.kind), ['ticket', 'result', 'delivery', 'attention', 'attention', 'input', 'requirements']);
  assert.equal(page.entries.every(row => row.ticketId === 'ticket-a'), true);
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
  f.tx(() => f.db.exec("UPDATE sa_tickets SET status='waiting' WHERE id='ticket-a'"));
  const through = f.store.executionFactCursor();
  const first = f.store.executionFactPage({ after: snapshotCursor, through, limit: 2 });
  assert.equal(first.cursor, snapshotCursor + 2); assert.equal(first.hasMore, true);
  f.tx(() => f.db.exec("UPDATE sa_tickets SET status='completed' WHERE id='ticket-a'"));
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
  assert.equal(saved.ticketId, 'ticket-a'); assert.equal(saved.runId, 'run-a'); assert.equal(saved.instructionRevision, 1);
  const current = f.store.executionFactCursor();
  assert.equal(f.store.recordExecutionProjection(input).duplicate, true);
  assert.equal(f.store.executionFactCursor(), current);
  assert.equal(f.store.recordExecutionProjection({ ...input, cursor: 2 }).stale, true);
  assert.equal(f.store.getExecutionProjection('session-a').cursor, 7);
  assert.equal(f.store.executionFactCursor(), current);
  assert.doesNotMatch(JSON.stringify(f.store.executionEvidence({ ticketId: 'ticket-a' })), /PRIVATE|arguments|transcript|reasoning|"output"/);
  assert.deepEqual(f.store.executionFactPage({ after: current - 1 }).entries[0].data, {
    category: 'file', counts: { calls: 1, errors: 0, results: 1 }, evidenceRefs: [{ seq: 7, sessionId: 'session-a' }], kind: 'tool/result',
  });
  for (const patch of [{ ticketId: 'ticket-b' }, { runId: 'run-b' }, { fence: 2 }, { instructionRevision: 2 }, { rootSessionId: 'missing' }, { flushedCursor: 8 }]) {
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
  assert.deepEqual(resumed.executionProjections({ ticketId: 'ticket-b' }), []);
  assert.equal(resumed.executionBindings().length, 2);
  assert.equal(resumed.getExecutionBinding('missing'), null);
});

test('requirement and fence changes retain historical facts and reject stale writers', t => {
  const f = fixture(t); f.seed();
  f.store.recordExecutionProjection(projection());
  const before = f.store.executionFactCursor();
  f.tx(() => {
    f.db.exec("UPDATE sa_tickets SET instruction_revision=2 WHERE id='ticket-a'");
    f.db.prepare('UPDATE sa_assignments SET fence=2,payload=? WHERE id=?').run(JSON.stringify({ instructionRevision: 2 }), 'assignment-a');
    f.db.prepare('UPDATE sa_runs SET fence=2,payload=? WHERE id=?').run(JSON.stringify({ sessionId: 'session-a', instructionRevision: 2 }), 'run-a');
  });
  assert.throws(() => f.store.recordExecutionProjection(projection('a', { fence: 1, instructionRevision: 1 })), { code: 'EXECUTION_FACT_BINDING' });
  f.store.recordExecutionProjection(projection('a', { cursor: 8, fence: 2, instructionRevision: 2 }));
  const old = f.store.executionEvidence({ ticketId: 'ticket-a', instructionRevision: 1 });
  assert.equal(old.entries.filter(row => row.kind === 'execution').length, 1);
  assert.equal(old.projections.length, 0);
  const next = f.store.executionEvidence({ ticketId: 'ticket-a', runId: 'run-a', instructionRevision: 2, after: before, limit: 1 });
  assert.equal(next.hasMore, true); assert.equal(next.entries.length, 1);
  assert.equal(next.projections[0].fence, 2);
  assert.equal(f.store.executionEvidence({ ticketId: 'ticket-b' }).entries.length, 0);
});

test('commit subscribers coalesce, ignore rollback, isolate observer errors and release cleanly', async t => {
  const f = fixture(t), calls = [];
  const unsubscribe = f.store.onExecutionFacts(value => calls.push(value));
  f.store.onExecutionFacts(() => { throw new Error('observer failed'); });
  f.seed(); f.seed('b');
  await Promise.resolve();
  assert.deepEqual(calls, [6]);
  assert.throws(() => f.tx(() => { f.db.exec("UPDATE sa_tickets SET status='waiting' WHERE id='ticket-a'"); throw new Error('rollback'); }));
  f.store.flushExecutionFactChanges(); await Promise.resolve();
  assert.deepEqual(calls, [6]);
  unsubscribe();
  f.tx(() => f.db.exec("UPDATE sa_tickets SET status='waiting' WHERE id='ticket-a'"));
  await Promise.resolve(); assert.deepEqual(calls, [6]);
  f.store.disposeExecutionFacts();
  assert.throws(() => f.store.onExecutionFacts(() => {}), { code: 'EXECUTION_FACT_CLOSED' });
});

test('presentation and goal events share the journal without copying task metadata', t => {
  const f = fixture(t); f.seed();
  const before = f.store.executionFactCursor();
  f.tx(() => {
    f.db.prepare('INSERT INTO task_meta VALUES (?,?)').run('task-presentation:ticket:ticket-a', JSON.stringify({ title: 'PRIVATE TITLE', version: 1 }));
    f.db.prepare('INSERT INTO task_meta VALUES (?,?)').run('scheduler', JSON.stringify({ credential: 'PRIVATE SECRET' }));
    f.db.prepare('INSERT INTO assistant_goals VALUES (?,?,?)').run('goal-a', JSON.stringify({ target: 'PRIVATE GOAL' }), 'running');
  });
  const entries = f.store.executionFactPage({ after: before }).entries;
  assert.equal(entries.length, 2); assert.equal(entries[0].ticketId, 'ticket-a'); assert.equal(entries[0].kind, 'presentation');
  assert.equal(entries[1].ticketId, null); assert.equal(entries[1].kind, 'goal'); assert.equal(entries[1].data.goalId, 'goal-a');
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
  f.tx(() => f.db.prepare('INSERT INTO task_meta VALUES (?,?)').run('task-presentation:ticket:ticket-a', '{}'));
  assert.equal(later.executionFactCursor(), before + 1);
  assert.equal(later.executionFactPage({ after: before }).entries[0].kind, 'presentation');
});

test('summary publication only emits a display change and requires a real ticket', async t => {
  const f = fixture(t); f.seed();
  const before = f.store.executionFactCursor(), observed = [];
  f.store.onExecutionFacts(value => observed.push(value));
  const saved = f.store.recordExecutionDisplayChange({ ticketId: 'ticket-a', kind: 'summary', text: 'PRIVATE SUMMARY' });
  assert.equal(saved.kind, 'summary'); assert.equal(saved.seq, before + 1);
  assert.equal(saved.runId, 'run-a'); assert.equal(saved.assignmentId, 'assignment-a');
  assert.equal(saved.instructionRevision, 1); assert.deepEqual(saved.data, {});
  await Promise.resolve(); assert.deepEqual(observed, [saved.seq]);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM sa_outbox').get().count, 0);
  assert.equal(f.db.prepare("SELECT status FROM sa_tickets WHERE id='ticket-a'").get().status, 'running');
  assert.equal(f.db.prepare("SELECT state FROM sa_runs WHERE id='run-a'").get().state, 'running');
  assert.doesNotMatch(JSON.stringify(f.store.executionFactPage({ after: before })), /PRIVATE/);
  assert.throws(() => f.store.recordExecutionDisplayChange({ ticketId: 'ticket-a', kind: 'tool/result' }), { code: 'EXECUTION_FACT_INPUT' });
  assert.throws(() => f.store.recordExecutionDisplayChange({ ticketId: 'missing', kind: 'summary' }), { code: 'EXECUTION_FACT_BINDING' });
  assert.equal(f.store.executionFactCursor(), saved.seq);
  f.tx(() => f.db.prepare('INSERT INTO sa_tickets VALUES (?,?,?,?)').run('unassigned', 'running', 2, 'PRIVATE TARGET'));
  const unassigned = f.store.recordExecutionDisplayChange({ ticketId: 'unassigned', kind: 'summary' });
  assert.equal(unassigned.runId, null); assert.equal(unassigned.instructionRevision, 2);
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
  const artifact = first.store.recordExecutionArtifactObservation(observation());
  const cursor = first.store.executionFactCursor(); first.close();
  const second = fixture(t, filename);
  assert.equal(second.store.executionFactCursor(), cursor);
  assert.equal(second.store.recordExecutionArtifactObservation(observation()).duplicate, true);
  assert.equal(second.store.executionFactCursor(), cursor);
  assert.equal(second.store.executionEvidence({ ticketId: 'ticket-a', after: artifact.seq - 1 }).entries[0].data.observationId, 'checkpoint-a');
  assert.equal(second.store.getExecutionProjection('session-a').flushedCursor, 7);
  assert.equal(second.store.getExecutionProjection('session-a').sourceDurability, 'persisted');
  assert.equal(second.store.executionEvidence({ ticketId: 'ticket-a', limit: 1 }).entries.length, 1);
  assert.equal(second.store.executionEvidence({ ticketId: 'ticket-a', after: cursor }).cursor, cursor);
  second.close();
});
