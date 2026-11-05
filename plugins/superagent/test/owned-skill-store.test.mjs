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

test('Curator thresholds and use watermark survive reopening without duplicate archival', () => {
  const dir = mkdtempSync(join(tmpdir(), 'benchgo-owned-skills-')); let api;
  try {
    api = open(join(dir, 'skills.db')); create(api);
    api.configureCurator({ staleDays: 14, archiveDays: 30 });
    assert.equal(api.curateOwnedSkills({ now: 14 * DAY })[0].state, 'stale');
    api.recordOwnedSkillUse('example', { eventId: 'session:step:skill', now: 15 * DAY });
    api.db.close(); api = open(join(dir, 'skills.db'));
    const version = api.getOwnedSkill('example').version;
    api.recordOwnedSkillUse('example', { eventId: 'session:step:skill', now: 29 * DAY });
    assert.equal(api.getOwnedSkill('example').version, version);
    assert.equal(api.getOwnedSkill('example').lastUsedAt, 15 * DAY);
    assert.deepEqual(api.curateOwnedSkills({ now: 28 * DAY }), []);
    assert.equal(api.curateOwnedSkills({ now: 45 * DAY })[0].state, 'archived');
    api.db.close(); api = open(join(dir, 'skills.db'));
    assert.deepEqual(api.curateOwnedSkills({ now: 60 * DAY }), []);
    assert.equal(api.ownedSkillAudit('example').filter(row => row.action === 'archived').length, 1);
    const restored = api.restoreOwnedSkill('example', { expectedVersion: api.getOwnedSkill('example').version, now: 60 * DAY });
    assert.equal(restored.state, 'active');
    assert.deepEqual(api.curateOwnedSkills({ now: 60 * DAY }), []);
    assert.deepEqual(api.curatorPolicy(), { staleDays: 14, archiveDays: 30, llmMerge: false });
  } finally { api?.db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('fixed skills cannot be changed or automatically archived; unknown third party skills are never adopted', () => {
  const api = open();
  try {
    create(api);
    api.setOwnedSkillFixed('example', { fixed: true, expectedVersion: 1, now: 1 });
    assert.deepEqual(api.curateOwnedSkills({ now: 100 * DAY }), []);
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
    assert.throws(() => api.configureCurator({ staleDays: 30, archiveDays: 14 }), /thresholds/);
    assert.throws(() => api.saveOwnedSkill({ id: '../outside', body: 'bad', source: { reviewId: 'r2' } }), /id/);
  } finally { api.db.close(); }
});
