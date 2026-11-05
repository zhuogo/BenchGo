import assert from 'node:assert/strict';
import test from 'node:test';
import { latestPetExpression, petActionForSession, petExpressionForAction, petImageUrl, petDesignIntent, isRetiredPetDraft } from '../client/pet-state.mjs';

test('action feedback changes builtin faces and only uses a custom characters own faces', () => {
  assert.equal(petExpressionForAction(null, 'focus'), 'think');
  assert.equal(petExpressionForAction(null, 'waiting'), 'stare');
  assert.notEqual(petImageUrl(null, 'https://local/', 'think'), petImageUrl(null, 'https://local/', 'happy'));
  const custom = { kind: 'custom', expressions: { happy: 'own.png' } };
  assert.equal(petExpressionForAction(custom, 'happy'), 'happy');
  assert.equal(petExpressionForAction(custom, 'focus'), null);
  assert.equal(petExpressionForAction(custom, 'idle'), null);
});

test('expression playback selects the latest unexpired event for the current appearance', () => {
  const older = { eventId: 'old', revision: 3, expression: 'happy', createdAt: 1000 };
  const newer = { ...older, eventId: 'new', createdAt: 2000 };
  assert.equal(latestPetExpression([older, newer], 3, 3000), newer);
  assert.equal(latestPetExpression([older, newer], 4, 3000), null);
  assert.equal(latestPetExpression([older, newer], 3, 12000), null);
  assert.equal(latestPetExpression([newer], 3, 1500), null);
});

test('custom expressions remain attached to their own appearance with safe same-origin resources', () => {
  const main = '12345678-1234-1234-1234-123456789012.png';
  const happy = '87654321-1234-1234-1234-123456789012.png';
  const pet = { kind: 'custom', assetId: main, expressions: { happy, unsafe: 'https://tracker.example/image.png' } };
  const base = 'https://bench.example/workbench/';
  assert.equal(new URL(petImageUrl(pet, base, 'happy')).searchParams.get('id'), happy);
  for (const expression of ['missing', 'unsafe', undefined]) assert.equal(new URL(petImageUrl(pet, base, expression)).searchParams.get('id'), main);
  assert.equal(new URL(petImageUrl(pet, base)).origin, 'https://bench.example');
  assert.equal(petImageUrl({ ...pet, assetId: '../../secret' }, base), undefined);
});

test('pet motion follows real running and approval facts, not reply completion', () => {
  assert.equal(petActionForSession({ running: true }), 'focus');
  assert.equal(petActionForSession({ running: true, pendingInteraction: { kind: 'approval' } }), 'waiting');
  assert.equal(petActionForSession({ running: true, openState: 'error' }), 'idle');
  assert.equal(petActionForSession({ running: false, completionUnread: true }), 'idle');
});

test('design entry carries only a source-bound hint, never an automatic user draft', () => {
  let notifications = 0;
  assert.equal(petDesignIntent.getSnapshot(), null);
  const unsubscribe = petDesignIntent.subscribe(() => notifications++);
  petDesignIntent.request('side');
  assert.deepEqual(petDesignIntent.getSnapshot(), { threadId: 'side', kind: 'design' });
  petDesignIntent.clear();
  assert.equal(petDesignIntent.getSnapshot(), null);
  assert.equal(notifications, 2);
  unsubscribe();
});

test('retired preset cleanup preserves edits, attachments, references and in-flight submissions', () => {
  const input = { phase: 'plain', draft: '我想设计你的宠物形象：\n\n请先了解我的想法，优先复用可用素材，生成后让我预览再应用。' };
  assert.equal(isRetiredPetDraft(input), true);
  for (const patch of [{ draft: input.draft + '我想要蓝色' }, { draft: '我的草稿' }, { draft: '' }, { attachmentIds: ['image'] }, { occurrences: [{}] }, { phase: 'submitting' }]) {
    assert.equal(isRetiredPetDraft({ ...input, ...patch }), false);
  }
});
