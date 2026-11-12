import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWatchdogScheduleBridge, watchdogSchedulePrompt } from '../src/watchdog-schedule.mjs';
import { createWatchdogStore } from '../src/watchdog-store.mjs';
import { resolveWatchdogConfig } from '../src/watchdog-config.mjs';
import { createWatchdogRuntime } from '../src/watchdog-runtime.mjs';
import { createWatchdogHost } from './watchdog-host-fixture.mjs';

async function fixture(t, check, { client } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-watchdog-schedule-'));
  const config = resolveWatchdogConfig({ targetId: 'fixture-target', targetUrl: 'http://127.0.0.1:3080',
    tokenFile: join(directory, 'unused-token'), sessionId: 'watchdog-schedule-fixture', intervalSeconds: 3600, backoffMaxMs: 3600000 });
  const opened = [];
  const open = async () => {
    const store = await createWatchdogStore({ directory, config });
    let host;
    try { host = await createWatchdogHost({ directory, sessionId: store.snapshot().sessionId }); }
    catch (error) { await store.close(); throw error; }
    const watchdog = client ? createWatchdogRuntime({ store, config, client }) : { check };
    const bridge = createWatchdogScheduleBridge({ ctx: host.ctx, watchdog, store, config, ensureSession: host.ensureSession });
    let closed = false;
    const current = { ...host, bridge, store, config, watchdog, async close() {
      if (closed) return;
      closed = true;
      await bridge.stop(); await watchdog.stop?.(); await host.close(); await store.close();
    } };
    opened.push(current);
    return current;
  };
  t.after(async () => {
    for (const current of opened.reverse()) await current.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { ...(await open()), reopen: open };
}

test('official Schedule receipt is durable before the mechanical Watchdog check completes, with no model request', { timeout: 10000 }, async t => {
  const begun = Promise.withResolvers(), finish = Promise.withResolvers();
  let probes = 0;
  t.after(() => finish.resolve());
  const host = await fixture(t, undefined, { client: {
    async readFacts() {
      probes++; begun.resolve(); await finish.promise;
      const observedAt = new Date().toISOString();
      return { targetId: 'fixture-target', facts: { observedAt, bootId: 'fixture-boot', cursor: 1, currentCursor: 1,
        executions: [], complete: true, truncated: false, schedulerHeartbeat: { at: observedAt } } };
    },
    async sendSignal() { assert.fail('healthy empty execution facts do not emit an incident'); },
  } });
  await Promise.all([host.bridge.start(), host.bridge.start()]);
  const state = host.store.snapshot();
  assert.ok(state.scheduleId);
  assert.equal((await host.ctx.schedule.catalog()).length, 1, 'concurrent starts share one official Schedule registration');
  const delivered = await host.ctx.schedule.run({ id: state.scheduleId });
  await begun.promise;
  const history = await host.ctx.schedule.history({ id: state.scheduleId, limit: 1 });
  assert.equal(history.records.length, 1);
  const [running] = host.store.snapshot().checks;
  assert.equal(running.status, 'running', 'Schedule acknowledged inbox durability, not the pending check');
  assert.equal(running.completedAt, null);
  assert.equal(running.messageId, history.records[0].messageId);
  assert.equal(host.store.snapshot().lastCheckAt, null);
  assert.equal(delivered.lastDelivery.messageId, history.records[0].messageId);
  const agent = await host.ensureSession();
  await agent.whenIdle();
  assert.equal(host.requests.length, 0, 'a mechanical check consumes the Schedule message without a model turn');
  assert.ok(agent.session.snapshotEvents().some(event => event.type === 'agent/inbox/spliced'
    && event.data.inserted.some(message => message.id === history.records[0].messageId && message.source.kind === 'schedule')));
  finish.resolve();
  await host.bridge.reconcile();
  assert.equal(host.store.snapshot().checks[0].status, 'completed');
  assert.ok(host.store.snapshot().checks[0].completedAt);
  assert.deepEqual(host.watchdog.readLog().degraded, []);
  host.ctx.emit('schedule/changed'); host.ctx.emit('schedule/changed');
  await host.bridge.reconcile();
  assert.equal(probes, 1, 'duplicate Schedule notifications do not repeat a completed probe');
  assert.equal(host.store.snapshot().checks.length, 1);
  assert.equal((await host.ctx.schedule.catalog()).length, 1);
  await host.close();
  const restarted = await host.reopen();
  await restarted.bridge.start();
  assert.equal(probes, 1, 'a completed check is deduplicated from persisted state after host restart');
  assert.equal(restarted.store.snapshot().checks.length, 1);
  assert.equal(restarted.store.snapshot().checks[0].id, running.id);
  assert.equal(restarted.requests.length, 0);
});

test('bridge restart reuses its durable official Schedule and reads only the newest missed receipt', { timeout: 10000 }, async t => {
  // Exercise the official one-minute admission floor without waiting a real minute.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const checks = [];
  const host = await fixture(t, async receipt => { checks.push(receipt); });
  await host.bridge.start();
  const id = host.store.snapshot().scheduleId;
  await host.bridge.stop();
  const first = await host.ctx.schedule.run({ id });
  await (await host.ensureSession()).whenIdle();
  t.mock.timers.setTime(Date.now() + 61000);
  const second = await host.ctx.schedule.run({ id });
  await (await host.ensureSession()).whenIdle();
  assert.notEqual(first.lastDelivery.messageId, second.lastDelivery.messageId);
  assert.equal((await host.ctx.schedule.history({ id, limit: 100 })).records.length, 2);
  assert.equal(checks.length, 0, 'stopped bridge does not consume delivery events');
  await host.close();

  const restarted = await host.reopen();
  await restarted.bridge.start();
  assert.equal(restarted.store.snapshot().scheduleId, id);
  assert.equal((await restarted.ctx.schedule.catalog()).length, 1, 'restart must not create a second clock');
  assert.equal(checks.length, 1);
  assert.equal(checks[0].messageId, second.lastDelivery.messageId, 'recovery checks the latest snapshot rather than replaying the missed backlog');
  assert.equal((await restarted.ctx.schedule.history({ id, limit: 100 })).records.length, 2, 'reading history never generates another delivery');
  assert.equal(restarted.requests.length, 0);
  assert.equal((await restarted.ensureSession()).session.snapshotEvents().some(event => event.type === 'request/header'), false);
});

test('registration crash recovery matches exact session and prompt rather than a title', { timeout: 10000 }, async t => {
  const host = await fixture(t, async () => {});
  const sessionId = host.store.snapshot().sessionId;
  const expected = await host.ctx.schedule.create({ title: 'Renamed by the operator', prompt: watchdogSchedulePrompt,
    timing: { kind: 'every', every_seconds: 3600 }, target: { kind: 'session', sessionId } });
  const unrelated = await host.ctx.schedule.create({ title: 'BenchGo Watchdog', prompt: 'A separate user reminder',
    timing: { kind: 'every', every_seconds: 3600 }, target: { kind: 'session', sessionId } });
  assert.equal(host.store.snapshot().scheduleId, null, 'simulate a crash before the bridge saved the official id');
  await host.bridge.start();
  assert.equal(host.store.snapshot().scheduleId, expected.id);
  assert.equal((await host.ctx.schedule.catalog()).length, 2);
  assert.equal((await host.ctx.schedule.catalog()).find(row => row.id === unrelated.id).prompt, 'A separate user reminder');
});

test('an ordinary official Schedule pause survives change events and a bridge restart', { timeout: 10000 }, async t => {
  const checks = [];
  const host = await fixture(t, async receipt => { checks.push(receipt); });
  await host.bridge.start();
  const id = host.store.snapshot().scheduleId;
  await host.ctx.schedule.edit({ id, action: 'update', patch: { active: false } });
  await host.bridge.reconcile();
  assert.equal((await host.ctx.schedule.catalog()).find(row => row.id === id).status, 'paused');
  await host.close();
  const restarted = await host.reopen();
  await restarted.bridge.start();
  assert.equal((await restarted.ctx.schedule.catalog()).find(row => row.id === id).status, 'paused');
  assert.equal(restarted.store.snapshot().scheduleSuspended, false);
  assert.equal(checks.length, 0);
});

test('ambiguous registration recovery stops without creating another official Schedule', { timeout: 10000 }, async t => {
  const host = await fixture(t, async () => { assert.fail('ambiguous registration must not check'); });
  const sessionId = host.store.snapshot().sessionId;
  for (const title of ['First record', 'Second record']) await host.ctx.schedule.create({ title, prompt: watchdogSchedulePrompt,
    timing: { kind: 'every', every_seconds: 3600 }, target: { kind: 'session', sessionId } });
  await assert.rejects(host.bridge.start(), { code: 'WATCHDOG_SCHEDULE_INVALID' });
  assert.equal(host.store.snapshot().scheduleId, null);
  assert.equal((await host.ctx.schedule.catalog()).length, 2);
});
