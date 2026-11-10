import { VoiceError, validateRealtime } from './config.mjs';

const protocols = {
  asr: ['transcriptions', 'transcriptions-sse', 'openai-websocket'],
  tts: ['speech', 'speech-stream'],
};

/** Resolve the request route without probing the provider or changing model IDs. */
export async function resolveVoiceProvider(store, kind, providers) {
  const value = structuredClone(store.value[kind]);
  if (value.providerId) {
    if (!providers) throw new VoiceError('模型供应商服务尚未就绪', 409);
    try {
      const resolved = await providers.resolve(value.providerId);
      value.baseURL = resolved.baseURL;
      value.apiKey = resolved.apiKey;
    } catch { throw new VoiceError('模型供应商不可用，请检查模型设置中的 API 地址和密钥', 409); }
  }
  if (!value.baseURL || !value.model) throw new VoiceError(`Configure the ${kind.toUpperCase()} model first`, 409);
  let endpoint;
  try { endpoint = new URL(value.baseURL); } catch { throw new VoiceError('模型服务地址不可用，请检查语音设置', 409); }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new VoiceError('模型服务地址不可用，请检查语音设置', 409);
  if (value.protocol && !protocols[kind].includes(value.protocol)) throw new VoiceError(`Unknown ${kind.toUpperCase()} protocol`, 409);
  if (kind === 'asr' && value.realtime) value.realtime = validateRealtime(value.realtime, value.apiKey);
  return value;
}

/** Public config and assistant capabilities use the same request route resolver. */
export async function voiceSnapshot(store, providers) {
  const config = store.snapshot();
  await Promise.all(['asr', 'tts'].map(async kind => {
    try {
      const resolved = await resolveVoiceProvider(store, kind, providers);
      config[kind].baseURL = resolved.baseURL;
      config[kind].configured = true;
    } catch (error) {
      config[kind].unavailableReason = error.message;
      config[kind].configured = false;
      if (config[kind].providerId) config[kind].baseURL = '';
    }
  }));
  return config;
}

export async function voiceAvailability(store, providers) {
  const available = { voiceInput: false, readAloud: false, realtimeVoice: false };
  const reasons = {};
  if (!store?.value || !store.snapshot) {
    for (const name of Object.keys(available)) reasons[name] = '共享 Voice 服务尚未就绪';
    return { available, reasons };
  }
  const config = await voiceSnapshot(store, providers);
  for (const [name, enabled, ready, label] of [
    ['voiceInput', config.dictation, config.asr.configured, '语音输入'],
    ['readAloud', config.readAloud, config.tts.configured, '自动朗读'],
    ['realtimeVoice', config.call, config.asr.configured && config.tts.configured, '实时通话'],
  ]) {
    available[name] = !!(enabled && ready);
    if (!enabled) reasons[name] = `请在设置 → 语音中启用${label}`;
    else if (!ready) reasons[name] = '共享 Voice 模型、协议、供应商路由或凭据不可用，请检查设置 → 语音';
  }
  return { available, reasons };
}
