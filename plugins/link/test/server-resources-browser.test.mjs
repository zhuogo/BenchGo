import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { officialUiEntries, officialUiLoaders } from '../scripts/official-ui.mjs';
import { sharedUiStyles } from '../../base/scripts/shared-ui.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(new URL('../package.json', import.meta.url));
const { build } = require('esbuild');
const { chromium } = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url))('playwright');
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || [chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);

test('device center renders server preparation and relay pool states across themes and sizes', { skip: !executablePath, timeout: 90000 }, async () => {
  const built = await build({
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', target: 'es2022', minify: true,
    outfile: join(root, 'artifacts/server-install-20261118/app.js'),
    nodePaths: [join(root, 'plugins/link/node_modules'), join(root, 'plugins/base/node_modules')],
    alias: { react: fileURLToPath(new URL('../node_modules/react', import.meta.url)), 'react-dom': fileURLToPath(new URL('../node_modules/react-dom', import.meta.url)), ...await officialUiEntries() },
    plugins: [sharedUiStyles()], loader: { '.css': 'text', '.svg': 'text', '.json': 'json', ...officialUiLoaders },
    define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
    stdin: { resolveDir: root, loader: 'jsx', contents: `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {DeviceCenter} from './plugins/link/client/device-center.jsx';
      import {connectDeviceTheme} from './plugins/link/client/device-theme.mjs';
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
        window.relayMode = mode.slice(6);
        const relayScenario = mode.startsWith('relay-');
        const relayUrl = 'https://backup.example.com:24680';
        const nodes = [
          {id:'preferred',url:'https://preferred-relay.example.com:24680',enabled:true,connected:false,checkedAt:1795000000000,lastError:'网络超时'},
          {id:'backup',url:relayUrl,enabled:true,connected:true,checkedAt:1795000000000},
        ];
        const hostStatus = () => ({relay:{fingerprint:'relay-revision',preferredId:'preferred',nodes:window.relayMode==='data'?nodes:[]}});
        const remote = {id:'remote',name:'远端工作台',kind:'computer',status:'online',currentPath:'relay',currentRelayUrl:relayUrl};
        const runtime = {bootstrap:()=>null,isNative:()=>false,clientName:()=> '本机',call:async(action,input)=>{
          window.calls.push({action,input});
          if(action==='list')return {devices:[{id:'local',name:'本机',kind:'local',status:'online'},...(['relay-data','directory','managed'].includes(mode)?[{...remote,...(mode==='managed'?{sshManaged:true,sshStatus:'connected',status:'offline'}: {})}]:[])],activeId:mode==='relay-data'?'remote':'local',capabilities:{ssh:mode!=='phone',hostAdmin:relayScenario,relayDeploy:relayScenario,serverManagement:mode==='managed'}};
          if(action==='serverTerminal')return {id:'fixture-terminal',title:'ubuntu@host.test'};
          if(action==='serverTerminalRead')return {output:input.offset?'':'terminal fixture ready',offset:1,closed:false};
          if(action==='serverPairing')return {mode:'public',webUrl:'https://host.test/link/?code=fixture',uri:'benchgo://pair?code=fixture',expiresAt:Date.now()+60000};
          if(action==='serverPairingStatus')return {pending:window.calls.some(item=>item.action==='serverPairingDecide')?[]:[{id:'mobile',name:'手机'}]};
          if(['serverTerminalWrite','serverTerminalClose','serverPairingDecide'].includes(action))return {ok:true};
          if(action==='select' && mode==='directory')return {device:remote,url:'http://127.0.0.1:17872/directory-workbench/'};
          if(action==='serverPrefetch')return {jobId:'resources'};
          if(action==='jobCancel')return {ok:true};
          if(action==='sshProbe')return {fingerprint:'SHA256:verified'};
          if(action==='sshConnect')return {jobId:'install'};
          if(action==='job')return input.jobId==='install'?{id:'install',kind:'server',state:'running',cancellable:false,steps:[{label:'上传部署资源',state:'running',message:'远端安装已开始'}]}:resourceJob();
          throw Error('Unexpected action '+action);
        },hostCall:async(action,input)=>{
          window.calls.push({action,input});
          if(action==='hostStatus' && window.relayMode==='loading') return new Promise(()=>{});
          if(action==='hostStatus' && window.relayMode==='error') throw Error('读取连接超时');
          if(action==='relayTest') return {ok:true,message:'中继验证通过',latencyMs:23};
          return relayScenario?hostStatus():{};
        }};
        root.render(<DeviceCenter key={++serial} runtime={runtime}/>);
      };
    ` },
  });
  const script = built.outputFiles.find(file => file.path.endsWith('.js')).text;
  const baseCss = await readFile(new URL('../client/style.css', import.meta.url), 'utf8');
  const css = [baseCss, ...built.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text)].join('\n');
  const screenshots = process.env.BENCHGO_SERVER_INSTALL_SCREENSHOTS || join(root, 'artifacts/server-install-20261118');
  await mkdir(screenshots, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage({ reducedMotion: 'reduce' }); page.setDefaultTimeout(5000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>' + css + '</style></head><body style="margin:0"><div id="root"></div></body></html>' }));
    await page.goto('http://127.0.0.1/'); await page.addScriptTag({ content: script });
    await page.evaluate(() => window.renderScenario('managed'));
    await page.getByText('工作台 离线', { exact: true }).waitFor();
    await page.getByText('SSH 已连接', { exact: true }).waitFor();
    await page.getByRole('button', { name: '打开 远端工作台 的 SSH 终端' }).click();
    await page.getByText('ubuntu@host.test', { exact: true }).waitFor();
    await page.locator('.xterm-helper-textarea').press('a');
    await page.waitForFunction(() => window.calls.some(call => call.action === 'serverTerminalWrite' && call.input.data === 'a'));
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await page.waitForFunction(() => window.calls.some(call => call.action === 'serverTerminalClose' && call.input.id === 'fixture-terminal'));
    await page.getByRole('button', { name: '远端工作台设置' }).click();
    await page.getByRole('button', { name: '生成连接码', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: '允许', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.calls.find(call => call.action === 'serverPairingDecide').input), { deviceId: 'remote', id: 'mobile', decision: 'confirm' });
    await page.getByRole('button', { name: '关闭配对窗口' }).click();
    const openAddDevice = async mode => {
      await page.evaluate(mode => window.renderScenario(mode), mode);
      await page.getByRole('button', { name: '添加设备', exact: true }).click();
    };
    const openServer = async mode => {
      await openAddDevice(mode);
      await page.getByRole('tab', { name: '添加服务器', exact: true }).click();
      await page.getByRole('button', { name: '准备部署资源', exact: true }).waitFor();
    };
    for (const [width, theme] of [[1280, 'light'], [390, 'dark']]) {
      await page.setViewportSize({ width, height: 850 });
      await page.emulateMedia({ colorScheme: theme });
      await page.evaluate(() => window.renderScenario('directory'));
      const directory = page.getByRole('tabpanel', { name: '设备', exact: true });
      const remote = directory.getByRole('button', { name: /远端工作台.*可连接/ });
      await remote.click();
      const workbench = page.locator('.dc-workbenches iframe');
      await workbench.waitFor();
      const entry = await workbench.getAttribute('src');
      await page.getByRole('button', { name: '返回设备中心' }).click();
      await directory.getByText('本机工作台', { exact: true }).waitFor();
      assert(await remote.isVisible());
      assert(await directory.getByRole('button', { name: '远端工作台设置' }).isVisible());
      assert.equal(await page.locator('.dc-topbar').getByText('远端工作台', { exact: true }).count(), 0);
      assert.equal(await directory.getByText('当前打开的工作台', { exact: true }).count(), 0);
      assert(await directory.evaluate(node => node.scrollWidth <= node.clientWidth), 'device directory overflowed');
      await page.screenshot({ path: join(screenshots, `device-directory-${width}-${theme}.png`), fullPage: true });
      await remote.click();
      await workbench.waitFor();
      assert.equal(await workbench.getAttribute('src'), entry);
    }
    for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 850 }); await page.emulateMedia({ colorScheme: theme });
      await page.waitForFunction(theme => document.documentElement.getAttribute('data-dsh-device-theme') === theme, theme);
      await openAddDevice('phone');
      const paths = page.getByRole('tablist', { name: '添加方式', exact: true });
      const existing = paths.getByRole('tab', { name: '连接已有设备', exact: true });
      const server = paths.getByRole('tab', { name: '添加服务器', exact: true });
      assert.equal(await existing.getAttribute('aria-selected'), 'true');
      assert.equal(await server.getAttribute('aria-selected'), 'false');
      const colors = await paths.evaluate(track => {
        const context = document.createElement('canvas').getContext('2d');
        const paint = color => { context.fillStyle = color; context.fillRect(0, 0, 1, 1); };
        const luminance = (color, ...backgrounds) => {
          context.clearRect(0, 0, 1, 1);
          backgrounds.forEach(paint);
          paint(color);
          const linear = byte => { const value = byte / 255; return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4; };
          const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
          return .2126 * linear(red) + .7152 * linear(green) + .0722 * linear(blue);
        };
        const colorOf = (node, property) => getComputedStyle(node)[property];
        const sheet = colorOf(track.closest('.dc-sheet'), 'backgroundColor');
        const background = colorOf(track, 'backgroundColor');
        const fill = colorOf(track.querySelector('.bg-segments-fill'), 'backgroundColor');
        return {
          selection: luminance(fill, sheet, background), track: luminance(background, sheet),
          selectedLabel: luminance(colorOf(track.querySelector('[aria-selected=true]'), 'color')),
          inactiveLabel: luminance(colorOf(track.querySelector('[aria-selected=false]'), 'color')),
        };
      });
      const contrast = (a, b) => (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
      assert(contrast(colors.selectedLabel, colors.selection) >= 4.5 && contrast(colors.inactiveLabel, colors.track) >= 4.5, JSON.stringify({ theme, colors }));
      assert(theme === 'dark' ? colors.selection < .15 && colors.selection > colors.track : colors.selection > .65 && colors.selection < colors.track, JSON.stringify({ theme, colors }));
      assert.equal(await page.getByRole('button', { name: '连接设备', exact: true }).isDisabled(), true);
      await page.screenshot({ path: join(screenshots, 'add-device-' + width + '-' + theme + '.png'), fullPage: true });
      await existing.focus(); await page.keyboard.press('ArrowRight');
      assert.equal(await server.getAttribute('aria-selected'), 'true');
      assert.equal(await page.getByLabel('服务器地址', { exact: true }).isVisible(), false);
      assert.equal(await page.getByRole('button', { name: '手动安装', exact: true }).getAttribute('aria-expanded'), 'true');
      await page.screenshot({ path: join(screenshots, 'add-server-' + width + '-' + theme + '.png'), fullPage: true });
      for (const mode of ['empty', 'loading', 'error', 'data']) {
        await openServer(mode);
        if (mode !== 'empty') {
          await page.getByLabel('名称（可选）', { exact: true }).fill('保留的服务器名称');
          await page.locator('.dc-field').filter({ hasText: '下载源' }).locator('button.dowork-select').click();
          await page.getByRole('option', { name: '官方直连', exact: true }).click();
          const prepare = page.getByRole('button', { name: '准备部署资源', exact: true });
          await prepare.focus(); await page.keyboard.press('Enter');
          if (mode === 'loading') {
            await page.getByText('128 MB / 256 MB · 50%', { exact: true }).waitFor();
            await page.getByRole('button', { name: '取消', exact: true }).waitFor();
          } else if (mode === 'error') {
            await page.getByRole('alert').filter({ hasText: '部署资源下载失败' }).waitFor();
            await page.getByRole('button', { name: '重试', exact: true }).waitFor();
          } else {
            await page.getByRole('status').filter({ hasText: '部署资源已就绪' }).waitFor();
            assert.equal(await page.getByRole('button', { name: '打开工作台', exact: true }).count(), 0);
          }
          assert.deepEqual(await page.evaluate(() => window.calls.find(call => call.action === 'serverPrefetch').input), { source: 'github' });
          assert.equal(await page.evaluate(() => window.calls.some(call => ['sshProbe', 'sshConnect', 'select'].includes(call.action))), false);
        } else assert.equal(await page.getByRole('button', { name: '准备部署资源', exact: true }).isEnabled(), true);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.querySelector('.dc-sheet').scrollWidth <= document.querySelector('.dc-sheet').clientWidth), mode + '/' + width + '/' + theme + ' overflow');
        await page.screenshot({ path: join(screenshots, mode + '-' + width + '-' + theme + '.png'), fullPage: true });
        if (mode === 'data') {
          await page.getByRole('button', { name: '继续安装', exact: true }).click();
          assert.equal(await page.getByLabel('名称（可选）', { exact: true }).inputValue(), '保留的服务器名称');
          assert.equal(await page.locator('.dc-field').filter({ hasText: '下载源' }).locator('button.dowork-select').innerText(), '官方直连');
          assert.equal(await page.getByRole('dialog').count(), 1);
        } else if (mode === 'error') {
          await page.evaluate(() => { window.resourceMode = 'data'; });
          await page.getByRole('button', { name: '重试', exact: true }).click();
          await page.getByRole('button', { name: '继续安装', exact: true }).waitFor();
          assert.equal(await page.evaluate(() => window.calls.filter(call => call.action === 'serverPrefetch').length), 2);
        }
      }
    }
    await openServer('loading');
    await page.getByRole('button', { name: '准备部署资源', exact: true }).click();
    await page.getByText('128 MB / 256 MB · 50%', { exact: true }).waitFor();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(await page.getByText('资源准备已取消', { exact: true }).count(), 0, 'wait for the real terminal state');
    assert.deepEqual(await page.evaluate(() => window.calls.find(call => call.action === 'jobCancel').input), { jobId: 'resources' });
    await page.evaluate(() => { window.resourceMode = 'cancelled'; });
    await page.getByRole('status').filter({ hasText: '资源准备已取消' }).waitFor();
    assert.equal(await page.getByRole('alert').count(), 0);
    assert.equal(await page.getByRole('button', { name: '取消', exact: true }).count(), 0);
    await page.screenshot({ path: join(screenshots, 'cancelled-390-dark.png'), fullPage: true });
    await page.getByRole('button', { name: '返回', exact: true }).click();
    await page.getByLabel('服务器地址', { exact: true }).fill('server.example.com');
    await page.getByLabel('用户名', { exact: true }).fill('ubuntu');
    await page.getByRole('button', { name: '检查', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '服务器准备就绪' }).waitFor();
    assert.equal(await page.getByText('SHA256:verified', { exact: true }).isVisible(), false);
    await page.screenshot({ path: join(screenshots, 'ssh-ready-390-dark.png'), fullPage: true });
    await page.getByText('查看 SSH 指纹', { exact: true }).click();
    await page.getByText('SHA256:verified', { exact: true }).waitFor();
    await page.getByRole('button', { name: '连接', exact: true }).click();
    await page.getByText('远端安装已开始', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '取消', exact: true }).count(), 0, 'upload/install cannot be cancelled as resource preparation');
    await page.screenshot({ path: join(screenshots, 'install-390-dark.png'), fullPage: true });
    await page.getByRole('button', { name: '手动安装', exact: true }).click();
    const command = await page.locator('.dc-install-command').innerText();
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      async writeText(text) { window.copiedInstallCommand = text; },
    } }));
    await page.getByRole('button', { name: '复制', exact: true }).click();
    await page.getByRole('button', { name: '已复制', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.copiedInstallCommand), command);
    assert.equal(await page.getByRole('button', { name: '已复制', exact: true }).count(), 1);
    const downloadLink = page.getByRole('link', { name: '下载', exact: true });
    const downloadUrl = await downloadLink.getAttribute('href');
    assert(command.includes(downloadUrl));
    const scriptBytes = await readFile(join(root, 'install-server.sh'));
    await page.route(downloadUrl, route => route.fulfill({
      contentType: 'text/plain',
      headers: { 'content-disposition': 'attachment; filename=install-server.sh' },
      body: scriptBytes,
    }));
    const scriptDownload = page.waitForEvent('download');
    await downloadLink.click();
    assert.equal((await scriptDownload).suggestedFilename(), 'install-server.sh');
    await page.screenshot({ path: join(screenshots, 'script-390-dark.png'), fullPage: true });
    await page.getByRole('button', { name: '手动安装', exact: true }).click();
    await page.getByText('远端安装已开始', { exact: true }).waitFor();
    await page.evaluate(() => window.renderScenario('phone'));
    await page.getByRole('button', { name: '添加设备', exact: true }).click();
    await page.getByRole('tab', { name: '添加服务器', exact: true }).click();
    assert.equal(await page.getByLabel('服务器地址', { exact: true }).isVisible(), false);
    assert.equal(await page.getByRole('button', { name: '手动安装', exact: true }).getAttribute('aria-expanded'), 'true');
    await page.screenshot({ path: join(screenshots, 'script-phone-390-dark.png'), fullPage: true });
    for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 850 }); await page.emulateMedia({ colorScheme: theme });
      await openServer('empty');
      await page.getByLabel('名称（可选）', { exact: true }).fill('草稿服务器');
      await page.getByRole('button', { name: '手动安装', exact: true }).click();
      await page.getByRole('tab', { name: '连接已有设备', exact: true }).click();
      await page.getByRole('tab', { name: '添加服务器', exact: true }).click();
      await page.screenshot({ path: join(screenshots, 'script-' + width + '-' + theme + '.png'), fullPage: true });
      await page.getByRole('button', { name: '手动安装', exact: true }).click();
      assert.equal(await page.getByLabel('名称（可选）', { exact: true }).inputValue(), '草稿服务器');
    }
    for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 850 }); await page.emulateMedia({ colorScheme: theme });
      await page.evaluate(() => window.renderScenario('relay-empty'));
      await page.getByRole('tab', { name: '中继池', exact: true }).click();
      await page.getByRole('tabpanel', { name: '中继池', exact: true }).getByRole('button', { name: '添加中继' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('group', { name: '中继添加方式' }).getByRole('button', { name: '部署', exact: true }).click();
      assert.equal(await dialog.getByRole('link', { name: '部署指南' }).getAttribute('href'), 'https://benchgo.cn/docs/linux-server');
      const advanced = dialog.getByRole('button', { name: '高级设置', exact: true });
      const relayPort = dialog.getByLabel('中继业务端口', { exact: true });
      assert.equal(await advanced.getAttribute('aria-expanded'), 'false');
      assert.equal(await relayPort.isVisible(), false);
      await page.screenshot({ path: join(screenshots, `relay-deploy-${width}-${theme}.png`), fullPage: true });
      await advanced.focus();
      await page.keyboard.press('Space');
      assert.equal(await advanced.getAttribute('aria-expanded'), 'true');
      assert(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth), 'relay deployment overflowed');
      assert(await advanced.evaluate(node => Number.parseInt(getComputedStyle(node).paddingInlineStart, 10) >= 12));
      assert(await relayPort.evaluate(node => Number.parseInt(getComputedStyle(node.closest('.bg-ui-disclosure-inner')).paddingInlineEnd, 10) >= 12));
      await advanced.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(screenshots, `relay-advanced-${width}-${theme}.png`), fullPage: true });
      await dialog.getByLabel('服务器地址', { exact: true }).fill('8.8.8.8');
      await relayPort.fill('19999');
      await advanced.focus();
      await page.keyboard.press('Enter');
      assert.equal(await advanced.getAttribute('aria-expanded'), 'false');
      assert.equal(await relayPort.isVisible(), false);
      await dialog.locator('button[type=submit]').click();
      await dialog.getByRole('alert').filter({ hasText: '中继端口须为 20000–49151' }).waitFor();
      assert.equal(await advanced.getAttribute('aria-expanded'), 'true');
      assert.equal(await relayPort.inputValue(), '19999');
      assert.equal(await page.evaluate(() => window.calls.some(call => ['relayProbe', 'relayDeploy'].includes(call.action))), false);
      await relayPort.fill('24681');
      await advanced.click();
      await advanced.click();
      assert.equal(await relayPort.inputValue(), '24681');
    }
    for (const [width, theme] of [[1280, 'light'], [390, 'dark']]) {
      await page.setViewportSize({ width, height: 850 }); await page.emulateMedia({ colorScheme: theme });
      for (const [mode, expected] of [['loading', '正在读取中继…'], ['error', '无法读取中继状态 · 读取连接超时'], ['empty', '尚未添加中继'], ['data', '首选中继']]) {
        await page.evaluate(mode => window.renderScenario('relay-' + mode), mode);
        const tab = page.getByRole('tab', { name: '中继池', exact: true });
        await tab.click();
        const relay = page.getByRole('tabpanel', { name: '中继池', exact: true });
        if (mode === 'loading') await relay.getByRole('status').filter({ hasText: expected }).waitFor();
        else await relay.getByText(expected, { exact: true }).waitFor();
        assert(await relay.evaluate(node => node.scrollWidth <= node.clientWidth), `relay ${mode} ${width} overflowed`);
        await page.screenshot({ path: join(screenshots, `relay-${mode}-${width}-${theme}.png`), fullPage: true });
        if (mode === 'error') {
          await page.evaluate(() => { window.relayMode = 'empty'; });
          await relay.getByRole('button', { name: '重试读取' }).click();
          await relay.getByText('尚未添加中继').waitFor();
        }
        if (mode === 'data') {
          await relay.getByText(/当前工作台使用/).waitFor();
          await relay.getByText('通道已连接', { exact: true }).waitFor();
          await relay.getByText('网络超时', { exact: true }).waitFor();
          assert.equal(await relay.locator('time').count(), 2);
          await relay.getByRole('button', { name: '重试检测' }).click();
          await relay.getByText('中继验证通过').waitFor();
          assert.equal(await page.evaluate(() => window.calls.find(call => call.action === 'relayTest')?.input.id), 'preferred');
        }
      }
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
