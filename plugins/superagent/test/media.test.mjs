import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMedia } from '../src/media.mjs';
import { createAssistantStore } from '../src/store.mjs';
import { pcmWav } from '../../voice/client/media.mjs';

async function fixture(t, fetcher, overrides = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'assistant-media-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const config = { image: { providerId: 'images', modelId: 'opaque-image-id', protocol: 'openai-compatible' }, tts: { providerId: 'speech', modelId: 'opaque-tts-id', protocol: 'speech', voice: 'custom', speed: 1 }, asr: null, ...overrides };
  const options = { store: { paths: { workspace }, getConfig: async () => config }, providers: { describeRoute: async id => ({ protocol: 'openai-completions', baseURL: `https://${id}.example/v1` }), resolve: async id => ({ baseURL: `https://${id}.example/v1`, apiKey: 'test-secret' }) }, fetcher };
  return { media: createAssistantMedia(options), options, workspace };
}
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
test('media availability checks local configuration, routes and credentials without network requests', async t => {
  const { options } = await fixture(t, async () => { throw Error('availability must not fetch'); });
  const config = await options.store.getConfig();
  let status = await createAssistantMedia(options).availability();
  assert.equal(status.image.available, true); assert.equal(status.tts.available, true);
  assert.equal(status.asr.available, false); assert.match(status.asr.reason, /配置/);
  config.tts.protocol = 'unknown'; config.image.protocol = 'unknown';
  status = await createAssistantMedia(options).availability();
  assert.match(status.tts.reason, /协议/); assert.equal(status.image.available, false);
  config.tts.protocol = 'step-speech';
  config.asr = { providerId: 'speech', modelId: 'opaque-asr', protocol: 'mimo-sse' };
  status = await createAssistantMedia(options).availability();
  assert.equal(status.tts.available, false); assert.equal(status.asr.available, false);
  config.tts.protocol = 'speech'; config.image.protocol = 'openai-compatible';
  options.providers.resolve = async () => { throw Error('missing shared credential'); };
  status = await createAssistantMedia(options).availability();
  assert.equal(status.tts.available, false); assert.match(status.image.reason, /路由或凭据/);
  config.tts.credentialRef = 'MEDIA_KEY'; config.image.credentialRef = 'MEDIA_KEY';
  const credentials = { resolve: async () => ({ value: 'dedicated-secret' }) };
  status = await createAssistantMedia({ ...options, credentials }).availability();
  assert.equal(status.tts.available, true); assert.equal(status.image.available, true);
  options.providers.describeRoute = async () => ({ baseURL: 'file:///tmp/private', protocol: 'openai-completions' });
  status = await createAssistantMedia({ ...options, credentials }).availability();
  assert.equal(status.tts.available, false); assert.equal(status.image.available, false);
  options.providers.describeRoute = async () => ({ baseURL: 'https://provider.example', protocol: 'anthropic' });
  status = await createAssistantMedia({ ...options, credentials }).availability();
  assert.equal(status.image.available, false);
  credentials.resolve = async () => undefined;
  status = await createAssistantMedia({ ...options, credentials }).availability();
  assert.equal(status.tts.available, false);
});
test('image uses exact configured model and persists idempotency across instances', async t => {
  let calls = 0;
  const { media, options, workspace } = await fixture(t, async (url, request) => {
    calls++; assert.equal(url, 'https://images.example/v1/images/generations');
    assert.equal(JSON.parse(request.body).model, 'opaque-image-id');
    assert.equal(request.redirect, 'error');
    return Response.json({ data: [{ b64_json: png.toString('base64') }] });
  });
  const input = { requestId: 'stable', prompt: 'Make an image' };
  const [a, b] = await Promise.all([media.generateImage(input), media.generateImage(input)]);
  assert.deepEqual(a, b); assert.equal(calls, 1);
  assert.deepEqual(await createAssistantMedia(options).generateImage(input), a);
  assert.deepEqual(await readFile(join(workspace, a.relativePath)), png);
  await assert.rejects(media.generateImage({ ...input, prompt: 'Different image' }), /another request/);
  assert.equal(calls, 1);
});
test('uncertain submitted image never automatically resends and URL results are not fetched', async t => {
  let calls = 0;
  const { media, options } = await fixture(t, async () => { calls++; return Response.json({ data: [{ url: 'http://127.0.0.1/private' }] }); });
  const input = { requestId: 'url', prompt: 'Make an image' };
  await assert.rejects(media.generateImage(input), /remote image URLs/);
  await assert.rejects(createAssistantMedia(options).generateImage(input), /already submitted/);
  assert.equal(calls, 1);
});
test('unknown image protocol and invalid request ids fail before upstream access', async t => {
  let calls = 0;
  const { media } = await fixture(t, async () => { calls++; }, { image: { providerId: 'images', modelId: 'id', protocol: 'unknown' } });
  await assert.rejects(media.generateImage({ requestId: '../bad', prompt: 'Image' }), /requestId/);
  await assert.rejects(media.generateImage({ requestId: 'valid', prompt: 'Image' }), /protocol/);
  assert.equal(calls, 0);
});
test('TTS resolves independent provider and exact model then streams PCM', async t => {
  const { media } = await fixture(t, async (url, request) => {
    assert.equal(url, 'https://speech.example/v1/audio/speech');
    assert.deepEqual(JSON.parse(request.body), { model: 'opaque-tts-id', voice: 'custom', input: 'Hello', response_format: 'pcm', speed: 1 });
    return new Response(new Uint8Array([0, 0, 1, 0]), { headers: { 'content-type': 'audio/pcm' } });
  });
  const result = await media.synthesize(new Request('https://app.example/api/assistant/voice/speech', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Hello' }) }));
  assert.equal(result.status, 200); assert.equal((await result.arrayBuffer()).byteLength, 4);
});

test('independent streaming TTS is available and forwards first PCM before provider EOF', { timeout: 1000 }, async t => {
  let calls = 0, signal, cancelled = false;
  const { media } = await fixture(t, async (url, request) => {
    calls++; signal = request.signal;
    assert.equal(url, 'https://speech.example/v1/audio/speech');
    assert.deepEqual(JSON.parse(request.body), { model: 'Opaque TTS:09', voice: 'custom', input: 'Hello', response_format: 'pcm', speed: 1.35, stream: true });
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array([1, 0])); },
      cancel() { cancelled = true; },
    }), { headers: { 'content-type': 'audio/pcm' } });
  }, { tts: { providerId: 'speech', modelId: 'Opaque TTS:09', protocol: 'speech-stream', voice: 'custom', speed: 1.35 } });
  assert.deepEqual((await media.availability()).tts, { available: true, reason: '' });
  assert.equal(calls, 0);
  const response = await media.synthesize(new Request('https://app.example/api/assistant/voice/speech', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Hello' }),
  }));
  assert.equal(response.status, 200); assert.equal(calls, 1);
  const reader = response.body.getReader();
  t.after(() => reader.cancel());
  assert.deepEqual(await reader.read(), { value: new Uint8Array([1, 0]), done: false });
  assert.equal(signal.aborted, false);
  await reader.cancel();
  assert.equal(signal.aborted, true); assert.equal(cancelled, true);
});
test('missing independent ASR config is explicit', async t => {
  const { media } = await fixture(t, async () => { throw Error('must not fetch'); });
  const result = await media.transcribe(new Request('https://app.example/api/assistant/voice/transcribe', { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: new Uint8Array() }));
  assert.equal(result.status, 409); assert.match((await result.json()).error, /ASR/);
});

test('saved and reloaded independent ASR/TTS selection reaches exact provider requests', async t => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'assistant-media-config-'));
  const store = await createAssistantStore({ dataDirectory });
  let reloaded;
  t.after(async () => { reloaded?.close(); store.close(); await rm(dataDirectory, { recursive: true, force: true }); });
  await store.updateConfig({ models: [{ providerId: 'text', modelId: 'text-main' }], asr: { providerId: 'asr-provider', modelId: 'Exact ASR:07', protocol: 'transcriptions' }, tts: { providerId: 'tts-provider', modelId: 'Exact TTS:09', protocol: 'speech', voice: 'original', speed: 1 } });
  await store.updateConfig({ tts: { voice: 'changed' } });
  reloaded = await createAssistantStore({ dataDirectory });
  const observed = [];
  assert.deepEqual((await reloaded.getConfig()).models, [{ providerId: 'text', modelId: 'text-main' }]);
  const media = createAssistantMedia({ store: reloaded, providers: { resolve: async provider => ({ baseURL: `https://${provider}.example/v1`, apiKey: provider }) }, fetcher: async (url, request) => {
    observed.push(url);
    if (url.includes('asr-provider')) {
      assert.equal(request.body.get('model'), 'Exact ASR:07');
      assert.equal(request.headers.authorization, 'Bearer asr-provider');
      return Response.json({ text: 'recognized' });
    }
    const body = JSON.parse(request.body);
    assert.equal(body.model, 'Exact TTS:09'); assert.equal(body.voice, 'changed');
    assert.equal(request.headers.authorization, 'Bearer tts-provider');
    return new Response(new Uint8Array([0, 0]), { headers: { 'content-type': 'audio/pcm' } });
  } });
  const wav = pcmWav([new Float32Array(240)]);
  const asr = await media.transcribe(new Request('https://app.example/api/assistant/voice/transcribe', { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wav }));
  assert.equal(asr.status, 200); assert.equal((await asr.json()).text, 'recognized');
  const tts = await media.synthesize(new Request('https://app.example/api/assistant/voice/speech', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Reply' }) }));
  assert.equal(tts.status, 200); await tts.arrayBuffer();
  assert.deepEqual(observed, ['https://asr-provider.example/v1/audio/transcriptions', 'https://tts-provider.example/v1/audio/speech']);
});

test('dedicated media credentials override shared keys, unavailable references never fall back', async t => {
  const { options } = await fixture(t, async (url, request) => {
    assert.equal(request.headers.authorization, 'Bearer dedicated-secret');
    return url.endsWith('/audio/speech') ? new Response(new Uint8Array([0, 0]), { headers: { 'content-type': 'audio/pcm' } }) : Response.json({ data: [{ b64_json: png.toString('base64') }] });
  });
  const config = await options.store.getConfig();
  config.tts.credentialRef = 'ASSISTANT_MEDIA_KEY'; config.image.credentialRef = 'ASSISTANT_MEDIA_KEY';
  delete config.tts.protocol;
  const media = createAssistantMedia({ ...options, credentials: { resolve: async ref => { assert.equal(ref, 'ASSISTANT_MEDIA_KEY'); return { value: 'dedicated-secret' }; } } });
  const speechRequest = () => new Request('https://app.example/api/assistant/voice/speech', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Hello' }) });
  const speech = await media.synthesize(speechRequest()); assert.equal(speech.status, 200); await speech.arrayBuffer();
  await media.generateImage({ requestId: 'dedicated', prompt: 'Image' });
  const missing = createAssistantMedia({ ...options, credentials: { resolve: async () => undefined } });
  await assert.rejects(missing.generateImage({ requestId: 'missing', prompt: 'Image' }), /credential reference is unavailable/);
  const refused = await missing.synthesize(speechRequest()); assert.equal(refused.status, 409); await refused.json();
});

test('dedicated image, ASR and TTS credentials work without shared provider credentials', async t => {
  const observed = [];
  const { options } = await fixture(t, async (url, request) => {
    observed.push(url);
    assert.equal(request.headers.authorization, 'Bearer dedicated-secret');
    if (url.endsWith('/audio/transcriptions')) return Response.json({ text: 'recognized' });
    if (url.endsWith('/audio/speech')) return new Response(new Uint8Array([0, 0]), { headers: { 'content-type': 'audio/pcm' } });
    return Response.json({ data: [{ b64_json: png.toString('base64') }] });
  }, { asr: { providerId: 'asr', modelId: 'exact-asr', protocol: 'transcriptions', credentialRef: 'MEDIA_KEY' } });
  const config = await options.store.getConfig();
  config.image.credentialRef = 'MEDIA_KEY'; config.tts.credentialRef = 'MEDIA_KEY';
  options.providers.resolve = async () => { throw new Error('Shared provider credentials unavailable'); };
  const media = createAssistantMedia({ ...options, credentials: { resolve: async ref => { assert.equal(ref, 'MEDIA_KEY'); return { value: 'dedicated-secret' }; } } });
  await media.generateImage({ requestId: 'no-shared-key', prompt: 'Image' });
  const asr = await media.transcribe(new Request('https://app.example/api/assistant/voice/transcribe', { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: pcmWav([new Float32Array(240)]) }));
  assert.equal(asr.status, 200); assert.equal((await asr.json()).text, 'recognized');
  const tts = await media.synthesize(new Request('https://app.example/api/assistant/voice/speech', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Hello' }) }));
  assert.equal(tts.status, 200); await tts.arrayBuffer();
  assert.deepEqual(observed, ['https://images.example/v1/images/generations', 'https://asr.example/v1/audio/transcriptions', 'https://speech.example/v1/audio/speech']);
});
