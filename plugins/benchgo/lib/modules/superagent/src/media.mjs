import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createVoiceHandlers } from '../../voice/src/web.mjs';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const MAX_IMAGE = 12 * 1024 * 1024;
async function limitedJson(response, signal) {
  if (!response.body) throw fail('Image provider returned an empty response', 502);
  const reader = response.body.getReader(), chunks = []; let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) { signal.throwIfAborted(); const { value, done } = await reader.read(); signal.throwIfAborted(); if (done) break; size += value.length; if (size > MAX_IMAGE * 1.4) throw fail('Image response exceeds size limit', 502); chunks.push(value); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); }
}
function imageType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return ['png', 'image/png'];
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return ['jpg', 'image/jpeg'];
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return ['webp', 'image/webp'];
  throw fail('Image provider returned an unsupported image format', 502);
}

export function createAssistantMedia({ store, providers, credentials, fetcher = fetch, shutdown = new AbortController().signal }) {
  const active = new Map(), voiceActive = { transcribe: 0, speech: 0 };
  async function resolveProvider(config, describe = false) {
    const resolved = await (describe || config.credentialRef ? providers.describeRoute(config.providerId, { credentials: !config.credentialRef }) : providers.resolve(config.providerId));
    if (!config.credentialRef) return resolved;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.credentialRef)) throw fail('Invalid assistant credential reference', 409);
    const secret = await credentials?.resolve(config.credentialRef);
    if (!secret?.value) throw fail('Assistant credential reference is unavailable', 409);
    return { ...resolved, apiKey: secret.value };
  }
  async function availability() {
    const config = await store.getConfig(), result = {};
    for (const kind of ['image', 'asr', 'tts']) {
      const selected = config[kind];
      let reason = '';
      if (!selected?.providerId || !selected.modelId) reason = '请配置供应商与模型';
      else {
        const protocol = selected.protocol || (kind === 'asr' ? 'transcriptions' : kind === 'tts' ? 'speech' : '');
        const supported = kind === 'image' ? ['openai-compatible'] : kind === 'tts' ? ['speech', 'speech-stream'] : ['transcriptions', 'transcriptions-sse'];
        if (!supported.includes(protocol)) reason = '当前协议不受支持';
        else try {
          if (kind === 'image') {
            const route = await providers.describeRoute(selected.providerId);
            if (!['openai-compatible', 'openai-completions', 'openai-responses'].includes(route.protocol)) throw fail('Unsupported image provider protocol');
          }
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
  async function generateImage({ requestId, prompt, signal } = {}) {
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(requestId)) throw fail('A stable image requestId is required');
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 16000) throw fail('Image prompt must contain 1-16000 characters');
    const config = (await store.getConfig()).image;
    if (!config?.providerId || !config.modelId) throw fail('Configure the assistant image model first', 409);
    const fingerprint = createHash('sha256').update(JSON.stringify({ prompt, config })).digest('hex');
    const directory = join(store.paths.workspace, 'artifacts');
    const taskPath = join(directory, `image-task-${requestId}.json`);
    const existing = active.get(taskPath);
    if (existing) { if (existing.fingerprint !== fingerprint) throw fail('Image requestId already belongs to another request', 409); return existing.promise; }
    const operation = async () => {
      await mkdir(directory, { recursive: true });
      try {
        const previous = JSON.parse(await readFile(taskPath, 'utf8'));
        if (previous.fingerprint !== fingerprint) throw fail('Image requestId already belongs to another request', 409);
        if (previous.status === 'complete') return previous.result;
        throw fail('Image request already submitted; verify its outcome before creating another request', 409);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const route = await resolveProvider(config, true);
      if (config.protocol !== 'openai-compatible' || !['openai-compatible', 'openai-completions', 'openai-responses'].includes(route.protocol)) throw fail('Image generation requires an explicitly supported OpenAI-compatible provider protocol', 409);
      for (const key of ['size', 'quality']) if (config[key] !== undefined && (typeof config[key] !== 'string' || config[key].length > 100)) throw fail(`Invalid image ${key}`);
      const resolved = await resolveProvider(config);
      const url = new URL(resolved.baseURL);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw fail('Invalid image API address', 409);
      const requestSignal = AbortSignal.any([shutdown, AbortSignal.timeout(90000), ...(signal ? [signal] : [])]);
      requestSignal.throwIfAborted();
      await writeFile(taskPath, JSON.stringify({ status: 'submitted', fingerprint, requestId }), { flag: 'wx', mode: 0o600 });
      // Submitted records survive network failures: a retry must not charge twice.
      const response = await fetcher(resolved.baseURL.replace(/\/+$/, '') + '/images/generations', { method: 'POST', redirect: 'error', signal: requestSignal, headers: { 'content-type': 'application/json', authorization: `Bearer ${resolved.apiKey}` }, body: JSON.stringify({ model: config.modelId, prompt, n: 1, response_format: 'b64_json', ...(config.size ? { size: config.size } : {}), ...(config.quality ? { quality: config.quality } : {}) }) });
      if (!response.ok) { await response.body?.cancel(); throw fail(`Image provider rejected the request (${response.status})`, 502); }
      const data = await limitedJson(response, requestSignal), encoded = data?.data?.[0]?.b64_json;
      if (typeof encoded !== 'string' || !encoded.length || encoded.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw fail('Image provider must return base64 image data; remote image URLs are not supported', 502);
      const bytes = Buffer.from(encoded, 'base64');
      if (!bytes.length || bytes.length > MAX_IMAGE) throw fail('Image exceeds size limit', 502);
      const [extension, mimeType] = imageType(bytes), filename = randomUUID() + '.' + extension;
      await writeFile(join(directory, filename), bytes, { flag: 'wx', mode: 0o600 });
      const result = { requestId, filename, relativePath: `artifacts/${filename}`, mimeType, bytes: bytes.length, providerId: config.providerId, modelId: config.modelId };
      const temporary = taskPath + '.' + randomUUID() + '.tmp';
      try { await writeFile(temporary, JSON.stringify({ status: 'complete', fingerprint, requestId, result }), { mode: 0o600 }); await rename(temporary, taskPath); }
      finally { await rm(temporary, { force: true }); }
      return result;
    };
    const promise = operation().finally(() => active.delete(taskPath)); active.set(taskPath, { fingerprint, promise }); return promise;
  }
  return { availability, handlers: { transcribe: request => voice('transcribe', request), speech: request => voice('speech', request), worklet: async request => { const handlers = createVoiceHandlers({ value: {} }); try { return await handlers.worklet(request); } finally { handlers.dispose(); } } }, transcribe: request => voice('transcribe', request), synthesize: request => voice('speech', request), generateImage };
}
