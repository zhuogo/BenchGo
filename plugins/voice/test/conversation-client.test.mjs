import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceConversation } from '../client/conversation.mjs';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function fixture() {
  const requests = [], events = [], errors = [];
  let source;
  const client = new VoiceConversation({ endpoint: 'https://voice.example/api/voice/conversation',
    identity: { sessionId: 's', callId: 'c', deviceId: 'd' }, onEvent: event => events.push(event), onError: error => errors.push(error),
    request: async (_url, options) => {
      const input = JSON.parse(options.body); requests.push(input);
      if (input.action === 'events') return new Response(new ReadableStream({
        start(controller) { source = controller; options.signal.addEventListener('abort', () => controller.error(options.signal.reason), { once: true }); },
      }), { headers: { 'content-type': 'application/x-ndjson' } });
      return Response.json({ accepted: true });
    },
  });
  return { client, requests, events, errors, emit(event, split = false) {
    const bytes = new TextEncoder().encode(JSON.stringify(event) + '\n');
    if (split) for (const value of bytes) source.enqueue(new Uint8Array([value])); else source.enqueue(bytes);
  }, finish() { source.close(); } };
}

test('conversation receives UTF-8 events before EOF and rejects old speech after interruption', async () => {
  const h = fixture(); await h.client.start();
  h.emit({ type: 'start', messageId: 'old' }); h.emit({ type: 'text', messageId: 'old', text: '你好。' }, true);
  await tick(); assert.equal(h.events.at(-1).text, '你好。');
  await h.client.interrupt();
  h.emit({ type: 'text', messageId: 'old', text: '迟到内容' });
  h.emit({ type: 'start', messageId: 'new' }); h.emit({ type: 'text', messageId: 'new', text: '新的回答。' });
  await tick(); assert(!h.events.some(event => event.text === '迟到内容')); assert.equal(h.events.at(-1).text, '新的回答。');
  await h.client.send('帮我查一下', 'r');
  assert.deepEqual(h.requests.at(-1), { action: 'turn', text: '帮我查一下', requestId: 'r', sessionId: 's', callId: 'c', deviceId: 'd' });
  await h.client.dispose(); assert.equal(h.requests.at(-1).action, 'close'); assert.equal(h.errors.length, 0);
});

test('resume follows the pending interruption and sends nothing after dispose', async () => {
  const h = fixture(); await h.client.start();
  const interrupting = h.client.interrupt(); await h.client.resume(); await interrupting;
  assert.deepEqual(h.requests.slice(-2).map(row => row.action), ['interrupt', 'resume']);
  assert.deepEqual(h.requests.at(-1), { action: 'resume', sessionId: 's', callId: 'c', deviceId: 'd' });
  await h.client.dispose(); const count = h.requests.length;
  await h.client.resume(); assert.equal(h.requests.length, count);
});

test('unexpected event EOF reports disconnection without replaying an accepted turn', async () => {
  const h = fixture(); await h.client.start(); await h.client.send('执行原话', 'same-request');
  h.finish(); await tick(); assert.equal(h.errors.length, 1); assert.match(h.errors[0].message, /断开/);
  assert.equal(h.requests.filter(row => row.action === 'turn').length, 1); await h.client.dispose();
});

test('late errors for interrupted reply are isolated without hiding a later execution reply for the same request', async () => {
  const h = fixture(); await h.client.start();
  h.emit({ type: 'start', messageId: 'old', requestId: 'task' }); await tick();
  await h.client.interrupt();
  h.emit({ type: 'error', messageId: 'old', requestId: 'task', error: 'old model error' });
  h.emit({ type: 'start', messageId: 'result', requestId: 'task' });
  h.emit({ type: 'text', messageId: 'result', requestId: 'task', text: '任务已完成。' });
  h.emit({ type: 'error', messageId: 'result', requestId: 'task', error: 'current provider error' });
  await tick();
  assert.equal(h.events.some(event => event.error === 'old model error'), false);
  assert.ok(h.events.some(event => event.text === '任务已完成。'));
  assert.ok(h.events.some(event => event.error === 'current provider error'));
  await h.client.dispose();
});

test('conversation closes a pending stream and never emits callbacks after dispose', async () => {
  const h = fixture(); await h.client.start(); await h.client.dispose();
  assert.equal(h.client.closed, true); assert.equal(h.events.length, 0); assert.equal(h.errors.length, 0);
  await assert.rejects(h.client.send('不应再发送', 'late'), /通话已结束/);
});

test('event stream handshake has a deadline and aborts the pending transport', async () => {
  let signal;
  const client = new VoiceConversation({ endpoint: 'https://voice.example/api/voice/conversation', connectTimeoutMs: 20,
    request: async (_url, options) => {
      if (JSON.parse(options.body).action !== 'events') return Response.json({ closed: true });
      signal = options.signal;
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
  });
  await assert.rejects(client.start(), /连接超时/);
  assert.equal(signal.aborted, true);
  await client.dispose();
});
