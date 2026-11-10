import test from 'node:test';
import assert from 'node:assert/strict';
import { notificationPublication } from '../src/notification-publication.mjs';
import { systemStateDelivery } from '../src/result-delivery.mjs';

test('verified system publications retain their identity through repeated projections', () => {
  const publication = systemStateDelivery({ state: 'continuation_wait', code: 'NETWORK', stage: 'execution' });
  const event = notificationPublication({ type: 'ticket.result', ticketId: 'ticket', publication,
    origin: 'router', systemState: { state: 'untrusted' }, text: 'RAW WORKER TEXT' });
  assert.equal(event.origin, 'system');
  assert.deepEqual(event.systemState, { state: 'continuation_wait', code: 'NETWORK', stage: 'execution' });
  assert.equal(event.text, publication.text);
  assert.deepEqual(notificationPublication(event), event);
});

test('system metadata comes only from validated publication, never the event envelope', () => {
  const systemState = { state: 'budget_wait', code: 'BUDGET', stage: 'execution' };
  for (const type of ['ticket.result', 'ticket.attention']) {
    const event = notificationPublication({ type, origin: 'system', systemState, text: 'Question',
      ...(type === 'ticket.result' ? { publication: { action: 'ask', text: 'Which city?', options: ['上海', '北京'] } } : {}) });
    assert.equal(event.origin, undefined);
    assert.equal(event.systemState, undefined);
    if (type === 'ticket.result') assert.deepEqual(event.options, ['上海', '北京']);
  }
});

test('invalid system publications are suppressed instead of becoming assistant text', () => {
  const valid = systemStateDelivery();
  for (const publication of [
    { ...valid, origin: undefined },
    { ...valid, systemState: { ...valid.systemState, state: 'invented' } },
    { ...valid, systemState: { ...valid.systemState, code: 'untrusted code' } },
    { ...valid, action: 'ask' },
  ]) assert.equal(notificationPublication({ type: 'ticket.result', publication, text: 'Fallback must not publish' }), null);
});

test('Router acknowledgements keep their provenance and cannot carry system metadata', () => {
  const event = notificationPublication({ type: 'ticket.accepted', origin: 'router', ticketId: 'ticket',
    requestId: 'request', text: '我来整理这些信息。', systemState: { state: 'untrusted' } });
  assert.equal(event.origin, 'router');
  assert.equal(event.systemState, undefined);
  assert.equal(event.text, '我来整理这些信息。');
  assert.equal(notificationPublication({ ...event, origin: 'system' }), null);
});
