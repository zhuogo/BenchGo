import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createScheduleLifecycle } from '../src/schedule-lifecycle.mjs';
import { createAssistantRuntimeStore } from '../src/runtime-store.mjs';
import { notificationPublication } from '../src/notification-publication.mjs';

const at = '2026-11-05T10:00:00.000Z';
const triggerId = (session, id, occurrence) => `schedule:${createHash('sha256').update(JSON.stringify([session, id, occurrence])).digest('hex')}`;
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'schedule-lifecycle-'));
  let database = createAssistantRuntimeStore({ directory });
  t.after(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
  const entry = { id: 'opaque/schedule', title: '每天检查', prompt: 'PRIVATE INSTRUCTION', target: { kind: 'session', sessionId: 'main-session' }, createdAt: at };
  let state = { mainSessionId: 'main-session', threads: [] }, catalog = [entry], available = true;
  const triggers = new Map(), tickets = new Map(), receipts = [];
  const ctx = { get: () => available ? { catalog: async () => catalog, history: async () => ({ records: receipts }) } : undefined };
  const store = { getState: async () => state, orchestration: {
    getTrigger: id => triggers.get(id), getTicket: id => tickets.get(id),
    listTickets: ({ ownerSessionIds, offset, limit }) => [...tickets.values()].filter(row => ownerSessionIds.includes(row.mandate.source.sessionId)).slice(offset, offset + limit),
  } };
  let lifecycle = createScheduleLifecycle({ ctx, store, database });
  const admit = (time = at) => {
    const source = { channel: 'desktop', sessionId: 'main-session', scheduleId: entry.id, occurrenceAt: time, origin: 'harness-schedule' };
    triggers.set(triggerId(source.sessionId, entry.id, time), { source, actor: { kind: 'machine', id: 'harness-schedule' } });
    return source;
  };
  return { entry, tickets, triggers, receipts, admit, get lifecycle() { return lifecycle; }, get database() { return database; },
    occurrence: (time = at) => lifecycle.occurrence({ entry: { ...entry, sessionId: 'main-session' }, occurrence: { occurrence_at: time } }),
    setState: value => { state = value; }, setCatalog: value => { catalog = value; }, disableHost: () => { available = false; },
    restart: () => { database.close(); database = createAssistantRuntimeStore({ directory }); lifecycle = createScheduleLifecycle({ ctx, store, database }); },
  };
}

test('four lifecycle stages persist, deduplicate retries and respect main-chat clear boundary', async t => {
  const f = await fixture(t);
  await Promise.all([f.lifecycle.sync(), f.lifecycle.sync()]);
  const source = f.admit();
  await Promise.all([f.occurrence(), f.occurrence()]);
  f.tickets.set('done', { id: 'done', title: '每天检查', status: 'completed', updatedAt: at, mandate: { admission: 'desktop-schedule', source } });
  const failedAt = '2026-11-06T10:00:00.000Z';
  const failedSource = f.admit(failedAt);
  f.tickets.set('failed', { id: 'failed', title: '每天检查', status: 'failed', updatedAt: failedAt, mandate: { admission: 'desktop-schedule', source: failedSource } });
  await f.lifecycle.sync();
  const events = f.database.chatNotifications('main').events;
  assert.deepEqual(events.map(row => row.schedule.phase), ['created', 'triggered', 'completed', 'triggered', 'failed']);
  assert.ok(events.every(row => row.origin === 'system' && row.type === 'schedule.lifecycle' && row.threadId === 'main'));
  assert.equal(f.database.chatNotifications('other').events.length, 0);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE INSTRUCTION/);
  f.restart(); await f.lifecycle.sync();
  assert.deepEqual(f.database.chatNotifications('main').events, events);
  f.database.clearMainChatNotifications(); await f.lifecycle.sync();
  assert.equal(f.database.chatNotifications('main').events.length, 0);
  assert.equal(f.database.notifications().events.length, 5, 'clear hides existing history without deleting audit facts');
});

test('only owned sessions and recorded official occurrences can project facts', async t => {
  const f = await fixture(t);
  await f.occurrence();
  assert.equal(f.database.notifications().events.length, 0, 'callback alone is not evidence');
  const source = f.admit();
  f.setCatalog([{ ...f.entry, target: { kind: 'session', sessionId: 'foreign' } },
    { ...f.entry, id: 'archived', target: { kind: 'session', sessionId: 'archived' } }]);
  f.setState({ mainSessionId: 'other', threads: [{ sessionId: 'main-session', archived: true }] });
  f.tickets.set('done', { id: 'done', status: 'completed', updatedAt: at, mandate: { admission: 'desktop-schedule', source } });
  await f.occurrence(); await f.lifecycle.ticket({ id: 'done' }); await f.lifecycle.sync();
  assert.equal(f.database.notifications().events.length, 0);
});

test('terminal projection reads persistent Ticket and reconstructs after schedule service removal', async t => {
  const f = await fixture(t), source = f.admit();
  f.disableHost();
  await f.lifecycle.ticket({ id: 'forged', status: 'completed', updatedAt: at, mandate: { admission: 'desktop-schedule', source } });
  assert.equal(f.database.notifications().events.length, 0);
  f.tickets.set('real', { id: 'real', status: 'completed', updatedAt: at, mandate: { admission: 'desktop-schedule', source } });
  await f.lifecycle.sync();
  assert.deepEqual(f.database.notifications().events.map(row => row.schedule.phase), ['triggered', 'completed']);
});

test('latest saved receipt repairs a missed projection only after a durable admission', async t => {
  const f = await fixture(t);
  f.entry.lastDelivery = { scheduledAt: at };
  f.receipts.push({ scheduledAt: at, targetSessionId: 'main-session' });
  await f.lifecycle.sync();
  assert.deepEqual(f.database.notifications().events.map(row => row.schedule.phase), ['created']);
  f.admit(); await f.lifecycle.sync();
  assert.deepEqual(f.database.notifications().events.map(row => row.schedule.phase), ['created', 'triggered']);
});

test('schedule notification allowlist keeps system facts and strips executable or raw content', () => {
  const fact = { type: 'schedule.lifecycle', origin: 'system', schedule: { id: 's', title: '提醒', sourceSessionId: 'main-session', phase: 'created', at },
    text: 'FORGED TEXT', options: ['execute'], publication: { action: 'deliver', text: 'RAW' }, source: { secret: true } };
  const event = notificationPublication(fact);
  assert.equal(event.text, '定时任务已创建：提醒');
  assert.equal(event.options, undefined); assert.equal(event.publication, undefined); assert.equal(event.source, undefined);
  assert.deepEqual(notificationPublication(event), event);
  for (const invalid of [{ ...fact, origin: 'router' }, { ...fact, schedule: { ...fact.schedule, phase: 'invented' } },
    { ...fact, schedule: { ...fact.schedule, phase: 'triggered' } }, { ...fact, schedule: { ...fact.schedule, phase: 'completed', occurrenceAt: at } }]) {
    assert.equal(notificationPublication(invalid), null);
  }
});
