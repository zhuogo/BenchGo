import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { Context } from '@deepseek-ai/cordis';
import * as plugin from '../src/plugin.mjs';
import { UsageLedger, normalizeUsage, mountUsage } from '../src/usage.mjs';

test('actual Cordis keeps the usage route mounted after the injection callback settles', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'commander-usage-cordis-'));
  const ctx = new Context(), routes = new Map();
  ctx.provide('tools', { register() {} });
  ctx.provide('connection', { fetch: { register(route) { routes.set(route.path, route); return () => { routes.delete(route.path); }; } } });
  try {
    await ctx.plugin(plugin, { dataDir: dir, usage: { enabled: false } });
    for (let attempt = 0; !routes.has('/api/commander/usage') && attempt < 20; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(routes.has('/api/commander/usage'), true);
    const response = await routes.get('/api/commander/usage').fetch(new Request('http://app.test/api/commander/usage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ start: '2026-10-01', end: '2026-10-17' }) }));
    assert.equal(response.status, 200);
    await ctx.fiber.dispose(); assert.equal(routes.size, 0);
  } finally { await ctx.fiber.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test('queries return live usage before slow history and share one background backfill', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'commander-usage-lazy-'));
  const commander = new EventEmitter(); commander.store = { directory: dir }; commander.sessions = new Map();
  const effects = [], hooks = {}, routes = [];
  let listed = 0, scans = 0, release;
  const pendingHistory = new Promise(resolve => { release = resolve; });
  const event = { seq: 1, type: 'assistant/message', time: Date.parse('2026-11-10'), data: { turn: 1, usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 }, message: { source: { provider: 'test', model: 'opaque' } } } };
  const ctx = { effect(fn) { const dispose = fn(); if (dispose) effects.push(dispose); }, on(name, fn) { hooks[name] = fn; },
    inject(_keys, fn) { fn({ sessionQuery: { async listSessions() { listed++; return [{ header: { id: 'old' } }]; }, async readSession() { await pendingHistory; return { events: [event] }; } } }); },
    connection: { fetch: { register(route) { routes.push(route); return () => {}; } } } };
  try {
    const ledger = await mountUsage(ctx, commander, { enabled: false });
    assert.equal(listed, 0); assert.equal(ledger.importer.coverage.state, 'idle');
    ledger.importer.scan = async () => { scans++; };
    hooks['session/event']({ id: 'live' }, event);
    assert.equal(ledger.rows.get('harness:live:1').totalTokens, 12);
    const query = () => routes[0].fetch(new Request('http://app.test/api/commander/usage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ start: '2026-11-10', end: '2026-11-11' }) }));
    const results = await Promise.all([query(), query()]);
    for (const response of results) {
      const data = await response.json();
      assert.equal(data.summary.totalTokens, 12);
      assert.equal(data.coverage.historyState, 'scanning');
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(listed, 1); assert.equal(scans, 1);
    hooks['session/event']({ id: 'during-history' }, event);
    release();
    let settled;
    for (let attempt = 0; attempt < 100; attempt++) {
      settled = await (await query()).json();
      if (settled.coverage.historyState === 'complete') break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(settled.summary.totalTokens, 36);
    assert.equal(settled.coverage.historyState, 'complete');
    assert.equal(listed, 1); assert.equal(scans, 1);
    for (const dispose of effects.reverse()) await dispose();
    const stored = await new UsageLedger(dir).open(); assert.equal(stored.rows.size, 3);
  } finally { release(); await rm(dir, { recursive: true, force: true }); }
});

test('flush coalesces a burst into one snapshot and persists changes received during an active write', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'commander-usage-coalesced-'));
  try {
    const ledger = await new UsageLedger(dir).open();
    let serializations = 0;
    ledger.rows.set('marker', { id: 'marker', toJSON() { serializations++; return { id: 'marker' }; } });
    const writes = [];
    for (let index = 0; index < 50; index++) {
      ledger.put({ id: 'row-' + index, time: '2026-11-10T00:00:00Z', totalTokens: index });
      writes.push(ledger.flush());
    }
    assert(writes.every(task => task === writes[0]));
    await Promise.resolve();
    ledger.put({ id: 'during-write', time: '2026-11-10T00:00:00Z', totalTokens: 99 });
    assert.equal(ledger.flush(), writes[0]);
    await Promise.all(writes);
    assert.equal(serializations, 2);
    const saved = JSON.parse(await readFile(ledger.path, 'utf8'));
    assert.equal(saved.rows.length, 52); assert.equal(saved.rows.at(-1).totalTokens, 99);
    assert.equal(ledger.dirty, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('native usage conventions preserve exact counts and unknown buckets', () => {
  assert.deepEqual(normalizeUsage({ inputTokens: 100, cached_input_tokens: 60, outputTokens: 20, totalTokens: 120 }, 'inclusive'), { inputTokens: 40, outputTokens: 20, cacheReadTokens: 60, cacheWriteTokens: null, totalTokens: 120, contextTokens: 100, contextWindow: null, reasoningTokens: null });
  const unknown = normalizeUsage({ input_tokens: 100, output_tokens: 20 });
  assert.equal(unknown.totalTokens, null); assert.equal(unknown.cacheReadTokens, null); assert.equal(unknown.contextWindow, null);
  assert.equal(normalizeUsage({ input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 }).totalTokens, 180);
});

test('collection imports own official history once, excludes routed duplicate and blocks cross-site reads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'commander-usage-route-'));
  const commander = new EventEmitter(); commander.store = { directory: dir }; commander.sessions = new Map();
  const effects = [], hooks = {}, routes = []; const usage = { inputTokens: 10, outputTokens: 2, totalTokens: 12 };
  const ctx = { effect(fn) { const dispose = fn(); if (dispose) effects.push(dispose); }, on(name, fn) { hooks[name] = fn; }, inject(_keys, fn) { fn({ sessionQuery: { listSessions: async () => [{ header: { id: 'history' } }], readSession: async () => ({ inheritedEventCount: 1, events: [
    { seq: 0, type: 'assistant/message', time: Date.parse('2026-10-16'), data: { turn: 0, usage, message: { source: { provider: 'deepseek', model: 'test' } } } },
    { seq: 1, type: 'assistant/message', time: Date.parse('2026-10-16'), data: { turn: 1, usage, message: { source: { provider: 'deepseek', model: 'test' } } } },
    { seq: 2, type: 'assistant/message', time: Date.parse('2026-10-16'), data: { turn: 2, usage, message: { source: { provider: 'commander-codex', model: 'test' } } } },
  ] }) } }); }, connection: { fetch: { register(route) { routes.push(route); return () => {}; } } } };
  try {
    const ledger = await mountUsage(ctx, commander, { enabled: false }); const route = routes[0];
    commander.sessions.set('native', { id: 'native', provider: 'codex', model: 'model', status: 'idle', events: [] });
    const emit = (type, time, data) => commander.emit('event', { sessionId: 'native', turnId: 'one', type, time: new Date(Date.parse('2026-10-16') + time).toISOString(), data });
    emit('turn.started', 0, {}); emit('usage', 500, { id: 'one', scope: 'request', usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } });
    emit('text.delta', 1000, { text: 'a' }); emit('usage', 2000, { id: 'two', scope: 'request', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } }); emit('turn.completed', 4000, { status: 'completed' });
    const nativeRows = [...ledger.rows.values()].filter(row => row.sessionId === 'native');
    assert.equal(nativeRows.filter(row => row.durationMs !== null).length, 0);
    const query = headers => new Request('http://app.test/api/commander/usage', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ start: '2026-10-16', end: '2026-10-17' }) });
    const response = await route.fetch(query()); assert.equal(response.status, 200);
    let data = await response.json();
    for (let attempt = 0; data.coverage.historyState === 'scanning' && attempt < 100; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 5)); data = await (await route.fetch(query())).json();
    }
    assert.equal(data.recordCount, 3); assert.equal(data.summary.totalTokens, 242); assert.equal(data.summary.tokensPerSecond, null);
    hooks['session/event']({ id: 'history', inheritedEventCount: 1 }, { seq: 1, type: 'assistant/message', time: Date.parse('2026-10-16'), data: { turn: 1, usage, message: { source: { provider: 'deepseek', model: 'test' } } } });
    assert.equal(ledger.rows.size, 3);
    hooks['session/event']({ id: 'history' }, { seq: 3, type: 'request/header', data: { header: { config: { provider: 'router', model: 'real' } } } });
    const attemptedStream = [{ type: 'text-chunks', time0: 1000, dt: [500], texts: ['a', 'b'] }, { type: 'chunk', time: 3000, chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } } }];
    hooks['session/event']({ id: 'history' }, { seq: 4, type: 'assistant/attempt', time: 3000, data: { turn: 3, step: 0, stream: attemptedStream } });
    hooks['session/event']({ id: 'history' }, { seq: 5, type: 'assistant/attempt', time: 4000, data: { turn: 3, step: 0, stream: [{ type: 'text-chunks', time0: 3500, dt: [], texts: ['retry'] }] } });
    assert.equal(ledger.rows.has('harness:history:4'), false); assert.equal(ledger.rows.has('harness:history:5'), false); assert.equal(ledger.rows.size, 3);
    hooks['session/event']({ id: 'history' }, { seq: 6, type: 'assistant/message', time: 5000, data: { turn: 3, step: 0, usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 }, stream: [{ type: 'text-chunks', time0: 4500, dt: [], texts: ['settled'] }] } });
    const settled = ledger.rows.get('harness:history:6'); assert.equal(settled.tool, 'router'); assert.equal(settled.model, 'real'); assert.equal(settled.durationMs, 4000); assert.equal(ledger.rows.size, 4);
    hooks['session/event']({ id: 'history' }, { seq: 7, type: 'assistant/message', time: 6000, data: { turn: 3, step: 1, usage } });
    assert.equal(ledger.rows.get('harness:history:7').durationMs, null);
    assert.equal((await route.fetch(query({ origin: 'https://attacker.test' }))).status, 400);
    for (const dispose of effects.reverse()) await dispose();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('ledger deduplicates, filters exclusive end and never stores content', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'commander-usage-'));
  try {
    const ledger = await new UsageLedger(dir).open();
    const row = { id: 'a', tool: 'codex', model: 'test', time: '2026-10-16T00:00:00Z', prompt: 'private', response: 'secret', durationMs: 2000, ...normalizeUsage({ inputTokens: 100, outputTokens: 20, cached_input_tokens: 50, totalTokens: 120 }, 'inclusive') };
    ledger.put(row); ledger.put(row); ledger.put({ ...row, id: 'b', time: '2026-10-17T00:00:00Z' }); await ledger.flush();
    const result = ledger.query({ start: '2026-10-16', end: '2026-10-17' });
    assert.equal(result.recordCount, 1); assert.equal(result.summary.totalTokens, 120); assert.equal(result.summary.cacheHitRate, 0.5); assert.equal(result.summary.tokensPerSecond, 10);
    const stored = await readFile(ledger.path, 'utf8'); assert.doesNotMatch(stored, /private|secret|prompt|response/);
    assert.equal((await new UsageLedger(dir).open()).rows.size, 2);
    ledger.put({ ...row, durationMs: null }); assert.equal(ledger.rows.get('a').durationMs, 2000);
    ledger.put({ id: 'unknown', tool: 'pi', time: row.time }); assert.equal(ledger.query({ start: '2026-10-16', end: '2026-10-17' }).summary.totalTokens, 120);
    assert.throws(() => ledger.query({ start: 'bad', end: 'bad' }));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('mixed historical missing fields preserve known subtotals and cache ratio uses one measured subset', () => {
  const ledger = new UsageLedger('/unused'), time = '2026-11-09T16:00:00Z';
  for (const row of [
    { id: 'full', inputTokens: 40, outputTokens: 20, totalTokens: 120, cacheReadTokens: 60 },
    { id: 'total-only', totalTokens: 500 },
    { id: 'cache-only', cacheReadTokens: 900 },
    { id: 'partial-input', inputTokens: 7, outputTokens: 3 },
    { id: 'disjoint', inputTokens: 20, outputTokens: 10, cacheReadTokens: 30, cacheWriteTokens: 0 },
    { id: 'zero', inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0 },
    { id: 'unknown' },
  ]) ledger.put({ tool: 'codex', model: 'same', time, ...row });
  const result = ledger.query({ start: '2026-11-09T16:00:00Z', end: '2026-11-10T16:00:00Z', timeZone: 'Asia/Shanghai' });
  assert.equal(result.summary.totalTokens, 620);
  assert.equal(result.summary.inputTokens, 67);
  assert.equal(result.summary.outputTokens, 33);
  assert.equal(result.summary.cacheReadTokens, 990);
  assert.equal(result.summary.cacheWriteTokens, 0);
  assert.equal(result.summary.cacheHitRate, 90 / 150);
  assert.equal(result.summary.measuredCalls, 3);
  assert.equal(result.summary.incompleteCalls, 5);
  assert.equal(result.groups[0].totalTokens, result.summary.totalTokens);
  assert.equal(result.timeline.buckets.reduce((sum, bucket) => sum + (bucket.totalTokens ?? 0), 0), result.summary.totalTokens);
  const empty = ledger.query({ start: '2026-11-11', end: '2026-11-12' });
  assert.equal(empty.summary.totalTokens, null); assert.equal(empty.summary.cacheHitRate, null);
  ledger.rows.clear(); ledger.put({ id: 'unknown', time });
  const unknown = ledger.query({ start: '2026-11-09T16:00:00Z', end: '2026-11-10T16:00:00Z' });
  assert.equal(unknown.summary.totalTokens, null); assert.equal(unknown.summary.inputTokens, null); assert.equal(unknown.summary.cacheReadTokens, null); assert.equal(unknown.summary.cacheHitRate, null);
});

test('every preset interval includes known historical usage without null poisoning or changing local day boundaries', () => {
  const ledger = new UsageLedger('/unused'), end = '2026-11-10T16:00:00Z';
  for (let day = 1; day <= 30; day++) {
    const time = new Date(Date.parse(end) - day * 86400000).toISOString();
    ledger.put({ id: 'measured-' + day, tool: 'codex', time, totalTokens: 10, inputTokens: 8, outputTokens: 2, cacheReadTokens: 0 });
    if (day > 1) ledger.put({ id: 'unknown-' + day, tool: 'other', time });
  }
  ledger.put({ id: 'excluded-end', tool: 'codex', time: end, totalTokens: 9999 });
  for (const days of [1, 3, 7, 15, 30]) {
    const start = new Date(Date.parse(end) - days * 86400000).toISOString();
    const result = ledger.query({ start, end, timeZone: 'Asia/Shanghai' });
    assert.equal(result.summary.totalTokens, days * 10);
    assert.equal(result.summary.cacheHitRate, 0);
    assert.equal(result.summary.incompleteCalls, days - 1);
    assert.equal(result.recordCount, days * 2 - 1);
    assert.equal(result.groups.find(group => group.tool === 'other')?.totalTokens ?? null, null);
  }
});

test('server pagination returns 50 records while overview aggregates the full interval',()=>{
 const ledger=new UsageLedger('/unused');for(let i=0;i<123;i++)ledger.put({id:String(i),tool:'codex',model:'m',time:new Date(Date.UTC(2026,9,16,0,0,i)).toISOString(),...normalizeUsage({inputTokens:10,outputTokens:1,totalTokens:11})});
 const range={start:'2026-10-16',end:'2026-10-17'};
 const first=ledger.query(range),second=ledger.query({...range,page:2}),last=ledger.query({...range,page:3});
 assert.equal(first.records.length,50);assert.equal(first.pageCount,3);assert.equal(first.summary.totalTokens,1353);assert.equal(second.records.length,50);assert.equal(last.records.length,23);assert.equal(first.records.some(row=>second.records.some(other=>other.id===row.id)),false);assert.equal(ledger.query({...range,page:999}).page,3);for(const page of [0,-1,1.2,'2'])assert.throws(()=>ledger.query({...range,page}));assert.throws(()=>ledger.query({...range,pageSize:100000}));
});

test('cached intervals reflect updates, removals, ownership, native completeness and fresh coverage', () => {
  const ledger = new UsageLedger('/unused'), time = '2026-11-10T00:00:00Z';
  const range = { start: '2026-11-10', end: '2026-11-11' };
  ledger.managed = () => new Map([['session', 'codex:native']]);
  ledger.importer = { coverage: { state: 'ready' }, completeNativeIds: new Set() };
  ledger.put({ id: 'live', sessionId: 'session', tool: 'codex', time, totalTokens: 10 });
  ledger.put({ id: 'imported', source: 'machine', tool: 'codex', nativeId: 'native', time, totalTokens: 100 });
  const first = ledger.query(range);
  assert.equal(first.summary.totalTokens, 10);
  assert.equal(ledger.query({ ...range, page: 2 }).summary, first.summary);
  ledger.error = 'write failed'; ledger.historyState = 'scanning';
  const progress = ledger.query(range);
  assert.equal(progress.error, 'write failed'); assert.equal(progress.coverage.historyState, 'scanning');
  ledger.importer.completeNativeIds.add('codex:native');
  assert.equal(ledger.query(range).summary.totalTokens, 100);
  ledger.importer.coverage = { state: 'scanning' };
  assert.equal(ledger.query(range).summary.totalTokens, 10);
  ledger.importer.coverage = { state: 'ready' };
  ledger.put({ id: 'imported', source: 'machine', tool: 'codex', nativeId: 'native', time, totalTokens: 120 });
  assert.equal(ledger.query(range).summary.totalTokens, 120);
  ledger.managed = () => new Map([['session', 'codex:different']]);
  assert.equal(ledger.query(range).summary.totalTokens, 130);
  ledger.delete('live'); assert.equal(ledger.query(range).summary.totalTokens, 120);
  ledger.delete('imported'); assert.equal(ledger.query(range).summary.totalTokens, null);
  assert.throws(() => ledger.query({ ...range, timeZone: 'invalid' }));
});

test('slow machine scans and refreshes run behind immediate validated responses', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'commander-usage-background-'));
  const effects = [], routes = [];
  const ctx = { effect(fn) { const dispose = fn(); if (dispose) effects.push(dispose); }, on() {}, inject() {}, connection: { fetch: { register(route) { routes.push(route); return () => {}; } } } };
  let release;
  try {
    const ledger = await mountUsage(ctx, { store: { directory: dir }, sessions: new Map(), on() {}, off() {} }, { enabled: false });
    let scans = 0;
    ledger.importer.scan = async () => { scans++; await new Promise(resolve => { release = resolve; }); ledger.importer.coverage = { state: 'ready', sources: [], scannedBytes: 0 }; };
    const request = (input = {}) => routes[0].fetch(new Request('http://app.test/api/commander/usage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ start: '2026-11-10', end: '2026-11-11', ...input }) }));
    assert.equal((await request({ page: 0 })).status, 400); assert.equal(scans, 0);
    assert.equal((await request({ timeZone: 'invalid' })).status, 400); assert.equal(scans, 0);
    const first = await (await request()).json();
    assert.equal(first.coverage.state, 'scanning'); assert.equal(scans, 1);
    await request({ refresh: true }); assert.equal(scans, 1);
    release(); await new Promise(resolve => setImmediate(resolve));
    assert.equal((await (await request()).json()).coverage.state, 'ready');
    const refresh = await (await request({ refresh: true })).json();
    assert.equal(scans, 2); assert.equal(refresh.coverage.state, 'scanning');
    release(); await new Promise(resolve => setImmediate(resolve));
    for (const dispose of effects.reverse()) await dispose();
  } finally { release?.(); await rm(dir, { recursive: true, force: true }); }
});
