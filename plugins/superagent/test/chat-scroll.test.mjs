import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatScroll } from '../client/chat-scroll.mjs';

function fixture(sessionKey = '', reduced = false, rounded = false) {
  const listeners = new Map(), frames = new Map();
  let frameId = 0, top = 0, height = 1000, viewport = 300, state, rowPositions = [];
  const scroller = {
    get scrollHeight() { return height; }, get clientHeight() { return viewport; },
    get scrollTop() { return top; }, set scrollTop(value) { const next = Math.max(0, Math.min(value, height - viewport)); top = rounded ? Math.round(next) : next; },
    getBoundingClientRect: () => ({ top: 0 }),
    addEventListener: (name, handler) => listeners.set(name, handler),
    removeEventListener: name => listeners.delete(name),
  };
  const content = { querySelectorAll: () => rowPositions.map(([key, y, size = 100]) => ({
    getAttribute: () => key, getBoundingClientRect: () => ({ top: y - top, bottom: y + size - top }),
  })) };
  const owner = createChatScroll({ scroller, content, sessionKey, reducedMotion: () => reduced,
    onChange: value => { state = value; }, requestFrame: fn => { frames.set(++frameId, fn); return frameId; }, cancelFrame: id => frames.delete(id),
  });
  return { owner, scroller, get state() { return state; }, listeners, frames,
    layout(value, rows = rowPositions, size = viewport) { height = value; rowPositions = rows; viewport = size; },
    event(name, event = {}) { listeners.get(name)?.(event); },
    move(value) { scroller.scrollTop = value; listeners.get('scroll')(); },
    tick(time) { const batch = [...frames.values()]; frames.clear(); for (const fn of batch) fn(time); },
  };
}
const user = (key = 'u', extra = {}) => ({ key, role: 'user', ...extra });
const reply = text => ({ key: 'a', role: 'assistant', text });

test('initial tail follows growth; upward intent stops it and new output raises one unread state', () => {
  const f = fixture(); f.owner.update([user(), reply('a')]);
  assert.equal(f.scroller.scrollTop, 700);
  f.layout(1100); f.owner.resize(); assert.equal(f.scroller.scrollTop, 700);
  f.tick(0); f.tick(32); assert(f.scroller.scrollTop > 700 && f.scroller.scrollTop < 800);
  f.tick(700); assert.equal(f.scroller.scrollTop, 800);
  f.event('wheel', { deltaY: -30 }); f.move(700);
  f.layout(1200); f.owner.update([user(), reply('ab')]);
  assert.equal(f.scroller.scrollTop, 700); assert.deepEqual(f.state, { visible: true, unread: true });
  f.move(900); assert.deepEqual(f.state, { visible: false, unread: false });
  f.owner.dispose();
});

test('a new submission follows once across pending, admitted and persisted identities', () => {
  const f = fixture(); f.owner.update([user(), reply('old')]); f.move(100);
  f.owner.update([user(), reply('old'), user('pending:r', { rpcId: 'r' })]);
  assert.equal(f.frames.size, 0, 'sending is immediate, including keyboard submission');
  assert.equal(f.scroller.scrollTop, 700);
  f.event('wheel', { deltaY: -100 }); f.move(200);
  f.owner.update([user(), reply('old'), user('live:2', { rpcId: 'r', seq: 2 })]);
  f.owner.update([user(), reply('old'), user('saved:2', { seq: 2 })]);
  assert.equal(f.scroller.scrollTop, 200); assert.equal(f.frames.size, 0);
  f.owner.dispose();
});

test('return animation targets a growing tail and can be interrupted by keyboard or touch', () => {
  const f = fixture(); f.owner.update([user()]); f.move(100);
  f.owner.bottom(true); f.tick(0); f.tick(80); assert(f.scroller.scrollTop > 100);
  f.event('keydown', { key: 'PageUp' }); assert.equal(f.frames.size, 0);
  const stopped = f.scroller.scrollTop; f.layout(1500); f.owner.resize();
  assert.equal(f.scroller.scrollTop, stopped);
  f.owner.bottom(true); f.tick(100); f.layout(1800); f.tick(1000);
  assert.equal(f.scroller.scrollTop, 1500);
  f.move(200); f.owner.bottom(true); f.event('touchstart', { touches: [{ clientY: 50 }] });
  assert.equal(f.frames.size, 0); f.owner.dispose();
});

test('prepend and asynchronous reflow preserve the visible message offset', () => {
  const f = fixture(); f.layout(1000, [['u', 0], ['a', 300], ['b', 600]]);
  f.owner.update([user(), reply('text')]); f.move(320);
  f.layout(1400, [['older', 0], ['u', 400], ['a', 700], ['b', 1000]]);
  f.owner.update([user('older'), user(), reply('text')]);
  assert.equal(f.scroller.scrollTop, 720); assert.equal(f.state.unread, false);
  f.layout(1500, [['older', 0], ['u', 400], ['a', 800], ['b', 1100]]); f.owner.resize();
  assert.equal(f.scroller.scrollTop, 820); f.owner.dispose();
});

test('session reopening restores reading anchor and a different session starts at its tail', () => {
  const f = fixture('saved-session'); f.layout(1000, [['u', 0], ['a', 300]]);
  f.owner.update([user(), reply('text')]); f.move(330); f.owner.dispose();
  const restored = fixture('saved-session'); restored.layout(1400, [['u', 0], ['a', 600]]);
  restored.owner.update([user(), reply('text')]); assert.equal(restored.scroller.scrollTop, 630);
  const other = fixture('other-session'); other.owner.update([user()]); assert.equal(other.scroller.scrollTop, 700);
  restored.owner.dispose(); other.owner.dispose();
});

test('reduced motion returns immediately, resize follows composer height, disposal removes work', () => {
  const f = fixture('', true); f.owner.update([user()]); f.move(50); f.owner.bottom(true);
  assert.equal(f.frames.size, 0); assert.equal(f.scroller.scrollTop, 700);
  f.layout(1000, [], 200); f.owner.resize(); assert.equal(f.scroller.scrollTop, 800);
  f.owner.dispose(); assert.equal(f.listeners.size, 0); assert.equal(f.frames.size, 0);
});

test('continuous growth retargets one follow loop and settles without idle frames', () => {
  const f = fixture(); f.owner.update([user(), reply('start')]);
  let previous = f.scroller.scrollTop;
  f.layout(1040); f.owner.resize(); f.tick(0);
  for (let time = 16; time <= 160; time += 16) {
    f.layout(1040 + time); f.owner.update([user(), reply(String(time))]);
    assert.equal(f.frames.size, 1, 'one frame owns both text growth and resize');
    f.tick(time);
    assert(f.scroller.scrollTop > previous, 'retargeting never starves forward progress');
    assert(f.scroller.scrollTop < f.scroller.scrollHeight - f.scroller.clientHeight, 'new lines do not snap directly to the tail');
    previous = f.scroller.scrollTop;
  }
  f.tick(1000);
  assert.equal(f.scroller.scrollTop, 900);
  assert.equal(f.frames.size, 0, 'completed following schedules no idle animation');
  f.owner.dispose();
});

test('upward wheel interrupts an active follow before the next content update', () => {
  const f = fixture(); f.owner.update([user(), reply('start')]);
  f.layout(1300); f.owner.resize(); f.tick(0); f.tick(32);
  const position = f.scroller.scrollTop;
  f.event('wheel', { deltaY: -1 });
  assert.equal(f.frames.size, 0);
  f.layout(1400); f.owner.update([user(), reply('more')]);
  assert.equal(f.scroller.scrollTop, position);
  assert.deepEqual(f.state, { visible: true, unread: true });
  f.owner.dispose();
});

test('a growing target retains speed instead of restarting or jumping on its next frame', () => {
  const baseline = fixture(), growing = fixture();
  for (const f of [baseline, growing]) {
    f.owner.update([user(), reply('start')]);
    f.layout(1300); f.owner.resize(); f.tick(0); f.tick(64);
  }
  const before = growing.scroller.scrollTop;
  growing.layout(1327); growing.owner.update([user(), reply('next line')]);
  assert.equal(growing.scroller.scrollTop, before, 'retargeting does not write a new position synchronously');
  baseline.tick(65); growing.tick(65);
  assert(growing.scroller.scrollTop > before, 'the previous velocity continues immediately');
  assert(growing.scroller.scrollTop >= baseline.scroller.scrollTop, 'a farther destination never decelerates the retained trajectory');
  assert(Math.abs(growing.scroller.scrollTop - baseline.scroller.scrollTop) < .1, 'retargeting changes acceleration rather than introducing a speed jump');
  for (const f of [baseline, growing]) f.owner.dispose();
});

test('rounded browser positions still settle completely and schedule no idle frames', () => {
  const f = fixture('', false, true);
  f.owner.update([user(), reply('start')]); f.layout(1300); f.owner.resize();
  for (let time = 0; time <= 1200 && f.frames.size; time += 1000 / 120) f.tick(time);
  assert.equal(f.scroller.scrollTop, 1000);
  assert.equal(f.frames.size, 0, 'fractional trajectory does not stall on the last rounded pixel');
  f.owner.dispose();
});
