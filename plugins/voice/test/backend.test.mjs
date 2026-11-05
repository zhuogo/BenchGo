import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VoiceConfig, updateConfig, publicConfig, migrateLegacyConfig, normalizeTtsModel, normalizeAsrModel } from '../src/config.mjs';
import { createVoiceHandlers, mountWeb } from '../src/web.mjs';
import { LIMITS, validateWav } from '../src/media.mjs';
import { CallLeases } from '../src/calls.mjs';
import { voiceAvailability, resolveVoiceProvider } from '../src/availability.mjs';

const json = (path, input, extras = {}) => new Request(`http://app.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...extras.headers }, body: JSON.stringify(input), ...extras });
function wav(samples = 2400, rate = 24000) {
  const bytes = Buffer.alloc(44 + samples * 2); bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40); return bytes;
}
const input = bytes => new Request('http://app.test/api/voice/transcribe', { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: bytes });

test('shared provider references clear borrowed secrets and resolve server-side only', async () => {
  const store = memory();
  await store.configure({ asr: { providerId: 'routergo', baseURL: 'https://ignored.test', apiKey: 'clear-me', model: 'whisper-test', protocol: 'transcriptions' } });
  assert.equal(store.value.asr.apiKey, ''); assert.equal(store.value.asr.baseURL, '');
  const handlers = createVoiceHandlers(store, { providers: {
    resolve: async () => ({ baseURL: 'https://shared.test/v1', apiKey: 'server-only-key' }),
  }, fetcher: async (url, options) => {
    assert.equal(url, 'https://shared.test/v1/audio/transcriptions');
    assert.equal(options.headers.authorization, 'Bearer server-only-key');
    return Response.json({ text: 'shared success' });
  } });
  const safe = await (await handlers.config(json('/api/voice', { action: 'config' }))).json();
  assert.equal(safe.config.asr.baseURL, 'https://shared.test/v1');
  assert.equal(safe.config.asr.configured, true);
  assert.equal(JSON.stringify(safe).includes('server-only-key'), false);
  const result = await handlers.transcribe(input(wav())); assert.equal(result.status, 200);
  assert.equal((await result.json()).text, 'shared success'); handlers.dispose();
});

test('unavailable shared provider disables voice without exposing resolver errors', async () => {
  const store = memory(); await store.configure({ asr: { providerId: 'removed' } });
  const handlers = createVoiceHandlers(store, { providers: { resolve: async () => { throw Error('private-error'); } } });
  const safe = await (await handlers.config(json('/api/voice', { action: 'config' }))).json();
  assert.equal(safe.config.asr.configured, false);
  const result = await handlers.transcribe(input(wav())); assert.equal(result.status, 409);
  assert.equal((await result.text()).includes('private-error'), false); handlers.dispose();
});
test('shared availability follows feature switches and the same resolved routes as config and media', async () => {
  const store = memory(), routes = new Map([
    ['asr', { baseURL: 'https://shared-asr.test/v1', apiKey: 'server-asr-secret' }],
    ['tts', { baseURL: 'https://shared-tts.test/v1', apiKey: 'server-tts-secret' }],
  ]);
  await store.configure({ asr: { providerId: 'asr', model: 'Opaque ASR:07', protocol: 'openai-websocket' }, tts: { providerId: 'tts', model: 'Opaque TTS:09', protocol: 'speech' } });
  const providers = { resolve: async id => { const route = routes.get(id); if (!route) throw Error('private resolver details'); return route; } };
  const handlers = createVoiceHandlers(store, { providers });
  try {
    let result = await voiceAvailability(store, providers);
    assert.deepEqual(result, { available: { voiceInput: true, readAloud: true, realtimeVoice: true }, reasons: {} });
    assert.equal((await resolveVoiceProvider(store, 'asr', providers)).model, 'Opaque ASR:07');
    routes.delete('asr');
    result = await voiceAvailability(store, providers);
    assert.deepEqual(result.available, { voiceInput: false, readAloud: true, realtimeVoice: false });
    assert.ok(result.reasons.voiceInput); assert.ok(result.reasons.realtimeVoice);
    assert.equal(JSON.stringify(result).includes('private resolver details'), false);
    const config = await (await handlers.config(json('/api/voice', { action: 'config' }))).json();
    assert.equal(config.config.asr.configured, false); assert.equal(config.config.tts.configured, true);
    assert.equal(JSON.stringify(config).includes('server-tts-secret'), false);
    routes.set('asr', { baseURL: 'file:///bad-route', apiKey: 'secret' });
    assert.equal((await voiceAvailability(store, providers)).available.voiceInput, false);
    routes.set('asr', { baseURL: 'https://shared-asr.test/v1', apiKey: 'server-asr-secret' });
    store.value.asr.protocol = 'unsupported';
    assert.equal((await voiceAvailability(store, providers)).available.voiceInput, false);
    store.value.asr.protocol = 'transcriptions-sse'; store.value.dictation = false;
    result = await voiceAvailability(store, providers);
    assert.deepEqual(result.available, { voiceInput: false, readAloud: true, realtimeVoice: true });
    assert.match(result.reasons.voiceInput, /启用语音输入/);
    store.value.tts.model = '';
    result = await voiceAvailability(store, providers);
    assert.deepEqual(result.available, { voiceInput: false, readAloud: false, realtimeVoice: false });
  } finally { handlers.dispose(); }
});
const memory = () => ({
  value: { dictation: true, readAloud: true, call: true, asr: { baseURL: 'https://asr.test/v1', model: 'recognizer', apiKey: 'secret-for-test' }, tts: { baseURL: 'https://tts.test/v1', model: 'speaker', apiKey: 'other-secret', voice: 'alloy' } },
  snapshot() { return publicConfig(this.value); }, async configure(patch) { this.value = updateConfig(this.value, patch); return this.snapshot(); },
});

test('configuration is durable, private, masked and serialized without losing concurrent changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'voice-config-'));
  try {
    const store = await new VoiceConfig({ dataDir: directory }).open();
    await Promise.all([store.configure({ dictation: true, asr: { baseURL: 'http://localhost:8000/v1/', apiKey: 'keep-me', model: 'whisper' } }), store.configure({ readAloud: true })]);
    const publicValue = store.snapshot();
    assert.equal(publicValue.asr.apiKey, undefined); assert.equal(publicValue.asr.apiKeyMasked, '••••••••'); assert.equal(publicValue.asr.configured, true);
    assert.equal(JSON.stringify(publicValue).includes('keep-me'), false);
    if (process.platform !== 'win32') assert.equal((await stat(store.path)).mode & 0o777, 0o600);
    const reopened = await new VoiceConfig({ dataDir: directory }).open();
    assert.equal(reopened.value.dictation, true); assert.equal(reopened.value.readAloud, true); assert.equal(reopened.value.asr.apiKey, 'keep-me');
    await reopened.configure({ asr: { model: 'new-model' } }); assert.equal(reopened.value.asr.apiKey, 'keep-me');
    await reopened.configure({ asr: { apiKey: '' } }); assert.equal(reopened.snapshot().asr.apiKeyConfigured, false);
    assert.equal(JSON.parse(await readFile(store.path, 'utf8')).asr.model, 'new-model');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('fresh configuration defaults to streaming OpenAI with no inferred model', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'voice-defaults-'));
  try {
    const store = await new VoiceConfig({ dataDir: directory }).open();
    assert.equal(store.value.asr.model, '');
    assert.equal(store.value.asr.protocol, 'transcriptions-sse');
    assert.equal(store.value.tts.model, '');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('provider ASR IDs survive saving, reopening and multipart requests unchanged', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'voice-provider-model-'));
  try {
    for (const model of ['step-asr', 'stepfun-2.5-asr']) for (const protocol of ['transcriptions', 'transcriptions-sse']) {
      const store = await new VoiceConfig({ dataDir: directory }).open();
      const saved = await store.configure({ dictation: true, asr: { providerId: 'routergo', model, protocol } });
      assert.equal(saved.asr.model, model);
      assert.equal(JSON.parse(await readFile(store.path, 'utf8')).asr.model, model);
      const reopened = await new VoiceConfig({ dataDir: directory }).open();
      assert.equal(reopened.snapshot().asr.model, model);
      const handlers = createVoiceHandlers(reopened, {
        providers: { resolve: async () => ({ baseURL: 'https://routergo.test/api/v1' }) },
        fetcher: async (url, options) => {
          assert.equal(url, 'https://routergo.test/api/v1/audio/transcriptions');
          assert.equal(options.body.get('model'), model);
          return protocol === 'transcriptions' ? Response.json({ text: 'recognized' }) : new Response('data: {"type":"transcript.text.done","text":"recognized"}\n\n', { headers: { 'content-type': 'text/event-stream' } });
        },
      });
      try {
        const response = await handlers.transcribe(input(wav()));
        assert.equal(response.status, 200);
        assert.match(await response.text(), /recognized/u);
      } finally { handlers.dispose(); }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('configuration rejects unsafe URL shapes, unknown fields and header injection', () => {
  const value = memory().value;
  for (const baseURL of ['file:///etc/passwd', 'https://user:password@example.test', 'https://example.test/?key=secret', 'https://example.test/#secret']) assert.throws(() => updateConfig(value, { asr: { baseURL } }));
  assert.throws(() => updateConfig(value, { asr: { apiKey: 'x\r\nsecret' } }));
  assert.throws(() => updateConfig(value, { typo: true }));
  assert.throws(() => updateConfig(value, { call: 'true' }));
});

test('routes inherit official owner-only Connection routes and use streaming bounded request bodies', () => {
  const registered = [], effects = [];
  mountWeb({ effect(fn) { effects.push(fn()); }, connection: { fetch: { register(route) { registered.push(route); return () => {}; } } } }, memory());
  assert.deepEqual(registered.map(route => route.path), ['/api/voice', '/api/voice/transcribe', '/api/voice/speech', '/api/voice/worklet']);
  assert.equal(registered.slice(0, 3).every(route => route.requestBody === 'streaming' && route.methods.join() === 'POST'), true);
  assert.deepEqual(registered[3].methods, ['GET']);
  for (const cleanup of effects) cleanup?.();
});

test('config API blocks cross-site requests while accepting trusted proxy Host', async () => {
  const handlers = createVoiceHandlers(memory());
  assert.equal((await handlers.config(json('/api/voice', { action: 'config' }, { headers: { 'content-type': 'application/json', origin: 'https://attacker.test' } }))).status, 403);
  assert.equal((await handlers.config(json('/api/voice', { action: 'config' }, { headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' } }))).status, 403);
  const response = await handlers.config(json('/api/voice', { action: 'config' }, { headers: { 'content-type': 'application/json', host: 'dsh.test', origin: 'https://dsh.test' } }));
  assert.equal(response.status, 200); assert.equal(JSON.stringify(await response.json()).includes('secret-for-test'), false);
});

test('ASR verifies WAV, forwards configured model and returns only transcription', async () => {
  let seen = false;
  const handlers = createVoiceHandlers(memory(), { fetcher: async (url, options) => {
    seen = true; assert.equal(url, 'https://asr.test/v1/audio/transcriptions'); assert.equal(options.headers.authorization, 'Bearer secret-for-test'); assert.equal(options.body.get('model'), 'recognizer'); assert.equal(options.body.get('file').type, 'audio/wav'); assert.equal(options.redirect, 'error');
    return Response.json({ text: ' hello ', dangerous: 'ignore' });
  } });
  assert.equal((await handlers.transcribe(input(Buffer.from('not-wav')))).status, 400); assert.equal(seen, false);
  assert.deepEqual(await (await handlers.transcribe(input(wav()))).json(), { text: 'hello' });
  assert.throws(() => validateWav(wav(16 * 24000)), /15 seconds/u);
  const invalid = wav(); invalid.writeUInt16LE(2, 22); assert.throws(() => validateWav(invalid), /mono/u);
});

test('upstream failures never expose body, URL, API key or native exception text', async () => {
  const handlers = createVoiceHandlers(memory(), { fetcher: async () => new Response('Bearer secret-for-test', { status: 401 }) });
  const response = await handlers.transcribe(input(wav())); assert.equal(response.status, 502); assert.deepEqual(await response.json(), { error: 'ASR service rejected the request (401)', code: 'asr_http_401' });
  const network = createVoiceHandlers(memory(), { fetcher: async () => { throw new Error('secret-for-test @ https://asr.test'); } });
  assert.equal((await (await network.transcribe(input(wav()))).text()).includes('secret-for-test'), false);
});

test('TTS streams promptly, rejoins odd-byte chunks and never accepts frontend credentials/models', async () => {
  let sent;
  const handlers = createVoiceHandlers(memory(), { fetcher: async (_url, options) => {
    sent = JSON.parse(options.body);
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); controller.enqueue(new Uint8Array([4])); controller.close(); } }), { headers: { 'content-type': 'application/octet-stream' } });
  } });
  const response = await handlers.speech(json('/api/voice/speech', { text: 'hello', model: 'not-used', apiKey: 'not-used' }));
  assert.equal(response.headers.get('x-voice-sample-rate'), '24000'); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3, 4]);
  assert.deepEqual(sent, { model: 'speaker', voice: 'alloy', input: 'hello', response_format: 'pcm', speed: 1.2 });
});

test('disabled features and missing models are rejected before provider access', async () => {
  const store = memory(); store.value.dictation = false; store.value.call = false; store.value.readAloud = false;
  const handlers = createVoiceHandlers(store, { fetcher() { assert.fail('provider called'); } });
  assert.equal((await handlers.transcribe(input(wav()))).status, 409); assert.equal((await handlers.speech(json('/api/voice/speech', { text: 'hello' }))).status, 409);
  store.value.dictation = true; store.value.asr.model = ''; assert.equal((await handlers.transcribe(input(wav()))).status, 409);
});

test('speech cancellation releases concurrency and cancels upstream reader', async () => {
  let cancelled = 0; const signals = [];
  const handlers = createVoiceHandlers(memory(), { fetcher: async (_url, options) => { signals.push(options.signal); return new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { 'content-type': 'audio/pcm' } }); } });
  const make = () => handlers.speech(json('/api/voice/speech', { text: 'hello' }));
  const first = await make(), second = await make(), prefetched = await make();
  assert.equal(prefetched.status, 200); assert.equal((await make()).status, 429);
  await first.body.cancel(); assert.equal(signals[0].aborted, true); assert.equal(cancelled, 1);
  const third = await make(); assert.equal(third.status, 200); await second.body.cancel(); await prefetched.body.cancel(); await third.body.cancel();
});

test('request abort and plugin shutdown propagate while TTS stream is open', async () => {
  const shutdown = new AbortController(), abort = new AbortController(); let signal;
  const handlers = createVoiceHandlers(memory(), { shutdown: shutdown.signal, fetcher: async (_url, options) => { signal = options.signal; return new Response(new ReadableStream({}), { headers: { 'content-type': 'audio/pcm' } }); } });
  const response = await handlers.speech(json('/api/voice/speech', { text: 'hello' }, { signal: abort.signal }));
  abort.abort(); assert.equal(signal.aborted, true); await assert.rejects(response.arrayBuffer());
  const next = await handlers.speech(json('/api/voice/speech', { text: 'again' })); shutdown.abort(); assert.equal(signal.aborted, true); await assert.rejects(next.arrayBuffer());
  assert.equal((await handlers.config(json('/api/voice', { action: 'config' }))).status, 503);
});

test('call lease enforces one device, heartbeat TTL, 30 minute maximum and active media cancellation', () => {
  let now = 0; const calls = new CallLeases({ now: () => now });
  const first = calls.start({ sessionId: 'one', deviceId: 'browser' });
  assert.equal(calls.start({ sessionId: 'one', deviceId: 'browser' }).callId, first.callId);
  assert.throws(() => calls.start({ sessionId: 'one', deviceId: 'phone' }), /another device/u);
  const signal = calls.media(first.callId);
  now = 30000; assert.equal(calls.heartbeat(first).expiresAt, 75000);
  now = 75001; assert.throws(() => calls.heartbeat(first), /expired/u); assert.equal(signal.aborted, true);
  const second = calls.start({ sessionId: 'one', deviceId: 'phone' });
  now = second.startedAt + 30 * 60000; assert.throws(() => calls.heartbeat(second), /expired/u);
  calls.clear();
});

test('call APIs bind media to lease; config change and hangup abort live audio immediately', async () => {
  const store = memory(); store.value.dictation = false; store.value.readAloud = false; let upstream;
  const handlers = createVoiceHandlers(store, { fetcher: async (_url, options) => { upstream = options.signal; return new Response(new ReadableStream({}), { headers: { 'content-type': 'audio/pcm' } }); } });
  const control = async value => (await handlers.config(json('/api/voice', value))).json();
  const { call } = await control({ action: 'call.start', sessionId: 'session', deviceId: 'device' });
  const speech = () => handlers.speech(json('/api/voice/speech', { text: 'hello' }, { headers: { 'content-type': 'application/json', 'x-voice-call-id': call.callId } }));
  assert.equal((await handlers.speech(json('/api/voice/speech', { text: 'hello' }))).status, 409);
  const response = await speech(); assert.equal(response.status, 200);
  await control({ action: 'call.end', ...call }); assert.equal(upstream.aborted, true); await assert.rejects(response.arrayBuffer()); assert.equal((await speech()).status, 409);
  const next = await control({ action: 'call.start', sessionId: 'session', deviceId: 'device' });
  const audio = await handlers.speech(json('/api/voice/speech', { text: 'hello' }, { headers: { 'content-type': 'application/json', 'x-voice-call-id': next.call.callId } }));
  await control({ action: 'configure', config: { call: false } }); assert.equal(upstream.aborted, true); await assert.rejects(audio.arrayBuffer());
  assert.equal((await handlers.config(json('/api/voice', { action: 'call.heartbeat', ...next.call }))).status, 409); handlers.dispose();
});

test('voice calls preserve the selected provider ASR ID in realtime routing and session settings', async () => {
  const { EventEmitter } = await import('node:events'); let socket, connectedUrl;
  class FakeSocket extends EventEmitter {
    constructor() { super(); this.sent = []; queueMicrotask(() => this.emit('open')); }
    send(raw) { const event = JSON.parse(raw); this.sent.push(event); if (event.type === 'session.update') queueMicrotask(() => this.emit('message', JSON.stringify({ type: 'session.updated' }))); }
    close() { this.closed = true; }
  }
  const store = memory();
  await store.configure({ dictation: false, asr: { providerId: 'routergo', model: 'step-asr', protocol: 'openai-websocket', realtime: { url: 'wss://routergo.test/api/v1/realtime', query: { model: '{model}' } } } });
  const h = createVoiceHandlers(store, { providers: { resolve: async () => ({ baseURL: 'https://routergo.test/api/v1' }) }, socket: url => { connectedUrl = url; return socket = new FakeSocket(); } });
  try {
    const started = await h.config(json('/api/voice', { action: 'call.start', sessionId: 'session', deviceId: 'device' }));
    assert.equal(started.status, 200);
    const { call } = await started.json();
    const asr = await h.config(json('/api/voice', { action: 'asr.start' }, { headers: { 'content-type': 'application/json', 'x-voice-call-id': call.callId } }));
    assert.equal(asr.status, 200);
    assert.equal(new URL(connectedUrl).searchParams.get('model'), 'step-asr');
    assert.equal(socket.sent[0].session.audio.input.transcription.model, 'step-asr');
  } finally { h.dispose(); }
});

test('SSE transcription route emits partials and final; TTS uses standard fields',async()=>{
  const store=memory();store.value.asr.protocol='transcriptions-sse';store.value.tts.model='stepaudio-2.5-tts';store.value.tts.voice='';
  const h=createVoiceHandlers(store,{fetcher:async(url,options)=>{
    if(url.endsWith('/audio/transcriptions'))return new Response('data: {"type":"transcript.text.delta","delta":"你"}\n\ndata: {"type":"transcript.text.done","text":"你好"}\n\n',{headers:{'content-type':'text/event-stream'}});
    const body=JSON.parse(options.body);assert.equal(body.voice,'alloy');assert.equal(body.sample_rate,undefined);assert.equal(body.speed,1.2);return new Response(new Uint8Array(4),{headers:{'content-type':'audio/pcm'}});
  }});
  const response=await h.transcribe(input(wav())),events=(await response.text()).trim().split('\n').map(JSON.parse);assert.deepEqual(events.map(e=>e.type),['partial','partial','final']);assert.equal(events.at(-1).text,'你好');
  assert.equal((await (await h.speech(json('/api/voice/speech',{text:'测试'}))).arrayBuffer()).byteLength,4);h.dispose();
});

test('TTS keeps provider model IDs without model-derived protocol defaults', async () => {
  assert.equal(normalizeTtsModel(' stepfun-2.5-tts '), 'stepfun-2.5-tts');
  assert.equal(normalizeAsrModel(' step-asr '), 'step-asr');
  assert.equal(updateConfig(memory().value, { tts: { model: 'stepfun-2.5-tts' } }).tts.model, 'stepfun-2.5-tts');
  assert.equal(migrateLegacyConfig({ tts: { model: 'stepfun-2.5-tts' } }).tts.model, 'stepfun-2.5-tts');
  let sent;
  const store = memory(); store.value.tts.model = 'stepfun-2.5-tts'; store.value.tts.voice = '';
  const h = createVoiceHandlers(store, { fetcher: async (_url, options) => { sent = JSON.parse(options.body); return new Response(new Uint8Array([1, 0]), { headers: { 'content-type': 'audio/pcm' } }); } });
  await (await h.speech(json('/api/voice/speech', { text: '测试' }))).arrayBuffer();
  assert.equal(sent.model, 'stepfun-2.5-tts'); assert.equal(sent.voice, 'alloy'); assert.equal(sent.speed, 1.2); h.dispose();
});
test('model selection preserves explicit protocols without guessing transport from the model name', () => {
  const base = memory().value; base.asr.protocol = 'transcriptions-sse';
  assert.equal(updateConfig(base, { asr: { model: 'stepaudio-2.5-asr-stream' } }).asr.protocol, 'transcriptions-sse');
  const native = updateConfig(base, { asr: { model: 'stepaudio-2.5-asr-stream', protocol: 'openai-websocket' } });
  assert.equal(updateConfig(native, { asr: { model: 'stepaudio-2.5-asr' } }).asr.protocol, 'openai-websocket');
  assert.equal(updateConfig(base, { asr: { model: 'stepaudio-2.5-asr-stream', protocol: 'transcriptions' } }).asr.protocol, 'transcriptions');
});
test('pre-protocol model migration is provider independent and preserves explicit choices', async () => {
  const legacy = { asr: { providerId: 'routergo', model: 'mimo-v2.5-asr' } };
  assert.equal(migrateLegacyConfig(legacy).asr.protocol, 'transcriptions-sse');
  assert.equal(legacy.asr.protocol, undefined);
  assert.equal(migrateLegacyConfig({ asr: { baseURL: 'https://routergo.cn/api/v1', model: 'stepaudio-2.5-asr' } }).asr.protocol, 'transcriptions-sse');
  assert.equal(migrateLegacyConfig({ asr: { ...legacy.asr, protocol: 'mimo-sse' } }).asr.protocol, 'mimo-sse');
  assert.equal(migrateLegacyConfig({ asr: { model: 'stepaudio-2.5-asr-stream' } }).asr.protocol, 'transcriptions-sse');
  const directory = await mkdtemp(join(tmpdir(), 'voice-migrate-'));
  try {
    await writeFile(join(directory, 'config.json'), JSON.stringify(legacy));
    const store = await new VoiceConfig({ dataDir: directory }).open(); assert.equal(store.value.asr.protocol, 'transcriptions-sse');
    await store.configure({ call: true }); assert.equal(JSON.parse(await readFile(store.path, 'utf8')).asr.protocol, 'transcriptions-sse');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('legacy TTS reload keeps its effective protocol and preserves explicit protocol choices', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'voice-tts-migrate-'));
  try {
    for (const model of ['stepaudio-2.5-tts', 'stepfun-2.5-tts', 'custom-tts']) for (const explicit of [undefined, 'speech', 'step-speech']) {
      const legacy = { tts: { baseURL: 'https://tts.test/v1', model, ...(explicit ? { protocol: explicit } : {}) } };
      await writeFile(join(directory, 'config.json'), JSON.stringify(legacy));
      const expected = explicit || 'speech';
      const store = await new VoiceConfig({ dataDir: directory }).open();
      assert.equal(store.snapshot().tts.protocol, expected);
      assert.equal(store.snapshot().tts.model, model);
      await store.configure({ readAloud: true });
      const reopened = await new VoiceConfig({ dataDir: directory }).open();
      assert.equal(reopened.snapshot().tts.protocol, expected);
      assert.equal(reopened.snapshot().tts.model, model);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('safe upstream machine codes explain wrong protocol without reflecting provider message', async () => {
  const h = createVoiceHandlers(memory(), { fetcher: async () => Response.json({ error: { code: 'model_unavailable', message: 'Bearer secret-for-test private user text' } }, { status: 503 }) });
  const response = await h.transcribe(input(wav())), body = await response.json();
  assert.equal(response.status, 502); assert.equal(body.code, 'model_unavailable'); assert.match(body.error, /503.*model_unavailable/u); assert.equal(JSON.stringify(body).includes('secret-for-test'), false); h.dispose();
});
test('TTS rejects contradictory PCM metadata rather than playing at the wrong pitch', async () => {
  for (const contentType of ['audio/pcm;rate=16000;channels=1', 'audio/pcm;rate=24000;channels=2']) {
    const h = createVoiceHandlers(memory(), { fetcher: async () => new Response(new Uint8Array(8), { headers: { 'content-type': contentType } }) });
    const response = await h.speech(json('/api/voice/speech', { text: 'hello' })); assert.equal(response.status, 502); assert.equal((await response.json()).code, 'tts_pcm_format'); h.dispose();
  }
});


test('configuration cancellation is scoped and leaves call leases usable for subsequent segments', async () => {
  const store = memory(); store.value = updateConfig(store.value, {});
  const signals = [], h = createVoiceHandlers(store, { fetcher: async (url, options) => {
    signals.push({ url, signal: options.signal });
    if (url.endsWith('/audio/transcriptions')) return Response.json({ text: 'ok' });
    return new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1, 0])); } }), { headers: { 'content-type': 'audio/pcm' } });
  } });
  const control = input => h.config(json('/api/voice', input));
  try {
    const { call } = await (await control({ action: 'call.start', sessionId: 's', deviceId: 'd' })).json();
    const callHeaders = { 'content-type': 'application/json', 'x-voice-call-id': call.callId };
    const speech = () => h.speech(json('/api/voice/speech', { text: 'hello' }, { headers: callHeaders }));
    const first = await speech();
    await control({ action: 'configure', config: {} }); assert.equal(signals[0].signal.aborted, false);
    await control({ action: 'configure', config: { dictation: false } }); assert.equal(signals[0].signal.aborted, false);
    await control({ action: 'configure', config: { tts: { speed: 1.35 } } }); assert.equal(signals[0].signal.aborted, true);
    await assert.rejects(first.arrayBuffer());
    assert.equal((await control({ action: 'call.heartbeat', ...call })).status, 200);
    const second = await speech(); assert.equal(second.status, 200); assert.equal(signals[1].signal.aborted, false);
    await control({ action: 'configure', config: { asr: { model: 'new-recognizer' } } }); assert.equal(signals[1].signal.aborted, false);
    await control({ action: 'configure', config: { call: false } }); assert.equal(signals[1].signal.aborted, true);
    await assert.rejects(second.arrayBuffer());
  } finally { h.dispose(); }
});

test('TTS changes do not cancel an in-flight ASR request', async () => {
  const store = memory(); let signal, finish, entered;
  const started = new Promise(resolve => entered = resolve);
  const h = createVoiceHandlers(store, { fetcher: async (_url, options) => { signal = options.signal; entered(); return new Promise(resolve => finish = resolve); } });
  try {
    const pending = h.transcribe(input(wav())); await started;
    await h.config(json('/api/voice', { action: 'configure', config: { tts: { speed: 1.15 } } }));
    assert.equal(signal.aborted, false); finish(Response.json({ text: 'kept' }));
    assert.equal((await (await pending).json()).text, 'kept');
  } finally { h.dispose(); }
});

test('provider lookup cannot launch stale media after its configuration is changed', async () => {
  const store = memory(); store.value.tts.providerId = 'old'; let resolveProvider, entered, fetched = false;
  const started = new Promise(resolve => entered = resolve);
  const h = createVoiceHandlers(store, { providers: { resolve: () => { entered(); return new Promise(resolve => resolveProvider = resolve); } }, fetcher: async () => { fetched = true; return new Response(new Uint8Array(2)); } });
  try {
    const pending = h.speech(json('/api/voice/speech', { text: 'old text' })); await started;
    await h.config(json('/api/voice', { action: 'configure', config: { tts: { providerId: '', baseURL: 'https://new.test', model: 'new' } } }));
    resolveProvider({ baseURL: 'https://old.test', apiKey: 'old-secret' });
    assert.equal((await pending).status, 499); assert.equal(fetched, false);
  } finally { h.dispose(); }
});

test('buffered TTS waits for complete PCM and enforces the audio bound', async () => {
  const store = memory(); store.value.tts.stream = false; let source, entered, sent;
  const started = new Promise(resolve => entered = resolve);
  const h = createVoiceHandlers(store, { fetcher: async (_url, options) => { sent = JSON.parse(options.body); return new Response(new ReadableStream({ start(c) { source = c; c.enqueue(new Uint8Array([1])); entered(); } })); } });
  try {
    let settled = false; const pending = h.speech(json('/api/voice/speech', { text: 'buffered' })).then(value => { settled = true; return value; });
    await started; await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
    source.enqueue(new Uint8Array([2, 3, 4])); source.close();
    assert.deepEqual(new Uint8Array(await (await pending).arrayBuffer()), new Uint8Array([1, 2, 3, 4])); assert.equal(sent.stream, undefined);
  } finally { h.dispose(); }
  const bounded = createVoiceHandlers(store, { fetcher: async () => new Response(new Uint8Array(2), { headers: { 'content-length': String(64 * 1024 * 1024) } }) });
  try { assert.equal((await bounded.speech(json('/api/voice/speech', { text: 'oversized' }))).status, 502); } finally { bounded.dispose(); }
});

test('TTS cancellation does not wait for an uncooperative upstream cancel promise', { timeout: 1000 }, async () => {
  const h = createVoiceHandlers(memory(), { fetcher: async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(2)); }, cancel() { return new Promise(() => {}); } })) });
  try { const response = await h.speech(json('/api/voice/speech', { text: 'cancel' })); await response.body.cancel(); } finally { h.dispose(); }
});

test('removed protocols load unchanged, report unavailable and recover only by explicit selection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'voice-removed-protocol-'));
  try {
    for (const protocol of ['step-sse', 'mimo-sse', 'step-websocket']) {
      await writeFile(join(directory, 'config.json'), JSON.stringify({ asr: { protocol, model: 'Opaque ID', baseURL: 'https://asr.test', apiKey: 'keep' }, tts: { protocol: 'step-speech', model: 'Opaque TTS', baseURL: 'https://tts.test', apiKey: 'retain' } }));
      const store = await new VoiceConfig({ dataDir: directory }).open(), h = createVoiceHandlers(store);
      try {
        const state = (await (await h.config(json('/api/voice', { action: 'config' }))).json()).config;
        assert.equal(state.asr.protocol, protocol); assert.equal(state.asr.configured, false); assert.match(state.asr.unavailableReason, /protocol/);
        assert.equal(state.tts.configured, false); assert.equal(store.value.asr.apiKey, 'keep');
        await store.configure({ asr: { protocol: 'transcriptions-sse' }, tts: { protocol: 'speech' } });
        assert.equal((await resolveVoiceProvider(store, 'asr')).model, 'Opaque ID'); assert.equal((await resolveVoiceProvider(store, 'tts')).apiKey, 'retain');
      } finally { h.dispose(); }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test('durable no-op saves do not notify or rewrite configuration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'voice-noop-'));
  try {
    const store = await new VoiceConfig({ dataDir: directory }).open(); let changes = 0;
    store.subscribe(() => changes++);
    await store.configure({ dictation: true }); const before = await stat(store.path);
    await store.configure({ dictation: true, tts: { speed: 1.2, stream: true } });
    assert.equal(changes, 1); assert.equal((await stat(store.path)).mtimeMs, before.mtimeMs);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('buffered TTS limits bytes even without a content-length header', async () => {
  const store = memory(); store.value.tts.stream = false;
  const h = createVoiceHandlers(store, { fetcher: async () => new Response(new Uint8Array(LIMITS.speechBytes + 2)) });
  try { assert.equal((await h.speech(json('/api/voice/speech', { text: 'oversized stream' }))).status, 502); } finally { h.dispose(); }
});
