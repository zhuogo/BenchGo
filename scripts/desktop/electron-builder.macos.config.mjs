/** macOS uses the same external plugin enrollment and brand masters as Windows. */
import { readFileSync, writeFileSync } from 'node:fs';
import { access, copyFile, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElectronBuilderConfig } from '../../deepseek-harness/apps/desktop/scripts/electron-builder-config.mjs';
import { prepareDesktopBrand, prepareDesktopRenderer, startupArtwork } from './prepare-brand.mjs';
import { verifyTrayBundle } from './prepare-tray.mjs';
import { verifyStartupBundle } from './prepare-startup.mjs';
import { verifyWorkbenchLoadingBundle } from './prepare-workbench-loading.mjs';
import { verifyBackgroundBundle } from './prepare-background.mjs';
import { verifyBrowserStorageBundle } from './prepare-browser-storage.mjs';
import { verifyUpdateBridgeBundle } from './prepare-update-bridge.mjs';
import { assertSidebarPayload, DESKTOP_ELECTRON_LANGUAGES, inspectPluginPayload } from './payload-policy.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

export function createMacOSConfig(arch = process.env.DSH_DESKTOP_TARGET_ARCH ?? process.arch) {
  if (!['arm64', 'x64'].includes(arch)) throw new Error('Unsupported BenchGo macOS architecture');
  const version = process.env.BENCHGO_MACOS_PACKAGE_VERSION ?? JSON.parse(readFileSync(join(root, 'package.json'))).version;
  const target = join(root, 'deepseek-harness/apps/desktop/.desktop-build/targets', `mac-${arch}`);
  const brand = join(root, '.local/desktop/brand');
  const config = createElectronBuilderConfig({ ...process.env, DSH_DESKTOP_APP_ID: 'cn.draftgo.benchgo',
    DSH_DESKTOP_UNSIGNED: '1', DSH_DESKTOP_MACOS_SKIP_NOTARIZATION: '0', DSH_DESKTOP_TARGET_PLATFORM: 'darwin', DSH_DESKTOP_TARGET_ARCH: arch });
  delete config.extraMetadata.dshMandatoryUpdatePolicy;
  Object.assign(config.extraMetadata, { name: 'benchgo-desktop', version, dshDesktopUpdateChannel: 'stable',
    description: 'BenchGo desktop with the official DeepSeek Harness runtime' });
  Object.assign(config, { productName: 'BenchGo', executableName: 'BenchGo',
    artifactName: `benchgo-${version}-mac-${arch}.\${ext}`, publish: null,
    protocols: [{ name: 'BenchGo', schemes: ['dsh'] }] });
  config.directories.output = join(root, `artifacts/macos-${arch}`);
  config.electronLanguages = [...DESKTOP_ELECTRON_LANGUAGES];
  config.mac.icon = join(brand, 'benchgo-icon.png');
  config.mac.target = ['dmg', 'zip'];
  config.mac.extendInfo.NSMicrophoneUsageDescription = 'BenchGo uses your microphone for voice conversations and transcription.';
  config.dmg.format = 'UDZO';
  config.dmg.sign = false;
  const beforeBuild = config.beforeBuild;
  config.beforeBuild = async (...args) => {
    const result = await beforeBuild(...args);
    await prepareDesktopBrand(root, brand);
    await prepareDesktopRenderer(root, join(brand, 'renderer'));
    return result;
  };
  config.extraResources = config.extraResources.map(item => item.to === 'icon.png'
    ? { from: join(brand, 'benchgo-icon.png'), to: 'icon.png' } : item);
  config.files.push('!renderer/welcome.html', { from: join(brand, 'renderer'), to: 'renderer', filter: ['**/*'] });
  config.asarUnpack.push('**/dsh/**/*');
  const enrollment = [
    ['scripts/desktop/plugin-bundle.mjs', 'benchgo/plugin-bundle.mjs'],
    ['scripts/desktop/workbench-desktop.mjs', 'benchgo/workbench-desktop.mjs'],
    ['scripts/desktop/payload-policy.mjs', 'benchgo/payload-policy.mjs'],
    ['plugins/base/shared/plugin-install.mjs', 'benchgo/shared/plugin-install.mjs'],
    ['plugins/base/shared/update-feed.mjs', 'benchgo/shared/update-feed.mjs'],
    ['plugins/base/shared/workbench-installation.mjs', 'benchgo/shared/workbench-installation.mjs'],
  ];
  for (const [source, destination] of enrollment) config.extraResources.push({ from: join(root, source), to: destination });
  config.extraResources.push({ from: join(root, 'LICENSE'), to: 'benchgo/LICENSE' },
    { from: join(target, 'plus-seed'), to: 'benchgo/seed', filter: ['**/*'] },
    { from: join(target, 'plus-seed/node_modules'), to: 'benchgo/seed/node_modules', filter: ['**/*'] });

  // Overlay generated main/preload bundles and restore their exact bytes on
  // success, failure and process exit. No upstream source changes.
  const main = join(root, 'deepseek-harness/apps/desktop/lib/main.js');
  const preload = join(root, 'deepseek-harness/apps/desktop/lib/preload-app.cjs');
  let originalMain, originalPreload;
  const restore = async () => {
    if (originalMain) await writeFile(main, originalMain);
    if (originalPreload) await writeFile(preload, originalPreload);
    originalMain = undefined;
    originalPreload = undefined;
  };
  const beforePack = config.beforePack;
  config.beforePack = async context => {
    originalMain = await readFile(main);
    originalPreload = await readFile(preload);
    try {
      await copyFile(join(root, '.local/desktop/main/main.js'), main);
      await copyFile(join(root, '.local/desktop/main/preload-app.cjs'), preload);
      await beforePack?.(context);
    } catch (error) { await restore(); throw error; }
  };
  const afterPack = config.afterPack;
  config.afterPack = async context => {
    try {
      await afterPack?.(context);
      const resources = context.packager.getResourcesDir(context.appOutDir);
      await verifyMacOSPackage(resources, enrollment);
    } finally { await restore(); }
  };
  process.once('exit', () => { if (originalMain) writeFileSync(main, originalMain); if (originalPreload) writeFileSync(preload, originalPreload); });
  return config;
}

export async function verifyMacOSPackage(resources, enrollment) {
  const require = createRequire(new URL('../../deepseek-harness/apps/desktop/package.json', import.meta.url));
  const { extractFile } = createRequire(require.resolve('app-builder-lib'))('@electron/asar');
  const bundle = extractFile(join(resources, 'app.asar'), 'lib/main.js').toString('utf8');
  const preload = extractFile(join(resources, 'app.asar'), 'lib/preload-app.cjs').toString('utf8');
  for (const verify of [verifyTrayBundle, verifyStartupBundle, verifyWorkbenchLoadingBundle, verifyBackgroundBundle]) verify(bundle);
  verifyUpdateBridgeBundle(bundle);
  verifyUpdateBridgeBundle(preload, true);
  verifyBrowserStorageBundle(bundle, preload);
  const artwork = startupArtwork(await readFile(join(root, 'assets/brand/benchgo-mark.svg'), 'utf8'));
  for (const name of ['welcome.html', 'splash.html']) {
    if (!extractFile(join(resources, 'app.asar'), `renderer/${name}`).toString('utf8').includes(artwork)) throw new Error(`Packaged BenchGo startup artwork mismatch: ${name}`);
  }
  for (const [source, destination] of enrollment) {
    if (!(await readFile(join(root, source))).equals(await readFile(join(resources, destination)))) throw new Error(`Packaged enrollment differs: ${destination}`);
  }
  const seed = join(resources, 'benchgo/seed');
  await access(join(seed, 'release.json'));
  const plugin = join(seed, 'node_modules/benchgo-plugin');
  const manifest = JSON.parse(await readFile(join(plugin, 'package.json'), 'utf8'));
  const files = new Set(['lib/client.js', 'lib/link.mjs', 'lib/link-web/index.html', 'cordis.patch.yml']);
  for (const key of ['.', './harness-plugin', './superagent-plugin', './voice-plugin', './link-plugin', './runtime']) {
    const entry = manifest.exports?.[key];
    if (typeof entry !== 'string' || !entry.endsWith('.mjs')) throw new Error(`Packaged BenchGo export is missing: ${key}`);
    files.add(entry);
  }
  for (const file of files) {
    const path = resolve(plugin, file), child = relative(plugin, path);
    if (isAbsolute(child) || child === '..' || child.startsWith(`..${sep}`)) throw new Error(`Packaged entry escapes plugin: ${file}`);
    await access(path);
  }
  assertSidebarPayload(plugin);
  inspectPluginPayload(seed);
}

export default createMacOSConfig();
