import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { PiProvider } from '../src/providers/pi.mjs';
import { askNativeQuestion } from '../../benchgo/src/questions.mjs';

const fixture = fileURLToPath(new URL('./commands-fixture.mjs', import.meta.url));
async function exchange(t, ui, approval) {
  const events = [], approvals = [], errors = [];
  const provider = new PiProvider({ command: process.execPath, commandArgs: [fixture], env: { PI_UI_REQUEST: JSON.stringify(ui) } });
  const driver = await provider.connect({ cwd: process.cwd() }, { event: (type, data) => events.push({ type, data }), nativeId() {}, failure: error => errors.push(error), approval: async request => { approvals.push(request); return approval(request); } });
  t.after(() => driver.close());
  await driver.submit('ui-fixture');
  for (let i = 0; i < 100 && !events.some(event => event.type === 'turn.completed'); i++) await delay(5);
  assert.ok(events.some(event => event.type === 'turn.completed'), 'Pi UI response must settle the turn');
  assert.deepEqual(errors, []);
  return { request: approvals[0], response: JSON.parse(events.find(event => event.type === 'text.delta').data.text) };
}

test('only the shipped BenchGo tool gate is eligible for policy permission allow', async t => {
  const source = await readFile(new URL('../src/providers/pi-permissions.ts', import.meta.url), 'utf8');
  const code = stripTypeScriptTypes(source.replace(/^import \{ Type \} from .*;\r?$/m, '')).replace('export default ', '');
  const mount = new Function('Type', code + '\nreturn commanderPermissions;')({});
  let gate, ui;
  mount({ registerTool() {}, on(type, handler) { if (type === 'tool_call') gate = handler; } });
  assert.deepEqual(await gate({ toolName: 'bash', toolCallId: 'opaque:tool/1', input: { command: 'fixture' } }, { hasUI: true, ui: { async confirm(title, message) { ui = { method: 'confirm', title, message }; return false; } } }), { block: true, reason: 'Denied by BenchGo user' });
  for (const allow of [true, false]) {
    const state = await exchange(t, ui, async request => { assert.equal(request.kind, 'permission'); return { allow }; });
    assert.equal(state.response.id, 'opaque:ui/1'); assert.equal(state.response.confirmed, allow);
  }
});

test('ordinary or malformed Pi confirms remain questions and ignore a permission allow answer', async t => {
  for (const ui of [{ method: 'confirm', title: 'Continue the approach?', message: 'A human decision' }, { method: 'confirm', title: 'BenchGo tool permission', message: '{invalid' }, { method: 'confirm', title: 'BenchGo tool permission', message: JSON.stringify({ benchgoToolPermission: true }) }]) {
    const state = await exchange(t, ui, async request => { assert.equal(request.kind, 'question'); assert.deepEqual(request.details.options, ['Yes', 'No']); return { allow: true }; });
    assert.equal(state.response.confirmed, false);
  }
});

test('Pi ordinary confirms transmit the actual human Yes or No through the question seam', async t => {
  for (const answer of ['Yes', 'No']) {
    const state = await exchange(t, { method: 'confirm', title: 'Human choice', message: 'Continue?' }, request => askNativeQuestion('pi', request, async () => ({ answers: [{ id: 'value', selected: [answer] }] })));
    assert.equal(state.request.kind, 'question'); assert.equal(state.response.confirmed, answer === 'Yes');
  }
});

test('Pi selection questions retain human values and cancellation', async t => {
  for (const selected of [['B'], []]) {
    const state = await exchange(t, { method: 'select', title: 'Choose', options: ['A', 'B'] }, request => askNativeQuestion('pi', request, async () => ({ answers: [{ id: 'value', selected }] })));
    assert.equal(state.request.kind, 'question'); assert.equal(state.response.cancelled, !selected.length); assert.equal(state.response.value, selected[0]);
  }
});
