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

async function measurePcm(chunks, completedAt = chunks.at(-1)[0]) {
  let now = 0, source, requestedText;
  const service = new ProtocolDetection({ now: () => now, fetcher: async (_url, options) => {
    requestedText = JSON.parse(options.body).input;
    return new Response(new ReadableStream({ start(controller) { source = controller; } }), { headers: { 'content-type': 'audio/pcm' } });
  } });
  const pending = service.probe('tts', endpoint(), 'speech', new AbortController().signal);
  const settle = () => new Promise(resolve => setImmediate(resolve));
  await settle();
  for (const [at, duration] of chunks) {
    now = at; source.enqueue(new Uint8Array(duration * 48)); await settle();
  }
  now = completedAt; source.close();
  return { ...await pending, requestedText };
}

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

test('later same-capability TTS format can beat earlier successful formats by measured playable PCM', async () => {
  const visited = [];
  class Measured extends ProtocolDetection { async probe(_kind, _config, protocol) { visited.push(protocol); if (protocol === 'stepfun-speech-websocket') throw new VoiceError('No WS', 502, 'tts_http_404'); return { message: 'valid', firstOutputMs: protocol === 'speech' ? 5 : 200, firstPlayableMs: protocol === 'speech' ? 30 : 240, maxAudioGapMs: 20, observedPlaybackGapMs: 0, audioSupplyRatio: 2, completionMs: 300 }; } }
  const result = await new Measured().detect('tts', endpoint({ apiType: 'stepfun' }), { requirement: 'streaming' });
  assert.ok(visited.includes('stepfun-speech-sse')); assert.ok(visited.includes('speech-stream'));
  assert.equal(result.protocol, 'speech'); assert.equal(result.firstOutputMs, 5); assert.equal(result.attempts.length, visited.length);
  assert.equal(result.firstPlayableMs,30);assert.equal(result.maxAudioGapMs,20);
});

test('nominal WebSocket text streaming and tiny first packets do not beat earlier playable audio',async()=>{
  const visited=[],measured={
    'stepfun-speech-websocket':{firstOutputMs:5,firstPlayableMs:700,completionMs:900,maxAudioGapMs:695},
    'stepfun-speech-sse':{firstOutputMs:80,firstPlayableMs:100,completionMs:300,maxAudioGapMs:20},
    speech:{firstOutputMs:20,firstPlayableMs:150,completionMs:250,maxAudioGapMs:130},
    'speech-stream':{firstOutputMs:80,firstPlayableMs:100,completionMs:350,maxAudioGapMs:20},
  };
  class Measured extends ProtocolDetection {async probe(_kind,_config,protocol){visited.push(protocol);return {message:'valid',observedPlaybackGapMs:0,audioSupplyRatio:2,...measured[protocol]};}}
  const config=endpoint({apiType:'stepfun',protocol:'stepfun-speech-websocket'}),service=new Measured();
  const result=await service.detect('tts',config,{requirement:'streaming'});
  assert.equal(visited.length,4);assert.equal(result.protocol,'stepfun-speech-sse');assert.equal(result.firstPlayableMs,100);
  assert.equal(result.attempts.find(row=>row.protocol==='stepfun-speech-websocket').firstOutputMs,5);
  visited.length=0;const explicit=await service.detect('tts',config,{requirement:'streaming',explicit:true});
  assert.deepEqual(visited,['stepfun-speech-websocket']);assert.equal(explicit.protocol,'stepfun-speech-websocket');assert.equal(explicit.firstPlayableMs,700);
});

test('TTS matching prefers continuous supply over an earlier 80ms burst without overriding explicit selection', async () => {
  const early = await measurePcm([[100, 80], [500, 80], [900, 80]]);
  const steady = await measurePcm([[200, 160], [300, 160], [400, 160]]);
  assert.equal(early.observedPlaybackGapMs, 640); assert.equal(early.audioSupplyRatio, 0.3);
  assert.equal(steady.observedPlaybackGapMs, 0); assert.equal(steady.audioSupplyRatio, 2.4);
  assert.ok(early.requestedText.length > 100); assert.equal(early.requestedText, steady.requestedText);
  class Measured extends ProtocolDetection { async probe(_kind, _config, protocol) { return protocol === 'speech' ? early : steady; } }
  const service = new Measured(), config = endpoint({ apiType: 'openai', protocol: 'speech' }), saved = structuredClone(config);
  const result = await service.detect('tts', config, { requirement: 'streaming' });
  assert.equal(result.protocol, 'speech-stream'); assert.equal(result.firstPlayableMs, 200);
  assert.equal(result.observedPlaybackGapMs, 0); assert.equal(result.audioSupplyRatio, 2.4);
  const explicit = await service.detect('tts', config, { explicit: true });
  assert.equal(explicit.protocol, 'speech'); assert.equal(explicit.observedPlaybackGapMs, 640);
  assert.deepEqual(config, saved);
});

test('large PCM bursts cover packet gaps and a delayed done event is not a playback shortfall', async () => {
  const result = await measurePcm([[100, 1000], [900, 1000]], 3000);
  assert.equal(result.maxAudioGapMs, 800); assert.equal(result.observedPlaybackGapMs, 0);
  assert.equal(result.audioSupplyRatio, 2.5); assert.equal(result.completionMs, 3000);
});

test('supply statistics expose below-realtime delivery and near-risk candidates still compare playable latency', async () => {
  const slow = await measurePcm([[100, 80], [300, 80], [500, 80]]);
  assert.equal(slow.audioSupplyRatio, 0.6); assert.equal(slow.observedPlaybackGapMs, 240);
  class Measured extends ProtocolDetection { async probe(_kind, _config, protocol) {
    return { firstOutputMs: 100, firstPlayableMs: protocol === 'speech' ? 100 : 180, observedPlaybackGapMs: protocol === 'speech' ? 20 : 0, audioSupplyRatio: 1.5, completionMs: 500 };
  } }
  assert.equal((await new Measured().detect('tts', endpoint())).protocol, 'speech');
});

test('TTS playable time uses accumulated 80ms PCM and gaps between nonempty audio chunks',async()=>{
  let now=1000,source;
  const service=new ProtocolDetection({now:()=>now,fetcher:async()=>new Response(new ReadableStream({start(controller){source=controller;}}),{headers:{'content-type':'audio/pcm'}})});
  const pending=service.detect('tts',endpoint({protocol:'speech'}),{explicit:true});
  const settle=()=>new Promise(resolve=>setImmediate(resolve));await settle();
  now=1010;source.enqueue(new Uint8Array(2));await settle();
  now=1080;source.enqueue(new Uint8Array(3838));await settle();
  now=1130;source.close();const result=await pending;
  assert.equal(result.firstOutputMs,10);assert.equal(result.firstPlayableMs,80);assert.equal(result.completionMs,130);assert.equal(result.maxAudioGapMs,70);
  assert.deepEqual(result.attempts[0].firstPlayableMs,result.firstPlayableMs);
});

test('a validated complete short utterance becomes playable at completion without waiting for 80ms PCM',async()=>{
  let now=0,source;
  const service=new ProtocolDetection({now:()=>now,fetcher:async()=>new Response(new ReadableStream({start(controller){source=controller;}}),{headers:{'content-type':'audio/pcm'}})});
  const pending=service.detect('tts',endpoint({protocol:'speech'}),{explicit:true});
  await new Promise(resolve=>setImmediate(resolve));now=20;source.enqueue(new Uint8Array([1,0]));await new Promise(resolve=>setImmediate(resolve));
  now=75;source.close();const result=await pending;
  assert.equal(result.firstOutputMs,20);assert.equal(result.firstPlayableMs,75);assert.equal(result.completionMs,75);assert.equal(result.maxAudioGapMs,0);
  assert.equal(result.audioSupplyRatio,null);assert.equal(result.observedPlaybackGapMs,0);
});

test('protocol test HTTP results expose playable and supply measurements without altering saved selection',async()=>{
  const value=store(),saved=structuredClone(value.value);let requests=0;
  const handlers=createVoiceHandlers(value,{fetcher:async()=>{requests++;return pcm();}});
  try{
    const response=await handlers.config(json({action:'protocol.test',kind:'tts'}));assert.equal(response.status,200);
    const {result}=await response.json();assert.equal(requests,1);assert.equal(result.protocol,'speech');
    assert.equal(typeof result.firstPlayableMs,'number');assert.equal(result.attempts[0].firstPlayableMs,result.firstPlayableMs);assert.equal(result.maxAudioGapMs,0);
    assert.equal(result.audioSupplyRatio,null);assert.equal(result.observedPlaybackGapMs,0);assert.equal(result.attempts[0].observedPlaybackGapMs,0);
    assert.deepEqual(value.value,saved);
  }finally{handlers.dispose();}
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
