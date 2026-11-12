import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { RealtimeASR } from '../src/realtime.mjs';
import { CallLeases } from '../src/calls.mjs';

class Upstream extends EventEmitter {
  constructor() { super(); queueMicrotask(() => this.emit('open')); }
  send(raw) { if (JSON.parse(raw).type === 'session.update') queueMicrotask(() => this.emit('message', JSON.stringify({ type: 'session.updated' }))); }
  close() { this.closed = true; }
}
const config = { protocol: 'openai-websocket', baseURL: 'https://example.test', model: 'exact-model' };

test('realtime ASR preserves default 30 minute limit and accepts bounded listening remaining time', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const duration of [undefined, 24 * 60 * 60 * 1000, 450]) {
    const sockets = [], runtime = new RealtimeASR({ socket: () => { const ws = new Upstream(); sockets.push(ws); return ws; } });
    try {
      const id = await runtime.open(config, new AbortController().signal, 'call', duration === undefined ? {} : { maxDurationMs: duration });
      runtime.events(id, 'call');
      const limit = duration ?? 30 * 60 * 1000;
      t.mock.timers.tick(limit - 1); assert.doesNotThrow(() => runtime.get(id, 'call'));
      t.mock.timers.tick(1); assert.throws(() => runtime.get(id, 'call'), /expired/); assert.equal(sockets[0].closed, true);
      assert.equal(sockets.length, 1);
    } finally { runtime.clear(); }
  }
});

test('realtime resets fence upstream audio without renewing the original duration cap', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sockets = [], runtime = new RealtimeASR({ socket: () => { const ws = new Upstream(); sockets.push(ws); return ws; } });
  try {
    const id = await runtime.open(config, new AbortController().signal, 'call', { maxDurationMs: 1000 }); runtime.events(id, 'call');
    t.mock.timers.tick(900); await runtime.reset(id, 'call');
    assert.equal(sockets.length, 2); assert.equal(sockets[0].closed, true);
    t.mock.timers.tick(100); assert.throws(() => runtime.get(id, 'call'), /expired/); assert.equal(sockets[1].closed, true);
  } finally { runtime.clear(); }
});

test('invalid realtime caps reject before connecting and call media options remain host-derived', async () => {
  const runtime = new RealtimeASR({ socket: () => assert.fail('must not open socket') });
  for (const maxDurationMs of [0, -1, Infinity, NaN, 0.5, '1000', 86400001]) await assert.rejects(runtime.open(config, new AbortController().signal, 'call', { maxDurationMs }), /Invalid realtime ASR duration/);
  assert.equal(runtime.sessions.size, 0);
  let now = 1000; const calls = new CallLeases({ now: () => now });
  try {
    const regular = calls.start({ sessionId: 'regular', deviceId: 'device', listening: true });
    const listening = calls.start({ sessionId: 'listening', deviceId: 'device' }, { listening: true });
    assert.deepEqual(calls.mediaOptions(regular.callId), {});
    now += 30000; assert.deepEqual(calls.mediaOptions(listening.callId), { maxDurationMs: 86400000 - 30000 });
    now += 15001; assert.throws(() => calls.mediaOptions(listening.callId), /expired/);
  } finally { calls.clear(); }
});
