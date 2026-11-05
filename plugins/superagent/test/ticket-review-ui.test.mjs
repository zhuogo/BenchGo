import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import * as ticketState from '../client/ticket-state.mjs';
import { normalizeTicketTitle } from '../src/ticket-title.mjs';
const { transformSync } = createRequire(new URL('../../benchgo/package.json', import.meta.url))('esbuild');
const code = transformSync(readFileSync(new URL('../client/tickets.jsx', import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs' }).code;
const walk = node => node && typeof node === 'object' ? [node, ...node.children.flatMap(walk)] : [];
function harness(row, failure, resumeResponse) {
  let cursor = 0, refCursor = 0; const refs = [];
  const state = [row ? [row] : []], calls = [], module = { exports: {} };
  const react = { createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(value => value != null && value !== false) }),
    useState: initial => { const i = cursor++; if (!(i in state)) state[i] = initial; return [state[i], value => state[i] = typeof value === 'function' ? value(state[i]) : value]; }, useCallback: fn => fn, useEffect() {}, useRef: current => refs[refCursor++] ||= { current } };
  runInNewContext(code, { module, exports: module.exports, require: id => id.endsWith('task-list.jsx') ? { TaskListRow: 'TaskListRow', TaskDetail: 'TaskDetail', TaskIconButton: 'TaskIconButton' } : id.endsWith('/ui/button.jsx') ? { Button: 'button' } : id.endsWith('/ui/collapsible.jsx') ? { Disclosure: 'Disclosure' } : id.endsWith('ticket-state.mjs') ? ticketState : id.endsWith('ticket-title.mjs') ? { normalizeTicketTitle } : id.endsWith('ticket-attention.jsx') ? { TicketAttention: 'TicketAttention' } : id.endsWith('.css') ? '' : id.endsWith('dirty-registry.mjs') ? { useDirtyRegistry: notify => () => notify } : react });
  return { calls, render() { cursor = refCursor = 0; return walk(module.exports.Tickets({ onCreateGoal: () => calls.push(['createGoal']), onOpenGoals: () => calls.push(['openGoals']), api: async (...args) => { calls.push(args); if (failure) throw new Error(failure); if (args[0] === 'state') return { config: { workerConcurrency: 3, revision: 8 } }; if (args[0] === 'config') return { revision: 9 }; if (args[0] === 'ticketResume') return resumeResponse; } })); } };
}
const row = { id: 'ticket', target: 'Task', status: 'waiting', instructionRevision: 2, resultVersion: 3, results: [{ instructionRevision: 2, version: 3, review: { verdict: 'wait' } }] };
test('internal review wait shows explicit automatic system state without a review gate', () => {
  const h = harness({ ...row, results: [{ ...row.results[0], review: { verdict: 'wait', waitKind: 'review_wait', reason: '证据正在补充' } }] });
  h.render().find(n => n.type === 'TaskListRow').props.onOpen();
  const nodes = h.render();
  assert(nodes.some(node => node.props.role === 'status' && node.props['aria-label'] === '系统状态'));
  assert(nodes.some(node => node.children.includes('系统自动核验中')));
  assert(nodes.some(node => node.children.includes('证据正在补充')));
  assert(!nodes.some(node => node.type === 'button' && node.children.includes('重新验收')));
  assert.equal(h.calls.length, 0);
});
test('terminal, stale and non-review waiting tickets cannot offer review retry', () => {
  for (const patch of [{ status: 'completed' }, { resultVersion: 4 }, { instructionRevision: 3 }, { results: [] }]) {
    const h = harness({ ...row, ...patch }); h.render().find(n => n.type === 'TaskListRow').props.onOpen();
    assert(!h.render().some(node => node.type === 'button' && node.children.includes('重新验收')));
  }
});

test('resource wait resumes the original ticket with its result fence and exposes system errors', async () => {
  const h = harness({ ...row, results: [{ ...row.results[0], review: { verdict: 'wait', waitKind: 'continuation_wait' } }] }, '执行额度尚未恢复');
  h.render().find(n => n.type === 'TaskListRow').props.onOpen();
  await h.render().find(node => node.type === 'button' && node.children.includes('恢复原单')).props.onClick();
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls)), [['ticketResume', { ticketId: 'ticket', expectedResultVersion: 3 }]]);
  assert(h.render().some(node => node.props.role === 'alert' && node.children.includes('执行额度尚未恢复')));
  assert(!h.render().some(node => node.children.some(value => typeof value === 'string' && value.includes('未重复调用模型'))));
});

test('answered blocked work adds only explicit execution time on the original result version', async () => {
  const h = harness({ ...row, continuationWait: { code: 'EXECUTION_BUDGET_EXHAUSTED', sourceResultVersion: 3 },
    attentions: [{ id: 'answered', origin: 'review', instructionRevision: 2, resultVersion: 3, state: 'answered' }],
    results: [{ ...row.results[0], review: { verdict: 'wait', waitKind: 'blocked' } }] });
  h.render().find(node => node.type === 'TaskListRow').props.onOpen();
  assert(h.render().some(node => node.children.includes('系统等待续做资源')));
  assert.equal(h.calls.length, 0, 'rendering never grants execution time');
  await h.render().find(node => node.type === 'button' && node.children.includes('增加10分钟并继续')).props.onClick();
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls)), [['ticketResume', { ticketId: 'ticket', expectedResultVersion: 3, additionalExecutionMs: 600000 }]]);
});

test('Goal budget wait opens existing Goal settings and never grants execution or Goal quota', async () => {
  const h = harness({ ...row, continuationWait: { code: 'GOAL_BUDGET_EXHAUSTED', sourceResultVersion: 3 } });
  h.render().find(node => node.type === 'TaskListRow').props.onOpen();
  await h.render().find(node => node.type === 'button' && node.children.includes('管理持续目标额度')).props.onClick();
  assert.deepEqual(h.calls, [['openGoals']]);
});

test('a recovery blocked by a higher-priority gate remains explicit rather than silently refreshing', async () => {
  const h = harness({ ...row, continuationWait: { code: 'NO_PROGRESS', sourceResultVersion: 3 } }, undefined, { queued: false, code: 'MANDATE_REVOKED' });
  h.render().find(node => node.type === 'TaskListRow').props.onOpen();
  await h.render().find(node => node.type === 'button' && node.children.includes('恢复原单')).props.onClick();
  assert(h.render().some(node => node.props.role === 'alert' && node.children.includes('系统状态：原工单暂未恢复（MANDATE_REVOKED）')));
});

test('stale and stopped resource waits cannot offer recovery or extra execution time', () => {
  for (const patch of [{ status: 'paused' }, { status: 'cancelled' }, { status: 'uncertain' }, { status: 'blocked' }, { resultVersion: 4 }]) {
    const h = harness({ ...row, ...patch, continuationWait: { code: 'EXECUTION_BUDGET_EXHAUSTED', sourceResultVersion: 3 } });
    h.render().find(node => node.type === 'TaskListRow').props.onOpen();
    assert(!h.render().some(node => node.type === 'button' && node.children.includes('增加10分钟并继续')));
    assert.equal(h.calls.length, 0);
  }
});

test('unknown or unverified external effects expose system verification state without recovery or extra budget', () => {
  for (const code of ['EXECUTION_EFFECTS_UNKNOWN', 'EXECUTION_NOT_VERIFIED', 'EXECUTION_STOP_UNCONFIRMED']) {
    const ticket = { ...row, continuationWait: { code, sourceResultVersion: 3 } };
    assert.equal(ticketState.continuationRecovery(ticket), null);
    const h = harness(ticket);
    const entry = h.render().find(node => node.type === 'TaskListRow');
    assert(!entry.props.actions.some(action => /恢复原单|增加10分钟|继续/.test(action.label)));
    entry.props.onOpen();
    const nodes = h.render();
    assert(nodes.some(node => node.children.includes('待核实外部效果')));
    assert(nodes.some(node => node.children.includes('系统等待安全条件')));
    assert(!nodes.some(node => node.type === 'button' && node.children.some(value => /恢复原单|增加10分钟/.test(value))));
    assert.equal(h.calls.length, 0);
  }
});

test('short display titles keep the full Mandate target and acceptance in the detail', () => {
  const target = '请整理今天的新闻热点，覆盖六到十条并注明来源及时间';
  const acceptance = '六到十条，每条一到两句，无需创建文件。';
  const h = harness({ ...row, target, acceptance, title: '今日新闻热点摘要的超长标题', taskMeta: { title: '用户整理的超长新闻摘要标题' } });
  const entry = h.render().find(node => node.type === 'TaskListRow');
  assert.equal(Array.from(entry.props.title).length, 10);
  entry.props.onOpen();
  assert(h.render().some(node => node.children.includes(target)));
  assert(h.render().some(node => node.children.includes(acceptance)));
});

test('ticket header opens goals; concurrency modal saves only its field and cancel restores saved value', async () => {
  const h = harness();
  h.render().find(n => n.children.includes('新建持续目标')).props.onClick();
  assert.equal(h.calls[0][0], 'createGoal');
  h.render().find(n => n.type === 'button' && n.children.includes('设置')).props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  let nodes = h.render();
  assert.equal(nodes.find(n => n.props.id === 'ba-worker-concurrency').props.value, '3');
  nodes.find(n => n.props.id === 'ba-worker-concurrency').props.onChange({ target: { value: '5' } });
  await h.render().find(n => n.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.find(c => c[0] === 'config')[1])), { revision: 8, patch: { workerConcurrency: 5 } });
  h.render().find(n => n.props.id === 'ba-worker-concurrency').props.onChange({ target: { value: '7' } });
  h.render().find(n => n.props.title === '工单设置').props.onClose();
  assert.equal(h.render().find(n => n.props.id === 'ba-worker-concurrency').props.value, '5');
});
