import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotificationSound, createNotificationFactGate, notificationKeys } from '../client/notification-sound.mjs';
import { AgentFeed } from '../../voice/client/agent-feed.mjs';
import { mountReplySound } from '../client/notification-sound-runtime.mjs';

function fixture(options = {}) {
  let plays = 0, time = 0, resumeCalls = 0;
  const storage = new Map(), parameter = { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} };
  class Audio {
    state = 'suspended'; currentTime = 0;
    addEventListener() {} removeEventListener() {}
    async resume() { resumeCalls++; if (options.blocked) throw Error('autoplay blocked'); this.state = 'running'; }
    async close() { this.state = 'closed'; }
    createOscillator() { return { frequency: parameter, connect() {}, disconnect() {}, start() { plays++; }, stop() {} }; }
    createGain() { return { gain: parameter, connect() {}, disconnect() {} }; }
  }
  const sound = createNotificationSound({ AudioContext: Audio, setTimeout, clearTimeout, performance: { now: () => time }, localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) } });
  return { sound, plays: () => plays, resumeCalls: () => resumeCalls, advance: () => time += 1000, storage };
}

test('autoplay locks truthfully, gestures unlock, mute persists, missed sounds never replay', async t => {
  const f = fixture(); t.after(() => f.sound.dispose());
  assert.equal(f.sound.notify(['old']), false); assert.equal(f.sound.getSnapshot().state, 'locked');
  assert.equal(f.resumeCalls(), 0);
  await f.sound.unlock(); assert.equal(f.sound.getSnapshot().state, 'ready'); assert.equal(f.plays(), 0);
  assert.equal(f.sound.notify(['old']), false); assert.equal(f.sound.notify(['new']), true);
  f.sound.setEnabled(false); f.advance(); assert.equal(f.sound.notify(['muted']), false);
  f.sound.setEnabled(true); assert.equal(f.sound.notify(['muted']), false);
  assert.equal(f.sound.notify(['next']), true); assert.equal(f.plays(), 2);
  const blocked = fixture({ blocked: true }); t.after(() => blocked.sound.dispose());
  assert.equal(await blocked.sound.unlock(true), false); assert.equal(blocked.sound.getSnapshot().state, 'error');
  assert.equal(blocked.plays(), 0);
});

test('fact snapshots, gaps, reconnects, updates and duplicate frames stay silent; new inserts sound', async t => {
  const f = fixture(); t.after(() => f.sound.dispose()); await f.sound.unlock();
  const gate = createNotificationFactGate(f.sound);
  const frame = (seq, operation = 'insert', patch = {}) => ({ cursor: seq, entries: [{ seq, kind: 'chat', data: { operation, eventId: `e${seq}`, ...patch } }] });
  gate.update(frame(1)); gate.replace({ cursor: 4 }); gate.update(frame(4)); assert.equal(f.plays(), 0);
  gate.update(frame(5)); gate.update(frame(5)); assert.equal(f.plays(), 1);
  f.advance(); gate.update(frame(6, 'update')); gate.update(frame(7, 'delete')); assert.equal(f.plays(), 1);
  gate.update(frame(9)); gate.update(frame(10)); assert.equal(f.plays(), 1);
  gate.replace({ cursor: 10 }); gate.disconnect(); gate.update(frame(11));
  gate.replace({ cursor: 11 }); gate.update(frame(12)); assert.equal(f.plays(), 2);
});

test('public reply parser sounds once per reply, never per chunk or history, and merges notification identities', async t => {
  const f = fixture(); t.after(() => f.sound.dispose()); await f.sound.unlock();
  const feed = new AgentFeed({ publicOnly: true, onPublication: (_text, event) => f.sound.notify(notificationKeys(event.data, 'main')) });
  let revision = 0;
  const accept = (events, kind = 'append') => feed.accept({ revision: ++revision, entries: events.map(event => ({ event })), change: { kind, entries: events.map(event => ({ event })) } });
  const user = id => ({ type: 'user/message', seq: revision * 10 + 1, data: { id, source: { kind: 'user' } } });
  const publication = id => ({ type: 'plugin:benchgo-plugin/chat-publication', ignorable: true, seq: revision * 10 + 2, data: { kind: 'final', requestId: id, text: '正式回复' } });
  accept([user('historic'), publication('historic')], 'replace'); assert.equal(f.plays(), 0);
  accept([{ type: 'turn/start', seq: 20, data: { turn: 1 } }, user('r1')]);
  accept([{ type: 'assistant/live-chunk', seq: 31, data: { turn: 1, chunk: { type: 'text-delta', text: 'part' } } }]);
  assert.equal(f.plays(), 0); const published = publication('r1'); accept([published]); accept([published]); assert.equal(f.plays(), 1);
  f.advance(); const gate = createNotificationFactGate(f.sound); gate.replace({ cursor: 0 });
  gate.update({ cursor: 1, entries: [{ seq: 1, kind: 'chat', data: { operation: 'insert', eventId: 'mirror', threadId: 'main', requestId: 'r1' } }] });
  assert.equal(f.plays(), 1);
  accept([{ type: 'turn/start', seq: 100, data: { turn: 2 } }, user('r2'), { type: 'assistant/message', seq: 102, data: { turn: 2, message: { source: { kind: 'model' }, content: [{ type: 'text', text: '自然回复' }] } } }]);
  assert.equal(f.plays(), 1);
  accept([{ type: 'turn/end', seq: 103, data: { turn: 2, reason: { kind: 'completed' } } }]); assert.equal(f.plays(), 2);
  f.advance(); accept([user('r2'), publication('r2')], 'replace'); assert.equal(f.plays(), 2);
});

test('background session listener shares official retention, ignores history and releases pending/active references', async t => {
  const previous = globalThis.document; globalThis.document = new EventTarget();
  t.after(() => { if (previous) globalThis.document = previous; else delete globalThis.document; });
  let revision = 0, snapshot = { revision: 0, entries: [], change: { kind: 'replace' } }, notify, releaseCount = 0, unsubscribeCount = 0, cleanup, disposed = 0;
  const sounded = [], catalog = new Set();
  const source = { getSnapshot: () => snapshot, subscribe(listener) { notify = listener; return () => { unsubscribeCount++; }; } };
  const binding = { eventSource: source };
  const ctx = { effect: effect => { cleanup = effect(); }, sessions: {
    list: { getSnapshot: () => ({ ids: ['router'] }), subscribe(listener) { catalog.add(listener); return () => catalog.delete(listener); } },
    retain: () => ({ ready: Promise.resolve(binding), binding, release() { releaseCount++; } }),
  } };
  mountReplySound(ctx, async () => ({ state: { mainSessionId: 'router', threads: [] } }), {
    getSnapshot: () => ({ enabled: true, state: 'locked' }), unlock: () => { throw Error('synthetic events must not unlock'); },
    notify: keys => sounded.push(keys), dispose: () => disposed++,
  });
  document.dispatchEvent(new CustomEvent('benchgo:assistant-notification-source', { detail: { publicChatNotifications: false } }));
  t.after(() => cleanup?.());
  await new Promise(resolve => setTimeout(resolve, 0));
  document.dispatchEvent(new Event('pointerdown'));
  const send = (entries, kind = 'append') => { snapshot = { revision: ++revision, entries: entries.map(event => ({ event })), change: { kind, entries: entries.map(event => ({ event })) } }; notify(); };
  const user = { type: 'user/message', seq: 1, data: { id: 'r', source: { kind: 'user' } } };
  const reply = { type: 'plugin:benchgo-plugin/chat-publication', seq: 2, ignorable: true, data: { kind: 'final', requestId: 'r', text: '后台回复' } };
  send([user, reply]); assert.deepEqual(sounded, [['request:main:r']]);
  send([user, reply], 'replace'); assert.equal(sounded.length, 1);
  cleanup(); cleanup = null;
  assert.equal(releaseCount, 1); assert.equal(unsubscribeCount, 1); assert.equal(catalog.size, 0); assert.equal(disposed, 1);
});

test('new sessions attach from catalog and assistant events without polling and cleanup rejects pending state', async t => {
  const previous = globalThis.document, previousInterval = globalThis.setInterval;
  globalThis.document = new EventTarget();
  globalThis.setInterval = () => { throw Error('reply sounds must not poll'); };
  t.after(() => { globalThis.setInterval = previousInterval; if (previous) globalThis.document = previous; else delete globalThis.document; });
  let cleanup, calls = 0, ids = [], state = { threads: [] }, delayed, resolveRead;
  const catalog = new Set(), attached = [], released = [], removed = [];
  const ctx = { effect: effect => { cleanup = effect(); }, sessions: {
    list: { getSnapshot: () => ({ ids }), subscribe(listener) { catalog.add(listener); return () => catalog.delete(listener); } },
    retain(sessionId) {
      attached.push(sessionId);
      const binding = { eventSource: { getSnapshot: () => ({ revision: 0, entries: [] }), subscribe: () => () => removed.push(sessionId) } };
      return { ready: Promise.resolve(binding), release: () => released.push(sessionId) };
    },
  } };
  const sound = { getSnapshot: () => ({ enabled: true }), dispose() {} };
  mountReplySound(ctx, async () => { calls++; return delayed ? await delayed : { state }; }, sound);
  document.dispatchEvent(new CustomEvent('benchgo:assistant-notification-source', { detail: { publicChatNotifications: false } }));
  t.after(() => cleanup?.());
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  await settle(); assert.equal(calls, 1); assert.deepEqual(attached, []);
  state = { mainSessionId: 'main-session', threads: [] }; ids = ['main-session'];
  for (const listener of catalog) listener();
  await settle(); assert.deepEqual(attached, ['main-session']); assert.equal(calls, 2);
  for (const listener of catalog) listener();
  await settle(); assert.equal(calls, 2); // Status-only catalog notifications do not read state.
  state.threads.push({ id: 'side', sessionId: 'side-session' });
  document.dispatchEvent(new Event('benchgo:assistant-changed'));
  await settle(); assert.deepEqual(attached, ['main-session', 'side-session']);
  delayed = new Promise(resolve => { resolveRead = resolve; });
  document.dispatchEvent(new Event('benchgo:assistant-changed'));
  cleanup(); cleanup = null;
  resolveRead({ state: { mainSessionId: 'late-session', threads: [] } });
  await settle();
  assert.deepEqual(attached, ['main-session', 'side-session']);
  assert.deepEqual(released, attached); assert.deepEqual(removed, attached); assert.equal(catalog.size, 0);
  const before = calls; document.dispatchEvent(new Event('benchgo:assistant-changed')); await settle(); assert.equal(calls, before);
});

test('disabled reply sound reads no state or sessions and disabling releases pending attachment', async t => {
  const previous = globalThis.document; globalThis.document = new EventTarget();
  t.after(() => { if (previous) globalThis.document = previous; else delete globalThis.document; });
  let cleanup, enabled = false, reads = 0, attaches = 0, released = 0, settleReady;
  const listeners = new Set(), soundListeners = new Set();
  const ctx = { effect: effect => { cleanup = effect(); }, sessions: {
    list: { getSnapshot: () => ({ ids: ['main'] }), subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); } },
    retain() { attaches++; return { ready: new Promise(resolve => { settleReady = resolve; }), release() { released++; } }; },
  } };
  const sound = { getSnapshot: () => ({ enabled }), subscribe(fn) { soundListeners.add(fn); return () => soundListeners.delete(fn); }, dispose() {} };
  const toggle = value => { enabled = value; for (const listener of soundListeners) listener(); };
  mountReplySound(ctx, async () => { reads++; return { state: { mainSessionId: 'main', threads: [] } }; }, sound);
  document.dispatchEvent(new CustomEvent('benchgo:assistant-notification-source', { detail: { publicChatNotifications: false } }));
  t.after(() => cleanup?.());
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  document.dispatchEvent(new Event('benchgo:assistant-changed')); await settle();
  assert.equal(reads, 0); assert.equal(attaches, 0);
  toggle(true); await settle(); assert.equal(reads, 1); assert.equal(attaches, 1);
  toggle(false); assert.equal(released, 1);
  settleReady({ eventSource: { getSnapshot() { throw Error('disabled reference must not read history'); } } });
  await settle();
  assert.equal(released, 1); assert.equal(reads, 1);
  cleanup(); cleanup = null; assert.equal(soundListeners.size, 0); assert.equal(listeners.size, 0);
});

test('new notification capability keeps enabled sounds off full-session retention and releases legacy fallback', async t => {
  const previous = globalThis.document; globalThis.document = new EventTarget();
  t.after(() => { if (previous) globalThis.document = previous; else delete globalThis.document; });
  let cleanup, reads = 0, attaches = 0, released = 0;
  const ctx = { effect: effect => { cleanup = effect(); }, sessions: {
    list: { getSnapshot: () => ({ ids: ['main'] }), subscribe: () => () => {} },
    retain() { attaches++; return { ready: Promise.resolve({ eventSource: { getSnapshot: () => ({ entries: [] }), subscribe: () => () => {} } }), release() { released++; } }; },
  } };
  mountReplySound(ctx, async () => { reads++; return { state: { mainSessionId: 'main', threads: [] } }; }, { getSnapshot: () => ({ enabled: true }), dispose() {} });
  t.after(() => cleanup?.());
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  const source = supported => document.dispatchEvent(new CustomEvent('benchgo:assistant-notification-source', { detail: { publicChatNotifications: supported } }));
  await settle(); assert.equal(reads, 0); assert.equal(attaches, 0, 'wait for the first authoritative capability snapshot');
  source(true); document.dispatchEvent(new Event('benchgo:assistant-changed')); await settle();
  assert.equal(reads, 0); assert.equal(attaches, 0);
  source(false); await settle(); assert.equal(reads, 1); assert.equal(attaches, 1, 'older servers keep public reply notifications');
  source(true); assert.equal(released, 1);
  document.dispatchEvent(new Event('benchgo:assistant-changed')); await settle(); assert.equal(reads, 1);
  cleanup(); cleanup = null;
});
