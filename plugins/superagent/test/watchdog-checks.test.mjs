import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectWatchdogFacts } from '../src/watchdog-checks.mjs';

const epoch = Date.parse('2026-11-09T00:00:00.000Z');
const config = { observationWindowMs: 120_000, intervalSeconds: 60, escalationAttempts: 3 };
const iso = value => new Date(value).toISOString();
function runtime(now = epoch) {
  return {
    ticket: { id: 'ticket', status: 'open', instructionRevision: 1 },
    assignment: { id: 'assignment', state: 'claimed', owner: 'owner', fence: 1, leaseUntil: now + 60000 },
    run: { id: 'run', sessionId: 'session', state: 'running', instructionRevision: 1 },
    executionAlive: { status: 'running', observedAt: iso(now), bootId: 'boot-1' },
    request: { state: 'settled', startedAt: iso(now - 1000), settledAt: iso(now), deadline: null },
    wait: { kind: 'none', since: null, expectedUntil: null },
    stop: { requestedAt: null, confirmedAt: null, confirmationOverdue: false },
    recovery: null,
    watermarks: [{ sessionId: 'session', sourceSeq: 20, flushedSeq: 20, complete: true }],
  };
}
function snapshot(now = epoch, row = runtime(now)) {
  return { cursor: 20, currentCursor: 20, observedAt: iso(now), bootId: 'boot-1',
    complete: true, truncated: false, schedulerHeartbeat: { at: iso(now) }, executions: row ? [row] : [] };
}
function inspect(facts, now = epoch, previous = {}) {
  return inspectWatchdogFacts({ facts, now, previous, config });
}
const codes = result => result.findings.map(row => row.reasonCode).sort();
function observeTwice(change) {
  const first = snapshot(); change(first.executions[0], epoch);
  const a = inspect(first);
  const last = snapshot(epoch + 120000); change(last.executions[0], epoch + 120000);
  return { first: a, last: inspect(last, epoch + 120000, a.candidates), lastFacts: last };
}

test('fresh execution facts report unknown deadlines without inventing faults or model progress', () => {
  const facts = snapshot(); facts.executions[0].toolCalls = 999; facts.executions[0].output = 'secret';
  const value = inspect(facts);
  assert.equal(value.complete, true);
  assert.deepEqual(value.findings, []);
  assert(value.coverage.unknown.some(row => row.field === 'requestDeadline'));
  assert(!JSON.stringify(value).includes('secret'));
  assert(!JSON.stringify(value).includes('toolCalls'));
});

test('mechanical conditions expose true false and null independently of the observation window', () => {
  const facts = snapshot(), row = facts.executions[0];
  row.executionAlive.status = 'absent';
  row.request = { state: 'inflight', startedAt: iso(epoch - 1000), deadline: null };
  const value = inspect(facts);
  assert.deepEqual(value.findings, [], 'true is a predicate, not a completed observation window');
  const condition = reasonCode => value.conditions.find(item => item.reasonCode === reasonCode);
  assert.equal(condition('EXECUTION_INACTIVE').condition, true);
  assert.equal(condition('LEASE_EXPIRED').condition, false);
  assert.equal(condition('REQUEST_DEADLINE_EXCEEDED').condition, null);
  assert.equal(condition('EXECUTION_INACTIVE').execution.runId, 'run');
  for (const alter of [
    input => { input.bootId = null; },
    input => { input.observedAt = null; },
  ]) {
    const input = structuredClone(facts); alter(input);
    assert(inspect(input).conditions.every(item => item.condition === null));
  }
  const stale = snapshot(epoch - 120001);
  assert(inspect(stale).conditions.filter(item => item.execution).every(item => item.condition === null));
  const invalid = snapshot(); invalid.executions[0].run.instructionRevision = 2;
  assert(!inspect(invalid).conditions.some(item => item.execution), 'unverified identity produces no false execution predicate');
});

test('stale facts and independently stale scheduler heartbeat are distinct', () => {
  const old = snapshot(epoch - 120001);
  assert.deepEqual(codes(inspect(old)), ['FACTS_STALE']);
  const facts = snapshot(); facts.schedulerHeartbeat.at = iso(epoch - 120001);
  assert.deepEqual(codes(inspect(facts)), ['SCHEDULER_STALLED']);
  facts.schedulerHeartbeat = null;
  const unknown = inspect(facts);
  assert.deepEqual(unknown.findings, []);
  assert.equal(unknown.coverage.schedulerHeartbeat, 'unknown');
});

test('Worker absence and unhandled expired lease require separate continuous observation windows', () => {
  const absent = observeTwice(row => { row.executionAlive.status = 'absent'; });
  assert.deepEqual(absent.first.findings, []);
  assert.deepEqual(codes(absent.last), ['EXECUTION_INACTIVE']);
  assert.equal(absent.last.findings[0].observations, 2);
  const expired = observeTwice(row => { row.assignment.leaseUntil = epoch - 1; });
  assert.deepEqual(expired.first.findings, []);
  assert.deepEqual(codes(expired.last), ['LEASE_EXPIRED']);
  assert.equal(expired.lastFacts.executions[0].executionAlive.status, 'running');
  const handled = structuredClone(expired.lastFacts); handled.executions[0].assignment.state = 'uncertain';
  const value = inspect(handled, epoch + 120000, expired.last.candidates);
  assert.deepEqual(value.findings, []);
  assert.equal(value.resolvedKeys.length, 1);
});

test('idle and frequent tool activity never prove Worker death or substantive progress', () => {
  for (const status of ['idle', 'running']) {
    const value = observeTwice(row => { row.executionAlive.status = status; row.toolCalls = 100000; });
    assert.deepEqual(value.last.findings, []);
  }
  for (const state of ['prepared', 'verifying']) {
    const value = observeTwice(row => { row.run.state = state; row.executionAlive.status = 'absent'; });
    assert.deepEqual(value.last.findings, []);
  }
});

test('only actual inflight deadlines and overdue unconfirmed stop requests are immediate faults', () => {
  const facts = snapshot(), row = facts.executions[0];
  row.request = { state: 'inflight', startedAt: iso(epoch - 5000), deadline: iso(epoch - 1), settledAt: null };
  row.stop = { requestedAt: iso(epoch - 31000), confirmedAt: null, confirmationOverdue: true };
  const value = inspect(facts);
  assert.deepEqual(codes(value), ['REQUEST_DEADLINE_EXCEEDED', 'STOP_UNCONFIRMED']);
  row.request.deadline = null;
  row.stop.confirmedAt = iso(epoch);
  const unknown = inspect(facts, epoch, value.candidates);
  assert.deepEqual(unknown.findings, []);
  assert.equal(unknown.resolvedKeys.length, 1, 'unknown deadline does not resolve the previous request fault');
  assert(Object.values(unknown.candidates).some(candidate => candidate.reasonCode === 'REQUEST_DEADLINE_EXCEEDED'));
  row.request.state = 'settled';
  assert.equal(inspect(facts, epoch, unknown.candidates).resolvedKeys.length, 1);
});

test('a preceding stop acknowledgement cannot confirm a newer stop request', () => {
  const facts = snapshot();
  facts.executions[0].stop = { requestedAt: iso(epoch - 31000), confirmedAt: iso(epoch - 40000), confirmationOverdue: true };
  assert.deepEqual(codes(inspect(facts)), ['STOP_UNCONFIRMED']);
  facts.executions[0].stop.requestedAt = iso(epoch + 1);
  assert.deepEqual(inspect(facts).findings, []);
});

test('user, approval, paused and bounded asynchronous waits are exempt', () => {
  for (const kind of ['user', 'approval', 'paused', 'background-job', 'long-operation', 'continuation']) {
    const value = observeTwice((row, now) => {
      row.executionAlive.status = 'absent'; row.assignment.leaseUntil = epoch - 1;
      row.request = { state: 'inflight', deadline: iso(epoch - 1) };
      row.wait = { kind, expectedUntil: iso(now + 60000) };
      row.recovery = { reasonCode: 'session-interrupted', attempts: 9, automatic: true,
        escalated: true, nextCheckAt: iso(now + 60000) };
    });
    assert.deepEqual(value.last.findings, [], kind);
  }
});

test('unknown and unbounded waits do not infer a hang or clear a previous fault', () => {
  const previous = observeTwice(row => { row.executionAlive.status = 'absent'; }).last;
  for (const kind of ['unknown', 'background-job', 'long-operation', 'continuation']) {
    const facts = snapshot(epoch + 180000), row = facts.executions[0];
    row.wait = { kind, expectedUntil: null }; row.executionAlive.status = 'absent';
    const value = inspect(facts, epoch + 180000, previous.candidates);
    assert.deepEqual(value.findings, []);
    assert.deepEqual(value.resolvedKeys, []);
    assert.equal(Object.values(value.candidates)[0].interrupted, true);
  }
});

test('repeated recovery needs the attempt threshold and a continuous window', () => {
  const pending = observeTwice(row => {
    row.assignment.state = 'uncertain';
    row.recovery = { reasonCode: 'session-interrupted', attempts: 3, automatic: true, escalated: false };
  });
  assert.deepEqual(pending.first.findings, []);
  assert.deepEqual(codes(pending.last), ['RECOVERY_NOT_CONVERGING']);
  const underLimit = observeTwice(row => {
    row.recovery = { reasonCode: 'session-interrupted', attempts: 2, automatic: true, escalated: false };
  });
  assert.deepEqual(underLimit.last.findings, []);
  const noAutomaticWork = observeTwice(row => {
    row.recovery = { reasonCode: 'session-interrupted', attempts: 9, automatic: false, escalated: false };
  });
  assert.deepEqual(noAutomaticWork.last.findings, []);
});

test('paused and terminal executions retire prior faults without requesting recovery', () => {
  const old = observeTwice(row => { row.executionAlive.status = 'absent'; }).last;
  for (const status of ['paused', 'completed', 'cancelled']) {
    const facts = snapshot(epoch + 180000); facts.executions[0].ticket.status = status;
    facts.executions[0].stop = { requestedAt: iso(epoch), confirmationOverdue: true, confirmedAt: null };
    const value = inspect(facts, epoch + 180000, old.candidates);
    assert.deepEqual(value.findings, []);
    assert.equal(value.resolvedKeys.length, 1);
  }
});

test('unknown, missing and stale execution facts preserve incidents without repeating an asserted finding', () => {
  const old = observeTwice(row => { row.executionAlive.status = 'absent'; }).last;
  for (const alter of [
    facts => { facts.executions = []; facts.complete = false; facts.truncated = true; },
    facts => { facts.executions[0].executionAlive.status = 'unknown'; },
    facts => { facts.executions[0].executionAlive.observedAt = iso(epoch - 1); },
    facts => { delete facts.executions[0].assignment.state; },
    facts => { delete facts.executions[0].run.state; },
    facts => { facts.bootId = null; },
  ]) {
    const facts = snapshot(epoch + 180000); alter(facts);
    const value = inspect(facts, epoch + 180000, old.candidates);
    assert.deepEqual(value.findings, []);
    assert.deepEqual(value.resolvedKeys, []);
    assert.equal(Object.keys(value.candidates).length, 1);
  }
});

test('a changed recovery reason begins a new observation window without resolving the prior incident', () => {
  const old = observeTwice(row => {
    row.recovery = { reasonCode: 'session-interrupted', attempts: 3, automatic: true, escalated: false };
  }).last;
  const facts = snapshot(epoch + 180000);
  facts.executions[0].recovery = { reasonCode: 'external-effects-unknown', attempts: 3, automatic: true, escalated: false };
  const value = inspect(facts, epoch + 180000, old.candidates);
  assert.deepEqual(value.findings, []);
  assert.deepEqual(value.resolvedKeys, []);
  assert.equal(Object.values(value.candidates)[0].observations, 1);
});

test('replay, clock rollback, host restart and observation gaps do not complete a stale window', () => {
  const firstFacts = snapshot(); firstFacts.executions[0].executionAlive.status = 'absent';
  const first = inspect(firstFacts);
  const replay = inspect(firstFacts, epoch + 120000, first.candidates);
  assert.deepEqual(replay.findings, []);
  assert.equal(Object.values(replay.candidates)[0].observations, 1);
  for (const [at, bootId] of [[epoch - 1, 'boot-1'], [epoch + 120000, 'boot-2'], [epoch + 180000, 'boot-1']]) {
    const facts = snapshot(at); facts.bootId = bootId;
    Object.assign(facts.executions[0].executionAlive, { status: 'absent', bootId });
    const value = inspect(facts, at, first.candidates);
    assert.deepEqual(value.findings, []);
    assert.equal(Object.values(value.candidates)[0].observations, 1);
  }
});

test('unknown observations interrupt rather than advance a later positive window', () => {
  const firstFacts = snapshot(); firstFacts.executions[0].executionAlive.status = 'absent';
  const first = inspect(firstFacts);
  const middleFacts = snapshot(epoch + 60000); middleFacts.executions[0].executionAlive.status = 'unknown';
  const middle = inspect(middleFacts, epoch + 60000, first.candidates);
  const endFacts = snapshot(epoch + 120000); endFacts.executions[0].executionAlive.status = 'absent';
  const end = inspect(endFacts, epoch + 120000, middle.candidates);
  assert.deepEqual(end.findings, []);
  assert.equal(Object.values(end.candidates)[0].firstObservedAt, iso(epoch + 120000));
});

test('fence replacements close the old identity and start a separate observation window', () => {
  const old = observeTwice(row => { row.executionAlive.status = 'absent'; }).last;
  const facts = snapshot(epoch + 180000), row = facts.executions[0];
  row.assignment.fence = 2; row.executionAlive.status = 'absent';
  const value = inspect(facts, epoch + 180000, old.candidates);
  assert.deepEqual(value.findings, []);
  assert.equal(value.resolvedKeys.length, 1);
  assert.equal(Object.values(value.candidates)[0].execution.fence, 2);
});

test('unverified identities, future timestamps and source gaps remain explicitly incomplete', () => {
  for (const alter of [
    facts => { facts.executions[0].run.instructionRevision = 2; },
    facts => { facts.observedAt = iso(epoch + 1); },
    facts => { facts.executions[0].watermarks[0].complete = false; },
    facts => { facts.bootId = ''; },
  ]) {
    const facts = snapshot(); alter(facts);
    const value = inspect(facts);
    assert.equal(value.complete, false);
    assert.deepEqual(value.findings, []);
    assert(value.coverage.unknown.length > 0);
  }
});

test('previous candidate payloads and ignored input cannot leak arbitrary strings or mutate callers', () => {
  const old = observeTwice(row => { row.executionAlive.status = 'absent'; }).last;
  const previous = structuredClone(old.candidates), key = Object.keys(previous)[0];
  previous[key].summary = 'password secret'; previous[key].execution.token = 'token-secret';
  previous.untrusted = { reasonCode: 'invented', output: 'private-output' };
  const input = snapshot(epoch + 180000); input.executions[0].executionAlive.status = 'unknown';
  const before = structuredClone({ input, previous });
  const value = inspect(input, epoch + 180000, previous);
  assert.deepEqual({ input, previous }, before);
  assert(!JSON.stringify(value).includes('secret'));
  assert(!JSON.stringify(value).includes('private-output'));
  assert.equal(Object.keys(value.candidates).length, 1);
});

test('invalid observation configuration fails explicitly', () => {
  for (const patch of [{ observationWindowMs: 0 }, { escalationAttempts: 0 }, { intervalSeconds: -1 }]) {
    assert.throws(() => inspectWatchdogFacts({ facts: snapshot(), now: epoch, config: { ...config, ...patch } }), /configuration/);
  }
});
