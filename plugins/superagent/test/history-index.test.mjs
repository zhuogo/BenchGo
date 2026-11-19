import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { historyPage, updateHistoryIndex } from '../src/history-index.mjs';
import { mediaArtifactUrl, NATIVE_MEDIA_RESULT } from '../../media/shared/generation-result.mjs';

const call = (seq, id, name = 'assistant_generate_image') => ({ seq, type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', name, id }] } } });
const result = (seq, id, filename, extra = {}) => ({ seq, type: 'tool/result', data: { message: { id: `image-${seq}`, toolCallId: id,
  content: [{ type: 'text', text: JSON.stringify({ filename }) }], ...extra } } });

test('history index appends metadata once and keeps pagination, image validation and message display order', () => {
  const events = [call(0, 'a'), result(1, 'a', 'first.png'), call(2, 'b'), result(3, 'b', '../private.png'),
    result(4, 'a', 'failed.png', { isError: true }), result(5, 'other', 'other.png'),
    { seq: 6, type: 'request/header', data: { header: { config: { provider: 'opaque-provider', model: 'exact-model' } } } },
    { seq: 7, type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'offline' } } } }];
  const index = updateHistoryIndex(events);
  assert.deepEqual(index.header, { provider: 'opaque-provider', model: 'exact-model' });
  assert.equal(index.lastEnd.error.message, 'offline');
  assert.deepEqual(index.images.map(row => row.image.name), ['first.png']);
  events.push(call(8, 'c', 'generate_image'), result(9, 'c', 'latest.webp'));
  updateHistoryIndex(events, index);
  updateHistoryIndex(events, index);
  assert.deepEqual(index.images.map(row => row.image.name), ['first.png', 'latest.webp']);
  assert.deepEqual(index.images.map(row => row.image.url), ['api/commander/assistant/artifact?file=first.png', 'api/benchgo/media/artifact?file=latest.webp']);
  const messages = [{ seq: 0 }, { seq: 6 }, { seq: 8 }];
  assert.deepEqual(historyPage(messages, index, { limit: 1 }), { messages: [{ seq: 8 }], images: [index.images[1].image], hasMore: true, nextBefore: 8 });
  assert.deepEqual(historyPage(messages, index, { before: 6, limit: 2 }), { messages: [{ seq: 0 }], images: [index.images[0].image], hasMore: false, nextBefore: null });
  assert.deepEqual(historyPage(messages, index, { before: 0, limit: 2 }), { messages: [], images: [], hasMore: false, nextBefore: null });
  const replacedAnswer = [{ seq: 7 }, { seq: 2 }, { seq: 5 }];
  assert.deepEqual(historyPage(replacedAnswer, index, { before: 6, limit: 1 }).messages, [{ seq: 5 }]);
});

test('generated images keep their originating turn group across calls, pages and late results', () => {
  const events = [{ seq: 0, type: 'turn/start', data: { turn: 1 } }, call(1, 'a'), result(2, 'a', 'first.png'),
    call(3, 'b'), { seq: 4, type: 'turn/end', data: { reason: { kind: 'completed' } } }];
  const index = updateHistoryIndex(events);
  events.push({ seq: 5, type: 'turn/start', data: { turn: 2 } }, call(6, 'c'), result(7, 'b', 'second.png'), result(8, 'c', 'third.png'));
  updateHistoryIndex(events, index);
  assert.deepEqual(index.images.map(row => row.image.groupId), ['turn:0', 'turn:0', 'turn:5']);
  const messages = [{ seq: 1 }, { seq: 6 }];
  const latest = historyPage(messages, index, { limit: 1 });
  const earlier = historyPage(messages, index, { before: latest.nextBefore, limit: 1 });
  assert.equal(latest.images[0].groupId, earlier.images[0].groupId, 'a split group rejoins when earlier history is loaded');
  assert.notEqual(latest.images[0].groupId, latest.images[1].groupId, 'distinct reply turns never share a group');
  const rebuilt = updateHistoryIndex(events);
  assert.deepEqual(rebuilt.images, index.images, 'reloading history preserves group identities');
});

test('shared media history restores the exact provider image link', () => {
  const externalUrl = 'https://images.cdn.com/finished?signature=a%2Fb';
  const external = result(2, 'cdn', undefined, { content: [{ type: 'text', text: JSON.stringify({
    status: 'completed', externalUrl, url: externalUrl, mimeType: 'image/*',
  }) }] });
  const events = [{ seq: 0, type: 'turn/start', data: { turn: 1 } }, call(1, 'cdn', 'generate_image'), external];
  const index = updateHistoryIndex(events);
  assert.deepEqual(historyPage([{ seq: 1 }], index, { limit: 10 }).images, [{
    id: 'image-2', groupId: 'turn:0', seq: 2, turn: 1, url: externalUrl, name: '生成图片', mimeType: 'image/*', external: true,
  }]);
});

test('completed audio and video restore by original turn and repeated status results collapse within it', () => {
  const delivery = (seq, id, filename, mimeType) => result(seq, id, filename, { content: [{
    type: 'text', text: JSON.stringify({ status: 'completed', filename, mimeType, url: mediaArtifactUrl(filename) }),
  }] });
  const events = [{ seq: 0, type: 'turn/start', data: { turn: 1 } }, call(1, 'video', 'generate_video'),
    delivery(2, 'video', 'clip.mp4', 'video/mp4'), call(3, 'status', 'media_video_status'),
    delivery(4, 'status', 'clip.mp4', 'video/mp4'), call(5, 'audio', 'generate_audio'),
    { seq: 6, type: 'turn/end', data: { reason: { kind: 'completed' } } },
    { seq: 7, type: 'turn/start', data: { turn: 2 } }, delivery(8, 'audio', 'voice.mp3', 'audio/mpeg'),
    { seq: 9, type: NATIVE_MEDIA_RESULT, ignorable: true, data: { filename: 'native.wav', mimeType: 'audio/wav', url: mediaArtifactUrl('native.wav') } }];
  const index = updateHistoryIndex(events);
  const page = historyPage([{ seq: 1 }, { seq: 7 }], index, { limit: 2 });
  assert.deepEqual(page.images, []);
  assert.deepEqual(page.media.map(({ name, seq, turn }) => ({ name, seq, turn })), [
    { name: 'clip.mp4', seq: 2, turn: 1 }, { name: 'voice.mp3', seq: 8, turn: 1 }, { name: 'native.wav', seq: 9, turn: 2 },
  ]);
  assert.deepEqual(historyPage([{ seq: 1 }], index, { before: 7, limit: 2 }).media, [page.media[0]]);
});

test('incomplete transcripts group calls by assistant message instead of merging unrelated replies', () => {
  const first = call(0, 'a'); first.data.message.id = 'reply-1';
  first.data.message.content.push({ type: 'tool-call', name: 'assistant_generate_image', id: 'b' });
  const events = [first, result(1, 'a', 'a.png'), result(2, 'b', 'b.png'), call(3, 'c'), result(4, 'c', 'c.png')];
  const index = updateHistoryIndex(events);
  assert.deepEqual(index.images.map(row => row.image.groupId), ['message:reply-1', 'message:reply-1', 'message:3']);
});

test('warm reads never revisit old tool traces and incremental indexing reads only appended events', t => {
  let accesses = 0;
  const trace = Array.from({ length: 100000 }, (_, seq) => ({ seq, type: 'tool/call', data: { name: 'opaque-tool' } }));
  const events = new Proxy(trace, { get(target, key, receiver) {
    if (typeof key === 'string' && /^\d+$/.test(key)) accesses++;
    return Reflect.get(target, key, receiver);
  } });
  const messages = Array.from({ length: 2000 }, (_, i) => ({ seq: i * 50, text: `message-${i}` }));
  const cold = performance.now(), index = updateHistoryIndex(events);
  const coldMs = performance.now() - cold;
  assert.equal(accesses, trace.length);
  accesses = 0;
  const begin = performance.now();
  for (let i = 0; i < 100; i++) {
    updateHistoryIndex(events, index);
    assert.equal(historyPage(messages, index, { limit: 50 }).messages.length, 50);
  }
  const warm100Ms = performance.now() - begin;
  assert.equal(accesses, 0, 'warm pagination must not traverse any stored event');
  trace.push({ seq: trace.length, type: 'turn/end', data: { reason: { kind: 'completed' } } });
  updateHistoryIndex(events, index);
  assert.equal(accesses, 1);
  assert.equal(index.lastEnd.kind, 'completed');
  t.diagnostic(JSON.stringify({ events: trace.length, messages: messages.length, coldIndexMs: coldMs, warm100PagesMs: warm100Ms }));
});
