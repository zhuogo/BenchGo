import test from 'node:test';
import assert from 'node:assert/strict';
import { streamTranscription } from '../src/asr.mjs';
import { normalizeTtsSpeed } from '../src/config.mjs';

test('every hundredth in the supported speed range survives floating point rounding', () => {
  for (let hundredths = 25; hundredths <= 400; hundredths++) {
    const speed = hundredths / 100;
    assert.equal(normalizeTtsSpeed(speed), speed);
  }
  for (const speed of [1.234, 0.249, 4.001, NaN, Infinity]) {
    assert.throws(() => normalizeTtsSpeed(speed), /Invalid TTS speed/u);
  }
});

test('ASR returns final transcript and cancels a connection that remains open', async () => {
  let cancelled = false;
  const partials = [];
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"transcript.text.delta","delta":"hello"}\n\ndata: {"type":"transcript.text.done","text":"hello world"}\n\n'));
    },
    cancel() { cancelled = true; },
  });
  const signal = AbortSignal.timeout(1000);
  const result = await streamTranscription(async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    { protocol: 'transcriptions-sse', baseURL: 'https://example.test/v1', model: 'opaque-model' }, new Uint8Array(), signal, text => partials.push(text));
  assert.deepEqual(result, { text: 'hello world' });
  assert.deepEqual(partials, ['hello', 'hello world']);
  assert.equal(cancelled, true);
  assert.equal(signal.aborted, false);
});

test('ASR ignores bytes after its final event', async () => {
  const body = 'data: {"type":"transcript.text.done","text":"final"}\n\ndata: broken\n\n';
  const result = await streamTranscription(async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    { protocol: 'transcriptions-sse', baseURL: 'https://example.test/v1', model: 'opaque-model' }, new Uint8Array(), new AbortController().signal, () => {});
  assert.deepEqual(result, { text: 'final' });
});
