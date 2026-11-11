import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Exercise the pinned official YAML/patch/Loader and SQLite implementations.
const official = new URL('../../../deepseek-harness/', import.meta.url);
const queryRequire = createRequire(new URL('packages/session-query/session-query-sqlite/package.json', official));
const includeRequire = createRequire(new URL('vendor/include/package.json', official));
const load = name => import(pathToFileURL(queryRequire.resolve(name)));
const { Context } = await load('@deepseek-ai/cordis');
const { default: Sessions } = await load('@deepseek-ai/dsh-session');
const { default: Projections } = await load('@deepseek-ai/dsh-session-projection');
const { createUserMessage } = await load('@deepseek-ai/dsh-llm');
const { default: Loader } = await import(new URL('vendor/loader/lib/index.js', official));
const { applyEntryPatches, entryListSchema } = await import(new URL('vendor/include/lib/index.js', official));
const { default: SqliteQuery } = await import(new URL('packages/session-query/session-query-sqlite/lib/index.js', official));
const { load: parseYaml } = includeRequire('js-yaml');

async function patches(url) {
  return parseYaml(await readFile(url, 'utf8'), { schema: entryListSchema });
}

async function composedRows(surface) {
  const layers = [await patches(new URL('packages/bundle/base/cordis.patch.yml', official))];
  if (surface === 'web') layers.push(await patches(new URL('packages/bundle/web-app/cordis.patch.yml', official)));
  layers.push(await patches(new URL('../cordis.patch.yml', import.meta.url)));
  const warnings = [];
  const rows = applyEntryPatches([], layers.flat(), (...warning) => warnings.push(warning));
  assert.deepEqual(warnings, []);
  return rows;
}

for (const surface of ['base', 'web']) {
  test(`${surface} bundle preserves five BenchGo entries and enables one durable official index`, async () => {
    const rows = await composedRows(surface);
    const search = rows.filter(row => row.id === 'session-query-sqlite');
    assert.equal(search.length, 1);
    assert.equal(search[0].name, '@deepseek-ai/dsh-session-query-sqlite');
    assert.deepEqual(search[0].config, {
      path: { __jsExpr: "dshHomePath('storages/benchgo-session-search.sqlite')" },
      openAt: 'first-search',
    });
    assert.deepEqual(rows.filter(row => row.name?.startsWith('benchgo-plugin')).map(row => row.name), [
      'benchgo-plugin', 'benchgo-plugin/harness-plugin', 'benchgo-plugin/superagent-plugin',
      'benchgo-plugin/voice-plugin', 'benchgo-plugin/link-plugin',
    ]);
  });
}

test('official Loader resolves the home path and SQLite opens lazily, persists and reopens', async t => {
  const root = await mkdtemp(join(tmpdir(), 'benchgo-history-config-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const indexPath = join(root, 'storages/benchgo-session-search.sqlite');
  const row = (await composedRows('web')).find(row => row.id === 'session-query-sqlite');
  const event = { type: 'user/message', seq: 0, time: 1, surfaceOp: 'append',
    data: createUserMessage({ content: [{ type: 'text', text: 'history config fixture' }], source: { kind: 'user' } }) };

  async function mount() {
    const ctx = new Context();
    ctx.provide('dshHomePath', path => join(root, path));
    await ctx.plugin(Sessions);
    await ctx.plugin(Projections);
    await ctx.plugin(Loader);
    ctx.loader.builtins['search-fixture'] = SqliteQuery;
    await ctx.loader.root.create({ ...row, name: 'cordis:search-fixture' });
    await ctx.loader.await();
    assert.ok(ctx.sessionQuery, 'the configured service must activate');
    assert.equal(ctx.sessionQuery.config.path, indexPath);
    assert.equal(ctx.sessionQuery.config.openAt, 'first-search');
    ctx.sessions.create('config-fixture', { seed: [event], meta: { createdAt: 1 } });
    return ctx;
  }

  const first = await mount();
  try {
    await assert.rejects(stat(indexPath), { code: 'ENOENT' }, 'startup must not open SQLite');
    const page = await first.sessionQuery.searchEvents({ sessionId: 'config-fixture', query: 'history' });
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].seq, 0);
    assert.ok((await stat(indexPath)).size > 0);
  } finally {
    await first.fiber.dispose();
  }
  assert.equal((await readFile(indexPath)).subarray(0, 16).toString(), 'SQLite format 3\0');

  const second = await mount();
  try {
    const page = await second.sessionQuery.searchEvents({ sessionId: 'config-fixture', query: 'fixture' });
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].sessionId, 'config-fixture');
  } finally {
    await second.fiber.dispose();
  }
});
