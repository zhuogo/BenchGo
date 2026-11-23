import test from 'node:test';
import assert from 'node:assert/strict';
import { managementCall, pairingContext, contextUri } from '../client/api.mjs';

test('branded connection information round trips while legacy links remain accepted', () => {
  const value = { url: 'https://desk.example', pin: 'a+b/c=', code: 'one-use', name: '办公室电脑' };
  const uri = contextUri(value);
  assert(uri.startsWith('benchgo://pair?'));
  assert.deepEqual(pairingContext(uri), value);
  assert.deepEqual(pairingContext(uri.replace('benchgo:', 'dshlink:')), value);
  for (const uri of ['benchgo://other?code=x', 'benchgo://pair/other?code=x', 'benchgo://user@pair?code=x', 'benchgo://pair:123?code=x', 'benchgo://pair?code=x#extra']) assert.throws(() => pairingContext(uri), /地址无效/);
});

test('Android bootstrap round trips the target of a shared relay QR', t => {
  const relayTarget = 'sha256:' + 'A'.repeat(43) + '=';
  const qr = new URL('https://relay.example/link/#code=one-use');
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', { configurable: true, value: qr });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'location', previous); else delete globalThis.location; });
  qr.searchParams.set('relayTarget', relayTarget);
  const scanned = pairingContext(qr.href);
  assert.equal(scanned.relayTarget, relayTarget);
  assert.deepEqual(pairingContext(contextUri(scanned)), { ...scanned, pin: '' });
  qr.searchParams.append('relayTarget', relayTarget);
  assert.throws(() => pairingContext(qr.href), /中继目标无效/);
  assert.throws(() => pairingContext(contextUri({ ...scanned, pin: relayTarget.slice(7) })), /中继目标无效/);
});

test('management API preserves same-origin credentials, bounds requests and returns recoverable 404 diagnostics', async () => {
  const previous = new Map();
  const calls = [];
  for (const [key, value] of Object.entries({ document: { baseURI: 'https://cloud.test/' }, fetch: async (url, options) => { calls.push({ url, options }); return new Response('<html>not found</html>', { status: 404 }); } })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  try {
    await assert.rejects(managementCall('status'), error => { assert.equal(error.message, '服务待就绪，请稍后重试'); assert.equal(error.status, 404); assert.match(error.detail, /HTTP 404.*\/api\/commander-link/); return true; });
    assert.equal(calls[0].options.credentials, 'same-origin');
    assert(calls[0].options.signal instanceof AbortSignal);
    assert.equal(calls[0].url.href, 'https://cloud.test/api/commander-link');
    assert.equal(JSON.parse(calls[0].options.body).action, 'status');
    const controller = new AbortController(); controller.abort();
    globalThis.fetch = async (_url, options) => { throw options.signal.reason; };
    await assert.rejects(managementCall('status', {}, controller.signal), error => error.name === 'AbortError');
    for (const body of ['<html>proxy</html>', 'null', '[]', '{}']) {
      globalThis.fetch = async () => new Response(body, { status: 200 });
      await assert.rejects(managementCall('status'), error => { assert.equal(error.message, '暂时无法连接，请重试'); assert.match(error.detail, /格式异常|状态不完整/); return true; });
    }
    globalThis.fetch = async () => Response.json({ enabled: false });
    assert.deepEqual(await managementCall('status'), { enabled: false });
    const timeoutDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout');
    let duration;
    Object.defineProperty(AbortSignal, 'timeout', { configurable: true, value: milliseconds => { duration = milliseconds; const timed = new AbortController(); timed.abort(new DOMException('request timeout', 'TimeoutError')); return timed.signal; } });
    try {
      globalThis.fetch = async (_url, options) => { throw options.signal.reason; };
      await assert.rejects(managementCall('status'), error => error.message === '连接超时，请重试');
      assert.equal(duration, 10_000);
    } finally { Object.defineProperty(AbortSignal, 'timeout', timeoutDescriptor); }
  } finally { for (const [key, descriptor] of previous) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
});
