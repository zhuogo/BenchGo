import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
const { transformSync } = createRequire(new URL('../../benchgo/package.json', import.meta.url))('esbuild');
const code = transformSync(readFileSync(new URL('../client/goal-budget.jsx', import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs' }).code;
const walk = node => node && typeof node === 'object' ? [node, ...node.children.flatMap(walk)] : [];
function harness(row, failure) {
  let cursor = 0; const state = [], calls = [], module = { exports: {} };
  const react = { createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(value => value != null && value !== false) }), useEffect() {},
    useState: initial => { const i = cursor++; if (!(i in state)) state[i] = initial; return [state[i], value => { state[i] = typeof value === 'function' ? value(state[i]) : value; }]; } };
  runInNewContext(code, { module, exports: module.exports, require: id => id.endsWith('/ui/button.jsx') ? { Button: 'button' } : id.endsWith('/ui/collapsible.jsx') ? { Disclosure: 'Disclosure' } : react });
  return { exports: module.exports, calls, render() { cursor = 0; return walk(module.exports.GoalBudget({ row, api: async (action, input) => { calls.push({ action, input }); if (failure) throw new Error(failure); }, reload: async () => calls.push({ action: 'reload' }) })); } };
}
const row = () => ({ id: 'goal', status: 'paused', budgetState: { version: 4, budget: { requests: 5, tokens: 300, cost: 0.5 }, usage: { requests: 5, tokens: 20, cost: 0, unknownCost: 2, unknownTokens: 1 } } });
test('budget parser preserves zero, omission and exact limits and rejects invalid values', () => {
  const h = harness(row());
  assert.deepEqual(JSON.parse(JSON.stringify(h.exports.parseBudget({ requests: '0', tokens: '', cost: '0.125', deadline: '' }))), { requests: 0 });
  for (const requests of ['-1', '1.5', 'Infinity', '9007199254740992']) assert.throws(() => h.exports.parseBudget({ requests }));
  assert.throws(() => h.exports.parseBudget({ deadline: 'invalid' }));
  const stamp = new Date(2030, 4, 7, 13, 24, 51, 123).getTime();
  assert.equal(h.exports.parseBudget(h.exports.budgetDraft({ deadline: stamp })).deadline, stamp);
});
test('budget edit preserves other limits, sends opened version and never auto resumes', async () => {
  const data = row(), h = harness(data);
  h.render().find(n => n.children.includes('调整预算')).props.onClick();
  const fields = h.render().find(n => n.type?.name === 'BudgetFields');
  fields.props.onChange({ ...fields.props.value, requests: '20' });
  data.budgetState = { ...data.budgetState, version: 9 };
  await h.render().find(n => n.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls)), [{ action: 'goalBudgetUpdate', input: { id: 'goal', expectedVersion: 4, budget: { requests: 20, tokens: 300 } } }, { action: 'reload' }]);
});
test('conflict keeps draft visible; unknown usage is disclosed and missing budget is unavailable', async () => {
  const h = harness(row(), '版本冲突');
  assert(h.render().some(n => n.children.some(c => typeof c === 'string' && c.includes('以上仅为已知累计'))));
  h.render().find(n => n.children.includes('调整预算')).props.onClick();
  await h.render().find(n => n.type === 'form').props.onSubmit({ preventDefault() {} });
  assert(h.render().some(n => n.props.role === 'alert' && n.children.includes('版本冲突')));
  assert(h.render().some(n => n.type === 'form'));
  assert.equal(h.calls.length, 1);
  const missing = harness({ id: 'missing' }).render().find(n => n.props.title === '预算记录暂不可用');
  assert(missing);
  assert.equal(missing.props.actionLabel, '重新读取');
  assert.equal(typeof missing.props.onAction, 'function');
});

test('Goals create submits budget with opaque model IDs; budget wait resumes through dedicated API', async () => {
  const source = transformSync(readFileSync(new URL('../client/goals.jsx', import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs' }).code;
  const data = { ...row(), status: 'waiting', waitReason: 'budget', executionKind: 'ticket', rowVersion: 7 };
  const state = [[data], { objective: '目标', projectId: 'project', provider: 'p/@', model: 'Exact: 01', text: 'work', acceptance: '' }, true];
  let cursor = 0, viewedTickets = 0; const calls = [], refs = [], module = { exports: {} }; let refCursor = 0;
  const react = { createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(value => value != null && value !== false) }), useEffect() {}, useCallback: fn => fn, useRef: initial => refs[refCursor++] ||= { current: initial },
    useState: initial => { const i = cursor++; if (!(i in state)) state[i] = initial; return [state[i], value => state[i] = typeof value === 'function' ? value(state[i]) : value]; } };
  const budget = harness(row()).exports;
  runInNewContext(source, { module, exports: module.exports, crypto: { randomUUID: () => 'request' }, require: id => id.endsWith('/ui/button.jsx') ? { Button: 'button' } : id.endsWith('/ui/collapsible.jsx') ? { Disclosure: 'Disclosure' } : id === 'react' ? react : id.endsWith('task-list.jsx') ? { TaskListRow: 'TaskListRow', TaskDetail: 'TaskDetail', TaskIconButton: 'TaskIconButton' } : id.endsWith('dirty-registry.mjs') ? { useDirtyRegistry: () => () => () => {} } : id.endsWith('.css') ? '' : budget });
  const render = () => { cursor = refCursor = 0; return walk(module.exports.Goals({ onViewTickets: () => viewedTickets++, api: async (action, input) => { if (action === 'catalog') return { projects: [{ id: 'project' }], providers: [{ id: 'p/@', available: true }], models: [{ id: 'Exact: 01', provider: 'p/@' }] }; calls.push({ action, input }); return { goals: [data] }; }, refresh: async () => {} })); };
  await render().find(n => n.type === 'button' && n.children.includes('刷新目录')).props.onClick();
  const fields = render().find(n => n.type?.name === 'BudgetFields');
  fields.props.onChange({ ...fields.props.value, requests: '12', tokens: '999' });
  await render().find(n => n.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].input.goal.budget)), { requests: 12, tokens: 999 });
  assert.equal(calls[0].input.goal.model, 'Exact: 01');
  assert.equal(viewedTickets, 1);
  await render().find(n => n.type === 'TaskListRow').props.actions.find(action => action.label === '继续执行').onClick();
  assert.deepEqual(JSON.parse(JSON.stringify(calls.find(c => c.action === 'goalBudgetResume'))), { action: 'goalBudgetResume', input: { id: 'goal', rowVersion: 7 } });
});
