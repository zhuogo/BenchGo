import test from 'node:test';
import assert from 'node:assert/strict';
import { generatedMediaDraft, generatedMediaPatch, voiceSettingsPatch, listeningDraft } from '../client/settings-state.mjs';

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

test('streaming synthesis protocol switches without changing endpoint or playback choices', () => {
  const original = { dictation: true, readAloud: true, call: false, asr: { protocol: 'transcriptions-sse', model: 'ASR/@01' }, tts: { providerId: 'Cloud/@01', baseURL: 'https://speech.test/v1', protocol: 'speech', model: 'TTS/@01', voice: 'Voice:02', speed: 1.35, stream: false, apiKey: '' } };
  const draft = { ...original, tts: { ...original.tts, protocol: 'speech-stream' } };
  const patch = voiceSettingsPatch(draft, original);
  assert.deepEqual(patch, { tts: { protocol: 'speech-stream' } });
  const saved = { ...original, tts: { ...original.tts, ...patch.tts } };
  assert.deepEqual(saved.tts, draft.tts);
  assert.deepEqual(voiceSettingsPatch(saved, saved), {});
  assert.deepEqual(voiceSettingsPatch(original, saved), { tts: { protocol: 'speech' } });
  assert.throws(() => voiceSettingsPatch({ ...draft, tts: { ...draft.tts, protocol: 'unknown.speech' } }, original), /显式选择/);
});

test('conversation model edits preserve media config, exact IDs and explicit clearing', () => {
  const original = { dictation: true, readAloud: true, call: true, asr: { protocol: 'transcriptions-sse', model: 'ASR/@01' }, tts: { protocol: 'speech-stream', model: 'TTS/@01', voice: 'voice', speed: 1.5 }, conversation: { providerId: 'Cloud/@01', model: 'Exact Model:02' } };
  assert.deepEqual(voiceSettingsPatch({ ...original, conversation: { ...original.conversation, model: 'Exact Model:03' } }, original), { conversation: { model: 'Exact Model:03' } });
  assert.deepEqual(voiceSettingsPatch({ ...original, conversation: { providerId: '', model: '' } }, original), { conversation: { providerId: '', model: '' } });
  assert.deepEqual(voiceSettingsPatch({ ...original, tts: { ...original.tts, speed: 1.65 } }, original), { tts: { speed: 1.65 } });
  for (const conversation of [{ providerId: 'Cloud/@01', model: '' }, { providerId: '', model: 'Exact Model:02' }]) assert.throws(() => voiceSettingsPatch({ ...original, conversation }, original), /同时选择/);
  assert.throws(() => voiceSettingsPatch({ ...original, conversation: { providerId: 'Cloud/@01', model: ' Exact Model:02' } }, original), /首尾/);
});

test('explicit matched protocols preserve opaque selections and omit server detection metadata', () => {
  const original = { asr: { apiType: '', protocol: '', model: 'Unknown Step/@raw' }, tts: { apiType: '', protocol: '', model: 'TTS/@raw' } };
  const draft = { ...original, asr: { ...original.asr, resolvedProtocol: 'stepfun-sse', detection: { status: 'supported' } }, tts: { ...original.tts, voice: 'Voice/@raw' } };
  assert.deepEqual(voiceSettingsPatch(draft, original), { tts: { voice: 'Voice/@raw' } });
  assert.deepEqual(voiceSettingsPatch({ ...original, asr: { ...original.asr, apiType: 'stepfun', protocol: 'stepfun-sse' } }, original), { asr: { apiType: 'stepfun', protocol: 'stepfun-sse' } });
  assert.throws(() => voiceSettingsPatch({ ...original, asr: { ...original.asr, apiType: 'unknown' } }, original), /接口类型/);
  assert.throws(() => voiceSettingsPatch({ ...original, asr: { ...original.asr, protocol: 'auto' } }, original), /显式选择/);
});

test('listening saves only edits, keeps custom wake draft and never round-trips a saved secret', () => {
  assert.deepEqual(listeningDraft(), { enabled: false, endpoint: '', model: '', apiKey: '', wakeSource: 'custom', wakeWord: '' });
  const config = { enabled: true, endpoint: 'https://example.test/v1/systemone', model: 'Exact/@01', apiKey: 'PRIVATE', apiKeyConfigured: true, wakeSource: 'superagent', wakeWord: '小白', superagentName: '小蓝', configured: true };
  const original = { asr: {}, tts: {}, listening: listeningDraft(config) };
  assert.equal(original.listening.apiKey, ''); assert.equal(original.listening.wakeWord, '小白');
  assert.deepEqual(voiceSettingsPatch(original, original), {});
  assert.deepEqual(voiceSettingsPatch({ ...original, listening: { ...original.listening, wakeSource: 'custom' } }, original), { listening: { wakeSource: 'custom' } });
  assert.deepEqual(voiceSettingsPatch({ ...original, listening: { ...original.listening, model: 'Exact/@02' } }, original), { listening: { model: 'Exact/@02' } });
  assert.deepEqual(voiceSettingsPatch(original, original, { listening: true }), { listening: { apiKey: '' } });
  assert.deepEqual(voiceSettingsPatch({ ...original, listening: { ...original.listening, apiKey: 'NEW_PRIVATE' } }, original), { listening: { apiKey: 'NEW_PRIVATE' } });
  assert.throws(() => voiceSettingsPatch({ ...original, listening: { ...original.listening, model: ' Exact/@01' } }, original), /首尾/);
});
