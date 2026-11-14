import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readWatchdogToken, resolveWatchdogConfig } from '../src/watchdog-config.mjs';
import { createWatchdogObservationClient } from '../src/watchdog-observation-route.mjs';
import { createWatchdogRuntime } from '../src/watchdog-runtime.mjs';

const iso = value => new Date(value).toISOString();
const epoch = Date.parse('2026-11-09T00:00:00.000Z');

test('deployment token files and the observation transport share the same credential format', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-watchdog-token-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, 'token');
  const client = token => createWatchdogObservationClient({ origin: 'http://127.0.0.1:3080', targetId: 'target', token });
  for (const token of ['a'.repeat(30) + '_-', 'a'.repeat(254) + '_-']) {
    await writeFile(filename, `${token}\r\n`);
    const loaded = await readWatchdogToken(filename);
    assert.equal(loaded, token);
    assert.doesNotThrow(() => client(loaded));
  }
  for (const token of ['a'.repeat(31), 'a'.repeat(257), 'a'.repeat(31) + '+', 'a'.repeat(31) + '/',
    'a'.repeat(16) + ' ' + 'a'.repeat(16), 'a'.repeat(16) + '\n' + 'a'.repeat(16)]) {
    await writeFile(filename, token);
    await assert.rejects(readWatchdogToken(filename), { code: 'WATCHDOG_CONFIG_INVALID' });
    assert.throws(() => client(token), { code: 'WATCHDOG_TOKEN_INVALID' });
  }
});

function fixture(t, readFacts) {
  let at = epoch;
  const config = resolveWatchdogConfig({ targetId: 'fixture-target', targetUrl: 'http://127.0.0.1:3080',
    tokenFile: join(tmpdir(), 'unused-watchdog-token'), sessionId: 'watchdog-fixture', scheduleId: 'schedule',
    intervalSeconds: 60, backoffMaxMs: 60000 });
  let state = { targetId: config.targetId, sessionId: config.sessionId, scheduleId: config.scheduleId,
    configRevision: 1, checks: [], incidents: [], signals: [], candidates: {}, probeFailures: 0,
    nextProbeAt: null, degraded: [], lastCheckAt: null };
  const store = { snapshot: () => structuredClone(state), async update(change) {
    const next = structuredClone(state); change(next); state = next;
  } };
  const sent = [];
  const runtime = createWatchdogRuntime({ config, store, now: () => at, client: {
    readFacts: async () => ({ targetId: config.targetId, facts: await readFacts(at) }),
    async sendSignal(signal) { sent.push(signal); return { accepted: true, id: signal.id }; },
  } });
  t.after(() => runtime.stop());
  return { store, sent, async check(time = at) {
    at = time;
    return runtime.check({ scheduleId: config.scheduleId, targetSessionId: config.sessionId,
      messageId: `message-${at}`, scheduledAt: iso(at), deliveredAt: iso(at) });
  } };
}

function facts(at, executions = []) {
  return { observedAt: iso(at), bootId: 'boot', cursor: 1, currentCursor: 1,
    executions, complete: true, truncated: false, schedulerHeartbeat: { at: iso(at) } };
}

test('a reachable follow-up closes the unreachable alert with a recovery message', async t => {
  const host = fixture(t, at => {
    if (at === epoch) throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' });
    return facts(at);
  });
  assert.equal((await host.check()).outcome, 'unreachable');
  assert.match(host.store.snapshot().signals[0].summary, /暂不可达/);
  assert.equal((await host.check(epoch + 60000)).outcome, 'observed');
  assert.equal(host.sent.length, 1, 'the pending old alert is superseded before delivery');
  assert.equal(host.sent[0].phase, 'resolved');
  assert.equal(host.sent[0].reasonCode, 'TARGET_UNREACHABLE');
  assert.match(host.sent[0].summary, /已恢复可达/);
  assert.doesNotMatch(host.sent[0].summary, /暂不可达|执行状态未知/);
});

test('legal waiting retires an execution alert without claiming worker recovery or task completion', async t => {
  const host = fixture(t, at => facts(at, [{
    task: { id: 'task', status: 'running', instructionRevision: 1 },
    assignment: { id: 'assignment', state: 'claimed', fence: 1, leaseUntil: at + 60000 },
    run: { id: 'run', sessionId: 'worker-session', state: 'running', instructionRevision: 1 },
    executionAlive: { status: 'running', observedAt: iso(at), bootId: 'boot' },
    request: { state: 'inflight', startedAt: iso(epoch - 60000), deadline: iso(epoch - 1000) },
    wait: { kind: at === epoch ? 'none' : 'user', since: null, expectedUntil: null },
    stop: { requestedAt: null, confirmedAt: null, confirmationOverdue: false },
    recovery: null,
    watermarks: [{ sessionId: 'worker-session', sourceSeq: 1, flushedSeq: 1, complete: true }],
  }]));
  assert.equal((await host.check()).outcome, 'fault');
  assert.equal(host.sent[0].reasonCode, 'REQUEST_DEADLINE_EXCEEDED');
  await host.check(epoch + 60000);
  const resolved = host.sent.find(row => row.phase === 'resolved');
  assert.ok(resolved);
  assert.match(resolved.summary, /已解除该次执行告警/);
  assert.doesNotMatch(resolved.summary, /已恢复|已完成|已超过其真实截止时间/);
  assert.equal(host.store.snapshot().incidents[0].active, false);
});
