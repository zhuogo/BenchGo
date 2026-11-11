import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { gunzipSync } from 'node:zlib';
import { NoiseDenoiser, NoiseCapture, NoiseResampler } from '../client/noise-core.mjs';
import { createNoiseSuppressor } from '../client/noise.mjs';
import { Capture } from '../client/media.mjs';

const require = createRequire(new URL('../../benchgo/package.json', import.meta.url));
const sync = await readFile(require.resolve('@jitsi/rnnoise-wasm/dist/rnnoise-sync.js'), 'utf8');
const bytes = Buffer.from(/base64,([A-Za-z0-9+/=]+)/u.exec(sync)[1], 'base64');
const module = await WebAssembly.compile(bytes);

test('pinned RNNoise 0.2 binary suppresses sustained noise and returns model VAD', () => {
  assert.equal(createHash('sha256').update(bytes).digest('hex'), '4f513a50613de74378331237886138eab52fa2650e8b1a41eb587d932d9b8850');
  const denoiser = new NoiseDenoiser(module); let seed = 17, inputEnergy = 0, outputEnergy = 0, probability = 0;
  for (let n = 0; n < 150; n++) {
    const frame = new Float32Array(480);
    for (let i = 0; i < frame.length; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; frame[i] = (seed / 4294967296 * 2 - 1) * .03; if (n > 20) inputEnergy += frame[i] ** 2; }
    const p = denoiser.process(frame); assert.ok(p >= 0 && p <= 1);
    if (n > 20) { probability += p; for (const sample of frame) outputEnergy += sample ** 2; }
  }
  assert.ok(10 * Math.log10(inputEnergy / outputEnergy) > 25, 'stationary noise must be attenuated, not simply tagged');
  assert.ok(probability / 129 < .1, 'sustained white noise must not be classified as continuous speech');
  denoiser.destroy(); denoiser.destroy(); assert.throws(() => denoiser.process(new Float32Array(480)), /active/);
});

test('capture emits aligned 24 kHz PCM/probability across device rates and isolates mute epochs', () => {
  for (const rate of [44100, 48000, 96000]) {
    const packets = [], capture = new NoiseCapture(module, rate, packet => packets.push(packet));
    for (let i = 0; i < rate; i++) capture.accept(0);
    assert.ok(packets.length >= 48 && packets.length <= 50);
    for (const packet of packets) { assert.equal(packet.data.byteLength, 960); assert.equal(packet.epoch, 0); assert.equal(packet.probability, 0); assert.equal(new Int16Array(packet.data).some(Boolean), false); }
    capture.setMuted(true, 7); const count = packets.length;
    for (let i = 0; i < 4000; i++) capture.accept(.2);
    assert.equal(packets.length, count);
    capture.setMuted(false, 8); packets.length = 0;
    for (let i = 0; i < rate / 10; i++) capture.accept(0);
    assert.ok(packets.length > 0); assert.ok(packets.every(packet => packet.epoch === 8 && packet.probability === 0 && !new Int16Array(packet.data).some(Boolean)));
    capture.destroy(); capture.destroy();
  }
});

test('a quiet short 你好 survives real RNNoise syllable valleys and reaches final ASR', async () => {
  // Offline synthetic fixture: Windows System.Speech Huihui Desktop, zh-CN,
  // rate 6, “你好”, PCM16/48 kHz mono. No microphone recording or network call.
  const wav = gunzipSync(await readFile(new URL('./fixtures/nihao-huihui-rate6.wav.gz', import.meta.url)));
  const requests = [], finals = [], starts = [], ends = [];
  let capturedMs = 0, lastVoiceMs = 0;
  const capture = new Capture({ transcribe: async blob => { requests.push(blob); return '你好'; },
    onSpeechStart: id => starts.push(id), onSpeechEnd: () => ends.push(capturedMs), onFinal: text => finals.push(text) });
  let continuous = 0, maxContinuous = 0, voiced = 0;
  const noise = new NoiseCapture(module, 48000, packet => {
    const pcm = new Int16Array(packet.data);
    const rms = Math.sqrt(pcm.reduce((sum, sample) => sum + (sample / 32768) ** 2, 0) / pcm.length);
    capturedMs += 20; if (packet.probability >= .35 && rms > .002) lastVoiceMs = capturedMs;
    if (packet.probability >= .6 && rms > .002) { continuous += 20; voiced += 20; maxContinuous = Math.max(maxContinuous, continuous); }
    else continuous = 0;
    capture.accept(pcm, packet.probability);
  });
  try {
    for (let offset = 44; offset < wav.length; offset += 2) noise.accept(wav.readInt16LE(offset) / 32768 * .08);
    for (let i = 0; i < 48000; i++) noise.accept(0);
    await capture.pending;
    assert.equal(maxContinuous, 80, 'neither syllable alone reaches the former 100 ms continuous attack');
    assert.equal(voiced, 160, 'the phrase still has sufficient confidently voiced audio');
    assert.deepEqual(starts, [1]); assert.equal(requests.length, 1); assert.deepEqual(finals, ['你好']);
    assert.equal(lastVoiceMs, 300); assert.deepEqual(ends, [620], 'commit exactly 320 ms after the last voiced frame');
    assert.ok(requests[0].size > 44, 'submit the real denoised PCM, not a fabricated transcript');
  } finally { noise.destroy(); await capture.dispose(); }
});

test('real RNNoise background tails remain bounded by the 320 ms speech endpoint', async () => {
  const wav = gunzipSync(await readFile(new URL('./fixtures/nihao-huihui-rate6.wav.gz', import.meta.url)));
  for (const amplitude of [.003, .03]) {
    let capturedMs = 0, lastVoiceMs = 0, seed = 17;
    const ends = [], finals = [];
    const capture = new Capture({ transcribe: async () => '你好', onSpeechEnd: () => ends.push(capturedMs), onFinal: text => finals.push(text) });
    const noise = new NoiseCapture(module, 48000, packet => {
      const pcm = new Int16Array(packet.data);
      const rms = Math.sqrt(pcm.reduce((sum, sample) => sum + (sample / 32768) ** 2, 0) / pcm.length);
      capturedMs += 20; if (packet.probability >= .35 && rms > .002) lastVoiceMs = capturedMs;
      capture.accept(pcm, packet.probability);
    });
    try {
      for (let offset = 44; offset < wav.length; offset += 2) noise.accept(wav.readInt16LE(offset) / 32768 * .08);
      for (let i = 0; i < 48000; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; noise.accept((seed / 4294967296 * 2 - 1) * amplitude); }
      await capture.pending;
      assert.deepEqual(ends, [lastVoiceMs + 320]); assert.ok(ends[0] <= 900);
      assert.deepEqual(finals, ['你好']); assert.equal(capture.segment, null);
    } finally { noise.destroy(); await capture.dispose(); }
  }
});

test('soft short speech reaches ASR despite RNNoise output attenuation', async () => {
  const wav = gunzipSync(await readFile(new URL('./fixtures/nihao-huihui-rate6.wav.gz', import.meta.url)));
  for (const amplitude of [.02, .03]) {
    const requests = [], finals = [], starts = [];
    const capture = new Capture({ transcribe: async blob => { requests.push(blob); return '你好'; },
      onSpeechStart: id => starts.push(id), onFinal: text => finals.push(text) });
    const noise = new NoiseCapture(module, 48000, packet => capture.accept(new Int16Array(packet.data), packet.probability));
    try {
      for (let offset = 44; offset < wav.length; offset += 2) noise.accept(wav.readInt16LE(offset) / 32768 * amplitude);
      for (let i = 0; i < 48000; i++) noise.accept(0);
      await capture.pending;
      assert.deepEqual(starts, [1]); assert.deepEqual(finals, ['你好']); assert.equal(requests.length, 1);
      assert.ok(requests[0].size > 44); assert.equal((requests[0].size - 44) / 48, 1000);
      const samples = new Int16Array((await requests[0].arrayBuffer()).slice(44));
      assert.ok(samples.some(sample => sample !== 0), 'forward real denoised samples, never silence padding or a fabricated transcript');
    } finally { noise.destroy(); await capture.dispose(); }
  }
});

test('streaming downsampler rejects out-of-band audio without resetting frame phase', () => {
  function measure(hz) {
    const resampler = new NoiseResampler(48000, 24000), values = [];
    for (let i = 0; i < 48000; i++) resampler.push(Math.sin(i * Math.PI * 2 * hz / 48000), value => values.push(value));
    return Math.sqrt(values.slice(500).reduce((sum, value) => sum + value * value, 0) / (values.length - 500));
  }
  assert.ok(measure(18000) < measure(1000) * .05);
});

function mockNode(t, kind = 'ready') {
  const nodes = [];
  class Node extends EventTarget {
    constructor(context, name, options) {
      super(); this.port = new EventTarget(); this.messages = []; this.disconnects = 0;
      this.port.start = () => {}; this.port.close = () => {}; this.port.postMessage = message => this.messages.push(message);
      this.disconnect = () => this.disconnects++;
      nodes.push(this); assert.equal(name, 'voice-noise-capture'); assert.ok(options.processorOptions.module instanceof WebAssembly.Module);
      if (kind) queueMicrotask(() => this.port.dispatchEvent(new MessageEvent('message', { data: { type: kind } })));
    }
  }
  t.mock.method(globalThis, 'fetch', async (_url, options) => { assert.equal(options.credentials, 'same-origin'); return new Response(bytes); });
  const old = globalThis.AudioWorkletNode; globalThis.AudioWorkletNode = Node;
  t.after(() => { if (old) globalThis.AudioWorkletNode = old; else delete globalThis.AudioWorkletNode; });
  return nodes;
}

test('noise helper waits for ready, preserves PCM consumer and disposes once', async t => {
  const nodes = mockNode(t), modules = [];
  const result = await createNoiseSuppressor({ audioWorklet: { addModule: async url => modules.push(url) } });
  assert.equal(result.node, nodes[0]); assert.deepEqual(modules, ['api/voice/noise-worklet']);
  let received = 0; result.node.port.addEventListener('message', () => received++);
  result.node.port.dispatchEvent(new MessageEvent('message', { data: { type: 'pcm' } })); assert.equal(received, 1);
  result.dispose(); result.dispose(); assert.deepEqual(result.node.messages, [{ type: 'destroy' }]); assert.equal(result.node.disconnects, 1);
});

test('noise initialization failure and cancellation close nodes instead of bypassing processing', async t => {
  const nodes = mockNode(t, 'error');
  await assert.rejects(createNoiseSuppressor({ audioWorklet: { addModule: async () => {} } }), /初始化失败/);
  assert.equal(nodes[0].disconnects, 1); assert.deepEqual(nodes[0].messages, [{ type: 'destroy' }]);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(createNoiseSuppressor({}, { signal: abort.signal }), { name: 'AbortError' });
  assert.equal(nodes.length, 1);
});

test('cancelling while the worklet is initializing releases its node', async t => {
  const nodes = mockNode(t, null), abort = new AbortController();
  const pending = createNoiseSuppressor({ audioWorklet: { addModule: async () => {} } }, { signal: abort.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  while (!nodes.length) await new Promise(resolve => setImmediate(resolve));
  abort.abort(); await rejected;
  assert.equal(nodes[0].disconnects, 1); assert.deepEqual(nodes[0].messages, [{ type: 'destroy' }]);
});

test('cancelling an unresolved worklet module does not wait for it or create a late node', async t => {
  const nodes=mockNode(t),abort=new AbortController();let finish,entered;
  const called=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>finish=resolve);
  const pending=createNoiseSuppressor({audioWorklet:{addModule:()=>{entered();return gate;}}},{signal:abort.signal});
  const rejected=assert.rejects(pending,{name:'AbortError'});await called;abort.abort();await rejected;
  finish();await new Promise(resolve=>setImmediate(resolve));assert.equal(nodes.length,0);
});
