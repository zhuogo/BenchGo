import test from 'node:test';
import assert from 'node:assert/strict';
import { executionEvidence, withRecoveredEvidence } from '../src/execution-evidence.mjs';

test('host projection binds actual tool calls and results without reasoning or binary data', () => {
  const events = [
    { seq: 1, type: 'assistant/message', data: { message: { content: [
      { type: 'reasoning', text: 'private reasoning' },
      { type: 'tool-call', id: 'read-1', name: 'opaque/read', arguments: '{"path":"result.txt"}' },
    ] } } },
    { seq: 2, type: 'tool/result', data: { message: { toolCallId: 'read-1', content: [
      { type: 'text', text: 'VERIFIED_391' }, { type: 'image', data: 'binary-secret' },
    ] } } },
  ];
  const evidence = executionEvidence({ events });
  assert.equal(evidence.toolEvidence.entries[0].name, 'opaque/read');
  assert.equal(evidence.toolEvidence.entries[0].text, 'VERIFIED_391');
  assert.equal(evidence.toolEvidence.entries[0].seq, 2);
  assert.equal(evidence.toolEvidence.truncated, false);
  assert.doesNotMatch(JSON.stringify(evidence), /private reasoning|binary-secret/);
});

test('large evidence stays bounded and reports omissions including omitted failures', () => {
  const events = Array.from({ length: 100 }, (_, seq) => ({ seq, type: 'tool/result', data: {
    message: { toolCallId: String(seq), isError: seq === 0, content: [{ type: 'text', text: 'x'.repeat(10000) }] },
  } }));
  const { toolEvidence } = executionEvidence({ events });
  assert.ok(JSON.stringify(toolEvidence).length < 24500);
  assert.equal(toolEvidence.total, 100);
  assert.ok(toolEvidence.omitted > 0);
  assert.equal(toolEvidence.failedCount, 1);
  assert.equal(toolEvidence.truncated, true);
  assert.equal(toolEvidence.entries.at(-1).seq, 99);
});

test('current deliverable is the final assistant text while complete draft history remains verifiable', () => {
  const events = ['draft with 14 items', 'corrected digest with 8 items'].map((text, seq) => ({ seq, type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } }));
  events.push({ seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: 'verify', name: 'check', arguments: '{}' }] } } });
  const evidence = executionEvidence({ events });
  assert.equal(evidence.finalSummary, 'corrected digest with 8 items');
  assert.match(evidence.summary, /draft with 14 items/);
});

function fixture() {
  const events = [
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Evidence' }] } } },
    { seq: 2, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ];
  const run = { id: 'run', sessionId: 'session', evidence: { runId: 'run', sessionId: 'session', ...executionEvidence({ events }) } };
  let closed = 0, locked = false;
  const ctx = { agents: { get: () => undefined }, sessionPersistence: { open: async (id, access) => {
    assert.equal(access, 'write'); assert.equal(locked, false); locked = true;
    return { id, access, read: async () => ({ events }), close: async () => { closed++; locked = false; } };
  } } };
  return { events, run, ctx, signal: new AbortController().signal, closed: () => closed, locked: () => locked };
}

test('recovery holds the official exclusive handle through verification and always releases it', async () => {
  const f = fixture();
  await withRecoveredEvidence(f, async (evidence, observation) => {
    assert.equal(f.locked(), true); assert.equal(evidence.summary, 'Evidence');
    assert.equal(observation.completed, true); assert.equal(observation.hash, f.run.evidence.transcript.hash);
  });
  assert.equal(f.closed(), 1);
  await assert.rejects(withRecoveredEvidence(f, () => { throw new Error('review failed'); }), /review failed/);
  assert.equal(f.closed(), 2);
});

test('a retained project directory alone is insufficient recovery evidence', async () => {
  const f = fixture();
  f.run.environment = { path: '/retained', branch: 'task', baseCommit: 'base' };
  await assert.rejects(withRecoveredEvidence(f, () => assert.fail('unverified artifacts must not be accepted')), /verified artifact checkpoint/);
  assert.equal(f.closed(), 1);
});

test('legacy results gain verified evidence on read-only retry and forged projections are rejected', async () => {
  const f = fixture();
  delete f.run.evidence.toolEvidence;
  await withRecoveredEvidence(f, saved => assert.deepEqual(saved.toolEvidence.entries, []));
  f.run.evidence.toolEvidence = { entries: [{ text: 'forged success' }] };
  await assert.rejects(withRecoveredEvidence(f, () => assert.fail('forged projection')), /tool evidence does not match/);
  assert.equal(f.closed(), 2);
});

test('recovery derives legacy final text and rejects a forged current deliverable', async () => {
  const f = fixture();
  delete f.run.evidence.finalSummary;
  await withRecoveredEvidence(f, saved => assert.equal(saved.finalSummary, 'Evidence'));
  f.run.evidence.finalSummary = 'forged final result';
  await assert.rejects(withRecoveredEvidence(f, () => assert.fail('forged deliverable')), /final result does not match/);
});

test('live writers, changed transcripts and incomplete endings never authorize recovery', async () => {
  const f = fixture(); let called = false;
  const action = () => { called = true; };
  f.ctx.agents.get = () => ({});
  await assert.rejects(withRecoveredEvidence(f, action), /still live/);
  assert.equal(f.closed(), 0);
  f.ctx.agents.get = () => undefined;
  f.events.push({ seq: 3, type: 'user/message', data: { content: 'new instruction' } });
  await assert.rejects(withRecoveredEvidence(f, action), /does not match/);
  f.run.evidence = { ...f.run.evidence, ...executionEvidence({ events: f.events }) };
  await assert.rejects(withRecoveredEvidence(f, action), /normal ending/);
  assert.equal(called, false);
  assert.equal(f.closed(), 2);
});

test('recovery derives legacy effects from the log and rejects forged effect safety', async () => {
  const f = fixture();
  await withRecoveredEvidence(f, saved => assert.deepEqual(saved.executionEffects, { effectsVerified: true, unknownCallIds: [] }));
  f.run.evidence.executionEffects = { effectsVerified: false, unknownCallIds: ['invented'] };
  await assert.rejects(withRecoveredEvidence(f, () => assert.fail('forged effects')), /execution effects do not match/);
  assert.equal(f.closed(), 2);
});
