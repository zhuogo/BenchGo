import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { runInNewContext } from 'node:vm';

const code = transformSync(readFileSync(new URL('../client/skills-library.jsx', import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs' }).code;
const walk = node => node && typeof node === 'object' && node.props ? [node, ...(node.children || []).flatMap(walk)] : [];
const text = node => typeof node === 'string' || typeof node === 'number' ? String(node) : (node?.children || []).map(text).join('');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function harness({ directory = [], managed = [], catalogImpl, ownedImpl, available = true } = {}) {
  let cursor = 0, refCursor = 0, effectCursor = 0;
  const states = [], refs = [], effects = [], pending = [], calls = [], module = { exports: {} };
  const CustomSelect = () => null;
  const react = {
    createElement: (type, props, ...children) => type === 'benchgo-disclosure' ? react.createElement('section', props, react.createElement('button', { 'aria-expanded': true }, props.title), ...children) : ({ type, props: props || {}, children: children.flat(Infinity).filter(value => value !== null && value !== undefined && value !== false) }),
    useState: initial => { const index = cursor++; if (!(index in states)) states[index] = initial; return [states[index], next => { states[index] = typeof next === 'function' ? next(states[index]) : next; }]; },
    useRef: current => refs[refCursor++] ||= { current },
    useEffect: (run, deps) => { const index = effectCursor++, old = effects[index]; if (!old || deps.some((dep, i) => !Object.is(dep, old.deps[i]))) pending.push(() => { old?.cleanup?.(); effects[index] = { deps, cleanup: run() }; }); },
  };
  const catalog = { available, skills: directory, projects: [{ id: 'p', title: 'Project', path: '/project' }], scope: { title: '全局技能' } };
  const api = async (action, input, signal) => { calls.push({ kind: 'catalog', action, input, signal }); return catalogImpl ? catalogImpl(action, input, signal) : action === 'list' ? catalog : { skill: { ...directory.find(row => row.name === input.name), content: 'Loaded instructions' } }; };
  const ownedApi = async (action, input, signal) => { calls.push({ kind: 'owned', action, input, signal }); return ownedImpl ? ownedImpl(action, input, signal) : { available, skills: managed, events: [{ seq: 8, action: 'create', version: 1, body: 'Old instructions', at: 1 }] }; };
  runInNewContext(code, { module, exports: module.exports, AbortController, navigator: { clipboard: { writeText: async () => {} } }, require: name => name === 'react' ? react : name.endsWith('/ui/button.jsx') ? { Button: 'button' } : name.endsWith('/ui/collapsible.jsx') ? { Disclosure: 'benchgo-disclosure' } : { CustomSelect } });
  const render = () => { cursor = refCursor = effectCursor = 0; const nodes = walk(module.exports.SkillsLibrary({ api, ownedApi })); while (pending.length) pending.shift()(); return nodes; };
  return { calls, render, catalog, async settle() { await new Promise(resolve => setImmediate(resolve)); return render(); }, unmount() { effects.forEach(effect => effect?.cleanup?.()); } };
}
const registered = (name, extras = {}) => ({ name, description: name + ' description', source: 'user-agents', provider: 'filesystem', path: '/skills/' + name + '/SKILL.md', invocation: { modelInvocable: true, userInvocable: true }, ...extras });
const owned = (status = 'active') => ({ id: 'owned-1', name: 'learned', description: 'Learned skill', status, revision: 4, content: 'Managed instructions', pinned: false });
const rows = h => h.render().filter(node => node.props.className?.startsWith('bg-skill-row') && node.type === 'button');
const button = (h, label) => h.render().find(node => node.type === 'button' && text(node) === label);
const control = (h, label) => h.render().find(node => node.props['aria-label'] === label);

test('installed skills remain usable without SuperAgent; policy controls availability and filtering', async () => {
  const h = harness({ directory: [registered('installed'), registered('disabled', { invocation: { modelInvocable: false, userInvocable: false } })], ownedImpl: async () => { throw Error('SuperAgent is off'); } });
  h.render(); await h.settle(); assert.equal(rows(h).length, 2);
  await button(h, '可用').props.onClick(); assert.equal(rows(h).length, 1);
  await rows(h)[0].props.onClick();
  assert(h.render().some(node => node.type === 'pre' && text(node) === 'Loaded instructions'));
  const call = h.calls.find(call => call.action === 'get'); assert.equal(call.input.provider, 'filesystem');
  assert(h.render().some(node => node.type === 'button' && text(node).includes('自建技能暂不可用')));
  h.unmount();
});

test('registered managed skills deduplicate; candidates and shadowed records remain manageable', async () => {
  const h = harness({ directory: [registered('learned', { provider: 'benchgo-superagent', source: 'benchgo-owned' })], managed: [owned('stale'), { ...owned('candidate'), id: 'candidate', name: 'proposed' }] });
  h.render(); await h.settle(); assert.equal(rows(h).length, 2); assert(text(rows(h)[0]).includes('可用 · 待整理'));
  control(h, '按来源筛选').props.onChange('owned'); assert.equal(rows(h).length, 2);
  button(h, '待审核1').props.onClick(); assert.equal(rows(h).length, 1);
  await rows(h)[0].props.onClick(); await button(h, '批准启用').props.onClick();
  const call = h.calls.find(call => call.action === 'ownedSkillApprove'); assert.equal(call.input.id, 'candidate'); assert.equal(call.input.revision, 4);
  h.unmount();
});

test('project changes abort old requests and late results cannot replace the selected scope', async () => {
  const old = deferred();
  const h = harness({ catalogImpl: (action, input) => input.projectId ? { available: true, skills: [registered('project-skill')], projects: [], scope: { projectId: 'p', cwd: '/project' } } : old.promise });
  h.render(); control(h, '技能查询范围').props.onChange('p'); h.render(); await h.settle();
  assert.equal(h.calls.find(call => call.kind === 'catalog').signal.aborted, true);
  old.resolve({ available: true, skills: [registered('old-skill')], projects: [], scope: {} }); await h.settle();
  assert.equal(rows(h).length, 1); assert(text(rows(h)[0]).includes('project-skill'));
  h.unmount();
});

test('detail races do not show a previously selected body and search matches paths', async () => {
  const first = deferred();
  const h = harness({ catalogImpl: (action, input) => action === 'list' ? { available: true, skills: [registered('first'), registered('second')], projects: [], scope: {} } : input.name === 'first' ? first.promise : { skill: { content: 'Second body' } } });
  h.render(); await h.settle(); const pending = rows(h)[0].props.onClick(); await rows(h)[1].props.onClick();
  first.resolve({ skill: { content: 'Old body' } }); await pending;
  assert(h.render().some(node => node.type === 'pre' && text(node) === 'Second body'));
  control(h, '搜索技能名称、描述或路径').props.onChange({ target: { value: '/skills/second/' } }); assert.equal(rows(h).length, 1);
  h.unmount();
});

test('managed history restores the exact snapshot with revision; fixed versions cannot restore', async () => {
  const h = harness({ managed: [owned()] }); h.render(); await h.settle(); await rows(h)[0].props.onClick();
  await button(h, '查看历史').props.onClick(); await button(h, '恢复此版本').props.onClick();
  const call = h.calls.find(call => call.action === 'ownedSkillRestore'); assert.equal(call.input.snapshotSeq, 8); assert.equal(call.input.revision, 4);
  h.unmount();
  const fixed = harness({ managed: [{ ...owned(), pinned: true }] }); fixed.render(); await fixed.settle(); await rows(fixed)[0].props.onClick(); await button(fixed, '查看历史').props.onClick();
  assert.equal(button(fixed, '恢复此版本').props.disabled, true); fixed.unmount();
});

test('managed publish is disabled without provider; rejection, pin and conflict feedback retain versions', async () => {
  const pending = harness({ managed: [owned('candidate')], available: false }); pending.render(); await pending.settle(); await rows(pending)[0].props.onClick();
  assert.equal(button(pending, '批准启用').props.disabled, true);
  await button(pending, '拒绝候选').props.onClick();
  assert.equal(pending.calls.find(call => call.action === 'ownedSkillReject').input.revision, 4); pending.unmount();
  const h = harness({ managed: [owned()], ownedImpl: async action => { if (action === 'ownedSkills') return { available: true, skills: [owned()] }; throw Error('版本冲突，请刷新'); } });
  h.render(); await h.settle(); await rows(h)[0].props.onClick(); await button(h, '固定技能').props.onClick();
  const call = h.calls.find(call => call.action === 'ownedSkillPin'); assert.equal(call.input.pinned, true); assert.equal(call.input.revision, 4);
  assert(h.render().some(node => node.props.role === 'alert' && text(node).includes('版本冲突'))); h.unmount();
});
