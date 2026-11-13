import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createHistorySearch } from '../src/history-search.mjs';

const requireQuery = createRequire(new URL('../../../deepseek-harness/packages/session-query/session-query-sqlite/package.json', import.meta.url));
const load = name => import(pathToFileURL(requireQuery.resolve(name)).href);
const { Context } = await load('@deepseek-ai/cordis');
const { default: SessionStore } = await load('@deepseek-ai/dsh-session');
const { default: Registry } = await load('@deepseek-ai/dsh-session-projection');
const { default: Search } = await load('@deepseek-ai/dsh-session-query-sqlite');
const { createUserMessage, createAssistantMessage } = await load('@deepseek-ai/dsh-llm');

async function fixture(t, options = {}) {
  const ctx = new Context();
  await ctx.plugin(SessionStore); await ctx.plugin(Registry); await ctx.plugin(Search, { path: ':memory:', openAt: 'first-search' });
  let state = { mainSessionId: 'main', threads: [{ id: 'side', sessionId: 'side' }, { id: 'im', sessionId: 'im', sourceKey: 'channel:im' }], sessionLineage: { main: ['old'], im: ['old-im'] } };
  const service = createHistorySearch({ ctx, store: { getState: async () => state } });
  const sessions = new Map();
  function session(id) { if (!sessions.has(id)) sessions.set(id, ctx.sessions.create(id)); return sessions.get(id); }
  function user(id, value, source = { kind: 'user' }) { return session(id).append('user/message', createUserMessage({ content: [{ type: 'text', text: value }], source }), { surfaceOp: 'append' }); }
  function turn(id, value, answer, { internal = false, tool = false, publication } = {}) {
    const s = session(id), turn = 1 + s.snapshotEvents().filter(e => e.type === 'turn/start').length;
    s.append('turn/start', { turn }); s.append('step/start', { turn, step: 1 });
    const u = createUserMessage({ content: [{ type: 'text', text: value }], source: internal ? { kind: 'benchgo-execution-input' } : { kind: 'user' } });
    s.append('user/message', u, { surfaceOp: 'append' });
    const message = createAssistantMessage({ content: [{ type: 'text', text: answer }, ...(tool ? [{ type: 'tool-call', id: 'call-secret', name: 'hidden-tool', arguments: '{"secret":"needle-private"}' }] : [])], source: { provider: 'test', model: 'test' } });
    s.append('assistant/message', { turn, step: 1, stream: [], message }, { surfaceOp: 'append' });
    if (publication) s.append('plugin:benchgo-plugin/chat-publication', { kind: 'final', requestId: u.id, text: publication }, { ignorable: true });
    s.append('step/end', { turn, step: 1 }); s.append('turn/end', { turn, reason: { kind: 'completed' } });
    return { session: s, user: u };
  }
  t.after(async () => { service.dispose(); await ctx.fiber.dispose(); });
  return { ctx, service, user, turn, session, setState: value => { state = value; } };
}

test('official search limits trusted scope, returns public positions and reads exact original', async t => {
  const f = await fixture(t);
  f.turn('main', 'needle main', 'needle public response');
  f.turn('side', 'needle side', 'side response');
  f.turn('old', 'needle old', 'old response');
  f.turn('worker', 'needle worker', 'worker response');
  f.turn('im', 'needle im', 'im response');
  f.turn('old-im', 'needle old-im', 'old im response');
  // Any accidental legacy full-read path is a regression, even for live logs.
  f.ctx.sessionQuery.readSession = () => { throw Error('legacy full read'); };
  f.ctx.sessionQuery.listSessions = () => { throw Error('legacy global list'); };
  const page = await f.service.search({ query: 'needle', limit: 10 });
  assert.deepEqual(new Set(page.results.map(r => r.sessionId)), new Set(['main', 'side', 'old']));
  assert.equal(page.source, 'official'); assert.equal(page.nextCursor, null);
  assert.equal(page.matchMode, 'official-phrase');
  const hit = page.results.find(r => r.sessionId === 'main');
  const original = await f.service.history({ sessionId: hit.sessionId, seq: hit.seq });
  assert.match(original.events[0].text, /needle/);
  assert.equal(original.events[0].seq, hit.seq);
  await assert.rejects(f.service.history({ sessionId: 'worker' }), { code: 'SESSION_QUERY_FORBIDDEN' });
});

test('maintenance resolves host message references with public feedback and never reads foreign or internal messages', async t => {
  const f = await fixture(t);
  const main = f.turn('main', 'Keep my replies concise', 'I will keep the conclusion short');
  const hidden = f.turn('main', 'secret-maintenance', 'secret-reply', { internal: true });
  const foreign = f.turn('im', 'private-channel', 'private-channel-reply');
  const references = [main, hidden, foreign].map(row => ({ sessionId: row.session.id, messageId: row.user.id, role: 'user' }));
  const result = await f.service.maintenanceSources({ references });
  assert.equal(result.consumedReferences, 3);
  assert.deepEqual(result.items.map(row => row.source.role), ['user', 'assistant']);
  assert.equal(result.items[0].source.messageId, main.user.id);
  assert.ok(!JSON.stringify(result).includes('secret-maintenance'));
  assert.ok(!JSON.stringify(result).includes('private-channel'));
});

test('maintenance character and item limits stop at a complete reference prefix', async t => {
  const f = await fixture(t);
  const a = f.turn('main', 'first '.repeat(1000), 'answer '.repeat(1000));
  const b = f.turn('main', 'second question', 'second answer');
  const references = [a, b].map(row => ({ sessionId: 'main', messageId: row.user.id, role: 'user' }));
  const result = await f.service.maintenanceSources({ references, limit: 2, maxChars: 5000 });
  assert.equal(result.consumedReferences, 1); assert.equal(result.hasMore, true);
  assert.ok(JSON.stringify(result.items).length <= 5000);
  assert.ok(result.items.some(row => row.truncated));
  const rest = await f.service.maintenanceSources({ references: references.slice(result.consumedReferences) });
  assert.equal(rest.consumedReferences, 1); assert.equal(rest.items[0].text, 'second question');
});

test('private internal/tool matches cannot disclose snippets; grouped best match does not hide public fallback', async t => {
  const f = await fixture(t);
  f.turn('main', 'needle-private needle-private needle-private', 'needle-private', { internal: true });
  f.turn('main', 'normal question', 'normal answer', { tool: true });
  assert.deepEqual((await f.service.search({ query: 'needle-private' })).results, []);
  f.turn('main', 'needle-private visible', 'legitimate answer');
  const page = await f.service.search({ query: 'needle-private' });
  assert.equal(page.results.length, 1); assert.match(page.results[0].text, /visible/);
  assert.ok(!JSON.stringify(page.results).includes('hidden-tool'));
  const events = f.session('main').snapshotEvents();
  const hidden = events.find(e => e.type === 'user/message' && e.data.source.kind === 'benchgo-execution-input');
  await assert.rejects(f.service.history({ sessionId: 'main', seq: hidden.seq }), { code: 'SESSION_QUERY_EVENT_NOT_PUBLIC' });
});

test('official cursor pages do not duplicate final rows and scope/query changes reject old cursors', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 5; i++) f.turn('main', `needle question ${i}`, `needle answer ${i}`);
  let cursor, all = [];
  do { const p = await f.service.search({ query: 'needle', sessionId: 'main', limit: 2, cursor }); all.push(...p.results); cursor = p.nextCursor; } while (cursor);
  assert.equal(all.length, 10); assert.equal(new Set(all.map(r => r.seq)).size, 10);
  const page = await f.service.search({ query: 'needle', sessionId: 'main', limit: 2 });
  await assert.rejects(f.service.search({ query: 'other', sessionId: 'main', limit: 2, cursor: page.nextCursor }), { code: 'SESSION_QUERY_INVALID_CURSOR' });
  f.setState({ mainSessionId: 'side', threads: [] });
  await assert.rejects(f.service.search({ query: 'needle', limit: 2, cursor: page.nextCursor }), { code: 'SESSION_QUERY_INVALID_CURSOR' });
});

test('history paging, Unicode original segments, source validation and incrementally changed observations', async t => {
  const f = await fixture(t);
  f.turn('main', 'first question', '😀报告'.repeat(10));
  f.turn('main', 'second question', 'second response');
  const recent = await f.service.history({ sessionId: 'main', limit: 2 });
  assert.equal(recent.events.length, 2); assert.ok(recent.nextCursor);
  const earlier = await f.service.history({ sessionId: 'main', limit: 2, cursor: recent.nextCursor });
  assert.equal(earlier.events.length, 2); assert.equal(earlier.nextCursor, null);
  const target = earlier.events.find(r => r.role === 'assistant');
  let cursor = 0, rebuilt = '';
  do { const [row] = (await f.service.history({ sessionId: 'main', seq: target.seq, textLimit: 4, offset: cursor })).events; rebuilt += row.text; cursor = row.nextOffset; } while (cursor !== null);
  assert.equal(rebuilt, '😀报告'.repeat(10));
  f.turn('main', 'fresh needle', 'fresh answer');
  assert.equal((await f.service.search({ query: 'fresh' })).results.length, 1);
});

test('official Chinese phrase behavior and publication-only coverage are explicit', async t => {
  const f = await fixture(t);
  f.turn('main', '连接我们的香港服务器看看状态', '正常');
  f.turn('side', '香港 服务器 状态', '正常', { publication: '这是仅发布文本中的特殊词 publicationonly' });
  const short = await f.service.search({ query: '香港' });
  assert.deepEqual(short.results.map(r => r.sessionId), ['side']);
  assert.equal(short.coverage, 'official-message-text'); assert.equal(short.limitations.length, 2);
  const publication = await f.service.search({ query: 'publicationonly' });
  assert.deepEqual(publication.results, []); assert.equal(publication.limitations.length, 2);
});

test('cancellation and disabled official search propagate without fallback or activation', async t => {
  const f = await fixture(t); f.turn('main', 'needle', 'answer');
  const controller = new AbortController(); controller.abort(new Error('cancelled'));
  await assert.rejects(f.service.search({ query: 'needle' }, { signal: controller.signal }), /cancelled/);
  f.ctx.sessionQuery.searchSessions = async () => { throw Object.assign(Error('disabled'), { code: 'SESSION_QUERY_SEARCH_DISABLED' }); };
  await assert.rejects(f.service.search({ query: 'needle' }), { code: 'SESSION_QUERY_SEARCH_DISABLED' });
});

test('bounded hidden candidates resume without skipping the eventual public match', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 90; i++) f.turn('main', 'needle private', 'hidden', { internal: true });
  f.turn('main', 'needle visible', 'public');
  const raw = f.session('main').snapshotEvents().filter(e => e.type === 'user/message');
  f.ctx.sessionQuery.searchSessions = async () => ({ items: [{ header: { id: 'main' }, bestMatch: { seq: raw[0].seq } }] });
  let calls = 0;
  f.ctx.sessionQuery.searchEvents = async ({ cursor, limit }) => {
    calls++; const offset = Number(cursor || 0), items = raw.slice(offset, offset + limit).map(e => ({ sessionId: 'main', seq: e.seq }));
    return { items, nextCursor: offset + limit < raw.length ? String(offset + limit) : undefined };
  };
  let cursor, results = [], pages = 0;
  do {
    const page = await f.service.search({ query: 'needle', limit: 1, cursor });
    results.push(...page.results); cursor = page.nextCursor; pages++;
    assert.ok(pages <= 4);
  } while (cursor);
  assert.equal(results.length, 1); assert.equal(results[0].text, 'needle visible');
  assert.ok(pages > 1); assert.equal(calls, 91);
});

test('metadata pages never observe logs and source changes invalidate metadata cursors', async t => {
  const f = await fixture(t); f.turn('main', 'hello', 'reply'); f.turn('side', 'hello', 'reply');
  f.ctx.sessionQuery.observeSession = () => { throw Error('metadata must not read logs'); };
  const p = await f.service.sessions({ limit: 1 });
  assert.equal(p.sessions.length, 1); assert.ok(p.nextCursor);
  const p2 = await f.service.sessions({ limit: 1, cursor: p.nextCursor });
  assert.notEqual(p2.sessions[0].id, p.sessions[0].id); assert.equal(p2.nextCursor, null);
  f.ctx.sessionQuery.filterSessions = async () => [{ header: { id: 'side' } }];
  await assert.rejects(f.service.sessions({ limit: 1, cursor: p.nextCursor }), { code: 'SESSION_QUERY_INVALID_CURSOR' });
});

test('long originals remain pageable in bounded segments', async t => {
  const f = await fixture(t); f.turn('main', 'x'.repeat(20000), 'reply');
  const original = (await f.service.history({ sessionId: 'main' })).events.find(e => e.role === 'user');
  const [p] = (await f.service.history({ sessionId: 'main', seq: original.seq, textLimit: 16000 })).events;
  assert.equal(p.text.length, 16000); assert.equal(p.nextOffset, 16000);
  const [end] = (await f.service.history({ sessionId: 'main', seq: original.seq, textLimit: 16000, offset: p.nextOffset })).events;
  assert.equal(end.text.length, 4000); assert.equal(end.nextOffset, null);
});

test('context response budgets retain nonempty resumable public rows', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 20; i++) f.turn('main', 'x'.repeat(5000), 'y'.repeat(5000));
  const page = await f.service.history({ sessionId: 'main', limit: 100, textLimit: 16000 });
  assert.equal(page.events.length, 40);
  assert.ok(page.events.every(row => row.text.length > 0 && row.nextOffset !== null));
  assert.ok(page.events.reduce((total, row) => total + row.text.length, 0) <= 32000);
});
