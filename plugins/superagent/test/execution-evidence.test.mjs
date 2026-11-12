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

test('news evidence retains independent sources, publication and fetch times, including a failed site', () => {
  const events = [];
  for (const [id, url, isError, content] of [
    ['one', 'https://one.example/news', false, JSON.stringify({ url: 'https://one.example/news', source: 'One News', publishedAt: '2026-11-05T08:00:00Z' })],
    ['two', 'https://two.example/news', false, JSON.stringify({ url: 'https://two.example/news', published_at: '2026-11-05T09:00:00Z' })],
    ['failed', 'https://blocked.example/news', true, 'HTTP 403'],
  ]) {
    events.push({ seq: events.length, type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id, name: 'web_fetch', arguments: { url } }] } } });
    events.push({ seq: events.length, time: Date.parse('2026-11-05T10:00:00Z'), type: 'tool/result', data: { message: { toolCallId: id, isError, content: [{ type: 'text', text: content }] } } });
  }
  const evidence = executionEvidence({ events }).toolEvidence;
  assert.equal(evidence.failedCount, 1);
  assert.equal(evidence.entries.filter(row => !row.isError).length, 2);
  assert.deepEqual(evidence.entries[0].sources[0], { url: 'https://one.example/news', source: 'One News', publishedAt: '2026-11-05T08:00:00Z', fetchedAt: '2026-11-05T10:00:00.000Z', status: 'observed' });
  assert.equal(evidence.entries[2].sources[0].status, 'failed');
  assert.equal(evidence.entries[2].sources[0].publishedAt, null);
});

test('structured news sources retain explicit failures and relationships through duplicate URL matches', () => {
  const primary = 'https://wire.example/article', peer = 'https://paper.example/report', blocked = 'https://blocked.example/article';
  const payload = { sources: [
    { url: primary, source: 'Wire', publishedAt: '2026-11-05T08:00:00Z', relatedUrls: [peer], corroborates: [peer], relationship: { type: 'corroborates', url: peer } },
    { url: blocked, source: 'Blocked', failureReason: 'Access\u0000 denied', error: { message: 'HTTP 403\r\nForbidden', debug: 'private-debug' }, status: 'failed' },
    { url: primary, source: 'Later conflicting label', publishedAt: 'later', relatedUrls: [blocked, peer] },
    { url: peer },
  ] };
  const text = JSON.stringify(payload);
  const events = [
    { seq: 0, type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: 'news', name: 'news_search', arguments: { url: primary } }] } } },
    { seq: 1, time: Date.parse('2026-11-05T10:00:00Z'), type: 'tool/result', data: { message: { toolCallId: 'news', content: [{ type: 'text', text }] } } },
  ];
  const evidence = executionEvidence({ events }).toolEvidence;
  const [entry] = evidence.entries, sources = new Map(entry.sources.map(source => [source.url, source]));
  assert.equal(entry.text, text);
  assert.equal(entry.isError, false);
  assert.equal(sources.size, 3);
  assert.equal(sources.get(primary).source, 'Wire');
  assert.equal(sources.get(primary).publishedAt, payload.sources[0].publishedAt);
  assert.deepEqual(sources.get(primary).relatedUrls, [peer, blocked]);
  assert.deepEqual(sources.get(primary).corroborates, [peer]);
  assert.deepEqual(sources.get(primary).relationship, { type: 'corroborates', url: peer });
  assert.equal(sources.get(primary).status, 'observed');
  assert.equal(sources.get(blocked).status, 'failed');
  assert.equal(sources.get(blocked).failureReason, 'Access  denied');
  assert.equal(sources.get(blocked).error, 'HTTP 403  Forbidden');
  assert.doesNotMatch(JSON.stringify(entry.sources), /private-debug/);
  assert.equal(sources.get(peer).publishedAt, null);
  for (const key of ['failureReason', 'error', 'relatedUrls', 'corroborates', 'relationship']) assert.equal(sources.get(peer)[key], undefined);
});

test('structured fetch errors stay bounded and absent source facts remain unknown', () => {
  const url = 'https://blocked.example/news';
  const events = [
    { seq: 0, type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: 'fetch', name: 'web_fetch', arguments: { url } }] } } },
    { seq: 1, type: 'tool/result', data: { message: { toolCallId: 'fetch', isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { message: 'Denied\u0000' + 'x'.repeat(600), stack: 'private-stack' }, relationship: { type: 'x'.repeat(400), url: 'javascript:alert(1)' }, relatedUrls: ['javascript:alert(1)', 'file:///secret'], corroborates: false }) }] } } },
  ];
  const [source] = executionEvidence({ events }).toolEvidence.entries[0].sources;
  assert.equal(source.status, 'failed');
  assert.equal(source.error.length, 500);
  assert.doesNotMatch(source.error, /\u0000|private-stack/);
  assert.equal(source.failureReason, undefined);
  assert.equal(source.publishedAt, null);
  assert.equal(source.fetchedAt, null);
  assert.deepEqual(source.relationship, { type: 'x'.repeat(100) });
  assert.equal(source.relatedUrls, undefined);
  assert.equal(source.corroborates, undefined);
});

test('structured source metadata is merged at the existing sixteen-source limit', () => {
  const urls = Array.from({ length: 20 }, (_, index) => `https://source.example/${index}`);
  const events = [
    { seq: 0, type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: 'news', name: 'news_search', arguments: { sources: urls.slice(0, 16).map(url => ({ url })) } }] } } },
    { seq: 1, type: 'tool/result', data: { message: { toolCallId: 'news', content: [{ type: 'text', text: JSON.stringify({ sources: [{ url: urls[0], source: 'Explicit source', relatedUrls: urls, relationship: 'independent reporting' }, { url: urls[16] }] }) }] } } },
  ];
  const [entry] = executionEvidence({ events }).toolEvidence.entries;
  assert.equal(entry.sources.length, 16);
  assert.equal(entry.sources[0].source, 'Explicit source');
  assert.deepEqual(entry.sources[0].relatedUrls, urls.slice(0, 16));
  assert.equal(entry.sources[0].relationship, 'independent reporting');
  assert.equal(entry.sources.some(source => source.url === urls[16]), false);
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
  f.run.evidence.finalSummary = 'Original final';
  f.run.evidence.toolEvidence = { entries: [{ text: 'Original tool projection' }] };
  f.run.evidence.executionEffects = { effectsVerified: false, unknownCallIds: ['missing'] };
  f.run.evidence.transcript.hash = 'old-hash';
  f.events.push({ seq: 3, type: 'session/end-seed' });
  await withRecoveredEvidence(f, (saved, observation) => {
    assert.equal(saved.summary, 'Original draft');
    assert.equal(saved.finalSummary, 'Original final');
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
