import assert from 'node:assert/strict';
import test from 'node:test';
import { watchWorkbench } from '../client/workbench-recovery.mjs';

const status = (instanceId, plugin, health = {}) => ({
  installation: 'server',
  current: { plugin },
  hostHealth: { instanceId, ready: true, ...health },
});

function fixture(t, responses) {
  const editor = { inert: false, focus: t.mock.fn() };
  const body = { children: [editor], append(element) { this.children.push(element); } };
  const root = {
    body, activeElement: editor,
    createElement() {
      return {
        style: {}, textContent: '', setAttribute() {}, focus() {}, children: [],
        append(...children) { this.children.push(...children); },
        remove() { body.children = body.children.filter(element => element !== this); },
        get firstChild() { return this.children[0]; },
        get lastChild() { return this.children.at(-1); },
      };
    },
  };
  const reload = t.mock.fn();
  const read = t.mock.fn(async () => {
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  watchWorkbench(read, { root, reload });
  const tick = async ms => { t.mock.timers.tick(ms); await Promise.resolve(); };
  return { editor, root, read, reload, tick };
}

test('temporary server status failures leave the editor usable and the document mounted', async t => {
  const ready = status('same', '1.0.0');
  const { editor, root, read, reload, tick } = fixture(t, [ready, new Error('timeout'), new Error('timeout'), ready]);
  await tick(0);
  await tick(15_000);
  assert.equal(editor.inert, false);
  assert.equal(root.body.children.length, 1);
  await tick(29_999);
  assert.equal(read.mock.callCount(), 2);
  await tick(1);
  await tick(60_000);
  assert.equal(read.mock.callCount(), 4);
  assert.equal(reload.mock.callCount(), 0);
});

test('confirmed restart waits for the target version before reloading', async t => {
  const { editor, root, reload, tick } = fixture(t, [
    status('old', '1.0.0'),
    status('old', '1.0.0', { restart: 'restarting', target: '1.1.0' }),
    new Error('host stopped'),
    status('new', '1.1.0', { ready: false, workbench: true, requiresAssistant: true }),
    status('new', '1.1.0'),
  ]);
  await tick(0);
  await tick(15_000);
  assert.equal(editor.inert, true);
  assert.match(root.body.children[1].firstChild.textContent, /正在重启/);
  await tick(5_000);
  await tick(5_000);
  assert.match(root.body.children[1].firstChild.textContent, /等待总助手/);
  assert.equal(reload.mock.callCount(), 0);
  await tick(5_000);
  assert.equal(reload.mock.callCount(), 1);
  assert.equal(editor.inert, false);
});
