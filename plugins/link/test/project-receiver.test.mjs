import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = 'function installResourceReceiver' + readFileSync(new URL('../client/resource-navigation.jsx', import.meta.url), 'utf8').split('export function installResourceReceiver')[1];
const origin = 'https://owner.example';
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(projectApi) {
  const listeners = new Set(), messages = [], attributes = new Set();
  const parent = { postMessage: (value, target) => messages.push({ value: JSON.parse(JSON.stringify(value)), target }) };
  const window = { parent, addEventListener: (_, listener) => listeners.add(listener), removeEventListener: (_, listener) => listeners.delete(listener) };
  const install = runInNewContext('(' + source + ')', { window, location: { hash: '#' + new URLSearchParams({ resourceParentOrigin: origin }) }, document: { documentElement: { setAttribute: name => attributes.add(name) } }, URL, URLSearchParams, setTimeout, clearTimeout });
  const dispose = install({}, { projectApi });
  const send = (data, source = parent, from = origin) => { for (const listener of listeners) listener({ data, source, origin: from }); };
  return { send, dispose, messages, listeners, parent, window, attributes };
}

test('project receiver allowlists operations and fields, authenticates the parent and deduplicates concurrent writes', async () => {
  const calls = []; let complete;
  const view = fixture(async (action, args) => { calls.push({ action, args: JSON.parse(JSON.stringify(args)) }); if (action === 'clone') return new Promise(resolve => { complete = resolve; }); return { path: args.path }; });
  try {
    assert.deepEqual(view.messages[0].value.projectActions, ['browse', 'project', 'clone']);
    const browse = { type: 'benchgo:project:call', action: 'browse', args: { path: '/srv/exact', url: 'ignored', action: 'delete' }, requestId: 'browse' };
    view.send(browse, view.window); view.send(browse, view.parent, 'https://forged.example'); await flush();
    assert.equal(calls.length, 0);
    view.send(browse); await flush();
    assert.deepEqual(calls, [{ action: 'browse', args: { path: '/srv/exact' } }]);
    assert.equal(view.messages.at(-1).target, origin);
    assert.equal(view.messages.at(-1).value.value.path, '/srv/exact');
    view.send({ ...browse, action: 'management', requestId: 'unsupported' }); await flush();
    assert.match(view.messages.at(-1).value.error, /不支持/); assert.equal(calls.length, 1);
    const clone = { type: 'benchgo:project:call', action: 'clone', args: { url: 'https://github.com/owner/exact.git', path: 'ignored' }, requestId: 'clone' };
    view.send(clone); view.send(clone); await flush();
    assert.equal(calls.length, 2); assert.deepEqual(calls[1].args, { url: 'https://github.com/owner/exact.git' });
    complete({ project: { id: 'opaque:project/id' } }); await flush();
    assert.equal(view.messages.filter(message => message.value.requestId === 'clone').length, 2);
    assert(view.messages.filter(message => message.value.requestId === 'clone').every(message => message.value.value.project.id === 'opaque:project/id'));
  } finally { view.dispose(); }
  assert.equal(view.listeners.size, 0);
});

test('project receiver reports unavailable capabilities and suppresses replies after disposal', async () => {
  const unsupported = fixture();
  unsupported.send({ type: 'benchgo:project:call', action: 'browse', requestId: 'missing' }); await flush();
  assert.deepEqual(unsupported.messages[0].value.projectActions, []);
  assert.match(unsupported.messages.at(-1).value.error, /更新 BenchGo/); unsupported.dispose();
  let finish;
  const view = fixture(() => new Promise(resolve => { finish = resolve; }));
  view.send({ type: 'benchgo:project:call', action: 'project', args: { path: '/srv/exact' }, requestId: 'pending' }); await flush();
  const count = view.messages.length; view.dispose(); finish({ project: { id: 'exact' } }); await flush();
  assert.equal(view.messages.length, count);
});
