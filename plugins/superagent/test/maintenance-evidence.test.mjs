import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantStore } from '../src/store.mjs';
import { createMaintenanceProcessor } from '../src/maintenance-processors.mjs';

test('real storage preserves review evidence and forgetting invalidates both relationship views and ideas', async t => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'benchgo-maintenance-evidence-'));
  const store = await createAssistantStore({ dataDirectory });
  t.after(async () => { store.close(); await rm(dataDirectory, { recursive: true, force: true }); });
  await store.updateConfig({ models: [{ providerId: 'provider', modelId: 'Exact:Opaque' }] });
  const fact = await store.saveMemory({ content: '张敏是项目的设计负责人。', category: 'world', source: { role: 'user', sessionId: 'real-session', messageId: 'real-message' } });
  const ctx = { llm: { async *stream(request) {
    const material = JSON.parse(request.messages.at(-1).content[0].text), sourceId = material.find(row => row.kind === 'memory').id;
    const output = request.purpose.endsWith('relationships') ? { entities: [{ type: 'people', key: '张敏', name: '张敏', summary: '设计负责人，具体事实见来源。', sourceIds: [sourceId] }] }
      : { ideas: [{ title: '考虑整理设计交接', content: '可根据设计负责人的已知分工，询问是否需要准备交接清单。', sourceIds: [sourceId], expiresInDays: 7 }] };
    yield { type: 'text-delta', text: JSON.stringify(output) };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } } };
  const process = createMaintenanceProcessor({ ctx, store, readSources: async () => [] });
  const signal = new AbortController().signal;
  const relationship = await process({ id: 'relation-review', kind: 'maintenance', payload: { task: 'relationships' } }, { signal });
  const index = await store.memory.readDocument('memory/people/INDEX.md');
  assert.match(index.content, /张敏/);
  assert.match(index.content, new RegExp(fact.id));
  assert.equal(JSON.stringify(relationship).includes('张敏'), false, 'queue receipts contain identities and status only');
  await process({ id: 'idea-review', kind: 'maintenance', payload: { task: 'idea-curation' } }, { signal });
  assert.equal(store.ideas.list().length, 1);
  await store.memory.forget(fact.id, { revision: fact.revision });
  assert.equal((await store.memory.readDocument('memory/people/INDEX.md')).content, '');
  assert.equal(store.ideas.list().length, 0);
  assert.equal(store.ideas.list({ status: 'invalidated' })[0].content, '');
});

test('upkeep does not republish old context through a different live message after a concurrent correction', async t => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'benchgo-upkeep-correction-'));
  const store = await createAssistantStore({ dataDirectory });
  t.after(async () => { store.close(); await rm(dataDirectory, { recursive: true, force: true }); });
  await store.updateConfig({ models: [{ providerId: 'provider', modelId: 'Exact:Opaque' }] });
  const fact = await store.saveMemory({ content: '用户居住在北京。', source: { role: 'user', sessionId: 's', messageId: 'old' } });
  const ctx = { llm: { async *stream() {
    await store.saveMemory({ id: fact.id, content: '用户已搬到上海。', source: { role: 'user', sessionId: 's', messageId: 'correction' } }, { revision: fact.revision });
    yield { type: 'text-delta', text: JSON.stringify({ memories: [{ content: '用户居住在北京。', category: 'world', sourceMessageId: 'live-message' }] }) };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } } };
  const process = createMaintenanceProcessor({ ctx, store, readSources: async () => [{ id: 'live-message', text: '继续讨论城市。', source: { role: 'user', sessionId: 's', messageId: 'live' } }] });
  await assert.rejects(process({ id: 'upkeep-correction', kind: 'learning', payload: { task: 'memory-upkeep' } }, { signal: new AbortController().signal }), /来源已变更/);
  const entries = await store.listMemories();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].content, '用户已搬到上海。');
});

test('daily log retains both source dependencies and forgetting either clears the combined derived log', async t => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'benchgo-dream-dependencies-'));
  const store = await createAssistantStore({ dataDirectory });
  t.after(async () => { store.close(); await rm(dataDirectory, { recursive: true, force: true }); });
  await store.updateConfig({ models: [{ providerId: 'provider', modelId: 'Exact:Opaque' }] });
  const first = await store.saveMemory({ content: '用户要求结果失败时明确说明。', source: { role: 'user', messageId: 'feedback-first' } });
  let current = first, label = '第一次反思';
  const ctx = { llm: { async *stream() {
    yield { type: 'text-delta', text: JSON.stringify({ reflections: [{ content: label, sourceIds: [`memory:${current.id}`] }], alignment: [] }) };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } } };
  const process = createMaintenanceProcessor({ ctx, store, readSources: async () => [], now: () => new Date('2026-11-13T10:00:00Z') });
  await process({ id: 'dream-first', kind: 'maintenance', payload: { task: 'dreaming' } }, { signal: new AbortController().signal });
  current = await store.saveMemory({ content: '用户要求先给结论。', source: { role: 'user', messageId: 'feedback-second' } });
  label = '第二次反思';
  await process({ id: 'dream-second', kind: 'maintenance', payload: { task: 'dreaming' } }, { signal: new AbortController().signal });
  const daily = await store.memory.readDocument('dreams/2026-11-13.md');
  assert.match(daily.content, /第一次反思/);
  assert.match(daily.content, /第二次反思/);
  assert.match(daily.content, new RegExp(first.id));
  assert.match(daily.content, new RegExp(current.id));
  await store.memory.forget(first.id, { revision: first.revision });
  assert.equal((await store.memory.readDocument('dreams/2026-11-13.md')).content, '');
});
