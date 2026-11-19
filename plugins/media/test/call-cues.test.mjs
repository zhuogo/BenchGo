import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceController } from '../client/controller.mjs';
import { createCallPresentation } from '../client/call-presentation.mjs';
import { playCallCue } from '../client/call-cues.mjs';

globalThis.document ||= { baseURI: 'https://voice.example/' };
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function harness(options = {}) {
  const cues = [], calls = [], protections = [], environment = new EventTarget(), pending = deferred();
  let capture, playback, capturesDisposed = 0, playersDisposed = 0, released = 0, config;
  config = { call: true, dictation: true, readAloud: true, asr: { configured: true, protocol: 'transcriptions-sse' }, tts: { configured: true, protocol: 'speech' }, listening: { enabled: !!options.listening } };
  const source = { getSnapshot: () => ({ revision: 0, entries: [], change: { kind: 'replace' } }), subscribe: () => () => {} };
  const ctx = { uiSession: { sessionStatus: { getSnapshot: () => new Map(), subscribe: () => () => {} } }, sessions: {
    binding: sessionId => ({ sessionId, eventSource: source }), retain: () => ({ ready: Promise.resolve(), release() { released++; } }), scope: () => ({ get: () => ({ send: async () => {}, cancel: async () => {} }) }),
  } };
  const api = createVoiceController(ctx, {
    window: environment, setInterval: () => 1, clearInterval() {},
    json: async (action, args) => { calls.push(action); if (action === 'config') return { config }; if (action === 'configure') { config = { ...config, ...args.config }; return { config }; } if (action === 'call.start') { await options.lease?.(); return { call: { callId: 'lease' } }; } return {}; },
    createPlayer: callbacks => { playback = callbacks; return { context: { name: 'player' }, start: async () => { await options.player?.(); }, dispose: async () => { playersDisposed++; } }; },
    createCapture: callbacks => { capture = callbacks; return { start: async () => { await options.capture?.(); }, dispose: async () => { capturesDisposed++; }, setPlaybackActive: value => protections.push(value) }; },
    createChunker: () => ({ push: text => [text], finish: () => [] }),
    playCallCue: (kind, args) => { cues.push({ kind, args }); if (options.cueError) throw Error('output unavailable'); return { finished: kind === 'connected' ? pending.promise : new Promise(() => {}), cancel: pending.resolve }; },
  });
  return { api, cues, calls, protections, pending, environment, get capture() { return capture; }, get playback() { return playback; }, counts: () => ({ capturesDisposed, playersDisposed, released }) };
}

test('connection cue waits for lease, output and capture readiness, then protects input once', async () => {
  const lease = deferred(), output = deferred(), capture = deferred();
  const h = harness({ lease: () => lease.promise, player: () => output.promise, capture: () => capture.promise, listening: true });
  const start = h.api.startCall({ sessionId: 's' }); await tick(); assert.deepEqual(h.cues, []);
  lease.resolve(); await tick(); assert.deepEqual(h.cues, []);
  output.resolve(); await tick(); assert.deepEqual(h.cues, []);
  capture.resolve(); await start;
  assert.deepEqual(h.cues.map(row => row.kind), ['connected']); assert.equal(h.cues[0].args.context.name, 'player');
  h.capture.onSpeechStart(1); h.capture.onPartial('cue echo', { utteranceId: 1 }); h.capture.onFinal('cue echo', { utteranceId: 1 });
  assert.equal(h.api.state.getSnapshot().transcript, ''); assert.equal(h.api.state.getSnapshot().turnPending, false);
  assert.equal(h.api.state.getSnapshot().recoveryText, ''); assert.equal(h.calls.includes('listening.decide'), false);
  h.playback.onPlaybackIdle(); assert.equal(h.protections.at(-1), true);
  h.playback.onPlaybackStart(); h.pending.resolve(); await tick(); assert.equal(h.protections.at(-1), true);
  h.playback.onPlaybackIdle(); assert.equal(h.protections.at(-1), false);
  h.capture.onSpeechStart(2); h.capture.onFinal('real input', { utteranceId: 2 });
  await h.api.dispose(); assert.deepEqual(h.cues.map(row => row.kind), ['connected']);
});

test('active UI hangup plays once without awaiting cue or holding media and lease', async () => {
  const h = harness(); await h.api.startCall({ sessionId: 's' });
  const view = createCallPresentation(h.api); await Promise.all([view.hangup(), h.api.hangup()]);
  assert.deepEqual(h.cues.map(row => row.kind), ['connected', 'disconnected']);
  assert.equal(h.cues[1].args, undefined); assert.deepEqual(h.counts(), { capturesDisposed: 1, playersDisposed: 1, released: 1 });
  assert.equal(h.calls.filter(action => action === 'call.end').length, 1);
  await h.api.hangup(); await h.api.dispose(); view.dispose(); assert.equal(h.cues.length, 2);
});

test('failed and cancelled starts never play either success cue, including late media readiness', async () => {
  for (const stage of ['lease', 'player', 'capture']) {
    const fail = harness({ [stage]: async () => { throw Error('failed'); } });
    await assert.rejects(fail.api.startCall({ sessionId: 's' }), /failed/); assert.deepEqual(fail.cues, []); await fail.api.dispose();
    const gate = deferred(), h = harness({ [stage]: () => gate.promise });
    const start = h.api.startCall({ sessionId: 's' }); await tick(); await h.api.hangup(); gate.resolve(); await start;
    assert.deepEqual(h.cues, []); assert.equal(h.api.state.getSnapshot().mode, 'idle'); await h.api.dispose();
  }
});

test('passive cleanup and dictation are silent; missing cue devices never fail a call', async () => {
  for (const cause of ['offline', 'pagehide', 'dispose', 'configure', 'capture-error']) {
    const h = harness(); await h.api.startCall({ sessionId: 's' });
    if (cause === 'dispose') await h.api.dispose();
    else if (cause === 'configure') await h.api.configure({ call: false });
    else if (cause === 'capture-error') h.capture.onError(Error('microphone removed'));
    else h.environment.dispatchEvent(new Event(cause));
    await tick(); await h.api.dispose(); assert.deepEqual(h.cues.map(row => row.kind), ['connected'], cause);
  }
  const h = harness({ cueError: true }); await h.api.startCall({ sessionId: 's' });
  assert.equal(h.api.state.getSnapshot().mode, 'call'); assert.equal(h.api.state.getSnapshot().error, '');
  await h.api.hangup(); await h.api.dispose();
  const dictation = harness(); await dictation.api.startDictation({ sessionId: 's', inputActions: { captureInsertion: () => ({ start: 0, end: 0 }) } });
  await dictation.api.hangup(); await dictation.api.dispose(); assert.deepEqual(dictation.cues, []);
});

test('unavailable Web Audio silently skips cues', () => {
  assert.equal(playCallCue('connected'), null);
  assert.equal(playCallCue('connected', { context: { state: 'closed' } }), null);
  assert.equal(playCallCue('connected', { context: { state: 'suspended' } }), null);
});

test('autoplay refusal and partial oscillator setup release owned contexts and nodes', async () => {
  let closed = 0, disconnected = 0;
  const original = globalThis.AudioContext;
  try {
    globalThis.AudioContext = class { state = 'suspended'; resume() { return Promise.reject(Error('autoplay denied')); } close() { closed++; this.state = 'closed'; } };
    await playCallCue('disconnected').finished; assert.equal(closed, 1);
    globalThis.AudioContext = class {
      state = 'running'; currentTime = 0; close() { closed++; this.state = 'closed'; }
      createOscillator() { return { frequency: { setValueAtTime() { throw Error('device gone'); } }, stop() { throw Error('not started'); }, disconnect() { disconnected++; } }; }
      createGain() { return { disconnect() { disconnected++; } }; }
    };
    await playCallCue('disconnected').finished; assert.equal(closed, 2); assert.equal(disconnected, 2);
  } finally { if (original) globalThis.AudioContext = original; else delete globalThis.AudioContext; }
});
