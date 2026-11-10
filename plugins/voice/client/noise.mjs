// Assets use the caller's existing authenticated same-origin Voice transport.
export async function createNoiseSuppressor(context, { workletURL = 'api/voice/noise-worklet', wasmURL = 'api/voice/noise-wasm', signal } = {}) {
  const timeout = AbortSignal.timeout(12000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  combined.throwIfAborted();
  const response = await fetch(wasmURL, { credentials: 'same-origin', signal: combined });
  if (!response.ok) throw Error('本地语音降噪加载失败，请重试。');
  const bytes = await response.arrayBuffer(); combined.throwIfAborted();
  const module = await WebAssembly.compile(bytes);
  await context.audioWorklet.addModule(String(workletURL)); combined.throwIfAborted();
  const node = new AudioWorkletNode(context, 'voice-noise-capture', {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { module },
  });
  let disposed = false;
  const dispose = () => { if (disposed) return; disposed = true; node.port.postMessage({ type: 'destroy' }); node.disconnect(); node.port.close?.(); };
  try {
    await new Promise((resolve, reject) => {
      const finish = error => { node.port.removeEventListener('message', message); node.removeEventListener('processorerror', failed); combined.removeEventListener('abort', abort); error ? reject(error) : resolve(); };
      const message = ({ data }) => { if (data.type === 'ready') finish(); else if (data.type === 'error') failed(); };
      const failed = () => finish(Error('本地语音降噪初始化失败，请重试。'));
      const abort = () => finish(combined.reason);
      node.port.addEventListener('message', message); node.port.start?.(); node.addEventListener('processorerror', failed); combined.addEventListener('abort', abort, { once: true });
      if (combined.aborted) abort();
    });
    return { node, dispose };
  } catch (error) { dispose(); throw error; }
}
