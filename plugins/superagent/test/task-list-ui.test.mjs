import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import * as ticketTitle from '../src/ticket-title.mjs';
const { transformSync } = createRequire(new URL('../../benchgo/package.json', import.meta.url))('esbuild');
const code = transformSync(readFileSync(new URL('../client/task-list.jsx', import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs' }).code;
const walk = node => node && typeof node === 'object' && node.props ? [node, ...(node.children || []).flatMap(walk)] : [];
function harness(fail = false) {
  let cursor = 0, changed = 0, opened = 0; const state = [], calls = [], module = { exports: {} };
  const react = { useEffect() {}, createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }), useState: initial => { const i = cursor++; if (!(i in state)) state[i] = initial; return [state[i], value => state[i] = value]; } };
  runInNewContext(code, { module, exports: module.exports, window: { confirm: () => true }, require: id => id.endsWith('/ui/confirmation.jsx') ? { useConfirmation: () => [async () => true, null] } : id === 'react' ? react : id.endsWith('ticket-title.mjs') ? ticketTitle : id.endsWith('.css') ? '' : {} });
  const props = { kind: 'ticket', row: { id: 't1', taskMeta: { version: 4 } }, title: 'Task', summary: 'Summary', onChanged: () => changed++, onOpen: () => opened++, api: async (...args) => { calls.push(args); if (fail) throw new Error('版本冲突'); } };
  return { calls, get changed() { return changed; }, get opened() { return opened; }, render(extra = {}) { cursor = 0; return walk(module.exports.TaskListRow({ ...props, ...extra })); } };
}
test('completion and delete retain version and refresh only after success', async () => {
  const h = harness();
  await h.render().find(n => n.props.type === 'checkbox').props.onChange();
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0])), ['taskUpdate', { kind: 'ticket', id: 't1', operation: 'complete', version: 4 }]);
  assert.equal(h.changed, 1);
  h.render().find(n => n.props.label === '删除').props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls[1][1].operation, 'delete');
  h.render().find(n => n.props.className === 'ba-task-open').props.onClick();
  assert.equal(h.opened, 1);
});
test('rename submits display title and conflicts preserve draft', async () => {
  const h = harness(true);
  h.render().find(n => n.props.label === '重命名').props.onClick();
  h.render().find(n => n.props['aria-label'] === '任务名称').props.onChange({ target: { value: 'New name' } });
  await h.render().find(n => n.props.label === '保存名称').props.onClick();
  assert.equal(h.calls[0][1].title, 'New name');
  assert.equal(h.changed, 0);
  assert.equal(h.render().find(n => n.props['aria-label'] === '任务名称').props.value, 'New name');
  assert(h.render().some(n => n.props.role === 'alert' && n.children.includes('版本冲突')));
});

test('ticket rename limits Unicode characters while goal names keep their existing contract', async () => {
  const h = harness();
  h.render().find(node => node.props.label === '重命名').props.onClick();
  h.render().find(node => node.props['aria-label'] === '任务名称').props.onChange({ target: { value: '📰一二三四五六七八九十十一' } });
  assert.equal(h.render().find(node => node.props['aria-label'] === '任务名称').props.value, '📰一二三四五六七八九');
  await h.render().find(node => node.props.label === '保存名称').props.onClick();
  assert.equal(h.calls[0][1].title, '📰一二三四五六七八九');
  const goal = harness();
  goal.render({ kind: 'goal' }).find(node => node.props.label === '重命名').props.onClick();
  goal.render({ kind: 'goal' }).find(node => node.props['aria-label'] === '任务名称').props.onChange({ target: { value: '这是一个超过十个字符的持续目标名称' } });
  await goal.render({ kind: 'goal' }).find(node => node.props.label === '保存名称').props.onClick();
  assert.equal(goal.calls[0][1].title, '这是一个超过十个字符的持续目标名称');
});
test('auto-completed checkbox is checked and locked without hiding details', () => {
  const nodes = harness().render({ completed: true, completionLocked: true });
  const checkbox = nodes.find(n => n.props.type === 'checkbox');
  assert.equal(checkbox.props.checked, true); assert.equal(checkbox.props.disabled, true);
  assert(nodes.some(n => n.props.className === 'ba-task-open'));
});
test('active work cannot be completed or deleted from the list', () => {
  const nodes = harness().render({ row: { id: 't1', status: 'open', taskCanOrganize: false } });
  assert.equal(nodes.find(n => n.props.type === 'checkbox').props.disabled, true);
  assert.equal(nodes.find(n => n.props.icon === 'trash').props.disabled, true);
  assert.match(nodes.find(n => n.props.icon === 'trash').props.label, /先停止/);
});
