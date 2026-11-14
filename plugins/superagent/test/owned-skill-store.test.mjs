import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installOwnedSkillStore } from '../src/owned-skill-store.mjs';

const DAY = 86400000;
function open(path = ':memory:') {
  const db = new DatabaseSync(path);
  const tx = fn => { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } };
  return { db, ...installOwnedSkillStore({ db, tx }) };
}
const create = (api, id = 'example') => api.saveOwnedSkill({ id, body: '# Example\nReusable rule', source: { reviewId: 'review-1' }, now: 0 });

test('idleness stays a signal and use watermark survives reopening without automatic archival', () => {
  const dir = mkdtempSync(join(tmpdir(), 'benchgo-owned-skills-')); let api;
  try {
    api = open(join(dir, 'skills.db')); create(api);
    api.recordOwnedSkillUse('example', { eventId: 'session:step:skill', now: 15 * DAY });
    api.db.close(); api = open(join(dir, 'skills.db'));
    const version = api.getOwnedSkill('example').version;
    api.recordOwnedSkillUse('example', { eventId: 'session:step:skill', now: 29 * DAY });
    assert.equal(api.getOwnedSkill('example').version, version);
    assert.equal(api.getOwnedSkill('example').lastUsedAt, 15 * DAY);
    api.recordOwnedSkillFeedback('example', { eventId: 'f1', text: 'Actual feedback', source: { messageId: 'feedback' }, now: 45 * DAY });
    assert.equal(api.ownedSkillReviewInputs({ now: 60 * DAY })[0].idleDays, 45);
    assert.equal(api.getOwnedSkill('example').version, version, 'reading idleDays does not change skill state or version');
    api.db.close(); api = open(join(dir, 'skills.db'));
    assert.equal(api.getOwnedSkill('example').state, 'active');
    assert.equal(api.ownedSkillAudit('example').filter(row => row.action === 'archived').length, 0);
    // Explicitly archived skill state and restoration remain supported.
    api.db.prepare("UPDATE sa_owned_skills SET state='archived' WHERE id=?").run('example');
    const restored = api.restoreOwnedSkill('example', { expectedVersion: api.getOwnedSkill('example').version, now: 60 * DAY });
    assert.equal(restored.state, 'active');
  } finally { api?.db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('review inputs require durable real feedback, persist deduplication and bind evidence to the body', () => {
  const dir = mkdtempSync(join(tmpdir(), 'benchgo-skill-feedback-')); let api;
  try {
    api = open(join(dir, 'skills.db')); create(api);
    assert.deepEqual(api.ownedSkillReviewInputs(), []);
    api.recordOwnedSkillUse('example', { eventId: 'real-load', now: DAY });
    assert.deepEqual(api.ownedSkillReviewInputs(), [], 'loading is not a success outcome');
    assert.throws(() => api.recordOwnedSkillFeedback('example', { eventId: 'f1', text: 'Worked', source: {}, outcome: 'success' }), /source/);
    assert.throws(() => api.recordOwnedSkillFeedback('third-party', { eventId: 'f1', text: 'Worked', source: { messageId: 'm1' } }), /not found/);
    assert.throws(() => api.recordOwnedSkillFeedback('example', { eventId: 'f1', text: 'Worked', source: { messageId: 'm1' }, useEventId: 'preview' }), /evidence/);
    const saved = api.recordOwnedSkillFeedback('example', { eventId: 'f1', text: 'Actual result was wrong.', source: { messageId: 'm1', taskId: 't1' }, outcome: 'failure', useEventId: 'real-load', now: 2 * DAY });
    assert.equal(saved.outcome, 'failure');
    api.db.close(); api = open(join(dir, 'skills.db'));
    assert.deepEqual(api.recordOwnedSkillFeedback('example', { eventId: 'f1', text: 'ignored duplicate', source: { messageId: 'm1' } }), saved);
    const [input] = api.ownedSkillReviewInputs({ now: 3 * DAY });
    assert.equal(input.idleDays, 2);
    assert.deepEqual(input.feedback, [saved]);
    const oldVersion = api.getOwnedSkill('example').version;
    api.saveOwnedSkill({ id: 'example', body: 'Corrected procedure', source: { reviewId: 'r2' }, expectedVersion: oldVersion, now: 3 * DAY });
    assert.deepEqual(api.ownedSkillReviewInputs(), [], 'old feedback cannot validate a changed procedure');
    assert.throws(() => api.recordOwnedSkillFeedback('example', { eventId: 'old-use', text: 'Old procedure worked', source: { messageId: 'm2' }, useEventId: 'real-load' }), /current body/);
    api.recordOwnedSkillFeedback('example', { eventId: 'f2', text: 'Observed success.', source: { taskId: 't2' }, outcome: 'success' });
    assert.equal(api.ownedSkillReviewInputs()[0].feedback[0].outcome, 'success');
    api.setOwnedSkillFixed('example', { fixed: true, expectedVersion: api.getOwnedSkill('example').version });
    assert.deepEqual(api.ownedSkillReviewInputs(), [], 'fixed skills are excluded from background review');
    assert.throws(() => api.ownedSkillReviewInputs({ limit: 0 }), /limit/);
  } finally { api?.db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('legacy usage metadata migrates without inventing evidence for a skill body', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE sa_skill_uses(event_id TEXT PRIMARY KEY,skill_id TEXT NOT NULL,used_at INTEGER NOT NULL)');
    db.prepare('INSERT INTO sa_skill_uses VALUES(?,?,?)').run('legacy-load', 'example', 0);
    const api = installOwnedSkillStore({ db, tx: fn => fn() });
    create(api);
    assert.throws(() => api.recordOwnedSkillFeedback('example', { eventId: 'legacy-feedback', text: 'Unknown body', source: { messageId: 'm1' }, useEventId: 'legacy-load' }), /current body/);
    assert.equal(api.getOwnedSkill('example').state, 'active');
  } finally { db.close(); }
});

test('fixed skills cannot be changed or automatically archived; unknown third party skills are never adopted', () => {
  const api = open();
  try {
    create(api);
    api.setOwnedSkillFixed('example', { fixed: true, expectedVersion: 1, now: 1 });
    assert.deepEqual(api.ownedSkillReviewInputs({ now: 100 * DAY }), []);
    assert.throws(() => api.saveOwnedSkill({ id: 'example', body: 'rewrite', source: { reviewId: 'r2' }, expectedVersion: 2 }), /Fixed/);
    assert.throws(() => api.recordOwnedSkillUse('third-party', { eventId: 'use' }), /not found/);
    assert.equal(api.listOwnedSkills().length, 1);
  } finally { api.db.close(); }
});

test('immutable snapshots support rollback with CAS and preserve both revisions', () => {
  const api = open();
  try {
    const original = create(api);
    const seq = api.ownedSkillAudit('example')[0].seq;
    api.saveOwnedSkill({ id: 'example', body: 'new content', source: { reviewId: 'r2' }, expectedVersion: 1, now: 1 });
    assert.throws(() => api.restoreOwnedSkill('example', { expectedVersion: 1, snapshotSeq: seq }), /version conflict/);
    const result = api.restoreOwnedSkill('example', { expectedVersion: 2, snapshotSeq: seq, now: 2 });
    assert.equal(result.body, original.body);
    assert.deepEqual(api.ownedSkillAudit('example').map(row => row.body), [original.body, 'new content', original.body]);
    assert.throws(() => api.saveOwnedSkill({ id: '../outside', body: 'bad', source: { reviewId: 'r2' } }), /id/);
  } finally { api.db.close(); }
});
