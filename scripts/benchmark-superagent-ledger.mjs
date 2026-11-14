import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createAssistantLedger } from '../plugins/superagent/src/ledger.mjs';

// Real SQLite/FTS benchmark; timings are evidence, not machine-dependent assertions.
const count = Number(process.argv[2] || 10000);
if (!Number.isSafeInteger(count) || count < 100 || count > 100000) throw new Error('记录数须在 100 至 100000 之间');
const directory = await mkdtemp(join(tmpdir(), 'benchgo-ledger-benchmark-'));
let ledger;
try {
  ledger = createAssistantLedger({ directory });
  const begin = performance.now();
  for (let i = 0; i < count; i++) ledger.append({ id: `entry-${i}`, sourceKey: `bench:${i}`, kind: 'trigger', content: `飞书连接原始消息 ${i}，需要保存原文与任务关系。` }, i ? [{ id: `entry-${i - 1}`, relation: 'source' }] : []);
  const insertMs = performance.now() - begin;
  const samples = [];
  for (let i = 0; i < 100; i++) {
    const start = performance.now();
    assert.equal(ledger.search('飞书连接', { limit: 20 }).length, 20);
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  assert.equal(ledger.related(`entry-${Math.floor(count / 2)}`).length, 2);
  const original = '中文😀原文'.repeat(10000);
  ledger.append({ id: 'long', sourceKey: 'bench:long', kind: 'trigger', content: original });
  let cursor = 0, restored = '', pages = 0;
  const pageStart = performance.now();
  do {
    const page = ledger.read('long', { cursor, limit: 1024 });
    restored += page.content; cursor = page.nextCursor; pages++;
  } while (cursor !== null);
  assert.equal(restored, original);
  const pageMs = performance.now() - pageStart;
  ledger.close(); ledger = createAssistantLedger({ directory });
  assert.equal(ledger.read(`entry-${count - 1}`).id, `entry-${count - 1}`);
  console.log(JSON.stringify({ records: count + 1, links: count - 1, insertMs, searches: samples.length, searchP50Ms: samples[50], searchP95Ms: samples[95], pages, pageMs, restartRead: true }, null, 2));
} finally {
  ledger?.close();
  await rm(directory, { recursive: true, force: true });
}
