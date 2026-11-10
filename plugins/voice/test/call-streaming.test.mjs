import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceHandlers } from '../src/web.mjs';
import { voiceAvailability } from '../src/availability.mjs';
import { publicConfig } from '../src/config.mjs';

const request = input => new Request('https://voice.test/api/voice', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
function memory() {
  return { value: { dictation: true, readAloud: true, call: true,
    asr: { baseURL: 'https://provider.test/v1', model: 'Exact ASR', protocol: 'transcriptions-sse' },
    tts: { baseURL: 'https://provider.test/v1', model: 'Exact TTS', protocol: 'speech', stream: true } },
    snapshot() { return publicConfig(this.value); } };
}

for (const blocked of ['asr', 'tts']) {
  test(`call discovery, start and existing lease reject non-streaming ${blocked} without changing independent capabilities`, async () => {
    const store = memory(); let upstream = 0;
    const handlers = createVoiceHandlers(store, { fetcher: async () => { upstream++; throw Error('unexpected upstream'); } });
    try {
      const ready = await handlers.config(request({ action: 'call.start', sessionId: 'session', deviceId: 'device' }));
      assert.equal(ready.status, 200);
      const { call } = await ready.json();
      if (blocked === 'asr') store.value.asr.protocol = 'transcriptions'; else store.value.tts.stream = false;
      const expected = structuredClone(store.value);
      const availability = await voiceAvailability(store);
      assert.deepEqual(availability.available, { voiceInput: true, readAloud: true, realtimeVoice: false });
      assert.match(availability.reasons.realtimeVoice, blocked === 'asr' ? /SSE/ : /开启流式播放/);
      const start = await handlers.config(request({ action: 'call.start', sessionId: 'next', deviceId: 'next' }));
      assert.equal(start.status, 409); assert.match((await start.json()).error, blocked === 'asr' ? /SSE/ : /开启流式播放/);
      const audio = await handlers.speech(new Request('https://voice.test/api/voice/speech', { method: 'POST', headers: { 'content-type': 'application/json', 'x-voice-call-id': call.callId }, body: JSON.stringify({ text: 'Reply' }) }));
      assert.equal(audio.status, 409); assert.equal(upstream, 0); assert.deepEqual(store.value, expected);
    } finally { handlers.dispose(); }
  });
}

test('both explicit streaming ASR transports support standard PCM and extended streaming synthesis', async () => {
  const store = memory();
  for (const asr of ['transcriptions-sse', 'openai-websocket']) for (const tts of ['speech', 'speech-stream']) {
    store.value.asr.protocol = asr; store.value.tts.protocol = tts;
    assert.equal((await voiceAvailability(store)).available.realtimeVoice, true);
  }
});
