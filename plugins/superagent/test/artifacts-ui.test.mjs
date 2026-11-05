import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const { transformSync } = createRequire(new URL('../../benchgo/package.json', import.meta.url))('esbuild');
const code = transformSync(readFileSync(new URL('../client/artifacts.jsx', import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs' }).code;
const walk = node => node?.children ? [node, ...node.children.flatMap(walk), ...walk(node.props.footer)] : [];
const settle = () => new Promise(resolve => setImmediate(resolve));
function harness({ failDelete } = {}) {
  let cursor = 0;
  const hooks = [], effects = [], calls = [];
  let files = ['a.md', 'b.md'].map(name => ({ id: name, name, hash: name + '-version', bytes: 1, updatedAt: '2026-11-03', url: '/file' }));
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(value => value !== false && value != null) }),
    useId: () => 'files',
    useState(initial) { const index = cursor++; if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial; return [hooks[index], value => { hooks[index] = typeof value === 'function' ? value(hooks[index]) : value; }]; },
    useRef(initial) { return hooks[cursor++] ||= { current: initial }; },
    useEffect(effect) { const index = cursor++; if (!(index in hooks)) { hooks[index] = true; effects.push(effect); } },
  };
  const module = { exports: {} };
  const primitives = Object.fromEntries(['Modal', 'Menu', 'Tooltip', 'IconDownloadOutlineRegular'].map(name => [name, name]));
  runInNewContext(code, { module, exports: module.exports, AbortController, localStorage: { getItem: () => null, setItem() {} }, require: id => id === 'react' ? react : id.includes('ui-primitives') ? primitives : id.endsWith('button.jsx') ? { Button: 'button' } : id.endsWith('segmented-control.jsx') ? { SegmentedControl: 'tabs' } : {} });
  const api = async (action, input) => {
    calls.push({ action, ...input });
    if (action === 'artifacts') return { artifacts: files, total: files.length, nextCursor: null };
    if (action === 'artifactDelete') { if (input.file === failDelete) throw new Error('File changed'); files = files.filter(file => file.name !== input.file); }
    return {};
  };
  const render = () => { cursor = 0; const tree = module.exports.Artifacts({ api }); effects.splice(0).forEach(effect => effect()); return walk(tree); };
  return { render, calls };
}
const button = (nodes, text) => nodes.find(node => node.type === 'button' && node.children.includes(text));

test('rename sends the file version only after confirmation', async () => {
  const h = harness(); h.render(); await settle();
  h.render().find(node => node.props['aria-label'] === '管理 a.md').props.onClick({ currentTarget: {} });
  button(h.render(), '重命名').props.onClick();
  h.render().find(node => node.type === 'input' && node.props.autoFocus).props.onChange({ target: { value: 'renamed.md' } });
  assert.equal(h.calls.length, 1);
  await button(h.render(), '保存').props.onClick();
  assert.deepEqual(h.calls[1], { action: 'artifactRename', file: 'a.md', expectedHash: 'a.md-version', name: 'renamed.md' });
  assert.equal(h.calls[2].action, 'artifacts');
});

test('batch delete confirms selected files and reports partial failures', async () => {
  const h = harness({ failDelete: 'b.md' }); h.render(); await settle();
  button(h.render(), '全选已加载文件').props.onClick();
  button(h.render(), '删除所选').props.onClick();
  assert.equal(h.calls.length, 1);
  await button(h.render(), '删除').props.onClick();
  assert.deepEqual(h.calls.filter(call => call.action === 'artifactDelete').map(call => call.file), ['a.md', 'b.md']);
  const nodes = h.render();
  assert.ok(nodes.some(node => node.children.includes('已删除 1 个文件')));
  assert.ok(nodes.some(node => node.children.includes('b.md：File changed')));
  assert.equal(nodes.filter(node => node.props.type === 'checkbox').length, 1);
});
