import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantRuntimeStore } from '../src/runtime-store.mjs';
import { createAssistantDeliveryWorker } from '../src/delivery-worker.mjs';

test('delivery worker is idempotent and persists failed attempts', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'assistant-delivery-'));
  const database = createAssistantRuntimeStore({ directory });
  t.after(() => database.close());
  t.after(() => rm(directory, { recursive: true, force: true }));
  const task = { id: 'delivery-task', requestId: 'delivery-request', fingerprint: 'delivery-fingerprint', status: 'running', rowVersion: 1, instructionRevision: 1, title: 'delivery' };
  const event = database.notify(task, 'ticket.result', { publication: { action: 'deliver', text: 'ok' }, text: 'ok' }, 'delivery-task:1:completed');
  const sent = [];
  const worker = createAssistantDeliveryWorker({ database, targets: async () => ['phone', 'tablet'], send: async (_event, meta) => { sent.push(meta); return meta.deviceId !== 'tablet'; } });
  const first = await worker.tick();
  assert.equal(first.delivered, 1);
  assert.equal(database.deliveryTargets(event.eventId).find(row => row.deviceId === 'phone').deliveredAt !== null, true);
  assert.equal(database.deliveryTargets(event.eventId).find(row => row.deviceId === 'tablet').deliveredAt, null);
  assert.equal(sent.length, 2);
  const second = await worker.tick();
  assert.equal(second.delivered, 0);
  assert.equal(database.deliveryTargets(event.eventId).find(row => row.deviceId === 'tablet').attempts, 1);
});

test('offline target providers retain outbox rows until a device is available', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'assistant-delivery-offline-'));
  const database = createAssistantRuntimeStore({ directory });
  t.after(() => database.close());
  t.after(() => rm(directory, { recursive: true, force: true }));
  const task = { id: 'offline-task', requestId: 'offline-request', fingerprint: 'offline-fingerprint', status: 'running', rowVersion: 1, instructionRevision: 1, title: 'offline' };
  const event = database.notify(task, 'ticket.result', { publication: { action: 'deliver', text: 'offline' }, text: 'offline' }, 'offline-task:1:completed');
  let sent = 0;
  const worker = createAssistantDeliveryWorker({ database, targets: async () => [], send: async () => { sent++; return true; } });
  const result = await worker.tick();
  assert.equal(result.delivered, 0);
  assert.equal(sent, 0);
  assert.equal(database.outboxStatus(event.eventId).deliveredAt, null);
});
