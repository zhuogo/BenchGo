import test from 'node:test';
import assert from 'node:assert/strict';
import { findReviewReminder, reviewReminderMatches, reviewActionDetails, reviewApprovalResponse, reviewConnectionError, reviewDisplayText, reviewDisplayValue, reviewSessionOpenError, sameReviewOrigin } from '../client/approval-review.mjs';
import { approvalReminderNavigation } from '../client/approval-flow.mjs';

const worker = { kind: 'worker', taskId: 'task', assignmentId: 'assignment', runId: 'run', sessionId: 'worker', ownerSessionId: 'router', ownerThreadId: 'main' };
const router = { kind: 'router', sessionId: 'router', ownerSessionId: 'router', ownerThreadId: 'main' };

const binding = { sessionId: 'worker', callId: 'call', approvalId: 'durable-id', actionId: 'action', taskId: 'task', assignmentId: 'assignment', runId: 'run', ownerThreadId: 'main', eventKey: 'approval:worker:durable-id' };
const reminder = () => ({ role: 'assistant', requestId: 'reminder', approval: { ...binding } });
const entry = () => ({ origin: { ...worker }, pending: { sessionId: 'worker', callId: 'call', key: 'approval:unrelated-client-sequence', toolName: 'assistant_external_action', answerable: true, reason: '批准本次具体外部动作（仅本次有效）：\n' + JSON.stringify({ actionId: 'action' }) } });

test('inline reminder matches the trusted action and run, never the transient client key or unrelated request', () => {
  assert(reviewReminderMatches(reminder(), entry()));
  for (const key of ['sessionId', 'callId', 'actionId', 'taskId', 'assignmentId', 'runId', 'ownerThreadId', 'eventKey']) {
    const row = reminder(); row.approval[key] = 'wrong'; assert(!reviewReminderMatches(row, entry()), key);
  }
  for (const change of [{ answerable: false }, { toolName: 'other' }, { reason: '{"actionId":"action"}' }, { callId: undefined }]) {
    const current = entry(); Object.assign(current.pending, change); assert(!reviewReminderMatches(reminder(), current));
  }
  assert(!reviewReminderMatches({ ...reminder(), role: 'user' }, entry()));
});

test('review reminder search follows only the owner history and bounds a stalled or endless cursor', async () => {
  let reads = 0;
  const row = reminder();
  assert.equal(await findReviewReminder(async (action, input) => {
    assert.equal(action, 'history'); assert.equal(input.threadId, 'main'); reads++;
    return input.before ? { messages: [row], hasMore: false } : { messages: [], hasMore: true, nextBefore: 9 };
  }, entry()), row);
  assert.equal(reads, 2);
  for (const stalled of [true, false]) {
    reads = 0;
    await assert.rejects(findReviewReminder(async () => ({ messages: [], hasMore: true, nextBefore: stalled ? 1 : ++reads }), entry()), /暂未找到/);
    if (!stalled) assert.equal(reads, 20);
  }
});

test('approval navigation clears only the consumed target so a late view cannot erase a newer navigation', () => {
  approvalReminderNavigation.open(reminder()); const old = approvalReminderNavigation.getSnapshot();
  approvalReminderNavigation.open({ ...reminder(), requestId: 'new' }); const current = approvalReminderNavigation.getSnapshot();
  approvalReminderNavigation.clear(old); assert.equal(approvalReminderNavigation.getSnapshot(), current);
  approvalReminderNavigation.clear(current); assert.equal(approvalReminderNavigation.getSnapshot(), null);
});

test('review identity preserves Worker fences and current Router ownership without borrowing either role', () => {
  assert(sameReviewOrigin(worker, { ...worker })); assert(sameReviewOrigin(router, { ...router }));
  for (const change of [{ kind: 'router' }, { runId: 'other' }, { assignmentId: 'other' }, { ownerThreadId: 'side' }, { ownerSessionId: 'old' }]) assert(!sameReviewOrigin(worker, { ...worker, ...change }));
  for (const change of [{ kind: 'worker' }, { sessionId: 'old' }, { ownerSessionId: 'other' }, { ownerThreadId: 'side' }]) assert(!sameReviewOrigin(router, { ...router, ...change }));
  assert(!sameReviewOrigin(null, null)); assert(!sameReviewOrigin({ kind: 'router' }, { kind: 'router' }));
});

test('review decisions re-read current server origin before settling the same official pending', async () => {
  for (const origin of [worker, router]) {
    const answers = [], pending = { answerable: true, answer: async value => { answers.push(value); pending.answerable = false; } };
    let reads = 0;
    const response = reviewApprovalResponse({ origin, pending, readOrigins: async () => { reads++; return [origin]; } });
    await assert.rejects(response.answer('allowed-always'), /只允许本次/);
    await response.answer('allowed-once'); assert.deepEqual(answers, ['allowed-once']); assert.equal(reads, 1);
    await assert.rejects(response.answer('rejected'), /失效/);
  }
});

test('review rejects stopped or replaced sources, aborts and double clicks without answering', async () => {
  for (const origin of [worker, router]) {
    let answers = 0;
    const pending = { answerable: true, answer: async () => { answers++; } };
    const revoked = reviewApprovalResponse({ origin, pending, readOrigins: async () => [] });
    await assert.rejects(revoked.answer('allowed-once'), /来源已失效/);
    let resolve;
    const blocked = new Promise(done => { resolve = done; });
    const response = reviewApprovalResponse({ origin, pending, readOrigins: () => blocked });
    const first = response.answer('rejected'); await assert.rejects(response.answer('allowed-once'), /正在提交/);
    pending.answerable = false; resolve([origin]); await assert.rejects(first, /来源已失效/); assert.equal(answers, 0);
  }
});

test('review read failure can retry rejection; unmounted card can never answer', async () => {
  const answers = [], pending = { answerable: true, answer: async value => answers.push(value) }; let reads = 0;
  const response = reviewApprovalResponse({ origin: worker, pending, readOrigins: async () => { if (++reads === 1) throw Error('offline'); return [worker]; } });
  await assert.rejects(response.answer('rejected'), /offline/); assert(response.canAnswer());
  await response.answer('rejected'); assert.deepEqual(answers, ['rejected']);
  const removed = reviewApprovalResponse({ origin: router, pending, readOrigins: async () => [router], isCurrent: () => false });
  await assert.rejects(removed.answer('allowed-once'), /失效/); assert.deepEqual(answers, ['rejected']);
});

test('review formats exact frozen-action reason for reading and never treats other text as authority', () => {
  const details = { category: 'external-send', origin: null, target: { channel: 'feishu', chatId: 'private-chat' }, content: { text: 'EXACT BODY' } };
  assert.deepEqual(reviewActionDetails({ toolName: 'assistant_external_action', reason: '批准本次具体外部动作（仅本次有效）：\n' + JSON.stringify(details) }), details);
  for (const pending of [{ toolName: 'other', reason: JSON.stringify(details) }, { toolName: 'assistant_external_action', reason: JSON.stringify(details) },
    { toolName: 'assistant_external_action', reason: '批准本次具体外部动作（仅本次有效）：\n{broken' }]) assert.equal(reviewActionDetails(pending), null);
});

test('settled ready still requires an actually open official Session and preserves causal errors', () => {
  let state = { openState: 'error', openError: new Error('读取渠道会话失败', { cause: new Error('system event must be first') }) };
  const reference = { binding: { session: { getSnapshot: () => state } } };
  assert.equal(reviewSessionOpenError(reference), '读取渠道会话失败；原因：system event must be first');
  state = { openState: 'opening', openError: null };
  assert.equal(reviewSessionOpenError(reference), '会话尚未打开（opening）');
  state = { openState: 'open', openError: null }; assert.equal(reviewSessionOpenError(reference), '');
  const recursive = new Error('循环原因'); recursive.cause = recursive;
  assert.equal(reviewConnectionError(recursive), '循环原因');
});

test('review redacts credentials for display without mutating the frozen approval payload', () => {
  const original = { target: { endpoint: 'https://name:secret@example.test/action', authorization: 'secret-auth', chatId: 'opaque-target-id', token: 'private-token-value' },
    content: { text: 'Send this exact body\napi_key=private-value\nBearer private-token', password: 'private-password', nested: [{ refresh_token: 'private-refresh' }] } };
  const before = JSON.stringify(original), value = reviewDisplayValue(original), display = JSON.stringify(value);
  for (const secret of ['name:secret', 'secret-auth', 'private-value', 'private-token', 'private-password', 'private-refresh']) assert(!display.includes(secret), secret);
  assert.equal(value.target.chatId, 'opaque-target-id', 'opaque business identifiers are not rewritten');
  assert(value.content.text.startsWith('Send this exact body\n'));
  assert.equal(JSON.stringify(original), before, 'redaction never changes the pending request or authority binding');
  assert.equal(reviewDisplayText('-----BEGIN PRIVATE KEY-----\nprivate\n-----END PRIVATE KEY-----'), '[凭据已隐藏]');
});
