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
    require: id => id === 'react' ? react : id.endsWith('time-groups.mjs') ? { groupByDay } : id.endsWith('button.jsx') ? { Button: 'button' } : id.endsWith('collapsible.jsx') ? { Disclosure: 'disclosure' } : {},
  });
  const render = () => { cursor = 0; return walk(module.exports.MemoryFeed({ api, refresh, entries, threadId: 'main' })); };
  const button = label => render().find(node => node.type === 'button' && walk(node).some(child => child.children.includes(label)));
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
  assert.equal(calls[0].input.memory.source.type, 'user-edit');
  assert.equal(calls[0].input.memory.source.messageId, undefined);
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

test('memory timeline exposes original sources and version references with local display times', () => {
  const updatedAt = '2026-11-05T06:45:00.000Z';
  const entry = { id: 'memory-2', content: '新偏好', revision: 2, updatedAt, document: 'MEMORY.md',
    source: { messageId: 'source-message', sessionId: 'source-session', excerpt: '用户原始表述', excerptTruncated: true },
    versionChain: [{ id: 'memory-2', revision: 1, updatedAt: '2026-11-04T06:45:00.000Z' }] };
  const f = fixture({ api: async () => {}, entries: [entry] });
  const nodes = f.render();
  assert.deepEqual(nodes.filter(node => node.type === 'disclosure').map(node => node.props.title), ['来源原文', '替代版本 · 1 次']);
  assert.ok(nodes.some(node => node.type === 'p' && node.children.includes('用户原始表述')));
  assert.ok(nodes.some(node => node.type === 'p' && node.children.includes('原文较长，已保留前 6000 个字符。')));
  const times = nodes.filter(node => node.type === 'time');
  assert.equal(times[0].props.dateTime, updatedAt);
  assert.ok(times.every(node => !node.children.includes(node.props.dateTime)));
  assert.ok(nodes.some(node => node.type === 'li' && node.children.includes(1)));
  const old = fixture({ api: async () => {}, entries: [{ ...entry, source: { messageId: 'old-message' }, versionChain: [] }] });
  assert.equal(old.render().some(node => node.type === 'p' && node.children.includes('此记录未保存来源原文。')), false);
  assert.equal(old.render().filter(node => node.type === 'disclosure').length, 1);
  const noSource = fixture({ api: async () => {}, entries: [{ ...entry, source: {}, versionChain: [] }] });
  assert.equal(noSource.render().filter(node => node.type === 'disclosure').length, 0);
});

test('failed deletion preserves the editing draft and observed revision', async () => {
  const entry = { id: 'memory-delete', content: '原记忆', revision: 4, document: 'MEMORY.md' };
  let request;
  const f = fixture({ entries: [entry], api: async (action, input) => { request = { action, input }; throw new Error('删除失败'); } });
  f.button('编辑').props.onClick();
  f.write('尚未保存的编辑内容');
  await f.button('忘记').props.onClick();
  assert.equal(f.draft(), '尚未保存的编辑内容');
  assert.equal(request.action, 'memoryDelete');
  assert.equal(request.input.revision, 4);
  assert.equal(f.button('保存修改').props.disabled, false);
});
