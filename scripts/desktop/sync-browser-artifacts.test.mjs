import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { releaseBundleName } from '../../plugins/benchgo/shared/plugin-install.mjs';
import { syncDesktopBrowserArtifacts } from './sync-browser-artifacts.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'benchgo-browser-sync-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = join(root, 'profile'), source = join(root, 'plugins/benchgo');
  const releaseRoot = join(profile, '.benchgo/releases'), directory = join(releaseRoot, '0.1.1');
  const target = join(directory, 'node_modules/benchgo-plugin'), bundleName = releaseBundleName('0.1.1');
  const wrapper = join(directory, 'node_modules', bundleName);
  const put = async (path, text) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, text); };
  const state = { schemaVersion: 1, version: '0.1.1', directory, root: releaseRoot, bundleName };
  const manifest = { dsh: { profile: { bundles: [bundleName] }, plusInstall: state } };
  const save = () => put(join(profile, 'package.json'), JSON.stringify(manifest));
  await save();
  await put(join(wrapper, 'package.json'), JSON.stringify({ name: bundleName, version: '0.1.1', dependencies: { 'benchgo-plugin': '0.1.1' } }));
  await mkdir(join(profile, 'node_modules/@benchgo'), { recursive: true });
  await symlink(wrapper, join(profile, 'node_modules', bundleName), process.platform === 'win32' ? 'junction' : 'dir');
  for (const base of [source, target]) {
    await put(join(base, 'package.json'), JSON.stringify({ name: 'benchgo-plugin', version: '0.1.1' }));
    for (const file of ['lib/client.js', 'lib/preview/markdown.js', 'lib/link-web/index.html', 'assets/channel-brands/sources.json', 'assets/fonts/web/text.woff2', 'assets/icon.svg', 'lib/UI-LICENSES.txt', 'lib/LINK-THIRD-PARTY-LICENSES.txt'])
      await put(join(base, file), base === source ? `new:${file}` : `old:${file}`);
  }
  for (const language of ['en', 'zh-CN']) {
    for (const base of [source, target, wrapper]) await put(join(base, `locale/${language}.json`), JSON.stringify({ meta: { title: base === source ? 'BenchGo' : language === 'en' ? 'Base' : '基础层' } }));
  }
  for (const file of ['lib/server/seed.zip', 'lib/modules/superagent/src/service.mjs', 'lib/link.mjs', 'src/plugin.mjs', 'cordis.patch.yml']) await put(join(target, file), 'preserve:'+file);
  return { root, profile, source, target, directory, wrapper, state, manifest, save, put };
}

test('browser sync validates the selected release, preserves services and publishes client last', async t => {
  const f = await fixture(t), writes = [];
  const before = await readFile(join(f.profile, 'package.json'), 'utf8');
  const result = await syncDesktopBrowserArtifacts({ root: f.root, profile: f.profile, write: async (path, bytes) => { writes.push(path); await writeFile(path, bytes); } });
  assert.equal(result.synced, true);
  assert.equal(writes.at(-1), join(f.target, 'lib/client.js'));
  assert.equal(await readFile(writes.at(-1), 'utf8'), 'new:lib/client.js');
  assert.equal(await readFile(join(f.target, 'lib/preview/markdown.js'), 'utf8'), 'new:lib/preview/markdown.js');
  assert.equal(await readFile(join(f.target, 'lib/link-web/index.html'), 'utf8'), 'new:lib/link-web/index.html');
  for (const file of ['lib/server/seed.zip', 'lib/modules/superagent/src/service.mjs', 'lib/link.mjs', 'src/plugin.mjs', 'cordis.patch.yml']) assert.equal(await readFile(join(f.target, file), 'utf8'), 'preserve:'+file);
  assert.equal(await readFile(join(f.profile, 'package.json'), 'utf8'), before);
  assert.equal(JSON.parse(await readFile(join(f.target, 'package.json'), 'utf8')).version, '0.1.1');
  for (const base of [f.target, f.wrapper]) for (const language of ['en', 'zh-CN']) {
    assert.equal(JSON.parse(await readFile(join(base, `locale/${language}.json`), 'utf8')).meta.title, 'BenchGo');
  }
  assert.equal(JSON.parse(await readFile(join(f.wrapper, 'package.json'), 'utf8')).name, f.state.bundleName);
});

test('default writer creates missing browser directories atomically and retains older assets', async t => {
  const f = await fixture(t);
  await rm(join(f.target, 'lib/preview'), { recursive: true });
  await f.put(join(f.target, 'lib/link-web/old-chunk.js'), 'old-open-page');
  await syncDesktopBrowserArtifacts(f);
  assert.equal(await readFile(join(f.target, 'lib/preview/markdown.js'), 'utf8'), 'new:lib/preview/markdown.js');
  assert.equal(await readFile(join(f.target, 'lib/link-web/old-chunk.js'), 'utf8'), 'old-open-page');
});

for (const mode of ['unmanaged', 'disabled']) test(`browser sync skips ${mode} profile`, async t => {
  const f = await fixture(t);
  if (mode === 'unmanaged') delete f.manifest.dsh.plusInstall;
  else f.manifest.dsh.profile.bundles = [];
  await f.save();
  let writes = 0;
  const result = await syncDesktopBrowserArtifacts({ ...f, write: async () => { writes++; } });
  assert.equal(result.synced, false); assert.equal(result.reason, mode); assert.equal(writes, 0);
});

for (const mode of ['outside', 'package', 'active-pointer', 'destination-link', 'source-link', 'wrapper-locale-link', 'source-locale-link', 'missing-source']) test(`browser sync rejects ${mode} before writing`, async t => {
  const f = await fixture(t);
  if (mode === 'outside') { f.state.directory = join(f.root, 'outside'); await f.save(); }
  if (mode === 'package') await f.put(join(f.target, 'package.json'), JSON.stringify({ name: 'other-plugin', version: '0.1.1' }));
  if (mode === 'active-pointer') {
    await rm(join(f.profile, 'node_modules', f.state.bundleName));
    await symlink(f.source, join(f.profile, 'node_modules', f.state.bundleName), process.platform === 'win32' ? 'junction' : 'dir');
  }
  if (mode === 'destination-link' || mode === 'source-link') {
    const path = join(mode === 'destination-link' ? f.target : f.source, 'lib/preview');
    await rm(path, { recursive: true });
    await mkdir(join(f.root, 'outside'), { recursive: true });
    await symlink(join(f.root, 'outside'), path, process.platform === 'win32' ? 'junction' : 'dir');
  }
  if (mode === 'wrapper-locale-link' || mode === 'source-locale-link') {
    const path = join(mode === 'wrapper-locale-link' ? f.wrapper : f.source, 'locale');
    await rm(path, { recursive: true });
    const outside = join(f.root, 'outside');
    await mkdir(outside);
    await f.put(join(outside, 'en.json'), '{"meta":{"title":"external"}}');
    await symlink(outside, path, process.platform === 'win32' ? 'junction' : 'dir');
  }
  if (mode === 'missing-source') await rm(join(f.source, 'lib/client.js'));
  let writes = 0;
  await assert.rejects(syncDesktopBrowserArtifacts({ ...f, write: async () => { writes++; } }));
  assert.equal(writes, 0);
  assert.equal(await readFile(join(f.target, 'lib/client.js'), 'utf8'), 'old:lib/client.js');
});
