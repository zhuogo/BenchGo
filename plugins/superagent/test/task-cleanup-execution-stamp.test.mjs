import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'benchgo-cleanup-stamp-'));
  const store = createAssistantOrchestrationStore({ directory });
  const sql = new DatabaseSync(join(directory, 'assistant.db'));
  t.after(() => { sql.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const thread = { id: 'tasks', source: { type: 'desktop', id: 'owner' } };
  store.createThread(thread);
  store.createTask({ id: 'task', threadId: thread.id, target: 'Complete this task', mandate: { source: { channel: 'desktop', sessionId: 'owner' } } });
  const stamp = options => store.taskCleanupExecutionStamp('task', options);
  const input = (triggerId, kind = 'context', snapshot) => {
    store.ingest({ id: triggerId, thread, dedupeKey: triggerId, source: { channel: 'desktop', sessionId: 'owner' },
      actor: { kind: 'human', id: 'owner' }, content: triggerId, mode: 'direct' });
    return store.recordTaskInput({ taskId: 'task', triggerId, kind, snapshot, idempotencyKey: `trigger:${triggerId}` });
  };
  const execute = () => {
    const created = store.createAssignment('task', { text: 'Execute' });
    const [assignment] = store.claimAssignments('worker', { assignmentId: created.id, validateMandate: () => true });
    const run = store.prepareRun(assignment.id, { ...assignment, sessionId: `worker:${assignment.id}`, directory: '/unused' });
    return { assignment, run };
  };
  return { store, sql, stamp, input, execute };
}

test('cleanup execution stamp binds new assignments, claims and runs but permits their natural progress', t => {
  const f = fixture(t), empty = f.stamp();
  assert.match(empty, /^[a-f0-9]{64}$/u);
  assert.equal(f.stamp(), empty);
  assert.throws(() => f.store.taskCleanupExecutionStamp('missing'), { code: 'TASK_NOT_FOUND' });
  const created = f.store.createAssignment('task', { text: 'Execute' });
  const queued = f.stamp(); assert.notEqual(queued, empty);
  const [assignment] = f.store.claimAssignments('worker', { validateMandate: () => true });
  const claimed = f.stamp(); assert.notEqual(claimed, queued);
  const run = f.store.prepareRun(created.id, { ...assignment, sessionId: 'worker-session', directory: '/unused' });
  const running = f.stamp(); assert.notEqual(running, claimed);
  f.store.updateRun(run.id, { ...assignment, state: 'submitted' });
  assert.equal(f.stamp(), running, 'run state transitions are not a different execution');
  f.sql.prepare("UPDATE sa_assignments SET state='uncertain',owner=NULL,lease_until=NULL WHERE id=?").run(assignment.id);
  assert.equal(f.stamp(), running, 'releasing an assignment owner preserves its execution identity');
  f.sql.prepare('UPDATE sa_assignments SET fence=fence+1 WHERE id=?').run(assignment.id);
  assert.notEqual(f.stamp(), running, 'a new claim fence is a different execution');
});

test('cleanup execution stamp includes historical assignments and all run fences and owners', t => {
  const f = fixture(t), first = f.execute();
  f.execute();
  const before = f.stamp();
  f.sql.prepare('UPDATE sa_assignments SET fence=fence+1 WHERE id=?').run(first.assignment.id);
  const assignmentChanged = f.stamp(); assert.notEqual(assignmentChanged, before);
  f.sql.prepare('UPDATE sa_runs SET fence=fence+1 WHERE id=?').run(first.run.id);
  const fenceChanged = f.stamp(); assert.notEqual(fenceChanged, assignmentChanged);
  f.sql.prepare("UPDATE sa_runs SET owner='new-worker' WHERE id=?").run(first.run.id);
  assert.notEqual(f.stamp(), fenceChanged);
});

test('own context-to-stop input and confirmed execution exit leave cleanup identity unchanged', t => {
  const f = fixture(t), { assignment } = f.execute();
  const options = { excludeTriggerId: 'own-stop' }, before = f.stamp(options);
  f.input('own-stop');
  assert.equal(f.stamp(options), before, 'the original input is excluded before promotion');
  f.store.recordTaskInput({ taskId: 'task', triggerId: 'own-stop', kind: 'stop', idempotencyKey: 'trigger:own-stop' });
  assert.equal(f.stamp(options), before, 'promotion excludes the same whole input identity');
  f.store.cancelTask('task'); f.store.applyTaskStopInput('task', 'own-stop');
  assert.equal(f.stamp(options), before, 'stop controls and application receipts do not invalidate the original intent');
  f.store.confirmExecutionStopped(assignment.id, assignment);
  assert.equal(f.store.getTask('task').executionControl.stopped, true);
  assert.equal(f.stamp(options), before, 'executor release confirmation is expected progress');
  assert.notEqual(f.stamp(), before, 'the stop input is excluded only for its own intent');
});

test('later input identity, snapshot and promotion change stamp but state/application changes do not', t => {
  const f = fixture(t), initial = f.stamp();
  const input = f.input('context');
  const received = f.stamp(); assert.notEqual(received, initial);
  f.sql.prepare("UPDATE sa_task_inputs SET state='applied',application=? WHERE id=?").run(JSON.stringify({ boundaryId: 'expected-progress' }), input.id);
  assert.equal(f.stamp(), received);
  f.sql.prepare('UPDATE sa_task_inputs SET snapshot=? WHERE id=?').run(JSON.stringify({ executionInput: { kind: 'revision' } }), input.id);
  const snapshotChanged = f.stamp(); assert.notEqual(snapshotChanged, received, 'snapshot changes cannot hide behind a stored stale fingerprint');
  f.sql.prepare("UPDATE sa_task_inputs SET state='pending' WHERE id=?").run(input.id);
  f.store.recordTaskInput({ taskId: 'task', triggerId: 'context', kind: 'revision', idempotencyKey: 'trigger:context', snapshot: { target: 'New requirement' } });
  const promoted = f.stamp(); assert.notEqual(promoted, snapshotChanged);
  f.input('later-pause', 'pause');
  assert.notEqual(f.stamp(), promoted, 'a later pause input cannot be mistaken for stop progress');
});

test('pause reason detects resumed initial work while own stop and pause acknowledgement preserve it', t => {
  const f = fixture(t);
  f.store.pauseTask('task');
  const paused = f.stamp();
  f.sql.prepare('UPDATE sa_tasks SET execution_control=? WHERE id=?').run(JSON.stringify({ pauseRequested: true, paused: false }), 'task');
  assert.equal(f.stamp(), paused, 'pause acknowledgement booleans are not an execution identity');
  f.sql.prepare('UPDATE sa_tasks SET execution_control=? WHERE id=?').run(JSON.stringify({ paused: true }), 'task');
  f.store.resumeTask('task');
  assert.notEqual(f.stamp(), paused, 'resuming the initially paused task clears its bound pause reason');
  f.store.pauseTask('task');
  const pausedAgain = f.stamp();
  f.store.cancelTask('task');
  assert.equal(f.stamp(), pausedAgain, 'own stop retains the original pause reason');
});
