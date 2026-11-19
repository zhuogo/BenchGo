import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMediaGeneration } from '../src/generation.mjs';
import { createMediaGenerationSettingsAdapter } from '../src/generation-settings-adapter.mjs';
import { mountMediaGenerationWeb } from '../src/generation-web.mjs';
import { createSettingsManagement } from '../../base/src/settings-management.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lH0AAAAASUVORK5CYII=', 'base64');
const imageReply = () => Response.json({ data: [{ b64_json: png.toString('base64') }] });
const route = (modelId, providerId = 'routergo') => ({ providerId, modelId });
const setting = (...routes) => ({ enabled: true, routes });
const available = [
  { id: 'primary-image', name: 'Primary image', capabilities: ['image-generation'] },
  { id: 'second-image', name: 'Second image', capabilities: ['image-generation', 'image-edit', 'image-mask'] },
  { id: 'video-exact', name: 'Video', capabilities: ['video'], mediaConstraints: { video: { seconds: [8] } } },
  { id: 'speech-exact', name: 'Speech', capabilities: ['tts'], mediaConstraints: { tts: { response_formats: ['mp3'], voices: ['default'] } } },
];

async function fixture(t, fetcher, rows = available) {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-generation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const providers = {
    async models() { return rows; },
    async describeRoute(id, options) {
      return { baseURL: 'https://' + id + '.example/v1', protocol: 'openai-completions', ...(options.credentials ? { apiKey: 'fixture-secret' } : {}) };
    },
  };
  const create = () => createMediaGeneration({ directory, providers, fetcher });
  return { create, service: await create() };
}

test('three slots preserve category edits and ignore a stale save or old image after disable', async t => {
  const { service, create } = await fixture(t, () => { throw Error('Unexpected request'); });
  const initial = await service.getSettings();
  assert.equal(initial.image.enabled, false);
  await service.importLegacyMedia({ image: { ...route('primary-image'), size: '1024x1024' }, video: route('video-exact') });
  const migrated = await service.getSettings();
  assert.equal(migrated.image.routes[0].size, '1024x1024');
  assert.equal(migrated.video.enabled, false);
  await assert.rejects(service.updateSettings({ audio: setting(route('speech-exact')) }, initial.revision), { code: 'MEDIA_SETTINGS_STALE' });
  const next = await service.updateSettings({ image: { enabled: false, routes: [] } }, migrated.revision);
  await service.importLegacyMedia({ image: route('primary-image') });
  assert.deepEqual(await (await create()).getSettings(), next);
});

test('Agent media settings are verified by the settings manager, page reload and live routing', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-media-settings-'));
  const manager = createSettingsManagement({ directory });
  t.after(async () => { await manager.close(); await rm(directory, { recursive: true, force: true }); });
  const preferredId = 'Image/Opaque Ω';
  const speechId = 'Voice/Original';
  const requests = [];
  const generation = await createMediaGeneration({
    directory,
    providers: {
      async models() { return [...available, { id: preferredId, capabilities: ['image-generation'] }, { id: speechId, capabilities: ['tts'] }]; },
      async describeRoute() { return { baseURL: 'https://routergo.example/v1', protocol: 'openai-completions', apiKey: 'original-key' }; },
    },
    credentials: { async resolve(ref) { assert.equal(ref, 'PRIVATE_IMAGE_CREDENTIAL'); return { value: 'per-model-key' }; } },
    fetcher(url, init) {
      requests.push({ url, data: JSON.parse(init.body), auth: init.headers.authorization });
      return url.endsWith('/audio/speech') ? new Response(Buffer.from('ID3mock'), { headers: { 'content-type': 'audio/mpeg' } }) : imageReply();
    },
  });
  const routes = new Map();
  mountMediaGenerationWeb({ effect: setup => setup(), connection: { fetch: { register: handle => routes.set(handle.path, handle.fetch) } } }, generation);
  const path = '/api/benchgo/media/settings';
  const endpoint = 'http://localhost' + path;
  const get = async () => (await (await routes.get(path)(new Request(endpoint))).json()).settings;
  const save = (settings, revision) => routes.get(path)(new Request(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings, revision }) }));
  const previousImage = { ...route(preferredId), size: '1024x1024', credentialRef: 'PRIVATE_IMAGE_CREDENTIAL' };
  const untouchedVideo = { enabled: false, routes: [route('video-exact')] };
  assert.equal((await save({ image: setting(route('primary-image'), previousImage), video: untouchedVideo, audio: setting(route(speechId)) }, 0)).status, 200);
  const ref = { adapterId: 'benchgo-media-generation', namespace: 'benchgo-media-generation' };
  const owner = { kind: 'owner', id: 'human', profileId: 'media-fixture', sessionId: 'router' };
  const set = (path, value) => ({ op: 'set', path, value });
  const unset = path => ({ op: 'unset', path });
  const audioRoute = ['audio', 'routes', '0'];
  await manager.register(createMediaGenerationSettingsAdapter(generation)).ready;
  const entry = (await manager.catalog()).entries.find(row => row.adapterId === ref.adapterId);
  assert.equal(entry.schema.properties.image.properties.routes.maxItems, 3);
  assert.ok(entry.schema.properties.audio.properties.routes.items.properties.defaultVoice);
  const before = await manager.read(ref);
  assert.equal(Object.hasOwn(before.value.image.routes[1], 'credentialRef'), false);
  const voices = [{ name: 'Story/Tall', description: '  低音女声  ' }, { name: 'News/Deep', description: '明亮男声' }];
  const plan = await manager.prepare({ ...ref, expectedRevision: before.revision, ops: [
    set(['image', 'routes'], [route(preferredId), route('primary-image')]),
    set([...audioRoute, 'voices'], voices), set([...audioRoute, 'defaultVoice'], voices[1].name),
  ] }, owner);
  assert.equal(plan.requiresConfirmation, false);
  const receipt = await manager.commit(plan, owner);
  assert.equal(receipt.verified, true);
  assert.equal(receipt.application.state, 'applied');
  assert.equal(JSON.stringify(receipt).includes('PRIVATE_IMAGE_CREDENTIAL'), false);
  const current = await get();
  assert.deepEqual(current.image.routes, [previousImage, route('primary-image')]);
  assert.deepEqual(current.video, untouchedVideo);
  assert.deepEqual(current.audio.routes, [{ ...route(speechId), voices: [{ ...voices[0], description: '低音女声' }, voices[1]], defaultVoice: voices[1].name }]);

  await generation.generate({ kind: 'image', requestId: 'preferred', prompt: 'A lake' });
  await generation.generate({ kind: 'audio', requestId: 'default-voice', prompt: '你好' });
  await generation.generate({ kind: 'audio', requestId: 'named-voice', prompt: '你好', voice: voices[0].name });
  assert.deepEqual(requests.map(({ data, auth }) => [data.model, data.size, data.voice, auth]), [
    [preferredId, previousImage.size, undefined, 'Bearer per-model-key'],
    [speechId, undefined, voices[1].name, 'Bearer original-key'],
    [speechId, undefined, voices[0].name, 'Bearer original-key'],
  ]);

  const read = await manager.read(ref);
  const prepareAudio = ops => manager.prepare({ ...ref, expectedRevision: read.revision, ops }, owner);
  await assert.rejects(prepareAudio([set([...audioRoute, 'defaultVoice'], 'missing')]), /默认音色/u);
  await assert.rejects(prepareAudio([set([...audioRoute, 'credentialRef'], 'ANOTHER_KEY')]), { code: 'SETTINGS_SCHEMA_REJECTED' });
  const clear = await prepareAudio([set([...audioRoute, 'voices'], []), unset([...audioRoute, 'defaultVoice'])]);
  assert.equal((await manager.commit(clear, owner)).verified, true);
  const cleared = await get();
  assert.deepEqual(cleared.audio.routes, [route(speechId)]);
  const afterClear = await manager.read(ref);
  const stale = await manager.prepare({ ...ref, expectedRevision: afterClear.revision, ops: [set(audioRoute, { ...route(speechId), voices: [voices[1]] })] }, owner);
  assert.equal((await save({ video: setting(route('video-exact')) }, cleared.revision)).status, 200);
  await assert.rejects(manager.commit(stale, owner), { code: 'SETTINGS_CONFLICT' });
  assert.equal((await manager.read(ref)).value.video.enabled, true);
  assert.deepEqual((await get()).audio.routes, [route(speechId)]);
});

test('image safely falls back on definite refusal and persists its artifact for reloaded callers', async t => {
  const seen = [];
  const { service, create } = await fixture(t, (url, init) => {
    assert.equal(url, 'https://routergo.example/v1/images/generations');
    assert.equal(init.headers.authorization, 'Bearer fixture-secret');
    const body = JSON.parse(init.body);
    assert.equal(body.response_format, undefined);
    seen.push(body.model);
    return new Response(null, { status: 429 });
  });
  await service.updateSettings({ image: setting(route('primary-image'), route('second-image')) }, 0);
  const fixed = { kind: 'image', model: 'Primary image', prompt: 'portrait', requestId: 'explicit' };
  await assert.rejects(service.generate(fixed), { code: 'MEDIA_PROVIDER_REJECTED' });
  assert.deepEqual(seen, ['primary-image']);

  const verified = [];
  const generated = await fixture(t, (url, init) => {
    const body = JSON.parse(init.body);
    verified.push(body.model);
    return body.model === 'primary-image' ? new Response(null, { status: 429 }) : imageReply();
  });
  await generated.service.updateSettings({ image: setting(route('primary-image'), route('second-image')) }, 0);
  const input = { kind: 'image', prompt: 'portrait', requestId: 'automatic' };
  const [reply, duplicate] = await Promise.all([generated.service.generate(input), generated.service.generate(input)]);
  assert.deepEqual(duplicate, reply);
  const reopened = await generated.create();
  assert.deepEqual(await reopened.generate(input), reply);
  assert.deepEqual(verified, ['primary-image', 'second-image']);
  const artifact = await reopened.artifact(reply.filename);
  assert.equal(artifact.mimeType, 'image/png');
  assert.deepEqual(Buffer.from(await new Response(artifact.stream()).arrayBuffer()), png);
  assert.equal(await reopened.artifact('../generation.json'), null);
  assert.deepEqual(await (await create()).getSettings(), await service.getSettings());
});

test('RouterGo CDN images settle as original links without a download or duplicate submission', async t => {
  const externalUrl = 'https://pub-13fd1d3607a441b4a9d232b3a223f5f6.r2.dev/generated/testing.png?fixture=one%2Ftwo&keep=1';
  const modelId = 'gpt-image-2.6-sunburst';
  const calls = [];
  const { service, create } = await fixture(t, (url, init) => {
    calls.push({ url, method: init.method, model: JSON.parse(init.body).model });
    return Response.json({ data: [{ url: externalUrl }] });
  }, [{ id: modelId, capabilities: ['image-generation'] }]);
  await service.updateSettings({ image: setting(route(modelId)) }, 0);
  const input = { kind: 'image', prompt: 'portrait', requestId: 'cdn-image' };
  const result = await service.generate(input);
  assert.deepEqual(result, { requestId: 'cdn-image', providerId: 'routergo', modelId, status: 'completed', externalUrl, mimeType: 'image/png' });
  const reopened = await create();
  assert.deepEqual(await reopened.imageReceipt(input.requestId), result);
  assert.deepEqual(await reopened.generate(input), result);
  assert.deepEqual(calls, [{ url: 'https://routergo.example/v1/images/generations', method: 'POST', model: modelId }]);
});

test('same-origin image URLs still use an unauthenticated download and local delivery', async t => {
  const { service } = await fixture(t, (url, init) => {
    if (typeof url === 'string') return Response.json({ data: [{ url: '/generated/testing.png' }] });
    assert.equal(url.href, 'https://routergo.example/generated/testing.png');
    assert.equal(init.headers, undefined);
    assert.equal(init.redirect, 'error');
    return new Response(png);
  });
  await service.updateSettings({ image: setting(route('primary-image')) }, 0);
  const result = await service.generate({ kind: 'image', prompt: 'portrait', requestId: 'local-image' });
  assert.equal(result.mimeType, 'image/png');
  assert.equal(result.externalUrl, undefined);
  assert.ok(await service.artifact(result.filename));
});

test('unsafe image URLs remain unconfirmed without download or fallback', async t => {
  const calls = [];
  const { service } = await fixture(t, (url, init) => {
    calls.push({ url, method: init.method });
    return Response.json({ data: [{ url: 'http://127.0.0.1/generated/testing.png' }] });
  });
  await service.updateSettings({ image: setting(route('primary-image'), route('second-image')) }, 0);
  const input = { kind: 'image', prompt: 'portrait', requestId: 'unsafe-image' };
  await assert.rejects(service.generate(input), { code: 'MEDIA_IMAGE_URL_INVALID' });
  assert.equal(await service.imageReceipt(input.requestId), null);
  await assert.rejects(service.generate(input), { code: 'MEDIA_SUBMISSION_UNCERTAIN' });
  assert.deepEqual(calls, [{ url: 'https://routergo.example/v1/images/generations', method: 'POST' }]);
});

test('duplicate display names require a provider and opaque IDs remain unchanged', async t => {
  const seen = [];
  const rows = [{ id: 'Image/Opaque Ω', name: 'Reference model', capabilities: ['image-generation'] }];
  const { service } = await fixture(t, (url, init) => {
    seen.push({ url, id: JSON.parse(init.body).model });
    return imageReply();
  }, rows);
  await service.updateSettings({ image: setting(route(rows[0].id), route(rows[0].id, 'another')) }, 0);
  const args = { kind: 'image', prompt: 'portrait', requestId: 'name-match', model: 'Reference model' };
  await assert.rejects(service.generate(args), { code: 'MEDIA_MODEL_AMBIGUOUS' });
  await service.generate({ ...args, providerId: 'another' });
  assert.deepEqual(seen, [{ url: 'https://another.example/v1/images/generations', id: rows[0].id }]);
});

test('editing keeps references and PNG mask while skipping incompatible slots', async t => {
  const { service } = await fixture(t, async (url, init) => {
    assert.match(url, /\/images\/edits$/u);
    assert.equal(init.body.get('model'), 'second-image');
    assert.equal(init.body.getAll('image[]').length, 2);
    assert.deepEqual(Buffer.from(await init.body.get('mask').arrayBuffer()), png);
    assert.equal(init.headers['content-type'], undefined);
    return imageReply();
  });
  await service.updateSettings({ image: setting(route('primary-image'), route('second-image')) }, 0);
  const reference = new Blob([png]);
  const args = { kind: 'image', operation: 'edit', requestId: 'edit', prompt: 'change the sky', reference: [reference, reference], mask: reference };
  assert.equal((await service.generate(args)).modelId, 'second-image');
  await assert.rejects(service.generate({ ...args, requestId: 'unsupported-model', model: 'primary-image' }), /模型未标记/u);
  await assert.rejects(service.generate({ ...args, prompt: 'change a different region' }), { code: 'MEDIA_REQUEST_CONFLICT' });
});

test('unknown submission survives a restart and never falls through', async t => {
  let requests = 0;
  const { service, create } = await fixture(t, () => {
    requests++;
    throw Error('connection closed');
  });
  await service.updateSettings({ image: setting(route('primary-image'), route('second-image')) }, 0);
  const args = { kind: 'image', prompt: 'portrait', requestId: 'uncertain' };
  await assert.rejects(service.generate(args), { code: 'MEDIA_SUBMISSION_UNCERTAIN' });
  await assert.rejects((await create()).generate(args), { code: 'MEDIA_SUBMISSION_UNCERTAIN' });
  assert.equal(requests, 1);
});

test('video persists one job and retries a failed download through that job after reopen', async t => {
  const seen = [];
  const { service, create } = await fixture(t, (url, init) => {
    const path = new URL(url).pathname;
    seen.push(path);
    if (path === '/v1/videos') {
      assert.equal(init.method, 'POST');
      assert.equal(init.body.get('seconds'), '8');
      assert.equal(init.body.get('input_reference').type, 'image/png');
      return Response.json({ id: 'job-1', status: 'queued' });
    }
    if (path === '/v1/videos/job-1') return Response.json({ id: 'job-1', status: 'completed', progress: 100 });
    if (seen.length === 3) return new Response(null, { status: 503 });
    return new Response(Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]), { headers: { 'content-type': 'video/mp4' } });
  });
  await service.updateSettings({ video: setting(route('video-exact')) }, 0);
  const args = { kind: 'video', prompt: 'move camera', requestId: 'video-1', seconds: 8, reference: new Blob([png]) };
  await assert.rejects(service.generate({ ...args, seconds: 4 }), /时长/u);
  const submitted = await service.generate(args);
  assert.equal(submitted.status, 'queued');
  const reopened = await create();
  assert.deepEqual(await reopened.videoReceipt(args.requestId), submitted);
  await assert.rejects(reopened.videoStatus({ requestId: args.requestId }), { code: 'MEDIA_DOWNLOAD_FAILED' });
  assert.equal((await reopened.videoStatus({ requestId: args.requestId })).status, 'completed');
  assert.equal((await reopened.generate(args)).status, 'completed');
  assert.deepEqual(seen, ['/v1/videos', '/v1/videos/job-1', '/v1/videos/job-1/content', '/v1/videos/job-1/content']);
});

test('speech validates output format and returns a downloadable artifact', async t => {
  const { service } = await fixture(t, (url, init) => {
    assert.match(url, /\/audio\/speech$/u);
    assert.deepEqual(JSON.parse(init.body), { model: 'speech-exact', input: '你好', voice: 'default', response_format: 'mp3' });
    return new Response(Buffer.from('ID3mock'), { headers: { 'content-type': 'audio/mpeg' } });
  });
  await service.updateSettings({ audio: setting(route('speech-exact')) }, 0);
  const args = { kind: 'audio', prompt: '你好', requestId: 'spoken' };
  await assert.rejects(service.generate({ ...args, format: 'wav' }), /输出格式/u);
  const result = await service.generate(args);
  assert.equal(result.mimeType, 'audio/mpeg');
  const artifact = await service.artifact(result.filename);
  assert.equal(await new Response(artifact.stream()).text(), 'ID3mock');
});

test('speech preserves configured voice across reloads and sends the exact requested voice', async t => {
  const voices = [];
  const model = { id: 'speech-no-voices', capabilities: ['tts'], mediaConstraints: { tts: { response_formats: ['mp3'] } } };
  const { service, create } = await fixture(t, (_url, init) => {
    voices.push(JSON.parse(init.body).voice);
    return new Response(Buffer.from('ID3mock'), { headers: { 'content-type': 'audio/mpeg' } });
  }, [model]);
  const selected = { ...route(model.id), voice: 'MiMo/Story-v2' };
  await service.updateSettings({ audio: setting(selected) }, 0);
  const reopened = await create();
  const image = setting(route('unchanged-image'));
  await reopened.updateSettings({ image }, 1);
  const migrated = { ...route(model.id), voices: [{ name: 'MiMo/Story-v2' }], defaultVoice: 'MiMo/Story-v2' };
  assert.deepEqual((await reopened.getSettings()).audio.routes, [migrated]);
  const args = { kind: 'audio', prompt: '你好' };
  await reopened.generate({ ...args, requestId: 'configured' });
  await reopened.generate({ ...args, requestId: 'explicit', voice: 'MiMo/Voice-v3' });
  await assert.rejects(reopened.updateSettings({ audio: setting({ ...selected, voice: ' invalid ' }) }, 2), /音色名称/u);
  const cleared = await reopened.updateSettings({ audio: setting({ ...selected, voice: '' }) }, 2);
  assert.deepEqual(cleared.audio.routes, [route(model.id)]);
  assert.deepEqual(cleared.image, image);
  await assert.rejects(reopened.generate({ ...args, requestId: 'missing-voice' }), /填写音色名称/u);
  assert.deepEqual(voices, ['MiMo/Story-v2', 'MiMo/Voice-v3']);
});

test('speech uses the saved default and only admits configured choices from the assistant', async t => {
  const submissions = [];
  const model = { id: 'speech-no-voices', capabilities: ['tts'] };
  const { service, create } = await fixture(t, (_url, init) => {
    submissions.push(JSON.parse(init.body));
    return new Response(Buffer.from('ID3mock'), { headers: { 'content-type': 'audio/mpeg' } });
  }, [model]);
  const voices = [{ name: 'Story', description: '低音女声' }, { name: 'News', description: '明亮男声' }];
  const configured = { ...route(model.id), voices, defaultVoice: 'News' };
  await assert.rejects(service.updateSettings({ audio: setting({ ...configured, defaultVoice: 'missing' }) }, 0), /默认音色/u);
  await service.updateSettings({ audio: setting(configured) }, 0);
  const reopened = await create();
  assert.deepEqual((await reopened.getSettings()).audio.routes, [configured]);
  const args = { prompt: '你好', kind: 'audio' };
  await reopened.generate({ ...args, requestId: 'default' });
  await reopened.generate({ ...args, requestId: 'selected', configuredVoice: 'Story' });
  await assert.rejects(reopened.generate({ ...args, requestId: 'invented', configuredVoice: 'missing' }), { code: 'MEDIA_VOICE_NOT_CONFIGURED' });
  assert.deepEqual(submissions, ['News', 'Story'].map(voice => ({ model: model.id, input: args.prompt, response_format: 'mp3', voice })));
});

test('speech rejects an unlisted voice before posting to the provider', async t => {
  let submissions = 0;
  const { service } = await fixture(t, () => { submissions++; throw Error('Unexpected request'); });
  await service.updateSettings({ audio: setting({ ...route('speech-exact'), voice: 'alloy' }) }, 0);
  await assert.rejects(service.generate({ kind: 'audio', prompt: '你好', requestId: 'unlisted' }), {
    code: 'MEDIA_VOICE_INVALID', message: /alloy.*不在.*音色列表/u,
  });
  assert.equal(submissions, 0);
});

test('speech reports provider voice errors without guessing or resubmitting', async t => {
  const statuses = new Map([['definite', 422], ['ambiguous', 502]]);
  const submissions = [];
  const model = { id: 'speech-no-voices', capabilities: ['tts'] };
  const { service, create } = await fixture(t, (_url, init) => {
    const { voice, input } = JSON.parse(init.body);
    submissions.push(voice);
    return Response.json({ error: { param: 'voice', message: 'internal upstream detail' } }, { status: statuses.get(input) });
  }, [model]);
  await service.updateSettings({ audio: setting(
    { ...route(model.id), voice: 'Bad/Voice' },
    { ...route(model.id, 'backup'), voice: 'Backup/Voice' },
  ) }, 0);
  for (const [prompt, code] of [['definite', 'MEDIA_VOICE_INVALID'], ['ambiguous', 'MEDIA_SUBMISSION_UNCERTAIN']]) {
    const args = { kind: 'audio', prompt, requestId: prompt };
    const message = prompt === 'definite' ? /音色「Bad\/Voice」.*HTTP 422/u : /音色「Bad\/Voice」.*HTTP 502.*请勿自动重新生成/u;
    for (const active of [service, await create()]) {
      await assert.rejects(active.generate(args), error => {
        assert.equal(error.code, code);
        assert.match(error.message, message);
        assert.doesNotMatch(error.message, /internal upstream detail/u);
        return true;
      });
    }
  }
  assert.deepEqual(submissions, ['Bad/Voice', 'Bad/Voice']);
});
