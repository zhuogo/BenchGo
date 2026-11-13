import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAssistantDocuments, ASSISTANT_DOCUMENTS, isAssistantDocument } from '../src/documents.mjs';
import { createAssistantMemory, MEMORY_OUTLINE_LIMIT, cleanMemoryContext } from '../src/memory.mjs';
import { createRouterContext } from '../src/router-context.mjs';
import { profileDocuments } from '../src/profile-documents.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'assistant-structured-memory-'));
  const opened = [];
  const open = async () => {
    const documents = await createAssistantDocuments({ directory });
    const memory = await createAssistantMemory({ directory, documents });
    const store = { documents, memory, getContext: () => memory.context(), getConfig: async () => ({ name: '' }) };
    opened.push(store); return store;
  };
  t.after(async () => { for (const store of opened) { store.memory.close(); store.documents.close(); } await rm(directory, { recursive: true, force: true }); });
  return { directory, open, store: await open() };
}
const user = id => ({ role: 'user', sessionId: 'facts', messageId: id });

test('details use dated records and category views while the sourced outline stays bounded', async t => {
  const { store, open } = await fixture(t);
  const saved = [];
  for (let index = 0; index < 35; index++) saved.push(await store.memory.save({ content: `事实${index} ${'有价值的经验'.repeat(100)}`, source: user(`m${index}`), category: index % 2 ? 'experience' : 'world' }));
  assert.ok(saved.every(entry => /^memory\/\d{4}-\d{2}-\d{2}\.md$/u.test(entry.document)));
  const overview = await store.memory.curate({ ids: saved.map(entry => entry.id) });
  assert.ok(overview.content.length <= MEMORY_OUTLINE_LIMIT);
  assert.match(overview.content, /\[\[memory:/u);
  assert.match(overview.content, /来源：m0/u);
  assert.doesNotMatch(overview.content, /benchgo-memory /u);
  assert.ok((await store.memory.search({ category: 'experience', limit: 100 })).every(entry => entry.category === 'experience'));
  const reopened = await open();
  assert.equal((await reopened.memory.list()).length, saved.length);
  assert.deepEqual((await reopened.documents.list()).map(row => row.name), ASSISTANT_DOCUMENTS);
  assert.ok((await reopened.documents.list({ recursive: true })).some(row => row.name === saved[0].document));
  await assert.rejects(store.documents.update('MEMORY.md', { content: 'x'.repeat(6001), expectedHash: overview.hash }), /6000/u);
});

test('changed-file indexing preserves unaffected term rows and restarts keep IDs and versions', async t => {
  const { store, directory, open } = await fixture(t);
  const first = await store.memory.save({ content: '独立甲文件 searchable alpha', document: 'memory/2026-11-01.md', source: user('a') });
  const second = await store.memory.save({ content: '独立乙文件 searchable beta', document: 'memory/2026-11-02.md', source: user('b') });
  const db = new DatabaseSync(join(directory, 'assistant.db'));
  let updated;
  try {
    const before = db.prepare('SELECT rowid,term FROM memory_terms WHERE entry_id=? ORDER BY term').all(second.id);
    updated = await store.memory.save({ id: first.id, content: '修订后的独立甲文件 gamma', source: user('a2'), category: 'opinions' }, { revision: first.revision });
    assert.deepEqual(db.prepare('SELECT rowid,term FROM memory_terms WHERE entry_id=? ORDER BY term').all(second.id), before);
  } finally { db.close(); }
  const reopened = await open(), entry = (await reopened.memory.list()).find(entry => entry.id === first.id);
  assert.equal(entry.revision, 2);
  assert.equal(entry.category, 'opinions');
  assert.equal(entry.versionChain[0].revision, 1);
  assert.equal(entry.id, updated.id);
  assert.ok((await reopened.documents.versions(first.document)).some(row => row.content.includes(first.content)));
});

test('corrections invalidate relationship, dream and alignment views including historical and frozen copies', async t => {
  const { store } = await fixture(t);
  const first = await store.memory.save({ content: '联系人住在旧城市', source: user('old-city') });
  await store.memory.curate({ ids: [first.id] });
  const targets = ['memory/people/INDEX.md', 'memory/people/person_1.md', 'memory/groups/INDEX.md', 'dreams/2026-11-13.md', 'dreams/alignment/ALIGNMENT_SYNTHESIS.md'];
  for (const document of targets) await store.memory.writeDerived({ document, content: '由旧城市推导的关系与复盘', memoryIds: [first.id], source: { kind: 'derived', references: [user('old-city')] } });
  await store.documents.freezeSessionContext('derived-context', await store.memory.context());
  const events = [];
  store.memory.onChange(event => events.push(event));
  await store.memory.save({ id: first.id, content: '联系人住在新城市', source: user('new-city') }, { revision: first.revision });
  for (const document of targets) {
    assert.equal((await store.documents.read(document)).content, '');
    assert.ok((await store.documents.versions(document)).every(version => version.content === ''));
  }
  const frozen = await store.documents.sessionContext('derived-context');
  assert.doesNotMatch(JSON.stringify(frozen.documents.filter(row => targets.includes(row.name))), /旧城市/u);
  const outline = (await store.documents.read('MEMORY.md')).content;
  assert.match(outline, /新城市/u); assert.doesNotMatch(outline, /旧城市/u);
  assert.equal(events[0].kind, 'corrected');
  assert.deepEqual(events[0].memoryIds, [first.id]);
  await assert.rejects(store.memory.writeDerived({ document: 'dreams/2026-11-13.md', content: '改写旧证据', memoryIds: [], source: { references: [user('old-city')] } }), { code: 'MEMORY_EXCLUDED' });
});

test('forget clears dated histories, derived documents, outline and snapshots and rejects copied-back details', async t => {
  const { store, directory, open } = await fixture(t);
  const secret = '应被忘记的精确私人内容';
  const entry = await store.memory.save({ content: secret, source: user('private') });
  const original = (await store.documents.read(entry.document)).content;
  await store.memory.curate({ ids: [entry.id] });
  await store.memory.writeDerived({ document: 'memory/people/INDEX.md', content: '私密关系概述', memoryIds: [entry.id], source: { references: [user('private')] } });
  const frozen = cleanMemoryContext(await store.memory.context());
  await store.documents.freezeSessionContext('private-context', frozen);
  await store.memory.forget(entry.id);
  assert.doesNotMatch(JSON.stringify(await store.documents.list({ recursive: true })), /精确私人内容|私密关系概述/u);
  assert.doesNotMatch(JSON.stringify(await store.documents.versions(entry.document)), /精确私人内容/u);
  assert.doesNotMatch(JSON.stringify(await store.documents.sessionContext('private-context')), /精确私人内容|私密关系概述/u);
  await writeFile(join(directory, entry.document), original);
  const reopened = await open();
  assert.deepEqual(await reopened.memory.list(), []);
  assert.doesNotMatch((await reopened.documents.read(entry.document)).content, /精确私人内容/u);
  assert.doesNotMatch(JSON.stringify(await reopened.documents.versions(entry.document)), /精确私人内容/u);
  assert.equal((await reopened.memory.propose({ content: '换句话重现', source: user('private') }, { verifiedSource: user('private') })).status, 'excluded');
});

test('controlled document paths distinguish fixed and recursive views and refuse traversal and junctions', async t => {
  const { store, directory } = await fixture(t);
  for (const name of ['../USER.md', 'memory/../USER.md', 'memory\\people\\a.md', 'memory/people/a/b.md', 'memory/people/CON.md', 'memory/2026-02-31.md', 'dreams/alignment/other.md', 'memory/entries/a.md']) {
    assert.equal(isAssistantDocument(name), false, name);
    await assert.rejects(store.documents.write(name, { content: 'bad' }), /未知|不安全/u);
  }
  await store.documents.write('memory/groups/project-one.md', { content: '一个安全视图' });
  assert.ok(!(await store.documents.list()).some(row => row.name.includes('/')));
  const catalog = await profileDocuments(store, { op: 'list', recursive: true }, { kind: 'conversation' });
  assert.ok(catalog.documents.some(row => row.name === 'memory/groups/project-one.md'));
  assert.ok(catalog.documents.every(row => row.content === undefined));
  const fixed = await profileDocuments(store, { op: 'list' }, { kind: 'conversation' });
  assert.deepEqual(fixed.documents.map(row => row.name), ASSISTANT_DOCUMENTS);
  const outside = await mkdtemp(join(tmpdir(), 'assistant-path-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await mkdir(join(directory, 'memory'), { recursive: true });
  try { await symlink(outside, join(directory, 'memory', 'people'), 'junction'); }
  catch (error) { if (error.code === 'EPERM') return; throw error; }
  await assert.rejects(store.documents.write('memory/people/person.md', { content: 'unsafe' }), /符号链接/u);
  await assert.rejects(store.documents.list({ recursive: true }), /符号链接/u);
});

test('Router injects bounded current profiles, outline, alignment and relation indexes without repeated detail sources', async t => {
  const { store } = await fixture(t);
  const entry = await store.memory.save({ content: 'composer项目使用轻量流程', source: user('router') });
  await store.memory.curate({ ids: [entry.id] });
  for (const document of ['memory/people/INDEX.md', 'memory/groups/INDEX.md', 'dreams/alignment/ALIGNMENT_SYNTHESIS.md']) await store.memory.writeDerived({ document, content: '简短关系和对齐', memoryIds: [entry.id], source: { references: [user('router')] } });
  const build = createRouterContext({ store, sessionId: 'same-router' });
  const first = JSON.parse(await build({ incoming: 'composer', messages: [] }));
  assert.deepEqual(first.documents.slice(0, 5).map(row => row.name), ['SOUL.md', 'IDENTITY.md', 'USER.md', 'AGENTS.md', 'MEMORY.md']);
  assert.ok(first.documents.some(row => row.name.endsWith('ALIGNMENT_SYNTHESIS.md')));
  assert.equal(first.memories.length, 0);
  const soul = await store.documents.read('SOUL.md');
  await store.documents.update('SOUL.md', { content: '本回合更新的风格', expectedHash: soul.hash });
  const next = JSON.parse(await build({ incoming: 'composer', messages: [] }));
  assert.equal(next.documents[0].content, '本回合更新的风格');
  for (const name of ['SOUL.md', 'IDENTITY.md', 'USER.md', 'AGENTS.md']) {
    const document = await store.documents.read(name);
    await store.documents.update(name, { content: '长'.repeat(20000), expectedHash: document.hash });
  }
  const bounded = JSON.parse(await build({ incoming: 'composer', messages: [] }));
  assert.ok(bounded.documents.reduce((total, row) => total + row.content.length, 0) <= 12000);
  assert.ok(bounded.documents.slice(0, 4).every(row => row.truncated));
});

test('imported derived metadata rebuilds evidence receipts and forget clears imported views and their histories', async t => {
  const { store: source } = await fixture(t), { store: target, open } = await fixture(t);
  const entry = await source.memory.save({ content: '导入包中的个人事实', source: user('profile-private') });
  const targets = ['memory/people/INDEX.md', 'memory/groups/project.md', 'dreams/alignment/ALIGNMENT_SYNTHESIS.md'];
  for (const document of targets) await source.memory.writeDerived({ document, content: '由导入事实派生的关系与对齐', memoryIds: [entry.id], source: { references: [user('profile-private')] } });
  await source.memory.writeDerived({ document: 'dreams/2026-11-13.md', content: '只绑定原始来源的复盘', memoryIds: [], source: { references: [user('profile-private')] } });
  // Profile v2 imports authoritative files; derived SQLite receipts are intentionally not exported.
  for (const row of await source.documents.list({ recursive: true })) await target.documents.write(row.name, { content: row.content, source: { type: 'profile-import' } });
  const copiedAlignment = (await target.documents.read(targets[2])).content;
  const context = await target.memory.context();
  assert.match(context.documents.find(row => row.name === targets[2]).content, /导入事实派生/u);
  await target.documents.freezeSessionContext('imported-derived', context);
  await target.memory.forget(entry.id);
  for (const document of [...targets, 'dreams/2026-11-13.md']) {
    assert.equal((await target.documents.read(document)).content, '');
    assert.ok((await target.documents.versions(document)).every(row => row.content === ''));
  }
  assert.doesNotMatch(JSON.stringify(await target.documents.sessionContext('imported-derived')), /导入事实派生/u);
  await target.documents.write(targets[2], { content: copiedAlignment, source: { type: 'profile-import' } });
  const restarted = await open();
  assert.equal((await restarted.memory.readDocument(targets[2])).content, '');
  assert.equal((await restarted.documents.read(targets[2])).content, '');
});

test('unbound handwritten derived pages never enter live or frozen contexts and valid bindings can be added later', async t => {
  const { store } = await fixture(t);
  const alignment = 'dreams/alignment/ALIGNMENT_SYNTHESIS.md';
  await store.documents.write(alignment, { content: '没有来源绑定的人工总结' });
  const raw = await store.documents.context();
  assert.equal((await store.memory.readDocument(alignment)).content, '');
  assert.equal((await store.memory.context()).documents.find(row => row.name === alignment).content, '');
  assert.equal(store.memory.redactForgottenContext(raw).documents.find(row => row.name === alignment).content, '');
  assert.equal((await store.documents.read(alignment)).content, '没有来源绑定的人工总结');
  const entry = await store.memory.save({ content: '当前可用的来源事实', source: user('valid-binding') });
  await store.memory.writeDerived({ document: alignment, content: '已经绑定来源的总结', memoryIds: [entry.id], source: { references: [user('valid-binding')] } });
  assert.match((await store.memory.readDocument(alignment)).content, /已经绑定来源/u);
  const row = await store.documents.read(alignment);
  await store.documents.update(alignment, { content: '移除来源后的内容', expectedHash: row.hash });
  assert.equal((await store.memory.readDocument(alignment)).content, '');
  assert.equal((await store.documents.read(alignment)).content, '');
});

test('direct day-file corrections emit old evidence once across restart and invalidate source-only derived views', async t => {
  const { store, directory, open } = await fixture(t);
  const entry = await store.memory.save({ content: '直接编辑之前的旧结论', source: user('external-old') });
  await store.memory.writeDerived({ document: 'dreams/alignment/ALIGNMENT_SYNTHESIS.md', content: '从旧原话得到的对齐', memoryIds: [], source: { references: [user('external-old')] } });
  const row = await store.documents.read(entry.document);
  // Keep annotations unchanged, as a normal Markdown editor would.
  await writeFile(join(directory, entry.document), row.content.replace(entry.content, '直接编辑之后的新结论'));
  const restarted = await open(), events = [];
  restarted.memory.onChange(event => events.push(event));
  assert.match((await restarted.memory.list())[0].content, /新结论/u);
  assert.deepEqual(events, [{ kind: 'corrected', memoryIds: [entry.id], references: [user('external-old')] }]);
  assert.equal((await restarted.documents.read('dreams/alignment/ALIGNMENT_SYNTHESIS.md')).content, '');
  assert.equal((await restarted.memory.propose({ content: '换一种措辞恢复旧证据', source: user('external-old') }, { verifiedSource: user('external-old') })).status, 'excluded');
  await restarted.memory.list();
  assert.equal(events.length, 1);
  await restarted.memory.save({ id: entry.id, content: '通过正式API再次纠正', source: user('external-new') });
  assert.equal(events.length, 2);
  assert.equal(events[1].kind, 'corrected');
  assert.deepEqual(events[1].memoryIds, [entry.id]);
  await writeFile(join(directory, entry.document), '');
  assert.deepEqual(await restarted.memory.list(), []);
  assert.equal(events.length, 3);
  assert.deepEqual(events[2].references, [user('external-new')]);
});
