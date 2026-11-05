import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceController } from '../client/controller.mjs';

// Exercise the real AgentFeed -> chunker -> synthesis queue path. The provider
// deliberately never ends its response: first audio must not depend on EOF.
test('ASR final reaches first PCM before LLM completion or TTS EOF; barge-in aborts it', { timeout: 1500 }, async t => {
  const before = globalThis.document;
  globalThis.document = { baseURI: 'https://voice.test/' };
  t.after(() => { globalThis.document = before; });
  let snapshot = { revision: 0, entries: [], change: { kind: 'replace' } }, sequence = 0, capture;
  let status = { running: false, pendingInteraction: false }, firstAudio, synthSignal, cancelled = 0, cleared = 0;
  const heard = new Promise(resolve => { firstAudio = resolve; });
  const listeners = new Set(), sent = [], requests = [], audio = [];
  const source = { getSnapshot: () => snapshot, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); } };
  const publish = (type, data = {}) => {
    const entry = { type: 'event', event: { seq: ++sequence, type, data } };
    snapshot = { revision: sequence, entries: [...snapshot.entries, entry], change: { kind: 'append', entries: [entry] } };
    for (const fn of listeners) fn();
  };
  const conversation = {
    async send(text) {
      sent.push(text); status.running = true; publish('turn/start');
      publish('assistant/live-chunk', { attemptId: 'attempt', turn: 1, step: 1, chunk: { type: 'text-delta', text: '好的，我马上帮你检查。' } });
      // No final assistant message or turn/end yet.
    },
    async cancel() { cancelled++; status.running = false; },
  };
  const controller = createVoiceController({
    sessions: { binding: sessionId => ({ sessionId, eventSource: source }), scope: () => ({ get: () => conversation }) },
    uiSession: { sessionStatus: { getSnapshot: () => new Map([['session', status]]), subscribe: () => () => {} } },
  }, {
    window: { addEventListener() {}, removeEventListener() {} },
    json: async action => action === 'config' ? { config: { call: true, dictation: true, readAloud: false, asr: { protocol: 'transcriptions-sse', configured: true }, tts: { protocol: 'speech', configured: true } } } : action === 'call.start' ? { call: { callId: 'call' } } : {},
    createCapture: callbacks => { capture = callbacks; return { start: async () => {}, dispose: async () => {}, setPlaybackActive() {} }; },
    createPlayer: () => ({ start: async () => {}, enqueue: async (bytes, id) => { audio.push({ id, bytes: [...bytes] }); firstAudio(); }, segmentEnd() {}, clear() { cleared++; }, dispose: async () => {} }),
    fetch: async (_url, options) => {
      requests.push(JSON.parse(options.body)); synthSignal = options.signal;
      return new Response(new ReadableStream({ start(stream) { stream.enqueue(new Uint8Array([1, 0, 2, 0])); } }));
    },
  });
  t.after(() => controller.dispose());
  await controller.startCall({ sessionId: 'session' });
  capture.onSpeechStart(1); capture.onSpeechEnd(1); capture.onFinal('检查语音设置', { utteranceId: 1 });
  await heard;
  assert.deepEqual(sent, ['检查语音设置']);
  assert.deepEqual(requests, [{ text: '好的，我马上帮你检查。' }]);
  assert.deepEqual(audio[0].bytes, [1, 0, 2, 0]);
  assert.equal(status.running, true); assert.equal(synthSignal.aborted, false);
  const previousClears = cleared;
  capture.onSpeechStart(2);
  assert.ok(cleared > previousClears); assert.equal(synthSignal.aborted, true); assert.equal(cancelled, 1);
});
