import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeMediaTools, mediaToolDefinitions } from '../src/generation-tools.mjs';
import { mountMediaGenerationWeb } from '../src/generation-web.mjs';

const settings = { revision: 0, image: { enabled: true, routes: [{}] }, video: { enabled: false, routes: [] }, audio: { enabled: false, routes: [] } };
const userImage = attachment => ({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'image', attachment }] } });
const userText = text => ({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } });
const receipt = value => [
  { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', name: 'generate_video', id: 'video-call' }] } } },
  { type: 'tool/result', data: { message: { toolCallId: 'video-call', content: [{ type: 'text', text: JSON.stringify(value) }] } } },
];
const execution = events => ({
  agent: { id: 'chat-id', session: { snapshotEvents: () => events } },
  callId: 'image-call',
  signal: new AbortController().signal,
});

test('official chat sends only session attachments and preserves an explicit model', async () => {
  const attachment = { attachmentId: 'ref-image', mediaType: 'image/png', bytes: 3, name: 'scene.png' };
  const attachments = { readImage: async ref => { assert.equal(ref, attachment); return { data: new Uint8Array([1, 2, 3]) }; } };
  const generation = { getSettings: async () => settings, async generate(input) {
    assert.equal(input.model, 'Exact/Model');
    assert.equal(input.reference[0].size, 3);
    return { filename: 'image.png', status: 'completed' };
  } };
  const [image] = mediaToolDefinitions({ generation, attachments });
  assert.equal(await image.when(), true);
  const input = { prompt: 'edit this scene', model: 'Exact/Model', operation: 'edit', references: ['scene.png'] };
  const message = userText('Edit with Exact/Model.');
  message.data.content.push(...userImage(attachment).data.content);
  const result = await image.execute(input, execution([{ type: 'turn/start' }, message]));
  assert.equal(result.url, 'api/benchgo/media/artifact?file=image.png');
  await assert.rejects(image.execute(input, execution([])), /this conversation/);
});

test('media routing ignores agent-selected IDs unless the active user names them exactly', async () => {
  const calls = [];
  const generation = { getSettings: async () => settings, async generate(input) { calls.push(input); return {}; } };
  const [image] = mediaToolDefinitions({ generation });
  const args = { prompt: 'Draw a lake with Exact/Model.', model: 'Exact/Model', providerId: 'Image/Provider' };
  const history = [userText('Use Exact/Model on Image/Provider.'), { type: 'turn/end' }, { type: 'turn/start' }];
  await image.execute(args, execution([...history, userText('画一个湖。')]));
  await image.execute(args, execution([...history, userText('请用Exact/Model-v2画一个湖。')]));
  await image.execute(args, execution([...history, userText('请用Exact/Model画一个湖。')]));
  await image.execute(args, execution(history), { requestId: 'router-action', userMessage: userText('Use Exact/Model on Image/Provider.').data });
  assert.deepEqual(calls.map(({ model, providerId }) => [model, providerId]), [
    [undefined, undefined], [undefined, undefined], ['Exact/Model', undefined], ['Exact/Model', 'Image/Provider'],
  ]);
  assert.equal(calls.at(-1).requestId, 'router-action');
});

test('official video lookup requires a receipt from the current conversation', async () => {
  const generation = { videoStatus: async ({ requestId }) => ({ requestId, jobId: 'upstream', status: 'completed', filename: 'movie.mp4' }) };
  const status = mediaToolDefinitions({ generation }).find(tool => tool.name === 'media_video_status');
  await assert.rejects(status.execute({ requestId: 'local' }, execution([])), /not recorded/);
  const video = await status.execute({ requestId: 'local' }, execution(receipt({ requestId: 'local', jobId: 'upstream' })));
  assert.equal(video.url, 'api/benchgo/media/artifact?file=movie.mp4');
});

test('batch tool variants share settings and return separate presentation and video receipts', async () => {
  const calls = [];
  const generation = { getSettings: async () => settings, async generateBatch(input) {
    calls.push(input);
    return { requestId: input.requestId, results: [
      { requestId: 'first', status: 'completed', filename: 'first.png', mimeType: 'image/png' },
      { requestId: 'second', status: 'error', error: { code: 'MEDIA_SUBMISSION_UNCERTAIN', message: 'Unknown' } },
    ] };
  }, videoStatus: async ({ requestId }) => ({ requestId, jobId: 'upstream', status: 'completed', filename: 'movie.mp4' }) };
  const tools = mediaToolDefinitions({ generation });
  const image = tools.find(tool => tool.name === 'generate_image');
  const reply = await image.execute({ prompt: 'draw spring', count: 2 }, execution([]));
  assert.deepEqual(calls[0].prompts, ['draw spring', 'draw spring']);
  assert.equal(reply.results[0].url, 'api/benchgo/media/artifact?file=first.png');
  assert.deepEqual(image.output.presentationMeta({}, reply), { benchgoMedia: reply });
  assert.doesNotMatch(image.output.render({}, reply)[0].text, /api\/benchgo/);
  assert.equal(reply.results[1].error.code, 'MEDIA_SUBMISSION_UNCERTAIN');
  await assert.rejects(image.execute({ prompt: 'a', prompts: ['a', 'b'] }, execution([])), /optional count/);
  const videoStatus = tools.find(tool => tool.name === 'media_video_status');
  const video = await videoStatus.execute({ requestId: 'video-2' }, execution(receipt({ results: [{ requestId: 'video-2', jobId: 'upstream' }] })));
  assert.equal(video.url, 'api/benchgo/media/artifact?file=movie.mp4');
});

test('media tools accept single-prompt placeholders and preserve explicit batch intent', async () => {
  const calls = [];
  const generation = { getSettings: async () => ({ ...settings, video: settings.image, audio: settings.image }),
    async generate(input) { calls.push(input); return { status: 'completed' }; },
    async generateBatch(input) { calls.push(input); return { results: [] }; },
  };
  const [image, video, audio] = mediaToolDefinitions({ generation });
  const prompt = '一只坐在阳光下草地上的金毛寻回犬幼崽。';
  const padded = { count: 1, format: 'png', mask: '', model: '', operation: 'generate', prompt,
    prompts: [prompt, ''], providerId: '', quality: '', references: [], size: '1024x1024' };
  const native = createNativeMediaTools(generation);
  await image.execute(padded, execution([]), { requestId: 'router-image' });
  await native.executeNative({ sessionId: 'native-chat', callId: 'image-call', name: image.name, args: { ...padded, prompts: [] } });
  for (const call of calls) {
    assert.deepEqual([call.kind, call.prompt, call.size, call.format], ['image', prompt, '1024x1024', 'png']);
    for (const field of ['mask', 'quality', 'model', 'providerId', 'prompts']) assert.equal(call[field], undefined, field);
  }
  assert.equal(calls[0].requestId, 'router-image');
  const batch = ['第一项', '第二项', '第三项'];
  for (const tool of [image, video, audio]) {
    await tool.execute({ prompt: '', count: 1, prompts: batch }, execution([]));
    assert.deepEqual(calls.at(-1).prompts, batch);
    await tool.execute({ prompt: '描述', count: 2, prompts: [] }, execution([]));
    assert.deepEqual(calls.at(-1).prompts, ['描述', '描述']);
    await assert.rejects(tool.execute({ prompt: '描述', prompts: ['不同描述', ''] }, execution([])), { code: 'MEDIA_INVALID' });
    await assert.rejects(tool.execute({ prompts: ['描述', ''] }, execution([])), { code: 'MEDIA_INVALID' });
    await assert.rejects(tool.execute({ count: 2, prompts: batch }, execution([])), { code: 'MEDIA_INVALID' });
  }
  assert.equal(calls.length, 8);
});

test('audio tools only override configured voice with a selection in the current user message', async () => {
  const routes = [{ providerId: 'test', modelId: 'test-tts', voices: [{ name: 'Story', description: '低音女声' }], defaultVoice: 'Story' }];
  const generation = {
    getSettings: async () => ({ ...settings, audio: { enabled: true, routes } }),
    generate: async ({ voice, configuredVoice }) => ({ voice, configuredVoice }),
  };
  const audio = mediaToolDefinitions({ generation }).find(tool => tool.name === 'generate_audio');
  const args = { prompt: 'Read this', voice: 'MiMo/Story-v2' };
  const explicit = '请用 MiMo/Story-v2 朗读。';
  const turn = text => execution([{ type: 'turn/start' }, userText(text)]);
  assert.equal((await audio.execute(args, turn('朗读这段文字。'))).voice, undefined);
  assert.equal((await audio.execute(args, turn(explicit))).voice, args.voice);
  const selection = await audio.execute({ ...args, configuredVoice: 'Story' }, turn(explicit));
  assert.equal(selection.voice, args.voice);
  assert.equal(selection.configuredVoice, undefined);
  const native = createNativeMediaTools(generation);
  const call = { sessionId: 'chat', callId: 'audio-1', name: 'generate_audio', args };
  assert.equal((await native.executeNative(call)).voice, undefined);
  assert.equal((await native.executeNative({ ...call, userText: explicit })).voice, args.voice);
  assert.equal((await native.executeNative({ ...call, args: { prompt: args.prompt, configuredVoice: 'Story' } })).configuredVoice, 'Story');
  assert.deepEqual(await native.executeNative({ ...call, name: 'media_audio_voices', args: {} }), { routes });
});

test('media tools return the original image URL for chat delivery', async () => {
  const externalUrl = 'https://pub-13fd1d3607a441b4a9d232b3a223f5f6.r2.dev/generated/testing.png';
  const result = { externalUrl, mimeType: 'image/png', status: 'completed' };
  const generation = { generate: async () => result };
  const [image] = mediaToolDefinitions({ generation });
  const { requestId, ...delivery } = await image.execute({ prompt: 'draw spring' }, execution([]));
  assert.match(requestId, /^[a-f0-9]{64}$/u);
  assert.deepEqual(delivery, { ...result, url: externalUrl });
  assert.deepEqual(image.output.presentationMeta({}, delivery), { benchgoMedia: delivery });
  assert.doesNotMatch(image.output.render({}, delivery)[0].text, /https:|externalUrl/);
});

test('native requests validate inputs, keep stable call identities and isolate video lookups', async () => {
  const generation = { getSettings: async () => settings, generate: async input => ({ requestId: input.requestId, modelId: input.model, status: 'completed', filename: 'native.png' }),
    videoStatus: async () => ({ filename: 'native.mp4', status: 'completed' }) };
  const native = createNativeMediaTools(generation);
  const tools = await native.nativeTools();
  assert.deepEqual(tools.map(tool => tool.name), ['generate_image', 'media_video_status']);
  assert.ok(tools.every(tool => tool.description.includes('omit the returned artifact URL')));
  const input = { sessionId: 'chat-a', callId: 'call-1', name: 'generate_image', args: { prompt: 'draw spring', model: 'Opaque/Model.v2' } };
  const first = await native.executeNative(input);
  assert.equal(first.modelId, undefined);
  assert.equal((await native.executeNative(input)).requestId, first.requestId);
  const explicit = await native.executeNative({ ...input, callId: 'call-2', userText: 'Use `Opaque/Model.v2` to draw spring.' });
  assert.equal(explicit.modelId, 'Opaque/Model.v2');
  await assert.rejects(native.executeNative({ ...input, args: { prompt: '' } }));
  await assert.rejects(native.executeNative({ ...input, sessionId: 'chat-b', name: 'media_video_status', args: { requestId: first.requestId } }), /not recorded/);
});

test('owner file delivery supports streaming playback metadata and seeking', async () => {
  const routes = new Map(), reads = [];
  const ctx = { effect: setup => setup(), connection: { fetch: { register: route => routes.set(route.path, route) } } };
  mountMediaGenerationWeb(ctx, { artifact: async () => ({
    mimeType: 'video/mp4', bytes: 10,
    stream(range) {
      reads.push(range);
      return new Blob(['0123456789'.slice(range?.start ?? 0, range ? range.end + 1 : undefined)]).stream();
    },
  }) });
  const route = routes.get('/api/benchgo/media/artifact');
  const request = (method = 'GET', headers) => route.fetch(new Request('http://localhost/api/benchgo/media/artifact?file=movie.mp4', { method, headers }));
  assert.deepEqual(route.methods, ['GET', 'HEAD']);
  const head = await request('HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-type'), 'video/mp4');
  assert.equal(head.headers.get('content-length'), '10');
  assert.equal(head.headers.get('accept-ranges'), 'bytes');
  assert.equal(head.body, null);
  assert.deepEqual(reads, []);
  for (const [range, expected, content] of [['bytes=3-6', '3-6', '3456'], ['bytes=-2', '8-9', '89'], ['bytes=8-', '8-9', '89']]) {
    const result = await request('GET', { range });
    assert.equal(result.status, 206);
    assert.equal(result.headers.get('content-length'), String(content.length));
    assert.equal(result.headers.get('content-range'), `bytes ${expected}/10`);
    assert.equal(await result.text(), content);
  }
  const invalid = await request('GET', { range: 'bytes=10-' });
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers.get('content-range'), 'bytes */10');
  assert.equal((await request('GET', { range: 'bytes=0-2', origin: 'https://other.test' })).status, 403);
  assert.equal(reads.length, 3);
});

test('media settings and file delivery use the owner connection routes', async () => {
  const routes = new Map();
  const ctx = { effect: setup => setup(), connection: { fetch: { register: route => routes.set(route.path, route.fetch) } } };
  mountMediaGenerationWeb(ctx, {
    getSettings: async () => settings,
    updateSettings: async (next, revision) => ({ ...next, revision: revision + 1 }),
    artifact: async filename => filename === 'image.svg' ? {
      mimeType: 'image/svg+xml', bytes: 6, stream: () => new Blob(['<svg/>']).stream(),
    } : null,
  });
  const endpoint = 'http://localhost/api/benchgo/media/settings';
  const settingsRoute = routes.get(new URL(endpoint).pathname);
  assert.equal((await settingsRoute(new Request(endpoint, { headers: { origin: 'https://other.test' } }))).status, 403);
  assert.deepEqual(await (await settingsRoute(new Request(endpoint))).json(), { settings });
  const changed = await settingsRoute(new Request(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { image: { enabled: false, routes: [] } }, revision: 0 }) }));
  assert.equal((await changed.json()).settings.revision, 1);
  const file = await routes.get('/api/benchgo/media/artifact')(new Request('http://localhost/api/benchgo/media/artifact?file=image.svg'));
  assert.match(file.headers.get('content-disposition'), /^attachment/);
  assert.equal(await file.text(), '<svg/>');
});
