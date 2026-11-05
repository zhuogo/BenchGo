import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { groupByDay } from '../client/time-groups.mjs';

const { transformSync } = createRequire(new URL('../../benchgo/package.json', import.meta.url))('esbuild');
const walk = node => node && typeof node === 'object' && node.props ? [node, ...node.children.flatMap(walk)] : [];
function fixture({ api, refresh = async () => {}, entries = [] }) {
  let cursor = 0, confirmations = 0;
  const hooks = [], react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(value => value != null && value !== false) }),
    useId: () => 'memory-content', useEffect() {},
    useRef(value) { const index = cursor++; return hooks[index] ||= { current: value }; },
    useState(value) { const index = cursor++; if (!(index in hooks)) hooks[index] = value; return [hooks[index], next => { hooks[index] = typeof next === 'function' ? next(hooks[index]) : next; }]; },
  };
  const module = { exports: {} };
  const code = transformSync(readFileSync(new URL('../client/memory.jsx', import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs' }).code;
  runInNewContext(code, { module, exports: module.exports,
    window: { confirm() { confirmations++; return true; }, matchMedia: () => ({ matches: true }) },
    require: id => id === 'react' ? react : id.endsWith('time-groups.mjs') ? { groupByDay } : id.endsWith('button.jsx') ? { Button: 'button' } : {},
  });
  const render = () => { cursor = 0; return walk(module.exports.MemoryFeed({ api, refresh, entries, threadId: 'main' })); };
  const button = label => render().find(node => node.type === 'button' && node.children.includes(label));
  return {
    render, button, confirmations: () => confirmations,
    draft: () => render().find(node => node.type === 'textarea').props.value,
    write: value => render().find(node => node.type === 'textarea').props.onChange({ target: { value } }),
    save: () => render().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }),
  };
}

test('failed memory saves keep the draft and allow retry', async () => {
  let fail = true, writes = 0;
  const f = fixture({ api: async action => { assert.equal(action, 'memorySave'); writes++; if (fail) throw new Error('写入失败'); } });
  f.write('偏好简洁中文');
  await f.save();
  assert.equal(f.draft(), '偏好简洁中文');
  assert.ok(f.render().some(node => node.props.role === 'alert' && node.children.some(child => child.children?.includes('写入失败'))));
  assert.equal(f.button('记下来').props.disabled, false);
  fail = false;
  await f.save();
  assert.equal(f.draft(), '');
  assert.equal(writes, 2);
});

test('a successful save followed by refresh failure retries only the refresh', async () => {
  let writes = 0, reads = 0;
  const f = fixture({ api: async () => { writes++; }, refresh: async () => { if (++reads === 1) throw new Error('网络中断'); } });
  f.write('项目使用官方入口');
  await f.save();
  assert.equal(f.draft(), '');
  assert.equal(f.button('记下来').props.disabled, true);
  await f.button('重试刷新').props.onClick();
  assert.equal(writes, 1);
  assert.equal(reads, 2);
});

test('editing and forgetting pass the observed revision without confirmation', async () => {
  const calls = [], entry = { id: 'memory-1', content: '旧偏好', revision: 3, source: { messageId: 'user-1' }, document: 'MEMORY.md' };
  const f = fixture({ entries: [entry], api: async (action, input) => { calls.push({ action, input }); } });
  f.button('编辑').props.onClick();
  assert.equal(f.button('保存修改').props.disabled, true);
  f.write('新偏好');
  await f.save();
  assert.equal(calls[0].action, 'memorySave');
  assert.equal(calls[0].input.revision, 3);
  assert.equal(calls[0].input.memory.id, entry.id);
  assert.equal(calls[0].input.memory.content, '新偏好');
  await f.button('忘记').props.onClick();
  assert.equal(calls[1].action, 'memoryDelete');
  assert.equal(calls[1].input.id, entry.id);
  assert.equal(calls[1].input.revision, 3);
  assert.equal(f.confirmations(), 0);
});

test('rapid repeated submits persist a memory only once', async () => {
  let release, writes = 0;
  const f = fixture({ api: async () => { writes++; await new Promise(resolve => { release = resolve; }); } });
  f.write('只保存一次');
  const saving = f.save();
  await f.save();
  assert.equal(writes, 1);
  release(); await saving;
  assert.equal(f.draft(), '');
});
