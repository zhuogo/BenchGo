import { readFileSync, writeFileSync } from 'node:fs';
import { copyFile, access, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createElectronBuilderConfig } from '../../deepseek-harness/apps/desktop/scripts/electron-builder-config.mjs';
import { prepareDesktopBrand, prepareDesktopRenderer, startupArtwork } from './prepare-brand.mjs';
import { prepareWindowsInstaller } from './prepare-windows-installer.mjs';
import { verifyTrayBundle } from './prepare-tray.mjs';
import { verifyStartupBundle } from './prepare-startup.mjs';
import { verifyWorkbenchLoadingBundle } from './prepare-workbench-loading.mjs';
import { verifyBackgroundBundle } from './prepare-background.mjs';
import { verifyBrowserStorageBundle } from './prepare-browser-storage.mjs';
import { verifyUpdateBridgeBundle } from './prepare-update-bridge.mjs';
import { assertSidebarPayload, DESKTOP_ELECTRON_LANGUAGES, inspectPluginPayload } from './payload-policy.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const version = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url))).version;
// The official factory requires policy metadata. Updates use the application's own feed.
const config = createElectronBuilderConfig({
  ...process.env, DSH_DESKTOP_APP_ID: 'cn.draftgo.benchgo', DSH_DESKTOP_UNSIGNED: '1',
  DSH_DESKTOP_AUTO_UPDATE_ENV: 'production', DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN: 'https://localhost',
  DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: '{}', DSH_DESKTOP_TARGET_PLATFORM: 'win32', DSH_DESKTOP_TARGET_ARCH: 'x64',
});
delete config.extraMetadata.dshMandatoryUpdatePolicy;
config.extraMetadata.name = 'benchgo-desktop';
config.extraMetadata.version = version;
config.extraMetadata.dshDesktopUpdateChannel = 'stable';
config.extraMetadata.description = 'DeepSeek Harness with BenchGo, Voice and Link';
config.productName = 'BenchGo';
config.electronLanguages = [...DESKTOP_ELECTRON_LANGUAGES];
config.executableName = 'BenchGo';
config.protocols = [{ name: 'BenchGo', schemes: ['dsh'] }];
config.artifactName = `benchgo-${version}-win-x64-setup.exe`;
config.directories.output = `${root}/artifacts/windows`;
const brandOutput = `${root}/.local/desktop/brand`;
config.beforeBuild = async () => {
  await prepareWindowsInstaller(root, brandOutput);
  await prepareDesktopBrand(root, brandOutput);
  await prepareDesktopRenderer(root, `${brandOutput}/renderer`);
  return true;
};
config.win.icon = `${brandOutput}/benchgo-icon.png`;
config.nsis.installerIcon = config.nsis.uninstallerIcon = `${brandOutput}/benchgo.ico`;
config.nsis.installerSidebar = config.nsis.uninstallerSidebar = `${brandOutput}/uninstaller-sidebar.bmp`;
config.extraResources = config.extraResources.map(resource => resource.to === 'icon.png'
  ? { from: `${brandOutput}/benchgo-icon.png`, to: 'icon.png' }
  : resource.to === 'tray.ico' ? { from: `${brandOutput}/benchgo.ico`, to: 'tray.ico' } : resource);
// electron-builder drops file mappings whose source is outside the desktop app dir.
// Swap the compiled entry in only while app files are collected, then restore the official build.
if (!config.files.includes('lib/main.js')) throw new Error('Official desktop main file mapping changed; review tray packaging');
const desktopMain = `${root}/deepseek-harness/apps/desktop/lib/main.js`;
const stagedMain = `${root}/.local/desktop/main/main.js`;
const desktopPreload = `${root}/deepseek-harness/apps/desktop/lib/preload-app.cjs`;
const stagedPreload = `${root}/.local/desktop/main/preload-app.cjs`;
let officialMainBytes, officialPreloadBytes;
const officialBeforePack = config.beforePack;
config.beforePack = async context => {
  officialMainBytes = await readFile(desktopMain);
  officialPreloadBytes = await readFile(desktopPreload);
  try {
    await copyFile(stagedMain, desktopMain);
    await copyFile(stagedPreload, desktopPreload);
    await officialBeforePack?.(context);
  } catch (error) {
    await writeFile(desktopMain, officialMainBytes);
    await writeFile(desktopPreload, officialPreloadBytes);
    officialMainBytes = undefined;
    officialPreloadBytes = undefined;
    throw error;
  }
};
const officialAfterPack = config.afterPack;
const officialAfterAll = config.afterAllArtifactBuild;
config.afterAllArtifactBuild = async context => {
  try {
    return await officialAfterAll?.(context);
  } finally {
    if (officialMainBytes) await writeFile(desktopMain, officialMainBytes);
    if (officialPreloadBytes) await writeFile(desktopPreload, officialPreloadBytes);
    officialMainBytes = undefined;
    officialPreloadBytes = undefined;
  }
};
process.once('exit', () => {
  if (!officialMainBytes) return;
  writeFileSync(desktopMain, officialMainBytes);
  if (officialPreloadBytes) writeFileSync(desktopPreload, officialPreloadBytes);
});
config.files.push('!renderer/welcome.html',
  { from: `${brandOutput}/renderer`, to: 'renderer', filter: ['**/*'] });
// A physical runtime also lets installation initialize a profile entirely offline.
config.asarUnpack.push('**/dsh/**/*');
config.extraResources.push({ from: `${root}/scripts/desktop/plugin-bundle.mjs`, to: 'benchgo/plugin-bundle.mjs' });
config.extraResources.push({ from: `${root}/scripts/desktop/workbench-desktop.mjs`, to: 'benchgo/workbench-desktop.mjs' });
config.extraResources.push({ from: `${root}/scripts/desktop/payload-policy.mjs`, to: 'benchgo/payload-policy.mjs' });
config.extraResources.push({ from: `${root}/scripts/desktop/install-cleanup.mjs`, to: 'benchgo/install-cleanup.mjs' });
config.extraResources.push({ from: `${root}/plugins/base/shared/plugin-install.mjs`, to: 'benchgo/shared/plugin-install.mjs' });
config.extraResources.push({ from: `${root}/plugins/base/shared/update-feed.mjs`, to: 'benchgo/shared/update-feed.mjs' });
config.extraResources.push({ from: `${root}/plugins/base/shared/workbench-installation.mjs`, to: 'benchgo/shared/workbench-installation.mjs' });
const pluginSeed = `${root}/deepseek-harness/apps/desktop/.desktop-build/targets/win-x64/plus-seed`;
config.extraResources.push({ from: pluginSeed, to: 'benchgo/seed', filter: ['**/*'] });
// Like the official runtime mapping, the seed needs an explicit node_modules
// source: electron-builder excludes a source directory's root node_modules.
config.extraResources.push({ from: `${pluginSeed}/node_modules`, to: 'benchgo/seed/node_modules', filter: ['**/*'] });

/** Check the published entry contract instead of retaining pre-split source paths. */
export async function verifyPackagedPluginSeed(seed) {
  await access(join(seed, 'release.json'));
  const plugin = join(seed, 'node_modules', 'benchgo-plugin');
  const manifest = JSON.parse(await readFile(join(plugin, 'package.json'), 'utf8'));
  const files = new Set(['lib/client.js', 'lib/link.mjs', 'lib/link-web/index.html', 'cordis.patch.yml']);
  for (const key of ['.', './harness-plugin', './superagent-plugin', './voice-plugin', './link-plugin', './runtime']) {
    const entry = manifest.exports?.[key];
    if (typeof entry !== 'string' || !entry.endsWith('.mjs')) throw new Error(`Packaged BenchGo export is missing: ${key}`);
    files.add(entry);
  }
  for (const file of files) {
    const target = resolve(plugin, file), child = relative(plugin, target);
    if (isAbsolute(child) || child === '..' || child.startsWith(`..${sep}`)) throw new Error(`Packaged BenchGo entry escapes package: ${file}`);
    await access(target);
  }
}

/** Startup and offline installation must ship the same reviewed enrollment code. */
export async function verifyPackagedEnrollment(resources) {
  for (const [source, target] of [
    ['scripts/desktop/plugin-bundle.mjs', 'benchgo/plugin-bundle.mjs'],
    ['scripts/desktop/workbench-desktop.mjs', 'benchgo/workbench-desktop.mjs'],
    ['scripts/desktop/payload-policy.mjs', 'benchgo/payload-policy.mjs'],
    ['scripts/desktop/install-cleanup.mjs', 'benchgo/install-cleanup.mjs'],
    ['plugins/base/shared/plugin-install.mjs', 'benchgo/shared/plugin-install.mjs'],
    ['plugins/base/shared/update-feed.mjs', 'benchgo/shared/update-feed.mjs'],
    ['plugins/base/shared/workbench-installation.mjs', 'benchgo/shared/workbench-installation.mjs'],
  ]) {
    const expected = await readFile(join(root, source));
    const actual = await readFile(join(resources, target));
    if (!actual.equals(expected)) throw new Error(`Packaged BenchGo enrollment differs from source: ${target}`);
  }
}

config.afterPack = async context => {
  await officialAfterPack?.(context);
  const require = createRequire(new URL('../../deepseek-harness/apps/desktop/package.json', import.meta.url));
  const { extractFile } = createRequire(require.resolve('app-builder-lib'))('@electron/asar');
  const archive = `${context.appOutDir}/resources/app.asar`;
  const main = extractFile(archive, 'lib/main.js').toString('utf8');
  const preload = extractFile(archive, 'lib/preload-app.cjs').toString('utf8');
  verifyTrayBundle(main);
  verifyStartupBundle(main);
  verifyWorkbenchLoadingBundle(main);
  verifyBackgroundBundle(main);
  verifyUpdateBridgeBundle(main);
  verifyUpdateBridgeBundle(preload, true);
  verifyBrowserStorageBundle(main, preload);
  const startupIcon = startupArtwork(await readFile(`${root}/assets/brand/benchgo-mark.svg`, 'utf8'));
  for (const name of ['welcome.html', 'splash.html']) {
    if (!extractFile(`${context.appOutDir}/resources/app.asar`, `renderer/${name}`).toString('utf8').includes(startupIcon)) {
      throw new Error(`Packaged BenchGo startup artwork does not match the brand master: ${name}`);
    }
  }
  await verifyPackagedPluginSeed(`${context.appOutDir}/resources/benchgo/seed`);
  assertSidebarPayload(`${context.appOutDir}/resources/benchgo/seed/node_modules/benchgo-plugin`);
  inspectPluginPayload(`${context.appOutDir}/resources/benchgo/seed`);
  await verifyPackagedEnrollment(`${context.appOutDir}/resources`);
};
config.publish = [{ provider: 'generic', url: 'https://ghfast.top/https://github.com/zhuogo/BenchGo/releases/download/app-updates/', channel: 'latest' }];
config.nsis.shortcutName = 'BenchGo';
config.nsis.uninstallDisplayName = 'BenchGo ${version}';
config.nsis.include = `${root}/.local/desktop/installer-plus.nsh`;
export default config;
