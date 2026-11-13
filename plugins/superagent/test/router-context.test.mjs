import test from 'node:test';
import assert from 'node:assert/strict';
import { selectContextMemories } from '../src/memory.mjs';
import { createRouterContext } from '../src/router-context.mjs';

test('memory context excludes unrelated recency and bounds relevant bodies', () => {
  const entries = Array.from({ length: 100 }, (_, id) => ({ id: String(id), content: 'unrelated old task '.repeat(100), source: { excerpt: 'private raw source' } }));
  assert.deepEqual(selectContextMemories(entries, 'hello'), []);
  const relevant = Array.from({ length: 20 }, (_, id) => ({ id: String(id), content: `composer ${id} ` + 'detail '.repeat(1000), source: { messageId: String(id), excerpt: 'raw repeated text' } }));
  const result = selectContextMemories(relevant, 'composer');
  assert.ok(result.length <= 8);
  assert.ok(result.reduce((sum, row) => sum + row.content.length, 0) <= 8000);
  assert.ok(result.every(row => row.truncated && row.source.excerpt === undefined));
});

test('proactive suggestions require enabled capability, a real user turn and a related pending idea', async () => {
  let enabled = false, reads = 0, listed = 0;
  const idea = { id: 'idea-1', status: 'pending', title: '简化 composer 发布', content: '可以合并 composer 发布前的重复检查。', memoryIds: ['m1'], expiresAt: '2026-12-01T00:00:00Z' };
  const store = {
    getContext: async () => ({ documents: [], memories: [] }),
    getConfig: async () => ({ capabilities: { proactive: enabled } }),
    ideas: { list: options => { listed++; assert.deepEqual(options, { status: 'pending', limit: 20 }); return [idea]; } },
    memory: { readDocument: async name => { reads++; assert.equal(name, 'PROACTIVE_PREFERENCES.md'); return { name, content: '只在讨论相关主题时自然提出；不要重复打扰。' }; } },
  };
  const build = createRouterContext({ store, sessionId: 'router-proactive' });
  const user = [{ source: { kind: 'user' } }];
  let result = JSON.parse(await build({ incoming: 'composer 发布', messages: user }));
  assert.equal(result.ideaProposal, undefined); assert.equal(listed, 0); assert.equal(reads, 0);
  enabled = true;
  result = JSON.parse(await build({ incoming: 'hello', messages: user }));
  assert.equal(result.ideaProposal, undefined); assert.equal(result.proactivePreferences, undefined); assert.equal(reads, 0);
  result = JSON.parse(await build({ incoming: 'composer 发布', messages: [{ source: { kind: 'schedule' } }] }));
  assert.equal(result.ideaProposal, undefined); assert.equal(reads, 0);
  result = JSON.parse(await build({ incoming: 'composer 发布', messages: user }));
  assert.equal(result.ideaProposal.id, idea.id);
  assert.equal(result.ideaProposal.proposalOnly, true);
  assert.equal(result.ideaProposal.requiresUserInstruction, true);
  assert.match(result.proactivePreferences.content, /不要重复打扰/u);
  assert.deepEqual(result.memories, []);
  assert.equal(reads, 1);
});

test('proactive context exposes at most one proposal and bounds preference text', async () => {
  const store = {
    getContext: async () => ({ documents: [], memories: [] }),
    getConfig: async () => ({ capabilities: { proactive: true } }),
    ideas: { list: () => [
      { id: 'one', status: 'pending', title: 'composer流程', content: 'composer流程可简化', memoryIds: [] },
      { id: 'two', status: 'pending', title: 'composer检查', content: 'composer检查可改进', memoryIds: [] },
    ] },
    memory: { readDocument: async name => ({ name, content: '<!-- 不注入内部备注 -->' + '偏好'.repeat(1200) }) },
  };
  const build = createRouterContext({ store, sessionId: 'one-idea' });
  const result = JSON.parse(await build({ incoming: 'composer', messages: [{ source: { kind: 'user' } }] }));
  assert.equal(result.ideaProposal.id, 'one');
  assert.equal(Array.isArray(result.ideaProposal), false);
  assert.equal(result.proactivePreferences.content.length, 1500);
  assert.equal(result.proactivePreferences.truncated, true);
  assert.doesNotMatch(result.proactivePreferences.content, /内部备注/u);
});
