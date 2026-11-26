import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { createWorkerArchive } from '../src/worker-archive.mjs';

test('Workspace archive events update the projection before the registry getter changes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-worker-archive-'));
  const db = createAssistantOrchestrationStore({ directory });
  const registry = { archivedSessionIds: [] };
  let onChange;
  const archive = createWorkerArchive({ ctx: { workspaceRegistry: registry, on: (_event, listener) => { onChange = listener; } },
    orchestration: db, signal: new AbortController().signal, wake() {} });
  t.after(async () => { await archive.dispose(); db.close(); await rm(directory, { recursive: true, force: true }); });
  db.createThread({ id: 'workspace-archive', source: { type: 'desktop', id: 'owner' } });
  const task = db.createTask({ threadId: 'workspace-archive', target: 'task', mandate: {} });
  db.createAssignment(task.id, { id: 'archive-work' });
  const [assignment] = db.claimAssignments('worker', { validateMandate: () => true });
  const ownership = { owner: assignment.owner, fence: assignment.fence };
  const run = db.prepareRun(assignment.id, { ...ownership, sessionId: 'workspace-worker', directory });
  db.finishAssignment(assignment.id, { ...ownership, status: 'queued' });
  const emitArchive = archivedSessionIds => onChange({ domain: 'workspace', table: '', operation: 'put', value: { archivedSessionIds } });
  emitArchive([run.sessionId]);
  assert.equal(db.getTask(task.id).archived, true);
  assert.equal(db.hasAssignmentWork(), false);
  assert.deepEqual(db.claimAssignments('replacement', { validateMandate: () => true }), []);
  assert.throws(() => db.resumeWorkerConversation(run.sessionId, { owner: 'replacement', validateMandate: () => true }), { code: 'TASK_ARCHIVED' });
  registry.archivedSessionIds = [run.sessionId];
  emitArchive([]);
  assert.equal(db.getTask(task.id).archived, false);
});

test('local native Workers use the archive state stored by Commander', async t => {
  const current = { task: { id: 'task', instructionRevision: 1 }, assignment: { id: 'assignment', fence: 2 }, run: { id: 'run', sessionId: 'native' } };
  const session = { id: 'native', executionId: 'run', archived: false };
  let archived = false;
  const commander = Object.assign(new EventEmitter(), {
    list: () => [session], executionSession: id => id === session.executionId ? session : undefined,
    async archive(id, value, options) {
      assert.equal(id, session.id);
      assert.deepEqual(options, value ? { stopActivity: true } : {});
      session.archived = value;
      this.emit('session/archive', { sessionId: id, archived: value });
    },
  });
  const archive = createWorkerArchive({ ctx: {}, commander, signal: new AbortController().signal, wake() {}, orchestration: {
    getTask: () => ({ ...current.task, archived }), assignments: () => [current.assignment], runs: () => [{ ...current.run, fence: current.assignment.fence }],
    currentArchiveWorker: () => current, syncTaskArchive: ids => { archived = ids.includes(session.id); },
  } });
  t.after(() => archive.dispose());
  const taskId = current.task.id, worker = archive.describeTask(taskId);
  assert.deepEqual(await archive.archiveTask({ taskId, worker, requestId: 'archive' }), { archived: true });
  assert.deepEqual(await archive.unarchiveTask({ taskId, worker, requestId: 'restore' }), { archived: false });
});
