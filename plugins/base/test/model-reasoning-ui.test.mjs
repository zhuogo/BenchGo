import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import * as reasoning from '../client/model-reasoning-state.mjs';

const code = transformSync(readFileSync(new URL('../client/model-reasoning.jsx', import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs' }).code;
let cursor = 0, values = [];
const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  useState(initial) {
    const index = cursor++;
    return [values[index] ?? initial, value => { values[index] = value; }];
  },
};
const module = { exports: {} };
runInNewContext(code, { module, exports: module.exports, require: id => id === 'react' ? react
  : id.includes('/ui/') ? { Button: 'button' } : id.endsWith('select.jsx') ? { Select: 'select' } : reasoning });

function nodes(node) {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(nodes);
  return [node, ...nodes(node.props?.children)];
}

function editor(model, props = {}) {
  let retained;
  values = [];
  const render = () => { cursor = 0; return module.exports.ModelReasoningEditor({
    model, retained, position: 2, styles: {}, ...props,
    onChange: (next, mapping) => { model = next; retained = mapping; },
  }); };
  const buttons = () => nodes(render()).filter(node => node.type === 'button');
  return {
    get model() { return model; },
    render,
    buttons,
    select(label) { buttons().find(node => node.props.children[0] === label).props.onClick(); },
  };
}

test('reasoning validates official adapter constraints before a settings write', () => {
  for (const value of [undefined, false, { off: null, high: 'deep' }, { off: 'none', low: 'basic', high: 'deep' }]) {
    assert.equal(reasoning.reasoningError(value), undefined);
  }
  for (const value of [null, true, [], {}, { off: null }, { off: 'off' }, { high: null }, { high: '' }, { high: ' ' }, { ultra: 'deep' }]) {
    assert.equal(typeof reasoning.reasoningError(value), 'string');
  }
  assert.match(reasoning.validateModelReasoning([{ id: 'a' }, { id: 'b', reasoningEfforts: { high: null } }]), /模型 2/);
  assert.equal(reasoning.validateModelReasoning(undefined), undefined);
});

test('the editor displays inherited levels directly and preserves wire values when changing the selection', () => {
  const model = { id: 'm', maxTokens: 32000, compat: { supportsReasoningEffort: true } };
  const h = editor(model, { inherited: { off: null, low: 'basic', high: 'deep' }, defaultEffort: 'high' });
  assert.deepEqual(h.buttons().map(node => node.props.children[0]), ['关闭', '低 · basic', '高 · deep（默认）', '自定义档位']);
  assert(h.buttons().slice(0, 3).every(node => node.props['aria-pressed']));
  assert.equal(h.model, model);

  h.select('低 · basic');
  assert.deepEqual(JSON.parse(JSON.stringify(h.model.reasoningEfforts)), { off: null, high: 'deep' });
  assert.equal(h.buttons()[1].props['aria-pressed'], false);
  h.select('低 · basic');
  assert.deepEqual(h.model, { ...model });
});

test('existing custom levels can be removed and restored in one draft', () => {
  const h = editor({ id: 'm', reasoningEfforts: { off: 'none', high: 'deep' } });
  h.select('关闭');
  assert.deepEqual(JSON.parse(JSON.stringify(h.model.reasoningEfforts)), { high: 'deep' });
  h.select('高 · deep');
  assert.equal(h.model.reasoningEfforts, false);
  assert.equal(h.buttons()[0].props.disabled, true);
  h.select('高 · deep');
  assert.deepEqual(JSON.parse(JSON.stringify(h.model.reasoningEfforts)), { high: 'deep' });
  h.select('关闭');
  assert.deepEqual(JSON.parse(JSON.stringify(h.model.reasoningEfforts)), { high: 'deep', off: 'none' });
});

test('custom supplier labels can be added without creating an off slot', () => {
  const h = editor({ id: 'plain', reasoningEfforts: false });
  h.select('自定义档位');
  nodes(h.render()).find(node => node.type === 'select').props.onChange({ target: { value: 'high' } });
  nodes(h.render()).find(node => node.type === 'input').props.onChange({ target: { value: 'Vendor/Ultra' } });
  h.select('应用档位');
  assert.deepEqual(JSON.parse(JSON.stringify(h.model.reasoningEfforts)), { high: 'Vendor/Ultra' });
  assert(nodes(editor({ id: 'm', reasoningEfforts: {} }).render()).some(node => node.props?.role === 'alert'));
  assert(editor({ id: 'm', reasoningEfforts: { high: 'deep' } }, { disabled: true }).buttons().every(node => node.props.disabled));
});
