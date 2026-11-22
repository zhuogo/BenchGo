import test from 'node:test';
import assert from 'node:assert/strict';
import { requestSpeech } from '../../src/protocols/registry.mjs';
import { SPEECH_BYTES } from '../../src/protocols/shared/speech-stream.mjs';

const config = { baseURL: 'https://routergo.cn/api/v1', model: 'qwen3-tts-flash', voice: 'Chelsie', speed: 1.2, protocol: 'speech-wav' };
const pcm = Buffer.from([1, 0, 3, 0, 4, 0]);
const wav = Buffer.concat([Buffer.from('524946462a00000057415645666d74201000000001000100c05d000080bb0000020010006461746106000000', 'hex'), pcm]);
const response = bytes => new Response(bytes, { headers: { 'content-type': 'audio/wav' } });
const synthesize = (bytes, signal) => requestSpeech(async () => response(bytes), config, '你好', signal);

test('HTTP WAV streams aligned PCM before EOF, preserving model and voice with supplier speed', async () => {
  let source;
  const body = new ReadableStream({ start(controller) { source = controller; } });
  const result = await requestSpeech(async (url, { body: request }) => {
    assert.equal(url, 'https://routergo.cn/api/v1/audio/speech');
    assert.deepEqual(JSON.parse(request), { model: 'qwen3-tts-flash', voice: 'Chelsie', input: '你好', response_format: 'wav' });
    return response(body);
  }, config, '你好');
  assert.equal(result.headers.get('x-voice-format'), 'pcm_s16le');
  const reader = result.body.getReader();
  const first = reader.read();
  for (const byte of wav.subarray(0, 47)) source.enqueue(Uint8Array.of(byte));
  assert.deepEqual(Buffer.from((await first).value), pcm.subarray(0, 2));
  source.enqueue(wav.subarray(47, 48));
  assert.deepEqual(Buffer.from((await reader.read()).value), pcm.subarray(2, 4));
  source.enqueue(wav.subarray(48));
  source.close();
  assert.deepEqual(Buffer.from((await reader.read()).value), pcm.subarray(4));
  assert.equal((await reader.read()).done, true);
});

test('HTTP WAV accepts stream size sentinels and skips padded ancillary chunks', async () => {
  const streamed = Buffer.from(wav);
  streamed.writeUInt32LE(0xffffffff, 4);
  streamed.writeUInt32LE(0xffffffff, 40);
  assert.deepEqual(Buffer.from(await (await synthesize(streamed)).arrayBuffer()), pcm);

  const junk = Buffer.from('4a554e4b0300000001020300', 'hex');
  const withAncillary = Buffer.concat([wav.subarray(0, 36), junk, wav.subarray(36), junk]);
  withAncillary.writeUInt32LE(withAncillary.length - 8, 4);
  assert.deepEqual(Buffer.from(await (await synthesize(withAncillary)).arrayBuffer()), pcm);
});

test('HTTP WAV accepts paired RouterGo placeholders only at its official endpoint', async () => {
  const streamed = Buffer.from(wav);
  streamed.writeUInt32LE(0x7fffffff, 4);
  streamed.writeUInt32LE(0x7fffffff - 36, 40);
  assert.deepEqual(Buffer.from(await (await synthesize(streamed)).arrayBuffer()), pcm);
  const generic = await requestSpeech(async () => response(streamed), { ...config, baseURL: 'https://audio.example/v1' }, '你好');
  await assert.rejects(generic.arrayBuffer(), error => error.code === 'tts_wav_format');
  streamed.writeUInt32LE(0x7fffffff - 38, 40);
  await assert.rejects((await synthesize(streamed)).arrayBuffer(), error => error.code === 'tts_wav_format');
});

test('HTTP WAV detects wrong formats, conflicting lengths and truncated audio', async () => {
  const changed = (offset, value, size = 2) => {
    const bytes = Buffer.from(wav);
    bytes.writeUIntLE(value, offset, size);
    return bytes;
  };
  const malformed = [
    Buffer.from('not wav'), changed(20, 3), changed(22, 2), changed(24, 16000, 4), changed(28, 1, 4),
    changed(32, 4), changed(34, 8), changed(40, 0, 4), changed(40, 5, 4), changed(40, 8, 4),
    changed(4, 44, 4), changed(4, 40, 4), changed(4, 0x7fffffff, 4), wav.subarray(0, 43), wav.subarray(0, -2),
    Buffer.concat([wav, Buffer.of(0, 0)]),
  ];
  for (const bytes of malformed) {
    const result = await synthesize(bytes);
    await assert.rejects(result.arrayBuffer(), error => error.code === 'tts_wav_format');
  }
  const odd = Buffer.from(wav.subarray(0, -1));
  odd.writeUInt32LE(0xffffffff, 4);
  odd.writeUInt32LE(0xffffffff, 40);
  await assert.rejects((await synthesize(odd)).arrayBuffer(), error => error.code === 'tts_audio_empty');
  await assert.rejects((await synthesize(changed(4, SPEECH_BYTES, 4))).arrayBuffer(), error => error.code === 'tts_audio_limit');
  const oversized = Buffer.alloc(SPEECH_BYTES + 1);
  odd.copy(oversized);
  await assert.rejects((await synthesize(oversized)).arrayBuffer(), error => error.code === 'tts_audio_limit');
});

test('HTTP WAV propagates cancellation during a partial header and releases the body', async () => {
  const abort = new AbortController();
  let cancelled = false;
  const source = new ReadableStream({
    start(controller) { controller.enqueue(wav.subarray(0, 7)); },
    cancel() { cancelled = true; return new Promise(() => {}); },
  });
  const result = await synthesize(source, abort.signal);
  const reading = result.body.getReader().read();
  await new Promise(resolve => setImmediate(resolve));
  abort.abort();
  await assert.rejects(reading, { name: 'AbortError' });
  assert.equal(cancelled, true);
  assert.equal(source.locked, false);
});
