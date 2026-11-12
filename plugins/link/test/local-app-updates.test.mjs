import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { officialUiEntries, officialUiLoaders } from '../scripts/official-ui.mjs';
import { sharedUiStyles } from '../../benchgo/scripts/shared-ui.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(new URL('../package.json', import.meta.url));
const { build } = require('esbuild');
const { chromium } = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url))('playwright');
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || [chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);

test('APK update trust key is copied from the canonical source and the native bridge stays local', async () => {
  const app = join(root, 'plugins/link/mobile/android/app');
  const gradle = await readFile(join(app, 'build.gradle'), 'utf8');
  assert(gradle.includes("inputs.file(file('../../../../benchgo/shared/update-public-key.pem'))"));
  assert(gradle.includes("into new File(out, 'updates')"));
  assert.equal(resolve(app, '../../../../benchgo/shared/update-public-key.pem'), join(root, 'plugins/benchgo/shared/update-public-key.pem'));
  const native = await readFile(join(app, 'src/main/java/cn/draftgo/benchgo/link/MainActivity.kt'), 'utf8');
  assert(native.includes('webView.removeJavascriptInterface("LinkNative")'));
  assert(native.includes('"appUpdateCheck" -> appUpdates.check()'));
  assert(native.includes('appUpdates.close()'));
  const navigation = await readFile(join(app, 'src/main/java/cn/draftgo/benchgo/link/NativeDeviceNavigation.kt'), 'utf8');
  assert(!navigation.includes('appUpdate'));
  const updater = await readFile(join(app, 'src/main/java/cn/draftgo/benchgo/link/AppUpdates.kt'), 'utf8');
  assert(updater.indexOf('verifyAppUpdateSignature(bytes, signature, pem)') < updater.indexOf('val manifest = JSONObject'));
  assert(updater.includes('available = code > BuildConfig.VERSION_CODE'));
  assert(updater.includes('manifest.opt("schemaVersion") == 1'));
  assert(updater.includes('phase = "missing"'));
  assert(updater.includes('phase = "unpublished"'));
  assert(updater.includes('status == 404 && canonical == APP_UPDATE_MANIFEST'));
  assert(updater.includes('if (appUpdateChannelUnpublished(canonical, response.code)) throw Unpublished()'));
  assert(updater.includes('validAppUpdateVersion(parts[1].drop(1))'));
  assert(updater.includes('parts[2] == "benchgo-$version-android.apk"'));
  assert(updater.includes('TimeUnit.SECONDS.toNanos(20)'));
  assert(!updater.includes('PackageInstaller'));
});

test('local APK update UI renders four states and completes check, source-save and browser handoff', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const result = await build({ bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', target: 'es2022', minify: true,
    outfile: join(root, 'artifacts/android-updates-qa/app.js'), nodePaths: [join(root, 'plugins/link/node_modules'), join(root, 'plugins/benchgo/node_modules')],
    alias: { react: fileURLToPath(new URL('../node_modules/react', import.meta.url)), 'react-dom': fileURLToPath(new URL('../node_modules/react-dom', import.meta.url)), ...await officialUiEntries() },
    plugins: [sharedUiStyles()], loader: { '.css': 'text', '.svg': 'text', '.json': 'json', ...officialUiLoaders }, logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"' },
    stdin: { resolveDir: root, loader: 'jsx', contents: `
      import React from 'react';import {createRoot} from 'react-dom/client';
      import {LocalAppUpdates} from './plugins/link/client/local-app-updates.jsx';
      import {DeviceCenter} from './plugins/link/client/device-center.jsx';
      import css from './plugins/link/client/device-center.css';
      const style=document.createElement('style');style.textContent=css;document.head.append(style);
      const root=createRoot(document.getElementById('root'));let serial=0;
      window.renderScenario=(mode,native=true)=>{window.calls=[];let config={source:'mirror',mirrorUrl:'https://ghfast.top/'};
        const current={version:'0.1.0',versionCode:12};
        const idle=()=>({phase:'idle',current,config,available:false,notice:'尚未检查本机应用更新'});
        const checked=()=>mode==='missing'?{...idle(),phase:'missing',releaseVersion:'0.1.1',notice:'已验证发布签名，尚无手机更新信息'}
          :mode==='unpublished'?{...idle(),phase:'unpublished',notice:'更新通道尚未就绪'}
          :mode==='error'?{...idle(),phase:'error',notice:'更新清单签名校验失败'}
          :mode==='current'?{...idle(),phase:'current',android:{version:'0.0.9',versionCode:11},notice:'本机应用已是最新版本'}
          :{...idle(),phase:'available',available:true,releaseVersion:'0.1.1',android:{version:'0.1.1',versionCode:13,url:'https://github.com/zhuogo/BenchGo/releases/download/v0.1.1/benchgo-0.1.1-android.apk'},notice:'发现已验证签名的手机新版本'};
        const runtime={isNative:()=>native,bootstrap:()=>({capabilities:{devices:true,appUpdates:true}}),clientName:()=> '这部手机',async call(action,args){
          window.calls.push({action,args,selectedSource:config.source});
          if(action==='list')return{devices:[{id:'local',name:'这部手机',kind:'local',deviceType:'mobile',status:'online'}],capabilities:{ssh:false}};
          if(action==='appUpdateStatus')return mode==='loading'?new Promise(()=>{}):['idle','flow','entry'].includes(mode)?idle():checked();
          if(action==='appUpdateCheck'){await new Promise(resolve=>setTimeout(resolve,80));return checked();}
          if(action==='appUpdateConfigure'){config=args;return idle();}
          if(action==='appUpdateOpen')return{...checked(),opened:true};
          if(action==='select')return{device:{id:'local',kind:'local'}};
          return{};
        }};
        root.render(mode==='entry'?<DeviceCenter key={++serial} runtime={runtime}/>:<main className="dc-root"><section className="dc-sheet"><LocalAppUpdates key={++serial} runtime={runtime}/></section></main>);
      };
    ` } });
  const script = result.outputFiles.find(file => file.path.endsWith('.js')).text;
  const css = result.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n');
  const browser = await chromium.launch({ headless: true, executablePath });
  const screenshots = process.env.BENCHGO_ANDROID_UPDATE_SCREENSHOTS;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  try {
    const page = await browser.newPage(); page.setDefaultTimeout(8000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.request().url() === 'http://localhost/' ? route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font-family:Arial,sans-serif}${css}</style></head><body><div id="root"></div><script>${script.replaceAll('</script', '<\\/script')}</script></body></html>` }) : route.abort());
    await page.goto('http://localhost/');
    for (const width of [390, 960]) for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 850 });
      await page.evaluate(theme => document.documentElement.dataset.dshDeviceTheme = theme, theme);
      for (const mode of ['loading', 'missing', 'error', 'available']) {
        await page.evaluate(mode => window.renderScenario(mode), mode);
        if (mode === 'loading') await page.getByRole('status', { name: '正在读取本机版本…' }).waitFor();
        else if (mode === 'error') await page.getByRole('alert').getByText('更新清单签名校验失败').waitFor();
        else if (mode === 'missing') { await page.getByText('已验证发布签名，尚无手机更新信息', { exact: true }).waitFor(); assert.equal(await page.getByText('本机应用已是最新版本', { exact: true }).count(), 0); }
        else { await page.getByRole('button', { name: '立即更新', exact: true }).waitFor(); await page.getByText('统一发布 v0.1.1 · 已验证发布清单签名').waitFor(); }
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), mode + '/' + width + '/' + theme + ' overflow');
        if (screenshots) await page.screenshot({ path: join(screenshots, `${mode}-${width}-${theme}.png`), fullPage: true });
      }
    }
    await page.evaluate(() => window.renderScenario('unpublished'));
    await page.getByText('更新通道尚未就绪', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '立即更新', exact: true }).count(), 0);
    await page.evaluate(() => window.renderScenario('current'));
    await page.getByText('本机应用已是最新版本', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '立即更新', exact: true }).count(), 0);

    await page.evaluate(() => window.renderScenario('flow'));
    await page.getByRole('button', { name: '检查更新', exact: true }).click();
    await page.getByRole('button', { name: '立即更新', exact: true }).click();
    await page.getByText('已打开浏览器，请下载 APK 后按系统提示确认安装。').waitFor();
    assert.deepEqual(await page.evaluate(() => window.calls.map(item => item.action)), ['appUpdateStatus', 'appUpdateCheck', 'appUpdateOpen']);
    assert(await page.getByText('此处已验证发布清单签名，未在应用内校验下载文件。', { exact: false }).isVisible());
    await page.getByRole('button', { name: '更新来源', exact: true }).click();
    await page.getByRole('button', { name: '本机应用下载源', exact: true }).click(); await page.getByRole('option', { name: 'GitHub 直连', exact: true }).click();
    await page.getByRole('button', { name: '检查更新', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.calls.find(item => item.action === 'appUpdateConfigure').args.source), 'github');
    await page.getByRole('button', { name: '本机应用下载源', exact: true }).click(); await page.getByRole('option', { name: '自定义镜像', exact: true }).click();
    const mirror = page.getByRole('textbox', { name: 'HTTPS 镜像地址' });
    assert(await page.getByRole('button', { name: '检查更新', exact: true }).isDisabled(), 'unsaved source cannot silently use the previous download source');
    await mirror.fill('http://bad.example/'); await page.getByRole('button', { name: '保存来源', exact: true }).click();
    await page.getByRole('alert').getByText('请输入不含凭据、查询参数和片段的 HTTPS 镜像地址').waitFor();
    await mirror.fill('https://mirror.example/'); await page.getByRole('button', { name: '保存来源', exact: true }).click();
    await page.waitForFunction(() => window.calls.filter(item => item.action === 'appUpdateConfigure').length === 2);
    assert.deepEqual(await page.evaluate(() => window.calls.filter(item => item.action === 'appUpdateConfigure').at(-1).args), { source: 'custom', mirrorUrl: 'https://mirror.example/' });
    await page.getByRole('button', { name: '检查更新', exact: true }).click();
    await page.getByRole('button', { name: '立即更新', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.calls.filter(item => item.action === 'appUpdateCheck').at(-1).selectedSource), 'custom');

    await page.evaluate(() => window.renderScenario('entry', true));
    await page.getByRole('button', { name: '这部手机设置', exact: true }).click();
    await page.getByRole('region', { name: '本机应用更新', exact: true }).waitFor();
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await page.evaluate(() => window.renderScenario('entry', false));
    await page.getByRole('button', { name: '这部手机设置', exact: true }).click();
    await page.getByRole('dialog').waitFor();
    assert.equal(await page.getByRole('region', { name: '本机应用更新', exact: true }).count(), 0);
    assert.equal(await page.evaluate(() => window.calls.filter(item => item.action.startsWith('appUpdate')).length), 0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
