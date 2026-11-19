import test from 'node:test';
import assert from 'node:assert/strict';
import { createSkillsCatalog, mountSkills } from '../src/skills.mjs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('default preset scope discovers installed filesystem skills and releases every read lease', async t => {
  const require = createRequire(new URL('../../../deepseek-harness/packages/skill/skill/package.json', import.meta.url));
  const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);
  const { createScope, scopeOf } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-scope')).href);
  const { default: SkillRegistry } = await import('../../../deepseek-harness/packages/skill/skill/lib/index.js');
  const FileSystem = await import('../../../deepseek-harness/packages/skill/skill-filesystem/lib/index.js');
  const root = await mkdtemp(join(tmpdir(), 'benchgo-skill-catalog-'));
  const ctx = new Context(); await ctx.plugin(SkillRegistry);
  const preset = createScope(ctx, { preset: 'skills-fixture' });
  t.after(async () => { await preset.dispose(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); });
  await mkdir(join(root, 'installed'));
  await writeFile(join(root, 'installed/SKILL.md'), '---\nname: installed\ndescription: User installed skill\n---\nActual instructions.');
  await preset.ctx.plugin(FileSystem, { includeDefaultRoots: false, customSkillDirs: [root], watch: false });
  assert.deepEqual(await ctx.skills.list(), []);
  let released = 0;
  const api = createSkillsCatalog({ getSkills: () => ctx.skills, getWorkspaces: () => undefined,
    getPresets: () => ({ acquireScope: async () => ({ key: scopeOf(preset.ctx), [Symbol.asyncDispose]: async () => { released++; } }) }) });
  const list = await api({ action: 'list' });
  assert.equal(list.skills[0].name, 'installed'); assert.equal(released, 1);
  assert.equal((await api({ action: 'get', name: 'installed', provider: 'filesystem' })).skill.content, 'Actual instructions.');
  assert.equal(released, 2);
  await assert.rejects(api({ action: 'get', name: 'installed', provider: 'changed' }), { status: 409 });
  assert.equal(released, 3);
  const abort = new AbortController();
  const cancelled = createSkillsCatalog({ getSkills: () => ctx.skills, getWorkspaces: () => undefined,
    getPresets: () => ({ acquireScope: async () => { abort.abort(); return { key: scopeOf(preset.ctx), [Symbol.asyncDispose]: async () => { released++; } }; } }) });
  await assert.rejects(cancelled({ action: 'list' }, abort.signal), { name: 'AbortError' });
  assert.equal(released, 4);
});

test('catalog uses official global/project lookup and preserves opaque provider metadata', async () => {
  const calls = [], row = { name: 'example', description: 'Example', provider: 'opaque:provider', source: 'custom', path: '/skills/example/SKILL.md', invocation: { modelInvocable: false, userInvocable: true } };
  const api = createSkillsCatalog({ getSkills: () => ({ list: async options => { calls.push(options); return [row]; }, get: async (name, options) => { calls.push(options); return { ...row, content: 'Body' }; } }), getWorkspaces: () => ({ list: () => [{ id: 'project', title: 'Project', path: '/project' }] }) });
  const global = await api({ action: 'list' });
  assert.deepEqual(global.skills, [row]); assert.equal(calls[0].cwd, undefined);
  const project = await api({ action: 'list', projectId: 'project' });
  assert.equal(project.scope.cwd, '/project'); assert.equal(calls[1].cwd, '/project');
  assert.equal((await api({ action: 'get', name: row.name, provider: row.provider })).skill.content, 'Body');
  await assert.rejects(api({ action: 'get', name: row.name, provider: 'old-provider' }), { status: 409 });
  await assert.rejects(api({ action: 'list', projectId: '../unknown' }), { status: 404 });
});

test('missing service differs from an empty catalog and provider failures propagate', async () => {
  const api = createSkillsCatalog({ getSkills: () => undefined, getWorkspaces: () => undefined });
  assert.deepEqual(await api({ action: 'list' }), { available: false, skills: [], projects: [], scope: { title: '全局技能' } });
  await assert.rejects(api({ action: 'get', name: 'example', provider: 'provider' }), { status: 503 });
  const failed = createSkillsCatalog({ getSkills: () => ({ list: async () => { throw Error('failure'); }, get() {} }), getWorkspaces: () => undefined });
  await assert.rejects(failed({ action: 'list' }), /failure/);
});

test('owner route enforces same-origin and JSON, remains mounted without optional services', async () => {
  let route;
  mountSkills({ get: () => undefined, effect: fn => fn(), connection: { fetch: { register: value => { route = value; } } } });
  const request = headers => new Request('http://localhost/api/benchgo/skills', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ action: 'list' }) });
  assert.equal(route.path, '/api/benchgo/skills');
  const response = await route.fetch(request());
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await route.fetch(request({ origin: 'https://foreign.example' }))).status, 403);
  assert.equal((await route.fetch(request({ 'content-type': 'text/plain' }))).status, 415);
  assert.equal((await route.fetch(request({ origin: 'dsh-app://app' }))).status, 200);
});
