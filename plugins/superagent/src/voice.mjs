import { createVoiceHandlers } from '../../media/src/web.mjs';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

export function createAssistantVoice({ store, providers, credentials, fetcher = fetch, shutdown = new AbortController().signal }) {
  const voiceActive = { transcribe: 0, speech: 0 };
  async function resolveProvider(config) {
    const resolved = await (config.credentialRef ? providers.describeRoute(config.providerId, { credentials: false }) : providers.resolve(config.providerId));
    if (!config.credentialRef) return resolved;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.credentialRef)) throw fail('Invalid assistant credential reference', 409);
    const secret = await credentials?.resolve(config.credentialRef);
    if (!secret?.value) throw fail('Assistant credential reference is unavailable', 409);
    return { ...resolved, apiKey: secret.value };
  }
  async function availability() {
    const config = await store.getConfig(), result = {};
    for (const kind of ['asr', 'tts']) {
      const selected = config[kind];
      let reason = '';
      if (!selected?.providerId || !selected.modelId) reason = '请配置供应商与模型';
      else {
        const protocol = selected.protocol || (kind === 'asr' ? 'transcriptions' : 'speech');
        const supported = kind === 'tts' ? ['speech', 'speech-stream'] : ['transcriptions', 'transcriptions-sse'];
        if (!supported.includes(protocol)) reason = '当前协议不受支持';
        else try {
          const resolved = await resolveProvider(selected);
          const url = new URL(resolved.baseURL);
          if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !resolved.apiKey) throw fail('Invalid provider route or credentials');
        } catch { reason = '供应商路由或凭据不可用，请检查配置'; }
      }
      result[kind] = { available: !reason, reason };
    }
    return result;
  }
  async function voice(kind, request) {
    if (voiceActive[kind] >= (kind === 'speech' ? 3 : 2)) return Response.json({ error: 'Too many active assistant voice requests' }, { status: 429 });
    voiceActive[kind]++;
    const localShutdown = new AbortController();
    const abort = () => localShutdown.abort();
    shutdown.addEventListener('abort', abort, { once: true });
    if (shutdown.aborted) abort();
    let handlers, closed = false;
    const close = () => { if (closed) return; closed = true; shutdown.removeEventListener('abort', abort); handlers?.dispose(); localShutdown.abort(); voiceActive[kind]--; };
    try {
    const config = await store.getConfig();
    const mapped = key => ({ ...config[key], protocol: config[key]?.protocol || (key === 'asr' ? 'transcriptions' : 'speech'), model: config[key]?.modelId || '', apiKey: '', baseURL: '' });
    const value = { asr: mapped('asr'), tts: mapped('tts'), dictation: true, readAloud: true, call: false };
    const selected = config[kind === 'speech' ? 'tts' : 'asr'];
    const scopedProviders = { resolve: () => resolveProvider(selected) };
    handlers = createVoiceHandlers({ value, snapshot: () => structuredClone(value) }, { providers: scopedProviders, fetcher, shutdown: localShutdown.signal });
    const response = await handlers[kind](request);
    if (!response.body) { close(); return response; }
    const reader = response.body.getReader();
    return new Response(new ReadableStream({
      async pull(controller) { try { const next = await reader.read(); if (next.done) { close(); controller.close(); } else controller.enqueue(next.value); } catch (error) { close(); controller.error(error); } },
      async cancel() { try { await reader.cancel(); } finally { close(); } },
    }), { status: response.status, headers: response.headers });
    } catch (error) { close(); throw error; }
  }
  return { availability, handlers: { transcribe: request => voice('transcribe', request), speech: request => voice('speech', request), worklet: async request => { const handlers = createVoiceHandlers({ value: {} }); try { return await handlers.worklet(request); } finally { handlers.dispose(); } } } };
}
