import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const require = createRequire(new URL('../../benchgo/package.json', import.meta.url));
const { transformSync } = require('esbuild');
const slots = ['sidebar.session.row.trailing', 'benchgo.sidebar.session.row.trailing'];

function fixture(file) {
  const effects = [], subscriptions = [], registrations = [], removed = [], timers = [], eventDefinitions = [], removedEvents = [];
  const scopeCleanups = [];
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useSyncExternalStore: (subscribe, snapshot) => { subscriptions.push(subscribe(() => {})); return snapshot(); },
    useEffect: effect => { effects.push(effect); },
  };
  const code = transformSync(readFileSync(new URL(`../client/${file}`, import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs' }).code;
  const module = { exports: {} };
  runInNewContext(code, { module, exports: module.exports, document: { hidden: false }, AbortController,
    require: name => name === 'react' ? react : {},
    setInterval: callback => { timers.push(callback); return timers.length; }, clearInterval: id => { timers[id - 1] = null; },
  });
  const ctx = { effect: setup => {
    const cleanup = setup(); let disposed = false;
    const dispose = () => { if (!disposed) { disposed = true; cleanup(); } };
    scopeCleanups.push(dispose); return dispose;
  }, uiConversation: { events: {
    register: definition => { eventDefinitions.push(definition); return () => removedEvents.push(definition); },
  } }, slots: {
    inject: (name, setup) => { setup(); return () => removed.push(name); },
    register: (options, component) => { registrations.push({ ...options, component }); return () => {}; },
  } };
  return { api: module.exports, ctx, effects, timers, registrations, removed, eventDefinitions, removedEvents,
    dispose: () => { for (const cleanup of subscriptions) cleanup(); for (const cleanup of scopeCleanups.slice().reverse()) cleanup(); } };
}

test('both sidebar slots share one Ticket component, projection request and polling lifetime', async () => {
  const f = fixture('execution-session.jsx');
  let requests = 0, resolve;
  const result = new Promise(done => { resolve = done; });
  const dispose = f.api.registerExecutionSessionRows(f.ctx, () => { requests++; return result; });
  assert.deepEqual(f.registrations.map(entry => entry.name), slots);
  assert.equal(f.registrations[0].component, f.registrations[1].component);
  assert.equal(f.timers.length, 1);
  for (const entry of f.registrations) assert.equal(entry.component({ sessionId: 'worker' }), null);
  for (const effect of f.effects.splice(0)) effect();
  assert.equal(requests, 1);
  resolve([{ sessionId: 'worker', title: '真实工单' }]);
  await result;
  await new Promise(done => setImmediate(done));
  for (const entry of f.registrations) {
    const mark = entry.component({ sessionId: 'worker' });
    assert.equal(mark.props['aria-label'], '工单：真实工单');
    assert.deepEqual(Array.from(mark.children), ['工单']);
  }
  dispose(); assert.deepEqual(f.removed, slots);
  f.dispose(); assert.equal(f.timers[0], null);
});

test('both sidebar slots share the Channel component and read the official summary projection', () => {
  const f = fixture('channel-session.jsx');
  const dispose = f.api.registerChannelSessionRows(f.ctx);
  assert.deepEqual(f.registrations.map(entry => entry.name), slots);
  assert.equal(f.registrations[0].component, f.registrations[1].component);
  for (const entry of f.registrations) {
    const useSessions = select => select({ byId: { channel: { projectionValues: { benchgoChannelSource: { channel: 'feishu', sourceType: 'group' } } } } });
    assert.equal(entry.component({ sessionId: 'missing', useSessions }), null);
    const mark = entry.component({ sessionId: 'channel', useSessions });
    assert.equal(mark.props['aria-label'], '渠道来源：feishu · group');
  }
  assert.equal(f.timers.length, 0);
  assert.deepEqual(f.eventDefinitions, [f.api.channelMessageDefinition]);
  dispose(); assert.deepEqual(f.removed, slots);
  assert.deepEqual(f.removedEvents, [f.api.channelMessageDefinition]);
  f.dispose(); assert.equal(f.removedEvents.length, 1, 'scope disposal must not unregister the event twice');
});
