import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { officialUiEntries, officialUiLoaders } from '../scripts/official-ui.mjs';
import { sharedUiStyles } from '../../benchgo/scripts/shared-ui.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(new URL('../package.json', import.meta.url));
const { build } = require('esbuild');
const { chromium } = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url))('playwright');
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || [chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
let assets;
async function productionAssets() {
  return assets ??= (async () => {
    const result = await build({ entryPoints: [join(root, 'plugins/link/client/main.jsx')], outfile: join(root, 'artifacts/link-pairing-check/app.js'),
      bundle: true, write: false, metafile: true, platform: 'browser', format: 'iife', jsx: 'automatic', target: 'es2022', minify: true,
      nodePaths: [join(root, 'plugins/link/node_modules'), join(root, 'plugins/benchgo/node_modules')],
      alias: { react: fileURLToPath(new URL('../node_modules/react', import.meta.url)), 'react-dom': fileURLToPath(new URL('../node_modules/react-dom', import.meta.url)), ...await officialUiEntries() },
      plugins: [sharedUiStyles()], loader: { '.css': 'text', '.svg': 'text', '.json': 'json', ...officialUiLoaders },
      logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"' } });
    const css = await readFile(new URL('../client/style.css', import.meta.url), 'utf8');
    return { script: result.outputFiles.find(file => file.path.endsWith('.js')).text,
      css: css + '\n' + result.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n'), inputs: Object.keys(result.metafile.inputs) };
  })();
}

test('the production Link entry bundles pairing and no retired mobile workspace modules', async () => {
  const { inputs } = await productionAssets();
  assert(inputs.some(path => path.endsWith('link/client/pairing.jsx')));
  assert(inputs.some(path => path.endsWith('link/client/pairing.css')));
  for (const name of ['mobile.jsx', 'mobile.css', 'mobile-navigation.jsx', 'mobile-state.mjs', 'interaction.jsx', 'preview.mjs']) {
    assert(!inputs.some(path => path.endsWith('link/client/' + name)), name + ' must stay out of production');
  }
  const preview = await readFile(new URL('../scripts/build-preview.mjs', import.meta.url), 'utf8');
  assert.match(preview, /location\.replace\("\/link\/" \+ location\.search \+ location\.hash\)/);
});

test('the real Link entry renders pairing states and hands approval to the shared workbench without legacy RPC', { skip: !executablePath && 'Chromium/Edge is required', timeout: 60_000 }, async () => {
  const { script, css } = await productionAssets();
  const browser = await chromium.launch({ headless: true, executablePath });
  const screenshotDir = process.env.BENCHGO_LINK_PAIRING_SCREENSHOTS;
  if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
  try {
    for (const width of [1440, 390]) for (const colorScheme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width, height: 850 }, colorScheme });
      const page = await context.newPage(), errors = [], calls = [];
      page.setDefaultTimeout(6000);
      page.on('pageerror', error => errors.push(error.message));
      let mode = 'empty', status = 'pending', releasePair, workbenchError = false, serial = 0;
      await context.route('https://desk.example.com/**', async route => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/link/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="light dark"><title>BenchGo</title><link id="dsh-link-style" rel="stylesheet" href="./app.css"></head><body style="margin:0"><div id="root"></div><script src="./app.js"></script></body></html>' });
        if (path === '/link/app.js') return route.fulfill({ contentType: 'text/javascript', body: script });
        if (path === '/link/app.css') return route.fulfill({ contentType: 'text/css', body: css });
        if (path === '/link/workbench/') return route.fulfill({ contentType: 'text/html', body: '<main data-shared-workbench>Shared official workbench</main>' });
        const body = route.request().postDataJSON(); calls.push({ path, body });
        if (path === '/link/api/pair') {
          if (mode === 'loading') await new Promise(resolve => { releasePair = resolve; });
          if (mode === 'error') return route.fulfill({ status: 503, json: { error: '网络连接失败，请检查连接后重试' } });
          return route.fulfill({ json: { requestId: 'pair-request', pollToken: 'private-poll', expiresAt: Date.now() + 60_000 } });
        }
        if (path === '/link/api/pair/status') return route.fulfill({ json: { status, ...(status === 'approved' ? { token: 'approved-token', deviceId: 'paired-device', hostName: '开发工作台' } : {}) } });
        if (path === '/link/api/workbench') return route.fulfill(workbenchError ? { status: 503, json: { error: '工作台暂时无法打开，请重试' } } : { json: { url: '/link/workbench/' } });
        return route.fulfill({ status: 500, json: { error: 'Unexpected request: ' + path } });
      });
      const open = async (next, code = '') => {
        mode = next; status = 'pending';
        await page.goto('https://desk.example.com/link/?scenario=' + (++serial) + (code ? '#code=' + code : ''));
        await page.getByRole('heading', { name: '连接你的电脑' }).waitFor();
      };
      const capture = async state => {
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), state + '/' + width + ' overflow');
        assert.equal(await page.locator('.link-mobile').getAttribute('data-theme'), colorScheme);
        if (screenshotDir) await page.screenshot({ path: join(screenshotDir, state + '-' + width + '-' + colorScheme + '.png'), fullPage: true });
      };
      await open('empty');
      await page.getByRole('button', { name: '连接工作台', exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: '连接工作台', exact: true }).isEnabled(), false);
      await capture('empty');

      await open('loading', 'SCAN.CODE');
      await page.getByRole('heading', { name: '正在发送连接请求…' }).waitFor();
      assert.equal(await page.getByLabel('这台设备的名称').isEnabled(), false);
      await capture('loading');
      mode = 'data'; releasePair();
      await page.getByRole('heading', { name: '请在电脑上允许连接' }).waitFor();
      assert.equal(await page.getByLabel('已识别配对码').inputValue(), 'SCAN.CODE');
      await capture('data');

      await page.evaluate(() => sessionStorage.clear());
      await open('error', 'ERROR.CODE');
      await page.getByRole('alert').getByText('网络连接失败，请检查连接后重试', { exact: true }).waitFor();
      await capture('error');
      mode = 'data';
      await page.getByRole('button', { name: '重试连接', exact: true }).click();
      await page.getByRole('heading', { name: '请在电脑上允许连接' }).waitFor();
      status = 'rejected';
      await page.getByText('电脑未允许这次连接', { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: '使用地址连接', exact: true }).isEnabled(), false);
      await page.evaluate(() => sessionStorage.clear());
      await open('data', 'NEW.CODE'); status = 'expired';
      await page.getByText('配对码已过期', { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: '使用地址连接', exact: true }).isEnabled(), false);
      await page.evaluate(() => sessionStorage.clear());
      await open('data', 'APPROVE.CODE');
      status = 'approved'; workbenchError = true;
      await page.locator('.link-workbench-loading [role="alert"]').getByText('工作台暂时无法打开，请重试', { exact: true }).waitFor();
      assert.equal(await page.locator('.link-mobile-shell,.link-composer,.link-session-list').count(), 0);
      workbenchError = false;
      await page.getByRole('button', { name: '重新打开工作台', exact: true }).click();
      await page.waitForURL('https://desk.example.com/link/workbench/');
      await page.locator('[data-shared-workbench]').waitFor();
      assert(calls.some(call => call.path === '/link/api/workbench' && call.body));
      assert.equal(calls.some(call => call.path === '/link/api/rpc' || ['state', 'history', 'send', 'create'].includes(call.body?.action)), false);
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally { await browser.close(); }
});
