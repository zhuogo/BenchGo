import { retainAssistantSession } from '../client/session-retain.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { Context } from '@deepseek-ai/cordis';
import { webcrypto } from 'node:crypto';

const { transformSync } = createRequire(new URL('../../benchgo/package.json', import.meta.url))('esbuild');
function load(path, overrides = {}) {
  const module = { exports: {} };
  const empty = new Proxy({}, { get: () => () => {} });
  runInNewContext(transformSync(readFileSync(new URL(path, import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs' }).code, {
    module, exports: module.exports, AbortController, crypto: webcrypto, queueMicrotask: fn => fn(), setTimeout: fn => fn(),
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    document: { dispatchEvent() {}, addEventListener() {}, removeEventListener() {}, createElement: () => ({ remove() {} }), head: { append() {} } },
    require: id => id.endsWith('session-retain.mjs') ? { retainAssistantSession } : overrides[id] || empty,
  });
  return module.exports;
}

test('declared client dependencies authorize uiConversation in optional child scope', async () => {
  const entry = load('../../benchgo/client/index.jsx');
  const effects = [], errors = [], activated = [];
  const conversation = load('../client/conversation.jsx', { react: {
    createContext: () => ({}), createElement: () => null, useEffect: effect => effects.push(effect), useCallback: callback => callback, useMemo: read => read(),
    useState: initial => [initial, value => { if (typeof value === 'string' && value) errors.push(value); }],
  } });
  const ctx = new Context();
  for (const name of entry.inject) ctx.provide(name, name === 'uiConversation' ? { binding: id => ({ activate: target => activated.push([id, target]) }) }
    : name === 'sessions' ? { retain: () => ({ ready: Promise.resolve(), release() {} }) } : {});
  let cleanup;
  const fiber = ctx.plugin({ inject: entry.inject, apply: parent => {
    parent.plugin({ apply: child => {
      conversation.AssistantConversation({ ctx: child, sessionId: 'main-session' });
      cleanup = effects[0]();
    } });
  } });
  try {
    await fiber;
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(errors, []);
    assert.deepEqual(activated, [['main-session', 'chat']]);
  } finally { cleanup?.(); await ctx.fiber.dispose(); }
});

test('assistant conversation retains the official composer without a replacement slot', () => {
  const source = readFileSync(new URL('../client/conversation.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /InboxComposer|mountComposerInboxAdapter|<textarea|conversation\.composer/);
  assert.match(source, /renderFactorySlot\('conversation\.content'/);
});

test('first registered main panel opens SuperAgent and remount does not steal navigation', () => {
  const assistant = load('../client/index.jsx');
  const operations = [];
  const ctx = {
    effect: effect => effect(),
    layout: { panelInfo: { getSnapshot: () => ({ activePanelId: 'other' }) }, selectPanel: id => operations.push(['select', id]) },
    slots: { inject: (_name, mount) => mount(), register: options => { operations.push(['register', options.key]); return () => {}; } },
  };
  assistant.mountAssistant(ctx);
  assert.deepEqual(operations, [['register', 'benchgo-assistant'], ['select', 'benchgo-assistant']]);
  operations.length = 0;
  assistant.mountAssistant(ctx);
  assert.deepEqual(operations, [['register', 'benchgo-assistant']]);
});
