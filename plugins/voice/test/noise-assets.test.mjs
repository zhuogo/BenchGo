import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceHandlers } from '../src/web.mjs';
import { buildNoise } from '../scripts/build-noise.mjs';

test('local noise assets use the same-origin authenticated Voice route and contain offline resources', async () => {
  await buildNoise();
  const handlers = createVoiceHandlers({ value: {} });
  try {
    for (const [path, handler] of [['noise-worklet', handlers.noiseWorklet], ['noise-wasm', handlers.noiseWasm]]) {
      const forbidden = await handler(new Request(`http://benchgo.test/api/voice/${path}`, { headers: { origin: 'https://foreign.test' } }));
      assert.equal(forbidden.status, 403);
      const response = await handler(new Request(`http://benchgo.test/api/voice/${path}`));
      assert.equal(response.status, 200); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      if (path === 'noise-wasm') {
        assert.equal(response.headers.get('content-type'), 'application/wasm');
        assert.ok(await WebAssembly.compile(await response.arrayBuffer()));
      } else {
        assert.match(response.headers.get('content-type'), /javascript/);
        const body = await response.text();
        assert.match(body, /voice-noise-capture/); assert.doesNotMatch(body, /https?:\/\//);
      }
    }
  } finally { handlers.dispose(); }
});
