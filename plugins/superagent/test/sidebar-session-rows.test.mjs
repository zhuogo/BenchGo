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

test('channel messages retain the official event definition without obsolete sidebar badges', () => {
  const f = fixture('channel-session.jsx');
  const dispose = f.api.registerChannelMessages(f.ctx);
  assert.deepEqual(f.registrations, []);
  assert.deepEqual(f.eventDefinitions, [f.api.channelMessageDefinition]);
  assert.equal(f.timers.length, 0);
  dispose(); assert.deepEqual(f.removedEvents, [f.api.channelMessageDefinition]);
  f.dispose(); assert.equal(f.removedEvents.length, 1);
});
