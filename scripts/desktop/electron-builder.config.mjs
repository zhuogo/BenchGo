import { readFileSync, writeFileSync } from 'node:fs';
import { copyFile, access, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createElectronBuilderConfig } from '../../deepseek-harness/apps/desktop/scripts/electron-builder-config.mjs';
import { prepareDesktopBrand } from './prepare-brand.mjs';
import { verifyTrayBundle } from './prepare-tray.mjs';
import { verifyStartupBundle } from './prepare-startup.mjs';

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
config.extraMetadata.dshDesktopUpdateChannel = 'latest';
config.extraMetadata.description = 'DeepSeek Harness with BenchGo, Voice and Link';
config.productName = 'BenchGo';
config.executableName = 'BenchGo';
config.protocols = [{ name: 'BenchGo', schemes: ['dsh'] }];
config.artifactName = `benchgo-${version}-win-x64-setup.exe`;
config.directories.output = `${root}/artifacts/windows`;
const brandOutput = `${root}/.local/desktop/brand`;
const officialBeforeBuild = config.beforeBuild;
config.beforeBuild = async (...args) => {
  const result = await officialBeforeBuild(...args);
  await prepareDesktopBrand(root, brandOutput);
  await copyFile(`${root}/deepseek-harness/apps/desktop/.desktop-build/targets/win-x64/installer-ui/window-frame.dll`, `${brandOutput}/window-frame.dll`);
  return result;
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
let officialMainBytes;
const officialBeforePack = config.beforePack;
config.beforePack = async context => {
  officialMainBytes = await readFile(desktopMain);
  await copyFile(stagedMain, desktopMain);
  try {
    await officialBeforePack?.(context);
  } catch (error) {
    await writeFile(desktopMain, officialMainBytes);
    officialMainBytes = undefined;
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
    officialMainBytes = undefined;
  }
};
process.once('exit', () => {
  if (!officialMainBytes) return;
  writeFileSync(desktopMain, officialMainBytes);
});
config.files.push('!renderer/welcome.html',
  { from: `${root}/scripts/desktop/renderer`, to: 'renderer', filter: ['**/*'] });
// A physical runtime also lets installation initialize a profile entirely offline.
config.asarUnpack.push('**/dsh/**/*');
config.extraResources.push({ from: `${root}/scripts/desktop/plugin-bundle.mjs`, to: 'benchgo/plugin-bundle.mjs' });
config.extraResources.push({ from: `${root}/plugins/commander/shared/plugin-install.mjs`, to: 'benchgo/shared/plugin-install.mjs' });
config.extraResources.push({ from: `${root}/plugins/commander/shared/update-feed.mjs`, to: 'benchgo/shared/update-feed.mjs' });
const pluginSeed = `${root}/deepseek-harness/apps/desktop/.desktop-build/targets/win-x64/plus-seed`;
config.extraResources.push({ from: pluginSeed, to: 'benchgo/seed', filter: ['**/*'] });
// Like the official runtime mapping, the seed needs an explicit node_modules
// source: electron-builder excludes a source directory's root node_modules.
config.extraResources.push({ from: `${pluginSeed}/node_modules`, to: 'benchgo/seed/node_modules', filter: ['**/*'] });
config.afterPack = async context => {
  await officialAfterPack?.(context);
  const require = createRequire(new URL('../../deepseek-harness/apps/desktop/package.json', import.meta.url));
  const { extractFile } = createRequire(require.resolve('app-builder-lib'))('@electron/asar');
  verifyTrayBundle(extractFile(`${context.appOutDir}/resources/app.asar`, 'lib/main.js').toString('utf8'));
  verifyStartupBundle(extractFile(`${context.appOutDir}/resources/app.asar`, 'lib/main.js').toString('utf8'));
  extractFile(`${context.appOutDir}/resources/app.asar`, 'renderer/splash.html');
  const seed = `${context.appOutDir}/resources/benchgo/seed`;
  for (const file of ['release.json', 'node_modules/benchgo-plugin/package.json', 'node_modules/benchgo-plugin/src/plugin.mjs', 'node_modules/benchgo-plugin/lib/client.js', 'node_modules/benchgo-plugin/lib/link.mjs', 'node_modules/benchgo-plugin/lib/link-web/index.html', 'node_modules/benchgo-plugin/voice/src/plugin.mjs']) {
    await access(`${seed}/${file}`);
  }
};
config.publish = [{ provider: 'generic', url: 'https://ghfast.top/https://github.com/zhuogo/BenchGo/releases/download/app-updates/', channel: 'latest' }];
config.nsis.shortcutName = 'BenchGo';
config.nsis.uninstallDisplayName = 'BenchGo ${version}';
config.nsis.include = `${root}/.local/desktop/installer-plus.nsh`;
export default config;
