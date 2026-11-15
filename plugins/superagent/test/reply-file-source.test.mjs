import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveReplyFileSource } from '../src/reply-file-source.mjs';

function fixture() {
  const source = { kind: 'benchgo-task-reply', replyKind: 'result', taskId: 'task', eventKey: 'delivery-old' };
  const signal = { kind: 'result', taskId: 'task', eventKey: 'delivery-old', resultVersion: 1, instructionRevision: 1 };
  const execution = { deviceId: 'old-device', hostId: 'old-host', authorizationId: 'old-authorization' };
  const remote = { ...execution, runId: 'old-run', sessionId: 'old-session', executionId: 'old-execution' };
  const result = { version: 1, instructionRevision: 1, deliveryKey: 'delivery-old', runId: 'old-run', sessionId: 'old-session' };
  const assignment = { id: 'old-assignment', executor: 'remote', execution };
  const run = { id: 'old-run', sessionId: 'old-session' };
  const state = { requests: [{ messageId: 'request', threadId: 'main', sessionId: 'router', taskReply: signal, message: { source } }] };
  const database = {
    getTask: id => id === 'task' ? { id, ownerHostId: 'owner', resultVersion: 2, mandate: { execution: { deviceId: 'new-device' } } } : null,
    results: () => [result, { version: 2, instructionRevision: 2, deliveryKey: 'delivery-new', runId: 'new-run', sessionId: 'new-session' }],
    assignments: () => [assignment], runs: () => [run], remoteExecution: () => remote,
    resultNotification: () => { throw new Error('Historical file lookup must not use current notification selection'); },
  };
  return { input: { database, state, threadId: 'main', sessionId: 'router', requestId: 'request', requestSource: source }, database, state, source, signal, result, assignment, run, remote };
}

test('a historical completion keeps its original execution after the task changes device', () => {
  const f = fixture(), value = resolveReplyFileSource(f.input);
  assert.deepEqual(value, { remote: true, available: true, taskId: 'task', ownerHostId: 'owner', assignmentId: 'old-assignment',
    runId: 'old-run', deviceId: 'old-device', hostId: 'old-host', authorizationId: 'old-authorization', sessionId: 'old-session', executionId: 'old-execution' });
});

test('the original official source resolves an old request after receipt cleanup', () => {
  const f = fixture(); f.state.requests = [];
  assert.equal(resolveReplyFileSource(f.input).deviceId, 'old-device');
});

test('a retained request signal works before its public reply is confirmed', () => {
  const f = fixture(); delete f.input.requestSource;
  assert.equal(resolveReplyFileSource(f.input).sessionId, 'old-session');
});

test('ordinary human replies are local, including admitted question replies', () => {
  for (const kind of ['user', 'user-question-reply']) {
    const f = fixture(); f.state.requests = []; f.input.requestSource = { kind };
    assert.deepEqual(resolveReplyFileSource(f.input), { remote: false });
  }
});

test('known local worker results retain local navigation', () => {
  const f = fixture(); f.database.remoteExecution = () => null; f.assignment.executor = 'harness'; delete f.assignment.execution;
  assert.deepEqual(resolveReplyFileSource(f.input), { remote: false });
});

test('unknown and conflicting request origins fail closed', () => {
  for (const change of [f => { f.state.requests = []; delete f.input.requestSource; },
    f => { f.input.requestSource = { kind: 'runtime-context' }; },
    f => { f.input.requestSource = { kind: 'user' }; },
    f => { f.source.taskId = 'other-task'; },
    f => { f.state.requests[0].sessionId = 'other-router'; },
    f => { f.state.requests[0].threadId = 'other-thread'; }]) {
    const f = fixture(); change(f);
    assert.throws(() => resolveReplyFileSource(f.input), { code: 'REPLY_FILE_SOURCE_UNAVAILABLE' });
  }
});

test('result version, execution, and saved reply identity must all match', () => {
  for (const change of [f => { f.signal.resultVersion = 2; }, f => { f.signal.instructionRevision = 2; },
    f => { f.result.runId = 'missing'; }, f => { f.result.sessionId = 'other-session'; },
    f => { f.result.reply = { sessionId: 'router', requestId: 'different-request' }; },
    f => { f.remote.runId = 'new-run'; }, f => { f.remote.sessionId = 'new-session'; }]) {
    const f = fixture(); change(f);
    assert.throws(() => resolveReplyFileSource(f.input), { code: 'REPLY_FILE_SOURCE_UNAVAILABLE' });
  }
});

test('remote executions never fall back to a local same-named path when identity is incomplete', () => {
  for (const key of ['deviceId', 'hostId', 'authorizationId', 'executionId']) {
    const f = fixture(); delete f.remote[key];
    assert.throws(() => resolveReplyFileSource(f.input), { code: 'REPLY_FILE_SOURCE_UNAVAILABLE' });
  }
  const f = fixture(); f.database.remoteExecution = () => null;
  assert.throws(() => resolveReplyFileSource(f.input), { code: 'REPLY_FILE_SOURCE_UNAVAILABLE' });
  delete f.assignment.executor; delete f.assignment.execution;
  assert.throws(() => resolveReplyFileSource(f.input), { code: 'REPLY_FILE_SOURCE_UNAVAILABLE' });
});

test('duplicate delivery keys or execution bindings are rejected', () => {
  for (const change of [f => { f.database.results = () => [f.result, { ...f.result }]; },
    f => { f.database.runs = () => [f.run, { ...f.run }]; }]) {
    const f = fixture(); change(f);
    assert.throws(() => resolveReplyFileSource(f.input), { code: 'REPLY_FILE_SOURCE_UNAVAILABLE' });
  }
});
