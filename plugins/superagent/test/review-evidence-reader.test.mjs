import test from 'node:test';
import assert from 'node:assert/strict';
import { executionEvidence } from '../src/execution-evidence.mjs';
import { createReviewEvidenceReader } from '../src/review-evidence-reader.mjs';

function fixture(count = 1) {
  const events = Array.from({ length: count }, (_, i) => [
    { seq: i * 2, type: 'assistant/message', data: { message: { content: [
      { type: 'reasoning', text: 'PRIVATE' },
      { type: 'tool-call', id: `call-${i}`, name: 'web/read', arguments: 'a'.repeat(800) },
    ] } } },
    { seq: i * 2 + 1, type: 'tool/result', data: { message: { toolCallId: `call-${i}`, content: [
      { type: 'reasoning', text: 'PRIVATE' }, { type: 'image', data: 'BINARY' },
      { type: 'text', text: 'x'.repeat(9000) + 'SOURCE_AT_END' },
    ] } } },
  ]).flat();
  const log = { session: { id: 'session' }, events };
  const result = { sessionId: 'session', ...executionEvidence(log) };
  let reads = 0;
  const ctx = { sessionQuery: { readSession: async id => {
    assert.equal(id, 'session'); reads++; return log;
  } } };
  return { log, result, ctx, reads: () => reads };
}

test('verified reader retrieves evidence beyond the bounded projection without private blocks', async () => {
  const f = fixture(), reader = createReviewEvidenceReader(f);
  assert.equal(f.result.toolEvidence.entries[0].text.includes('SOURCE_AT_END'), false);
  const index = await reader.index();
  assert.equal(index.entries[0].arguments.length, 500);
  const first = await reader({ seq: 1, limit: 8000 });
  const last = await reader({ seq: 1, offset: first.nextOffset });
  assert.equal(first.text + last.text, 'x'.repeat(9000) + 'SOURCE_AT_END');
  assert.equal(last.nextOffset, null);
  assert.doesNotMatch(JSON.stringify({ index, first, last }), /PRIVATE|BINARY/);
  assert.equal(f.reads(), 1);
});

test('reader rejects changed transcripts, summaries and session headers', async () => {
  for (const mutate of [
    f => { f.log.events[1].data.message.content.push({ type: 'text', text: 'tampered' }); },
    f => { f.result.summary = 'forged'; },
    f => { f.result.transcript.lastSeq++; },
    f => { f.log.session.id = 'another-session'; },
  ]) {
    const f = fixture(); mutate(f);
    await assert.rejects(createReviewEvidenceReader(f).index(), /does not match/);
  }
});

test('reader rejects non-result sequences and invalid pagination', async () => {
  const reader = createReviewEvidenceReader(fixture());
  for (const input of [{ seq: 0 }, { seq: 99 }, { seq: 1, offset: 10000 },
    { seq: 1, offset: -1 }, { seq: 1, offset: 1.5 }, { seq: 1, limit: 8001 }, { seq: 1, limit: 0 }])
    await assert.rejects(reader(input));
});

test('index remains bounded while omitted results remain readable by real sequence', async () => {
  const reader = createReviewEvidenceReader(fixture(260));
  const index = await reader.index();
  assert.equal(index.entries.length, 256);
  assert.equal(index.total, 260);
  assert.equal(index.omitted, 4);
  assert.equal(index.entries[0].seq, 9);
  assert.equal(index.entries.at(-1).seq, 519);
  assert.equal((await reader({ seq: 1, offset: 9000 })).text, 'SOURCE_AT_END');
  assert.equal((await reader({ seq: 519, offset: 9000 })).text, 'SOURCE_AT_END');
});

test('tool arguments remain bounded on every page and report their original length', async () => {
  const f = fixture();
  f.log.events[0].data.message.content[1].arguments = 'a'.repeat(50000);
  Object.assign(f.result, executionEvidence(f.log));
  const reader = createReviewEvidenceReader(f);
  for (const offset of [0, 8000]) {
    const page = await reader({ seq: 1, offset, limit: 8000 });
    assert.equal(page.arguments.length, 2000);
    assert.equal(page.argumentsLength, 50000);
    assert.equal(page.argumentsTruncated, true);
    assert.ok(page.text.length <= 8000);
  }
  const normal = await createReviewEvidenceReader(fixture())({ seq: 1 });
  assert.equal(normal.argumentsLength, 800);
  assert.equal(normal.argumentsTruncated, false);
});
