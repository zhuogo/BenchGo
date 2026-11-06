import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import config, { verifyPackagedPluginSeed } from './electron-builder.config.mjs';
import { desktopUpdateChannel } from '../../deepseek-harness/apps/desktop/src/update-channel.ts';

test('external seed explicitly includes root node_modules with the official packaging convention', () => {
  const seed = config.extraResources.find(item => item.to === 'benchgo/seed');
  const modules = config.extraResources.find(item => item.to === 'benchgo/seed/node_modules');
  assert.ok(seed);
  assert.equal(modules.from, `${seed.from}/node_modules`);
  assert.deepEqual(modules.filter, ['**/*']);
  assert.equal(typeof config.afterPack, 'function');
});

test('application version stays independent of plugin-only releases', async () => {
  const app = JSON.parse(await readFile(new URL('../../package.json', import.meta.url)));
  assert.equal(config.extraMetadata.version, app.version);
  assert.equal(config.artifactName, `benchgo-${app.version}-win-x64-setup.exe`);
});

test('packaged seed checks all current exported entries without requiring removed source paths', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-seed-contract-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const plugin = join(directory, 'node_modules', 'benchgo-plugin');
  const manifest = JSON.parse(await readFile(new URL('../../plugins/benchgo/package.json', import.meta.url), 'utf8'));
  const entries = ['.', './harness-plugin', './superagent-plugin', './voice-plugin', './link-plugin', './runtime'];
  const files = new Set(['lib/client.js', 'lib/link.mjs', 'lib/link-web/index.html', 'cordis.patch.yml', ...entries.map(key => manifest.exports[key])]);
  for (const file of files) {
    const target = join(plugin, file);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, 'fixture');
  }
  await writeFile(join(directory, 'release.json'), '{}');
  await writeFile(join(plugin, 'package.json'), JSON.stringify(manifest));
  await verifyPackagedPluginSeed(directory);
  for (const key of entries) {
    const target = join(plugin, manifest.exports[key]);
    await rm(target);
    await assert.rejects(verifyPackagedPluginSeed(directory), { code: 'ENOENT' });
    await writeFile(target, 'fixture');
  }
  delete manifest.exports['./superagent-plugin'];
  await writeFile(join(plugin, 'package.json'), JSON.stringify(manifest));
  await assert.rejects(verifyPackagedPluginSeed(directory), /export is missing: \.\/superagent-plugin/);
});


test('BenchGo display naming preserves installed application identity and update channel', () => {
  assert.equal(config.productName, 'BenchGo');
  assert.equal(config.executableName, 'BenchGo');
  assert.equal(config.nsis.shortcutName, 'BenchGo');
  assert.equal(config.nsis.uninstallDisplayName, 'BenchGo ${version}');
  assert.equal(config.appId, 'cn.draftgo.benchgo');
  assert.equal(config.extraMetadata.name, 'benchgo-desktop');
  assert.equal(config.extraMetadata.dshDesktopUpdateChannel, 'stable');
  assert.equal(desktopUpdateChannel(config.extraMetadata), 'stable');
  assert.deepEqual(config.protocols[0].schemes, ['dsh']);
  assert.match(config.publish[0].url, /releases\/download\/app-updates\/$/);
});

test('installer keeps the current BenchGo shortcut during same-version repair', async () => {
  const source = await readFile(new URL('./package-windows.mjs', import.meta.url), 'utf8');
  const literal = source.match(/const bootstrap = ([\s\S]+?);\nawait mkdir/)[1];
  const overlay = runInNewContext(literal);
  assert.doesNotMatch(overlay, /Delete "\$SMPROGRAMS\\BenchGo\.lnk"/);
  assert.doesNotMatch(overlay, /Delete "\$DESKTOP\\BenchGo\.lnk"/);
  const upstream = await readFile(new URL('../../deepseek-harness/apps/desktop/scripts/installer.nsh', import.meta.url), 'utf8');
  for (const hook of ['customInit', 'customInstall']) assert.equal(upstream.replaceAll('\r\n', '\n').split('!macro ' + hook + '\n').length, 2);
});

