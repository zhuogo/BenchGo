import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
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
const options = async () => ({ bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', target: 'es2022', minify: true,
  nodePaths: [join(root, 'plugins/link/node_modules'), join(root, 'plugins/benchgo/node_modules')],
  alias: { react: fileURLToPath(new URL('../node_modules/react', import.meta.url)), 'react-dom': fileURLToPath(new URL('../node_modules/react-dom', import.meta.url)), ...await officialUiEntries() },
  plugins: [sharedUiStyles()], loader: { '.css': 'text', '.svg': 'text', '.json': 'json', ...officialUiLoaders },
  logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"' } });

test('standalone Link bundles the original public official UI root and matching module styles without engine builds', async () => {
  const result = await build({ ...await options(), entryPoints: [join(root, 'plugins/link/client/main.jsx')], outfile: join(root, 'artifacts/link-build-check/app.js'), metafile: true });
  assert(result.outputFiles.some(file => file.path.endsWith('.js')));
  assert(result.outputFiles.some(file => file.path.endsWith('.css') && file.text.includes('tooltip')));
  assert(Object.keys(result.metafile.inputs).some(path => path.replaceAll('\\', '/').endsWith('ui-primitives/src/index.ts')));
  assert(Object.keys(result.metafile.inputs).some(path => path.replaceAll('\\', '/').endsWith('ui-primitives/src/Tooltip.tsx')));
});

test('Link device directory renders shared loading, error, empty and data with official name tooltips at desktop and mobile widths', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const result = await build({ ...await options(), outfile: join(root, 'artifacts/link-feedback-fixture/app.js'), stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React from 'react';import {createRoot} from 'react-dom/client';import {DeviceCenter} from './plugins/link/client/device-center.jsx';
    const root=createRoot(document.getElementById('root'));let serial=0;
    window.renderScenario=(mode)=>{const runtime={isNative:()=>false,bootstrap:()=>null,clientName:()=> '本机',async call(action){
      if(action!=='list')throw Error('此视觉夹具禁止业务操作');
      if(mode==='loading')return new Promise(()=>{});if(mode==='error')throw Error('设备目录暂时无法读取');
      return {devices:mode==='empty'?[]:[{id:'desk',name:'设计工作台',kind:'computer',status:'offline',lastError:'设备尚未连接'}],capabilities:{hostAdmin:false,ssh:false}};
    }};root.render(<DeviceCenter key={++serial} runtime={runtime}/>);};
  ` } });
  const script = result.outputFiles.find(file => file.path.endsWith('.js')).text;
  const css = result.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n');
  const browser = await chromium.launch({ headless: true, executablePath });
  const screenshotDir = process.env.BENCHGO_LINK_FEEDBACK_SCREENSHOTS;
  if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
  try {
    const page = await browser.newPage(), errors = []; page.setDefaultTimeout(6000); page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.request().url() === 'http://localhost/' ? route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font-family:Arial,sans-serif;background:#fafafa;color:#202124}${css}</style></head><body><div id="root"></div><script>${script.replaceAll('</script', '<\\/script')}</script></body></html>` }) : route.abort());
    await page.goto('http://localhost/');
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 850 });
      for (const mode of ['loading', 'error', 'empty', 'data']) {
        await page.evaluate(mode => window.renderScenario(mode), mode);
        if (mode === 'loading') {
          await page.getByRole('status', { name: '正在读取设备…' }).waitFor();
          assert.equal(await page.locator('.dc-loading-preview,.dc-loading-mark').count(), 0);
        } else if (mode === 'error') await page.getByRole('alert').getByText('设备目录暂时无法读取', { exact: true }).waitFor();
        else if (mode === 'empty') await page.getByText('尚未添加设备', { exact: true }).waitFor();
        else {
          await page.getByText('设计工作台', { exact: true }).waitFor();
          const name = page.locator('.dc-device-copy strong'); assert.equal(await name.getAttribute('title'), null);
          await name.hover(); await page.getByRole('tooltip').getByText('设计工作台', { exact: true }).waitFor();
          await page.mouse.move(0, 0);
          await page.getByRole('button', { name: '设计工作台设置', exact: true }).click();
          await page.getByRole('button', { name: '编辑备注名称', exact: true }).click();
          await page.getByRole('button', { name: '取消修改名称', exact: true }).click();
          assert.equal(await page.locator('.dc-name-form').count(), 0, 'tooltip wrapping preserves cancel handlers');
          await page.keyboard.press('Escape');
        }
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), mode + '/' + width + ' overflow');
        if (screenshotDir) await page.screenshot({ path: join(screenshotDir, mode + '-' + width + '.png'), fullPage: true });
      }
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
