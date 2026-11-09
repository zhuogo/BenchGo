import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { resolveWatchdogConfig } from '../src/watchdog-config.mjs';
import { createWatchdogStore, watchdogDigest } from '../src/watchdog-store.mjs';
import { createWatchdogRuntime } from '../src/watchdog-runtime.mjs';

const epoch = Date.parse('2026-11-09T00:00:00.000Z');
const iso = value => new Date(value).toISOString();
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
function execution(now = epoch, overdue = false) {
  return {
    ticket: { id: 'ticket', status: 'open', instructionRevision: 1 },
    assignment: { id: 'assignment', state: 'claimed', owner: 'owner', fence: 1, leaseUntil: now + 60000 },
    run: { id: 'run', sessionId: 'session', state: 'running', instructionRevision: 1 },
    executionAlive: { status: 'running', observedAt: iso(now), bootId: 'boot-1' },
    request: { state: overdue ? 'inflight' : 'settled', startedAt: iso(now - 5000),
      settledAt: overdue ? null : iso(now), deadline: iso(now - 1) },
    wait: { kind: 'none', since: null, expectedUntil: null },
    stop: { requestedAt: null, confirmedAt: null, confirmationOverdue: false },
    recovery: null,
    watermarks: [{ sessionId: 'session', sourceSeq: 20, flushedSeq: 20, complete: true }],
  };
}
function facts(now = epoch, overdue = false) {
  return { cursor: 20, currentCursor: 20, observedAt: iso(now), bootId: 'boot-1', complete: true,
    truncated: false, schedulerHeartbeat: { at: iso(now) }, executions: [execution(now, overdue)] };
}

async function fixture(t, { config: overrides = {}, readFacts, sendSignal, judge } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-watchdog-runtime-'));
  let time = epoch, store, runtime;
  const config = resolveWatchdogConfig({ targetId: 'fixture-target', targetUrl: 'http://127.0.0.1:3080',
    tokenFile: join(directory, 'unused-token'), sessionId: 'watchdog-session', scheduleId: 'watchdog-schedule',
    probeTimeoutMs: 100, observationWindowMs: 1000, intervalSeconds: 60, backoffMaxMs: 120000,
    escalationAttempts: 3, retentionChecks: 20, ...overrides });
  const calls = { probes: 0, signals: [] };
  const api = {
    directory, config, calls,
    get store() { return store; },
    get runtime() { return runtime; },
    get time() { return time; },
    set time(value) { time = value; },
    receipt(at = time) { return { scheduleId: config.scheduleId, targetSessionId: config.sessionId,
      scheduledAt: iso(at), deliveredAt: iso(time), messageId: `message-${at}` }; },
    async restart() {
      await runtime?.stop();
      await store?.close();
      store = await createWatchdogStore({ directory, config, now: () => time });
      runtime = createWatchdogRuntime({ store, config, client, judge, now: () => time });
    },
  };
  const client = {
    async readFacts(options) {
      calls.probes++;
      return { targetId: config.targetId, facts: readFacts ? await readFacts(api, options) : facts(time) };
    },
    async sendSignal(payload, options) {
      calls.signals.push(structuredClone(payload));
      return sendSignal ? sendSignal(payload, api, options) : { accepted: true, id: payload.id };
    },
  };
  t.after(async () => {
    await runtime?.stop();
    await store?.close();
    const owned = relative(resolve(tmpdir()), resolve(directory));
    assert(owned.startsWith('benchgo-watchdog-runtime-') && !owned.includes('..'));
    await rm(directory, { recursive: true, force: true });
  });
  await api.restart();
  return api;
}

test('completed Schedule occurrences deduplicate durably and restart never completes a running check', async t => {
  const f = await fixture(t), receipt = f.receipt();
  const completed = await f.runtime.check(receipt);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.outcome, 'observed');
  assert.deepEqual(await f.runtime.check({ ...receipt, messageId: 'redelivery' }), completed);
  await f.restart();
  assert.deepEqual(await f.runtime.check(receipt), completed);
  assert.equal(f.calls.probes, 1);

  f.time += 60000;
  const interruptedReceipt = f.receipt();
  const id = `watchdog-check:${watchdogDigest([interruptedReceipt.scheduleId, interruptedReceipt.scheduledAt])}`;
  await f.store.update(state => state.checks.push({ ...interruptedReceipt, id, status: 'running',
    attempt: 1, outcome: 'unknown', completedAt: null }));
  await f.restart();
  const interrupted = f.store.snapshot().checks.find(row => row.id === id);
  assert.equal(interrupted.status, 'interrupted');
  assert.equal(interrupted.completedAt, null);
  assert.equal(interrupted.code, 'WATCHDOG_RESTARTED');
  assert.equal(f.store.snapshot().lastCheckAt, completed.completedAt);
  const resumed = await f.runtime.check(interruptedReceipt);
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.attempt, 2);
  assert.equal(f.calls.probes, 2);
});

test('unreachable targets retain independent checks and send only the resolved signal after recovery', async t => {
  let reachable = false;
  const f = await fixture(t, { readFacts: api => {
    if (!reachable) throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' });
    return facts(api.time);
  } });
  assert.equal((await f.runtime.check(f.receipt())).outcome, 'unreachable');
  f.time += 1000;
  assert.equal((await f.runtime.check(f.receipt())).outcome, 'backoff');
  assert.equal(f.calls.probes, 1);
  f.time = epoch + 60000;
  assert.equal((await f.runtime.check(f.receipt())).outcome, 'unreachable');
  let state = f.store.snapshot();
  assert.equal(state.checks.filter(row => row.outcome === 'unreachable').length, 2);
  assert.equal(state.incidents.length, 1);
  assert.equal(state.incidents[0].observations, 2);
  assert.equal(state.signals.length, 1);
  assert.equal(state.signals[0].state, 'pending');
  assert.equal(state.nextProbeAt, iso(epoch + 180000));
  assert.equal(f.calls.signals.length, 0);
  await f.restart();
  assert.equal(f.runtime.readLog().pendingSignals, 1);
  reachable = true;
  f.time = epoch + 180000;
  assert.equal((await f.runtime.check(f.receipt())).outcome, 'observed');
  state = f.store.snapshot();
  assert.equal(state.probeFailures, 0);
  assert.equal(state.nextProbeAt, null);
  assert.equal(state.incidents[0].active, false);
  assert.equal(state.signals.find(row => row.phase === 'opened').state, 'superseded');
  assert.equal(state.signals.find(row => row.phase === 'resolved').state, 'accepted');
  assert.deepEqual(f.calls.signals.map(row => row.phase), ['resolved']);
  assert.equal(f.runtime.readLog().pendingSignals, 0);
});

test('unknown evidence never reports healthy or resolves a fault before fresh authoritative recovery', async t => {
  let current = facts(epoch, true);
  const f = await fixture(t, { readFacts: () => current });
  assert.equal((await f.runtime.check(f.receipt())).outcome, 'fault');
  for (const change of [
    snapshot => { snapshot.executions[0].request.deadline = null; },
    snapshot => { snapshot.bootId = null; },
    snapshot => { snapshot.executions = []; snapshot.complete = false; snapshot.truncated = true; },
  ]) {
    f.time += 60000;
    current = facts(f.time, true); change(current);
    const check = await f.runtime.check(f.receipt());
    assert.equal(check.outcome, 'unknown');
    assert(check.coverage.unknown.length > 0);
    assert.equal(f.store.snapshot().incidents[0].active, true);
    assert(!f.store.snapshot().signals.some(row => row.phase === 'resolved'));
  }
  f.time += 60000; current = facts(f.time);
  assert.equal((await f.runtime.check(f.receipt())).outcome, 'observed');
  assert.equal(f.store.snapshot().incidents[0].active, false);
  assert.deepEqual(f.calls.signals.map(row => row.phase), ['opened', 'resolved']);
});

test('disabled, paused and maintenance modes journal a skipped check without external work', async t => {
  for (const config of [{ enabled: false }, { paused: true }, { maintenanceUntil: iso(epoch + 60000) }]) {
    const f = await fixture(t, { config, judge: () => assert.fail('maintenance must not invoke the judge') });
    const check = await f.runtime.check(f.receipt());
    assert.equal(check.status, 'completed');
    assert.equal(check.outcome, 'maintenance');
    assert.equal(check.completedAt, iso(epoch));
    assert.equal(f.calls.probes, 0);
    assert.equal(f.calls.signals.length, 0);
    assert.equal(f.store.snapshot().checks.length, 1);
    assert.equal(f.store.snapshot().incidents.length, 0);
  }
});

test('concurrent Schedule deliveries retain the running occurrence and only the latest queued occurrence', async t => {
  const started = deferred(), release = deferred();
  const f = await fixture(t, { readFacts: async api => {
    if (api.calls.probes === 1) { started.resolve(); await release.promise; }
    return facts(api.time);
  } });
  const first = f.runtime.check(f.receipt());
  await started.promise;
  const middle = f.runtime.check(f.receipt(epoch + 60000));
  const latest = f.runtime.check(f.receipt(epoch + 120000));
  const stale = f.runtime.check(f.receipt(epoch + 30000));
  assert.strictEqual(first, middle);
  assert.strictEqual(first, latest);
  assert.strictEqual(first, stale);
  release.resolve();
  await Promise.all([first, middle, latest, stale]);
  assert.equal(f.calls.probes, 2);
  assert.deepEqual(f.store.snapshot().checks.map(row => row.scheduledAt), [iso(epoch), iso(epoch + 120000)]);
  assert.equal((await f.runtime.check(f.receipt(epoch + 60000))).status, 'superseded');
  assert.equal(f.calls.probes, 2);
});

test('a hung auxiliary judge times out after mechanical incidents are persisted and cannot block delivery', async t => {
  let f, judgeSignal, persisted;
  f = await fixture(t, { readFacts: api => facts(api.time, true), judge: async ({ signal }) => {
    judgeSignal = signal;
    persisted = JSON.parse(await readFile(f.store.filename, 'utf8'));
    return new Promise(() => {});
  } });
  // AbortSignal.timeout is unref'ed; keep the test alive and fail if the runtime has no hard bound.
  let timer;
  try {
    const check = await Promise.race([f.runtime.check(f.receipt()), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('hung judge did not honor the runtime bound')), 2000);
    })]);
    assert.equal(judgeSignal.aborted, true);
    assert.equal(persisted.checks[0].status, 'running');
    assert.equal(persisted.incidents[0].reasonCode, 'REQUEST_DEADLINE_EXCEEDED');
    assert.equal(persisted.signals[0].state, 'pending');
    assert.equal(check.status, 'completed');
    assert.equal(check.outcome, 'fault');
    assert.equal(check.model, 'degraded');
    assert(f.store.snapshot().degraded.includes('MODEL_JUDGE_UNAVAILABLE'));
    assert.equal(f.store.snapshot().signals[0].state, 'accepted');
    assert.equal(f.calls.signals.length, 1);
  } finally { clearTimeout(timer); }
});

test('failed signals retry the same durable id and replayed snapshots cannot inflate escalation observations', async t => {
  let current = facts(epoch, true), rejectDelivery = true;
  const f = await fixture(t, { readFacts: () => current, sendSignal: payload => {
    if (rejectDelivery) throw Object.assign(new Error('temporarily unavailable'), { code: 'WATCHDOG_TRANSPORT_OFFLINE' });
    return { accepted: true, id: payload.id };
  } });
  await f.runtime.check(f.receipt());
  const initial = f.store.snapshot().signals[0];
  assert.equal(initial.state, 'pending');
  assert.equal(initial.attempts, 1);
  assert.equal(initial.lastError, 'WATCHDOG_TRANSPORT_OFFLINE');
  assert.equal(initial.nextAttemptAt, iso(epoch + 60000));
  for (const offset of [1, 2]) {
    f.time = epoch + offset;
    await f.runtime.check(f.receipt());
  }
  assert.equal(f.store.snapshot().incidents[0].observations, 1);
  assert.equal(f.store.snapshot().signals.length, 1, 'replayed source evidence must not escalate');
  assert.equal(f.calls.signals.length, 1, 'delivery obeys its retry backoff');
  await f.restart();
  assert.equal(f.store.snapshot().signals[0].id, initial.id);
  rejectDelivery = false; f.time = epoch + 60000; current = facts(f.time, true);
  await f.runtime.check(f.receipt());
  const state = f.store.snapshot(), delivered = state.signals[0];
  assert.equal(state.incidents.length, 1);
  assert.equal(state.signals.length, 1);
  assert.equal(delivered.id, initial.id);
  assert.equal(delivered.state, 'accepted');
  assert.equal(delivered.attempts, 2);
  assert.equal(delivered.nextAttemptAt, null);
  assert.equal(delivered.lastError, null);
  assert.deepEqual(f.calls.signals.map(row => row.id), [initial.id, initial.id]);
});

test('invalid receipts do not probe and shutdown interrupts an uncooperative in-flight probe', async t => {
  const started = deferred();
  const f = await fixture(t, { readFacts: () => { started.resolve(); return new Promise(() => {}); } });
  await assert.rejects(f.runtime.check({ ...f.receipt(), targetSessionId: 'wrong-session' }), { code: 'WATCHDOG_RECEIPT_INVALID' });
  assert.equal(f.calls.probes, 0);
  assert.equal(f.store.snapshot().checks.length, 0);
  const running = f.runtime.check(f.receipt());
  await started.promise;
  await f.runtime.stop();
  const check = await running;
  assert.equal(check.status, 'interrupted');
  assert.equal(check.completedAt, null);
  assert.equal(f.store.snapshot().lastCheckAt, null);
  assert.equal(f.store.snapshot().incidents.length, 0);
  assert.deepEqual(await f.runtime.check(f.receipt(epoch + 60000)), { status: 'stopped' });
  assert.equal(f.calls.probes, 1);
});
