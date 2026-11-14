import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createMaintenanceProcessor } from '../src/maintenance-processors.mjs';
import { MAINTENANCE_TASKS, maintenanceTaskPrompt } from '../src/maintenance-review.mjs';

const user = { id: 'message:1', text: '张敏是项目的设计负责人。我希望先给结论，工作失败要明确说明。', source: { role: 'user', sessionId: 's', messageId: 'm' } };
const memory = { id: 'known', content: '张敏是项目设计负责人。', source: { role: 'user', sessionId: 's', messageId: 'm0' }, category: 'world', revision: 1 };
function fixture(output, { observations = [user], memories = [memory], skills = [] } = {}) {
  const requests = [], writes = [], candidates = [], ideas = [], completed = [];
  let settings = { enabled: true, hash: 'policy:1', excludedTerms: ['秘密'], excludedScopes: [] }, revision = 1;
  const store = {
    getConfig: async () => ({ models: [{ providerId: 'router', modelId: 'Main:Opaque' }], auxiliary: { capabilities: ['review'], models: [{ providerId: 'aux', modelId: 'Aux:Opaque' }] } }),
    learning: { takeSources: async () => ({ batchId: 'batch:1', items: observations }), completeSources: id => { completed.push(id); return { nextSeq: 1 }; } },
    memory: { learning: async () => settings, list: async () => memories, contextRevision: () => revision,
      writeDerived: async input => { writes.push(input); revision++; return { document: input.document }; },
      readDocument: async name => { if (name.includes('alignment')) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return { content: '只在现有对话提出建议，不要外发。' }; },
      propose: async input => { candidates.push(input); return { status: 'accepted' }; } },
    ownedSkills: { reviewInputs: async () => skills, propose: async input => { candidates.push(input); return { id: 'skill-candidate', status: 'candidate' }; } },
    ideas: { list: () => [{ id: 'old', title: '已有建议', content: '不要重复' }], propose: input => { ideas.push(input); return { id: 'idea', status: 'pending' }; } },
  };
  const ctx = { llm: { async *stream(request) { requests.push(request); yield { type: 'text-delta', text: JSON.stringify(typeof output === 'function' ? output() : output) }; yield { type: 'finish', reason: { kind: 'stop' } }; } } };
  return { store, requests, writes, candidates, ideas, completed, process: createMaintenanceProcessor({ ctx, store, readSources: async () => [], now: () => new Date('2026-11-13T10:00:00Z') }),
    revoke() { settings = { ...settings, hash: 'policy:2', enabled: false }; }, changeSource() { revision++; } };
}
const run = (f, task, signal = new AbortController().signal) => f.process({ id: 'review:1', kind: task === 'memory-upkeep' ? 'learning' : 'maintenance', payload: { task } }, { signal });

test('all five task instructions ship as independent Markdown and forbid empty filler', () => {
  assert.equal(MAINTENANCE_TASKS.length, 5);
  for (const task of MAINTENANCE_TASKS) assert.match(maintenanceTaskPrompt(task), /empty|insufficient|\[\]/);
  assert.throws(() => maintenanceTaskPrompt('../invalid'), /未知/);
});

test('empty material across all five responsibilities never calls a model and completes source watermarks', async () => {
  for (const task of MAINTENANCE_TASKS) {
    const f = fixture(() => { throw new Error('must not infer'); }, { observations: [], memories: [] });
    assert.equal((await run(f, task)).modelUsed, false);
    assert.equal(f.requests.length, 0);
    assert.deepEqual(f.completed, ['batch:1']);
  }
});

test('relationship navigation uses safe host IDs, authoritative memory links and source bindings', async () => {
  const f = fixture({ entities: [{ type: 'people', key: '../../张敏', name: '张敏', summary: '设计负责人，具体事实见来源。', sourceIds: ['memory:known', 'message:1'] }] });
  const result = await run(f, 'relationships');
  assert.equal(result.task, 'relationships');
  assert.equal(f.requests[0].model, 'Aux:Opaque');
  assert.equal(f.requests[0].tools.length, 0);
  assert.equal(f.writes.length, 2);
  assert.match(f.writes[0].document, /^memory\/people\/entity-[a-f0-9]{24}\.md$/);
  assert.equal(f.writes[1].document, 'memory/people/INDEX.md');
  assert.match(f.writes[1].content, /设计负责人，具体事实见来源/);
  assert.match(f.writes[0].content, /\[\[memory:known\]\]/);
  assert.deepEqual(f.writes[0].memoryIds, ['known']);
  assert.equal(f.writes[0].source.role, 'assistant');
  assert.equal(f.writes[0].source.references[0].messageId, 'm0');
  assert.equal(f.candidates.length, 0);
  assert.deepEqual(f.completed, ['batch:1']);
});

test('all relationship citations validate before any derived write', async () => {
  const f = fixture({ entities: [{ type: 'people', key: 'one', name: '张敏', summary: '设计负责人', sourceIds: ['memory:known'] },
    { type: 'groups', key: 'unknown', name: '未知组织', summary: '无证据', sourceIds: ['forged'] }] });
  await assert.rejects(run(f, 'relationships'), /来源引用/);
  assert.equal(f.writes.length, 0);
  assert.equal(f.completed.length, 0);
});

test('dreaming keeps assistant reflection and bounded alignment out of user fact proposals', async () => {
  const f = fixture({ reflections: [{ content: '我应在结果不确定时明确说明，避免误报。', sourceIds: ['message:1'] }],
    alignment: [{ content: '先给结论，并说明实际完成与失败。', sourceIds: ['message:1'] }] });
  await run(f, 'dreaming');
  assert.deepEqual(f.writes.map(row => row.document), ['dreams/2026-11-13.md', 'dreams/alignment/ALIGNMENT_SYNTHESIS.md']);
  assert.equal(f.candidates.length, 0);
  assert.equal(f.writes[0].source.references[0].role, 'user');
  assert.match(f.writes[1].content, /source:m/);
});
test('relationship INDEX retains previously sourced visible objects when a new batch adds another person', async () => {
  const f = fixture({ entities: [{ type: 'people', key: '张敏', name: '张敏', summary: '设计负责人', sourceIds: ['memory:known'] }] });
  const previousId = `entity-${'a'.repeat(24)}`, previousName = `memory/people/${previousId}.md`;
  const previous = { name: previousName, content: `<!-- benchgo-derived ${JSON.stringify({ memoryIds: [{ id: 'previous-memory' }], source: { references: [{ role: 'user', messageId: 'previous-message' }] } })} -->\n# 李明\n\n见原始事实。\n` };
  f.store.documents = { list: async () => [previous] };
  const originalRead = f.store.memory.readDocument;
  f.store.memory.readDocument = async name => name === previousName ? previous : originalRead(name);
  await run(f, 'relationships');
  const index = f.writes.find(row => row.document.endsWith('INDEX.md'));
  assert.match(index.content, /李明/);
  assert.match(index.content, /见原始事实/);
  assert.match(index.content, /张敏/);
  assert.ok(index.memoryIds.includes('previous-memory'));
  assert.ok(index.source.references.some(row => row.messageId === 'previous-message'));
});

test('updates receive older current evidence for the same relationship and retain its original source links', async () => {
  const older = { ...memory, id: 'older', content: '张敏负责预算与设计评审。', source: { role: 'user', messageId: 'older-user-message' } };
  const recent = Array.from({ length: 30 }, (_, index) => ({ ...memory, id: `recent-${index}`, content: `无关事实${index}` }));
  const f = fixture(() => {
    const request = f.requests.at(-1), material = JSON.parse(request.messages.at(-1).content[0].text);
    assert.ok(material.some(row => row.id === 'memory:older' && row.text.includes('预算')));
    assert.match(request.messages[1].content[0].text, /原有预算评审导航/);
    return { entities: [{ type: 'people', key: '张敏', name: '张敏', summary: '设计负责人，负责预算与设计评审。', sourceIds: ['message:1'] }] };
  }, { memories: [older, ...recent] });
  const id = `entity-${createHash('sha256').update('people:张敏').digest('hex').slice(0, 24)}`, name = `memory/people/${id}.md`;
  const previous = { name, content: `<!-- benchgo-derived ${JSON.stringify({ memoryIds: [{ id: 'older' }], source: { entityKey: '张敏', references: [older.source] } })} -->\n# 张敏\n\n原有预算评审导航\n\n来源：[[memory:older]]\n` };
  f.store.documents = { list: async () => [previous] };
  f.store.memory.readDocument = async document => document === name ? previous : null;
  await run(f, 'relationships');
  assert.ok(f.writes[0].memoryIds.includes('older'));
  assert.equal(f.writes[0].source.entityKey, '张敏');
  assert.ok(f.writes[0].source.references.some(row => row.messageId === 'older-user-message'));
});

test('daily dreams append across responsibilities, deduplicate retries and retain only six sourced batches', async () => {
  let pass = 1, upkeep = false;
  const f = fixture(() => upkeep ? { memories: [{ content: '来自记忆维护的反思。', category: 'reflections', sourceMessageId: 'message:1' }] }
    : { reflections: [{ content: `第${pass}次反思。`, sourceIds: ['message:1'] }], alignment: [] }, { memories: [] });
  const documents = new Map();
  f.store.memory.readDocument = async name => documents.get(name) || null;
  f.store.memory.writeDerived = async input => {
    f.writes.push(input); f.changeSource();
    documents.set(input.document, { name: input.document, content: `<!-- benchgo-derived ${JSON.stringify({ memoryIds: input.memoryIds.map(id => ({ id })), source: input.source })} -->\n${input.content}` });
    return { document: input.document };
  };
  for (pass = 1; pass <= 7; pass++) await run(f, 'dreaming');
  const daily = 'dreams/2026-11-13.md';
  let content = documents.get(daily).content;
  assert.equal(content.includes('第1次反思'), false);
  assert.equal((content.match(/benchgo-dream-batch /gu) || []).length, 6);
  pass = 7;
  await run(f, 'dreaming');
  content = documents.get(daily).content;
  assert.equal((content.match(/第7次反思/gu) || []).length, 1);
  upkeep = true;
  await run(f, 'memory-upkeep');
  content = documents.get(daily).content;
  assert.match(content, /来自记忆维护的反思/);
  assert.match(content, /第7次反思/);
  assert.equal((content.match(/benchgo-dream-batch /gu) || []).length, 6);
  assert.ok(f.writes.at(-1).content.length <= 12000);
  assert.equal(f.writes.at(-1).source.references[0].messageId, 'm');
});
test('real assistant feedback is reflection evidence only, never a user fact source', async () => {
  const feedback = { id: 'feedback:1', kind: 'feedback', text: '连接未成功，刚才的完成说法不准确。', source: { role: 'assistant', sessionId: 's', messageId: 'assistant-result' } };
  const dreaming = fixture({ reflections: [{ content: '我应先确认真实连接结果再报告完成。', sourceIds: ['feedback:1'] }], alignment: [] }, { observations: [feedback], memories: [] });
  await run(dreaming, 'dreaming');
  assert.equal(dreaming.writes[0].source.references[0].role, 'assistant');
  assert.equal(dreaming.candidates.length, 0);
  const memoryReview = fixture({ memories: [] }, { observations: [feedback], memories: [] });
  await run(memoryReview, 'memory-upkeep');
  assert.equal(memoryReview.requests.length, 0);
});

test('real user observations produce classified facts while assistant reflections remain derived', async () => {
  const f = fixture({ memories: [{ content: '用户希望先给结论。', category: 'opinions', sourceMessageId: 'message:1' },
    { content: '我应核对完成证据，避免误报。', category: 'reflections', sourceMessageId: 'message:1' }] }, { memories: [] });
  await run(f, 'memory-upkeep');
  assert.equal(f.candidates.length, 1);
  assert.equal(f.candidates[0].category, 'opinions');
  assert.equal(f.candidates[0].source.messageId, 'm');
  assert.equal(f.writes[0].document, 'dreams/2026-11-13.md');
  assert.equal(f.writes[0].source.role, 'assistant');
});

test('unchanged fact/feedback fingerprints suppress repeated model calls after batch exhaustion', async () => {
  for (const task of MAINTENANCE_TASKS) {
    const output = task === 'memory-upkeep' ? { memories: [] } : task === 'relationships' ? { entities: [] }
      : task === 'dreaming' ? { reflections: [], alignment: [] } : task === 'skill-review' ? { skills: [] } : { ideas: [] };
    const f = fixture(output, { skills: task === 'skill-review' ? [skill] : [] }), fingerprints = new Map();
    f.store.learning.getTaskFingerprint = task => fingerprints.get(task);
    f.store.learning.setTaskFingerprint = (task, fingerprint) => fingerprints.set(task, fingerprint);
    await run(f, task);
    f.store.learning.takeSources = async () => ({ batchId: 'batch:2', items: [] });
    assert.equal((await run(f, task)).modelUsed, false);
    assert.equal(f.requests.length, 1, task);
    assert.deepEqual(f.completed, ['batch:1', 'batch:2']);
  }
});

test('policy or source revocation during inference prevents writes and watermark advancement', async () => {
  for (const change of ['revoke', 'changeSource']) {
    const f = fixture(() => { f[change](); return { entities: [{ type: 'people', key: 'one', name: '张敏', summary: '设计负责人', sourceIds: ['memory:known'] }] }; });
    await assert.rejects(run(f, 'relationships'), /已变更/);
    assert.equal(f.writes.length, 0);
    assert.equal(f.completed.length, 0);
  }
});

test('memory upkeep rejects context changes during inference before any fact or reflection write', async () => {
  const f = fixture(() => { f.changeSource(); return { memories: [{ content: '旧上下文结论', category: 'world', sourceMessageId: 'message:1' }] }; });
  await assert.rejects(run(f, 'memory-upkeep'), /来源已变更/);
  assert.equal(f.candidates.length + f.writes.length, 0);
  assert.equal(f.completed.length, 0);
});

test('excluded, assistant and reflection material is filtered before inference', async () => {
  const f = fixture({ entities: [] }, { observations: [{ ...user, text: '秘密' }, { ...user, id: 'assistant', source: { role: 'assistant', messageId: 'fake' } }],
    memories: [{ ...memory, content: '秘密' }, { ...memory, id: 'reflection', category: 'reflections' }] });
  await run(f, 'relationships');
  assert.equal(f.requests.length, 0);
});

const skill = { id: 'skill', name: 'bounded-review', revision: 3, content: '# Existing rules', description: '有限审查',
  feedback: [{ eventId: 'use:1', text: '这次方法成功完成核验。', outcome: 'success', source: { taskId: 'task', messageId: 'result' } }] };
const improvement = { skillId: 'skill', skillRevision: 3, name: 'bounded-review', description: '只审查有证据的材料', whenToUse: '有真实来源需要审查时。',
  procedure: '先检查来源再核验结果，以避免误报。', pitfalls: '未知结果不能当成功经验。', verification: '检查来源和实际输出。', sourceIds: ['skill:skill:3:use:1'] };
test('skill review creates a same-version owned candidate only from actual successful use feedback', async () => {
  const f = fixture({ skills: [improvement] }, { skills: [skill] });
  await run(f, 'skill-review');
  assert.equal(f.candidates.length, 1);
  assert.equal(f.candidates[0].source.skillId, 'skill');
  assert.equal(f.candidates[0].source.skillRevision, 3);
  assert.equal(f.candidates[0].name, skill.name);
  assert.match(f.candidates[0].content, /## Verification/);
  assert.equal(f.writes.length, 0);
  assert.equal(JSON.stringify(f.requests).includes('张敏'), false);
});
test('failure, unknown, fixed or idle skills cannot be converted into success candidates', async () => {
  for (const outcome of ['failure', 'unknown']) {
    const f = fixture({ skills: [improvement] }, { skills: [{ ...skill, feedback: [{ ...skill.feedback[0], outcome }] }] });
    await assert.rejects(run(f, 'skill-review'), /成功反馈/);
    assert.equal(f.candidates.length, 0);
  }
  for (const value of [{ ...skill, feedback: [] }, { ...skill, pinned: true }]) {
    const f = fixture({ skills: [improvement] }, { skills: [value] });
    await run(f, 'skill-review');
    assert.equal(f.requests.length, 0);
  }
});

test('ideas use explicit proactive preferences and remain expiring source-bound suggestions', async () => {
  const f = fixture({ ideas: [{ title: '核对设计交接', content: '根据张敏负责设计的明确资料，可询问是否需要整理交接清单。', sourceIds: ['memory:known'], expiresInDays: 7 }] });
  await run(f, 'idea-curation');
  assert.equal(f.ideas.length, 1);
  assert.equal(f.ideas[0].expiresAt, '2026-11-20T10:00:00.000Z');
  assert.deepEqual(f.ideas[0].memoryIds, ['known']);
  assert.match(JSON.stringify(f.requests), /不要外发/);
  assert.match(JSON.stringify(f.requests), /已有建议/);
  assert.equal(f.candidates.length + f.writes.length, 0);
});

test('abort during source read never commits an empty reserved batch', async () => {
  const f = fixture({ entities: [] }, { observations: [], memories: [] }), controller = new AbortController();
  f.store.learning.takeSources = async () => { controller.abort(); return { batchId: 'batch:1', items: [] }; };
  await assert.rejects(run(f, 'relationships', controller.signal), { name: 'AbortError' });
  assert.equal(f.completed.length, 0);
});
