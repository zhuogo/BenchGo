import test from 'node:test';
import assert from 'node:assert/strict';
import { isLongTermMemoryWrite, assertRouterMemoryTool } from '../src/memory-tool-policy.mjs';

test('Worker and child retained handles cannot modify memory or enqueue alternate write paths', () => {
  const ownerAgent = {}, worker = {}, child = {};
  for (const [name, args] of [['assistant_memory', { content: '记住' }], ['assistant_memory', { id: 'm', remove: true }],
    ['assistant_profile', { op: 'update', name: 'USER.md' }], ['assistant_profile', { op: 'restore', name: 'MEMORY.md' }],
    ['assistant_review', { op: 'enqueue', kind: 'memory' }], ['assistant_review', { op: 'enqueue', kind: 'learning' }],
    ['assistant_review', { op: 'skill-feedback', id: 'skill' }], ['assistant_review', { op: 'dismiss-idea', id: 'idea' }],
    ['assistant_learn', {}], ['assistant_memory', '{invalid']]) {
    assert.equal(isLongTermMemoryWrite(name, args), true);
    for (const agent of [worker, child, undefined]) assert.throws(() => assertRouterMemoryTool({ name, args, agent, ownerAgent }), { code: 'WORKER_MEMORY_WRITE_DENIED' });
    assert.doesNotThrow(() => assertRouterMemoryTool({ name, args, agent: ownerAgent, ownerAgent }));
  }
});

test('read-only memory and profile operations remain usable', () => {
  for (const [name, args] of [['assistant_memory', {}], ['assistant_memory_search', { query: '偏好' }],
    ['assistant_profile', { op: 'read', name: 'MEMORY.md' }], ['assistant_profile', { op: 'versions' }],
    ['assistant_review', { op: 'list' }], ['assistant_review', { op: 'budget' }], ['assistant_review', { op: 'skills' }], ['assistant_review', { op: 'ideas' }]]) {
    assert.equal(isLongTermMemoryWrite(name, args), false);
    assert.doesNotThrow(() => assertRouterMemoryTool({ name, args, agent: {}, ownerAgent: {} }));
  }
});
