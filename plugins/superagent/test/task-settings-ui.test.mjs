import test from 'node:test';
import * as ticketBoard from '../client/ticket-board.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
const { transformSync } = createRequire(new URL('../../benchgo/package.json', import.meta.url))('esbuild');
const code = transformSync(readFileSync(new URL('../client/tickets.jsx', import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs' }).code;
const walk = node => node && typeof node === 'object' && node.props ? [node, ...(node.children || []).flatMap(walk)] : [];
function harness({ fail = false } = {}) {
  const state = [[]], refs = [], calls = [], module = { exports: {} }; let cursor = 0, refCursor = 0, opened = 0;
  const react = { createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(value => value != null && value !== false) }),
    useState: value => { const at = cursor++; if (!(at in state)) state[at] = value; return [state[at], next => { state[at] = typeof next === 'function' ? next(state[at]) : next; }]; },
    useId: () => 'task-test', useRef: value => refs[refCursor++] ||= { current: value }, useCallback: fn => fn, useEffect() {} };
  const Modal = () => null;
  runInNewContext(code, { module, exports: module.exports, require: name => name.endsWith('ticket-board.mjs') ? ticketBoard : name.endsWith('/ui/button.jsx') ? { Button: 'button' } : name.endsWith('/ui/collapsible.jsx') ? { Disclosure: 'Disclosure' } : name === 'react' ? react : { Modal, useDirtyRegistry: () => () => () => {} } });
  const props = { onCreateGoal: () => opened++, api: async (action, args) => {
    calls.push({ action, args });
    if (action === 'state') return { config: { revision: 7, workerConcurrency: 2 } };
    if (fail) throw new Error('版本冲突');
    return { revision: 8, workerConcurrency: args.patch.workerConcurrency };
  } };
  return { calls, get opened() { return opened; }, render() { cursor = refCursor = 0; return walk(module.exports.Tickets(props)); }, Modal };
}
test('ticket header action is connected and concurrency changes submit only their field', async () => {
  const h = harness();
  h.render().find(n => n.children.includes('新建持续目标')).props.onClick();
  assert.equal(h.opened, 1);
  h.render().find(n => n.children.includes('设置')).props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  h.render().find(n => n.type === 'input').props.onChange({ target: { value: '4' } });
  await h.render().find(n => n.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.at(-1))), { action: 'config', args: { revision: 7, patch: { workerConcurrency: 4 } } });
  assert.equal(h.render().find(n => n.type === h.Modal).props.open, false);
});
test('concurrency conflicts retain the draft and cancelling restores the saved value', async () => {
  const h = harness({ fail: true });
  h.render().find(n => n.children.includes('设置')).props.onClick(); await new Promise(resolve => setImmediate(resolve));
  h.render().find(n => n.type === 'input').props.onChange({ target: { value: '5' } });
  await h.render().find(n => n.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.equal(h.render().find(n => n.type === 'input').props.value, '5');
  assert(h.render().some(n => n.props.role === 'alert' && walk(n).some(child => child.children.includes('版本冲突'))));
  h.render().find(n => n.type === h.Modal).props.onClose();
  assert.equal(h.render().find(n => n.type === 'input').props.value, '2');
});
