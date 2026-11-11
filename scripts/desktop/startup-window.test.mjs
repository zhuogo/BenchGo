import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openStartupWindow, createStartupTiming } from './startup-window.mjs';
import { startupWindowPlugin, verifyStartupBundle } from './prepare-startup.mjs';

function fixture(fail = false) {
  const app = new EventEmitter();
  app.quit = () => { app.quits = (app.quits ?? 0) + 1; };
  const nativeTheme = new EventEmitter();
  nativeTheme.shouldUseDarkColors = false;
  const windows = [];
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super(); this.options = options; windows.push(this);
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = handler => { this.openHandler = handler; };
      this.scripts = [];
      this.webContents.executeJavaScript = async script => { this.scripts.push(script); };
      app.emit('browser-window-created', {}, this);
    }
    setBackgroundColor(value) { this.background = value; }
    async loadFile(page) { this.page = page; if (fail) throw new Error('missing page'); }
    isDestroyed() { return Boolean(this.destroyed); }
    isVisible() { return Boolean(this.visible); }
    show() { this.visible = true; this.emit('show'); }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const nativeImage = { createFromPath: path => ({ path, isEmpty: () => !path }) };
  return { app, BrowserWindow, nativeImage, nativeTheme, windows, page: '/renderer/splash.html', iconPath: 'icon.png' };
}

test('splash covers hidden backend startup and disposes only when another window appears', async () => {
  const env = fixture();
  const close = await openStartupWindow(env);
  const splash = env.windows[0];
  const main = new env.BrowserWindow({ show: false });
  assert.equal(splash.isVisible(), true);
  assert.equal(splash.isDestroyed(), false);
  assert.equal(splash.options.icon.path, 'icon.png');
  assert.equal(splash.options.backgroundColor, '#ffffff');
  env.nativeTheme.shouldUseDarkColors = true; env.nativeTheme.emit('updated');
  assert.equal(splash.background, '#19191b');
  env.nativeTheme.shouldUseDarkColors = false; env.nativeTheme.emit('updated');
  assert.equal(splash.background, '#ffffff');
  assert.equal(splash.options.webPreferences.sandbox, true);
  assert.equal(splash.options.webPreferences.preload, undefined);
  assert.deepEqual(splash.openHandler(), { action: 'deny' });
  close.setStage('host-starting');
  assert.match(splash.scripts.at(-1), /正在启动服务/);
  const sent = splash.scripts.length;
  close.setStage('arbitrary config content');
  assert.equal(splash.scripts.length, sent);
  main.show();
  assert.equal(splash.isDestroyed(), true);
  assert.equal(env.app.quits, undefined);
  assert.equal(env.app.listenerCount('browser-window-created'), 0);
  assert.equal(env.nativeTheme.listenerCount('updated'), 0);
  assert.equal(main.listenerCount('closed'), 0);
  close();
  close.setStage('host-ready');
  assert.equal(splash.scripts.length, sent);
});

test('fatal cleanup and quit dispose the card without an extra quit request', async () => {
  for (const action of ['fatal', 'quit']) {
    const env = fixture();
    env.nativeTheme.shouldUseDarkColors = true;
    const close = await openStartupWindow(env);
    assert.equal(env.windows[0].options.backgroundColor, '#19191b');
    if (action === 'fatal') close(); else env.app.emit('will-quit');
    assert.equal(env.windows[0].isDestroyed(), true);
    assert.equal(env.app.quits, undefined);
    assert.equal(env.app.listenerCount('will-quit'), 0);
    assert.equal(env.nativeTheme.listenerCount('updated'), 0);
  }
});

test('a user close quits; an unavailable splash still allows official startup', async () => {
  const env = fixture();
  await openStartupWindow(env);
  env.windows[0].destroy();
  assert.equal(env.app.quits, 1);
  const failed = fixture(true);
  await openStartupWindow(failed);
  assert.equal(failed.windows[0].isDestroyed(), true);
  assert.equal(failed.app.quits, undefined);
  assert.equal(failed.nativeTheme.listenerCount('updated'), 0);
});

test('compile integration targets one official entry and rejects changed lifecycle anchors', async () => {
  const path = new URL('../../deepseek-harness/apps/desktop/lib/types/main.js', import.meta.url);
  const source = await readFile(path, 'utf8');
  const plugin = startupWindowPlugin(path.pathname);
  plugin.buildStart();
  assert.equal(plugin.transform(source, '/other.js'), null);
  assert.throws(() => plugin.generateBundle(), /got 0/);
  const code = plugin.transform(source, path.pathname).code;
  assert.match(code, /openStartupWindow\(\{ app, BrowserWindow, nativeImage, nativeTheme,/);
  assert.ok(code.indexOf('closeBenchgoStartup = await') < code.indexOf('const desktopSettings ='));
  assert.match(code, /function reportFatal\(error, source\) \{\n    closeBenchgoStartup\?\.\(\);/);
  plugin.generateBundle();
  assert.throws(() => plugin.transform(source.replace('async function main()', 'async function changed()'), path.pathname), /Official startup changed/);
});

test('startup executes the packaged enrollment entry and propagates failures before Host startup', async t => {
  const root = await mkdtemp(join(tmpdir(), 'benchgo-enrollment-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = await readFile(new URL('../../deepseek-harness/apps/desktop/lib/types/main.js', import.meta.url), 'utf8');
  const plugin = startupWindowPlugin('/main.js');
  const code = plugin.transform(source, '/main.js').code;
  assert.doesNotMatch(code, /import \{ initializePluginProfile \} from/);
  const functionSource = code.slice(code.indexOf('async function ensureBenchgoPlugin'), code.indexOf('\nlet closeBenchgoStartup'));
  const run = new (Object.getPrototypeOf(async function () {}).constructor)('join', 'benchgoPathToFileURL', 'resourcesPath', 'console', `${functionSource}; return ensureBenchgoPlugin(resourcesPath);`);
  for (const [name, body] of [
    ['valid', 'export async function initializePluginProfile({ resources }) { return { resources, owner: "packaged-entry" }; }'],
    ['invalid', 'export async function initializePluginProfile() { throw new Error("registration failed"); }'],
  ]) {
    const resources = join(root, name);
    await mkdir(join(resources, 'benchgo'), { recursive: true });
    await writeFile(join(resources, 'benchgo/plugin-bundle.mjs'), body);
    if (name === 'valid') assert.deepEqual(await run(join, pathToFileURL, resources, console), { resources, owner: 'packaged-entry' });
    else {
      const errors = [];
      await assert.rejects(run(join, pathToFileURL, resources, { error: (...args) => errors.push(args) }), /registration failed/);
      assert.equal(errors.length, 1);
    }
  }
  verifyStartupBundle(code);
  assert.throws(() => verifyStartupBundle(`${code}\nfunction initializePluginProfile() {}`), /inlined enrollment/);
  assert.throws(() => verifyStartupBundle(code.replace('await import(enrollmentModule)', 'await oldEnrollment()')), /packaged enrollment/);
});

test('startup timing records bounded phases and total elapsed time without slowing the caller', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-startup-timing-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let milliseconds = 100;
  const timing = createStartupTiming(directory, { now: () => milliseconds, startedAt: '2026-11-10T13:00:00.000Z' });
  milliseconds = 125;
  timing.mark('host-starting');
  timing.mark('host-starting');
  timing.mark('private session text');
  milliseconds = 180;
  timing.mark('host-ready');
  milliseconds = 200;
  timing.finish();
  timing.mark('failed');
  await timing.flush();
  const saved = JSON.parse(await readFile(join(directory, 'benchgo-startup.json'), 'utf8'));
  assert.equal(saved.status, 'workspace-ready');
  assert.equal(saved.elapsedMs, 100);
  assert.deepEqual(saved.stages, [
    { stage: 'started', elapsedMs: 0, durationMs: 0 },
    { stage: 'host-starting', elapsedMs: 25, durationMs: 25 },
    { stage: 'host-ready', elapsedMs: 80, durationMs: 55 },
    { stage: 'workspace-ready', elapsedMs: 100, durationMs: 20 },
  ]);
  const failed = createStartupTiming(directory, { now: () => milliseconds });
  failed.finish('failed');
  await failed.flush();
  assert.equal(JSON.parse(await readFile(join(directory, 'benchgo-startup.json'), 'utf8')).status, 'failed');
  const unwritable = createStartupTiming(join(directory, 'benchgo-startup.json', 'invalid'));
  unwritable.finish();
  await unwritable.flush();
});
