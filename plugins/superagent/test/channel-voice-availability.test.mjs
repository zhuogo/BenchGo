import test from 'node:test';
import assert from 'node:assert/strict';
import { channelVoiceAvailability } from '../src/service.mjs';

function voice(protocol, dictation = true) {
  const value = { dictation, readAloud: false, call: false,
    asr: { protocol, baseURL: 'https://voice.example/v1', model: 'opaque/asr:model' },
    tts: { protocol: 'speech', baseURL: 'https://voice.example/v1', model: 'opaque/tts:model' } };
  return { value, snapshot: () => structuredClone(value) };
}

test('channel uploads allow only concrete HTTP/SSE ASR protocols', async () => {
  for (const protocol of ['transcriptions', 'transcriptions-sse', 'stepfun-sse']) {
    const result = await channelVoiceAvailability(voice(protocol));
    assert.equal(result.available.voiceInput, true, protocol);
  }
});

test('unset and legacy auto protocols remain unavailable until explicitly matched', async () => {
  for (const protocol of ['', undefined, 'auto']) {
    const result = await channelVoiceAvailability(voice(protocol));
    assert.equal(result.available.voiceInput, false, String(protocol));
    assert.match(result.reasons.voiceInput, /尚未匹配.*自动匹配.*排除 WebSocket/);
    assert.doesNotMatch(result.reasons.voiceInput, /自动识别/);
  }
});

test('channel uploads explain unsupported WebSocket and unknown protocols', async () => {
  const websocket = await channelVoiceAvailability(voice('openai-websocket'));
  assert.equal(websocket.available.voiceInput, false);
  assert.match(websocket.reasons.voiceInput, /WebSocket.*不支持/);
  assert.match(websocket.reasons.voiceInput, /自动匹配.*文件上传.*HTTP\/SSE/);
  const unknown = await channelVoiceAvailability(voice('future-protocol'));
  assert.equal(unknown.available.voiceInput, false);
  assert.match(unknown.reasons.voiceInput, /不支持此语音识别协议/);
});

test('channel protocol support preserves the actual disabled and missing service state', async () => {
  assert.equal((await channelVoiceAvailability(voice('stepfun-sse', false))).available.voiceInput, false);
  assert.equal((await channelVoiceAvailability(undefined)).available.voiceInput, false);
});
