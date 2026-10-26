import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';

const { JSDOM } = createRequire(new URL('../../../deepseek-harness/package.json', import.meta.url))('jsdom');
const source = readFileSync(new URL('../../link/client/brand.jsx', import.meta.url), 'utf8');
const code = transformSync(source, { loader: 'jsx', format: 'cjs' }).code;

test('the shared app icon uses the 2026-10-26 BenchGo mark', () => {
  const logo = new JSDOM(readFileSync(new URL('../../../assets/brand/benchgo-logo.svg', import.meta.url), 'utf8'), { contentType: 'image/svg+xml' });
  const mark = new JSDOM(readFileSync(new URL('../../../assets/brand/benchgo-mark.svg', import.meta.url), 'utf8'), { contentType: 'image/svg+xml' });
  assert.equal(logo.window.document.documentElement.getAttribute('viewBox'), '0 0 1024 1024');
  assert.equal(logo.window.document.querySelector('g').getAttribute('transform'), 'translate(122,274.4) scale(1.3)');
  assert.match(logo.window.document.documentElement.outerHTML, /#F1E8DB/);
  assert.match(logo.window.document.documentElement.outerHTML, /#EE5A33/);
  assert.equal(mark.window.document.documentElement.getAttribute('viewBox'), '0 0 600 380');
  logo.window.close();
  mark.window.close();
});

test('brand favicon replaces both theme variants and restores existing icons when unloaded', () => {
  for (const initial of ['', '<link rel="icon" type="image/png" href="light.png" media="(prefers-color-scheme:light)"><link rel="icon" href="dark.svg" media="(prefers-color-scheme:dark)">']) {
    const dom = new JSDOM(`<!doctype html><head>${initial}</head>`), module = { exports: {} };
    const head = dom.window.document.head;
    const before = head.innerHTML;
    runInNewContext(code, { module, exports: module.exports, document: dom.window.document, require: id => id.endsWith('.svg') ? readFileSync(new URL('../../../assets/brand/' + (id.endsWith('/favicon.svg') ? 'favicon.svg' : 'benchgo-logo.svg'), import.meta.url), 'utf8') : {} });
    let dispose;
    module.exports.mountBrand({ effect: callback => { dispose = callback(); } });
    const icons = [...head.querySelectorAll('link[rel="icon"]')];
    assert.equal(icons.length, initial ? 2 : 1);
    assert(icons.every(icon => icon.href.startsWith('data:image/svg+xml,') && icon.type === 'image/svg+xml'));
    assert(icons.every(icon => decodeURIComponent(icon.href).includes('#EE5A33')));
    dispose();
    assert.equal(head.innerHTML, before);
    dom.window.close();
  }
});
