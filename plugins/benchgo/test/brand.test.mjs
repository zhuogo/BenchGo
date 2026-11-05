import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';

const { JSDOM } = createRequire(new URL('../../../deepseek-harness/package.json', import.meta.url))('jsdom');
const source = readFileSync(new URL('../../link/client/brand.jsx', import.meta.url), 'utf8');
const code = transformSync(source, { loader: 'jsx', format: 'cjs' }).code;

test('the app and transparent mark share the canonical BenchGo artwork', () => {
  const app = readFileSync(new URL('../../../assets/brand/benchgo-app.svg', import.meta.url), 'utf8');
  const logo = new JSDOM(app, { contentType: 'image/svg+xml' });
  const mark = new JSDOM(readFileSync(new URL('../../../assets/brand/benchgo-mark.svg', import.meta.url), 'utf8'), { contentType: 'image/svg+xml' });
  assert.equal(logo.window.document.documentElement.getAttribute('viewBox'), '0 0 840 840');
  assert.equal(mark.window.document.documentElement.getAttribute('viewBox'), '0 0 840 760');
  assert.equal(logo.window.document.querySelector('svg > rect').getAttribute('fill'), '#E8EAE5');
  assert.equal(mark.window.document.querySelector('svg > rect'), null);
  assert.equal(logo.window.document.querySelector('[data-part="placement"]').outerHTML, mark.window.document.querySelector('[data-part="placement"]').outerHTML);
  assert.equal(readFileSync(new URL('../assets/icon.svg', import.meta.url), 'utf8'), app);
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  for (const entry of ['./icon', './harness-plugin/icon', './superagent-plugin/icon', './voice-plugin/icon', './link-plugin/icon']) {
    assert.equal(manifest.exports[entry], './assets/icon.svg');
  }
  logo.window.close();
  mark.window.close();
});

test('brand favicon replaces both theme variants and restores existing icons when unloaded', () => {
  for (const initial of ['', '<link rel="icon" type="image/png" href="light.png" media="(prefers-color-scheme:light)"><link rel="icon" href="dark.svg" media="(prefers-color-scheme:dark)">']) {
    const dom = new JSDOM(`<!doctype html><head>${initial}</head>`), module = { exports: {} };
    const head = dom.window.document.head;
    const before = head.innerHTML;
    runInNewContext(code, { module, exports: module.exports, document: dom.window.document, require: id => id.endsWith('.svg') ? readFileSync(new URL(id, new URL('../../link/client/brand.jsx', import.meta.url)), 'utf8') : {} });
    let dispose;
    module.exports.mountBrand({ effect: callback => { dispose = callback(); } });
    const icons = [...head.querySelectorAll('link[rel="icon"]')];
    assert.equal(icons.length, initial ? 2 : 1);
    assert(icons.every(icon => icon.href.startsWith('data:image/svg+xml,') && icon.type === 'image/svg+xml'));
    const mark = readFileSync(new URL('../../../assets/brand/benchgo-mark.svg', import.meta.url), 'utf8');
    assert(icons.every(icon => decodeURIComponent(icon.href.split(',')[1]) === mark));
    dispose();
    assert.equal(head.innerHTML, before);
    dom.window.close();
  }
});
