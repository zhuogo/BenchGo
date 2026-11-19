import test from 'node:test';
import assert from 'node:assert/strict';
import { executeAsr, requestSpeech } from '../../src/protocols/registry.mjs';
import { protocolOptions, protocolDescriptor, VOICE_PROTOCOLS } from '../../shared/protocol-catalog.mjs';

const signal = () => new AbortController().signal;
const config = { baseURL: 'https://audio.example/v1', apiKey: 'fixture-key', model: 'Opaque Model:9' };
const sse = data => new Response(data, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });

test('native StepFun ASR has its own JSON route without rewriting the model', async () => {
  const bytes = new Uint8Array([1, 2, 3]), partials = [];
  const result = await executeAsr(async (url, options) => {
    assert.equal(url, 'https://audio.example/v1/audio/asr/sse');
    assert.equal(options.headers.authorization, 'Bearer fixture-key');
    assert.equal(options.headers['content-type'], 'application/json');
    assert.equal(options.redirect, 'error');
    assert.deepEqual(JSON.parse(options.body), { audio: { data: 'AQID', input: {
      transcription: { model: 'Opaque Model:9' }, format: { type: 'wav' },
    } } });
    return sse('data: {"type":"transcript.text.delta","delta":"你好"}\n\ndata: {"type":"transcript.text.done","text":"你好。"}\n\n');
  }, { ...config, protocol: 'stepfun-sse' }, bytes, signal(), text => partials.push(text));
  assert.deepEqual(result, { text: '你好。' }); assert.deepEqual(partials, ['你好', '你好。']);
});

test('native ASR error events fail safely instead of returning partial success', async () => {
  await assert.rejects(executeAsr(async () => sse('data: {"type":"error","message":"fixture-key"}\n\n'),
    { ...config, protocol: 'stepfun-sse' }, new Uint8Array(), signal()), error => {
    assert.equal(error.status, 502); assert.equal(error.message.includes('fixture-key'), false); return true;
  });
});

test('protocol dispatch rejects prototype keys and requires an explicit native session', async () => {
  const fetcher = () => assert.fail('unsupported protocols must not make a request');
  for (const protocol of ['__proto__', 'constructor', 'auto', 'unknown']) {
    await assert.rejects(executeAsr(fetcher, { ...config, protocol }, new Uint8Array(), signal()), /supported transcription/);
  }
  await assert.rejects(executeAsr(fetcher, { ...config, protocol: 'openai-websocket' }, new Uint8Array(), signal()), error => error.code === 'asr_session_required');
});

test('compatible StepFun TTS reuses speech request and preserves actual audio response', async () => {
  const response = await requestSpeech(async (url, options) => {
    assert.equal(url, 'https://audio.example/v1/audio/speech');
    assert.deepEqual(JSON.parse(options.body), { model: 'Opaque Model:9', voice: 'Explicit Voice', input: '测试', response_format: 'pcm', speed: 1.2 });
    return new Response(new Uint8Array([1, 0, 2, 0]), { headers: { 'content-type': 'audio/pcm' } });
  }, { ...config, protocol: 'speech', apiType: 'stepfun', voice: 'Explicit Voice' }, '测试', signal());
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([1, 0, 2, 0]));
});

test('upstream status remains classifiable while arbitrary messages remain private', async () => {
  await assert.rejects(requestSpeech(async () => Response.json({ error: { message: 'fixture-key private', code: 'invalid_api_key' } }, { status: 401 }), config, 'test', signal()), error => {
    assert.equal(error.upstreamStatus, 401); assert.equal(error.code, 'invalid_api_key');
    assert.equal(error.message.includes('fixture-key'), false); return true;
  });
});

test('raw speech refuses oversized upstream audio before returning normalized headers', async () => {
  let cancelled = false;
  await assert.rejects(requestSpeech(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }),
    { headers: { 'content-type': 'audio/pcm', 'content-length': String(64 * 1024 * 1024) } }), config, 'test', signal()), error => error.code === 'tts_audio_limit');
  assert.equal(cancelled, true);
});

test('audio cancellation never waits for a stalled upstream cancel handler', async () => {
  const response = await requestSpeech(async () => new Response(new ReadableStream({ cancel() { return new Promise(() => {}); } }),
    { headers: { 'content-type': 'audio/pcm' } }), config, 'test', signal());
  await Promise.race([response.body.cancel(), new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('cancellation stalled')), 100); timer.unref(); })]);
});

test('catalog exposes only implemented formats and native types reuse compatible TTS', () => {
  assert.equal(protocolDescriptor('asr', 'auto'), undefined);
  assert.equal(protocolDescriptor('asr', 'stepfun-sse').transport, 'sse');
  assert.equal(protocolDescriptor('tts', 'speech-stream').streaming, true);
  assert.equal(protocolDescriptor('tts', 'speech').streaming, true);
  assert.deepEqual(protocolOptions('tts', 'stepfun').map(item => item.value), ['speech', 'speech-stream', 'stepfun-speech-sse', 'stepfun-speech-websocket']);
  assert.equal(protocolDescriptor('tts', 'stepfun-speech-websocket').inputStreaming, true);
  assert.equal(protocolDescriptor('tts', 'speech').inputStreaming, false);
  assert.equal(protocolOptions('asr', 'openai').some(item => item.apiType === 'stepfun'), false);
  assert.equal(VOICE_PROTOCOLS.some(item => item.id === 'stepfun-websocket'), false);
});
