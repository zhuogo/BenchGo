import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantStore } from '../src/store.mjs';
import { createAssistantSettingsAdapter } from '../src/settings-adapter.mjs';
import { createConnectionSettingsAdapter } from '../src/connection-settings-adapter.mjs';
import { VoiceConfig } from '../../voice/src/config.mjs';
import { createVoiceSettingsAdapter } from '../../voice/src/settings-adapter.mjs';
import { applySettingsOps } from '../../benchgo/shared/settings-adapter-utils.mjs';

async function directory(t) { const path = await mkdtemp(join(tmpdir(), 'benchgo-settings-adapters-')); t.after(() => rm(path, { recursive: true, force: true })); return path; }
const set = (path, value) => ({ op: 'set', path, value });
const expected = snapshot => ({ fingerprint: snapshot.fingerprint, ...(snapshot.revision === undefined ? {} : { revision: snapshot.revision }) });

test('Voice CAS stays inside original queue and redacts/rejects secret edits while retaining opaque model IDs', async t => {
  const store = await new VoiceConfig({ dataDir: await directory(t) }).open();
  await store.configure({ tts: { baseURL: 'https://voice.invalid/v1', apiKey: 'private-voice-key', model: 'opaque:Model/Case' } });
  const adapter = createVoiceSettingsAdapter(store), notifications = [];
  const dispose = adapter.subscribe(value => notifications.push(value)); t.after(dispose);
  let current = await adapter.read('benchgo-voice');
  assert.ok(!JSON.stringify(current).includes('private-voice-key'));
  assert.equal(current.value.tts.apiKey, undefined);
  assert.equal(current.secrets.find(item => item.path[0] === 'tts').set, true);
  const saved = await adapter.apply('benchgo-voice', { ops: [set(['tts', 'speed'], 1.35)], expected: expected(current) });
  assert.equal(saved.application.state, 'applied');
  assert.equal(store.value.tts.apiKey, 'private-voice-key');
  assert.equal(store.value.tts.model, 'opaque:Model/Case');
  assert.equal(notifications.length, 1);
  await assert.rejects(adapter.apply('benchgo-voice', { ops: [set(['tts', 'apiKey'], 'rejected')], expected: expected(saved) }), { code: 'SETTINGS_PATH_BLOCKED' });
  await assert.rejects(adapter.apply('benchgo-voice', { ops: [set(['tts'], { model: 'opaque' })], expected: expected(saved) }), { code: 'SETTINGS_PATH_BLOCKED' });
  current = await adapter.read('benchgo-voice');
  const legacy = store.configure({ dictation: true });
  await assert.rejects(adapter.apply('benchgo-voice', { ops: [set(['readAloud'], true)], expected: expected(current) }), { code: 'REVISION_CONFLICT' });
  await legacy;
  current = await adapter.read('benchgo-voice');
  await adapter.apply('benchgo-voice', { ops: [{ op: 'unset', path: ['tts', 'speed'] }], expected: expected(current) });
  assert.equal(store.value.tts.speed, 1.2);
});

test('Assistant and all registered Connections share original stores, model identity, document hash CAS and policy transactions', async t => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'benchgo-settings-assistant-'));
  const store = await createAssistantStore({ dataDirectory }); t.after(() => { store.close(); return rm(dataDirectory, { recursive: true, force: true }); });
  const adapter = createAssistantSettingsAdapter(store, { applyConfig: ({ ops, expected, signal }) => store.updateConfig({}, { settingsOps: ops, expected, signal }) });
  const events = []; const dispose = adapter.subscribe(event => events.push(event)); t.after(dispose);
  let current = await adapter.read('superagent');
  let saved = await adapter.apply('superagent', { ops: [set(['models'], [{ providerId: 'Provider:Opaque', modelId: 'Model/Case:Exact' }]), set(['name'], '本地助手')], expected: expected(current) });
  assert.equal(saved.application.state, 'applied');
  assert.equal((await store.getConfig()).models[0].modelId, 'Model/Case:Exact');
  assert.match((await store.documents.read('IDENTITY.md')).content, /本地助手/u);
  await assert.rejects(adapter.apply('superagent', { ops: [set(['name'], '迟到覆盖')], expected: expected(current) }), { code: 'REVISION_CONFLICT' });
  await assert.rejects(adapter.apply('superagent', { ops: [set(['pet'], null)], expected: expected(saved) }), { code: 'SETTINGS_PATH_BLOCKED' });
  current = await adapter.read('superagent-learning');
  saved = await adapter.apply('superagent-learning', { ops: [set(['enabled'], false), set(['excludedTerms'], ['私人主题'])], expected: expected(current) });
  assert.equal(saved.value.enabled, false);
  await assert.rejects(adapter.apply('superagent-learning', { ops: [set(['enabled'], true)], expected: expected(current) }), { code: 'REVISION_CONFLICT' });
  assert.equal((await store.memory.learning()).excludedTerms[0], '私人主题');
  assert.deepEqual((await adapter.schema()).map(row => row.namespace), ['superagent', 'superagent-learning']);
  await assert.rejects(adapter.read('superagent-skills-policy'), /未知总助手设置/);
  assert.ok(events.some(event => event.namespace === 'superagent-learning'));
  const connections = createConnectionSettingsAdapter(store.connections, { applyConfig: args => ({ ...store.connections.update({}, args), application: { state: 'pending', reason: '真实渠道仍在连接' } }) });
  assert.equal((await connections.schema()).length, store.connections.list().length);
  current = await connections.read('superagent-connections:feishu');
  saved = await connections.apply('superagent-connections:feishu', { ops: [set(['appId'], 'Opaque:App/Case')], expected: expected(current) });
  assert.equal(saved.value.appId, 'Opaque:App/Case');
  assert.equal(saved.application.state, 'pending');
  await assert.rejects(connections.apply('superagent-connections:feishu', { ops: [set(['appId'], 'stale')], expected: expected(current) }), { code: 'REVISION_CONFLICT' });
});

test('adapter operations reject prototype paths and avoid mutating original input', () => {
  const value = { keep: { enabled: true } };
  assert.throws(() => applySettingsOps(value, [set(['constructor', 'prototype'], true)]));
  assert.deepEqual(applySettingsOps(value, [{ op: 'unset', path: ['absent', 'enabled'] }]), value);
  assert.deepEqual(value, { keep: { enabled: true } });
});
