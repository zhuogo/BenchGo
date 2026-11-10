import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const { transformSync } = createRequire(new URL('../../benchgo/package.json', import.meta.url))('esbuild');
const code = transformSync(readFileSync(new URL('../client/documents.jsx', import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs' }).code;
const walk = node => node && typeof node === 'object' ? [node, ...node.children.flatMap(walk)] : [];
const settle = () => new Promise(resolve => setImmediate(resolve));

function harness({ updateError, memory = false } = {}) {
  let cursor = 0, confirmed = false, refreshes = 0;
  const hooks = [], effects = [], calls = [];
  let document = { name: memory ? 'MEMORY.md' : 'USER.md', content: '原始正文', hash: 'original-hash' };
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(value => value !== false && value != null) }),
    useId: () => 'documents-panel',
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = initial;
      return [hooks[index], value => { hooks[index] = typeof value === 'function' ? value(hooks[index]) : value; }];
    },
    useRef(initial) {
      const index = cursor++;
      return hooks[index] ||= { current: initial };
    },
    useEffect(effect) {
      const index = cursor++;
      if (!(index in hooks)) { hooks[index] = true; effects.push(effect); }
    },
  };
  const module = { exports: {} };
  runInNewContext(code, { module, exports: module.exports, window: { confirm: () => confirmed }, require: id => id.endsWith('/ui/confirmation.jsx') ? { useConfirmation: () => [async () => confirmed, null] } : id.endsWith('/ui/button.jsx') ? { Button: 'button' } : id === 'react' ? react : {} });
  const props = {
    memory,
    api: async (action, payload) => {
      calls.push({ action, ...payload });
      if (payload.op === 'list') return { documents: [document] };
      if (payload.op === 'update') {
        if (updateError) throw new Error(updateError);
        document = { ...document, content: payload.content, hash: 'saved-hash' };
        return { document };
      }
      throw new Error(`Unexpected operation: ${payload.op}`);
    },
    refresh: async () => { refreshes++; },
  };
  const render = () => {
    cursor = 0;
    const tree = module.exports.AssistantDocuments(props);
    effects.splice(0).forEach(effect => effect());
    return walk(tree);
  };
  return { render, calls, confirm: value => { confirmed = value; }, get refreshes() { return refreshes; } };
}

test('profile editing reads and saves without version requests and carries the original hash', async () => {
  const h = harness();
  h.render(); await settle();
  let nodes = h.render();
  assert.equal(nodes.find(node => node.props.label === '档案文件').props.options.length, 5);
  assert.ok(nodes.find(node => node.props.label === '档案文件').props.options.every(option => option.value !== 'MEMORY.md'));
  assert.equal(nodes.some(node => node.type === 'details'), false);
  nodes.find(node => node.type === 'textarea').props.onChange({ target: { value: '更新正文' } });
  nodes = h.render();
  assert.equal(nodes.find(node => node.props.label === '档案文件').props.disabled, true);
  await nodes.find(node => node.type === 'button' && node.children.includes('保存')).props.onClick();
  nodes = h.render();
  assert.deepEqual(h.calls.map(call => call.op), ['list', 'update']);
  assert.equal(h.calls[1].expectedHash, 'original-hash');
  assert.equal(h.calls[1].content, '更新正文');
  assert.equal(h.refreshes, 1);
  assert.equal(nodes.find(node => node.type === 'textarea').props.value, '更新正文');
  assert.equal(nodes.find(node => node.props.label === '档案文件').props.disabled, false);
});

test('conflicting saves retain the draft and reload discards it only after confirmation', async () => {
  const h = harness({ updateError: '文件已被修改，请重新载入' });
  h.render(); await settle();
  h.render().find(node => node.type === 'textarea').props.onChange({ target: { value: '我的草稿' } });
  await h.render().find(node => node.type === 'button' && node.children.includes('保存')).props.onClick();
  let nodes = h.render();
  assert.equal(nodes.find(node => node.type === 'textarea').props.value, '我的草稿');
  assert.ok(nodes.some(node => node.props.role === 'alert' && node.children.includes('文件已被修改，请重新载入')));
  nodes.find(node => node.type === 'button' && node.children.includes('重新载入')).props.onClick();
  await settle();
  assert.equal(h.calls.length, 2);
  assert.equal(h.render().find(node => node.type === 'textarea').props.value, '我的草稿');
  h.confirm(true);
  h.render().find(node => node.type === 'button' && node.children.includes('重新载入')).props.onClick();
  await settle();
  nodes = h.render();
  assert.equal(h.calls.length, 3);
  assert.equal(nodes.find(node => node.type === 'textarea').props.value, '原始正文');
});

test('memory editing saves without a version timeline or history requests', async () => {
  const h = harness({ memory: true }); h.render(); await settle();
  let nodes = h.render();
  assert.equal(nodes.some(node => node.props.label === '档案文件'), false);
  assert.equal(nodes.some(node => node.props.className === 'ba-document-history'), false);
  nodes.find(node => node.type === 'textarea').props.onChange({ target: { value: '更新记忆' } });
  await h.render().find(node => node.type === 'button' && node.children.includes('保存')).props.onClick();
  assert.deepEqual(h.calls.map(call => call.op), ['list', 'update']);
  assert.equal(h.calls[1].name, 'MEMORY.md');
  assert.equal(h.render().find(node => node.type === 'textarea').props.value, '更新记忆');
});
