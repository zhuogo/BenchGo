import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
        ['async function main() {', "async function main() {\n    benchgoStartupTiming = createStartupTiming(app.getPath('logs'));\n    closeBenchgoStartup = await openStartupWindow({ app, BrowserWindow, nativeImage, nativeTheme, page: join(app.getAppPath(), 'renderer', 'splash.html'), iconPath: join(process.resourcesPath, 'icon.png') });\n    benchgoStartupStage('splash-visible');\n    await ensureBenchgoPlugin(process.resourcesPath);\n    benchgoStartupStage('enrollment-ready');"],
        ['function reportFatal(error, source) {', "function reportFatal(error, source) {\n    closeBenchgoStartup?.();\n    benchgoStartupTiming?.finish('failed');"],
        ['const ready = await host.start();', "benchgoStartupStage('host-starting');\n                const ready = await host.start();\n                benchgoStartupStage('host-ready');"],
        ['welcomeBackend = connectDesktopWelcome(ready.url, cookie);', "welcomeBackend = connectDesktopWelcome(ready.url, cookie);\n                benchgoStartupStage('host-connected');"],
        ['await navigateMain(applicationUrl);\n            await backend.start(async () => {', "benchgoStartupStage('shell-loading');\n            await navigateMain(applicationUrl);\n            benchgoStartupStage('shell-loaded');\n            await backend.start(async () => {"],
        ['const state = await readWelcomeState();', "const state = await readWelcomeState();\n        benchgoStartupStage('welcome-state-ready');"],
        ['enteredWorkspace = true;', "enteredWorkspace = true;\n        benchgoStartupStage('workspace-visible');\n        benchgoStartupTiming?.finish();"],
      ]) {
        if (code.split(before).length !== 2) throw new Error('Official startup changed; review startup window integration');
        code = code.replace(before, after);
      }
      transformed++;
      // Both app startup and the installer execute the packaged enrollment
      // entry. Never freeze another copy of that implementation into main.js.
      return { code: `import { openStartupWindow, createStartupTiming } from ${JSON.stringify(helper)};\nimport { pathToFileURL as benchgoPathToFileURL } from 'node:url';\nasync function ensureBenchgoPlugin(resourcesPath) {\n  try {\n    const enrollmentModule = benchgoPathToFileURL(join(resourcesPath, 'benchgo', 'plugin-bundle.mjs')).href;\n    const { initializePluginProfile } = await import(enrollmentModule);\n    return await initializePluginProfile({ resources: resourcesPath });\n  } catch (error) {\n    console.error('BenchGo plugin enrollment failed', error);\n    throw error;\n  }\n}\nlet closeBenchgoStartup;\nlet benchgoStartupTiming;\nfunction benchgoStartupStage(stage) { benchgoStartupTiming?.mark(stage); closeBenchgoStartup?.setStage(stage); }\n${code}`, map: null };
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
  if (!/['"]benchgo['"],\s*['"]plugin-bundle\.mjs['"]/.test(source) || !/\{\s*initializePluginProfile\s*\}\s*=\s*await import\(/.test(source)) missing.push('packaged enrollment entry');
  if (/function (?:initializePluginProfile|stagePluginBundle|attachOfficialPackages)\b/.test(source)) missing.push('inlined enrollment implementation');
  if (!/function reportFatal\(error, source\)\s*\{\s*closeBenchgoStartup\?\.\(\)/.test(source)) missing.push('fatal cleanup');
  for (const stage of ['host-starting', 'host-ready', 'host-connected', 'welcome-state-ready', 'workspace-visible']) {
    if (!source.includes(stage)) missing.push(`startup timing ${stage}`);
  }
  if (missing.length) throw new Error(`Compiled desktop is missing the startup window lifecycle: ${missing.join(', ')}`);
}
