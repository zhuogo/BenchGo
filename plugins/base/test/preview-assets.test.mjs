import test from 'node:test';
import assert from 'node:assert/strict';
import { mountPreviewAssets, previewAssets } from '../src/preview-assets.mjs';

test('only built preview resources are registered and served with correct MIME', async () => {
  const routes = new Map();
  await mountPreviewAssets({ effect: callback => callback(), connection: { fetch: { register(route) { routes.set(route.path, route); } } } });
  for (const file of previewAssets) {
    const route = routes.get('/api/benchgo/preview-assets/' + file);
    assert.deepEqual(route.methods, ['GET']);
    const result = await route.fetch();
    assert.equal(result.status, 200);
    assert.match(result.headers.get('content-type'), /javascript/);
    assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
    assert.ok((await result.arrayBuffer()).byteLength > 100);
  }
  assert.equal(routes.has('/api/benchgo/preview-assets/../package.json'), false);
  const wasm = [...routes.values()].find(route => route.path.endsWith('.wasm'));
  assert.equal((await wasm.fetch()).headers.get('content-type'), 'application/wasm');
});
