import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAssistantStore } from '../src/store.mjs';
import { createOrchestrationRuntime } from '../src/orchestration-runtime.mjs';
import { createTaskManagement } from '../src/task-management.mjs';

test('task management selects recent activity before the runtime ticket limit without changing default order', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-task-list-order-'));
  const store = await createAssistantStore({ dataDirectory: directory });
  const runtime = createOrchestrationRuntime({ ctx: {}, store, execute: async () => { throw new Error('read-only query must not execute'); } });
  t.after(async () => { await runtime.stop(); await store.close(); await rm(directory, { recursive: true, force: true }); });
  const database = store.orchestration;
  database.createThread({ id: 'thread', source: { type: 'desktop', id: 'owner' } });
  const start = Date.parse('2026-11-01T00:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const rows = Array.from({ length: 1002 }, (_, index) => {
    t.mock.timers.setTime(start + index * 1000);
    return database.createTicket({ threadId: 'thread', target: `task-${index}`, mandate: { source: { channel: 'desktop', sessionId: 'owner' } } });
  });
  t.mock.timers.setTime(start + 2000000);
  database.updateTicket(rows[0].id, { title: 'old task with recent activity' });
  const tasks = createTaskManagement({ database: { meta: () => undefined } });
  const recent = tasks.project('ticket', runtime.state({ newestFirst: true }));
  assert.equal(recent.length, 1000);
  assert.equal(recent[0].id, rows[0].id, 'last activity wins over creation time');
  assert.equal(recent[1].id, rows.at(-1).id, 'new tickets beyond the oldest 1000 are selected before limiting');
  assert.equal(recent.some(row => row.id === rows[1].id), false);
  const original = runtime.state();
  assert.deepEqual(original.map(row => row.id), rows.slice(0, 1000).map(row => row.id));
  assert.equal(original.some(row => row.id === rows.at(-1).id), false);
});
