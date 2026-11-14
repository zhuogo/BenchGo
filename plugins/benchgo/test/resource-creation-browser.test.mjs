import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { officialUiEntries, officialUiLoaders } from '../../link/scripts/official-ui.mjs';
import { sharedUiStyles } from '../scripts/shared-ui.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url));
const { chromium } = require('playwright');
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || [chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);

test('one creation dialog switches devices, reuses the project form and renders recoverable states', { skip: !executablePath, timeout: 90000 }, async () => {
  const options = { bundle: true, write: false, outdir: join(root, 'artifacts/unused-resource-creation'), format: 'iife', jsx: 'automatic', target: 'es2022', minify: true,
    alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')), ...await officialUiEntries() },
    nodePaths: [join(root, 'plugins/benchgo/node_modules'), join(root, 'plugins/link/node_modules')], plugins: [sharedUiStyles()],
    loader: { '.css': 'text', '.svg': 'text', ...officialUiLoaders }, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' };
  const owner = await build({ ...options, stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
    import {ResourceCreationDialog} from './plugins/benchgo/client/resource-creation.jsx';
    import hostCss from './plugins/benchgo/client/style.css';
    import tokens from './deepseek-harness/packages/client/ui-theme/src/styles/design-platform.css';
    import themeBase from './deepseek-harness/packages/client/ui-theme/src/styles/base.css';
    import {installIconSprite} from './deepseek-harness/packages/client/ui-theme/src/client/icon-sprite.ts';
    installIconSprite({effect:fn=>fn(),on(){}},undefined);
    const local={id:'local',name:'DESKTOP-R2F85SE',kind:'local',status:'online'},remote={id:'opaque:remote/01',name:'襄阳服务器',kind:'server',status:'online',hostId:'host:exact/1',authorizationId:'auth:exact/1'};
    const base={enabled:true,activeId:'local',devices:[local,remote],selected:[local,remote],scope:{mode:'all'},ready:true,error:'',retry:()=>window.scenario('data')};
    window.results=[];window.systemPicks=0;window.__DSH_DIRECTORY_PICKER__={pick:async()=>{systemPicks++;return null;}};
    const api=async(action,args={})=>{const response=await fetch('/project-api',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,args})});const value=await response.json();if(!response.ok)throw Error(value.error);return value;};
    function App(){const [action,setAction]=useState(null),[navigation,setNavigation]=useState(base),[version,setVersion]=useState(0);
      window.scenario=(mode,kind='addProject')=>{setVersion(v=>v+1);setAction(kind);setNavigation({...base,...(mode==='remote'?{selected:[remote]}:mode==='single'?{devices:[local],selected:[local]}:mode==='empty'?{devices:[],selected:[]}:mode==='loading'?{devices:[],selected:[],ready:false}:mode==='error'?{devices:[],selected:[],error:'设备列表暂不可用，请重试'}:{})});};
      window.removeRemote=()=>setNavigation(n=>({...n,devices:[local],selected:[local]}));
      window.preferRemote=()=>setNavigation(n=>({...n,selected:[remote]}));
      return <><style>{tokens}{themeBase}{hostCss}{'.fixture-shell{height:100dvh;display:grid;grid-template-columns:260px minmax(0,1fr)}.fixture-sidebar{display:flex;flex-direction:column;padding:20px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));gap:12px;border-right:1px solid #8882}.fixture-sidebar h1{font-size:17px;margin:0 0 12px}.fixture-sidebar button{min-height:36px;padding:6px 10px;border:0;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover);color:inherit;text-align:left;font:inherit;cursor:pointer}.fixture-main{padding:32px;min-width:0}.fixture-main h2{font-size:22px}.fixture-main textarea{box-sizing:border-box;width:100%;max-width:560px;min-height:100px;padding:14px;border:1px solid #8883;border-radius:12px;background:transparent;color:inherit;resize:none}.fixture-main p{color:var(--dsw-alias-label-secondary)}@media(max-width:600px){.fixture-shell{grid-template-columns:110px minmax(0,1fr)}.fixture-sidebar{padding:12px;font-size:12px}.fixture-main{padding:20px 12px}}'}</style>
      <div className="fixture-shell cmd-shell-frame"><aside className="fixture-sidebar"><h1>BenchGo</h1><button onClick={()=>window.scenario('data')}>添加项目目录</button><button onClick={()=>window.scenario('data','newSession')}>最近新聊天</button><p>项目</p><span>BenchGo</span><p>最近</p><span>工作台设计讨论</span><button className="dsh-device-launcher" onClick={()=>results.push({kind:'devices'})}>设备中心</button></aside><main className="fixture-main"><h2>工作台</h2><p>继续你的项目与对话</p><textarea defaultValue="保留的草稿" aria-label="聊天草稿"/></main></div>
      {action&&<ResourceCreationDialog key={version} action={action} navigation={navigation} api={api} onClose={()=>setAction(null)} onSelected={async(project,device)=>{results.push({kind:'project',project,deviceId:device.id});setAction(null);}} onNewSession={async device=>{if(window.failSession)throw Error('创建会话失败，请重试');results.push({kind:'session',deviceId:device.id});}}/>}</>;
    }createRoot(document.getElementById('root')).render(<App/>);
  ` } });
  const receiver = await build({ ...options, stdin: { resolveDir: root, loader: 'jsx', contents: `
    import {installResourceReceiver} from './plugins/link/client/resource-navigation.jsx';
    installResourceReceiver({}, {open:()=>{},newSession:()=>{},addProject:()=>{},projectApi:async(action,args)=>{const response=await fetch('/project-api',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,args})});const value=await response.json();if(!response.ok)throw Error(value.error);return value;}});
  ` } });
  const script = owner.outputFiles.find(file => file.path.endsWith('.js')).text;
  const css = owner.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n');
  const receiverScript = receiver.outputFiles.find(file => file.path.endsWith('.js')).text;
  const directory = join(root, 'artifacts/resource-creation-20261114'); await mkdir(directory, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath });
  let releaseBrowse = null;
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });page.setDefaultTimeout(6000);
    const errors = [], calls = [], selections = []; let mode = 'data', holdRemote = false;
    page.on('pageerror', error => errors.push(error.message));
    const handleRoute = async route => {
      const request = route.request(), url = new URL(request.url()), remote = url.port === '17974';
      if (url.pathname === '/api/commander-devices') { const input = request.postDataJSON();selections.push(input);return route.fulfill({ json: { url: 'http://127.0.0.1:17974/remote/?ticket=' + selections.length } }); }
      if (url.pathname === '/project-api') {
        const { action, args } = request.postDataJSON();calls.push({ remote, action, args });
        if (action === 'browse') {
          if (remote && holdRemote) await new Promise(resolve => { releaseBrowse = resolve; });
          if (mode === 'browse-error') return route.fulfill({ status: 503, json: { error: '目录读取失败，请重试' } });
          if (mode === 'browse-loading') await new Promise(resolve => { releaseBrowse = resolve; });
          const path = args.path || (remote ? '/srv/projects' : 'E:\\Workspace');
          const entries = mode === 'browse-empty' ? [] : remote ? [{ name: '远端项目', path: '/srv/projects/remote-repo' }] : [{ name: 'BenchGo', path: 'E:\\Workspace\\BenchGo' }, { name: '包含较长名称的项目文件夹用于检查截断', path: 'E:\\Workspace\\long-name' }];
          return route.fulfill({ json: { path, parent: remote ? '/srv' : 'E:\\', roots: remote ? [] : [{ name: 'C:', path: 'C:\\' }, { name: 'E:', path: 'E:\\' }], entries } });
        }
        if (action === 'project' || action === 'clone') return route.fulfill({ json: { project: { id: remote ? 'opaque:project/02' : 'local-project', path: args.path || '/srv/projects/exact-repo', title: '测试项目' } } });
        return route.fulfill({ status: 422, json: { error: 'Unsupported action' } });
      }
      if (url.pathname === '/receiver.js') return route.fulfill({ contentType: 'text/javascript', body: receiverScript });
      if (url.pathname === '/remote/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><html><head><meta charset="utf-8"></head><body><script src="/receiver.js"></script></body></html>' });
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>' + css + 'body{margin:0;font-family:Arial,sans-serif;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}</style></head><body><div id="root"></div></body></html>' });
    };
    await page.route('**/*', handleRoute);
    await page.goto('http://127.0.0.1:17973/');await page.addScriptTag({ content: script });
    const dialog = page.getByRole('dialog');
    const choose = async name => { const original = await dialog.elementHandle();await dialog.getByRole('button', { name: '目标设备', exact: true }).click();await page.getByRole('option', { name: new RegExp('^' + name + ' · ') }).click();assert.equal(await original.evaluate(node => node === document.querySelector('[role=dialog]')), true, 'switching devices retains the same modal DOM and focus layer'); };
    const open = async (state = 'data', action = 'addProject') => { await page.evaluate(([state, action]) => window.scenario(state, action), [state, action]);await dialog.waitFor(); };
    const shot = async name => { await page.screenshot({ path: join(directory, name + '.png'), animations: 'disabled' }); };
    const geometry = async () => {
      const rect = await dialog.boundingBox(), viewport = page.viewportSize();assert(rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= viewport.width + 1 && rect.y + rect.height <= viewport.height + 1, JSON.stringify({ rect, viewport }));
      assert.equal(await page.getByRole('dialog').count(), 1);assert.equal(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
      assert.equal(await dialog.getByText('使用此设备的文件夹与 Git 环境', { exact: true }).count(), 0);
      const toolbar = dialog.locator('.cmd-project-toolbar');
      if (await toolbar.count()) {
        const tabs = await toolbar.getByRole('tablist').boundingBox(), device = await toolbar.getByRole('button', { name: '目标设备', exact: true }).boundingBox();
        assert(tabs && device && Math.abs(tabs.y + tabs.height / 2 - device.y - device.height / 2) <= 1, 'device picker shares the tabs row');
        const control = await toolbar.locator('.cmd-creation-device').boundingBox();
        assert(tabs.x + tabs.width <= device.x && device.width < rect.width / 2, 'device picker stays compact beside tabs');
        assert(Math.abs(control.x - device.x) <= 1 && Math.abs(control.width - device.width) <= 1, 'disabled tooltip anchor preserves device control width');
        if (viewport.width >= 600) assert.equal(Math.round(rect.width), 480, 'desktop project dialog is wider');
      }
    };

    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { document.body.toggleAttribute('data-ds-dark-theme', theme === 'dark');document.documentElement.style.colorScheme = theme; }, theme);
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        for (const state of ['loading', 'empty', 'error', 'data']) {
          await open(state);
          if (state === 'loading') await dialog.getByRole('status', { name: '正在读取设备…' }).waitFor();
          if (state === 'empty') await dialog.getByText('暂无可用设备', { exact: true }).waitFor();
          if (state === 'error') await dialog.getByText('无法读取设备', { exact: true }).waitFor();
          if (state === 'data') await dialog.getByLabel('当前目录', { exact: true }).filter({ hasText: 'E:\\Workspace' }).waitFor();
          await geometry();await shot(theme + '-' + width + '-' + state);
          await dialog.getByRole('button', { name: '关闭', exact: true }).click();await dialog.waitFor({ state: 'detached' });
        }
      }
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    for (const state of ['browse-empty', 'browse-loading']) {
      mode = state;await open('remote');
      if (state === 'browse-empty') await dialog.getByText('此目录没有子文件夹', { exact: true }).waitFor();
      else await dialog.getByRole('status', { name: '正在读取…', exact: true }).waitFor();
      await geometry();await shot('remote-' + state);
      if (state === 'browse-loading') { mode = 'data';releaseBrowse?.();releaseBrowse = null;await dialog.getByLabel('当前目录', { exact: true }).filter({ hasText: '/srv/projects' }).waitFor(); }
      await dialog.getByRole('button', { name: '关闭', exact: true }).click();await dialog.waitFor({ state: 'detached' });
    }
    mode = 'data';
    await open();await dialog.getByRole('button', { name: '系统选择文件夹', exact: true }).waitFor();
    assert.equal((await dialog.getByRole('button', { name: '目标设备', exact: true }).innerText()).trim(), 'DESKTOP-R2F85SE', 'device trigger omits status and explanatory copy');
    await dialog.getByRole('button', { name: '目标设备', exact: true }).click();await page.getByRole('option', { name: '襄阳服务器 · 可连接', exact: true }).waitFor();await shot('device-options-with-status');await page.keyboard.press('Escape');
    await page.evaluate(() => window.preferRemote());assert.match(await dialog.getByRole('button', { name: '目标设备', exact: true }).innerText(), /DESKTOP-R2F85SE/);
    await choose('襄阳服务器');await dialog.getByLabel('当前目录', { exact: true }).filter({ hasText: '/srv/projects' }).waitFor();
    assert.equal((await dialog.getByRole('button', { name: '目标设备', exact: true }).innerText()).trim(), '襄阳服务器');
    assert.equal(await dialog.getByRole('button', { name: '系统选择文件夹', exact: true }).count(), 0);
    assert.equal(await dialog.getByRole('group', { name: '磁盘', exact: true }).count(), 0);
    assert.equal(await page.getByRole('dialog').count(), 1);await shot('remote-project-data');
    await dialog.getByRole('button', { name: '远端项目', exact: true }).click();await dialog.getByLabel('当前目录', { exact: true }).filter({ hasText: '/srv/projects/remote-repo' }).waitFor();
    await dialog.getByRole('button', { name: '添加项目', exact: true }).click();await dialog.waitFor({ state: 'detached' });
    assert.deepEqual(calls.filter(call => call.action === 'project').at(-1), { remote: true, action: 'project', args: { path: '/srv/projects/remote-repo' } });
    assert.equal((await page.evaluate(() => window.results)).at(-1).deviceId, 'opaque:remote/01');

    await open('remote');await dialog.getByLabel('当前目录', { exact: true }).filter({ hasText: '/srv/projects' }).waitFor();
    await dialog.getByRole('tab', { name: 'GitHub', exact: true }).click();await dialog.getByRole('textbox', { name: '仓库地址', exact: true }).fill('https://github.com/exact-owner/Exact.Repo.git');
    await choose('DESKTOP-R2F85SE');assert.equal(await dialog.getByRole('tab', { name: 'GitHub', exact: true }).getAttribute('aria-selected'), 'true');assert.equal(await dialog.getByRole('textbox', { name: '仓库地址', exact: true }).inputValue(), 'https://github.com/exact-owner/Exact.Repo.git');
    await choose('襄阳服务器');assert.equal(await dialog.getByRole('textbox', { name: '仓库地址', exact: true }).inputValue(), 'https://github.com/exact-owner/Exact.Repo.git');await shot('remote-github');
    await dialog.getByRole('button', { name: '克隆并添加', exact: true }).click();await dialog.waitFor({ state: 'detached' });
    assert.deepEqual(calls.filter(call => call.action === 'clone').at(-1), { remote: true, action: 'clone', args: { url: 'https://github.com/exact-owner/Exact.Repo.git' } });

    mode = 'browse-error';await open('remote');await dialog.getByRole('alert').filter({ hasText: '目录读取失败' }).waitFor();assert.equal(await dialog.getByRole('button', { name: '添加项目', exact: true }).isEnabled(), false);await shot('remote-browse-error');
    mode = 'data';await dialog.getByRole('button', { name: '重试', exact: true }).click();await dialog.getByLabel('当前目录', { exact: true }).filter({ hasText: '/srv/projects' }).waitFor();
    await choose('DESKTOP-R2F85SE');await dialog.getByLabel('当前目录', { exact: true }).filter({ hasText: 'E:\\Workspace' }).waitFor();
    holdRemote = true;await choose('襄阳服务器');await page.waitForFunction(() => document.querySelector('iframe')?.contentWindow);while (!releaseBrowse) await new Promise(resolve => setTimeout(resolve, 10));
    await choose('DESKTOP-R2F85SE');await dialog.getByLabel('当前目录', { exact: true }).filter({ hasText: 'E:\\Workspace' }).waitFor();holdRemote = false;releaseBrowse();releaseBrowse = null;
    assert.equal(await dialog.getByLabel('当前目录', { exact: true }).innerText(), 'E:\\Workspace');
    await choose('襄阳服务器');await dialog.getByLabel('当前目录', { exact: true }).filter({ hasText: '/srv/projects' }).waitFor();await page.evaluate(() => window.removeRemote());await dialog.getByText('目标设备已移除', { exact: true }).waitFor();assert.equal(await dialog.getByRole('button', { name: '添加项目', exact: true }).count(), 0);await shot('removed-selected-device');await choose('DESKTOP-R2F85SE');await dialog.getByLabel('当前目录', { exact: true }).filter({ hasText: 'E:\\Workspace' }).waitFor();await dialog.getByRole('button', { name: '关闭', exact: true }).click();

    for (const [state, expected] of [['data', 'local'], ['remote', 'opaque:remote/01']]) {
      await open(state, 'newSession');await geometry();await shot('new-session-' + state);
      await dialog.getByRole('button', { name: '目标设备', exact: true }).focus();await page.keyboard.press('ArrowDown');await page.getByRole('listbox').waitFor();await page.keyboard.press('Escape');assert.equal(await dialog.getByRole('button', { name: '目标设备', exact: true }).evaluate(node => node === document.activeElement), true);
      await dialog.getByRole('button', { name: '创建会话', exact: true }).click();await dialog.waitFor({ state: 'detached' });assert.equal((await page.evaluate(() => window.results)).at(-1).deviceId, expected);
    }
    await open('data', 'newSession');await page.evaluate(() => window.failSession = true);await dialog.getByRole('button', { name: '创建会话', exact: true }).click();await dialog.getByRole('alert').filter({ hasText: '创建会话失败' }).waitFor();await shot('new-session-error');await page.evaluate(() => window.failSession = false);await dialog.getByRole('button', { name: '创建会话', exact: true }).click();await dialog.waitFor({ state: 'detached' });
    assert.equal(await page.getByRole('textbox', { name: '聊天草稿' }).inputValue(), '保留的草稿');assert.equal(await page.evaluate(() => window.systemPicks), 0);assert.deepEqual(errors, []);
    await open('single');await dialog.getByLabel('当前目录', { exact: true }).filter({ hasText: 'E:\\Workspace' }).waitFor();assert.equal(await dialog.getByRole('button', { name: '目标设备', exact: true }).isDisabled(), true);await geometry();await shot('single-device-aligned');await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    const touch = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
    await touch.route('**/*', handleRoute);await touch.goto('http://127.0.0.1:17973/');await touch.addScriptTag({ content: script });await touch.evaluate(() => window.scenario('data'));
    const touchDialog = touch.getByRole('dialog');await touchDialog.getByLabel('当前目录', { exact: true }).filter({ hasText: 'E:\\Workspace' }).waitFor();
    const touchGeometry = await touchDialog.evaluate(node => { const picker = node.querySelector('[aria-label="目标设备"]').getBoundingClientRect(), tabs = node.querySelector('[role="tablist"]').getBoundingClientRect();return { pickerHeight: picker.height, sameRow: Math.abs(picker.y + picker.height / 2 - tabs.y - tabs.height / 2) <= 1, fits: node.scrollWidth <= node.clientWidth + 1 }; });
    assert.equal(await touch.evaluate(() => innerWidth), 390);assert(touchGeometry.pickerHeight >= 44 && touchGeometry.sameRow && touchGeometry.fits, JSON.stringify(touchGeometry));await touch.screenshot({ path: join(directory, 'touch-390-data.png'), animations: 'disabled' });await touch.close();
  } finally { releaseBrowse?.();await browser.close(); }
});
