import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { runInNewContext } from 'node:vm';

const code = transformSync(readFileSync(new URL('../client/tools-page.jsx', import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs' }).code;
test('tools wrapper preserves official plugin manager contract and restores it on dispose', () => {
  const module = { exports: {} };
  const react = { createElement: (type, props) => ({ type, props }) };
  runInNewContext(code, { module, exports: module.exports, require: name => name === 'react' ? react : {} });
  const original = () => null, inject = () => ({ account: 'official' }), store = {}, children = { 'plugins.item': {} };
  const entry = { component: original, options: { key: 'plugins' }, inject, store, children };
  let dispose;
  module.exports.mountToolsPage({ effect: effect => { dispose = effect(); }, slots: { entries: name => { assert.equal(name, 'main'); return [entry]; } } });
  assert.notEqual(entry.component, original);
  assert.equal(entry.inject, inject);
  assert.equal(entry.store, store);
  assert.equal(entry.children, children);
  const props = { useStore() {}, actions: {}, renderSlot() {} }, node = entry.component(props);
  assert.equal(node.props.OfficialPage, original);
  for (const key of Object.keys(props)) assert.equal(node.props[key], props[key]);
  dispose();
  assert.equal(entry.component, original);
});

test('tools tabs retain the official page and reveal deep-linked plugin views', () => {
  let tab = 'plugins', effect;
  const module = { exports: {} }, OfficialPage = () => null;
  const react = { createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat().filter(Boolean) }),
    useId: () => 'tools', useState: () => [tab, value => { tab = value; }], useEffect: callback => { effect = callback; } };
  const SegmentedControl = () => null, SkillsLibrary = () => null;
  runInNewContext(code, { module, exports: module.exports, require: name => name === 'react' ? react : { SegmentedControl, SkillsLibrary } });
  const walk = node => node && typeof node === 'object' && node.props ? [node, ...node.children.flatMap(walk)] : [];
  let view = { kind: 'list' };
  const props = { OfficialPage, useStore: select => select({ view }), actions: {}, renderSlot() {} };
  const render = () => walk(module.exports.ToolsPage(props));
  let nodes = render();
  assert.equal(nodes.find(node => node.type === OfficialPage).props.actions, props.actions);
  nodes.find(node => node.type === SegmentedControl).props.onChange('skills');
  nodes = render();
  assert.equal(nodes.find(node => node.props.className === 'bg-tools-official').props.hidden, true);
  assert(nodes.some(node => node.type === SkillsLibrary));
  view = { kind: 'detail', name: 'benchgo-plugin' };
  render(); effect(); nodes = render();
  assert.equal(nodes.find(node => node.props.className === 'bg-tools-official').props.hidden, false);
  assert(!nodes.some(node => node.type === SkillsLibrary));
});
