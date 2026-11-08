import test from 'node:test';
import assert from 'node:assert/strict';
import { resultDelivery, resultOutbox, validateDelivery, deliverySuppression } from '../src/result-delivery.mjs';
import { commitWorkerResult } from '../src/result-commit.mjs';

const ticket = { id: 't', title: '原任务', target: '完整要求', instructionRevision: 2, resultVersion: 0, mandate: { source: { channel: 'desktop', sessionId: 'owner' } } };
const result = { summary: '备用摘要', finalSummary: '  原正文\n\n保留段落与结尾。\n', selfCheck: { summary: '已按要求核对文本，零文件' }, outcome: 'completed', evidenceRefs: [] };

test('original Worker body with title forms the outbox without rewriting or truncation', () => {
  const delivery = resultDelivery({ ticket, result });
  assert.equal(delivery.text, `【原任务】\n\n${result.finalSummary}`);
  assert.equal(delivery.origin, 'worker');
  assert.deepEqual(resultOutbox({ ticket, result, delivery }), { type: 'ticket.result', ticketId: 't', title: '原任务', source: ticket.mandate.source,
    instructionRevision: 2, resultVersion: 1, outcome: 'completed', publication: delivery, text: delivery.text, evidenceRefs: [] });
  assert.equal(validateDelivery({ ...delivery, text: 'x'.repeat(20000) }).text.length, 20000);
});

test('self-check is a record from the Worker and never another model verdict', () => {
  let committed;
  const database = { commitResult: (id, input) => (committed = { id, ...input }) };
  commitWorkerResult({ database, ticket, result, uniqueKey: 'result' });
  assert.equal(committed.status, 'waiting');
  assert.deepEqual(committed.result.selfCheck, result.selfCheck);
  assert.equal(committed.result.review, undefined);
  assert.throws(() => commitWorkerResult({ database, ticket, result: { ...result, selfCheck: undefined } }), { code: 'SELF_CHECK_MISSING' });
  assert.throws(() => commitWorkerResult({ database, ticket, result: { ...result, selfCheckRevision: 1 } }), { code: 'INSTRUCTION_REVISION_CONFLICT' });
});

test('structural failure needs attempts, cause and changed conditions; unknown effects cannot be delivered as terminal', () => {
  const database = { commitResult: (_id, input) => input };
  assert.throws(() => commitWorkerResult({ database, ticket, result: { ...result, outcome: 'failed' } }), /Structural failure/);
  const failure = { attempted: '查询两项来源', cause: '数据已永久删除', resumeConditions: '恢复原始数据后可继续' };
  const saved = commitWorkerResult({ database, ticket, result: { ...result, outcome: 'failed', failure } });
  assert.equal(saved.outboxPayload.outcome, 'failed');
  assert.equal(saved.status, 'waiting');
  assert.throws(() => commitWorkerResult({ database, ticket, result: { ...result, executionEffects: { effectsVerified: false } } }), { code: 'EXECUTION_EFFECTS_UNKNOWN' });
});

test('superseded requirements and sources are suppressed rather than delivered', () => {
  const row = { ticketId: 't', payload: resultOutbox({ ticket, result, delivery: resultDelivery({ ticket, result }) }) };
  const database = { getTicket: () => ({ ...ticket, resultVersion: 1 }) };
  assert.equal(deliverySuppression(database, row), null);
  assert.equal(deliverySuppression({ getTicket: () => ({ ...ticket, resultVersion: 1, instructionRevision: 3 }) }, row), 'superseded-instruction');
  assert.equal(deliverySuppression(database, { ...row, payload: { ...row.payload, source: { channel: 'other' } } }), 'source-mismatch');
});
