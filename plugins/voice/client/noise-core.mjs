// ABI for the RNNoise 0.2 synchronous binary in @jitsi/rnnoise-wasm 0.2.1.
// The package's separate dist/rnnoise.wasm still contains the older 0.1 model.
export class NoiseDenoiser {
  constructor(module) {
    let exports;
    const instance = new WebAssembly.Instance(module, { a: {
      b: (dest, src, size) => { new Uint8Array(exports.c.buffer).copyWithin(dest, src, src + size); },
      a: size => {
        try { const memory = exports.c; memory.grow(Math.max(0, Math.ceil((size - memory.buffer.byteLength) / 65536))); return 1; }
        catch { return 0; }
      },
    } });
    exports = instance.exports;
    if (!(exports.c instanceof WebAssembly.Memory) || !['d', 'e', 'f', 'h', 'i', 'j'].every(key => typeof exports[key] === 'function')) throw Error('Unsupported RNNoise binary');
    this.exports = { memory: exports.c, malloc: exports.e, free: exports.f, rnnoise_create: exports.h, rnnoise_destroy: exports.i, rnnoise_process_frame: exports.j };
    exports.d();
    this.state = this.exports.rnnoise_create(0); this.input = this.exports.malloc(480 * 4); this.output = this.exports.malloc(480 * 4);
    if (!this.state || !this.input || !this.output) { this.destroy(); throw Error('RNNoise allocation failed'); }
  }
  process(frame) {
    if (!this.state || frame.length !== 480) throw Error('RNNoise requires an active 480-sample frame');
    const heap = new Float32Array(this.exports.memory.buffer);
    for (let i = 0; i < 480; i++) heap[this.input / 4 + i] = frame[i] * 32768;
    const probability = this.exports.rnnoise_process_frame(this.state, this.output, this.input);
    for (let i = 0; i < 480; i++) frame[i] = heap[this.output / 4 + i] / 32768;
    if (!Number.isFinite(probability)) throw Error('Invalid RNNoise probability');
    return Math.max(0, Math.min(1, probability));
  }
  destroy() {
    if (this.state) this.exports.rnnoise_destroy(this.state);
    if (this.input) this.exports.free(this.input);
    if (this.output) this.exports.free(this.output);
    this.state = this.input = this.output = 0;
  }
}

// A bounded streaming low-pass converter. Phase and history cross quantum and
// RNNoise frame boundaries; downsampling never decimates unfiltered noise.
export class NoiseResampler {
  constructor(sourceRate, targetRate) {
    if (!(sourceRate > 0 && targetRate > 0)) throw Error('Invalid audio sample rate');
    this.step = sourceRate / targetRate; this.position = 0; this.written = 0;
    this.ring = new Float32Array(4096);
    const half = 12, cutoff = Math.min(1, targetRate / sourceRate) * .94;
    this.coefficients = Array.from({ length: 256 }, (_, phase) => {
      const row = new Float32Array(half * 2); let sum = 0;
      for (let j = 0; j < row.length; j++) {
        const x = phase / 256 + half - 1 - j;
        const sinc = Math.abs(x) < 1e-8 ? cutoff : Math.sin(Math.PI * cutoff * x) / (Math.PI * x);
        sum += row[j] = Math.abs(x) >= half ? 0 : sinc * (.42 + .5 * Math.cos(Math.PI * x / half) + .08 * Math.cos(2 * Math.PI * x / half));
      }
      for (let j = 0; j < row.length; j++) row[j] /= sum;
      return row;
    });
  }
  push(value, output) {
    this.ring[this.written++ % 4096] = value;
    while (this.position + 12 < this.written) {
      const integer = Math.floor(this.position), start = integer - 11;
      const row = this.coefficients[Math.min(255, Math.floor((this.position - integer) * 256))];
      let value = 0;
      for (let j = 0; j < 24; j++) { const index = start + j; value += (index < 0 ? 0 : this.ring[index % 4096]) * row[j]; }
      output(value); this.position += this.step;
    }
  }
}

export class NoiseCapture {
  constructor(module, sampleRate, emit) {
    this.module = module; this.sampleRate = sampleRate; this.emit = emit;
    this.epoch = 0; this.muted = false; this.destroyed = false; this.reset();
  }
  reset() {
    this.denoiser?.destroy(); this.denoiser = new NoiseDenoiser(this.module);
    this.inputConverter = this.sampleRate === 48000 ? null : new NoiseResampler(this.sampleRate, 48000);
    this.outputConverter = new NoiseResampler(48000, 24000);
    this.inputFrame = new Float32Array(480); this.inputUsed = 0;
    this.outputFrame = new Int16Array(480); this.outputUsed = 0;
    this.probabilitySum = 0; this.probabilitySamples = 0;
    this.convertInput = sample => this.accept48k(sample);
    this.convertOutput = value => {
      this.outputFrame[this.outputUsed++] = Math.round(Math.max(-1, Math.min(1, value)) * 32767);
      this.probabilitySum += this.frameProbability; this.probabilitySamples++;
      if (this.outputUsed === 480) {
        const data = this.outputFrame.buffer;
        this.emit({ type: 'pcm', epoch: this.epoch, data, probability: this.probabilitySum / this.probabilitySamples }, [data]);
        this.outputFrame = new Int16Array(480); this.outputUsed = 0; this.probabilitySum = 0; this.probabilitySamples = 0;
      }
    };
  }
  setMuted(value, epoch) {
    this.muted = !!value; this.epoch = epoch ?? this.epoch;
    // Destroy the old model state too: neither audio nor VAD history survives
    // a mute/epoch boundary and appears in a later utterance.
    this.reset();
  }
  accept(value) {
    if (this.muted || this.destroyed) return;
    if (this.inputConverter) this.inputConverter.push(value, this.convertInput);
    else this.accept48k(value);
  }
  accept48k(value) {
    this.inputFrame[this.inputUsed++] = value;
    if (this.inputUsed !== 480) return;
    this.frameProbability = this.denoiser.process(this.inputFrame);
    for (const sample of this.inputFrame) this.outputConverter.push(sample, this.convertOutput);
    this.inputUsed = 0;
  }
  destroy() { if (this.destroyed) return; this.destroyed = true; this.denoiser.destroy(); }
}
