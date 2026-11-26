import test from 'node:test';
import * as taskBoard from '../client/task-board.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
const { transformSync } = createRequire(new URL('../../base/package.json', import.meta.url))('esbuild');
const code = transformSync(readFileSync(new URL('../client/tasks.jsx', import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs' }).code;
const walk = node => node && typeof node === 'object' && node.props ? [node, ...(node.children || []).flatMap(walk)] : [];
function harness() {
  const state = [], refs = [], module = { exports: {} }; let cursor = 0, refCursor = 0;
  const react = { createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(value => value != null && value !== false) }),
    useState: value => { const at = cursor++; if (!(at in state)) state[at] = value; return [state[at], next => { state[at] = typeof next === 'function' ? next(state[at]) : next; }]; },
    useId: () => 'task-test', useRef: value => refs[refCursor++] ||= { current: value }, useCallback: fn => fn, useMemo: fn => fn(), useEffect() {}, useLayoutEffect() {} };
  const activity = { rows: [], error: '', refresh: async () => {}, refreshTasks: async () => {} };
  runInNewContext(code, { module, exports: module.exports, require: name => name.endsWith('/ui/confirmation.jsx') ? { useConfirmation: () => [async () => true, null] } : name.endsWith('use-activity.jsx') ? { useAssistantActivity: () => activity } : name.endsWith('task-board.mjs') ? taskBoard : name.endsWith('/ui/button.jsx') ? { Button: 'button' } : name.endsWith('/ui/collapsible.jsx') ? { Disclosure: 'Disclosure' } : name === 'react' ? react : { useDirtyRegistry: () => () => () => {} } });
  return module.exports.Tasks;
}
test('the task header retains scheduling and archiving without a concurrency setting', () => {
  const Tasks = harness();
  const onSchedule = () => {};
  const nodes = walk(Tasks({ onSchedule }));
  assert.equal(nodes.find(node => node.props.label === '定时任务')?.props.onClick, onSchedule);
  assert(nodes.some(node => node.props.archiveAction?.props.label === '归档任务'));
  assert(!nodes.some(node => node.props.label === '设置' || node.type === 'form'));
});
