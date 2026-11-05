import test from 'node:test';
import assert from 'node:assert/strict';
import { generatedMediaDraft, generatedMediaPatch, voiceSettingsPatch } from '../client/settings-state.mjs';

test('image and video edits send only their changed selection and preserve opaque IDs', () => {
  for (const kind of ['image', 'video']) {
    const original = { providerId: 'Cloud/@01', modelId: 'Exact Model:02', protocol: 'provider/custom', size: 'large', quality: 'high', credentialRef: 'PRIVATE_REF' };
    const draft = { ...generatedMediaDraft(original), modelId: 'Exact Model:03' };
    assert.deepEqual(generatedMediaPatch(kind, draft, original), { [kind]: { modelId: 'Exact Model:03' } });
    assert.deepEqual(generatedMediaPatch(kind, { ...draft, providerId: 'Cloud/@02' }, original), { [kind]: { providerId: 'Cloud/@02', modelId: 'Exact Model:03', credentialRef: '' } });
    assert.deepEqual(generatedMediaPatch(kind, { ...draft, enabled: false }, original), { [kind]: null });
    assert.throws(() => generatedMediaPatch(kind, { ...draft, modelId: ' Exact Model:03' }, original), /首尾/);
    assert.throws(() => generatedMediaPatch(kind, { ...draft, providerId: '' }, original), /供应商/);
  }
});

test('enabling an unconfigured media model requires an exact provider/model pair', () => {
  const draft = generatedMediaDraft(null);
  assert.equal(draft.enabled, false);
  assert.throws(() => generatedMediaPatch('image', { ...draft, enabled: true }, null), /供应商/);
  assert.deepEqual(generatedMediaPatch('image', { ...draft, enabled: true, providerId: 'p', modelId: 'Image:001' }, null), { image: { providerId: 'p', modelId: 'Image:001', protocol: 'openai-compatible' } });
});

test('editing one voice setting does not overwrite another endpoint or unrelated toggles', () => {
  const original = { dictation: true, readAloud: false, call: false, asr: { providerId: 'cloud', baseURL: '', apiKey: '', model: 'Exact ASR:02', protocol: 'openai-websocket', realtime: { url: '', query: { route: 'opaque.02' } } }, tts: { providerId: '', baseURL: 'https://speech.test/v1', apiKey: '', model: 'Exact TTS:03', protocol: 'speech', speed: 1.2 } };
  assert.deepEqual(voiceSettingsPatch({ ...original, dictation: false }, original), { dictation: false });
  assert.deepEqual(voiceSettingsPatch({ ...original, tts: { ...original.tts, speed: 1.65 } }, original), { tts: { speed: 1.65 } });
  assert.deepEqual(voiceSettingsPatch({ ...original, asr: { ...original.asr, model: 'Exact ASR:04' } }, original), { asr: { model: 'Exact ASR:04' } });
  assert.deepEqual(voiceSettingsPatch(original, original, { tts: true }), { tts: { apiKey: '' } });
  assert.deepEqual(voiceSettingsPatch(original, original, { asr: true }), {});
});

test('voice stream choice round-trips without overwriting IDs, keys or routes', () => {
  const original = { asr: { protocol: 'openai-websocket', model: 'ASR/@01', realtime: { query: { route: 'private.02' } } }, tts: { protocol: 'speech', model: 'TTS/@01', apiKey: '', voice: 'Exact Voice', stream: true } };
  const draft = { ...original, tts: { ...original.tts, stream: false } };
  const patch = voiceSettingsPatch(draft, original);
  assert.deepEqual(patch, { tts: { stream: false } });
  const saved = { ...original, tts: { ...original.tts, ...patch.tts } };
  assert.deepEqual(voiceSettingsPatch(saved, saved), {});
  const legacy = { ...original, asr: { ...original.asr, protocol: 'unknown.route' } };
  assert.throws(() => voiceSettingsPatch(legacy, legacy), /显式选择/);
  assert.deepEqual(voiceSettingsPatch({ ...legacy, asr: { ...legacy.asr, protocol: 'transcriptions' } }, legacy), { asr: { protocol: 'transcriptions' } });
});
