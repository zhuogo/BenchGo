import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VoiceConfig, publicConfig, updateConfig } from '../src/config.mjs';
import { voiceAvailability } from '../src/availability.mjs';
import { createVoiceHandlers } from '../src/web.mjs';

const speech = () => new Request('http://app.test/api/voice/speech', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '立即朗读。' }),
});
const memory = (stream = true) => ({
  value: { readAloud: true, dictation: false, call: false,
    asr: {}, tts: { baseURL: 'https://tts.test/v1', model: 'Opaque TTS:09', protocol: 'speech-stream', voice: 'Custom Voice', speed: 1.35, stream } },
  snapshot() { return publicConfig(this.value); },
  async configure(patch) { this.value = updateConfig(this.value, patch); return this.snapshot(); },
});

test('explicit streaming protocol persists through partial save and reload without changing other choices', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'voice-speech-stream-'));
  try {
    const store = await new VoiceConfig({ dataDir: directory }).open();
    await store.configure({ readAloud: true, dictation: true, call: true,
      asr: { baseURL: 'https://asr.test/v1', apiKey: 'keep-asr-key', model: 'Opaque ASR:07', protocol: 'transcriptions-sse' },
      tts: { providerId: 'shared-provider', model: 'Opaque TTS:09', protocol: 'speech', voice: 'Custom Voice', speed: 1.35, stream: false } });
    const previous = structuredClone(store.value);
    await store.configure({ tts: { protocol: 'speech-stream' } });
    const reopened = await new VoiceConfig({ dataDir: directory }).open();
    assert.deepEqual(reopened.value, { ...previous, tts: { ...previous.tts, protocol: 'speech-stream' } });
    const providers = { resolve: async () => ({ baseURL: 'https://shared.test/v1', apiKey: 'server-only-key' }) };
    assert.deepEqual((await voiceAvailability(reopened, providers)).available, { voiceInput: true, readAloud: true, realtimeVoice: true });
    const h = createVoiceHandlers(reopened, { providers, fetcher: async (url, options) => {
      assert.equal(url, 'https://shared.test/v1/audio/speech');
      assert.equal(options.headers.authorization, 'Bearer server-only-key');
      assert.deepEqual(JSON.parse(options.body), { model: 'Opaque TTS:09', voice: 'Custom Voice', input: '立即朗读。', response_format: 'pcm', speed: 1.35, stream: true });
      return new Response(new Uint8Array([1, 0]), { headers: { 'content-type': 'audio/pcm' } });
    } });
    try { assert.equal((await (await h.speech(speech())).arrayBuffer()).byteLength, 2); }
    finally { h.dispose(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('speech-stream forwards the first PCM before upstream EOF and cancels the open stream', { timeout: 1000 }, async () => {
  let cancelled = false, signal;
  const h = createVoiceHandlers(memory(), { fetcher: async (_url, options) => {
    signal = options.signal;
    assert.equal(JSON.parse(options.body).stream, true);
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array([1, 0])); },
      cancel() { cancelled = true; },
    }), { headers: { 'content-type': 'audio/pcm' } });
  } });
  try {
    const response = await h.speech(speech());
    assert.equal(response.status, 200); assert.equal(response.headers.get('x-accel-buffering'), 'no');
    const reader = response.body.getReader();
    assert.deepEqual(await reader.read(), { value: new Uint8Array([1, 0]), done: false });
    assert.equal(signal.aborted, false);
    await reader.cancel();
    assert.equal(signal.aborted, true); assert.equal(cancelled, true);
  } finally { h.dispose(); }
});

test('local buffered playback still requests streaming synthesis and waits only for its segment EOF', { timeout: 1000 }, async () => {
  let source, entered;
  const started = new Promise(resolve => entered = resolve);
  const h = createVoiceHandlers(memory(false), { fetcher: async (_url, options) => {
    assert.equal(JSON.parse(options.body).stream, true);
    return new Response(new ReadableStream({ start(controller) { source = controller; controller.enqueue(new Uint8Array([1, 0])); entered(); } }));
  } });
  try {
    let returned = false;
    const pending = h.speech(speech()).then(response => { returned = true; return response; });
    await started; await new Promise(resolve => setImmediate(resolve));
    assert.equal(returned, false);
    source.enqueue(new Uint8Array([2, 0])); source.close();
    assert.deepEqual(new Uint8Array(await (await pending).arrayBuffer()), new Uint8Array([1, 0, 2, 0]));
  } finally { h.dispose(); }
});

test('unsupported provider streaming fails once without retrying a different protocol', async () => {
  const store = memory(); let requests = 0;
  const h = createVoiceHandlers(store, { fetcher: async (_url, options) => {
    requests++; assert.equal(JSON.parse(options.body).stream, true);
    return Response.json({ error: { code: 'unsupported_parameter', message: 'private supplier details' } }, { status: 400 });
  } });
  try {
    const response = await h.speech(speech());
    assert.equal(response.status, 502); assert.equal(requests, 1);
    const body = await response.json(); assert.equal(body.code, 'unsupported_parameter');
    assert.match(body.error, /TTS.*400/u); assert.equal(JSON.stringify(body).includes('private supplier details'), false);
    assert.equal(store.value.tts.protocol, 'speech-stream');
  } finally { h.dispose(); }
});
