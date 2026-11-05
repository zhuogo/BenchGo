import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
const { transformSync } = createRequire(new URL('../../benchgo/package.json', import.meta.url))('esbuild');
const walk = node => node && typeof node === 'object' && node.props ? [node, ...(node.children || []).flatMap(walk)] : [];
function harness(path) {
  let cursor = 0; const hooks = [];
  const react = { createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(value => value != null && value !== false) }), useId: () => 'test', useEffect() {}, useLayoutEffect() {}, useRef: value => { const at = cursor++; return hooks[at] ||= { current: value }; }, useState: value => { const at = cursor++; if (!(at in hooks)) hooks[at] = value; return [hooks[at], next => { hooks[at] = typeof next === 'function' ? next(hooks[at]) : next; }]; } };
  const module = { exports: {} };
  const code = transformSync(readFileSync(new URL(path, import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs' }).code;
  runInNewContext(code, { module, exports: module.exports, document: { body: {} }, require: id => id === 'react' ? react : id === 'react-dom' ? { createPortal: value => value } : {} });
  return (name, props) => { cursor = 0; return walk(module.exports[name](props)); };
}
test('searchable selector preserves opaque custom IDs and keyboard selection', () => {
  const render = harness('../../shared/client/custom-select.jsx'), selected = [];
  const props = { value: 'Old:ID', options: [{ value: 'Exact:Model/09', label: 'Model' }], searchable: true, allowCustom: true, onChange: value => selected.push(value) };
  let nodes = render('CustomSelect', props);
  assert.ok(nodes.some(node => node.children.includes('Old:ID')));
  nodes.find(node => node.type === 'button').props.onClick();
  nodes = render('CustomSelect', props);
  nodes.find(node => node.props.role === 'combobox').props.onChange({ target: { value: 'Opaque:ID / 09' } });
  nodes = render('CustomSelect', props);
  assert.ok(nodes.some(node => node.props.role === 'option' && node.children.some(child => child.children?.includes('使用完整 ID：Opaque:ID / 09'))));
  nodes.find(node => node.props.className === 'dowork-select-popup').props.onKeyDown({ key: 'Enter', preventDefault() {} });
  assert.deepEqual(selected, ['Opaque:ID / 09']);
  assert.equal(render('CustomSelect', props).find(node => node.type === 'button').props['aria-expanded'], false);
});
test('capsule tabs support arrows and keep panel relationships', () => {
  const render = harness('../../shared/client/segmented-control.jsx'), selected = [];
  const nodes = render('SegmentedControl', { options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], value: 'a', panelId: 'panel', onChange: value => selected.push(value) });
  const tabs = nodes.filter(node => node.props.role === 'tab');
  assert.equal(tabs[0].props.id, 'panel-a');
  assert.equal(tabs[0].props['aria-controls'], 'panel');
  assert.equal(tabs[1].props.tabIndex, -1);
  tabs[0].props.onKeyDown({ key: 'ArrowLeft', preventDefault() {} });
  assert.deepEqual(selected, ['b']);
});
test('resource frontend removes profile transfer while sharing capsule controls', () => {
  const source = file => readFileSync(new URL('../client/' + file, import.meta.url), 'utf8');
  assert.doesNotMatch(source('index.jsx'), /profileExport|profileImport|AssistantGovernance/);
  assert.match(source('artifacts.jsx'), /SegmentedControl/);
  assert.match(source('memory.jsx'), /<AssistantDocuments[^>]+memory/);
  assert.match(source('documents.jsx'), /name !== 'MEMORY.md'/);
});
