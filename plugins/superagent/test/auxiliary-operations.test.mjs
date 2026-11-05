import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuxiliaryOperations } from '../src/auxiliary-operations.mjs';

const main = { providerId: 'main', modelId: 'Opaque/main' };
const aux = { providerId: 'aux', modelId: 'Opaque/vision summary' };
const finish = { type: 'finish', reason: { kind: 'stop' } };
function fixture({ modalities = ['image', 'text'], attachments = true, response, stream } = {}) {
  const requests = [], entries = [], images = [];
  const config = { revision: 2, models: [main], auxiliary: { capabilities: ['summary', 'vision'], models: [aux] } };
  const emit = async function* (options) { requests.push(options); if (stream) yield* stream(options); else { yield { type: 'text-delta', text: 'Observed result' }; yield finish; } };
  const ctx = { llm: { stream: emit, async prepareCall(config) { return { config, inputModalities: modalities, stream: emit }; } },
    get: () => attachments ? { async saveImage(input) { images.push(input); return { attachmentId: 'opaque-image', mediaType: input.mediaType, bytes: input.data.length, width: 1, height: 1 }; } } : null };
  const store = { getConfig: async () => config, getState: async () => ({ threads: [{ id: 'side', models: [{ providerId: 'side', modelId: 'Opaque/side' }] }] }), ledger: { append: entry => entries.push(entry) } };
  const artifacts = { fetch: async request => response ? response(request) : new Response('image bytes', { headers: { 'content-type': 'image/png' } }) };
  return { api: createAuxiliaryOperations({ ctx, store, artifacts }), config, requests, entries, images };
}

test('summary follows capability changes and shared main selection even with stale thread overrides', async () => {
  const f = fixture();
  const result = await f.api.summarize({ text: 'Original decision and evidence' });
  assert.equal(f.requests[0].model, aux.modelId);
  assert.equal(result.source.complete, true); assert.equal(result.source.characters, 30);
  assert.equal(result.routing.capability, 'summary');
  assert.equal(f.entries[0].metadata.source.hash, result.source.hash);
  assert.ok(!JSON.stringify(f.entries).includes('Original decision'));
  f.config.auxiliary.capabilities = ['vision'];
  await f.api.summarize({ text: 'new', threadId: 'side' });
  assert.equal(f.requests[1].model, main.modelId);
  assert.deepEqual(f.requests[1].tools, []);
  await assert.rejects(f.api.summarize({ text: 'new', threadId: 'missing' }), /旁聊/);
});

test('summary rejects empty/oversized evidence instead of silently truncating', async () => {
  const f = fixture();
  for (const text of ['', ' ', 'x'.repeat(60001)]) await assert.rejects(f.api.summarize({ text }), /原文/);
  assert.equal(f.requests.length, 0);
});

test('vision uses official durable attachments and exact route, preserving source identity', async () => {
  const f = fixture();
  const result = await f.api.analyzeImage({ file: 'screens/图.png', question: 'What is visible?' });
  assert.equal(f.images[0].name, '图.png');
  assert.equal(f.requests[0].model, aux.modelId);
  assert.equal(f.requests[0].messages[1].content[1].attachment.attachmentId, 'opaque-image');
  assert.equal(result.source.file, 'screens/图.png');
  assert.equal(result.source.bytes, 11);
  assert.equal(result.routing.capability, 'vision');
});

test('vision never reports placeholder-only text model output as image evidence', async () => {
  const f = fixture({ modalities: ['text'] });
  await assert.rejects(f.api.analyzeImage({ file: 'image.png', question: 'Describe' }), /不支持图片/);
  assert.equal(f.requests.length, 0);
  assert.equal(f.entries.length, 0);
});

test('vision reports unavailable attachments, missing files and unsupported formats', async () => {
  for (const [options, pattern] of [
    [{ attachments: false }, /附件服务/],
    [{ response: () => new Response('Not found', { status: 404 }) }, /不存在/],
    [{ response: () => new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } }) }, /仅支持/],
  ]) {
    const f = fixture(options);
    await assert.rejects(f.api.analyzeImage({ file: 'image.png', question: 'Describe' }), pattern);
    assert.equal(f.requests.length, 0);
  }
});

test('read-only summary fallback discards partial text and retains frozen source/config', async () => {
  const f = fixture({ stream: async function* (options) {
    if (options.provider === 'aux') { f.config.revision++; yield { type: 'text-delta', text: 'not a valid answer' }; yield { type: 'finish', reason: { kind: 'error', failure: { status: 401 } } }; }
    else { yield { type: 'text-delta', text: 'Main summary' }; yield finish; }
  } });
  const result = await f.api.summarize({ text: 'source' });
  assert.equal(result.text, 'Main summary');
  assert.equal(result.routing.configRevision, 2);
  assert.deepEqual(f.requests.map(row => row.provider), ['aux', 'main']);
});

test('cancelled requests never publish or record an answer', async () => {
  const f = fixture(), controller = new AbortController(); controller.abort();
  await assert.rejects(f.api.summarize({ text: 'source', signal: controller.signal }), { name: 'AbortError' });
  assert.equal(f.requests.length, 0); assert.equal(f.entries.length, 0);
});
