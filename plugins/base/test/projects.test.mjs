import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, realpath, writeFile, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { dirname, join, parse } from 'node:path';
import { pathToFileURL } from 'node:url';
import { directoryRoots, githubRepository, projectActions } from '../src/projects.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'commander-projects-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registered = [];
  const ctx = { baseUrl: pathToFileURL(`${directory}/`).href, workspaceRegistry: { async create(path) { registered.push(path); return { id: 'shared-project', path, title: 'Cloned' }; } } };
  return { directory, registered, ctx };
}

test('browse shows only visible directories with parent, home and name filtering', async t => {
  const { directory, ctx } = await fixture(t);
  await mkdir(join(directory, 'Alpha'));
  await mkdir(join(directory, 'Beta'));
  await mkdir(join(directory, '.hidden'));
  await writeFile(join(directory, 'file.txt'), 'not a directory');
  const actions = projectActions(ctx);
  const result = await actions.browse({ path: directory });
  assert.equal(result.home, homedir());
  assert.equal(result.path, directory);
  assert.equal(result.parent, dirname(directory));
  if (process.platform === 'win32') assert.ok(result.roots.some(root => root.path === parse(directory).root));
  else assert.deepEqual(result.roots, []);
  assert.deepEqual(result.entries.map(e => e.name), ['Alpha', 'Beta']);
  assert.deepEqual((await actions.browse({ path: directory, name: 'ALP' })).entries.map(e => e.name), ['Alpha']);
  await assert.rejects(actions.browse({ path: 'relative' }), /absolute/);
  await assert.rejects(actions.browse({ path: join(directory, 'file.txt') }), /not a directory/);
});

test('only successful additions update the remembered folder and it survives service reload', async t => {
  const { directory, ctx } = await fixture(t);
  const first = join(directory, 'first'), second = join(directory, 'second');
  await mkdir(first); await mkdir(second);
  const actions = projectActions(ctx, { directory });
  await actions.project({ path: first });
  await actions.browse({ path: second });
  assert.equal((await actions.browse()).path, await realpath(first));
  await assert.rejects(actions.project({ path: join(directory, 'missing') }), /ENOENT/);
  ctx.workspaceRegistry.create = async () => { throw Error('Registration failed'); };
  await assert.rejects(actions.project({ path: second }), /Registration failed/);
  assert.equal((await projectActions(ctx, { directory }).browse()).path, await realpath(first));
  ctx.workspaceRegistry.create = async path => ({ id: 'second', path, title: 'Second' });
  await actions.project({ path: second });
  const reloaded = projectActions(ctx, { directory });
  assert.equal((await reloaded.browse()).path, await realpath(second));
  assert.equal((await reloaded.browse({ path: first })).path, await realpath(first));
  assert.equal((await reloaded.browse()).path, await realpath(second));
  assert.equal((await readdir(directory)).some(name => name.endsWith('.tmp')), false);
});

test('stale or invalid remembered folders fall back home while explicit navigation still reports errors', async t => {
  const { directory, ctx } = await fixture(t);
  const missing = join(directory, 'removed'), file = join(directory, 'file.txt');
  await writeFile(file, 'not a directory');
  const actions = projectActions(ctx, { directory }), home = await realpath(homedir());
  assert.equal((await actions.browse()).path, home);
  for (const record of [JSON.stringify({ path: missing }), JSON.stringify({ path: file }), '{broken', JSON.stringify({ path: 'relative' }), 'null']) {
    await writeFile(join(directory, 'project-picker.json'), record);
    assert.equal((await actions.browse()).path, home, record);
  }
  await assert.rejects(actions.browse({ path: missing }), /ENOENT/);
  await assert.rejects(actions.browse({ path: file }), /not a directory/);
});

test('project folder memory stays in its own data directory', async t => {
  const first = await fixture(t), second = await fixture(t);
  await projectActions(first.ctx, { directory: first.directory }).project({ path: first.directory });
  const other = projectActions(second.ctx, { directory: second.directory });
  assert.equal((await other.browse()).path, await realpath(homedir()));
  await other.project({ path: second.directory });
  assert.equal((await projectActions(first.ctx, { directory: first.directory }).browse()).path, await realpath(first.directory));
  assert.equal((await other.browse()).path, await realpath(second.directory));
});

test('a preference write failure does not fail an already added project or leave temporary files', async t => {
  const { directory, ctx, registered } = await fixture(t), warnings = [];
  ctx.logger = { warn: message => warnings.push(message) };
  await mkdir(join(directory, 'project-picker.json'));
  const result = await projectActions(ctx, { directory }).project({ path: directory });
  assert.equal(result.project.path, await realpath(directory));
  assert.deepEqual(registered, [result.project.path]);
  assert.equal(warnings.length, 1);
  assert.equal((await readdir(directory)).some(name => name.endsWith('.tmp')), false);
});

test('Windows directory roots include other drives and omit missing or inaccessible drives', async () => {
  const checked = [], closed = [];
  const roots = await directoryRoots({ platform: 'win32', openDirectory: async path => {
    checked.push(path);
    if (path === 'D:\\') throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    if (!['C:\\', 'E:\\'].includes(path)) throw Object.assign(new Error('missing drive'), { code: 'ENOENT' });
    return { async close() { closed.push(path); } };
  } });
  assert.deepEqual(roots, [{ name: 'C:', path: 'C:\\' }, { name: 'E:', path: 'E:\\' }]);
  assert.equal(checked.length, 26);
  assert.deepEqual(closed.sort(), ['C:\\', 'E:\\']);
});

test('non-Windows directory roots do not probe Windows drives', async () => {
  assert.deepEqual(await directoryRoots({ platform: 'linux', openDirectory: async () => { assert.fail('must not probe Windows drives'); } }), []);
});

test('browse exposes available drives from a drive root while retaining a null parent', { skip: process.platform !== 'win32' }, async () => {
  const actions = projectActions({});
  const root = parse(process.cwd()).root;
  const result = await actions.browse({ path: root });
  assert.equal(result.path, root);
  assert.equal(result.parent, null);
  assert.ok(result.roots.some(entry => entry.path === root));
});

test('GitHub repository validation only permits HTTPS repository identities', () => {
  assert.deepEqual(githubRepository('https://github.com/anywhere-labs/dsh-desktop.git'), { owner: 'anywhere-labs', name: 'dsh-desktop', url: 'https://github.com/anywhere-labs/dsh-desktop.git' });
  for (const url of ['http://github.com/o/r', 'https://evil.com/o/r', 'https://github.com/o/r/tree/main', 'https://token@github.com/o/r', 'https://github.com/o/r?x=y', 'https://github.com/o/..', 'https://github.com/o/%2e%2e', 'https://github.com/o/-rf;echo']) {
    assert.throws(() => githubRepository(url), /GitHub|Invalid/);
  }
});

test('clone uses active profile workspaces and registers a successful checkout without overwriting existing directories', async t => {
  const { directory, ctx, registered } = await fixture(t);
  const calls = [];
  const actions = projectActions(ctx, { directory, runClone: async (url, path) => { calls.push({ url, path }); await mkdir(path, { recursive: true }); await writeFile(join(path, 'README.md'), 'cloned'); } });
  const result = await actions.clone({ url: 'https://github.com/owner/repo' });
  assert.equal(result.project.path, join(directory, 'workspaces', 'repo'));
  assert.deepEqual(registered, [result.project.path]);
  assert.equal(calls[0].url, 'https://github.com/owner/repo.git');
  assert.equal(await readFile(join(result.project.path, 'README.md'), 'utf8'), 'cloned');
  await assert.rejects(actions.clone({ url: 'https://github.com/another/repo' }), /already exists/);
  assert.equal(calls.length, 1);
  assert.deepEqual(await readdir(join(directory, 'workspaces')), ['repo']);
  assert.equal((await projectActions(ctx, { directory }).browse()).path, result.project.path);
});

test('clone limits concurrency and cleans failed reserved checkout without touching existing paths', async t => {
  const { directory, ctx, registered } = await fixture(t);
  let release;
  const actions = projectActions(ctx, { runClone: async (_url, path) => { await mkdir(path, { recursive: true }); await new Promise(resolve => { release = resolve; }); throw new Error('clone fixture failed'); } });
  const pending = actions.clone({ url: 'https://github.com/owner/failed' });
  while (!release) await new Promise(resolve => setTimeout(resolve, 1));
  await assert.rejects(actions.clone({ url: 'https://github.com/owner/another' }), /being cloned/);
  release();
  await assert.rejects(pending, /fixture failed/);
  assert.deepEqual(await readdir(join(directory, 'workspaces')), []);
  assert.deepEqual(registered, []);
});
