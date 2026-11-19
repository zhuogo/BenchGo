import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { createSkillDeck, skillInstallPlan } from '../src/skill-deck.mjs';
import manifest from '../src/skill-deck-manifest.json' with { type: 'json' };

const hash = value => createHash('sha1').update(`blob ${Buffer.byteLength(value)}\0`).update(value).digest('hex');
const file = (path, text) => ({ path, size: Buffer.byteLength(text), sha: hash(text), mode: '100644' });
const content = '---\nname: example\ndescription: Example\ndisable-model-invocation: true\n---\nRead [guide](guide.md).\n';
async function fixture(t, { catalog, fetchImpl, support = 'Support content' } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'benchgo-skill-deck-')), root = join(base, 'skills');
  t.after(() => rm(base, { recursive: true, force: true }));
  const definition = { ...manifest, license: file('LICENSE', 'MIT fixture'), skills: [
    { name: 'reference', description: 'Reference', category: 'engineering', directory: 'skills/engineering/reference', dependencies: [], modelInvocable: true, files: [file('SKILL.md', 'Reference instructions')] },
    { name: 'example', description: 'Example', category: 'engineering', directory: 'skills/engineering/example', dependencies: ['reference'], modelInvocable: false, files: [file('SKILL.md', content), file('guide.md', support)] },
  ] };
  const bodies = { 'LICENSE': 'MIT fixture', 'skills/engineering/reference/SKILL.md': 'Reference instructions', 'skills/engineering/example/SKILL.md': content, 'skills/engineering/example/guide.md': support };
  const requests = [];
  const service = createSkillDeck({ root, definition, getCatalog: async () => catalog || { available: true, skills: [] }, fetchImpl: async (url, options) => {
    requests.push({ url, options }); const key = new URL(url).pathname.split('/').slice(4).join('/');
    return fetchImpl ? fetchImpl(url, options, bodies[key]) : new Response(bodies[key], { status: bodies[key] === undefined ? 404 : 200 });
  } });
  return { service, root, requests, definition };
}

test('reviewed catalog is exactly 27 fixed-version skills and dependency closure is deterministic', () => {
  assert.equal(manifest.skills.length, 27);
  assert.equal(manifest.commit, 'd1478fcb140db0b93c0c8df17bcfd311844749d0');
  assert.deepEqual(skillInstallPlan('implement').map(row => row.name), ['codebase-design', 'tdd', 'setup-matt-pocock-skills', 'code-review', 'implement']);
  assert.deepEqual(skillInstallPlan('grill-me').map(row => row.name), ['grilling', 'grill-me']);
  assert.equal(skillInstallPlan('ask-matt').length, 27);
  assert.throws(() => skillInstallPlan('../outside'), { status: 404 });
  assert(manifest.skills.every(row => row.files.every(file => /^[a-f0-9]{40}$/.test(file.sha))));
});

test('preview checks fixed source hashes and keeps original invocation boundary and license', async t => {
  const { service, requests, root } = await fixture(t);
  const result = await service.get('example');
  assert.equal(result.skill.content, content); assert.equal(result.skill.modelInvocable, false);
  assert.equal(result.licenseText, 'MIT fixture'); assert.deepEqual(result.skill.files, ['SKILL.md', 'guide.md']);
  assert.deepEqual(result.skill.plan.map(row => row.name), ['reference', 'example']);
  assert(requests.every(row => row.options.redirect === 'error' && row.url.includes(manifest.commit)));
  await assert.rejects(readdir(root), { code: 'ENOENT' });
});

test('single selection installs its dependencies and support files without executing or overwriting', async t => {
  const { service, root } = await fixture(t);
  const result = await service.install('example'); assert.deepEqual(result.installed, ['reference', 'example']);
  assert.equal(await readFile(join(root, 'example/SKILL.md'), 'utf8'), content);
  assert.equal(await readFile(join(root, 'example/guide.md'), 'utf8'), 'Support content');
  assert.equal(await readFile(join(root, 'example/LICENSE'), 'utf8'), 'MIT fixture');
  const receipt = JSON.parse(await readFile(join(root, 'example/.benchgo-source.json'), 'utf8'));
  assert.equal(receipt.commit, manifest.commit); assert.equal(receipt.name, 'example');
  await writeFile(join(root, 'example/guide.md'), 'User edits');
  assert.equal((await service.install('example')).alreadyInstalled, true);
  assert.equal(await readFile(join(root, 'example/guide.md'), 'utf8'), 'User edits');
  const rows = (await service.list()).skills;
  assert.equal(rows.find(row => row.name === 'example').status, 'installed');
  assert.equal(rows.find(row => row.name === 'example').available, false);
});

test('existing local directory or effective skill blocks the complete plan before download', async t => {
  const local = await fixture(t); await mkdir(join(local.root, 'reference'), { recursive: true });
  await writeFile(join(local.root, 'reference/keep.txt'), 'Keep');
  await assert.rejects(local.service.install('example'), { status: 409 });
  assert.equal(local.requests.length, 0); assert.deepEqual(await readdir(local.root), ['reference']);
  const other = await fixture(t, { catalog: { available: true, skills: [{ name: 'reference', provider: 'user-custom' }] } });
  await assert.rejects(other.service.install('example'), /已有其他来源/);
  assert.equal(other.requests.length, 0);
});

test('missing host service permits browsing but never starts an installation', async t => {
  const { service, requests } = await fixture(t, { catalog: { available: false, skills: [] } });
  assert.equal((await service.list()).available, false);
  await assert.rejects(service.install('example'), { status: 503 });
  assert.equal(requests.length, 0);
});

test('tampered download fails before publication and retains no installed directories', async t => {
  const { service, root } = await fixture(t, { fetchImpl: async (url, options, original) => new Response(url.endsWith('guide.md') ? 'Tampered source' : original) });
  await assert.rejects(service.install('example'), /校验失败|大小与固定版本不一致/);
  assert.deepEqual(await readdir(root), []);
});

test('concurrent install is rejected and failed publication rolls back only this operation', async t => {
  let release, entered;
  const wait = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { entered = resolve; });
  const { service, root } = await fixture(t, { fetchImpl: async (url, options, original) => { if (url.endsWith('/LICENSE')) { entered(); await wait; } return new Response(original); } });
  const pending = service.install('example'); await ready;
  await assert.rejects(service.install('example'), /另一个技能正在安装/);
  await mkdir(join(root, 'example')); await writeFile(join(root, 'example/user.txt'), 'User file');
  release(); await assert.rejects(pending, /已被其他操作创建/);
  assert.deepEqual(await readdir(root), ['example']);
  assert.equal(await readFile(join(root, 'example/user.txt'), 'utf8'), 'User file');
});

test('symlinked skill root is rejected without changing the target', async t => {
  const { service, root } = await fixture(t);
  const external = root + '-external'; await mkdir(external);
  await symlink(external, root, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(service.install('example'), /链接/);
  assert.deepEqual(await readdir(external), []);
});

test('official filesystem watcher discovers installed skill and preserves invocation policy', async t => {
  const { root, service } = await fixture(t);
  const require = createRequire(new URL('../../../deepseek-harness/packages/skill/skill/package.json', import.meta.url));
  const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);
  const { default: SkillRegistry } = await import('../../../deepseek-harness/packages/skill/skill/lib/index.js');
  const FileSystem = await import('../../../deepseek-harness/packages/skill/skill-filesystem/lib/index.js');
  const ctx = new Context(); t.after(() => ctx.fiber.dispose());
  await mkdir(root); await ctx.plugin(SkillRegistry);
  await ctx.plugin(FileSystem, { includeDefaultRoots: false, customSkillDirs: [root] });
  assert.deepEqual(await ctx.skills.list(), []);
  await service.install('example');
  let skill;
  for (let attempt = 0; attempt < 12; attempt++) {
    await setTimeout(250); skill = await ctx.skills.get('example'); if (skill) break;
  }
  assert.equal(skill?.provider, 'filesystem');
  assert.equal(skill?.invocation.modelInvocable, false);
  assert.equal(skill?.invocation.userInvocable, true);
  assert.equal(skill?.content, 'Read [guide](guide.md).');
});
