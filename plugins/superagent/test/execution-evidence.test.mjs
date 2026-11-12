import test from 'node:test';
import assert from 'node:assert/strict';
import { executionEvidence, withRecoveredEvidence } from '../src/execution-evidence.mjs';

test('the result is the last assistant text; drafts, reasoning and tool data stay in the official session', () => {
  const events = ['draft with 14 items', 'corrected digest with 8 items'].map((text, seq) => ({ seq, type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'private reasoning' }, { type: 'text', text }] } } }));
  events.push({ seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: 'verify', name: 'check', arguments: '{}' }] } } });
  events.push({ seq: 3, type: 'tool/result', data: { message: { toolCallId: 'verify', content: [{ type: 'text', text: 'VERIFIED_391' }, { type: 'image', data: 'binary-secret' }] } } });
  const evidence = executionEvidence({ events });
  assert.deepEqual(Object.keys(evidence).sort(), ['summary', 'transcript']);
  assert.equal(evidence.summary, 'corrected digest with 8 items');
  assert.equal(evidence.transcript.lastSeq, 3);
  assert.doesNotMatch(JSON.stringify(evidence), /draft with 14 items|private reasoning|VERIFIED_391|binary-secret/);
  assert.equal(executionEvidence({ events: [] }).summary, '');
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

test('normal recovery preserves raw text despite identity and projection diagnostics', async () => {
  const f = fixture();
  f.run.directory = '/artifacts';
  f.run.evidence.directory = '/old-directory';
  f.run.evidence.summary = 'Original draft';
  f.run.evidence.executionEffects = { effectsVerified: false, unknownCallIds: ['missing'] };
  f.run.evidence.transcript.hash = 'old-hash';
  f.events.push({ seq: 3, type: 'session/end-seed' });
  await withRecoveredEvidence(f, (saved, observation) => {
    assert.equal(saved.summary, 'Original draft');
    assert.equal(saved.completion.kind, 'completed');
    assert.equal(observation.completed, true);
    assert.deepEqual(saved.executionEffects, f.run.evidence.executionEffects);
    assert.deepEqual(saved.recoveryObservation.diagnostics, ['TRANSCRIPT_CHANGED']);
  });
  assert.equal(f.closed(), 1);
});

test('partial interrupted text is retained without inventing a successful completion', async () => {
  const f = fixture();
  f.events.push({ seq: 3, type: 'turn/start' }, { seq: 4, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'partial' }] } } });
  await withRecoveredEvidence(f, (saved, observation) => {
    assert.equal(saved.summary, 'Evidence');
    assert.equal(saved.completion, undefined);
    assert.equal(observation.completed, false);
  });
});

test('a live busy writer is never mistaken for a completed execution', async () => {
  const f = fixture();
  f.ctx.agents.get = () => ({ status: 'running' });
  await assert.rejects(withRecoveredEvidence(f, () => assert.fail('busy')), /still live/);
  assert.equal(f.closed(), 0);
});

test('idle official sessions are read without opening or disposing another writer', async () => {
  const f = fixture(); let flushed = 0;
  const agent = { status: 'idle', session: { id: 'session', snapshotEvents: () => f.events } };
  f.ctx.agents.get = () => agent;
  f.ctx.sessions = { flush: async () => { flushed++; } };
  await withRecoveredEvidence(f, saved => assert.equal(saved.completion.kind, 'completed'));
  assert.equal(flushed, 1); assert.equal(f.closed(), 0);
  f.ctx.sessions.flush = async () => { agent.status = 'running'; };
  await assert.rejects(withRecoveredEvidence(f, () => assert.fail('busy')), /still live/);
});
