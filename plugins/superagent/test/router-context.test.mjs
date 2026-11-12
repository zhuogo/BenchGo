import test from 'node:test';
import assert from 'node:assert/strict';
import { selectContextMemories } from '../src/memory.mjs';

test('memory context excludes unrelated recency and bounds relevant bodies', () => {
  const entries = Array.from({ length: 100 }, (_, id) => ({ id: String(id), content: 'unrelated old task '.repeat(100), source: { excerpt: 'private raw source' } }));
  assert.deepEqual(selectContextMemories(entries, 'hello'), []);
  const relevant = Array.from({ length: 20 }, (_, id) => ({ id: String(id), content: `composer ${id} ` + 'detail '.repeat(1000), source: { messageId: String(id), excerpt: 'raw repeated text' } }));
  const result = selectContextMemories(relevant, 'composer');
  assert.ok(result.length <= 8);
  assert.ok(result.reduce((sum, row) => sum + row.content.length, 0) <= 8000);
  assert.ok(result.every(row => row.truncated && row.source.excerpt === undefined));
});
