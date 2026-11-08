import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantRuntimeStore } from '../src/runtime-store.mjs';
import { DatabaseSync } from 'node:sqlite';
import { systemStateDelivery } from '../src/result-delivery.mjs';

test('legacy delivery keys expose the same stable signal identity for the Router reply', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-legacy-state-key-'));
  const db = createAssistantRuntimeStore({ directory });
  t.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  const event = db.notify({ id: 'ticket', threadId: 'main' }, 'ticket.result', {
    publication: { action: 'deliver', origin: 'router', text: '执行记录还在，我会在恢复条件具备后继续。' }, ticketId: 'ticket',
  }, 'ticket-delivery:assignment-system-state:work:1:execution');
  assert.equal(event.ticketStateEventKey, undefined);
  const restored = db.chatNotifications('main').events[0];
  assert.equal(restored.ticketStateEventKey, 'assignment-system-state:work:1:execution');
  assert.equal(restored.id, event.id);
});

test('Router wording and provenance survive persistence, history and every delivery projection', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-system-publication-'));
  let db = createAssistantRuntimeStore({ directory });
  t.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  const publication = { action: 'deliver', origin: 'router', text: '结果已经保存，正在等待原渠道恢复。' };
  const event = db.notify({ id: 'system-ticket', threadId: 'main' }, 'ticket.result', {
    publication, origin: 'worker', systemState: { state: 'untrusted' }, text: 'RAW WORKER OUTPUT',
  }, 'system-ticket:1');
  db.registerDeliveryTargets(event.eventId, ['phone']);
  db.close();
  db = createAssistantRuntimeStore({ directory });
  for (const projected of [event, db.notifications().events[0], db.chatNotifications('main').events[0],
    db.pendingOutbox()[0].event, db.pendingDeliveries()[0].event]) {
    assert.equal(projected.origin, 'router');
    assert.equal(projected.systemState, undefined);
    assert.equal(projected.text, publication.text);
    assert.doesNotMatch(JSON.stringify(projected), /untrusted|RAW WORKER OUTPUT/);
  }
});

test('old system templates and Worker bodies remain raw history but never reenter conversation or delivery', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-legacy-notification-'));
  let db = createAssistantRuntimeStore({ directory });
  t.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  const raw = new DatabaseSync(db.path);
  const records = [
    { id: 'system', publication: systemStateDelivery({ state: 'delivery_wait', code: 'ROUTER_DELIVERY_MISSING', stage: 'publication' }) },
    { id: 'worker', publication: { action: 'deliver', origin: 'worker', text: 'PRIVATE WORKER BODY' } },
  ].map(row => ({ ...row, eventId: row.id, type: 'ticket.result', threadId: 'main', text: row.publication.text }));
  for (const event of records) {
    raw.prepare('INSERT INTO task_events(id,unique_key,task_id,payload) VALUES (?,?,?,?)')
      .run(event.id, `ticket-delivery:${event.id}`, 'legacy-ticket', JSON.stringify(event));
    raw.prepare('INSERT INTO task_outbox(event_id) VALUES (?)').run(event.id);
    db.registerDeliveryTargets(event.id, ['phone']);
  }
  raw.close();
  db.close(); db = createAssistantRuntimeStore({ directory });
  assert.deepEqual(db.notifications().events, []);
  assert.deepEqual(db.chatNotifications('main').events, []);
  assert.deepEqual(db.pendingDeliveries(), []);
  assert.deepEqual(db.pendingOutbox(), []);
  const inspection = new DatabaseSync(db.path);
  for (const event of records) {
    assert.equal(inspection.prepare('SELECT payload FROM task_events WHERE id=?').get(event.id).payload, JSON.stringify(event));
    assert.equal(db.outboxStatus(event.id).lastError, 'publication-suppressed');
    assert.ok(db.deliveryTargets(event.id)[0].deliveredAt);
    assert.throws(() => db.notify({ id: 'legacy-ticket' }, 'ticket.result', event, `ticket-delivery:${event.id}`), /not publishable/);
  }
  inspection.close();
});

test('notification store persists events, cursors and read state', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-runtime-store-'));
  const db = createAssistantRuntimeStore({ directory });
  t.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  const event = db.notify({ id: 'ticket-1', threadId: 'main' }, 'ticket.result', { publication: { action: 'deliver', origin: 'router', text: 'done' }, text: 'done', result: { acceptanceVerdict: 'passed' } }, 'ticket-1:1:completed');
  assert.equal(event.seq, 1);
  const page = db.notifications({ after: 0 });
  assert.equal(page.events.length, 1);
  assert.equal(page.events[0].publication.text, 'done');
  assert.equal(page.events[0].result, undefined);
  db.markRead([page.events[0].eventId]);
  assert.equal(db.notifications({ after: 0, unread: true }).events.length, 0);
  const receipt = db.ackDelivery(page.events[0].eventId, 'phone-1');
  assert.equal(receipt.deviceId, 'phone-1');
  assert.equal(db.deliveryReceipts(page.events[0].eventId)[0].deviceId, 'phone-1');
  const batch = db.ackDeliveries([page.events[0].eventId], 'tablet-1');
  assert.deepEqual(batch.eventIds, [page.events[0].eventId]);
  assert.deepEqual(db.deliveryReceipts(page.events[0].eventId).map(row => row.deviceId), ['phone-1', 'tablet-1']);
});

test('history and every delivery queue project formal messages and settle legacy raw events', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-publication-'));
  const db = createAssistantRuntimeStore({ directory });
  t.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  const raw = new DatabaseSync(db.path);
  const legacy = { type: 'ticket.completed', text: 'PRIVATE WORKER OUTPUT', result: { secret: 'never publish' } };
  raw.prepare('INSERT INTO task_events(id,unique_key,task_id,payload) VALUES (?,?,?,?)').run('old', 'old', 'ticket', JSON.stringify(legacy));
  raw.prepare('INSERT INTO task_outbox(event_id) VALUES (?)').run('old');
  raw.close();
  db.registerDeliveryTargets('old', ['phone']);
  const valid = db.notify({ id: 'new', threadId: 'side' }, 'ticket.result', {
    publication: { action: 'deliver', origin: 'router', text: 'Public result' }, text: 'RAW', result: { secret: 'SECRET' }, reasoning: 'HIDDEN',
  }, 'new');
  db.registerDeliveryTargets(valid.eventId, ['phone']);
  const targets = db.pendingDeliveries();
  assert.equal(targets.length, 1);
  assert.equal(JSON.stringify(targets).includes('SECRET'), false);
  assert.equal(JSON.stringify(targets).includes('payload'), false);
  assert.equal(db.outboxStatus('old').lastError, 'publication-suppressed');
  assert.ok(db.deliveryTargets('old')[0].deliveredAt);
  assert.equal(db.pendingOutbox().length, 1);
  assert.equal(db.pendingOutbox()[0].event.text, 'Public result');
  assert.equal(db.notifications().events.length, 1);
  assert.throws(() => db.notify({ id: 'ticket' }, 'ticket.completed', legacy, 'old'), /not publishable/);
});

test('side chat notifications remain at their source and never join main implicitly', () => {
  const db = createAssistantRuntimeStore({ filename: ':memory:' });
  try {
    db.notify({ id: 'side-ticket', threadId: 'side-chat' }, 'ticket.result', { publication: { action: 'deliver', origin: 'router', text: 'side result' }, text: 'side result', threadRefs: ['main', 'side-chat'] }, 'side-result');
    assert.equal(db.notifications({ threadId: 'main' }).events.length, 0);
    const page = db.notifications({ threadId: 'side-chat' });
    assert.equal(page.events.length, 1);
    assert.deepEqual(page.events[0].threadRefs, ['side-chat']);
    assert.equal(db.notifications({ threadId: 'other-side' }).events.length, 0);
  } finally { db.close(); }
});

test('clearing main chat hides earlier notifications only from its chat history', () => {
  const db = createAssistantRuntimeStore({ filename: ':memory:' });
  try {
    const main = { id: 'main-task', threadId: 'main' }, side = { id: 'side-task', threadId: 'side' };
    db.notify(main, 'ticket.attention', { text: 'old' }, 'main-old');
    db.notify(side, 'ticket.attention', { text: 'side' }, 'side-old');
    db.clearMainChatNotifications();
    assert.deepEqual(db.chatNotifications('main').events, []);
    assert.equal(db.chatNotifications('side').events[0].text, 'side');
    assert.equal(db.notifications({ threadId: 'main' }).events[0].text, 'old');
    db.notify(main, 'ticket.attention', { text: 'new' }, 'main-new');
    assert.deepEqual(db.chatNotifications('main').events.map(event => event.text), ['new']);
  } finally { db.close(); }
});

test('other-thread notifications cannot consume the requested thread page', () => {
  const db = createAssistantRuntimeStore({ filename: ':memory:' });
  try {
    for (let i = 0; i < 4; i++) db.notify({ id: 'other', threadId: 'other' }, 'ticket.attention', { text: 'Other question' }, `other:${i}`);
    db.notify({ id: 'mine', threadId: 'main' }, 'ticket.attention', { text: 'My question' }, 'mine');
    const page = db.notifications({ threadId: 'main', limit: 2 });
    assert.equal(page.events.length, 1);
    assert.equal(page.events[0].text, 'My question');
    assert.equal(page.hasMore, false);
    assert.equal(db.notifications({ threadId: 'empty', limit: 2 }).hasMore, false);
  } finally { db.close(); }
});

test('durable outbox tracks per-device targets, retries independently and closes only after every target', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'assistant-outbox-targets-'));
  const db = createAssistantRuntimeStore({ directory });
  t.after(() => db.close());
  t.after(() => rm(directory, { recursive: true, force: true }));
  const task = { id: 'task-targets', threadId: 'main' };
  const event = db.notify(task, 'ticket.result', { publication: { action: 'deliver', origin: 'router', text: 'done' }, text: 'done' }, 'task-targets:1:completed');
  assert.deepEqual(db.registerDeliveryTargets(event.eventId, ['phone', 'tablet', 'phone']).map(row => row.deviceId), ['phone', 'tablet']);
  assert.equal(db.pendingDeliveries(Date.now()).length, 2);
  db.deliveryTargetAttempt(event.eventId, 'phone', { error: 'offline' });
  assert.equal(db.outboxStatus(event.eventId).deliveredAt, null);
  db.deliveryTargetAttempt(event.eventId, 'phone', { delivered: true });
  db.deliveryTargetAttempt(event.eventId, 'tablet', { delivered: true });
  assert.ok(db.outboxStatus(event.eventId).deliveredAt);
  assert.equal(db.deliveryTargets(event.eventId).filter(row => row.deliveredAt).length, 2);
  db.ackDelivery(event.eventId, 'phone');
  db.ackDelivery(event.eventId, 'phone');
  assert.equal(db.deliveryReceipts(event.eventId).length, 1);
});

