import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { NoiseDenoiser, NoiseCapture, NoiseResampler } from '../client/noise-core.mjs';
import { createNoiseSuppressor } from '../client/noise.mjs';

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
