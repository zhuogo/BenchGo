import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { startupWindowPlugin, verifyStartupBundle } from './prepare-startup.mjs';
import { workbenchLoadingPlugin, verifyWorkbenchLoadingBundle } from './prepare-workbench-loading.mjs';
import { backgroundExecutionPlugin, verifyBackgroundBundle } from './prepare-background.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

/** Compile only the tray's hover text and localized labels; changed upstream anchors stop packaging. */
export function prepareTrayInput(source) {
  let code = source.replaceAll('\r\n', '\n');
  const substitutions = [
    ['export class DesktopTray {', 'export class DesktopTray {'],
    ['const { messages } = this.options.locale();', 'const { id, messages } = this.options.locale();'],
    ['tray.setToolTip(messages.aboutProduct);', "tray.setToolTip('BenchGo');"],
    ['{ label: messages.openApplication, click: () => { this.options.open(); } }', "{ label: id === 'zh-CN' ? '主窗口' : 'Main Window', click: () => { this.options.open(); } }"],
    ['{ label: messages.quitApplication, click: () => { this.options.quit(); } }', "{ label: id === 'zh-CN' ? '退出' : 'Quit', click: () => { this.options.quit(); } }"],
  ];
  for (const [before, after] of substitutions) {
    if (code.split(before).length !== 2) throw new Error(`Official tray changed: expected one ${before}; review packaging labels`);
    code = code.replace(before, after);
  }
  return code;
}

/** Apply BenchGo's Windows application menu without modifying the official source tree. */
export function prepareApplicationMenuInput(source) {
  let code = source.replaceAll('\r\n', '\n');
  const about = "currentDesktopLocale().messages.aboutMenu";
  if (code.split(about).length !== 3) throw new Error('Official main changed: expected two application about labels');
  code = code.replaceAll(about, "currentDesktopLocale().id === 'zh-CN' ? '关于 BenchGo' : 'About BenchGo'");
  const aboutDialog = /title: locale\.messages\.aboutMenu, message: locale\.messages\.aboutProduct,\n\s+detail: formatDesktopMessage\(locale\.messages\.aboutVersion, \{ version: app\.getVersion\(\) \}\),/;
  const aboutDialogs = [...code.matchAll(new RegExp(aboutDialog.source, 'g'))];
  if (aboutDialogs.length !== 1) throw new Error('Official main changed: about dialog anchor missing');
  code = code.replace(aboutDialog, "title: locale.id === 'zh-CN' ? '关于 BenchGo' : 'About BenchGo', message: 'BenchGo',\n            detail: formatDesktopMessage(locale.messages.aboutVersion, { version: app.getVersion() }) + '\\nhttps://benchgo.cn',");
  if (code.split('{ label: currentDesktopLocale().messages.checkUpdatesMenu, click: () => { void openUpdatePrompt(true); } },').length !== 2) throw new Error('Official main changed: update menu anchor missing');
  code = code.replace('{ label: currentDesktopLocale().messages.checkUpdatesMenu, click: () => { void openUpdatePrompt(true); } },\n', '');
  const developmentRestart = /\n[ \t]+\{ label: currentDesktopLocale\(\)\.messages\.restartAppHostMenu, click: \(\) => \{\s+if \(quitting\)\s*return;?\s+app\.relaunch\(\);?\s+quitWithoutConfirmation\(\);?\s+\} \},(?=\s+\] : \[\],)/g;
  const developmentRestarts = code.match(developmentRestart) ?? [];
  if (developmentRestarts.length !== 1) throw new Error('Official main changed: development restart anchor missing');
  code = code.replace(developmentRestart, '');
  const quitAnchor = /\n(?<indent>[ \t]*)\{ type: 'separator' \},\n\k<indent>\.\.\.hideCommands,\n\k<indent>\{ role: 'quit'/;
  const quitMatches = [...code.matchAll(new RegExp(quitAnchor.source, 'g'))];
  if (quitMatches.length !== 1) throw new Error('Official main changed: quit menu anchor missing');
  const quitMatch = quitMatches[0];
  const indent = quitMatch.groups.indent;
  const inner = `${indent}    `;
  const restart = `${indent}{ label: currentDesktopLocale().id === 'zh-CN' ? '重启' : 'Restart', click: () => {\n${inner}if (quitting) return\n${inner}app.relaunch()\n${inner}quitWithoutConfirmation()\n${indent}} },\n`;
  code = code.replace(quitAnchor, `\n${restart}${indent}{ type: 'separator' },\n${indent}...hideCommands,\n${indent}{ role: 'quit'`);
  return code;
}

/** Limit compile-time substitutions to the official tray module, exactly once per main build. */
export function trayLabelsPlugin(trayPath) {
  const target = resolve(trayPath);
  let transformed = 0;
  return {
    name: 'benchgo-tray-labels',
    buildStart() { transformed = 0; },
    transform(source, id) {
      if (resolve(id) !== target) return null;
      transformed++;
      return { code: prepareTrayInput(source), map: null };
    },
    generateBundle() {
      if (transformed !== 1) throw new Error(`Official tray changed: expected one compiled tray module, got ${transformed}`);
    },
  };
}

export function applicationMenuPlugin(mainPath) {
  const target = resolve(mainPath);
  let transformed = 0;
  return {
    name: 'benchgo-application-menu',
    buildStart() { transformed = 0; },
    transform(source, id) {
      if (resolve(id) !== target) return null;
      transformed++;
      return { code: prepareApplicationMenuInput(source), map: null };
    },
    generateBundle() {
      if (transformed !== 1) throw new Error(`Official main changed: expected one compiled main module, got ${transformed}`);
    },
  };
}

/** Reject a staged or packed main bundle whose tray labels no longer match the reviewed menu. */
export function verifyTrayBundle(source) {
  const matches = [...source.matchAll(/[/][/]#region [^\n]*lib[/]types[/]tray\.js\n([\s\S]*?)[/][/]#endregion/g)];
  if (matches.length !== 1) throw new Error('Compiled desktop tray section changed; review packaging verification');
  const tray = matches[0][1];
  for (const label of ['label: id === "zh-CN" ? "主窗口" : "Main Window"', 'label: id === "zh-CN" ? "退出" : "Quit"', 'setToolTip("BenchGo")']) {
    if (tray.split(label).length !== 2) throw new Error('Compiled desktop tray is missing localized BenchGo labels');
  }
  if (tray.includes('label: messages.openApplication') || tray.includes('label: messages.quitApplication') || tray.includes('setToolTip(messages.aboutProduct)')) throw new Error('Compiled desktop tray still uses upstream menu labels');
}

/** Build the official main entry into a root-owned staging directory; no upstream files change. */
export async function prepareDesktopTray(repositoryRoot, output) {
  const engine = join(repositoryRoot, 'deepseek-harness');
  const desktop = join(engine, 'apps/desktop');
  const require = createRequire(join(engine, 'package.json'));
  const [{ build }, { default: configs }] = await Promise.all([
    import(pathToFileURL(require.resolve('tsdown')).href),
    import(pathToFileURL(join(desktop, 'tsdown.config.ts')).href),
  ]);
  const main = configs.filter(config => Array.isArray(config.entry) && config.entry.length === 1 && config.entry[0] === 'lib/types/main.js');
  if (main.length !== 1 || typeof main[0].onSuccess !== 'function') throw new Error('Official desktop main bundle configuration changed; review tray compilation');
  const { onSuccess: _rendererBuild, ...config } = main[0];
  // The official full build already prepared welcome assets and preloads. Reuse its
  // main-process settings and import checks without rebuilding unrelated renderers.
  await mkdir(output, { recursive: true });
  await build({
    ...config, config: false, cwd: desktop, entry: [join(desktop, 'lib/types/main.js')],
    outDir: output, clean: true, plugins: [...config.plugins, trayLabelsPlugin(join(desktop, 'lib/types/tray.js')), applicationMenuPlugin(join(desktop, 'lib/types/main.js')), startupWindowPlugin(join(desktop, 'lib/types/main.js')), backgroundExecutionPlugin(join(desktop, 'lib/types/main.js')), workbenchLoadingPlugin(join(desktop, 'lib/types/web-document.js'))],
  });
  const code = await readFile(join(output, 'main.js'), 'utf8');
  verifyTrayBundle(code);
  verifyStartupBundle(code);
  verifyWorkbenchLoadingBundle(code);
  verifyBackgroundBundle(code);
  return join(output, 'main.js');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareDesktopTray(root, join(root, '.local/desktop/main'));
}
