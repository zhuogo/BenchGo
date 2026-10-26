import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import config from './electron-builder.config.mjs';

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


test('BenchGo display naming preserves installed application identity and update channel', () => {
  assert.equal(config.productName, 'BenchGo');
  assert.equal(config.executableName, 'BenchGo');
  assert.equal(config.nsis.shortcutName, 'BenchGo');
  assert.equal(config.nsis.uninstallDisplayName, 'BenchGo ${version}');
  assert.equal(config.appId, 'cn.draftgo.benchgo');
  assert.equal(config.extraMetadata.name, 'benchgo-desktop');
  assert.equal(config.extraMetadata.dshDesktopUpdateChannel, 'latest');
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

