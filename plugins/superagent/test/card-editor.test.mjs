import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const { transformSync } = createRequire(new URL('../../benchgo/package.json', import.meta.url))('esbuild');
const code = transformSync(readFileSync(new URL('../client/identity-card-editor.jsx', import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs' }).code;
const walk = node => node && typeof node === 'object' && node.props ? [node, ...(node.children || []).flatMap(walk)] : [];
function editor(config) {
  let cursor = 0;
  const hooks = [], changes = [];
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(Boolean) }),
    useId: () => 'card-editor', useMemo: fn => fn(),
    useState: initial => { const at = cursor++; if (!(at in hooks)) hooks[at] = initial; return [hooks[at], value => { hooks[at] = value; }]; },
  };
  const module = { exports: {} };
  runInNewContext(code, { module, exports: module.exports, require: id => id.endsWith('/ui/button.jsx') ? { Button: 'button' } : id.endsWith('/ui/collapsible.jsx') ? { Disclosure: 'Disclosure' } : id === 'react' ? react : id.endsWith('/card.jsx') ? { inspectCardHtml: () => ({ issues: [] }) } : {} });
  return {
    changes,
    render() {
      cursor = 0;
      return walk(module.exports.IdentityCardEditor({ config, defaultName: 'BenchGo', onChange: patch => { changes.push(patch); config = { ...config, ...patch }; } }));
    },
  };
}

const toggle = nodes => nodes.find(node => node.type === 'button' && 'aria-expanded' in node.props);

test('code editor toggles without changing the card and retains edits across toggles', () => {
  const h = editor({ name: 'A', cardHtml: '<b>Original</b>', cardMotion: true, models: ['opaque'] });
  let nodes = h.render();
  assert.equal(nodes.some(node => node.type === 'textarea'), false);
  assert.equal(toggle(nodes).props['aria-expanded'], false);
  toggle(nodes).props.onClick();
  nodes = h.render();
  assert.equal(h.changes.length, 0);
  assert.equal(nodes.find(node => node.type === 'textarea').props.value, '<b>Original</b>');
  nodes.find(node => node.type === 'textarea').props.onChange({ target: { value: '<b>Edited</b>' } });
  nodes = h.render();
  toggle(nodes).props.onClick();
  nodes = h.render();
  assert.equal(nodes.some(node => node.type === 'textarea'), false);
  toggle(nodes).props.onClick();
  nodes = h.render();
  assert.equal(nodes.find(node => node.type === 'textarea').props.value, '<b>Edited</b>');
  assert.equal(nodes.find(node => node.type === 'textarea').props.maxLength, 16000);
  assert.deepEqual(JSON.parse(JSON.stringify(h.changes)), [{ cardHtml: '<b>Edited</b>' }]);
});

test('default card stays unchanged until input and has only the code toggle button', () => {
  const h = editor({ name: 'A', cardHtml: null, cardMotion: false });
  let nodes = h.render();
  assert.equal(nodes.filter(node => node.type === 'button').length, 1);
  assert.equal(nodes.some(node => node.type === 'textarea' || node.type === 'select'), false);
  assert.equal(nodes.find(node => node.props.role === 'switch').props.checked, false);
  toggle(nodes).props.onClick();
  nodes = h.render();
  assert.equal(h.changes.length, 0);
  assert.equal(nodes.find(node => node.type === 'textarea').props.value, '');
  nodes.find(node => node.type === 'textarea').props.onChange({ target: { value: '<b>Custom</b>' } });
  nodes = h.render();
  assert.equal(nodes.some(node => node.props.role === 'switch'), false);
  assert.deepEqual(JSON.parse(JSON.stringify(h.changes)), [{ cardHtml: '<b>Custom</b>' }]);
});
