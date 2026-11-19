import test from 'node:test';
import assert from 'node:assert/strict';
import { readVoiceEvents } from '../client/asr.mjs';

test('browser transcription completes on final without waiting for HTTP close', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"type":"partial","text":"hello"}\n{"type":"final","text":"hello world"}\ninvalid trailing data\n'));
    },
    cancel() { cancelled = true; },
  });
  const events = [];
  await readVoiceEvents(new Response(body), AbortSignal.timeout(1000), event => events.push(event));
  assert.deepEqual(events.map(event => event.text), ['hello', 'hello world']);
  assert.equal(cancelled, true);
});

test('browser transcription propagates cancellation while waiting for input', async () => {
  const abort = new AbortController();
  const reading = readVoiceEvents(new Response(new ReadableStream()), abort.signal, () => {});
  abort.abort();
  await assert.rejects(reading, { name: 'AbortError' });
});

test('final delivery does not wait for an uncooperative stream cancellation', async () => {
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"type":"final","text":"ready"}\n')); },
    cancel() { return new Promise(() => {}); },
  });
  await readVoiceEvents(new Response(body), new AbortController().signal, () => {});
});
