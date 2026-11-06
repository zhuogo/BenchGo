import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
const { transformSync } = createRequire(new URL('../../benchgo/package.json', import.meta.url))('esbuild');
const walk = node => node && typeof node === 'object' ? [node, ...node.children.flatMap(walk)] : [];
const text = nodes => nodes.flatMap(n => n.children.filter(c => typeof c === 'string')).join('');
const createElement = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(value => value != null && value !== false) });
const load = file => { const module = { exports: {} }; runInNewContext(transformSync(readFileSync(new URL(file, import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs' }).code, { module, exports: module.exports, require: () => ({ createElement }) }); return module.exports; };
const usage = load('../client/goal-usage.jsx');

test('goal usage is read-only accounting without limits or edit controls', () => {
  const nodes = walk(usage.GoalUsage({ row: { id: 'goal', budgetState: { usage: { requests: 5, tokens: 20, cost: 0, unknownTokens: 1 } } } }));
  const shown = text(nodes);
  assert.match(shown, /仅统计，不限制执行/);
  assert.match(shown, /以上仅为已知累计/);
  assert.ok(nodes.some(n => n.type === 'strong' && n.children.includes(20)));
  assert.ok(!nodes.some(n => ['form', 'input', 'button'].includes(n.type)));
  assert.doesNotMatch(shown, /额度|预算|不限制$/);
  assert.equal(usage.GoalUsage({ row: { id: 'ordinary' } }), null);
});

test('Goals form and actions have no budget fields or budget resume API', () => {
  const source = readFileSync(new URL('../client/goals.jsx', import.meta.url), 'utf8');
  for (const removed of ['goalBudgetResume', 'goalBudgetUpdate', 'BudgetFields', 'parseBudget', "waitReason === 'budget'", '用量与期限']) assert.ok(!source.includes(removed), removed);
});
