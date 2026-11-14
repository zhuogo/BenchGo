import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { createAssistantStore } from '../src/store.mjs';
import { ASSISTANT_CONTEXT_DOCUMENTS, documentHash } from '../src/documents.mjs';
import { cleanMemoryContext } from '../src/memory.mjs';

test('context uses the ordered five-document chain while preserving legacy tool notes', async t => {
  const { store } = await fixture(t);
  const first = await store.getContext();
  assert.deepEqual(first.documents.map(row => row.name), ASSISTANT_CONTEXT_DOCUMENTS);
  assert.equal(first.snapshotId, (await store.getContext()).snapshotId);
  const tools = await store.documents.read('TOOLS.md');
  await store.documents.update('TOOLS.md', { content: 'Legacy tools stay available', expectedHash: tools.hash });
  assert.equal(first.snapshotId, (await store.getContext()).snapshotId);
  assert.equal((await store.documents.read('TOOLS.md')).content, 'Legacy tools stay available');
  const soul = await store.documents.read('SOUL.md');
  await store.documents.update('SOUL.md', { content: 'New personality', expectedHash: soul.hash });
  const next = await store.getContext();
  assert.notEqual(first.snapshotId, next.snapshotId);
  assert.equal(first.documents[0].content, soul.content);
  assert.equal(next.documents[0].content, 'New personality');
});

async function fixture(t) {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'assistant-memory-'));
  const stores = [];
  const open = async () => { const store = await createAssistantStore({ dataDirectory }); stores.push(store); return store; };
  t.after(async () => { stores.forEach(store => store.close()); await rm(dataDirectory, { recursive: true, force: true }); });
  return { dataDirectory, open, store: await open() };
}

test('document edits use hashes across stores, import external edits and restore exact versions', async t => {
  const { store, open } = await fixture(t);
  const other = await open(), original = await store.documents.read('SOUL.md');
  await assert.rejects(store.documents.update('SOUL.md', { content: 'new' }), /expectedHash/);
  const outcomes = await Promise.allSettled([
    store.documents.update('SOUL.md', { content: '风格一', expectedHash: original.hash }),
    other.documents.update('SOUL.md', { content: '风格二', expectedHash: original.hash }),
  ]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(result => result.status === 'rejected').reason.code, 'HASH_CONFLICT');
  await writeFile(join(store.paths.directory, 'SOUL.md'), '外部编辑器修改');
  const external = await other.documents.read('SOUL.md');
  assert.equal(external.source.type, 'external-edit');
  assert.equal(external.content, '外部编辑器修改');
  const history = await store.documents.versions('SOUL.md');
  const initial = history.find(row => row.hash === original.hash);
  const restored = await store.documents.restore('SOUL.md', { versionId: initial.id, expectedHash: external.hash });
  assert.equal(restored.content, original.content);
  await assert.rejects(store.documents.read('../config.json'), /未知/);
  await unlink(join(store.paths.directory, 'TOOLS.md'));
  await assert.rejects(open(), /缺失/);
});

test('prepared journals recover from a file replacement without replaying abandoned or conflicting writes', async t => {
  const { store, open } = await fixture(t);
  const initial = await store.documents.read('SOUL.md');
  const db = new DatabaseSync(store.paths.database);
  const put = (content, oldHash) => {
    const id = randomUUID(), versionId = randomUUID(), date = new Date().toISOString();
    db.prepare('INSERT INTO document_versions VALUES (?,?,?,?,?,?,?,?)').run(versionId, 'SOUL.md', documentHash(content), content, initial.revision + 1, date, JSON.stringify({ type: 'test-crash' }), 'prepared');
    db.prepare('INSERT INTO document_journal VALUES (?,?,?,?,?,?,?)').run(id, 'SOUL.md', oldHash, documentHash(content), versionId, 'prepared', date);
    return id;
  };
  const committed = put('已落盘但未提交索引', initial.hash);
  await writeFile(join(store.paths.directory, 'SOUL.md'), '已落盘但未提交索引');
  const restarted = await open();
  assert.equal((await restarted.documents.read('SOUL.md')).content, '已落盘但未提交索引');
  assert.equal(db.prepare('SELECT status FROM document_journal WHERE id=?').get(committed).status, 'committed');
  const abandoned = put('不应重放', documentHash('已落盘但未提交索引'));
  await restarted.documents.read('SOUL.md');
  assert.equal(db.prepare('SELECT status FROM document_journal WHERE id=?').get(abandoned).status, 'aborted');
  const conflicted = put('后台想写的内容', documentHash('已落盘但未提交索引'));
  await writeFile(join(store.paths.directory, 'SOUL.md'), '用户另有编辑');
  assert.equal((await restarted.documents.read('SOUL.md')).content, '用户另有编辑');
  assert.equal(db.prepare('SELECT status FROM document_journal WHERE id=?').get(conflicted).status, 'conflict');
  db.close();
});

test('Chinese search rereads Markdown, verifies phrases and correction excludes old evidence', async t => {
  const { store } = await fixture(t);
  const first = await store.saveMemory({ content: '项目支持中文检索和多任务并行', source: { sessionId: 's', messageId: 'old' }, scope: 'project' });
  await store.saveMemory({ content: '中文展示与项目检索是两件事', source: { sessionId: 's', messageId: 'other' } });
  assert.equal((await store.memory.search({ query: '检索' })).length, 2);
  assert.deepEqual((await store.memory.search({ query: '中文检索' })).map(row => row.id), [first.id]);
  assert.equal((await store.memory.search({ query: '任务并行', scope: 'project' }))[0].source.messageId, 'old');
  await store.saveMemory({ ...first, content: '项目使用普通索引', source: { sessionId: 's', messageId: 'new' } }, { revision: first.revision });
  assert.equal((await store.memory.search({ query: '多任务并行' })).length, 0);
  const oldEvidence = { role: 'user', sessionId: 's', messageId: 'old' };
  assert.equal((await store.memory.propose({ content: '项目可以并行任务', source: oldEvidence }, { verifiedSource: oldEvidence })).status, 'excluded');
  const doc = await store.documents.read(first.document);
  await store.documents.update(first.document, { expectedHash: doc.hash, content: doc.content + '\n用户手工补充了跨平台路径约定\n' });
  assert.match((await store.memory.search({ query: '跨平台' }))[0].content, /跨平台路径/);
});

test('verified learning saves immediately without approval flags and obeys current exclusions', async t => {
  const { store } = await fixture(t);
  const evidence = { role: 'user', sessionId: 's', messageId: 'm' };
  const input = { content: '以后回复简洁中文', source: evidence, document: 'USER.md' };
  assert.equal((await store.memory.propose(input)).status, 'excluded');
  assert.equal((await store.listMemories()).length, 0);
  const saved = await store.memory.propose(input, { verifiedSource: evidence });
  assert.equal(saved.status, 'accepted');
  assert.notEqual(saved.id, saved.memoryId);
  assert.doesNotMatch(saved.memoryId, /candidate-/u);
  assert.equal((await store.listMemories())[0].candidateId, saved.id);
  assert.equal((await store.listMemories())[0].document, 'USER.md');
  assert.equal((await store.memory.search({ query: '简洁中文' }))[0].id, saved.memoryId);
  await store.memory.configureLearning({ enabled: false, excludedScopes: ['private'], excludedTerms: ['私人电话'] });
  assert.equal((await store.memory.propose({ ...input, content: '保存私人电话' }, { verifiedSource: evidence })).status, 'excluded');
  assert.equal((await store.memory.propose({ ...input, content: '另一项私人事实', scope: 'private' }, { verifiedSource: evidence })).status, 'excluded');
  assert.equal((await store.memory.propose({ ...input, content: '以后用紧凑列表' }, { verifiedSource: evidence })).status, 'excluded');
  await store.memory.configureLearning({ enabled: true, excludedTerms: ['简洁中文'] });
  assert.equal((await store.memory.propose({ ...input, content: '另一项私人事实', scope: 'private' }, { verifiedSource: evidence })).status, 'excluded');
  assert.equal((await store.memory.propose({ ...input, content: '回复简洁中文' }, { verifiedSource: evidence })).status, 'excluded');
  assert.equal((await store.memory.search({ query: '简洁中文' })).length, 0);
  const context = await store.memory.context();
  assert.doesNotMatch(context.documents.find(row => row.name === 'USER.md').content, /以后回复简洁中文/u);
  assert.match((await store.documents.read('USER.md')).content, /以后回复简洁中文/u);
  assert.equal((await store.memory.propose({ ...input, content: '以后用紧凑列表' }, { verifiedSource: evidence })).status, 'accepted');
});

function storedCandidate(store, { id = randomUUID(), content = '已有的待确认记忆', status = 'pending', evidence = { role: 'user', sessionId: 's', messageId: id }, source = evidence || { type: 'review' } } = {}) {
  const candidate = { id, status, input: { content, source }, evidence, createdAt: new Date().toISOString() };
  const db = new DatabaseSync(store.paths.database);
  const key = documentHash(content.normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, ' ').trim());
  db.prepare('INSERT INTO memory_candidates VALUES (?,?,?,?,?)').run(id, key, status, JSON.stringify(candidate), candidate.createdAt);
  db.close();
  return candidate;
}
function candidateRows(store, status) {
  const db = new DatabaseSync(store.paths.database);
  try { return db.prepare('SELECT payload FROM memory_candidates WHERE status=? ORDER BY created_at').all(status).map(row => JSON.parse(row.payload)); }
  finally { db.close(); }
}

test('pending and interrupted writes recover once while rejected and untrusted records stay inactive', async t => {
  const { store, open } = await fixture(t);
  const pending = storedCandidate(store);
  const interrupted = storedCandidate(store, { content: '已有的未完成写入', status: 'saving' });
  storedCandidate(store, { content: '用户已经拒绝', status: 'rejected' });
  storedCandidate(store, { content: '没有可信来源', evidence: null });
  const restarted = await open();
  const entries = await restarted.listMemories();
  assert.deepEqual(new Set(entries.map(row => row.candidateId)), new Set([pending.id, interrupted.id]));
  assert.ok(entries.every(row => !row.id.startsWith('candidate-')));
  assert.deepEqual(candidateRows(store, 'pending'), []);
  assert.deepEqual(candidateRows(store, 'saving'), []);
  assert.deepEqual(new Set(candidateRows(store, 'accepted').map(row => row.id)), new Set([pending.id, interrupted.id]));
  assert.equal((await (await open()).listMemories()).length, 2);
  await restarted.memory.forget(entries.find(row => row.candidateId === pending.id).id);
  assert.equal((await restarted.memory.propose(pending.input, { verifiedSource: pending.evidence })).status, 'excluded');
});

test('recovery respects disabled learning and does not revive an excluded record later', async t => {
  const { store, open } = await fixture(t);
  await store.memory.configureLearning({ enabled: false });
  const paused = storedCandidate(store, { content: '停用学习时不能写入' });
  const restarted = await open();
  assert.equal((await restarted.listMemories()).length, 0);
  assert.deepEqual(candidateRows(store, 'excluded').map(row => row.id), [paused.id]);
  await restarted.memory.configureLearning({ enabled: true });
  assert.equal((await (await open()).listMemories()).length, 0);
});

test('failed automatic persistence is reported and retries reuse the same durable identity', async t => {
  const { store, open } = await fixture(t);
  const evidence = { role: 'user', sessionId: 's', messageId: 'retry' };
  const input = { content: '故障后只保存一次的记忆', source: evidence };
  const mutate = store.documents.mutate;
  store.documents.mutate = async (...args) => { await mutate(...args); throw new Error('write receipt interrupted'); };
  await assert.rejects(store.memory.propose(input, { verifiedSource: evidence }), /write receipt interrupted/);
  const [retry] = candidateRows(store, 'saving');
  assert.match(retry.error, /write receipt interrupted/);
  store.documents.mutate = mutate;
  const restarted = await open();
  const saved = await restarted.memory.propose(input, { verifiedSource: evidence });
  assert.equal(saved.id, retry.id);
  assert.doesNotMatch(saved.memoryId, /candidate-/u);
  assert.equal((await store.listMemories())[0].candidateId, retry.id);
  assert.equal((await store.listMemories()).length, 1);
  assert.equal((await (await open()).listMemories()).length, 1);
});

test('closed-learning slots survive changed model output and never revive corrected or forgotten sources', async t => {
  const { store, open } = await fixture(t);
  const evidence = { role: 'user', sessionId: 's', messageId: 'closed-human', taskId: 'closed-task', taskId: 'closed-task', resultVersion: 1 };
  const options = { verifiedSource: evidence, idempotencyKey: 'closed-learning:closed:0:1:memory:0' };
  const first = await store.memory.propose({ content: '第一次整理', source: evidence }, options);
  const restarted = await open();
  const retried = await restarted.memory.propose({ content: '模型重新总结的另一句话', source: evidence }, options);
  assert.equal(retried.memoryId, first.memoryId);
  assert.equal((await store.listMemories()).length, 1);
  const entry = (await store.listMemories())[0];
  await store.saveMemory({ id: entry.id, content: '用户纠正后的结论', source: { type: 'user-edit' } }, { revision: entry.revision });
  assert.equal((await restarted.memory.propose({ content: '换句话恢复旧结论', source: evidence }, options)).status, 'excluded');
  await store.memory.forget(entry.id);
  assert.equal((await (await open()).memory.propose({ content: '再次试图恢复', source: evidence }, options)).status, 'excluded');
  assert.equal((await store.listMemories()).length, 0);
});

test('closed-learning duplicate slots retain their original receipt when retry wording changes', async t => {
  const { store, open } = await fixture(t);
  const evidence = { role: 'user', sessionId: 's', messageId: 'slot-human' };
  const first = await store.memory.propose({ content: '已有自动记忆', source: evidence }, { verifiedSource: evidence });
  const options = { verifiedSource: evidence, idempotencyKey: 'closed-learning:duplicate:memory:0' };
  assert.equal((await store.memory.propose({ content: '已有自动记忆', source: evidence }, options)).memoryId, first.memoryId);
  assert.equal((await (await open()).memory.propose({ content: '模型重试换词', source: evidence }, options)).memoryId, first.memoryId);
  assert.equal((await store.listMemories()).length, 1);
  const manual = await store.saveMemory({ content: '已有手工记忆', source: { type: 'user-edit' } });
  const manualOptions = { verifiedSource: evidence, idempotencyKey: 'closed-learning:duplicate:memory:1' };
  assert.equal((await store.memory.propose({ content: '已有手工记忆', source: evidence }, manualOptions)).memoryId, manual.id);
  await store.memory.forget(manual.id);
  assert.equal((await (await open()).memory.propose({ content: '改写已忘手工内容', source: evidence }, manualOptions)).status, 'excluded');
});

test('closed learning cannot evade forgotten human evidence by dropping Router tool-call metadata', async t => {
  const { store, open } = await fixture(t);
  const original = { role: 'user', sessionId: 'router', messageId: 'human-memory', callId: 'router-memory-call' };
  const entry = await store.saveMemory({ content: '用户要求忘记的事实', source: original });
  await store.memory.forget(entry.id);
  const closed = { role: 'user', sessionId: 'router', messageId: 'human-memory', taskId: 'closed-task', resultVersion: 1 };
  const result = await (await open()).memory.propose({ content: '旧事实改写为全新措辞', source: closed },
    { verifiedSource: closed, idempotencyKey: 'closed-learning:forgotten:0' });
  assert.equal(result.status, 'excluded');
  assert.equal((await store.listMemories()).length, 0);
});

test('invalid UTF-8 and damaged memory metadata are reported without recreating or overwriting files', async t => {
  const { store } = await fixture(t);
  const path = join(store.paths.directory, 'SOUL.md');
  const bytes = Buffer.from([0xff, 0xfe, 0x80]);
  await writeFile(path, bytes);
  await assert.rejects(store.documents.read('SOUL.md'), /encoded data/u);
  assert.deepEqual(await readFile(path), bytes);
  await writeFile(path, '恢复的风格');
  const body = '<!-- benchgo-memory {"id":"damaged"} -->\n不要丢失这段人工内容\n<!-- /benchgo-memory -->';
  const daily = 'memory/2026-11-13.md';
  await store.documents.write(daily, { content: body });
  await assert.rejects(store.listMemories(), error => error.code === 'MEMORY_PARSE_ERROR');
  assert.equal(await readFile(join(store.paths.directory, daily), 'utf8'), body);
});

test('concurrent automatic learning across stores creates one durable memory', async t => {
  const { store, open } = await fixture(t), other = await open();
  const evidence = { role: 'user', sessionId: 's', messageId: 'unique' };
  const input = { content: '唯一的自动记忆', source: evidence };
  const results = await Promise.all([store.memory.propose(input, { verifiedSource: evidence }), other.memory.propose(input, { verifiedSource: evidence })]);
  assert.equal(results[0].memoryId, results[1].memoryId);
  assert.doesNotMatch(results[0].memoryId, /candidate-/u);
  assert.equal((await store.listMemories())[0].candidateId, results[0].id);
  assert.equal((await store.listMemories()).filter(row => row.content === input.content).length, 1);
  assert.equal((await other.memory.propose(input, { verifiedSource: evidence })).memoryId, results[0].memoryId);
});

test('manual source excerpts use current input and corrections retain ID and version references', async t => {
  const { store } = await fixture(t);
  const first = await store.saveMemory({ content: '最初的原文', source: { kind: 'user', excerpt: '不应复用的摘要' } });
  assert.equal(first.source.excerpt, '最初的原文');
  const second = await store.saveMemory({ ...first, content: '第二次手工输入' }, { revision: first.revision });
  const third = await store.saveMemory({ ...second, content: '新'.repeat(6500) }, { revision: second.revision });
  assert.equal(third.id, first.id);
  assert.equal(third.revision, 3);
  assert.equal(third.source.excerpt.length, 6000);
  assert.equal(third.source.excerptTruncated, true);
  assert.deepEqual(third.supersedes, { id: first.id, revision: 2, updatedAt: second.updatedAt });
  assert.deepEqual(third.versionChain.map(row => row.revision), [1, 2]);
  assert.ok(third.versionChain.every(row => row.id === first.id && !('content' in row)));
  assert.ok((await store.documents.versions(first.document)).some(row => row.content.includes('第二次手工输入')));
});

test('model projections strip HTML comments without changing stored or frozen originals', async t => {
  const { store } = await fixture(t);
  const entry = await store.saveMemory({ content: '可用正文<!-- 不发送的内部注释 -->', source: { type: 'user-edit' } });
  const frozen = await store.getSessionContext('projection');
  const before = structuredClone(frozen);
  const projected = cleanMemoryContext({ ...frozen, userProfile: '用户<!-- 注释 -->', assistantIdentity: '身份<!-- 未闭合' });
  assert.deepEqual(frozen, before);
  assert.equal(projected.memories.find(row => row.id === entry.id).content, '可用正文');
  assert.equal(projected.memories.find(row => row.id === entry.id).source.excerpt, '可用正文');
  assert.equal(projected.userProfile, '用户');
  assert.equal(projected.assistantIdentity, '身份');
  assert.ok(projected.documents.every(row => !row.content.includes('<!--')));
  assert.match((await store.documents.read(entry.document)).content, /benchgo-memory/u);
  assert.deepEqual(await store.getSessionContext('projection'), before);
});

test('forget removes verified excerpts from managed documents, versions, candidate receipts and frozen snapshots', async t => {
  const { store } = await fixture(t);
  const secret = '用户原话中的私人事实';
  const evidence = { role: 'user', sessionId: 's-excerpt', messageId: 'm-excerpt', excerpt: secret, excerptTruncated: false };
  const candidate = await store.memory.propose({ content: '整理后的私人记忆', source: evidence }, { verifiedSource: evidence });
  assert.equal((await store.listMemories())[0].source.excerpt, secret);
  await store.getSessionContext('excerpt-forget');
  await store.memory.forget(candidate.memoryId);
  assert.doesNotMatch(JSON.stringify(await store.documents.list()), /用户原话中的私人事实|整理后的私人记忆/u);
  assert.doesNotMatch(JSON.stringify(await store.documents.versions('MEMORY.md')), /用户原话中的私人事实|整理后的私人记忆/u);
  assert.doesNotMatch(JSON.stringify(await store.getSessionContext('excerpt-forget')), /用户原话中的私人事实|整理后的私人记忆/u);
  assert.deepEqual(candidateRows(store, 'accepted'), []);
});

test('forget scrubs clean full documents even when selected memories are absent, truncated or an older revision', async t => {
  const { store } = await fixture(t);
  const text = `## 长期私密事项\n\n${'个人细节'.repeat(650)}<!-- 内部注释 -->\n\n后续说明`;
  const entry = await store.saveMemory({ content: text, document: 'USER.md', source: { type: 'user-edit' } });
  await store.saveMemory({ content: '保留的公共偏好', document: 'USER.md', source: { type: 'user-edit' } });
  const frozen = await store.getSessionContext('old-revision');
  const projected = cleanMemoryContext(frozen);
  const first = { ...projected, userProfile: projected.documents.find(row => row.name === 'USER.md').content, memories: projected.memories.map(row => ({ ...row, content: row.content.slice(0, 2000) })) };
  const omitted = { ...first, memories: [] };
  await store.saveMemory({ id: entry.id, content: '修正后的个人细节', source: { type: 'user-edit' } }, { revision: entry.revision });
  await store.memory.forget(entry.id);
  for (const context of [first, omitted, frozen]) {
    const redacted = store.memory.redactForgottenContext(context);
    assert.doesNotMatch(JSON.stringify(redacted), /长期私密事项|个人细节|后续说明/u);
    assert.match(JSON.stringify(redacted), /保留的公共偏好/u);
  }
});

test('profile import without memories preserves all target memory documents', async t => {
  const { store: source } = await fixture(t), { store: target } = await fixture(t);
  for (const document of ['MEMORY.md', 'USER.md', 'TOOLS.md']) {
    await source.memory.save({ content: `source-secret-${document}`, document, source: { type: 'user-edit' } });
    await target.memory.save({ content: `target-value-${document}`, document, source: { type: 'user-edit' } });
  }
  const before = await target.documents.list(), bundle = await source.profileExport();
  const result = await target.profileImport(bundle, { apply: true, overwrite: true, includeMemories: false });
  assert.equal(result.memories, 0);
  for (const document of ['MEMORY.md', 'USER.md', 'TOOLS.md']) {
    assert.equal((await target.documents.read(document)).content, before.find(row => row.name === document).content);
    assert.ok(!result.documents.includes(document));
  }
  assert.doesNotMatch(JSON.stringify(await target.listMemories()), /source-secret/);
});

test('forget removes managed history and blocks old sources without claiming deletion of original conversations', async t => {
  const { store, open } = await fixture(t);
  const secret = '这是应被彻底移除的个人事实';
  const entry = await store.saveMemory({ content: secret, source: { sessionId: 's1', messageId: 'm1' } });
  await store.saveMemory({ content: '需要保留的项目决定', source: { sessionId: 's1', messageId: 'm2' } });
  const frozen = await store.getSessionContext('privacy-session');
  assert.ok(JSON.stringify(frozen).includes(secret));
  const soul = await store.documents.read('SOUL.md');
  await store.documents.update('SOUL.md', { content: 'Ordinary edits must remain unfrozen', expectedHash: soul.hash });
  await store.memory.forget(entry.id);
  const scrubbed = await store.getSessionContext('privacy-session');
  assert.ok(!JSON.stringify(scrubbed).includes(secret));
  assert.ok(JSON.stringify(scrubbed).includes('需要保留的项目决定'));
  assert.equal(scrubbed.documents.find(row => row.name === 'SOUL.md').content, soul.content);
  assert.equal(scrubbed.hashes['MEMORY.md'], documentHash(scrubbed.documents.find(row => row.name === 'MEMORY.md').content));
  assert.equal((await store.listMemories()).length, 1);
  for (const version of await store.documents.versions('MEMORY.md')) assert.ok(!version.content.includes(secret));
  const restarted = await open();
  assert.ok(!JSON.stringify(await restarted.getSessionContext('privacy-session')).includes(secret));
  const forgottenEvidence = { role: 'user', sessionId: 's1', messageId: 'm1' };
  assert.equal((await restarted.memory.propose({ content: '换句话重复这条个人事实', source: forgottenEvidence }, { verifiedSource: forgottenEvidence })).status, 'excluded');
  const db = new DatabaseSync(store.paths.database);
  assert.ok(!db.prepare('SELECT context FROM session_context_snapshots WHERE session_id=?').get('privacy-session').context.includes(secret));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_terms WHERE entry_id=?').get(entry.id).n, 0);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 0);
  db.close();
});
