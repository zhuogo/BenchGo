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

test('server resource preparation renders four states and preserves the installation path across themes and sizes', { skip: !executablePath, timeout: 90000 }, async () => {
  const built = await build({
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', target: 'es2022', minify: true,
    outfile: join(root, 'artifacts/install-unification-20261115/server-resources-ui/app.js'),
    nodePaths: [join(root, 'plugins/link/node_modules'), join(root, 'plugins/benchgo/node_modules')],
    alias: { react: fileURLToPath(new URL('../node_modules/react', import.meta.url)), 'react-dom': fileURLToPath(new URL('../node_modules/react-dom', import.meta.url)), ...await officialUiEntries() },
    plugins: [sharedUiStyles()], loader: { '.css': 'text', '.svg': 'text', '.json': 'json', ...officialUiLoaders },
    define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
    stdin: { resolveDir: root, loader: 'jsx', contents: `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {DeviceCenter} from './plugins/link/client/device-center.jsx';
      import {connectDeviceTheme} from './plugins/link/client/device-theme.mjs';
      import tokens from './deepseek-harness/packages/client/ui-theme/src/styles/design-platform.css';
      import base from './deepseek-harness/packages/client/ui-theme/src/styles/base.css';
      connectDeviceTheme();
      const root = createRoot(document.getElementById('root')); let serial = 0;
      window.calls = []; window.resourceMode = 'loading';
      const resourceJob = () => {
        const base = {id:'resources',kind:'server-prefetch',cancellable:false};
        if(window.resourceMode === 'error') return {...base,state:'failed',error:'部署资源下载失败，请检查网络后重试',steps:[{label:'下载部署资源',state:'failed',message:'连接中断'}]};
        if(window.resourceMode === 'data') return {...base,state:'completed',resources:{cached:true,version:'0.1.4',origin:'cache'},steps:[{label:'验证部署资源',state:'completed',message:'已验证本地缓存'}]};
        if(window.resourceMode === 'cancelled') return {...base,state:'cancelled',error:'部署资源获取已取消，可重新尝试',steps:[{label:'下载部署资源',state:'cancelled'}]};
        return {...base,state:'running',cancellable:true,steps:[{label:'下载部署资源',state:'running',message:'128 MB / 256 MB · 50%'}]};
      };
      window.renderScenario = mode => {
        window.resourceMode = mode; window.calls = [];
        const runtime = {bootstrap:()=>null,isNative:()=>false,clientName:()=> '本机',call:async(action,input)=>{
          window.calls.push({action,input});
          if(action==='list')return {devices:[{id:'local',name:'本机',kind:'local',status:'online'}],capabilities:{ssh:true,hostAdmin:false}};
          if(action==='serverPrefetch')return {jobId:'resources'};
          if(action==='jobCancel')return {ok:true};
          if(action==='sshProbe')return {fingerprint:'SHA256:verified'};
          if(action==='sshConnect')return {jobId:'install'};
          if(action==='job')return input.jobId==='install'?{id:'install',kind:'server',state:'running',cancellable:false,steps:[{label:'上传部署资源',state:'running',message:'远端安装已开始'}]}:resourceJob();
          throw Error('Unexpected action '+action);
        },hostCall:async()=>({})};
        root.render(<><style>{tokens}{base}</style><DeviceCenter key={++serial} runtime={runtime}/></>);
      };
    ` },
  });
  const script = built.outputFiles.find(file => file.path.endsWith('.js')).text;
  const css = built.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n');
  const screenshots = join(root, 'artifacts/install-unification-20261115/server-resources-ui');
  await mkdir(screenshots, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage(); page.setDefaultTimeout(5000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>' + css + 'body{margin:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}</style></head><body><div id="root"></div></body></html>' }));
    await page.goto('http://127.0.0.1/'); await page.addScriptTag({ content: script });
    const openServer = async mode => {
      await page.evaluate(mode => window.renderScenario(mode), mode);
      await page.getByRole('button', { name: '添加设备', exact: true }).click();
      await page.getByRole('button', { name: '安装到服务器', exact: true }).click();
      await page.getByRole('button', { name: '准备离线部署资源', exact: true }).waitFor();
    };
    for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 850 }); await page.emulateMedia({ colorScheme: theme });
      await page.waitForFunction(theme => document.documentElement.getAttribute('data-dsh-device-theme') === theme, theme);
      for (const mode of ['empty', 'loading', 'error', 'data']) {
        await openServer(mode);
        if (mode !== 'empty') {
          await page.getByLabel('名称（可选）', { exact: true }).fill('保留的服务器名称');
          await page.locator('.dc-field').filter({ hasText: '下载源' }).locator('button.dowork-select').click();
          await page.getByRole('option', { name: '官方直连', exact: true }).click();
          const prepare = page.getByRole('button', { name: '准备离线部署资源', exact: true });
          await prepare.focus(); await page.keyboard.press('Enter');
          if (mode === 'loading') {
            await page.getByText('128 MB / 256 MB · 50%', { exact: true }).waitFor();
            await page.getByRole('button', { name: '取消准备', exact: true }).waitFor();
          } else if (mode === 'error') {
            await page.getByRole('alert').filter({ hasText: '部署资源下载失败' }).waitFor();
            await page.getByRole('button', { name: '重试准备', exact: true }).waitFor();
          } else {
            await page.getByRole('status').filter({ hasText: '部署资源已准备好（0.1.4）' }).waitFor();
            assert.equal(await page.getByRole('button', { name: '打开工作台', exact: true }).count(), 0);
          }
          assert.deepEqual(await page.evaluate(() => window.calls.find(call => call.action === 'serverPrefetch').input), { source: 'github' });
          assert.equal(await page.evaluate(() => window.calls.some(call => ['sshProbe', 'sshConnect', 'select'].includes(call.action))), false);
        } else assert.equal(await page.getByRole('button', { name: '准备离线部署资源', exact: true }).isEnabled(), true);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.querySelector('.dc-sheet').scrollWidth <= document.querySelector('.dc-sheet').clientWidth), mode + '/' + width + '/' + theme + ' overflow');
        await page.screenshot({ path: join(screenshots, mode + '-' + width + '-' + theme + '.png'), fullPage: true });
        if (mode === 'data') {
          await page.getByRole('button', { name: '继续安装', exact: true }).click();
          assert.equal(await page.getByLabel('名称（可选）', { exact: true }).inputValue(), '保留的服务器名称');
          assert.equal(await page.locator('.dc-field').filter({ hasText: '下载源' }).locator('button.dowork-select').innerText(), '官方直连');
          assert.equal(await page.getByRole('dialog').count(), 1);
        } else if (mode === 'error') {
          await page.evaluate(() => { window.resourceMode = 'data'; });
          await page.getByRole('button', { name: '重试准备', exact: true }).click();
          await page.getByRole('button', { name: '继续安装', exact: true }).waitFor();
          assert.equal(await page.evaluate(() => window.calls.filter(call => call.action === 'serverPrefetch').length), 2);
        }
      }
    }
    await openServer('loading');
    await page.getByRole('button', { name: '准备离线部署资源', exact: true }).click();
    await page.getByText('128 MB / 256 MB · 50%', { exact: true }).waitFor();
    await page.getByRole('button', { name: '取消准备', exact: true }).click();
    assert.equal(await page.getByText('资源准备已取消，尚未开始远端安装。', { exact: true }).count(), 0, 'wait for the real terminal state');
    assert.deepEqual(await page.evaluate(() => window.calls.find(call => call.action === 'jobCancel').input), { jobId: 'resources' });
    await page.evaluate(() => { window.resourceMode = 'cancelled'; });
    await page.getByRole('status').filter({ hasText: '资源准备已取消' }).waitFor();
    assert.equal(await page.getByRole('alert').count(), 0);
    assert.equal(await page.getByRole('button', { name: '取消准备', exact: true }).count(), 0);
    await page.screenshot({ path: join(screenshots, 'cancelled-390-dark.png'), fullPage: true });
    await page.getByRole('button', { name: '返回安装', exact: true }).click();
    await page.getByLabel('服务器地址', { exact: true }).fill('server.example.com');
    await page.getByLabel('用户名', { exact: true }).fill('ubuntu');
    await page.getByRole('button', { name: '检查服务器', exact: true }).click();
    await page.getByRole('button', { name: '确认指纹并连接', exact: true }).click();
    await page.getByText('远端安装已开始', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '取消准备', exact: true }).count(), 0, 'upload/install cannot be cancelled as resource preparation');
    await page.screenshot({ path: join(screenshots, 'install-390-dark.png'), fullPage: true });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
