import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build, transformSync } from 'esbuild';
import { readFileSync } from 'node:fs';
import { sharedUiStyles } from '../scripts/shared-ui.mjs';

const require = createRequire(new URL('../../link/package.json', import.meta.url));
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const result = await build({
  entryPoints: [fileURLToPath(new URL('../../shared/client/ui/index.jsx', import.meta.url))],
  bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  alias: { '@deepseek-ai/dsh-client-ui-primitives': fileURLToPath(new URL('../../../deepseek-harness/packages/client/ui-primitives/src/Tooltip.tsx', import.meta.url)) },
  nodePaths: [fileURLToPath(new URL('../node_modules', import.meta.url))],
  plugins: [sharedUiStyles()], loader: { '.css': 'text', '.module.css': 'text' }, metafile: true,
});
const module = { exports: {} };
new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports);
const { Button, Disclosure } = module.exports;
const render = (component, props, child) => renderToStaticMarkup(React.createElement(component, props, child));

test('shared buttons preserve form safety, explicit submit and disabled actions', () => {
  assert.match(render(Button, {}, '保存'), /type="button"/);
  const submit = render(Button, { type: 'submit', disabled: true }, '保存');
  assert.match(submit, /type="submit"/);
  assert.match(submit, /disabled=""/);
  const link = render(Button, { asChild: true }, React.createElement('a', { href: '/settings' }, '设置'));
  assert.match(link, /<a[^>]*href="\/settings"/);
  assert.doesNotMatch(link, /<button/);
  const hinted = render(Button, { title: '删除草稿' }, React.createElement('svg'));
  assert.match(hinted, /aria-label="删除草稿"/);
  assert.doesNotMatch(hinted, / title=/);
  assert.match(render(Button, { title: '补充说明', 'aria-label': '明确操作' }, '操作'), /aria-label="明确操作"/);
});

test('disclosures expose accessible expanded state and keep closed content hidden', () => {
  const closed = render(Disclosure, { title: '高级设置' }, 'private-detail');
  assert.match(closed, /aria-expanded="false"/);
  assert.match(closed, /hidden=""/);
  assert.doesNotMatch(closed, /private-detail/);
  const open = render(Disclosure, { title: '高级设置', defaultOpen: true }, 'private-detail');
  assert.match(open, /aria-expanded="true"/);
  assert.match(open, /aria-controls="[^"]+"/);
  assert.match(open, /private-detail/);
  assert.match(open, /type="button"/);
});

test('shared UI bundle keeps React supplied by its host and emits prefixed utilities', () => {
  const inputs = Object.keys(result.metafile.inputs);
  assert(!inputs.some(path => /node_modules[\\/]react(?:-dom)?[\\/]/.test(path)));
  assert(result.outputFiles[0].text.includes('bg\\\\:inline-flex'));
  assert(!result.outputFiles[0].text.includes('tailwindcss/preflight'));
});

test('shared styles survive sibling unmounts, refresh on reload and clean up the last mount', () => {
  let node;
  const cleanup = [];
  const document = {
    getElementById: () => node,
    createElement: () => ({ dataset: {}, textContent: '', remove() { node = undefined; } }),
    head: { append(value) { node = value; } },
  };
  const source = readFileSync(new URL('../../shared/client/ui/styles.jsx', import.meta.url), 'utf8');
  const code = transformSync(source, { loader: 'jsx', format: 'cjs' }).code;
  function mount(css) {
    const module = { exports: {} };
    const require = name => name === 'react' ? { useInsertionEffect: fn => cleanup.push(fn()) } : css;
    new Function('require', 'module', 'exports', 'document', code)(require, module, module.exports, document);
    module.exports.UiStyles();
  }
  mount('old'); mount('old');
  assert.equal(node.dataset.users, '2');
  cleanup.shift()();
  assert.equal(node.dataset.users, '1');
  mount('new');
  assert.equal(node.textContent, 'new');
  cleanup.shift()();
  assert(node);
  cleanup.shift()();
  assert.equal(node, undefined);
});
