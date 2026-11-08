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
        ['async function main() {', "async function main() {\n    closeBenchgoStartup = await openStartupWindow({ app, BrowserWindow, nativeImage, page: join(app.getAppPath(), 'renderer', 'splash.html'), iconPath: join(process.resourcesPath, 'icon.png') });\n    await ensureBenchgoPlugin(process.resourcesPath);"],
        ['function reportFatal(error, source) {', 'function reportFatal(error, source) {\n    closeBenchgoStartup?.();'],
      ]) {
        if (code.split(before).length !== 2) throw new Error('Official startup changed; review startup window integration');
        code = code.replace(before, after);
      }
      transformed++;
      // Both app startup and the installer execute the packaged enrollment
      // entry. Never freeze another copy of that implementation into main.js.
      return { code: `import { openStartupWindow } from ${JSON.stringify(helper)};\nimport { pathToFileURL as benchgoPathToFileURL } from 'node:url';\nasync function ensureBenchgoPlugin(resourcesPath) {\n  try {\n    const enrollmentModule = benchgoPathToFileURL(join(resourcesPath, 'benchgo', 'plugin-bundle.mjs')).href;\n    const { initializePluginProfile } = await import(enrollmentModule);\n    return await initializePluginProfile({ resources: resourcesPath });\n  } catch (error) {\n    console.error('BenchGo plugin enrollment failed', error);\n    throw error;\n  }\n}\nlet closeBenchgoStartup;\n${code}`, map: null };
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
  if (missing.length) throw new Error(`Compiled desktop is missing the startup window lifecycle: ${missing.join(', ')}`);
}
