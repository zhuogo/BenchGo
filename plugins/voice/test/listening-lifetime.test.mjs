import test from 'node:test';
import assert from 'node:assert/strict';
import { CallLeases } from '../src/calls.mjs';
import { createVoiceConversations } from '../src/conversations.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) { for (let i = 0; i < 100; i++) { if (predicate()) return; await tick(); } assert.fail('等待通话事件超时'); }

test('only validated listening options extend the lease, with heartbeat expiry and a fixed 24 hour cap', () => {
  let now = 0;
  const calls = new CallLeases({ now: () => now });
  try {
    const regular = calls.start({ sessionId: 'ordinary', deviceId: 'browser', listening: true, maxEndsAt: Infinity });
    assert.equal(regular.maxEndsAt, 30 * 60000); assert.equal(regular.listening, undefined);
    const listening = calls.start({ sessionId: 'listening', deviceId: 'browser' }, { listening: true });
    assert.equal(listening.maxEndsAt, 24 * 60 * 60000); assert.equal(listening.listening, true);
    assert.throws(() => calls.start({ sessionId: 'listening', deviceId: 'phone' }, { listening: true }), /another device/);
    const media = calls.media(listening.callId);
    for (now = 30000; now < listening.maxEndsAt; now += 30000) {
      assert.equal(calls.heartbeat(listening).maxEndsAt, listening.maxEndsAt);
      if (now === 31 * 60000) {
        const reconnect = calls.start({ sessionId: 'listening', deviceId: 'browser' }, { listening: true });
        assert.equal(reconnect.callId, listening.callId); assert.equal(reconnect.maxEndsAt, listening.maxEndsAt);
      }
    }
    assert.throws(() => calls.heartbeat(listening), /expired/); assert.equal(media.aborted, true);
    const lost = calls.start({ sessionId: 'lost', deviceId: 'browser' }, { listening: true });
    const lostMedia = calls.media(lost.callId); now += 45001;
    assert.throws(() => calls.heartbeat(lost), /expired/); assert.equal(lostMedia.aborted, true);
  } finally { calls.clear(); }
});

function fixture(t, { listening = true, generate } = {}) {
  const leases = new CallLeases(), listeners = new Set(), requests = [], records = [], events = [];
  const store = { value: { call: true, conversation: { providerId: 'provider', model: 'model' }, tts: { speed: 1.2, voice: 'voice' } } };
  const bridge = {
    describe: async () => ({ kind: 'ordinary' }), history: async () => [], handoffContext: async () => [], status: () => null,
    append: async (_id, record) => { records.push(record); },
    subscribe(_id, listener) { listeners.add(listener); return () => listeners.delete(listener); }, dispose() {},
  };
  const llm = { async prepareCall(config) { return { config, stream: request => llm.stream(request) }; }, async *stream(request) {
    requests.push(request);
    if (generate) yield* generate(request, requests.length);
    else { yield { type: 'text-delta', index: 0, text: '已收到。' }; yield { type: 'finish', reason: { kind: 'stop' } }; }
  } };
  const api = createVoiceConversations({ store, bridge, llm, leases, snapshot: async () => store.value });
  const lease = leases.start({ sessionId: 'session', deviceId: 'browser' }, { listening });
  const input = { sessionId: lease.sessionId, deviceId: lease.deviceId, callId: lease.callId };
  let reader;
  t.after(() => { api.dispose(); leases.clear(); void reader?.cancel(); });
  return { api, requests, records, events, input,
    async start() {
      await api.open(input); reader = api.events(input).getReader();
      void (async () => { try { for (;;) { const chunk = await reader.read(); if (chunk.done) return; for (const line of new TextDecoder().decode(chunk.value).trim().split('\n')) events.push(JSON.parse(line)); } } catch {} })();
    },
    turn: (requestId, text = '你好') => api.turn({ ...input, requestId, text }),
    emit: event => { for (const listener of listeners) listener(event); },
  };
}

test('listening admits 4096 requests, ordinary calls 256, without evicting earliest deduplication identities', async t => {
  for (const [listening, limit] of [[false, 256], [true, 4096]]) {
    const f = fixture(t, { listening, generate: async function* (request) {
      await new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }));
    } });
    await f.start(); await f.turn('first', '同一原话'); await until(() => f.requests.length === 1);
    for (let i = 1; i < limit; i++) await f.turn(`request-${i}`, `原话 ${i}`);
    assert.deepEqual(await f.turn('first', '同一原话'), { accepted: true, requestId: 'first', duplicate: true });
    await assert.rejects(f.turn('first', '改写原话'), /不能替换/);
    await assert.rejects(f.turn('overflow'), /已达上限/);
    assert.equal(f.records.filter(row => row.kind === 'user').length, limit);
    f.api.dispose();
  }
});

test('suspended execution results retain an ordered bounded queue and report overflow without replaying work', async t => {
  const f = fixture(t); await f.start(); f.api.interrupt(f.input);
  for (let i = 0; i < 40; i++) f.emit({ type: 'completed', requestId: `work-${i}`, text: `result-${i}` });
  await until(() => f.events.some(event => event.type === 'error'));
  await tick();
  assert.equal(f.requests.length, 0); assert.equal(f.events.filter(event => event.type === 'error').length, 1);
  assert.match(f.events.find(event => event.type === 'error').error, /完整结果仍保留.*不会重复执行/);
  await f.turn('resume', '请说结果'); await until(() => f.events.some(event => event.type === 'end'));
  const facts = f.requests[0].messages.find(row => row.content?.[0]?.text?.startsWith('以下是宿主回传')).content[0].text;
  const values = JSON.parse(facts.slice(facts.indexOf('\n') + 1));
  assert.equal(values.length, 32); assert.equal(values[0].requestId, 'work-0'); assert.equal(values.at(-1).requestId, 'work-31');
  assert.equal(f.records.filter(row => row.kind === 'user').length, 1);
});

test('failed result expression uses the same character bound when retaining facts for another turn', async t => {
  const f = fixture(t, { generate: async function* (_request, attempt) {
    if (attempt === 1) throw Error('expression failed');
    yield { type: 'text-delta', index: 0, text: '我在听。' }; yield { type: 'finish', reason: { kind: 'stop' } };
  } });
  await f.start(); f.emit({ type: 'completed', requestId: 'large', text: 'EXCESS'.repeat(5500) });
  await until(() => f.events.some(event => /待播结果较多/.test(event.error || '')));
  await f.turn('next'); await until(() => f.events.some(event => event.type === 'end' && event.requestId === 'next'));
  assert.doesNotMatch(JSON.stringify(f.requests.at(-1).messages), /EXCESS/);
});
