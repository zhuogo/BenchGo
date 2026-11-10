import { NoiseCapture } from './noise-core.mjs';

class NoiseCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super(); this.closed = false;
    try {
      this.capture = new NoiseCapture(options.processorOptions.module, sampleRate, (message, transfer) => this.port.postMessage(message, transfer));
      this.port.onmessage = ({ data }) => {
        if (this.closed) return;
        try {
          if (data.type === 'destroy') this.close();
          else if (data.type === 'mute') this.capture.setMuted(data.value, data.epoch);
        } catch { this.fail(); }
      };
      this.port.postMessage({ type: 'ready' });
    } catch { this.fail(); }
  }
  close() { this.closed = true; this.capture?.destroy(); }
  fail() { this.port.postMessage({ type: 'error', epoch: this.capture?.epoch, error: '本地语音降噪失败，请重新开启语音。' }); this.close(); }
  process(inputs) {
    if (this.closed) return false;
    const channels = inputs[0]; if (!channels?.length) return true;
    try {
      for (let i = 0; i < channels[0].length; i++) {
        let value = 0; for (const channel of channels) value += channel[i] || 0;
        this.capture.accept(value / channels.length);
      }
    } catch { this.fail(); }
    return !this.closed;
  }
}
registerProcessor('voice-noise-capture', NoiseCaptureProcessor);
