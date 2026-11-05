import test from 'node:test';
import assert from 'node:assert/strict';
import { createLearningProcessor } from '../src/learning-processor.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createOwnedSkills } from '../src/owned-skills.mjs';

function fixture(output, ownedSkills) {
  const candidates = [], requests = [];
  let settings = { enabled: true, excludedScopes: [], excludedTerms: ['私密'], hash: 'p1' };
  const store = { ownedSkills, getConfig: async () => ({ models: [{ providerId: 'provider', modelId: 'Exact:ID' }] }), memory: {
    learning: async () => settings, propose: async (input, options) => { candidates.push({ input, options }); return { status: 'accepted' }; },
  } };
  const ctx = { sessionQuery: { readSession: async () => ({ events: [
    { type: 'user/message', data: { id: 'visible', source: { kind: 'user' }, content: [{ type: 'text', text: '我偏好中文回复' }] } },
    { type: 'user/message', data: { id: 'hidden', source: { kind: 'user' }, content: [{ type: 'text', text: '私密资料' }] } },
  ] }) }, llm: { async *stream(request) { requests.push(request); yield { type: 'text-delta', text: JSON.stringify(output()) }; yield { type: 'finish', reason: { kind: 'stop' } }; } } };
  return { process: createLearningProcessor({ ctx, store }), candidates, requests, revoke() { settings = { ...settings, enabled: false, hash: 'p2' }; } };
}
const item = { id: 'review-1', payload: { scope: 'session', trigger: 'prompt', eventIds: ['visible', 'hidden'] }, source: { sessionId: 'session' } };
const options = { signal: new AbortController().signal };
test('learning filters excluded sources before inference and preserves verified evidence', async () => {
  const f = fixture(() => ({ memories: [{ content: '偏好中文回复', sourceMessageId: 'visible' }] }));
  await f.process(item, options);
  assert.equal(JSON.stringify(f.requests).includes('私密资料'), false);
  assert.equal(f.requests[0].model, 'Exact:ID');
  assert.equal(f.candidates[0].options.verifiedSource.messageId, 'visible');
  assert.equal('autoSave' in f.candidates[0].options, false);
});
test('fabricated source or policy revocation cannot write learning candidates', async () => {
  const invalid = fixture(() => ({ memories: [{ content: 'valid', sourceMessageId: 'visible' }, { content: 'forged', sourceMessageId: 'other' }] }));
  await assert.rejects(invalid.process(item, options), /证据/);
  assert.equal(invalid.candidates.length, 0);
  const revoked = fixture(() => { revoked.revoke(); return { memories: [{ content: '偏好中文回复', sourceMessageId: 'visible' }] }; });
  await assert.rejects(revoked.process(item, options), /规则已变更/);
  assert.equal(revoked.candidates.length, 0);
});

function skillStore(t) {
  const directory = mkdtempSync(join(tmpdir(), 'benchgo-learning-'));
  const store = createOwnedSkills({ directory });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return store;
}
const skill = { name: 'chinese-explanations', description: '按用户要求说明结果', whenToUse: '回复中文用户时', procedure: '使用中文解释，便于理解。', pitfalls: '保留代码标识。', verification: '核对输出语言与原文一致。', sourceMessageId: 'visible' };

test('learning creates review candidates without publishing and preserves approved retry results', async t => {
  const store = skillStore(t);
  let outputSkill = skill;
  const f = fixture(() => ({ memories: [], skills: [outputSkill] }), store);
  const result = await f.process(item, options);
  assert.equal(result.skills.length, 1);
  const saved = result.skills[0];
  assert.equal(saved.status, 'candidate');
  assert.equal(store.list().filter(row => row.status === 'active').length, 0);
  assert.deepEqual(saved.source, { role: 'user', sessionId: 'session', messageId: 'visible', reviewId: 'review-1' });
  assert.deepEqual([...saved.content.matchAll(/^## (.+)$/gm)].map(match => match[1]), ['When to Use', 'Procedure', 'Pitfalls', 'Verification']);
  outputSkill = { ...skill, procedure: 'A retry produces different text.' };
  assert.equal((await f.process(item, options)).skills[0].content, saved.content);
  const approved = store.approve(saved.id, { revision: saved.revision });
  store.pin(approved.id, { revision: approved.revision, pinned: true });
  const retry = (await f.process(item, options)).skills[0];
  assert.equal(retry.id, saved.id);
  assert.equal(retry.status, 'approved');
  assert.equal(store.get(saved.id).content, saved.content);
  assert.equal(store.get(saved.id).pinned, true);
  assert.equal(store.list().length, 1);
  assert.equal(store.audit(saved.id).filter(row => row.action === 'create').length, 1);
});

test('rejected learning candidates remain rejected across retries', async t => {
  const store = skillStore(t);
  const f = fixture(() => ({ memories: [], skills: [skill] }), store);
  const saved = (await f.process(item, options)).skills[0];
  store.reject(saved.id, { revision: saved.revision });
  assert.equal((await f.process(item, options)).skills[0].status, 'rejected');
  assert.equal(store.list().length, 0);
});

test('all skill evidence and fields are validated before any memory or skill is written', async t => {
  const store = skillStore(t);
  for (const invalid of [{ ...skill, name: 'Invalid Name' }, { ...skill, sourceMessageId: 'hidden' }, { ...skill, verification: '' }, { ...skill, procedure: '私密资料' }, null]) {
    const f = fixture(() => ({ memories: [{ content: '中文', sourceMessageId: 'visible' }], skills: [skill, invalid] }), store);
    await assert.rejects(f.process(item, options), /学习技能/);
    assert.equal(f.candidates.length, 0);
    assert.equal(store.list().length, 0);
  }
});

test('revoked policy cannot produce owned skills', async t => {
  const store = skillStore(t);
  const f = fixture(() => { f.revoke(); return { memories: [], skills: [skill] }; }, store);
  await assert.rejects(f.process(item, options), /规则已变更/);
  assert.equal(store.list().length, 0);
});
