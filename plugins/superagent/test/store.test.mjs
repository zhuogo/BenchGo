import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantStore } from '../src/store.mjs';

async function fixture(t) {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'assistant-store-'));
  const stores = [];
  const openStore = async () => { const store = await createAssistantStore({ dataDirectory }); stores.push(store); return store; };
  t.after(async () => { for (const store of stores) store.close(); await rm(dataDirectory, { recursive: true, force: true }); });
  return { dataDirectory, store: await openStore(), openStore };
}

test('legacy side-chat model overrides are removed durably without losing conversation state', async t => {
  const { store, openStore } = await fixture(t);
  const state = await store.getState();
  await writeFile(store.paths.state, JSON.stringify({ ...state, threads: [{ id: 'side', sessionId: 'kept', title: 'Topic', pinned: true, models: [{ providerId: 'legacy', modelId: 'old' }] }] }));
  const reopened = await openStore();
  const next = await reopened.getState();
  assert.deepEqual(next.threads, [{ id: 'side', sessionId: 'kept', title: 'Topic', pinned: true }]);
  assert.equal(next.revision, state.revision + 1);
  assert.equal('models' in JSON.parse(await readFile(store.paths.state, 'utf8')).threads[0], false);
  const saved = await reopened.updateState({ threads: [{ ...next.threads[0], models: [{ providerId: 'stale', modelId: 'stale' }] }] });
  assert.equal('models' in saved.threads[0], false);
});
test('independent configuration survives restart and preserves opaque models and unrelated fields', async (t) => {
  const { store, openStore } = await fixture(t);
  assert.ok((await stat(store.paths.workspace)).isDirectory());
  const models = [{ providerId: 'provider/@x', modelId: 'Exact Model:07', options: { reasoningEffort: 'custom-value' } }];
  await store.updateConfig({ models, tts: { providerId: 'voice', modelId: 'Exact TTS:07', credentialRef: 'PRIVATE_REF', voice: 'A' } }, { revision: 0 });
  await store.updateConfig({ tts: { voice: 'B' }, image: { providerId: 'image', modelId: 'image-v2' } });
  const restarted = await openStore();
  const result = await restarted.getConfig();
  assert.deepEqual(result.models, models);
  assert.deepEqual(result.tts, { providerId: 'voice', modelId: 'Exact TTS:07', credentialRef: 'PRIVATE_REF', voice: 'B' });
  assert.equal(result.image.modelId, 'image-v2');
  assert.equal(result.revision, 2);
  await assert.rejects(store.updateConfig({ asr: { apiKey: 'secret' } }), /credentialRef/);
  assert.equal((await store.getConfig()).revision, 2);
});
test('session context survives store restart and new sessions receive current documents', async t => {
  const { store, openStore } = await fixture(t);
  const identity = 'frozen identity ' + 'x'.repeat(13000);
  await store.updateProfile({ identity });
  const original = await store.getSessionContext('session-a');
  original.documents[0].content = 'caller mutation';
  await store.updateProfile({ identity: 'changed identity' });
  store.close();
  const restarted = await openStore();
  const restored = await restarted.getSessionContext('session-a');
  assert.equal(restored.documents.find(row => row.name === 'IDENTITY.md').content, identity);
  assert.notEqual(restored.documents[0].content, 'caller mutation');
  assert.equal((await restarted.getSessionContext('session-b')).documents.find(row => row.name === 'IDENTITY.md').content, 'changed identity');
  const [a, b] = await Promise.all([restarted.getSessionContext('session-c'), restarted.getSessionContext('session-c')]);
  assert.deepEqual(a, b);
});
test('concurrent stores serialize edits and reject stale revisions without partial files', async (t) => {
  const { store, openStore } = await fixture(t);
  const other = await openStore();
  const results = await Promise.allSettled([store.updateConfig({ name: 'A' }, { revision: 0 }), other.updateConfig({ name: 'B' }, { revision: 0 })]);
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(results.find((item) => item.status === 'rejected').reason.code, 'REVISION_CONFLICT');
  await Promise.all([store.updateConfig({ image: { providerId: 'images', modelId: 'image' } }), other.updateConfig({ asr: { providerId: 'voice', modelId: 'asr' } })]);
  assert.equal((await store.getConfig()).asr.modelId, 'asr');
  await assert.rejects(store.updateConfig({ asr: { language: 'zh' } }), /不支持/);
  await assert.rejects(store.updateConfig({ models: [{ providerId: 'p', modelId: 'm', options: { temperature: 1 } }] }), /不支持/);
  assert.equal((await store.getConfig()).image.modelId, 'image');
  assert.ok(!(await readdir(store.paths.directory)).some((name) => name.endsWith('.tmp')));
});

test('HTML name cards survive reload independently of names and opaque model settings', async t => {
  const { store, openStore } = await fixture(t);
  assert.equal((await store.getConfig()).cardHtml, null);
  const models = [{ providerId: 'provider/@x', modelId: 'Exact Model:07', options: { reasoningEffort: 'custom-value' } }];
  const html = '<span style="font-family:cursive;color:#ca2563">My assistant</span>';
  await store.updateConfig({ name: 'Display name', models, tts: { providerId: 'voice', modelId: 'Exact TTS:07', voice: 'A' } });
  await store.updateConfig({ cardHtml: html });
  const restarted = await openStore();
  const config = await restarted.getConfig();
  assert.equal(config.cardHtml, html);
  assert.equal(config.name, 'Display name');
  assert.deepEqual(config.models, models);
  assert.deepEqual(config.tts, { providerId: 'voice', modelId: 'Exact TTS:07', voice: 'A' });
  await restarted.updateConfig({ name: 'New name' });
  assert.equal((await store.getConfig()).cardHtml, html);
  for (const cardHtml of [false, 1, [], {}, 'x'.repeat(16001)]) await assert.rejects(store.updateConfig({ cardHtml }), /Invalid/);
  assert.equal((await store.getConfig()).cardHtml, html);
  await store.updateConfig({ cardHtml: 'x'.repeat(16000) });
  await store.updateConfig({ cardHtml: '' });
  assert.equal((await restarted.getConfig()).cardHtml, null);
  await restarted.updateConfig({ cardHtml: null });
  const legacy = await store.getConfig();
  delete legacy.cardHtml;
  await writeFile(store.paths.config, JSON.stringify(legacy));
  assert.equal((await (await openStore()).getConfig()).cardHtml, null);
  assert.deepEqual((await store.updateConfig({ cardHtml: html })).models, models);
});

test('card motion migrates, persists independently and rejects invalid or stale edits', async t => {
  const { store, openStore } = await fixture(t);
  const original = await store.getConfig();
  assert.equal(original.cardMotion, true);
  const legacy = { ...original, cardHtml: '  \n ' };
  delete legacy.cardMotion;
  await writeFile(store.paths.config, JSON.stringify(legacy));
  const migrated = await (await openStore()).getConfig();
  assert.equal(migrated.cardMotion, true);
  assert.equal(migrated.cardHtml, null);
  const saved = await store.updateConfig({ cardMotion: false, cardHtml: '<b>Card</b>' }, { revision: migrated.revision });
  assert.equal((await (await openStore()).getConfig()).cardMotion, false);
  for (const cardMotion of [null, 0, 'false', {}]) await assert.rejects(store.updateConfig({ cardMotion }), /Invalid assistant cardMotion/);
  await assert.rejects(store.updateConfig({ cardMotion: true }, { revision: migrated.revision }), { code: 'REVISION_CONFLICT' });
  assert.deepEqual(await store.getConfig(), saved);
  const reset = await store.updateConfig({ cardHtml: '\n\t ' });
  assert.equal(reset.cardHtml, null);
  assert.equal(reset.cardMotion, false);
});

test('media requires full references, duplicate models and dangerous nested keys are rejected without saving', async t => {
  const { store } = await fixture(t);
  for (const field of ['image', 'video', 'tts', 'asr']) {
    await assert.rejects(store.updateConfig({ [field]: { modelId: 'only-model' } }), /providerId/);
    await store.updateConfig({ [field]: { providerId: 'p', modelId: 'exact-model' } });
    await store.updateConfig({ [field]: null });
    assert.equal((await store.getConfig())[field], null);
  }
  const revision = (await store.getConfig()).revision;
  await assert.rejects(store.updateConfig({ models: [{ providerId: 'p', modelId: 'm' }, { providerId: 'p', modelId: 'm' }] }), /Duplicate/);
  await assert.rejects(store.updateConfig({ models: [{ providerId: 'p', modelId: ' m' }] }), /modelId/);
  await assert.rejects(store.updateConfig({ models: [{ providerId: 'p', modelId: 'm'.repeat(513) }] }), /modelId/);
  await assert.rejects(store.updateConfig(JSON.parse('{"models":[{"providerId":"p","modelId":"m","options":{"__proto__":{"polluted":true}}}]}')), /field/);
  assert.equal((await store.getConfig()).revision, revision);
  assert.equal({}.polluted, undefined);
});

test('video selection migrates legacy configs and preserves image/model settings without exporting credentials', async t => {
  const { store, openStore } = await fixture(t);
  const config = await store.getConfig();
  delete config.video;
  await writeFile(store.paths.config, JSON.stringify(config));
  assert.equal((await store.getConfig()).video, null);
  const image = { providerId: 'images/@main', modelId: 'Exact Image:07', protocol: 'openai-compatible', size: '1536x1024' };
  const video = { providerId: 'video/@cloud', modelId: 'Exact Video:08', protocol: 'provider-protocol', credentialRef: 'VIDEO_REF' };
  await store.updateConfig({ image, video, models: [{ providerId: 'text', modelId: 'Exact Text:09' }] });
  await store.updateConfig({ video: { modelId: 'Exact Video:10' } });
  const restarted = await openStore();
  const result = await restarted.getConfig();
  assert.deepEqual(result.image, image);
  assert.deepEqual(result.video, { ...video, modelId: 'Exact Video:10' });
  assert.equal(result.models[0].modelId, 'Exact Text:09');
  assert.equal((await store.profileExport()).config.video.credentialRef, undefined);
  await assert.rejects(store.updateConfig({ video: { apiKey: 'private' } }), /credentialRef/);
  await assert.rejects(store.updateConfig({ video: { modelId: ' Exact Video:10' } }), /modelId/);
});
test('profiles, thread metadata and explicit memories persist and corrected/deleted memories disappear', async (t) => {
  const { store, openStore } = await fixture(t);
  await store.updateProfile({ identity: 'Assistant identity', user: 'User facts' });
  await store.updateProfile({ identity: 'Corrected identity' });
  await store.updateState({ mainSessionId: 'main', threads: [{ id: 'side', sessionId: 's1' }] }, { revision: 0 });
  const entry = await store.saveMemory({ content: 'Old preference', source: { sessionId: 's1', messageId: 'm1' } });
  await assert.rejects(store.saveMemory({ ...entry, content: 'Conflict' }, { revision: 0 }), /reload/);
  await store.saveMemory({ ...entry, content: 'New preference' }, { revision: 1 });
  const restarted = await openStore();
  assert.deepEqual(await restarted.getProfile(), { identity: 'Corrected identity', user: 'User facts' });
  assert.equal((await restarted.getState()).mainSessionId, 'main');
  assert.equal((await restarted.listMemories())[0].content, 'New preference');
  assert.equal((await restarted.listMemories())[0].source.messageId, 'm1');
  await restarted.deleteMemory(entry.id, { revision: 2 });
  assert.deepEqual(await store.listMemories(), []);
  assert.ok(!(await readFile(join(store.paths.memory, 'entries.json'), 'utf8')).includes('Old preference'));
});

test('runtime freezes five ordered documents while management preserves six', async t => {
  const { store } = await fixture(t);
  const context = await store.getContext();
  assert.deepEqual(context.documents.map(row => row.name), [
    'SOUL.md', 'IDENTITY.md', 'USER.md', 'AGENTS.md', 'MEMORY.md',
  ]);
  assert.equal((await store.documents.list()).length, 6);
  assert.equal((await store.profileExport()).documents.length, 6);
  assert.equal(context.memories.length, 0);
  assert.equal(context.learning.enabled, true);
  assert.ok(context.hashes['MEMORY.md']);
});

test('assistant runtime context excludes memories blocked by learning policy', async t => {
  const { store } = await fixture(t);
  const secret = '不要把这条私人电话注入助手上下文';
  await store.saveMemory({ content: secret, source: { type: 'user-edit', messageId: 'privacy-1' } });
  await store.memory.configureLearning({ excludedTerms: ['私人电话'] });

  const context = await store.getContext();
  assert.equal(context.memories.some(entry => entry.content.includes(secret)), false);
  assert.doesNotMatch(context.documents.find(row => row.name === 'MEMORY.md').content, /私人电话/u);
  assert.deepEqual(context.learning.excludedTerms, ['私人电话']);

  // The management projection remains available for explicit correction or
  // deletion; only the runtime context is privacy-filtered.
  assert.equal((await store.listMemories()).some(entry => entry.content.includes(secret)), true);
});

test('profile import rejects duplicate or missing authoritative documents', async t => {
  const { store } = await fixture(t);
  const bundle = await store.profileExport();
  bundle.documents[5] = { ...bundle.documents[0], name: bundle.documents[0].name };
  await assert.rejects(store.profileImport(bundle), /恰好包含六份不同/u);
  assert.deepEqual((await store.getContext()).documents.map(row => row.name), [
    'SOUL.md', 'IDENTITY.md', 'USER.md', 'AGENTS.md', 'MEMORY.md',
  ]);
});

