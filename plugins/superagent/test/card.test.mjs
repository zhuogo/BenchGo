import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { petImageUrl } from '../client/pet-state.mjs';

const { transformSync } = createRequire(new URL('../../benchgo/package.json', import.meta.url))('esbuild');
const { JSDOM } = createRequire(new URL('../../../deepseek-harness/package.json', import.meta.url))('jsdom');
const code = transformSync(readFileSync(new URL('../client/card.jsx', import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs' }).code;
function harness() {
  const dom = new JSDOM('');
  const react = { createElement: (type, props, ...children) => ({ type, props, children }), useMemo: fn => fn(), useState: initial => [initial, () => {}], useRef: () => ({ current: null }), useEffect() {} };
  const module = { exports: {} };
  runInNewContext(code, { module, exports: module.exports, document: dom.window.document, require: id => id === 'react' ? react : id === './pet-state.mjs' ? { petImageUrl } : '' });
  return { ...module.exports, dom };
}

test('HTML name cards retain presentation but remove executable and navigable markup', () => {
  const h = harness();
  try {
    const source = h.cardDocument('<style>.name{color:red}</style><div class="name" style="font-weight:bold" onclick="alert(1)"><b>Card</b><script>alert(1)</script><a href="https://example.com">link</a><img src="https://example.com/x"><iframe srcdoc="x"></iframe><meta http-equiv="refresh" content="0;url=https://example.com"></div>', 'rgb(12, 34, 56)');
    const page = new JSDOM(source);
    assert.ok(page.window.document.querySelector('b'));
    assert.match(source, /color:red/);
    assert.match(source, /color:rgb\(12, 34, 56\)/);
    assert.equal(page.window.document.querySelector('script,a,img,iframe,[onclick],meta[http-equiv="refresh"]'), null);
    assert.match(page.window.document.querySelector('meta').content, /default-src 'none'/);
    page.window.close();
  } finally { h.dom.window.close(); }
});

test('custom cards use a fixed isolated frame and empty cards fall back to the current name', () => {
  const h = harness();
  try {
    for (const html of [undefined, null, '', '  ', '<img src="x">', '<style></style>', '<div style="display:none">Hidden</div>', '<div style="width:0">Hidden</div>', '<style>.name{display:none!important}</style><div class="name">Hidden</div>']) {
      const fallback = h.AssistantCard({ name: 'Assistant', html });
      assert.match(fallback.props.className, /ba-card-brand/);
      assert.equal(fallback.children[1].children[1].children[0], 'Assistant');
    }
    const card = h.AssistantCard({ name: 'Assistant', html: '<b>Card</b>' });
    const frame = card.children[1];
    assert.equal(frame.type, 'iframe');
    assert.equal(frame.props.sandbox, '');
    assert.equal(frame.props.tabIndex, -1);
    assert.equal(frame.props.referrerPolicy, 'no-referrer');
    assert.ok(frame.props.srcDoc.includes('<b>Card</b>'));
  } finally { h.dom.window.close(); }
});

test('theme colors cannot inject markup and the frame keeps its constrained layout', () => {
  const h = harness();
  try {
    const source = h.cardDocument('<style>body{height:800px}</style><b>Card</b>', '</style><script>bad()</script>');
    assert.doesNotMatch(source, /<script>/);
    assert.match(source, /width:160px!important;height:40px!important/);
    assert.ok(h.inspectCardHtml('<div style="height:800px">Card</div>').issues.length);
    assert.equal(h.AssistantCard({ name: 'A', onOpen() {} }).type, 'button');
  } finally { h.dom.window.close(); }
});

test('unsupported containers preserve safe children and report filtered content', () => {
  const h = harness();
  try {
    const result = h.inspectCardHtml('<section><h2>Hello</h2><script>bad()</script></section>');
    assert.equal(result.html, 'Hello');
    assert.equal(result.hasContent, true);
    assert.equal(result.issues.length, 3);
    assert.match(h.cardDocument('<b>Card</b>', '#222', false), /animation:none!important/);
  } finally { h.dom.window.close(); }
});

test('empty styling is not content but a painted CSS mark is supported', () => {
  const h = harness();
  try {
    for (const html of ['<div style=""></div>', '<span style="font-weight:bold"></span>', '<div style="width:20px;height:20px"></div>']) assert.equal(h.inspectCardHtml(html).hasContent, false);
    assert.equal(h.inspectCardHtml('<div style="width:20px;height:20px;background:red"></div>').hasContent, true);
    assert.equal(h.AssistantCard({ name: 'A', motion: false }).props['data-motion'], 'off');
    assert.match(h.cardDocument('<b>A</b>', '#222', false), /animation-play-state:paused!important/);
    assert.match(h.cardDocument('<b>A</b>', '#222'), /prefers-reduced-motion:reduce/);
  } finally { h.dom.window.close(); }
});
