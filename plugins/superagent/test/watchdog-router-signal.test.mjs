import test from 'node:test';
import assert from 'node:assert/strict';
import { watchdogRouterSignal, inspectWatchdogRouterSignal, watchdogNoticeCurrent } from '../src/watchdog-router-signal.mjs';
import { createMessageInbox } from '../src/message-inbox.mjs';

function fixture() {
  const ticket = { id: 'ticket', instructionRevision: 1, status: 'running', mandate: { source: { channel: 'desktop', sessionId: 'router', threadId: 'main' } } };
  const assignment = { id: 'assignment', ticketId: ticket.id, state: 'claimed', fence: 2, leaseUntil: 50 };
  const run = { id: 'run', sessionId: 'worker', fence: 2, instructionRevision: 1, state: 'running' };
  const database = { getTicket: id => id === ticket.id ? ticket : null, getAssignment: id => id === assignment.id ? assignment : null, runs: () => [run] };
  const observation = { id: 'signal', incidentKey: 'incident', phase: 'opened', kind: 'execution', targetId: 'host', checkId: 'check',
    observedAt: new Date(100).toISOString(), evidenceCursor: 10, reasonCode: 'LEASE_EXPIRED', summary: '疑似重复检查，尚无产出变化。',
    execution: { ticketId: ticket.id, assignmentId: assignment.id, runId: run.id, sessionId: run.sessionId, fence: 2, instructionRevision: 1 } };
  const facts = { ticket: { ...ticket }, assignment: { ...assignment }, run: { ...run }, evidenceCursor: 9,
    executionAlive: { status: 'running' }, wait: { kind: 'none' }, watermarks: [{ sessionId: 'worker', complete: true, sourceSeq: 5 }] };
  const snapshot = { currentCursor: 10, cursor: 10, observedAt: observation.observedAt, executions: [facts] };
  const principal = { kind: 'watchdog', targetId: 'host' };
  const signal = watchdogRouterSignal(database, observation, principal);
  return { ticket, assignment, run, database, observation, facts, snapshot, principal, signal,
    inspect: () => inspectWatchdogRouterSignal(database, signal, snapshot, { now: 100 }) };
}

test('authenticated observation preserves claimed execution and rejects wire-supplied authority', () => {
  const f = fixture(), original = JSON.stringify([f.ticket, f.assignment, f.run]);
  assert.equal(f.inspect().valid, true);
  assert.equal(JSON.stringify([f.ticket, f.assignment, f.run]), original);
  assert.throws(() => watchdogRouterSignal(f.database, f.observation, { kind: 'human', targetId: 'host' }), { code: 'WATCHDOG_PRINCIPAL_REQUIRED' });
  assert.throws(() => watchdogRouterSignal(f.database, { ...f.observation, principal: f.principal }, f.principal));
  assert.throws(() => watchdogRouterSignal(f.database, f.observation, { ...f.principal, actor: 'owner' }), { code: 'WATCHDOG_PRINCIPAL_REQUIRED' });
});

test('receiver rejects changed original execution identity and future watermarks', () => {
  for (const change of [f => f.assignment.fence++, f => f.run.sessionId = 'replacement', f => f.run.id = 'replacement',
    f => f.ticket.instructionRevision++, f => f.snapshot.currentCursor = 8]) {
    const f = fixture(); change(f); assert.equal(f.inspect().valid, false);
  }
});

test('legal waiting and unknown evidence never become a current no-progress alarm', () => {
  for (const kind of ['user', 'approval', 'paused', 'continuation', 'unknown']) {
    const f = fixture(); f.facts.wait.kind = kind; assert.equal(f.inspect().valid, false);
  }
  const f = fixture(); f.signal.observation.kind = 'execution'; f.signal.observation.reasonCode = 'EXECUTION_INACTIVE';
  assert.equal(f.inspect().valid, false);
  f.facts.executionAlive.status = 'absent'; assert.equal(f.inspect().valid, true);
});

test('host recovery binds a machine source and reports only the restored interface', () => {
  const f = fixture(), observation = { ...f.observation, kind: 'host', reasonCode: 'TARGET_UNREACHABLE', evidenceCursor: null };
  delete observation.execution;
  let signal = watchdogRouterSignal(f.database, observation, f.principal);
  assert.deepEqual(signal.source, { channel: 'watchdog', targetId: 'host', threadId: 'main' });
  assert.equal(inspectWatchdogRouterSignal(f.database, signal, f.snapshot).valid, false);
  signal = watchdogRouterSignal(f.database, { ...observation, phase: 'resolved' }, f.principal);
  assert.deepEqual(inspectWatchdogRouterSignal(f.database, signal, f.snapshot).facts,
    { interfaceReachable: true, observedAt: f.snapshot.observedAt });
});

test('same inbox persists phases once, retires queued old alarms and lets users go first', async () => {
  const f = fixture(); let state = { requests: [] }, queue = Promise.resolve();
  const sent = [], agent = { id: 'router', status: 'running', followup(message) { sent.push(message); agent.status = 'running'; } };
  const inbox = createMessageInbox({ getState: async () => structuredClone(state),
    updateState: change => { const operation = queue.then(() => { state = { ...state, ...change(state) }; }); queue = operation; return operation; },
    ensureSession: async () => agent, getAgent: () => agent, readSession: async () => ({ events: [] }) });
  await inbox.enqueueTicketReply({ threadId: 'main', signal: f.signal });
  await inbox.enqueueTicketReply({ threadId: 'main', signal: f.signal });
  const alias = watchdogRouterSignal(f.database, { ...f.observation, id: 'alias' }, f.principal);
  await inbox.enqueueTicketReply({ threadId: 'main', signal: alias });
  assert.equal(state.requests[0].watchdogReceipts[0].id, 'alias');
  await assert.rejects(inbox.enqueueTicketReply({ threadId: 'main', signal: watchdogRouterSignal(f.database,
    { ...f.observation, id: 'alias', incidentKey: 'changed' }, f.principal) }), /标识冲突/);
  queue = queue.catch(() => {});
  const resolved = watchdogRouterSignal(f.database, { ...f.observation, id: 'resolved', phase: 'resolved' }, f.principal);
  await inbox.enqueueTicketReply({ threadId: 'main', signal: resolved });
  assert.equal(state.requests.length, 2); assert.equal(state.requests[0].suppressed, true);
  assert.equal(watchdogNoticeCurrent(f.signal, state.requests), false);
  await inbox.enqueue({ text: '继续回答我的问题', requestId: 'human' });
  agent.status = 'idle'; await inbox.drain('main');
  assert.equal(sent[0].source.kind, 'user');
  assert.equal((await inbox.state('main')).length, 1, 'machine notices never impersonate the human queue');
  await inbox.dispose();
});

test('rejected recovery evidence cannot retire the accepted original observation', () => {
  const f = fixture(), resolved = watchdogRouterSignal(f.database, { ...f.observation, phase: 'resolved' }, f.principal);
  assert.equal(watchdogNoticeCurrent(f.signal, [{ ticketReply: resolved, suppressed: true }]), true);
});
