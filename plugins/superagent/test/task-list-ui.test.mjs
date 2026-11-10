import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import * as ticketTitle from '../src/ticket-title.mjs';
import * as ticketState from '../client/ticket-state.mjs';
import * as activityData from '../client/activity-data.mjs';
const { transformSync } = createRequire(new URL('../../benchgo/package.json', import.meta.url))('esbuild');
const code = transformSync(readFileSync(new URL('../client/task-list.jsx', import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs' }).code;
const walk = node => node && typeof node === 'object' && node.props ? [node, ...(node.children || []).flatMap(walk)] : [];
function harness(fail = false) {
  let cursor = 0, changed = 0, opened = 0; const state = [], calls = [], archived = [], restored = [], module = { exports: {} };
  const react = { useEffect() {}, createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }), useState: initial => { const i = cursor++; if (!(i in state)) state[i] = initial; return [state[i], value => state[i] = value]; } };
  runInNewContext(code, { module, exports: module.exports, window: { confirm: () => true }, require: id => id.endsWith('/ui/confirmation.jsx') ? { useConfirmation: () => [async () => true, null] } : id === 'react' ? react : id.endsWith('ticket-title.mjs') ? ticketTitle : id.endsWith('ticket-state.mjs') ? ticketState : id.endsWith('activity-data.mjs') ? activityData : id.endsWith('.css') ? '' : {} });
  const props = { kind: 'ticket', row: { id: 't1', status: 'waiting', executionControl: { stopped: true }, taskMeta: { version: 4 } }, title: 'Task', summary: 'Summary', onChanged: () => changed++, onOpen: () => opened++, onArchive: row => archived.push(row), onRestore: row => restored.push(row), api: async (...args) => { calls.push(args); if (fail) throw new Error('版本冲突'); } };
  return { calls, archived, restored, get changed() { return changed; }, get opened() { return opened; }, render(extra = {}) { cursor = 0; return walk(module.exports.TaskListRow({ ...props, ...extra })); } };
}
test('goal completion retains version and refreshes only after success without hiding details', async () => {
  const h = harness();
  await h.render({kind:'goal'}).find(n => n.props.type === 'checkbox').props.onChange();
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0])), ['taskUpdate', { kind: 'goal', id: 't1', operation: 'complete', version: 4 }]);
  assert.equal(h.changed, 1);
  h.render().find(n => n.props.className === 'ba-task-open').props.onClick();
  assert.equal(h.opened, 1);
  assert.equal(h.calls.length, 1);
});
test('goal and evaluation deletion retain their versioned update contract', async () => {
  for (const kind of ['goal', 'evaluation']) {
    const h = harness();
    h.render({ kind }).find(n => n.props.label === '删除').props.onClick();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(JSON.parse(JSON.stringify(h.calls)), [['taskUpdate', { kind, id: 't1', operation: 'delete', version: 4 }]]);
    assert.equal(h.changed, 1);
    assert.deepEqual(h.archived, []);
    assert.deepEqual(h.restored, []);
  }
});
test('terminal tickets open archive review with the exact row instead of deleting it', async () => {
  for (const state of [{ status: 'completed' }, { status: 'waiting', executionControl: { stopped: true } }]) {
    const h = harness(), row = { id: 't1', ...state, instructionRevision: 2, taskMeta: { version: 4 }, taskCanOrganize: true };
    const nodes = h.render({ row }), archive = nodes.find(n => n.props.icon === 'archive');
    assert.equal(archive.props.label, '归档');
    assert.equal(archive.props.disabled, false);
    assert.equal(nodes.some(n => n.props.icon === 'trash'), false);
    await archive.props.onClick();
    assert.equal(h.archived.length, 1);
    assert.strictEqual(h.archived[0], row);
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.restored, []);
    assert.equal(h.changed, 0);
  }
});
test('cleanup and archived metadata open restore review without reopening execution', async () => {
  for (const metadata of [{ cleanup: { id: 'cleanup-1', version: 5 } }, { taskMeta: { version: 5, archived: true } }]) {
    const h = harness(), row = { id: 't1', status: 'completed', instructionRevision: 2, ...metadata };
    const nodes = h.render({ row }), restore = nodes.find(n => n.props.label === '恢复展示');
    assert.equal(restore.props.icon, 'refresh');
    assert.equal(restore.props.disabled, false);
    assert.equal(nodes.some(n => ['trash', 'archive'].includes(n.props.icon)), false);
    await restore.props.onClick();
    assert.equal(h.restored.length, 1);
    assert.strictEqual(h.restored[0], row);
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.archived, []);
    assert.equal(h.changed, 0);
    assert.equal(row.status, 'completed');
  }
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
test('completed tickets show a read-only status icon and preserve details without strike-through', () => {
  const nodes = harness().render({ row: { id: 't1', status: 'completed' } });
  assert.equal(nodes.some(n => n.props.type === 'checkbox'), false);
  assert(nodes.some(n => n.props.role === 'img' && n.props['aria-label'] === '完成'));
  assert(nodes.some(n => n.props.className === 'ba-task-open'));
  assert.equal(nodes.some(n => /is-complete/.test(n.props.className || '')), false);
});
test('active work cannot be completed or archived from the list', () => {
  const nodes = harness().render({ row: { id: 't1', status: 'running', taskCanOrganize: false } });
  assert.equal(nodes.some(n => n.props.type === 'checkbox'), false);
  assert.equal(nodes.find(n => n.props.icon === 'archive').props.disabled, true);
  assert.equal(nodes.some(n => n.props.icon === 'trash'), false);
});
test('archive requires terminal state and settled execution even when presentation is editable', () => {
  for (const status of ['running', 'waiting', undefined]) {
    const nodes = harness().render({ row: { id: 't1', status, taskCanOrganize: true } });
    assert.equal(nodes.find(n => n.props.icon === 'archive').props.disabled, true, `cannot archive ${status}`);
  }
  const nodes = harness().render({ row: { id: 't1', status: 'waiting', executionControl: { stopped: true }, taskCanOrganize: false } });
  assert.equal(nodes.find(n => n.props.icon === 'archive').props.disabled, true);
});
