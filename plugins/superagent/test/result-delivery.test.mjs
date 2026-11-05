import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDelivery, systemStateDelivery, resultDelivery, resultOutbox, deliverySuppression } from '../src/result-delivery.mjs';

const ticket = { id: 't', resultVersion: 0, instructionRevision: 1, status: 'completed', mandate: { source: { channel: 'desktop', threadId: 'original' } } };
const result = { summary: 'WORKER_RAW_INTERNAL', evidenceRefs: ['proof'], transcript: { hash: 'host-evidence' } };

test('Router-authored text, never Worker prose, forms the human outbox', () => {
  const delivery = resultDelivery({ ticket, result, verdict: { verdict: 'passed', delivery: { action: 'deliver', text: 'Verified answer.', options: ['Open artifact'] } } });
  const payload = resultOutbox({ ticket, result, delivery });
  assert.equal(payload.text, 'Verified answer.');
  assert.equal(JSON.stringify(payload).includes(result.summary), false);
  assert.deepEqual(payload.source, ticket.mandate.source);
  assert.equal(payload.resultVersion, 1);
  assert.equal(payload.instructionRevision, 1);
});

test('missing delivery never falls back to raw execution output', () => {
  const delivery = resultDelivery({ ticket, result, verdict: { verdict: 'passed' } });
  assert.equal(delivery.action, 'deliver');
  assert.equal(delivery.text.includes(result.summary), false);
  assert.equal(delivery.origin, 'system');
  assert.equal(delivery.systemState.state, 'delivery_wait');
  assert.equal(delivery.systemState.code, 'ROUTER_DELIVERY_MISSING');
  assert.match(delivery.text, /^系统状态/);
  assert.doesNotMatch(delivery.text, /任务已通过验收/);
});

test('natural Router delivery, correction and blocker texts survive publication unchanged', () => {
  const text = '  保留首尾与段落。\n\n下一步说明。\n';
  for (const verdict of ['passed', 'rework', 'failed', 'wait']) {
    const delivery = resultDelivery({ ticket, result, verdict: { verdict, delivery: { action: 'deliver', text } } });
    assert.equal(resultOutbox({ ticket, result, delivery }).text, text);
  }
  assert.equal(resultDelivery({ ticket, result, verdict: { verdict: 'wait', userDecision: { kind: 'information', question: '具体信息？' },
    delivery: { action: 'ask', text } } }).text, text);
});

test('requested outcomes and failed work cannot be silenced by AI', () => {
  for (const verdict of ['passed', 'failed', 'wait']) {
    assert.equal(resultDelivery({ ticket, result, verdict: { verdict, delivery: { action: 'silent' } } }).action, 'deliver');
  }
  const previous = { ...result, instructionRevision: 1, review: { verdict: 'passed' }, delivery: { action: 'deliver' } };
  assert.equal(resultDelivery({ ticket, result, previous, previousDelivered: true, verdict: { verdict: 'passed', delivery: { action: 'silent' } } }).action, 'silent');
});

test('options are bounded plain replies and require accompanying text', () => {
  assert.throws(() => validateDelivery({ action: 'ask', options: ['yes'] }));
  assert.throws(() => validateDelivery({ action: 'deliver', text: 'ok', options: [{ approval: true }] }));
  assert.throws(() => validateDelivery({ action: 'silent', text: 'notify' }));
  assert.deepEqual(validateDelivery({ action: 'ask', text: 'Choose?', options: ['yes', 'yes'] }).options, ['yes']);
});

test('host system states preserve their explicit origin and reject malformed metadata', () => {
  const status = systemStateDelivery({ state: 'review_wait', code: 'NETWORK', stage: 'review' });
  assert.deepEqual(validateDelivery(status), status);
  assert.equal(resultOutbox({ ticket, result, delivery: status }).publication.origin, 'system');
  assert.doesNotMatch(systemStateDelivery({ state: 'continuation_wait' }).text, /系统会|自动继续|自动恢复/);
  for (const value of [
    { ...status, origin: undefined },
    { ...status, action: 'ask' },
    { ...status, systemState: { ...status.systemState, code: 'provider error containing secrets' } },
    { ...status, systemState: { ...status.systemState, state: 'success' } },
  ]) assert.throws(() => validateDelivery(value));
});

test('stale Attention questions obey the same revision, source and cancellation publication gate', () => {
  let current = { ...ticket, status: 'waiting', resultVersion: 2 };
  const row = { ticketId: ticket.id, payload: { type: 'ticket.attention', attentionId: 'a', source: ticket.mandate.source, instructionRevision: 1, resultVersion: 2 } };
  const database = { getTicket: () => current };
  assert.equal(deliverySuppression(database, row), null);
  current = { ...current, resultVersion: 3 };
  assert.equal(deliverySuppression(database, row), 'superseded-result');
  current = { ...current, resultVersion: 2, instructionRevision: 2 };
  assert.equal(deliverySuppression(database, row), 'superseded-instruction');
  current = { ...ticket, status: 'cancelled' };
  assert.equal(deliverySuppression(database, row), 'ticket-inactive');
  current = { ...ticket, status: 'completed', resultVersion: 2 };
  assert.equal(deliverySuppression(database, row), 'ticket-inactive');
  current = { ...ticket, status: 'waiting', resultVersion: 2 };
  database.attentions = () => [{ id: 'a', answerTriggerId: 'answer' }];
  assert.equal(deliverySuppression(database, row), 'attention-resolved');
});

test('publication rechecks target revision, result version, source and cancellation', () => {
  const payload = resultOutbox({ ticket, result, delivery: { action: 'deliver', text: 'done' } });
  let current = { ...ticket, resultVersion: 1 };
  const database = { getTicket: () => current };
  const row = { ticketId: 't', payload };
  assert.equal(deliverySuppression(database, row), null);
  current = { ...current, instructionRevision: 2 };
  assert.equal(deliverySuppression(database, row), 'superseded-instruction');
  current = { ...ticket, resultVersion: 2 };
  assert.equal(deliverySuppression(database, row), 'superseded-result');
  current = { ...ticket, resultVersion: 1, mandate: { source: { channel: 'desktop', threadId: 'other' } } };
  assert.equal(deliverySuppression(database, row), 'source-mismatch');
  current = { ...ticket, status: 'cancelled' };
  assert.equal(deliverySuppression(database, row), 'ticket-inactive');
});
