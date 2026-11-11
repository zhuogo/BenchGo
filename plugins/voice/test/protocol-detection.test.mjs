import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProtocolDetection, protocolCandidates, probeRealtimeAsr } from '../src/protocol-detection.mjs';
import { RealtimeASR } from '../src/realtime.mjs';
import { createVoiceHandlers } from '../src/web.mjs';
import { VoiceConfig, publicConfig, updateConfig, VoiceError } from '../src/config.mjs';
import { voiceSnapshot } from '../src/availability.mjs';

const endpoint = (patch = {}) => ({ baseURL: 'https://gateway.test/v1', model: 'Opaque step:09', apiKey: 'private-key', apiType: '', protocol: '', ...patch });
const sse = () => new Response('data: {"type":"transcript.text.delta","delta":"Hello"}\n\ndata: {"type":"transcript.text.done","text":"Hello voice test"}\n\n', { headers: { 'content-type': 'text/event-stream' } });
const pcm = () => new Response(new Uint8Array([1, 0, 2, 0]), { headers: { 'content-type': 'audio/pcm;rate=24000;channels=1' } });
const json = input => new Request('http://app.test/api/voice', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
const wav = () => readFile(new URL('../src/protocols/shared/protocol-probe.wav', import.meta.url));
const store = () => ({ value: { dictation: true, readAloud: true, call: true, asr: endpoint({ baseURL: 'https://api.stepfun.com/v1', apiType: 'stepfun', protocol: 'stepfun-sse' }), tts: endpoint({ voice: 'original-voice', speed: 1.2, stream: true, apiType: 'openai', protocol: 'speech' }) }, snapshot() { return publicConfig(this.value); }, async configure(patch) { this.value = updateConfig(this.value, patch); return this.snapshot(); } });

test('matching candidates honor exact host or selected type and purpose without using model names', () => {
  assert.deepEqual(protocolCandidates('asr', endpoint()), ['openai-websocket', 'transcriptions-sse', 'transcriptions']);
  assert.deepEqual(protocolCandidates('asr', endpoint(), 'http'), ['transcriptions-sse', 'transcriptions']);
  assert.deepEqual(protocolCandidates('asr', endpoint({ baseURL: 'https://api.stepfun.com/v1' }), 'streaming'), ['stepfun-sse', 'transcriptions-sse']);
  assert.deepEqual(protocolCandidates('asr', endpoint({ baseURL: 'https://api.stepfun.com.attacker.test/v1' }), 'streaming'), ['openai-websocket', 'transcriptions-sse']);
  assert.deepEqual(protocolCandidates('tts', endpoint({ apiType: 'openai' })), ['speech', 'speech-stream']);
});

test('matching tests all candidates and prefers capability before latency', async () => {
  const visited = [];
  class Measured extends ProtocolDetection { async probe(_kind, _config, protocol) { visited.push(protocol); return { message: 'valid', firstOutputMs: { 'openai-websocket': 400, 'transcriptions-sse': 10, transcriptions: 1 }[protocol], completionMs: 500 }; } }
  const result = await new Measured().detect('asr', endpoint());
  assert.deepEqual(visited, ['openai-websocket', 'transcriptions-sse', 'transcriptions']);
  assert.equal(result.protocol, 'openai-websocket'); assert.equal(result.firstOutputMs, 400); assert.equal(result.attempts.length, 3);
});

test('later same-capability TTS format can beat earlier successful formats by measured first output', async () => {
  const visited = [];
  class Measured extends ProtocolDetection { async probe(_kind, _config, protocol) { visited.push(protocol); if (protocol === 'stepfun-speech-websocket') throw new VoiceError('No WS', 502, 'tts_http_404'); return { message: 'valid', firstOutputMs: protocol === 'speech' ? 5 : 200, completionMs: 300 }; } }
  const result = await new Measured().detect('tts', endpoint({ apiType: 'stepfun' }), { requirement: 'streaming' });
  assert.ok(visited.includes('stepfun-speech-sse')); assert.ok(visited.includes('speech-stream'));
  assert.equal(result.protocol, 'speech'); assert.equal(result.firstOutputMs, 5); assert.equal(result.attempts.length, visited.length);
});

test('authentication, limits and no-speech stop safely with remaining candidates marked not-tested', async () => {
  for (const [status, error] of [[401, { code: 'invalid_api_key', message: 'private-key' }], [429, { code: 'rate_limited' }], [400, { message: 'no speech found' }]]) {
    let requests = 0; const service = new ProtocolDetection({ fetcher: async () => { requests++; return Response.json({ error }, { status }); } });
    const result = await service.detect('asr', endpoint({ apiType: 'stepfun' }));
    assert.equal(result.status, 'inconclusive'); assert.equal(requests, 1); assert.ok(result.attempts.slice(1).every(attempt => attempt.status === 'not-tested'));
    assert.equal(JSON.stringify(result).includes('private-key'), false);
  }
});

test('TTS measures first PCM and validates complete ending instead of accepting only the first chunk', async () => {
  let source, entered; const started = new Promise(resolve => entered = resolve);
  const service = new ProtocolDetection({ fetcher: async () => new Response(new ReadableStream({ start(c) { source = c; c.enqueue(new Uint8Array([1, 0])); entered(); } }), { headers: { 'content-type': 'audio/pcm' } }) });
  let settled = false; const pending = service.detect('tts', endpoint({ protocol: 'speech' }), { explicit: true }).then(result => { settled = true; return result; });
  await started; await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  source.enqueue(new Uint8Array([2, 0])); source.close(); const result = await pending;
  assert.equal(result.status, 'supported'); assert.equal(result.attempts[0].bytes, 4); assert.ok(result.completionMs >= result.firstOutputMs);
  const invalid = new ProtocolDetection({ fetcher: async () => new Response(new Uint8Array([1]), { headers: { 'content-type': 'audio/pcm' } }) });
  assert.equal((await invalid.detect('tts', endpoint({ protocol: 'speech' }), { explicit: true })).status, 'unsupported');
});

test('explicit tests execute only one concrete protocol without changing opaque model IDs', async () => {
  let requests = 0;
  const service = new ProtocolDetection({ fetcher: async (url, options) => { requests++; assert.ok(url.endsWith('/audio/asr/sse')); const body = JSON.parse(options.body); assert.equal(body.audio.input.transcription.model, 'Opaque step:09'); return sse(); } });
  const result = await service.detect('asr', endpoint({ protocol: 'stepfun-sse', apiType: 'stepfun' }), { explicit: true });
  assert.equal(requests, 1); assert.equal(result.attempts.length, 1); assert.equal(result.protocol, 'stepfun-sse');
  assert.equal((await service.detect('asr', endpoint(), { explicit: true })).status, 'inconclusive'); assert.equal(requests, 1);
});

test('cancelling one button consumer leaves concurrent work intact and stale pending work can be cancelled', async () => {
  let finish, signal; const service = new ProtocolDetection({ fetcher: (_url, options) => { signal = options.signal; return new Promise(resolve => finish = resolve); } });
  const route = endpoint({ protocol: 'speech' }), abort = new AbortController();
  const first = service.detect('tts', route, { explicit: true, signal: abort.signal }), second = service.detect('tts', route, { explicit: true });
  abort.abort(); await assert.rejects(first, { name: 'AbortError' }); assert.equal(signal.aborted, false); finish(pcm()); assert.equal((await second).status, 'supported');
  const stale = service.detect('tts', route, { explicit: true }); service.cancelPending(); await assert.rejects(stale, { name: 'AbortError' }); assert.equal(service.pending.size, 0);
});

test('websocket ASR measurement sends audio and requires a completed transcription', async () => {
  const sent = [];
  class Socket extends EventEmitter {
    constructor() { super(); this.bufferedAmount = 0; queueMicrotask(() => this.emit('open')); }
    send(raw) { const e = JSON.parse(raw); sent.push(e); if (e.type === 'session.update') queueMicrotask(() => this.emit('message', JSON.stringify({ type: 'session.updated' }))); if (e.type === 'input_audio_buffer.commit') queueMicrotask(() => this.emit('message', JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'test', transcript: 'Hello voice test' }))); }
    close() {}
  }
  const runtime = new RealtimeASR({ socket: () => new Socket() }); let outputs = 0;
  await probeRealtimeAsr(runtime, endpoint({ protocol: 'openai-websocket' }), await wav(), new AbortController().signal, () => outputs++);
  assert.equal(runtime.sessions.size, 0); assert.equal(outputs, 1); assert.equal(sent[0].session.audio.input.transcription.model, 'Opaque step:09'); assert.equal(sent.at(-1).type, 'input_audio_buffer.commit');
});

test('empty and legacy auto never probe during reads, saves, call startup or audio requests', async () => {
  for (const protocol of ['', 'auto']) {
    const value = store(); value.value.asr.protocol = protocol; value.value.tts.protocol = protocol; let requests = 0;
    const h = createVoiceHandlers(value, { fetcher: async () => { requests++; throw Error('No runtime probe'); }, socket: () => { requests++; throw Error('No runtime probe'); } });
    try {
      const config = await (await h.config(json({ action: 'config' }))).json(); assert.equal(config.config.asr.configured, false); assert.match(config.config.asr.unavailableReason, /自动匹配/);
      assert.equal((await h.config(json({ action: 'configure', config: { tts: { speed: 1.35 } } }))).status, 200);
      assert.equal((await h.config(json({ action: 'call.start', sessionId: 's', deviceId: 'd' }))).status, 409);
      assert.equal((await h.transcribe(new Request('http://app.test/api/voice/transcribe', { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: await wav() }))).status, 409);
      assert.equal((await h.speech(new Request('http://app.test/api/voice/speech', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'User text.' }) }))).status, 409); assert.equal(requests, 0);
    } finally { h.dispose(); }
  }
});

test('matching changes only the draft result; saving concrete protocols and starting a call never probe', async () => {
  const value = store(); value.value.asr.protocol = ''; let requests = 0;
  const h = createVoiceHandlers(value, { fetcher: async (url, options) => { requests++; assert.equal(options.headers.authorization, 'Bearer private-key'); return url.endsWith('/audio/asr/sse') || options.body?.get?.('stream') === 'true' ? sse() : Response.json({ text: 'Hello voice test' }); } });
  try {
    const response = await h.config(json({ action: 'protocol.detect', kind: 'asr', config: { apiKey: '' }, requirement: 'streaming' }));
    assert.equal(response.status, 200); const { result } = await response.json(); assert.equal(result.status, 'supported'); assert.equal(result.attempts.length, 2); assert.equal(requests, 2); assert.equal(value.value.asr.protocol, '');
    const saved = await h.config(json({ action: 'configure', config: { asr: { protocol: result.protocol, apiType: result.apiType } } })); assert.equal((await saved.json()).config.asr.protocol, result.protocol); assert.equal(requests, 2);
    const started = await h.config(json({ action: 'call.start', sessionId: 'matched', deviceId: 'desktop' })); assert.equal(started.status, 200); assert.equal(requests, 2);
    const { call } = await started.json(); const response2 = await h.transcribe(new Request('http://app.test/api/voice/transcribe', { method: 'POST', headers: { 'content-type': 'audio/wav', 'x-voice-call-id': call.callId }, body: await wav() })); assert.equal(response2.status, 200); await response2.text(); assert.equal(requests, 3);
  } finally { h.dispose(); }
});

test('new auto settings are rejected while existing auto remains unmatched until explicitly selected', async () => {
  assert.throws(() => updateConfig(store().value, { asr: { protocol: 'auto' } }), /protocol/); assert.throws(() => updateConfig(store().value, { asr: { apiType: 'auto' } }), /API type/);
  const directory = await mkdtemp(join(tmpdir(), 'voice-legacy-auto-'));
  try {
    await writeFile(join(directory, 'config.json'), JSON.stringify({ asr: endpoint({ protocol: 'auto', apiType: 'auto' }) }));
    const config = await new VoiceConfig({ dataDir: directory }).open(); assert.equal(config.value.asr.protocol, 'auto'); assert.equal((await voiceSnapshot(config)).asr.configured, false);
    await config.configure({ readAloud: true }); assert.equal(config.value.asr.protocol, 'auto'); await config.configure({ asr: { protocol: 'transcriptions-sse', apiType: 'openai' } }); assert.equal(config.value.asr.protocol, 'transcriptions-sse');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
