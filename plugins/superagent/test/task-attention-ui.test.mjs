import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import * as taskState from '../client/task-state.mjs';

const { transformSync } = createRequire(new URL('../../benchgo/package.json', import.meta.url))('esbuild');
const code = transformSync(readFileSync(new URL('../client/task-attention.jsx', import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs' }).code;
const walk = node => node && typeof node === 'object' ? [node, ...node.children.flatMap(walk)] : [];
function harness(overrides = {}, failure) {
  let cursor = 0, refCursor = 0;
  const state = [], refs = [], calls = [], module = { exports: {} };
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(value => value != null && value !== false) }),
    useState: initial => { const i = cursor++; if (!(i in state)) state[i] = initial; return [state[i], value => { state[i] = typeof value === 'function' ? value(state[i]) : value; }]; },
    useRef: initial => refs[refCursor++] ||= { current: initial },
    useId: () => 'question-test',
  };
  runInNewContext(code, { module, exports: module.exports, crypto: { randomUUID }, require: id => id === 'react' ? react : id.endsWith('/ui/button.jsx') ? { Button: 'button' } : id.endsWith('task-state.mjs') ? taskState : '' });
  const task = { id: 'original', status: 'waiting', instructionRevision: 2, resultVersion: 3, mandate: { source: { channel: 'desktop' } } };
  const attention = { id: 'question', taskId: task.id, origin: 'worker', instructionRevision: 2, resultVersion: 3, state: 'waiting', question: { question: '采用哪个范围？', options: [{ label: '国内外' }] } };
  const props = { task, attention, api: async (...args) => { calls.push(args); if (failure) throw new Error(failure); }, onAnswered: () => calls.push(['refresh']), ...overrides };
  return { calls, props, render() { cursor = refCursor = 0; return walk(module.exports.TaskAttention(props)); } };
}

test('free text answers the durable original Worker question and refreshes after acceptance', async () => {
  const h = harness();
  h.render().find(node => node.type === 'textarea').props.onChange({ target: { value: ' 国内外，保留 AI 热点 ' } });
  await h.render().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  const [op, payload] = h.calls[0];
  assert.equal(op, 'taskAnswer');
  assert.equal(payload.taskId, 'original');
  assert.equal(payload.attentionId, 'question');
  assert.equal(payload.instructionRevision, 2);
  assert(payload.requestId);
  assert.deepEqual(JSON.parse(JSON.stringify(payload.answer)), { selected: [], custom: '国内外，保留 AI 热点' });
  assert.equal(h.calls[1][0], 'refresh');
  assert(!h.render().some(node => node.type === 'form'));
});

test('changed applied requirements and stopped or completed tasks cannot submit old questions', () => {
  for (const patch of [{ instructionRevision: 3 }, { executionControl: { stopped: true } }, { status: 'completed' }]) {
    const h = harness(); Object.assign(h.props.task, patch);
    assert(!h.render().some(node => node.type === 'form'));
    assert.equal(h.calls.length, 0);
  }
});

test('failed answer keeps the same request identity on retry and exposes the system error', async () => {
  const h = harness({}, '答复尚未保存');
  h.render().find(node => node.type === 'textarea').props.onChange({ target: { value: '国内外' } });
  await h.render().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  const alert = h.render().find(node => node.props.role === 'alert');
  assert(walk(alert).some(node => node.children.includes('答复尚未保存')));
  await h.render().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.equal(h.calls[0][1].requestId, h.calls[1][1].requestId);
});

test('an in-flight Worker question remains answerable under its applied Assignment version', () => {
  const h = harness();
  h.props.attention = { ...h.props.attention, origin: 'worker', instructionRevision: undefined, assignmentId: 'old' };
  h.props.task.assignments = [{ id: 'old', instructionRevision: 1 }];
  assert(h.render().some(node => node.type === 'form'));
});
