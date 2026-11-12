import test from 'node:test';
import assert from 'node:assert/strict';
import { structuralShare } from '../client/structural-share.mjs';

const clone = value => JSON.parse(JSON.stringify(value));

test('an unchanged poll returns the previous snapshot itself', () => {
  const previous = { sessionId: 's', running: false, messages: [{ id: 'a', text: 'A', usage: { outputTokens: 2 } }, { id: 'b', text: 'B' }], reactions: { 'message:a': '👍' } };
  assert.equal(structuralShare(previous, clone(previous)), previous);
});

test('only the changed branch receives a new identity', () => {
  const previous = { running: true, messages: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], reactions: {} };
  const next = clone(previous); next.messages[1].text = 'B2'; next.running = false;
  const shared = structuralShare(previous, next);
  assert.notEqual(shared, previous);
  assert.equal(shared.messages[0], previous.messages[0]);
  assert.notEqual(shared.messages[1], previous.messages[1]);
  assert.equal(shared.reactions, previous.reactions);
  assert.deepEqual(shared, next);
});

test('prepended pages and sliding windows keep settled items by identity', () => {
  const previous = [{ id: 'c', text: 'C' }, { id: 'd', text: 'D' }];
  const earlier = structuralShare(previous, [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }, ...clone(previous)]);
  assert.equal(earlier[2], previous[0]); assert.equal(earlier[3], previous[1]);
  const events = [{ eventId: 'e1', text: '1' }, { eventId: 'e2', text: '2' }];
  const slid = structuralShare(events, [{ eventId: 'e2', text: '2' }, { eventId: 'e3', text: '3' }]);
  assert.equal(slid[0], events[1]);
  assert.deepEqual(slid.map(event => event.eventId), ['e2', 'e3']);
});

test('removed keys, type changes and non-plain values are never merged', () => {
  const previous = { error: 'old', failures: [1], value: { a: 1 }, when: new Map([['k', 1]]) };
  const map = new Map([['k', 1]]);
  const shared = structuralShare(previous, { failures: { 0: 1 }, value: [1], when: map });
  assert.equal(Object.hasOwn(shared, 'error'), false);
  assert.deepEqual(shared.failures, { 0: 1 });
  assert.deepEqual(shared.value, [1]);
  assert.equal(shared.when, map);
  assert.equal(structuralShare({ a: undefined }, { b: undefined }).hasOwnProperty('b'), true);
  assert.equal(structuralShare(null, { a: 1 }).a, 1);
  assert.equal(structuralShare({ a: 1 }, null), null);
});
