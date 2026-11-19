import test from 'node:test';
import assert from 'node:assert/strict';
import { askNativeQuestion } from '../src/questions.mjs';

test('human answers preserve Codex IDs, OpenCode order and Claude question keys', async () => {
  const details = { questions: [{ id: 'q1', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] };
  const ask = async ({ questions }) => ({ answers: questions.map(q => ({ id: q.id, selected: ['B'], custom: 'extra' })) });
  assert.deepEqual(await askNativeQuestion('codex', { details }, ask), { allow: false, answers: { q1: { answers: ['B', 'extra'] } } });
  assert.deepEqual(await askNativeQuestion('opencode', { details }, ask), { allow: false, answers: [['B', 'extra']] });
  assert.deepEqual(await askNativeQuestion('claude', { details }, ask), { allow: true, answers: { 'Which?': 'B, extra' } });
});

test('Pi choice and text input use actual human values; missing answers are never invented', async () => {
  assert.deepEqual(await askNativeQuestion('pi', { details: { title: 'Choose', options: ['A', 'B'] } }, async () => ({ answers: [{ id: 'value', selected: ['B'] }] })), { allow: false, value: 'B' });
  assert.deepEqual(await askNativeQuestion('pi', { details: { title: 'Input' } }, async () => ({ answers: [{ id: 'value', selected: [], custom: '' }] })), { allow: false, value: '' });
  await assert.rejects(askNativeQuestion('codex', { details: { questions: [{ id: 'q1', question: 'Q' }] } }, async () => ({ answers: [] })), /did not answer/);
});

test('Pi ordinary confirmations require an explicit human Yes and never use permission allow', async () => {
  for (const [selected, confirmed] of [[['Yes'], true], [['No'], false], [[], false], [['Yes', 'No'], false]]) {
    const result = await askNativeQuestion('pi', { kind: 'question', details: { method: 'confirm', title: 'Continue?', message: 'Human decision' } }, async ({ questions }) => {
      assert.deepEqual(questions[0].options, [{ label: 'Yes' }, { label: 'No' }]);
      return { answers: [{ id: 'value', selected }] };
    });
    assert.deepEqual(result, { allow: false, confirmed });
  }
  assert.deepEqual(await askNativeQuestion('pi', { details: { method: 'confirm' } }, async () => ({ answers: [{ id: 'value', selected: [], custom: 'Yes' }] })), { allow: false, confirmed: false });
});

test('ACP human choice maps only its exact option label back to the opaque optionId', async () => {
  const details = { acpOptions: [{ label: '1. A', optionId: 'opaque:a/1' }, { label: '2. A', optionId: 'opaque:a/2' }], questions: [{ question: 'Choose', options: [{ label: '1. A' }, { label: '2. A' }] }] };
  assert.deepEqual(await askNativeQuestion('gemini', { details }, async () => ({ answers: [{ id: '0', selected: ['2. A'] }] })), { allow: false, selectedOptionId: 'opaque:a/2' });
  for (const answer of [{ id: '0', selected: [], custom: '2. A' }, { id: '0', selected: ['invented'] }, { id: '0', selected: ['1. A', '2. A'] }]) {
    assert.deepEqual(await askNativeQuestion('gemini', { details }, async () => ({ answers: [answer] })), { allow: false });
  }
});
