import test from 'node:test';
import assert from 'node:assert/strict';
import { chatPublicationType, chatPublicationRecordOf, hostReplyPublicationOf, isTaskResultReplyRequest } from '../shared/public-chat-record.mjs';

const request = { id: 'request', source: { kind: 'benchgo-task-reply', replyKind: 'result', replyMode: 'conversation', taskId: 'task', eventKey: 'result:event' } };
const record = data => ({ type: chatPublicationType, ignorable: true, data: { kind: 'final', requestId: request.id, text: '完成正文', ...data } });

test('conversation result records expose a bound ordinary final while historical private drafts stay private', () => {
  const final = record({ taskReplyEventKey: request.source.eventKey });
  assert.equal(isTaskResultReplyRequest(request), true);
  assert.equal(chatPublicationRecordOf(final, request), final.data);
  assert.equal(hostReplyPublicationOf(final, request), null);
  const draft = record({ kind: 'task-reply' });
  assert.equal(hostReplyPublicationOf(draft, request), draft.data);
  assert.equal(chatPublicationRecordOf(draft, request), null);
  assert.equal(chatPublicationRecordOf(final, { ...request, source: { ...request.source, replyMode: undefined } }), null);
  assert.equal(chatPublicationRecordOf(record({ requestId: 'foreign' }), request), null);
  assert.equal(chatPublicationRecordOf(record({ suppressed: true, text: undefined }), request), null);
});

test('state publishes only a validated task reply record and preserves suppression and old permit privacy', () => {
  const state = { ...request, source: { ...request.source, replyKind: 'state' } };
  const published = record({ kind: 'task-reply' });
  assert.equal(chatPublicationRecordOf(published, state), published.data);
  assert.equal(chatPublicationRecordOf(record({ kind: 'state-final-permit' }), state), null);
  assert.equal(chatPublicationRecordOf(record({ kind: 'task-reply', suppressed: true, text: undefined }), state), null);
  assert.equal(chatPublicationRecordOf(record({}), state), null);
});
