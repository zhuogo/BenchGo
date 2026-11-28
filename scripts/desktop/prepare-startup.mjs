import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Apply BenchGo's native presentation while preserving the official welcome lifecycle. */
export function welcomePresentationPlugin(welcomePath) {
  const target = resolve(welcomePath);
  const helper = fileURLToPath(new URL('./startup-window.mjs', import.meta.url));
  const anchor = 'const window = new BrowserWindow(options);';
  let transformed = 0;
  return {
    name: 'benchgo-welcome-presentation',
    buildStart() { transformed = 0; },
    transform(source, id) {
      if (resolve(id) !== target) return null;
      if (source.split(anchor).length !== 2) throw new Error('Official welcome window changed: expected one window constructor');
      transformed++;
      const code = source.replace(anchor,
        'const window = createWelcomeWindow({ BrowserWindow, nativeTheme, platform: process.platform, options });');
      return {
        code: `import { nativeTheme } from 'electron';\nimport { createWelcomeWindow } from ${JSON.stringify(helper)};\n${code}`,
        map: null,
      };
    },
    generateBundle() {
      if (transformed !== 1) throw new Error(`Official welcome window changed: expected one welcome entry, got ${transformed}`);
    },
  };
}

/** Compile startup presentation into the staged entry without modifying upstream files. */
export function startupWindowPlugin(mainPath) {
  const target = resolve(mainPath);
  const helper = fileURLToPath(new URL('./startup-window.mjs', import.meta.url));
  let transformed = 0;
  return {
    name: 'benchgo-startup-window',
    buildStart() { transformed = 0; },
    transform(source, id) {
      if (resolve(id) !== target) return null;
      let code = source.replaceAll('\r\n', '\n');
      for (const [before, after] of [
        ['async function main() {', "async function main() {\n    benchgoStartupTiming = createStartupTiming(app.getPath('logs'));\n    closeBenchgoStartup = await openStartupWindow({ app, BrowserWindow, nativeImage, page: join(app.getAppPath(), 'renderer', 'splash.html'), iconPath: join(process.resourcesPath, 'icon.png'), onVisible: () => benchgoStartupStage('splash-visible') });\n    benchgoStartupStage('enrollment-starting');\n    benchgoWorkbench = await ensureBenchgoPlugin(process.resourcesPath);\n    app.once('will-quit', () => { void benchgoWorkbench.dispose().catch(error => console.error('BenchGo workbench ownership cleanup failed', error)); });\n    benchgoStartupStage('enrollment-ready');"],
        ['function reportFatal(error, source) {', "function reportFatal(error, source) {\n    closeBenchgoStartup?.();\n    benchgoStartupTiming?.finish('failed');"],
        ['const ready = await host.start();\n                const cookie = ready.authenticationCookie;', "benchgoStartupStage('host-starting');\n                const ready = await host.start();\n                benchgoStartupStage('host-ready');\n                const cookie = ready.authenticationCookie;\n                await benchgoWorkbench.publishReady({ url: ready.url, inspect: () => host.inspectQuit() });"],
        ['welcomeBackend = connectDesktopWelcome(ready.url, cookie);', "welcomeBackend = connectDesktopWelcome(ready.url, cookie);\n                benchgoStartupStage('host-connected');"],
        ['analyticsEnabled = await welcomeBackend.analyticsEnabled().catch(() => false);', "analyticsEnabled = await welcomeBackend.analyticsEnabled().catch(() => false);\n                benchgoStartupStage('host-analytics-ready');"],
        ['await navigateMain(applicationUrl);\n            await backend.start(async () => {\n                await Promise.all([manager.applyRelease(), prepareHostEnvironment()]);\n            });', "benchgoStartupStage('shell-loading');\n            await Promise.all([\n                navigateMain(applicationUrl).then(() => { benchgoStartupStage('shell-loaded'); }),\n                backend.start(async () => {\n                    await Promise.all([manager.applyRelease(), prepareHostEnvironment()]);\n                }),\n            ]);"],
        ['const state = await readWelcomeState();', "const state = await readWelcomeState();\n        benchgoStartupStage('welcome-state-ready');"],
        ['enteredWorkspace = true;', "enteredWorkspace = true;\n        benchgoStartupStage('workspace-visible');\n        benchgoStartupTiming?.finish();"],
      ]) {
        if (code.split(before).length !== 2) throw new Error(`Official startup changed: expected one ${before.split('\n')[0]}`);
        code = code.replace(before, after);
      }
      transformed++;
      // Both app startup and the installer execute the packaged enrollment
      // entry. Never freeze another copy of that implementation into main.js.
      return { code: `import { openStartupWindow, createStartupTiming } from ${JSON.stringify(helper)};
import { pathToFileURL as benchgoPathToFileURL } from 'node:url';
async function ensureBenchgoPlugin(resourcesPath) {
  try {
    const enrollmentModule = benchgoPathToFileURL(join(resourcesPath, 'benchgo', 'plugin-bundle.mjs')).href;
    const ownershipModule = benchgoPathToFileURL(join(resourcesPath, 'benchgo', 'workbench-desktop.mjs')).href;
    const [{ initializePluginProfile }, { beginDesktopWorkbench }] = await Promise.all([import(enrollmentModule), import(ownershipModule)]);
    return await beginDesktopWorkbench({ resources: resourcesPath, initialize: initializePluginProfile });
  } catch (error) {
    console.error('BenchGo plugin enrollment failed', error);
    throw error;
  }
}
let closeBenchgoStartup;
let benchgoStartupTiming;
let benchgoWorkbench;
let benchgoCleanupScheduled = false;
function benchgoStartupStage(stage) {
  benchgoStartupTiming?.mark(stage);
  closeBenchgoStartup?.setStage(stage);
  if (process.platform !== 'win32' || stage !== 'workspace-visible' || benchgoCleanupScheduled) return;
  benchgoCleanupScheduled = true;
  // Show the new workspace before housekeeping; never delay launch or lower
  // the whole Desktop's priority. The helper removes files in small batches.
  const timer = setTimeout(() => {
    const cleanupModule = benchgoPathToFileURL(join(process.resourcesPath, 'benchgo', 'install-cleanup.mjs')).href;
    void import(cleanupModule)
      .then(({ cleanupRetiredInstalls }) => cleanupRetiredInstalls({ resources: process.resourcesPath }))
      .then(results => { for (const result of results) if (result.error) console.warn('BenchGo retired install cleanup deferred', result.error); })
      .catch(error => { console.warn('BenchGo retired install cleanup deferred', error); });
  }, 1500);
  timer.unref();
}
${code}`, map: null };
    },
    generateBundle() {
      if (transformed !== 1) throw new Error(`Official startup changed: expected one main entry, got ${transformed}`);
    },
  };
}

export function verifyStartupBundle(source) {
  const missing = [];
  if (!source.includes('splash.html')) missing.push('splash page');
  // Bundling rewrites join() and quotes, so match the surviving resource path pieces.
  if (!source.includes('resourcesPath') || !source.includes('icon.png')) missing.push('window icon');
  if (!/ensureBenchgoPlugin\(process\.resourcesPath\)/.test(source)) missing.push('plugin enrollment');
  // Rolldown may fold the URL variable into import(), without inlining the module.
  if (!/['"]benchgo['"],\s*['"]plugin-bundle\.mjs['"]/.test(source) || !/\[\s*\{\s*initializePluginProfile\s*\},\s*\{\s*beginDesktopWorkbench\s*\}\s*\]\s*=\s*await Promise\.all\(\[\s*import\(/.test(source)) missing.push('packaged enrollment entry');
  if (!source.includes('workbench-desktop.mjs') || !source.includes('beginDesktopWorkbench') || !source.includes('publishReady') || !source.includes('host.inspectQuit()')) missing.push('shared workbench ownership lifecycle');
  if (/function (?:initializePluginProfile|stagePluginBundle|attachOfficialPackages)\b/.test(source)) missing.push('inlined enrollment implementation');
  if (!/function reportFatal\(error, source\)\s*\{\s*closeBenchgoStartup\?\.\(\)/.test(source)) missing.push('fatal cleanup');
  for (const stage of ['enrollment-starting', 'host-starting', 'host-ready', 'host-connected', 'host-analytics-ready', 'welcome-state-ready', 'workspace-visible']) {
    if (!source.includes(stage)) missing.push(`startup timing ${stage}`);
  }
  if (!source.includes('install-cleanup.mjs') || !source.includes('cleanupRetiredInstalls')) missing.push('post-launch retired install cleanup');
  if (missing.length) throw new Error(`Compiled desktop is missing the startup window lifecycle: ${missing.join(', ')}`);
}
