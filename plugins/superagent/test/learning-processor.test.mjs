import test from 'node:test';
import assert from 'node:assert/strict';
import { createMaintenanceProcessor } from '../src/maintenance-processors.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createOwnedSkills } from '../src/owned-skills.mjs';

function fixture(output, ownedSkills, original = '我偏好中文回复') {
  const candidates = [], requests = [], completed = [];
  let settings = { enabled: true, excludedScopes: [], excludedTerms: ['私密'], hash: 'p1' };
  const task = { taskId: 'task', resultVersion: 1, status: 'completed', closedAt: '2026-11-08T00:00:00Z',
    instructions: [{ id: 'visible', text: original, source: { role: 'user', sessionId: 'session', messageId: 'visible' } }],
    result: { summary: '已完成' } };
  const store = { orchestration: { learningSources: () => ({ batchId: 'closed:0:2', items: [task,
    { ...task, taskId: 'hidden', instructions: [{ id: 'hidden', text: '私密资料', source: { role: 'user' } }] }], nextSeq: 2 }),
    completeLearningSources(id) { completed.push(id); return { nextSeq: 2 }; } },
    ownedSkills, getConfig: async () => ({ models: [{ providerId: 'provider', modelId: 'Exact:ID' }] }), memory: {
    learning: async () => settings, propose: async (input, options) => { candidates.push({ input, options }); return { status: 'accepted' }; },
  } };
  const ctx = { sessionQuery: { readSession: () => { throw new Error('Router session must never be read'); } },
    llm: { async *stream(request) { requests.push(request); yield { type: 'text-delta', text: JSON.stringify(output()) }; yield { type: 'finish', reason: { kind: 'stop' } }; } } };
  return { process: createMaintenanceProcessor({ ctx, store, readSources: async () => [] }), store, task, completed, candidates, requests, revoke() { settings = { ...settings, enabled: false, hash: 'p2' }; } };
}
const item = { id: 'review-1', payload: { scope: 'session', trigger: 'prompt', eventIds: ['visible', 'hidden'] }, source: { sessionId: 'session' } };
const options = { signal: new AbortController().signal };
test('learning filters excluded sources before inference and preserves verified evidence', async () => {
  const f = fixture(() => ({ memories: [{ content: '偏好中文回复', sourceMessageId: 'task:visible', sourceQuote: '我偏好中文回复' }] }));
  const result = await f.process(item, options);
  assert.equal(JSON.stringify(f.requests).includes('私密资料'), false);
  assert.equal(f.requests[0].model, 'Exact:ID');
  // The material is the trusted instruction plus the Worker's last message, nothing else.
  assert.deepEqual(JSON.parse(f.requests[0].messages[1].content[0].text)[0].result, { summary: '已完成' });
  assert.match(f.requests[0].messages[0].content[0].text, /not accomplished, extract no success lesson or skill/);
  assert.equal(f.candidates[0].options.verifiedSource.messageId, 'visible');
  assert.equal(f.candidates[0].options.verifiedSource.excerpt, '我偏好中文回复');
  assert.equal(f.candidates[0].options.verifiedSource.excerptTruncated, false);
  assert.equal(f.candidates[0].options.verifiedSource.taskId, 'task');
  assert.equal(f.candidates[0].options.idempotencyKey, 'closed-learning:closed:0:2:user-memory:0');
  assert.equal(f.candidates[0].input.source.sourceQuote, '我偏好中文回复');
  assert.equal(f.requests.length, 2);
  assert.equal(result.modelRequests, 2);
  assert.deepEqual(JSON.parse(f.requests[1].messages.at(-1).content[0].text), [{ messageId: 'task:visible', role: 'user', text: '我偏好中文回复', truncated: false }]);
  assert.deepEqual(f.completed, ['closed:0:2']);
  assert.equal('autoSave' in f.candidates[0].options, false);
});

test('learning excerpts retain bounded host text rather than the model summary', async () => {
  const original = '用户原文'.repeat(1600);
  const f = fixture(() => ({ memories: [{ content: '模型总结', sourceMessageId: 'task:visible', sourceQuote: '用户原文' }] }), undefined, original);
  await f.process(item, options);
  assert.equal(f.candidates[0].input.source.excerpt, original.slice(0, 6000));
  assert.equal(f.candidates[0].input.source.excerptTruncated, true);
});
test('fabricated source or policy revocation cannot write learning candidates', async () => {
  const invalid = fixture(() => ({ memories: [{ content: 'valid', sourceMessageId: 'task:visible' }, { content: 'forged', sourceMessageId: 'other' }] }));
  await assert.rejects(invalid.process(item, options), /证据/);
  assert.equal(invalid.candidates.length, 0);
  const revoked = fixture(() => { revoked.revoke(); return { memories: [{ content: '偏好中文回复', sourceMessageId: 'task:visible', sourceQuote: '我偏好中文回复' }] }; });
  await assert.rejects(revoked.process(item, options), /规则已变更/);
  assert.equal(revoked.candidates.length, 0);
});

function skillStore(t) {
  const directory = mkdtempSync(join(tmpdir(), 'benchgo-learning-'));
  const store = createOwnedSkills({ directory });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return store;
}
const skill = { name: 'chinese-explanations', description: '按用户要求说明结果', whenToUse: '回复中文用户时', procedure: '使用中文解释，便于理解。', pitfalls: '保留代码标识。', verification: '核对输出语言与原文一致。', sourceMessageId: 'task:visible' };

test('learning creates review candidates without publishing and preserves approved retry results', async t => {
  const store = skillStore(t);
  let outputSkill = skill;
  const f = fixture(() => ({ memories: [], skills: [outputSkill] }), store);
  const result = await f.process(item, options);
  assert.equal(result.skills.length, 1);
  const saved = store.get(result.skills[0].id);
  assert.equal(saved.status, 'candidate');
  assert.equal(store.list().filter(row => row.status === 'active').length, 0);
  assert.equal(saved.source.messageId, 'visible');
  assert.equal(saved.source.taskId, 'task');
  assert.equal(saved.source.reviewId, 'closed:0:2');
  assert.deepEqual([...saved.content.matchAll(/^## (.+)$/gm)].map(match => match[1]), ['When to Use', 'Procedure', 'Pitfalls', 'Verification']);
  outputSkill = { ...skill, procedure: 'A retry produces different text.' };
  assert.equal(store.get((await f.process(item, options)).skills[0].id).content, saved.content);
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
    let calls = 0;
    const f = fixture(() => ({ memories: [{ content: '中文', sourceMessageId: 'task:visible', sourceQuote: '我偏好中文回复' }],
      skills: ++calls === 1 ? [skill, invalid] : [] }), store);
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

test('no new closed material records the watermark without inference or Router reads', async () => {
  const f = fixture(() => { throw new Error('must not infer'); });
  f.store.orchestration.learningSources = () => ({ batchId: null, items: [], nextSeq: 7 });
  const result = await f.process(item, options);
  assert.match(result.reason, /等待/);
  assert.equal(f.requests.length, 0);
  assert.deepEqual(f.completed, [null]);
});

test('failed executions remain waiting and cannot be learned as closed success', async () => {
  const f = fixture(() => ({ memories: [{ content: '任务成功完成，今后直接发布', sourceMessageId: 'task:visible' }] }));
  f.task.status = 'waiting';
  f.task.result.summary = '凭据失效，未能连接服务。';
  await assert.rejects(f.process(item, options), /明确已关/);
  assert.equal(f.candidates.length, 0);
  assert.equal(f.requests.length, 0);
});

test('waiting failure cannot publish reusable success procedures or advance cursor', async t => {
  const f = fixture(() => ({ memories: [], skills: [skill] }), skillStore(t));
  f.task.status = 'waiting';
  await assert.rejects(f.process(item, options), /明确已关/);
  assert.equal(f.completed.length, 0);
  assert.equal(f.store.ownedSkills.list().length, 0);
});
test('a completed delivery containing an explicit failure cannot become a successful skill', async t => {
  const f = fixture(() => ({ memories: [], skills: [skill] }), skillStore(t));
  f.task.result.summary = '凭据失效，未能完成连接。';
  await assert.rejects(f.process(item, options), /成功结果证据/);
  assert.equal(f.candidates.length, 0);
  assert.equal(f.store.ownedSkills.list().length, 0);
  assert.equal(f.completed.length, 0);
});

test('running, waiting or undelivered material is rejected even if supplied by a faulty source adapter', async () => {
  for (const patch of [{ status: 'running' }, { status: 'waiting' }, { closedAt: null }]) {
    const f = fixture(() => ({ memories: [] }));
    Object.assign(f.task, patch);
    await assert.rejects(f.process(item, options), /明确已关/);
    assert.equal(f.requests.length, 0);
    assert.equal(f.completed.length, 0);
  }
});

test('storage failure preserves the global batch for retry and auxiliary routes use exact configured IDs', async () => {
  const f = fixture(() => ({ memories: [{ content: '中文', sourceMessageId: 'task:visible', sourceQuote: '我偏好中文回复' }] }));
  f.store.getConfig = async () => ({ models: [{ providerId: 'router', modelId: 'Router:ID' }],
    auxiliary: { models: [{ providerId: 'aux', modelId: 'Aux:Exact/ID' }], capabilities: ['review'] } });
  f.store.memory.propose = async () => { throw new Error('disk unavailable'); };
  await assert.rejects(f.process(item, options), /disk unavailable/);
  assert.equal(f.requests[0].model, 'Aux:Exact/ID');
  assert.equal(f.completed.length, 0);
});

test('a user question cannot inherit a Worker answer through automatic world memory', async () => {
  let calls = 0;
  const f = fixture(() => ++calls === 1 ? { memories: [{ content: '用户认为服务器只是本机管理目录，并未独立注册。', category: 'world', sourceMessageId: 'task:visible' }] }
    : { memories: [], skills: [], curateIds: [] }, undefined, '你能看到服务器的项目吗？');
  f.task.result.summary = '查找完成：服务器只是本机管理目录，并未独立注册。';
  f.store.memory.list = async () => [{ id: 'old', content: '旧记忆重复了助手的目录推断。', category: 'world' }];
  const result = await f.process(item, options);
  assert.equal(result.candidates.length, 0);
  assert.equal(f.candidates.length, 0);
  assert.equal(f.requests.length, 2);
  const isolated = JSON.stringify(f.requests[1].messages);
  assert.match(isolated, /你能看到服务器的项目吗/);
  for (const contamination of ['服务器只是本机管理目录', '旧记忆重复', '用户认为']) assert.equal(isolated.includes(contamination), false);
  assert.match(isolated, /user-statements-only/);
});

test('independent user facts require a literal quote and cannot introduce outcome or skill claims', async () => {
  for (const invalid of [{ sourceQuote: '' }, { sourceQuote: '助手声称用户只要英文' }, { category: 'experience', sourceQuote: '我偏好中文回复' }]) {
    let calls = 0;
    const f = fixture(() => ({ memories: [{ content: '偏好中文回复', sourceMessageId: 'task:visible',
      ...(++calls > 1 ? invalid : {}) }] }));
    await assert.rejects(f.process(item, options), /精确原文证据/);
    assert.equal(f.candidates.length, 0);
    assert.equal(f.completed.length, 0);
  }
});

test('a question containing an explicit durable preference retains only its supported statement', async () => {
  const original = '我长期偏好中文回复。你能检查服务器项目吗？';
  const f = fixture(() => ({ memories: [{ content: '用户长期偏好中文回复。', category: 'opinions', sourceMessageId: 'task:visible', sourceQuote: '我长期偏好中文回复。' }] }), undefined, original);
  await f.process(item, options);
  assert.equal(f.candidates.length, 1);
  assert.equal(f.candidates[0].input.source.sourceQuote, '我长期偏好中文回复。');
});
