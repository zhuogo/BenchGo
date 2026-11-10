import { HttpError, assertSameOrigin, readJson, readLimited } from '../../benchgo/shared/http.mjs';
import { VoiceError } from './config.mjs';
import { resolveVoiceProvider, voiceSnapshot } from './availability.mjs';
import { LIMITS, validateWav, transcribe, upstreamFailure } from './media.mjs';
import { streamTranscription } from './asr.mjs';
import { RealtimeASR } from './realtime.mjs';
import { speechRequest } from './tts.mjs';
import { callStreamingReason } from './call-streaming.mjs';
import { CallLeases } from './calls.mjs';
import { readFile } from 'node:fs/promises';
import { WebSocketServer } from 'ws';
import { createRealtimeSockets } from './realtime-socket.mjs';

const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
function scope(request, signals) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LIMITS.requestTimeout); timeout.unref?.();
  const abort = () => controller.abort();
  for (const signal of [request.signal, ...signals]) { signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); }
  return { signal: controller.signal, abort, close() { clearTimeout(timeout); for (const signal of [request.signal, ...signals]) signal.removeEventListener('abort', abort); } };
}
export function createVoiceHandlers(store, { fetcher = fetch, shutdown = new AbortController().signal, providers, socket } = {}) {
  const active = { asr: 0, tts: 0 }, realtime = new RealtimeASR({ socket });
  const sockets = createRealtimeSockets(realtime);
  const calls = new CallLeases(); let revision = 0, previous = structuredClone(store.value);
  const generations = Object.fromEntries(['asr', 'tts', 'dictation', 'readAloud'].map(key => [key, new AbortController()]));
  const invalidate = () => {
    const next = store.value;
    if (JSON.stringify(previous) === JSON.stringify(next)) return;
    revision++;
    for (const key of Object.keys(generations)) {
      const changed = ['asr', 'tts'].includes(key) ? JSON.stringify(previous[key]) !== JSON.stringify(next[key]) : previous[key] && !next[key];
      if (!changed) continue;
      generations[key].abort(); generations[key] = new AbortController();
      if (key === 'asr') { sockets.clear(); realtime.clear(); }
    }
    if (previous.call && !next.call) calls.clear();
    previous = structuredClone(next);
  };
  const unsubscribe = store.subscribe?.(invalidate);
  const dispose = () => { unsubscribe?.(); sockets.dispose(); realtime.clear(); calls.clear(); for (const generation of Object.values(generations)) generation.abort(); };
  shutdown.addEventListener('abort', dispose, { once: true });
  const errorResponse = error => Response.json({ error: error instanceof HttpError ? error.message : 'Voice service request failed; check provider configuration and connectivity', ...(error instanceof HttpError && error.code ? { code: error.code } : {}) }, { status: error instanceof HttpError ? error.status : error?.name === 'AbortError' ? 499 : 502, headers });
  const protect = handler => async request => { try { assertSameOrigin(request); if (shutdown.aborted) throw new VoiceError('Voice service is stopping', 503); return await handler(request); } catch (error) { return errorResponse(error); } };
  const acquire = kind => { if (active[kind] >= (kind === 'tts' ? 3 : 2)) throw new VoiceError('Too many active voice requests; wait for the current segment', 429); active[kind]++; let released = false; return () => { if (!released) { released = true; active[kind]--; } }; };
  const provider = kind => resolveVoiceProvider(store, kind, providers);
  const snapshot = () => voiceSnapshot(store, providers);
  const operationFor = (request, feature) => {
    const callId = request.headers.get('x-voice-call-id');
    if (!callId && !store.value[feature]) throw new VoiceError('Start a voice call before requesting call audio', 409);
    const signals = [shutdown, generations[feature === 'dictation' ? 'asr' : 'tts'].signal];
    if (!callId) signals.push(generations[feature].signal);
    if (callId) { if (!store.value.call) throw new VoiceError('Voice calls are disabled', 409); const reason = callStreamingReason(store.value); if (reason) throw new VoiceError(reason, 409); signals.push(calls.media(callId)); }
    return scope(request, signals);
  };
  const reserve = (request, feature, kind) => { const operation = operationFor(request, feature); try { return { operation, release: acquire(kind) }; } catch (error) { operation.close(); throw error; } };
  return {
    dispose,
    acceptRealtimeSocket: sockets.accept,
    worklet: protect(async () => new Response(await readFile(new URL('../client/audio-worklet.js', import.meta.url)), { headers: { ...headers, 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'private, no-store' } })),
    noiseWorklet: protect(async () => new Response(await readFile(new URL('../lib/noise-worklet.js', import.meta.url)), { headers: { ...headers, 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'private, no-store' } })),
    noiseWasm: protect(async () => new Response(await readFile(new URL('../lib/rnnoise.wasm', import.meta.url)), { headers: { ...headers, 'content-type': 'application/wasm', 'cache-control': 'private, no-store' } })),
    config: protect(async request => {
      const input = await readJson(request);
      if (input.action === 'providers') return Response.json({ providers: providers ? await providers.list() : [] }, { headers });
      if (input.action === 'models') { if (!providers) throw new VoiceError('模型供应商服务尚未就绪', 409); return Response.json({ models: await providers.models(input.providerId, request.signal) }, { headers }); }
      if (input.action === 'asr.start') {
        const callId = request.headers.get('x-voice-call-id') || '';
        if (callId ? !store.value.call : !store.value.dictation) throw new VoiceError('Voice input is disabled', 409);
        if (callId) { const reason = callStreamingReason(store.value); if (reason) throw new VoiceError(reason, 409); }
        const signals = [shutdown, generations.asr.signal]; if (!callId) signals.push(generations.dictation.signal); if (callId) signals.push(calls.media(callId));
        const release = acquire('asr'), opening = new AbortController(); signals.push(opening.signal);
        const abort = () => opening.abort(); request.signal.addEventListener('abort', abort, { once: true }); if (request.signal.aborted) abort();
        try { const config = await provider('asr'); AbortSignal.any(signals).throwIfAborted(); if (config.protocol !== 'openai-websocket') throw new VoiceError('Select an OpenAI WebSocket transcription protocol first', 409); const id = await realtime.open(config, AbortSignal.any(signals), callId); realtime.get(id, callId).onClose = release; return Response.json({ id, ticket: sockets.issue(id, callId) }, { headers }); }
        catch (error) { release(); throw error; } finally { request.signal.removeEventListener('abort', abort); }
      }
      if (input.action === 'asr.end') { realtime.get(input.id, request.headers.get('x-voice-call-id') || ''); realtime.close(input.id); return Response.json({ ok: true }, { headers }); }
      if (input.action === 'config') return Response.json({ config: await snapshot() }, { headers });
      if (input.action === 'configure') { await store.configure(input.config); if (!unsubscribe) invalidate(); return Response.json({ config: await snapshot(), revision }, { headers }); }
      if (input.action === 'call.start') { if (!store.value.call) throw new VoiceError('Voice calls are disabled', 409); const reason = callStreamingReason(store.value); if (reason) throw new VoiceError(reason, 409); const startingRevision = revision; await provider('asr'); await provider('tts'); if (startingRevision !== revision || !store.value.call) throw new VoiceError('Voice configuration changed; start the call again', 409); return Response.json({ call: calls.start(input), revision }, { headers }); }
      if (input.action === 'call.heartbeat') return Response.json({ call: calls.heartbeat(input), revision }, { headers });
      if (input.action === 'call.end') return Response.json(calls.end(input), { headers });
      throw new VoiceError('Unknown Voice action');
    }),
    transcribe: protect(async request => {
      if (!store.value.dictation && !store.value.call) throw new VoiceError('Voice input is disabled', 409);
      if (!/^audio\/(wav|wave|x-wav)(;|$)/iu.test(request.headers.get('content-type') || '')) throw new VoiceError('Expected audio/wav', 415);
      const { operation, release } = reserve(request, 'dictation', 'asr'); let handedOff = false;
      try {
        const config = await provider('asr'); operation.signal.throwIfAborted();
        const bytes = await readLimited(request, LIMITS.audioBytes, operation.signal); validateWav(bytes);
        if ((config.protocol || 'transcriptions') === 'transcriptions') { const result = await transcribe(fetcher, config, bytes, operation.signal); operation.signal.throwIfAborted(); return Response.json(result, { headers }); }
        let finished = false; const close = () => { if (!finished) { finished = true; operation.close(); release(); } };
        const stream = new ReadableStream({ start(controller) {
          const emit = value => { operation.signal.throwIfAborted(); controller.enqueue(new TextEncoder().encode(JSON.stringify(value) + '\n')); };
          void streamTranscription(fetcher, config, bytes, operation.signal, text => emit({ type: 'partial', text })).then(result => { emit({ type: 'final', text: result.text }); controller.close(); }).catch(error => { try { controller.enqueue(new TextEncoder().encode(JSON.stringify({ type: 'error', error: error instanceof HttpError ? error.message : 'ASR stream failed' }) + '\n')); controller.close(); } catch {} }).finally(close);
        }, cancel() { operation.abort(); close(); } });
        handedOff = true; return new Response(stream, { headers: { ...headers, 'content-type': 'application/x-ndjson', 'x-accel-buffering': 'no' } });
      } finally { if (!handedOff) { operation.close(); release(); } }
    }),
    speech: protect(async request => {
      if (!store.value.readAloud && !store.value.call) throw new VoiceError('Voice playback is disabled', 409);
      const input = await readJson(request);
      if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > LIMITS.speechCharacters) throw new VoiceError('Speech text must contain 1–4000 characters');
      const { operation, release } = reserve(request, 'readAloud', 'tts'); let handedOff = false;
      try {
        const config = await provider('tts'); operation.signal.throwIfAborted();
        const upstream = await fetcher(`${config.baseURL}/audio/speech`, {
          method: 'POST', headers: { 'content-type': 'application/json', ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}) },
          body: JSON.stringify(speechRequest(config, input.text)), signal: operation.signal, redirect: 'error',
        });
        if (operation.signal.aborted) { void upstream.body?.cancel().catch(() => {}); operation.signal.throwIfAborted(); }
        if (!upstream.ok) throw await upstreamFailure(upstream, 'TTS', operation.signal);
        if (!upstream.body) throw new VoiceError('TTS service returned no audio', 502);
        const type = upstream.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
        if (type && !['audio/pcm', 'audio/pcm16', 'audio/x-pcm', 'application/octet-stream'].includes(type)) { void upstream.body.cancel().catch(() => {}); throw new VoiceError('TTS service must return raw PCM16LE, 24 kHz mono audio', 502); }
        const contentType = upstream.headers.get('content-type') || '', rate = upstream.headers.get('x-voice-sample-rate') || /(?:rate|samplerate|sample_rate)\s*=\s*"?(\d+)/iu.exec(contentType)?.[1], channels = upstream.headers.get('x-voice-channels') || /channels\s*=\s*"?(\d+)/iu.exec(contentType)?.[1];
        if (rate && Number(rate) !== 24000 || channels && Number(channels) !== 1) { void upstream.body.cancel().catch(() => {}); throw new VoiceError('TTS returned a mismatched PCM sample rate or channel count', 502, 'tts_pcm_format'); }
        if (Number(upstream.headers.get('content-length')) > LIMITS.speechBytes) { void upstream.body.cancel().catch(() => {}); throw new VoiceError('TTS output exceeds audio limit', 502); }
        const reader = upstream.body.getReader(); let bytes = 0, tail = null, finished = false, downstream;
        const onAbort = () => { reader.cancel().catch(() => {}); try { downstream?.error(new Error('Voice audio stream cancelled')); } catch {} close(); };
        const close = () => { if (!finished) { finished = true; operation.signal.removeEventListener('abort', onAbort); operation.close(); release(); } };
        const body = new ReadableStream({
          start(controller) { downstream = controller; operation.signal.addEventListener('abort', onAbort, { once: true }); if (operation.signal.aborted) onAbort(); },
          async pull(controller) {
            try {
              operation.signal.throwIfAborted();
              while (true) {
                const { value, done } = await reader.read();
                if (done) { if (tail !== null || !bytes) throw new Error('Incomplete PCM audio'); controller.close(); close(); return; }
                bytes += value.byteLength; if (bytes > LIMITS.speechBytes) throw new Error('Audio limit');
                let chunk = value;
                if (tail !== null) { chunk = new Uint8Array(value.length + 1); chunk[0] = tail; chunk.set(value, 1); tail = null; }
                if (chunk.length % 2) { tail = chunk[chunk.length - 1]; chunk = chunk.subarray(0, chunk.length - 1); }
                if (chunk.length) { controller.enqueue(chunk); return; }
              }
            } catch { operation.abort(); void reader.cancel().catch(() => {}); controller.error(new Error('Voice audio stream ended')); close(); }
          },
          cancel() { operation.abort(); void reader.cancel().catch(() => {}); close(); },
        });
        if (config.stream === false) {
          const chunks = []; let length = 0; const buffered = body.getReader();
          try { while (true) { const { value, done } = await buffered.read(); if (done) break; chunks.push(value); length += value.length; } } finally { buffered.releaseLock(); }
          const audio = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { audio.set(chunk, offset); offset += chunk.length; }
          return new Response(audio, { headers: { ...headers, 'content-type': 'audio/pcm;rate=24000;channels=1', 'x-voice-sample-rate': '24000', 'x-voice-channels': '1', 'x-voice-format': 'pcm_s16le' } });
        }
        handedOff = true;
        return new Response(body, { headers: { ...headers, 'content-type': 'audio/pcm;rate=24000;channels=1', 'x-voice-sample-rate': '24000', 'x-voice-channels': '1', 'x-voice-format': 'pcm_s16le', 'x-accel-buffering': 'no' } });
      } finally { if (!handedOff) { operation.close(); release(); } }
    }),
  };
}

/** Routes inherit the official Connection owner authentication before dispatch. */
export function mountWeb(ctx, store, options = {}) {
  const shutdown = new AbortController();
  const handlers = createVoiceHandlers(store, { ...options, shutdown: shutdown.signal });
  ctx.effect(() => () => shutdown.abort());
  for (const [path, handler] of [['/api/voice', handlers.config], ['/api/voice/transcribe', handlers.transcribe], ['/api/voice/speech', handlers.speech]]) {
    ctx.effect(() => ctx.connection.fetch.register({ path, methods: ['POST'], requestBody: 'streaming', fetch: handler }));
  }
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/voice/worklet', methods: ['GET'], requestBody: 'buffered', fetch: handlers.worklet }));
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/voice/noise-worklet', methods: ['GET'], requestBody: 'buffered', fetch: handlers.noiseWorklet }));
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/voice/noise-wasm', methods: ['GET'], requestBody: 'buffered', fetch: handlers.noiseWasm }));
  store.acceptRealtimeSocket = handlers.acceptRealtimeSocket;
  ctx.effect(() => () => { if (store.acceptRealtimeSocket === handlers.acceptRealtimeSocket) delete store.acceptRealtimeSocket; });
  ctx.inject?.(['webServer'], child => {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 2048, perMessageDeflate: false });
    child.effect(() => child.webServer.registerUpgrade({ path: '/api/voice/realtime', handler(req, socket, head) {
      const rejection = child.connection.requestRejection(req);
      if (rejection) { socket.end('HTTP/1.1 ' + rejection + ' Rejected\r\nConnection: close\r\n\r\n'); return; }
      wss.handleUpgrade(req, socket, head, handlers.acceptRealtimeSocket);
    } }));
    child.effect(() => () => { for (const ws of wss.clients) ws.terminate(); wss.close(); });
  });
  return handlers;
}
