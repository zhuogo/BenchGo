import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { prepareBackgroundInput, backgroundExecutionPlugin, verifyBackgroundBundle } from './prepare-background.mjs';

const mainPath = fileURLToPath(new URL('../../deepseek-harness/apps/desktop/lib/types/main.js', import.meta.url));

test('only the primary workspace disables hidden-window throttling, preserving window security', async () => {
  const source = await readFile(mainPath, 'utf8');
  const code = prepareBackgroundInput(source);
  const start = code.indexOf('function createWindow(');
  const constructor = code.slice(start, code.indexOf('window.webContents.setWindowOpenHandler', start));
  const createWindow = runInNewContext(constructor + '\nreturn window;\n}\ncreateWindow;', {
    BrowserWindow: class { constructor(options) { this.options = options; } },
    process: { platform: 'win32' }, nativeTheme: { shouldUseDarkColors: false },
    WINDOWS_TITLEBAR_HEIGHT: 40, chromeFallbackFill: () => '#ffffff',
  });
  for (const primary of [true, false]) {
    const { webPreferences } = createWindow('app-preload.cjs', false, primary).options;
    assert.equal(webPreferences.backgroundThrottling, !primary);
    assert.equal(webPreferences.preload, 'app-preload.cjs');
    assert.equal(webPreferences.nodeIntegration, false);
    assert.equal(webPreferences.contextIsolation, true);
    assert.equal(webPreferences.sandbox, true);
    assert.equal(webPreferences.webSecurity, true);
  }
  verifyBackgroundBundle(code);
  assert.equal(await readFile(mainPath, 'utf8'), source);
});

test('changed or duplicated upstream window anchors fail instead of widening the override', async () => {
  const source = await readFile(mainPath, 'utf8');
  assert.match(prepareBackgroundInput(source.replaceAll('\n', '\r\n')), /backgroundThrottling: !primary/);
  for (const invalid of [
    source.replace('webviewTag: primary,', 'webviewTag: true,'),
    source.replace('primary = false)', 'primary = true)'),
    source.replace('webviewTag: primary,', 'webviewTag: primary,\n backgroundThrottling: true,'),
    source + source,
  ]) assert.throws(() => prepareBackgroundInput(invalid), /Official main changed/);
  assert.throws(() => verifyBackgroundBundle(source), /missing.*background execution/);
  assert.throws(() => verifyBackgroundBundle('webviewTag: primary, backgroundThrottling: false,'), /missing/);
});

test('the main transform runs once and only for its exact staging input', async () => {
  const source = await readFile(mainPath, 'utf8');
  const plugin = backgroundExecutionPlugin(mainPath);
  plugin.buildStart();
  assert.equal(plugin.transform(source, mainPath + '.other'), null);
  assert.throws(() => plugin.generateBundle(), /got 0/);
  verifyBackgroundBundle(plugin.transform(source, mainPath).code);
  plugin.generateBundle();
  plugin.transform(source, mainPath);
  assert.throws(() => plugin.generateBundle(), /got 2/);
});
