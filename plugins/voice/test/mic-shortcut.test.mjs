import test from 'node:test';
import assert from 'node:assert/strict';
import { createMicTargets, installMicShortcut } from '../client/mic-shortcut.mjs';

function harness(state = { mode: 'idle', phase: 'idle', sessionId: 's' }, { ready = true } = {}) {
  const actions = [], windowListeners = new Map(), timers = new Map(), fixed = [];
  let observer, nextTimer = 0, registered = 0, consumed = 0;
  const shortcuts = {
    registerFixed(command) { fixed.push(command); registered++; return () => { registered--; }; },
    observeFixedInput(listener) { observer = listener; return () => { observer = null; }; },
  };
  const controller = { state: { getSnapshot: () => state }, toggleMute() { actions.push('mute'); } };
  const target = { sessionId: 's', ready: () => ready, start: () => actions.push('start'), keep: () => actions.push('keep'), send: () => actions.push('send'), stop: () => actions.push('stop') };
  const targets = { resolve: () => target };
  const environment = { addEventListener: (name, fn) => windowListeners.set(name, fn), removeEventListener: name => windowListeners.delete(name) };
  const dispose = installMicShortcut({ shortcuts, controller, targets, environment, holdMs: 350,
    setTimer: fn => { const id = ++nextTimer; timers.set(id, fn); return id; }, clearTimer: id => timers.delete(id) });
  return { actions, fixed, state, target, targets, dispose, windowListeners, get registered() { return registered; }, get consumed() { return consumed; },
    key(gesture = {}, context = {}) {
      observer?.({ type: 'keydown', consume: () => { consumed++; },
        gesture: { code: 'KeyM', repeat: false, composing: false, defaultPrevented: false, control: false, alt: false, shift: false, meta: false, ...gesture },
        context: { region: 'page', modal: null, target: null, ...context } });
    },
    release(code = 'KeyM') { windowListeners.get('keyup')?.({ code }); },
    blur() { windowListeners.get('blur')?.(); },
    elapse() { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } },
  };
}

test('M registers as one fixed bare key and never acts inside text input, terminals, IME or with modifiers', () => {
  const h = harness();
  assert.deepEqual(h.fixed.map(row => [row.id, row.keys, row.bindings, row.group]), [['voice.microphone', ['M'], [{ code: 'KeyM', modifiers: [] }], 'input']]);
  for (const [gesture, context] of [[{}, { region: 'editable' }], [{}, { region: 'terminal' }], [{ composing: true }, {}], [{ defaultPrevented: true }, {}],
    [{ control: true }, {}], [{ alt: true }, {}], [{ shift: true }, {}], [{ meta: true }, {}], [{ repeat: true }, {}], [{ code: 'KeyN' }, {}], [{}, { modal: 'settings' }]]) h.key(gesture, context);
  assert.deepEqual(h.actions, []); assert.equal(h.consumed, 0);
  h.dispose(); assert.equal(h.registered, 0); assert.equal(h.windowListeners.size, 0);
});

test('during a call M toggles the microphone, also inside the call stage, but not while connecting or under another dialog', () => {
  const h = harness({ mode: 'call', phase: 'listening', sessionId: 'other' });
  h.key(); h.key({}, { modal: 'voice-call' });
  assert.deepEqual(h.actions, ['mute', 'mute']); assert.equal(h.consumed, 2);
  h.key({}, { modal: 'settings' }); h.key({}, { region: 'editable' });
  h.state.phase = 'starting'; h.key();
  assert.deepEqual(h.actions, ['mute', 'mute']);
  h.release(); assert.deepEqual(h.actions, ['mute', 'mute']);
});

test('a tap starts dictation into the draft and the next tap stops it', () => {
  const h = harness();
  h.key(); assert.deepEqual(h.actions, ['start']);
  h.release('KeyN'); assert.deepEqual(h.actions, ['start']);
  h.release(); assert.deepEqual(h.actions, ['start', 'keep']);
  h.elapse(); h.release(); assert.deepEqual(h.actions, ['start', 'keep']);
  h.state.mode = 'dictation'; h.key(); assert.deepEqual(h.actions, ['start', 'keep', 'stop']);
  h.release(); assert.deepEqual(h.actions, ['start', 'keep', 'stop']);
  assert.equal(h.consumed, 2);
});

test('holding past the threshold sends on release; auto-repeat is swallowed and never restarts', () => {
  const h = harness();
  h.key(); h.key({ repeat: true }); h.key({ repeat: true });
  assert.deepEqual(h.actions, ['start']); assert.equal(h.consumed, 3);
  h.elapse(); h.state.mode = 'dictation'; h.key({ repeat: true });
  h.release(); assert.deepEqual(h.actions, ['start', 'send']);
  h.release(); assert.deepEqual(h.actions, ['start', 'send']);
});

test('a release the window never saw stops without sending: blur, a fresh press, and disposal', () => {
  for (const lose of ['blur', 'press', 'dispose']) {
    const h = harness(); h.key(); h.elapse(); h.state.mode = 'dictation';
    if (lose === 'blur') h.blur(); else if (lose === 'press') h.key(); else h.dispose();
    assert.deepEqual(h.actions, ['start', 'stop'], lose);
    h.release(); assert.deepEqual(h.actions, ['start', 'stop'], lose);
  }
});

test('M leaves the key alone when dictation is unavailable, no composer is in reach, or another session is dictating', () => {
  const unavailable = harness(undefined, { ready: false }); unavailable.key();
  const absent = harness(); absent.targets.resolve = () => null; absent.key();
  const foreign = harness({ mode: 'dictation', phase: 'listening', sessionId: 'other' }); foreign.key();
  for (const h of [unavailable, absent, foreign]) { assert.deepEqual(h.actions, []); assert.equal(h.consumed, 0); }
});

test('targets pick the visible composer of the focused conversation, else the only visible one', () => {
  const targets = createMicTargets();
  const node = visible => ({ getClientRects: () => visible ? [{}] : [] });
  const a = node(true), b = node(true), hidden = node(false);
  const owner = element => ({ closest: () => ({ contains: candidate => candidate === element }) });
  const offA = targets.add({ element: () => a, actions: () => 'A' });
  targets.add({ element: () => hidden, actions: () => 'hidden' });
  assert.equal(targets.resolve(null), 'A');
  const offB = targets.add({ element: () => b, actions: () => 'B' });
  assert.equal(targets.resolve(null), null);
  assert.equal(targets.resolve({ closest: () => null }), null);
  assert.equal(targets.resolve(owner(b)), 'B');
  assert.equal(targets.resolve(owner(hidden)), null);
  offA(); assert.equal(targets.resolve(null), 'B');
  offB(); assert.equal(targets.resolve(null), null);
});
