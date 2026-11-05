import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
const { transformSync } = createRequire(new URL('../../benchgo/package.json', import.meta.url))('esbuild');
const walk = node => node && typeof node === 'object' && node.children ? [node, ...node.children.flatMap(walk)] : [];
function harness(file, name, initial) {
  let cursor = 0; const state = [...initial], module = { exports: {} };
  const react = { createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(value => value != null && value !== false) }), useEffect() {}, useCallback: fn => fn, useRef: value => ({ current: value }), useState: value => { const index = cursor++; if (!(index in state)) state[index] = value; return [state[index], next => { state[index] = typeof next === 'function' ? next(state[index]) : next; }]; } };
  runInNewContext(transformSync(readFileSync(new URL(`../client/${file}`, import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs' }).code, { module, exports: module.exports, require: id => id === 'react' ? react : id.endsWith('task-list.jsx') ? { TaskListRow: 'TaskListRow', TaskDetail: 'TaskDetail', TaskIconButton: 'TaskIconButton' } : id.endsWith('dirty-registry.mjs') ? { useDirtyRegistry: () => () => () => {} } : id.endsWith('goal-budget') ? { budgetDraft: () => ({}), GoalBudget: 'GoalBudget' } : id.endsWith('/ui/button.jsx') ? { Button: 'button' } : {} });
  return () => { cursor = 0; return walk(module.exports[name]({ api: async () => ({}), refresh: async () => {} })); };
}
test('goal list opens budget details only on request and locks verified completion', () => {
  const row = { id: 'goal', status: 'completed', objective: 'original execution requirement', taskMeta: { title: 'renamed goal' } };
  const render = harness('goals.jsx', 'Goals', [[row]]);
  const entry = render().find(node => node.type === 'TaskListRow');
  assert.equal(entry.props.title, 'renamed goal');
  assert.equal(entry.props.completionLocked, true);
  assert.equal(render().some(node => node.type === 'GoalBudget'), false);
  entry.props.onOpen();
  assert.equal(render().find(node => node.type === 'GoalBudget').props.row, row);
  render().find(node => node.type === 'GoalBudget').props.onDirtyChange('goal', true);
  assert.equal(render().find(node => node.type === 'TaskDetail').props.dirty, true);
});
test('evaluation rows preserve full raw content in details and track draft protection', () => {
  const row = { id: 'eval', trigger: { content: 'original title\nfull evidence', source: { channel: 'feishu' } }, retryCount: 2, taskMeta: { title: 'renamed evaluation' } };
  const render = harness('evaluations.jsx', 'Evaluations', [false, false, null, { candidates: [row] }]);
  const entry = render().find(node => node.type === 'TaskListRow');
  assert.equal(entry.props.kind, 'evaluation');
  assert.equal(entry.props.title, 'renamed evaluation');
  assert.equal(render().some(node => node.type === 'TaskDetail'), false);
  entry.props.onOpen();
  const details = render().find(node => node.type?.name === 'EvaluationRow');
  assert.equal(details.props.row.trigger.content, 'original title\nfull evidence');
  details.props.onDirtyChange(true);
  assert.equal(render().find(node => node.type === 'TaskDetail').props.dirty, true);
});
