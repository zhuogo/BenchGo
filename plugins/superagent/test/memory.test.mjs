import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { createAssistantStore } from '../src/store.mjs';
import { ASSISTANT_DOCUMENTS, ASSISTANT_CONTEXT_DOCUMENTS, documentHash } from '../src/documents.mjs';
import { cleanMemoryContext, createAssistantMemory } from '../src/memory.mjs';

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

async function fixture(t, prepare) {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'assistant-memory-'));
  const stores = [];
  const open = async () => { const store = await createAssistantStore({ dataDirectory }); stores.push(store); return store; };
  t.after(async () => { stores.forEach(store => store.close()); await rm(dataDirectory, { recursive: true, force: true }); });
  await prepare?.(join(dataDirectory, 'assistant'));
  return { dataDirectory, open, store: await open() };
}

test('six Chinese documents keep existing configuration and legacy sources through an idempotent migration', async t => {
  const legacy = { id: 'legacy-1', content: '项目使用中文检索', scope: 'project:benchgo', source: { sessionId: 's1', messageId: 'm1' }, revision: 4, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-02-01T00:00:00Z' };
  const { store, open } = await fixture(t, async directory => {
    await mkdir(join(directory, 'memory'), { recursive: true });
    await writeFile(join(directory, 'identity.md'), '已有身份与工作习惯');
    await writeFile(join(directory, 'user.md'), '已有用户资料');
    await writeFile(join(directory, 'memory', 'entries.json'), JSON.stringify({ schemaVersion: 1, revision: 7, entries: [legacy] }));
  });
  const documents = await store.documents.list();
  assert.deepEqual(documents.map(row => row.name), ASSISTANT_DOCUMENTS);
  assert.equal(documents.find(row => row.name === 'IDENTITY.md').content, '已有身份与工作习惯');
  assert.match(documents.find(row => row.name === 'AGENTS.md').content, /已交代/);
  const entries = await store.listMemories();
  assert.equal(entries.length, 1);
  for (const [key, value] of Object.entries(legacy)) assert.deepEqual(entries[0][key], value);
  assert.equal((await (await open()).listMemories()).length, 1);
  assert.equal(await readFile(join(store.paths.directory, 'migration-v1', 'identity.md'), 'utf8'), '已有身份与工作习惯');
  assert.match(await readFile(join(store.paths.directory, 'migration-v1', 'entries.json'), 'utf8'), /中文检索/);
  assert.doesNotMatch(await readFile(join(store.paths.memory, 'entries.json'), 'utf8'), /中文检索/);
  assert.equal((await store.memory.migration()).imported, 1);
  assert.ok((await readdir(store.paths.directory)).includes('IDENTITY.md'));
});

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
  const doc = await store.documents.read('MEMORY.md');
  await store.documents.update('MEMORY.md', { expectedHash: doc.hash, content: doc.content + '\n用户手工补充了跨平台路径约定\n' });
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
  assert.deepEqual(await store.memory.candidates(), []);
  await assert.rejects(store.memory.reject(saved.id), /已保存/);
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

function legacyCandidate(store, { id = randomUUID(), content = '已有的待确认记忆', status = 'pending', evidence = { role: 'user', sessionId: 's', messageId: id }, source = evidence || { type: 'review' } } = {}) {
  const candidate = { id, status, input: { content, source }, evidence, createdAt: new Date().toISOString() };
  const db = new DatabaseSync(store.paths.database);
  const key = documentHash(content.normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, ' ').trim());
  db.prepare('INSERT INTO memory_candidates VALUES (?,?,?,?,?)').run(id, key, status, JSON.stringify(candidate), candidate.createdAt);
  db.close();
  return candidate;
}

test('legacy pending and interrupted writes recover once while rejected and untrusted records stay inactive', async t => {
  const { store, open } = await fixture(t);
  const pending = legacyCandidate(store);
  const interrupted = legacyCandidate(store, { content: '已有的未完成写入', status: 'saving' });
  legacyCandidate(store, { content: '用户已经拒绝', status: 'rejected' });
  legacyCandidate(store, { content: '没有可信来源', evidence: null });
  const restarted = await open();
  const entries = await restarted.listMemories();
  assert.deepEqual(new Set(entries.map(row => row.candidateId)), new Set([pending.id, interrupted.id]));
  assert.ok(entries.every(row => !row.id.startsWith('candidate-')));
  assert.deepEqual(await restarted.memory.candidates(), []);
  assert.equal((await restarted.memory.accept(pending.id)).status, 'accepted');
  assert.equal((await (await open()).listMemories()).length, 2);
  await restarted.memory.forget(entries.find(row => row.candidateId === pending.id).id);
  assert.equal((await restarted.memory.propose(pending.input, { verifiedSource: pending.evidence })).status, 'excluded');
});

test('legacy resolution respects disabled learning and cannot revive rejected evidence', async t => {
  const { store, open } = await fixture(t);
  await store.memory.configureLearning({ enabled: false });
  const paused = legacyCandidate(store, { content: '停用学习时不能写入' });
  const rejected = legacyCandidate(store, { content: '用户拒绝的旧记录' });
  await store.memory.reject(rejected.id);
  const restarted = await open();
  assert.equal((await restarted.listMemories()).length, 0);
  assert.equal((await restarted.memory.accept(paused.id)).status, 'excluded');
  await restarted.memory.configureLearning({ enabled: true });
  assert.equal((await restarted.memory.propose(rejected.input, { verifiedSource: rejected.evidence })).status, 'excluded');
});

test('failed automatic persistence is reported and retries reuse the same durable identity', async t => {
  const { store, open } = await fixture(t);
  const evidence = { role: 'user', sessionId: 's', messageId: 'retry' };
  const input = { content: '故障后只保存一次的记忆', source: evidence };
  const mutate = store.documents.mutate;
  store.documents.mutate = async (...args) => { await mutate(...args); throw new Error('write receipt interrupted'); };
  await assert.rejects(store.memory.propose(input, { verifiedSource: evidence }), /write receipt interrupted/);
  const [retry] = await store.memory.candidates({ status: 'saving' });
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

test('invalid UTF-8 and damaged memory metadata are reported without recreating or overwriting files', async t => {
  const { store } = await fixture(t);
  const path = join(store.paths.directory, 'SOUL.md');
  const bytes = Buffer.from([0xff, 0xfe, 0x80]);
  await writeFile(path, bytes);
  await assert.rejects(store.documents.read('SOUL.md'), /encoded data/u);
  assert.deepEqual(await readFile(path), bytes);
  await writeFile(path, '恢复的风格');
  const body = '<!-- benchgo-memory {"id":"damaged"} -->\n不要丢失这段人工内容\n<!-- /benchgo-memory -->';
  await writeFile(join(store.paths.directory, 'MEMORY.md'), body);
  await assert.rejects(store.listMemories(), error => error.code === 'MEMORY_PARSE_ERROR');
  assert.equal(await readFile(join(store.paths.directory, 'MEMORY.md'), 'utf8'), body);
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

test('legacy candidate IDs migrate once, repair an interrupted receipt and remain editable and forgettable by alias', async t => {
  const { store, open } = await fixture(t);
  const candidate = legacyCandidate(store, { status: 'saving', content: '旧版学习得到的长期偏好' });
  const legacyId = `candidate-${candidate.id}`;
  const metadata = { id: legacyId, source: candidate.evidence, scope: 'personal', revision: 4, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z' };
  await store.documents.mutate('MEMORY.md', body => body + `\n<!-- benchgo-memory ${JSON.stringify(metadata)} -->\n${candidate.input.content}\n<!-- /benchgo-memory -->\n`);
  await store.listMemories(); // Seed the previous index, which must not treat ID migration as correction.
  await store.getSessionContext('pre-migration');
  const mutate = store.documents.mutate;
  let interrupted = false;
  const documents = { ...store.documents, async mutate(...args) {
    const result = await mutate(...args);
    if (!interrupted && args[2]?.source?.type === 'memory-id-migration') { interrupted = true; throw new Error('migration receipt interrupted'); }
    return result;
  } };
  await assert.rejects(createAssistantMemory({ directory: store.paths.directory, documents }), /migration receipt interrupted/);
  const restarted = await open(), [entry] = await restarted.listMemories();
  assert.notEqual(entry.id, legacyId);
  assert.doesNotMatch(entry.id, /candidate-/u);
  assert.deepEqual(entry.legacyIds, [legacyId]);
  assert.equal(entry.candidateId, candidate.id);
  assert.equal(entry.revision, metadata.revision);
  assert.equal(entry.updatedAt, metadata.updatedAt);
  assert.deepEqual(entry.source, candidate.evidence);
  assert.equal(entry.source.excerpt, undefined);
  const accepted = await restarted.memory.accept(candidate.id);
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.memoryId, entry.id);
  assert.deepEqual((await (await open()).listMemories()).map(row => row.id), [entry.id]);
  const db = new DatabaseSync(store.paths.database);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_tombstones').get().n, 0);
  db.close();
  const edited = await restarted.saveMemory({ id: legacyId, content: '修正后的偏好', source: { type: 'user-edit' } }, { revision: entry.revision });
  assert.equal(edited.id, entry.id);
  assert.equal(edited.supersedes.id, entry.id);
  await restarted.memory.forget(legacyId, { revision: edited.revision });
  assert.equal((await restarted.listMemories()).length, 0);
  assert.doesNotMatch(JSON.stringify(await restarted.getSessionContext('pre-migration')), /旧版学习得到的长期偏好/u);
  assert.deepEqual(await restarted.memory.candidates({ status: 'accepted' }), []);
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
  assert.ok((await store.documents.versions('MEMORY.md')).some(row => row.content.includes('第二次手工输入')));
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
  assert.match((await store.documents.read('MEMORY.md')).content, /benchgo-memory/u);
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
  assert.deepEqual(await store.memory.candidates({ status: 'accepted' }), []);
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

test('only exact broken templates are repaired and custom content survives reopen', async t => {
  const broken = '# 闀挎湡璁板繂\n\n璁板綍鏈夋潵婧愮殑闀挎湡浜嬪疄銆佸喅瀹氬拰缁忛獙锛涗笉淇濆瓨鍘熷鑱婂ぉ鎴栧綋鍓嶄换鍔＄姸鎬併€俓n';
  const { store, open } = await fixture(t, async directory => {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'MEMORY.md'), broken);
    await writeFile(join(directory, 'SOUL.md'), '用户自己的表达约定');
  });
  assert.equal((await store.listMemories()).length, 0);
  assert.match((await store.documents.read('MEMORY.md')).content, /长期记忆/);
  assert.equal((await store.documents.read('SOUL.md')).content, '用户自己的表达约定');
  const history = await store.documents.versions('MEMORY.md');
  assert.ok(history.some(row => row.content === broken));
  const reopened = await open();
  assert.equal((await reopened.documents.versions('MEMORY.md')).length, history.length);
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
