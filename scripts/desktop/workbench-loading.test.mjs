import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { workbenchLoadingMarkup } from './workbench-loading.mjs';
import { workbenchLoadingPlugin, verifyWorkbenchLoadingBundle } from './prepare-workbench-loading.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(new URL('../../deepseek-harness/apps/web/package.json', import.meta.url));

test('workbench presentation is compiled into the document before boot and fails closed on upstream drift', async () => {
  const documentPath = fileURLToPath(new URL('../../deepseek-harness/apps/desktop/lib/types/web-document.js', import.meta.url));
  const source = await readFile(documentPath, 'utf8');
  const plugin = workbenchLoadingPlugin(documentPath);
  plugin.buildStart();
  assert.equal(plugin.transform(source, '/other.js'), null);
  assert.throws(() => plugin.generateBundle(), /got 0/);
  const result = plugin.transform(source, documentPath).code;
  verifyWorkbenchLoadingBundle(result);
  assert.match(result, /__DSH_BOOT_READY__ = Promise.withResolvers\(\)/);
  assert.match(result, /replace\('<head>', '<head>' \+ BOOT\)/);
  plugin.generateBundle();
  assert.throws(() => plugin.transform(source.replace('Promise.withResolvers()', 'newDeferred()'), documentPath), /Official web document changed/);
  assert.throws(() => verifyWorkbenchLoadingBundle(source), /missing workbench loading/);
});

test('real upstream boot page shows centered text from its first frame and retains failure/handoff', async t => {
  const { chromium } = require('playwright');
  const executablePath = [process.env.CHROMIUM_EXECUTABLE_PATH, chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(value => value && existsSync(value));
  if (!executablePath) return t.skip('Chromium/Edge is required');
  const { build } = require('esbuild');
  const built = await build({
    stdin: { contents: "import { BootPage } from './deepseek-harness/packages/client/web/src/boot-page.ts'; window.BootPage = BootPage;", resolveDir: root },
    bundle: true, write: false, outdir: 'out', format: 'iife', loader: { '.css': 'local-css' },
  });
  const upstreamCss = built.outputFiles.find(file => file.path.endsWith('.css')).text;
  const upstreamJs = built.outputFiles.find(file => file.path.endsWith('.js')).text;
  const loadingCss = await readFile(join(root, 'plugins/shared/client/ui/loading.css'), 'utf8');
  const markup = workbenchLoadingMarkup(loadingCss);
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 }, locale: 'zh-CN' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const screenshots = process.env.BENCHGO_STARTUP_SCREENSHOTS;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  const shot = async name => { if (screenshots) await page.screenshot({ path: join(screenshots, `workbench-${name}.png`) }); };
  await page.setContent(`<html><head><style>html,body,#root{margin:0;height:100%;font-family:system-ui}body{color-scheme:light dark}${upstreamCss}</style>${markup}</head><body><div id="root"></div><script>${upstreamJs}</script></body></html>`);
  assert.equal(await page.locator('[role=status]').count(), 0, 'empty mount is not given a persistent overlay');
  await shot('empty');
  await page.evaluate(() => { window.boot = new window.BootPage(document.getElementById('root')); });
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme });
    await page.evaluate(dark => document.body.toggleAttribute('data-ds-dark-theme', dark), theme === 'dark');
    await page.getByRole('status', { name: '正在加载…' }).waitFor();
    assert.equal(await page.getByText('HARNESS', { exact: true }).isVisible(), false);
    assert.equal(await page.getByText('Loading plugins…', { exact: true }).isVisible(), false);
    const box = await page.getByRole('status').boundingBox();
    assert(Math.abs(box.x + box.width / 2 - 500) < 1);
    assert(Math.abs(box.y + box.height / 2 - 350) < 1);
    assert.equal(await page.locator('.bg-loading-character').count(), 5);
    assert.equal(await page.locator('[data-dsh-boot-spinner]').evaluate(el => getComputedStyle(el).animationName), 'none');
    assert.equal(await page.locator('.bg-loading-character').first().evaluate(el => getComputedStyle(el).animationName), 'bg-loading-hit');
    await shot(theme);
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.evaluate(() => document.getAnimations().length), 0);
  await shot('reduced');
  await page.evaluate(() => window.boot.setState('fixture-plugin', 'failed'));
  await page.getByText('Failed to load plugins', { exact: true }).waitFor();
  assert.equal(await page.getByText('fixture-plugin', { exact: true }).isVisible(), true);
  assert.equal(await page.getByText('HARNESS', { exact: true }).isVisible(), false);
  assert.equal(await page.getByRole('status').count(), 0);
  await shot('error');
  await page.evaluate(() => window.boot.setState('fixture-plugin', 'active'));
  await page.getByRole('status', { name: '正在加载…' }).waitFor();
  await page.evaluate(() => {
    window.boot.dispose();
    document.getElementById('root').innerHTML = '<main><h1>工作台</h1><button>新会话</button></main>';
  });
  assert.equal(await page.getByRole('button', { name: '新会话' }).isVisible(), true);
  assert.equal(await page.locator('[data-dsh-boot]').count(), 0);
  assert.equal(await page.evaluate(() => document.getAnimations().length), 0);
  await shot('ready');
  assert.deepEqual(errors, []);
});
