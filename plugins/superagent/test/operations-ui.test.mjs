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
  runInNewContext(transformSync(readFileSync(new URL(`../client/${file}`, import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs' }).code,
    { module, exports: module.exports, crypto: { randomUUID: () => 'request-id' }, require: id => id.endsWith('/ui/button.jsx') ? { Button: 'button' } : id.endsWith('/ui/collapsible.jsx') ? { Disclosure: 'Disclosure' } : id.endsWith('task-list.jsx') ? { TaskIconButton: 'TaskIconButton' } : id.endsWith('dirty-registry.mjs') ? { useDirtyRegistry: notify => () => notify } : react });
  return { calls, render() { cursor = refCursor = 0; return walk(module.exports[name]({ ...props, api: async (action, input) => { calls.push({ action, input }); if (failure) throw new Error(failure); return {}; }, reload: async () => calls.push({ action: 'reload' }) })); } };
}
test('ticket revision submits the opened version and preserves failed draft and request ID', async () => {
  const ticket = { id: 'ticket', target: 'original', acceptance: 'accept', instructionRevision: 4, status: 'paused' };
  const h = harness('tickets.jsx', 'TicketChange', { ticket }, '版本冲突');
  h.render().find(node => node.props.label === '修订要求').props.onClick();
  h.render().filter(node => node.type === 'textarea').at(-1).props.onChange({ target: { value: 'changed context' } });
  await h.render().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  await h.render().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0])), { action: 'ticketChange', input: { id: 'ticket', operation: 'revise', expectedInstructionRevision: 4, target: 'original', acceptance: 'accept', reason: 'changed context', requestId: 'request-id' } });
  assert.equal(h.calls[0].input.requestId, h.calls[1].input.requestId);
  assert(h.render().some(node => node.props.role === 'alert' && node.children.includes('版本冲突')));
  ticket.instructionRevision = 5;
  assert.equal(h.render().find(node => node.type === 'button' && node.props.type === 'submit').props.disabled, true);
});
test('active or uncertain execution prevents revision while terminal tickets offer reopen', () => {
  for (const patch of [{ status: 'uncertain' }, { status: 'open', assignments: [{ state: 'claimed' }] }]) {
    assert.equal(harness('tickets.jsx', 'TicketChange', { ticket: { id: 't', target: 'x', instructionRevision: 1, ...patch } }).render().find(node => node.props.label === '修订要求').props.disabled, true);
  }
  assert(harness('tickets.jsx', 'TicketChange', { ticket: { status: 'completed' } }).render().some(node => node.props.label === '重开工单'));
});
test('manual Eval retry is bound to both versions and keeps failed reason visible', async () => {
  const row = { id: 'candidate', dispositionRevision: 8, updatedAt: 'then', trigger: { content: 'raw message' } };
  const h = harness('evaluations.jsx', 'EvaluationRow', { row }, '状态已变化');
  h.render().find(node => node.props.label === '重新评估').props.onClick();
  h.render().find(node => node.type === 'textarea').props.onChange({ target: { value: 'model restored' } });
  row.dispositionRevision = 9; row.updatedAt = 'now';
  await h.render().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0])), { action: 'evaluationDispose', input: { candidateId: 'candidate', disposition: 'retry', reason: 'model restored', expectedRevision: 8, expectedUpdatedAt: 'then' } });
  assert(h.render().some(node => node.props.role === 'alert' && walk(node).some(child => child.children.includes('状态已变化'))));
  assert.equal(h.render().find(node => node.type === 'textarea').props.value, 'model restored');
});
test('checkpoint restore shows exclusions and refuses active, conflicting or incomplete previews', () => {
  const ticket = { id: 'ticket', status: 'completed', assignments: [{ state: 'completed' }] };
  const plan = { runId: 'run', token: 'token', excluded: ['.env*', '*.key'], externalEffectsReverted: false, changes: [{ path: 'src/app.js', action: 'replace' }], conflicts: [] };
  const button = nodes => nodes.find(node => node.children.includes('确认整轮文件恢复'));
  const h = harness('checkpoints.jsx', 'CheckpointRestore', { ticket, plan });
  assert.equal(button(h.render()).props.disabled, false);
  assert(h.render().some(node => node.children.includes('.env*、*.key')));
  for (const patch of [{ conflicts: ['src/app.js'] }, { token: null }, { externalEffectsReverted: undefined }, { excluded: undefined }]) assert.equal(button(harness('checkpoints.jsx', 'CheckpointRestore', { ticket, plan: { ...plan, ...patch } }).render()).props.disabled, true);
  assert.equal(button(harness('checkpoints.jsx', 'CheckpointRestore', { ticket: { ...ticket, assignments: [{ state: 'uncertain' }] }, plan }).render()).props.disabled, true);
});
test('checkpoint restore uses the reviewed token and never claims to revert external effects', async () => {
  const calls = [], ticket = { id: 'ticket', status: 'cancelled', assignments: [{ state: 'cancelled' }] };
  const plan = { runId: 'run', token: 'reviewed-token', excluded: ['.env*'], conflicts: [], changes: [], externalEffectsReverted: false };
  const h = harness('checkpoints.jsx', 'CheckpointRestore', { ticket, plan, restore: async input => { calls.push(input); return { backupId: 'backup', externalEffectsReverted: false }; } });
  await h.render().find(node => node.children.includes('确认整轮文件恢复')).props.onClick();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ ticketId: 'ticket', runId: 'run', token: 'reviewed-token' }]);
  assert(h.render().some(node => node.children.includes('外部操作未撤销。原执行已禁止续行，继续工作请重新授权开单。')));
  assert(!h.render().some(node => node.children.includes('确认整轮文件恢复')));
});
