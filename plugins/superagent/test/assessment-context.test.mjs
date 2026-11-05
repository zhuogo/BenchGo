import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAssessmentContextWindow } from '../src/assessment-context.mjs';

const rows = () => Array.from({ length: 30 }, (_, i) => ({ id: `t${i + 1}`, seq: i + 1, threadId: 'thread', content: `message ${i + 1}`, source: { messageId: `m${i + 1}` }, actor: { id: 'owner' } }));

test('window retains head and trigger neighbours, stubs other originals without mutation', () => {
  const triggers = rows().reverse(), original = structuredClone(triggers);
  const window = buildAssessmentContextWindow({ triggers, triggerId: 't20' });
  assert.deepEqual(window.messages.filter(row => row.kind === 'inline').map(row => row.number), [1, 2, 3, 4, 5, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25]);
  assert.equal(window.messages[8].content, undefined);
  assert.deepEqual(window.messages[8].pointer, { triggerId: 't9', source: { messageId: 'm9' } });
  window.messages[0].actor.id = 'changed';
  assert.deepEqual(triggers, original);
});

test('excerpts retain original length and pointer without broken surrogate pairs', () => {
  const triggers = rows(); triggers[0].content = 'a😀b';
  const card = buildAssessmentContextWindow({ triggers, triggerId: 't1', maxContentLength: 2 }).messages[0];
  assert.equal(card.content, 'a'); assert.equal(card.fullLength, 4); assert.equal(card.truncated, true);
});

test('cross-thread context is excluded and late input leaves prior snapshot unchanged', () => {
  const triggers = rows();
  const before = buildAssessmentContextWindow({ triggers, triggerId: 't30' });
  triggers.push({ ...triggers[0], id: 'other', threadId: 'other' }, { ...triggers[0], id: 'late', seq: 40 });
  const after = buildAssessmentContextWindow({ triggers, triggerId: 't30' });
  assert.equal(before.total, 30); assert.equal(after.total, 31);
  assert.equal(after.messages.at(-1).kind, 'inline');
  assert.equal(after.messages.some(row => row.triggerId === 'other'), false);
});

test('invalid or ambiguous source order is rejected', () => {
  assert.throws(() => buildAssessmentContextWindow({ triggers: rows(), triggerId: 'missing' }));
  const triggers = rows(); triggers[1].seq = 1;
  assert.throws(() => buildAssessmentContextWindow({ triggers, triggerId: 't1' }));
  assert.throws(() => buildAssessmentContextWindow({ triggers: rows(), triggerId: 't1', beforeCount: -1 }));
});
