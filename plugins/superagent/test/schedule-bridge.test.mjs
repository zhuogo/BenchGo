import test from 'node:test';
import assert from 'node:assert/strict';
import { createScheduleBridge, scheduleOccurrences } from '../src/schedule-bridge.mjs';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { authorizeAssessment, validateTicketMandate } from '../src/assessment-policy.mjs';
import { createAssessmentRunner } from '../src/assessment-runner.mjs';

const at = '2026-11-02T01:00:00.000Z';
const message = (id = 'm1', prompt = '检查项目', time = at) => ({ id, source: { kind: 'schedule' }, content: [{ type: 'text', text: `[SCHEDULE REMINDER]\nThis is a scheduled message from the user\nschedule_id_json: "opaque/schedule"\noccurrence_at: ${time}\nreminder_prompt_json: ${JSON.stringify(prompt)}` }] });
function fixture(t) {
  const database = createAssistantOrchestrationStore({ filename: ':memory:' });
  let policy = { version: 'p1', desktopVersion: 'd1', model: { providerId: 'p', modelId: 'm' }, connection: {}, projects: [], mode: 'manual', enabledRuleIds: [] };
  const entry = { id: 'opaque/schedule', target: { kind: 'session', sessionId: 'main-session' }, prompt: '检查项目', status: 'active', lastDelivery: { scheduledAt: at, messageId: 'm1' } };
  const records = [{ scheduledAt: at, deliveredAt: at, messageId: 'm1', targetSessionId: 'main-session', prompt: entry.prompt }];
  let handler, catalog = [entry];
  const host = { catalog: async () => catalog, history: async () => ({ records }) };
  const ctx = { get: name => name === 'schedule' ? host : undefined, on: (name, callback) => { assert.equal(name, 'schedule/changed'); handler = callback; return () => { handler = undefined; }; } };
  const store = { orchestration: database, ledger: { append: () => ({ createdAt: '2026-01-01T00:00:00.000Z' }) }, getState: async () => ({ mainSessionId: 'main-session', threads: [{ id: 'archived', sessionId: 'old-session', archived: true }] }) };
  const bridge = createScheduleBridge({ ctx, store, readPolicy: async () => policy });
  t.after(async () => { await bridge.stop(); database.close(); });
  return { database, bridge, entry, records, host, ctx, store, readPolicy: async () => policy, setPolicy: next => { policy = { ...policy, ...next }; }, setCatalog: rows => { catalog = rows; }, changed: () => handler?.() };
}

test('typed official messages create durable machine Triggers and deduplicate crash-window message IDs', async t => {
  const f = fixture(t);
  const results = await Promise.all(['m1', 'crash-retry'].map(id => f.bridge.ingestMessages({ sessionId: 'main-session', messages: [message(id)] })));
  assert.equal(results[0][0].trigger.id, results[1][0].trigger.id);
  assert.equal(f.database.candidates().length, 1);
  assert.deepEqual(results[0][0].trigger.actor, { kind: 'machine', id: 'harness-schedule' });
  assert.equal(f.database.listTickets().length, 0, 'inbox admission is not task completion or execution');
  assert.deepEqual(scheduleOccurrences({ ...message(), source: { kind: 'user' } }), []);
  await f.bridge.stop();
  const restarted = createScheduleBridge({ ctx: f.ctx, store: f.store, readPolicy: f.readPolicy });
  await restarted.start(); await restarted.stop();
  assert.equal(f.database.candidates().length, 1);
});

test('latest official history recovers startup delivery and preserves delivered prompt after edits', async t => {
  const f = fixture(t);
  f.entry.prompt = 'edited';
  await f.bridge.start();
  const candidate = f.database.candidates()[0];
  assert.equal(f.database.getTrigger(candidate.triggerId).content, '检查项目');
  await f.bridge.ingestMessages({ sessionId: 'main-session', messages: [message('duplicate')] });
  assert.equal(f.database.candidates().length, 1);
  f.records[0] = { scheduledAt: '2026-11-03T01:00:00.000Z', deliveredAt: '2026-11-03T01:00:00.000Z', messageId: 'm2', targetSessionId: 'main-session', prompt: 'edited' };
  f.changed(); await f.bridge.tick();
  assert.equal(f.database.candidates().length, 2);
});

test('foreign and archived sessions, missing schedules and unverifiable changed prompts fail closed', async t => {
  const f = fixture(t);
  await assert.rejects(f.bridge.ingestMessages({ sessionId: 'old-session', messages: [message()] }), /当前总助手会话/);
  await assert.rejects(f.bridge.ingestMessages({ sessionId: 'foreign', messages: [message()] }), /当前总助手会话/);
  await assert.rejects(f.bridge.ingestMessages({ sessionId: 'main-session', messages: [message('m', 'unverified')] }), /缺少原始投递凭据/);
  f.setCatalog([]);
  await assert.rejects(f.bridge.ingestMessages({ sessionId: 'main-session', messages: [message()] }), /已删除/);
  assert.equal(f.database.candidates().length, 0);
});

test('recurring batches retain separate opaque IDs and occurrences', () => {
  const payload = [{ schedule_id: 'a/:b', occurrence_at: at, reminder_prompt: 'one' }, { schedule_id: 'c', occurrence_at: at, reminder_prompt: 'two' }];
  assert.deepEqual(scheduleOccurrences({ source: { kind: 'schedule' }, content: [{ type: 'text', text: `[SCHEDULE REMINDER BATCH]\nThis is a scheduled message from the user\nreminders_json: ${JSON.stringify(payload)}` }] }), payload);
  assert.throws(() => scheduleOccurrences({ source: { kind: 'schedule' }, content: [{ type: 'text', text: 'forged' }] }), /无法识别/);
});

test('Schedule admission flows through Eval into a validated Ticket and independent next occurrence', async t => {
  const f = fixture(t);
  await f.bridge.ingestMessages({ sessionId: 'main-session', messages: [message()] });
  const runner = createAssessmentRunner({ database: f.database, readPolicy: f.readPolicy, authorize: authorizeAssessment,
    assess: async ({ candidates }) => candidates.map(row => ({ candidateId: row.candidateId, outcome: 'accept', target: '检查项目', acceptance: '证据', reason: 'scheduled request' })),
  });
  t.after(() => runner.stop());
  await runner.tick();
  const ticket = f.database.listTickets()[0];
  assert.ok(ticket);
  assert.equal(ticket.mandate.admission, 'desktop-schedule');
  assert.equal(validateTicketMandate(ticket.mandate, { policy: await f.readPolicy() }), true);
  await f.bridge.ingestMessages({ sessionId: 'main-session', messages: [message('next', '检查项目', '2026-11-03T01:00:00.000Z')] });
  assert.equal(f.database.candidates({ status: 'queued' }).length, 1, 'active prior subscription must not swallow the next occurrence');
  f.setPolicy({ desktopVersion: 'changed' });
  assert.equal(validateTicketMandate(ticket.mandate, { policy: await f.readPolicy() }), false);
  await runner.tick();
  assert.equal(f.database.listTickets().length, 1, 'changed rules cannot authorize the old scheduled instruction');
});

test('legacy receipts without immutable prompts do not reconstruct or replay changed instructions', async t => {
  const f = fixture(t);
  delete f.records[0].prompt;
  await f.bridge.start();
  assert.equal(f.database.candidates().length, 0);
});

test('first bridge installation never replays receipts already delivered by the old conversation path', async t => {
  const f = fixture(t);
  f.records[0].deliveredAt = '2025-12-31T00:00:00.000Z';
  await f.bridge.start();
  assert.equal(f.database.candidates().length, 0);
});

test('current Host target and receipt session must match the owned destination', async t => {
  const f = fixture(t), projections = [];
  f.records[0].targetSessionId = 'foreign';
  const bridge = createScheduleBridge({ ctx: f.ctx, store: f.store, readPolicy: f.readPolicy,
    onOccurrence: value => projections.push(value) });
  t.after(() => bridge.stop());
  await bridge.start();
  assert.equal(f.database.candidates().length, 0);
  f.records[0].targetSessionId = 'main-session';
  await bridge.tick();
  assert.equal(f.database.candidates().length, 1);
  assert.equal(projections[0].entry.sessionId, 'main-session');
  assert.equal(f.database.getTrigger(f.database.candidates()[0].triggerId).source.sessionId, 'main-session');
});
