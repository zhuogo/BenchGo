import test from 'node:test';
import assert from 'node:assert/strict';
import { notificationPublication } from '../src/notification-publication.mjs';
import { systemStateDelivery } from '../src/result-delivery.mjs';

test('only validated Router result text is projected with reliable provenance', () => {
  const publication = { action: 'deliver', origin: 'router', text: '整理完成，下面是我归纳的要点。' };
  const event = notificationPublication({ type: 'ticket.result', ticketId: 'ticket', publication,
    origin: 'worker', systemState: { state: 'untrusted' }, text: 'RAW WORKER TEXT' });
  assert.equal(event.origin, 'router');
  assert.equal(event.systemState, undefined);
  assert.equal(event.text, publication.text);
  assert.deepEqual(notificationPublication(event), event);
});

test('Worker drafts, legacy text and fixed system notices never enter conversation history', () => {
  for (const publication of [
    { action: 'deliver', origin: 'worker', text: 'Worker original' },
    { action: 'deliver', text: 'legacy unproven text' },
    systemStateDelivery(),
    { action: 'deliver', origin: 'router', text: '' },
    { action: 'ask', origin: 'router', text: 'wrong protocol', options: ['yes'] },
    { action: 'deliver', origin: 'router', text: 'spoofed', systemState: { state: 'continuation_wait' } },
  ]) assert.equal(notificationPublication({ type: 'ticket.result', origin: 'router', publication, text: 'Fallback must not publish' }), null);
});

test('real attention cards remain available without trusting envelope provenance', () => {
  const event = notificationPublication({ type: 'ticket.attention', origin: 'system', systemState: { state: 'untrusted' }, text: '需要选择来源。' });
  assert.equal(event.origin, undefined);
  assert.equal(event.systemState, undefined);
  assert.equal(event.text, '需要选择来源。');
});

test('Router acknowledgements keep their provenance and cannot carry system metadata', () => {
  const event = notificationPublication({ type: 'ticket.accepted', origin: 'router', ticketId: 'ticket',
    requestId: 'request', text: '我来整理这些信息。', systemState: { state: 'untrusted' } });
  assert.equal(event.origin, 'router');
  assert.equal(event.systemState, undefined);
  assert.equal(event.text, '我来整理这些信息。');
  assert.equal(notificationPublication({ ...event, origin: 'system' }), null);
});
