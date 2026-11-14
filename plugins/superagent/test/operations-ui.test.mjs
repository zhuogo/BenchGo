import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
const { transformSync } = createRequire(new URL('../../benchgo/package.json', import.meta.url))('esbuild');
const walk = node => node && typeof node === 'object' ? [node, ...node.children.flatMap(walk)] : [];
function harness(file, name, props, failure, initialState = []) {
  let cursor = 0, refCursor = 0; const state = [...initialState], refs = [], calls = [], module = { exports: {} };
  const react = { createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(value => value != null && value !== false) }), useEffect() {},
    useState: initial => { const i = cursor++; if (!(i in state)) state[i] = initial; return [state[i], value => state[i] = typeof value === 'function' ? value(state[i]) : value]; }, useRef: initial => refs[refCursor++] ||= { current: initial } };
  const load = (path, target, require) => runInNewContext(transformSync(readFileSync(new URL(`../client/${path}`, import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs' }).code,
    { module: target, exports: target.exports, crypto: { randomUUID: () => 'request-id' }, require });
  const taskState = { exports: {} }; load('task-state.mjs', taskState, () => ({}));
  load(file, module, id => id.endsWith('/ui/button.jsx') ? { Button: 'button' } : id.endsWith('/ui/collapsible.jsx') ? { Disclosure: 'Disclosure' } : id.endsWith('task-list.jsx') ? { TaskIconButton: 'TaskIconButton' } : id.endsWith('dirty-registry.mjs') ? { useDirtyRegistry: notify => () => notify } : id.endsWith('task-state.mjs') ? taskState.exports : react);
  return { calls, render() { cursor = refCursor = 0; return walk(module.exports[name]({ ...props, api: async (action, input) => { calls.push({ action, input }); if (failure) throw new Error(failure); return {}; }, reload: async () => calls.push({ action: 'reload' }) })); } };
}
test('task revision submits the opened version and preserves failed draft and request ID', async () => {
  const task = { id: 'task', target: 'original', acceptance: 'accept', instructionRevision: 4, status: 'waiting', executionControl: { paused: true } };
  const h = harness('tasks.jsx', 'TaskChange', { task }, '版本冲突');
  h.render().find(node => node.props.label === '修订要求').props.onClick();
  h.render().filter(node => node.type === 'textarea').at(-1).props.onChange({ target: { value: 'changed context' } });
  await h.render().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  await h.render().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0])), { action: 'taskChange', input: { id: 'task', operation: 'revise', expectedInstructionRevision: 4, target: 'original', acceptance: 'accept', reason: 'changed context', requestId: 'request-id' } });
  assert.equal(h.calls[0].input.requestId, h.calls[1].input.requestId);
  assert(h.render().some(node => node.props.role === 'alert' && node.children.includes('版本冲突')));
  task.instructionRevision = 5;
  assert.equal(h.render().find(node => node.type === 'button' && node.props.type === 'submit').props.disabled, true);
});
test('running work accepts queued revisions while unsafe states wait and terminal tasks create linked adjustments', async () => {
  for (const patch of [{ status: 'waiting', assignments: [{ state: 'uncertain' }] }, { status: 'waiting', executionControl: { pauseRequested: true } }, { status: 'waiting', executionControl: { stopRequested: true } },
    { status: 'running', assignments: [{ state: 'uncertain' }] },
    { status: 'waiting', resultVersion: 1, continuationWait: { sourceResultVersion: 1, code: 'EXECUTION_EFFECTS_UNKNOWN' } }]) {
    assert.equal(harness('tasks.jsx', 'TaskChange', { task: { id: 't', target: 'x', instructionRevision: 1, ...patch } }).render().find(node => node.props.label === '修订要求').props.disabled, true);
  }
  assert.equal(harness('tasks.jsx', 'TaskChange', { task: { id: 't', target: 'x', instructionRevision: 1, status: 'running', assignments: [{ state: 'claimed' }] } }).render().find(node => node.props.label === '修订要求').props.disabled, false);
  const h = harness('tasks.jsx', 'TaskChange', { task: { id: 't', target: 'x', instructionRevision: 1, status: 'completed' } });
  h.render().find(node => node.props.label === '创建关联调整任务').props.onClick();
  h.render().filter(node => node.type === 'textarea').at(-1).props.onChange({ target: { value: 'follow-up adjustment' } });
  await h.render().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0])), { action: 'taskChange', input: { id: 't', operation: 'adjustment', expectedInstructionRevision: 1, target: 'x', acceptance: '', reason: 'follow-up adjustment', requestId: 'request-id' } });
});
