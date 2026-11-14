import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { officialUiEntries, officialUiLoaders } from '../scripts/official-ui.mjs';
import { shellUi } from '../../benchgo/scripts/shell-ui.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url));
const { chromium } = require('playwright');
const { build } = createRequire(new URL('../package.json', import.meta.url))('esbuild');
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || [chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const origin = 'http://127.0.0.1:17880';
const remoteOrigin = 'http://127.0.0.1:17882';
const localName = '本机 · BenchGo 设计与开发工作台（保留完整设备名称）';
const remoteName = '开发服务器 · BenchGo 项目与长期任务工作台（完整名称）';
const devices = [{ id: 'local', name: localName, kind: 'local', status: 'online' }, { id: 'cloud', name: remoteName, kind: 'computer', status: 'online' }];

async function alternateSidebarEntrypoints(page) {
  return page.evaluate(() => {
    const container = document.createElement('div');
    container.innerHTML = '<button data-sidebar-opener>Sidebar</button><div class="cmd-mobile-navigation"><button>Menu</button></div>';
    document.body.append(container);
    const display = [...container.querySelectorAll('button')].map(button => getComputedStyle(button).display);
    container.remove();
    return display;
  });
}

async function fixtureAssets() {
  const result = await build({ stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
    import {SidebarRoot} from './deepseek-harness/packages/client/ui-sidebar/src/client/SidebarRoot.tsx';
    import {DeviceSwitch} from './plugins/link/client/device-switch.jsx';
    import {UIIcon} from './plugins/benchgo/client/iconsax.jsx';
    import css from './plugins/benchgo/client/style.css';
    import frameCss from './deepseek-harness/packages/client/ui-layout/src/client/AppFrame.module.css';
    import shellBase from './deepseek-harness/packages/client/web/src/base.css';
    import {installThemeStyles} from './deepseek-harness/packages/client/ui-theme/src/client/styles.ts';
    import {installIconSprite} from './deepseek-harness/packages/client/ui-theme/src/client/icon-sprite.ts';
    const themeContext={effect:effect=>effect(),on(){}};
    installThemeStyles(themeContext);installIconSprite(themeContext,undefined);
    const params=new URLSearchParams(location.search),embedded=window.parent!==window;
    if(embedded)window.__DSH_LINK_WORKBENCH__=true;
    document.body.toggleAttribute('data-ds-dark-theme',params.get('theme')==='dark');
    function App(){const [collapsed,setCollapsed]=useState(false),[drawer,setDrawer]=useState(false),[active,setActive]=useState(null);
      window.scenario=(collapsed,drawer)=>{setCollapsed(collapsed);setDrawer(drawer)};
      const panels=[{id:'plugins',label:'工具'},{id:'schedules',label:'自动化任务'}];
      return <><style>{shellBase}{css}</style>{!embedded&&document.documentElement.hasAttribute('data-windows-titlebar')&&<div data-caption-app style={{position:'fixed',left:48,top:6,height:28,display:'flex',alignItems:'center',fontSize:12,zIndex:31}}>应用</div>}<div className={'cmd-shell-frame '+frameCss.frame} data-plus-shell data-sidebar-drawer={drawer||undefined} data-sidebar-collapsed={collapsed||undefined} style={{gridTemplateColumns:(drawer?'0':collapsed?'56px':'300px')+' minmax(0,1fr)',width:'100%'}}>{drawer&&<div className={frameCss.drawerMask} data-sidebar-mask aria-hidden='true'/>}<aside className={frameCss.sidebarCol} style={{width:collapsed&&!drawer?56:300}}><SidebarRoot collapsed={collapsed} drawer={drawer} width={300}
        toggleSidebar={()=>setCollapsed(!collapsed)} startSession={()=>{}} setPinned={()=>{}} trackEntryClick={()=>{}} selectPanel={setActive}
        usePanels={select=>select(panels)} useEntryPins={select=>select([])} useEntryActions={select=>select(false)} useRemoteAccess={()=>true}
        useShortcuts={select=>select([])} usePanelInfo={select=>select({activePanelId:active})} t={key=>key}
        renderFactorySlot={()=> <UIIcon name='plugins' size={16}/>} renderSlot={(name,props={})=>name==='sidebar.workspaces'?
          <section className={'cmd-projects '+(props.wide?'':'cmd-narrow')}><nav className='cmd-sidebar-nav' aria-label='快捷工具栏'>
            <button type='button' aria-label='设备中心'><UIIcon name='link' size={16}/></button><button type='button' className='cmd-new-chat' aria-label='创建新聊天'><UIIcon name='edit' size={16}/></button><button type='button' className='cmd-search-toggle' aria-label='搜索对话'><UIIcon name='search' size={16}/></button><DeviceSwitch/>
          </nav>{props.panelNavigation}{props.wide&&<div className='cmd-sidebar-content'><section className='cmd-section-title'><button type='button' className='cmd-section-toggle'>项目</button></section><div className='cmd-project-name'><button type='button'><UIIcon name='folder' size={16}/>BenchGo</button></div><section className='cmd-section-title'><button type='button' className='cmd-section-toggle'>最近</button></section>{Array.from({length:12},(_,i)=><div className='cmd-session-row' key={i}><button type='button' className='cmd-session'><UIIcon name='chat' size={16}/><span>项目讨论与执行进展 {i+1}</span></button></div>)}</div>}</section>:
          name==='sidebar.settings'?<button type='button' aria-label='设置'><UIIcon name='settings' size={16}/></button>:null}/></aside><main className={frameCss.centerCol} inert={drawer?'':undefined}><p>BenchGo 工作台</p><h1>把想法，推进成结果。</h1><p>选择设备，继续你的工作。</p><textarea aria-label='尚未发送的消息' defaultValue='保留本机草稿'/><button type='button' aria-label='正文操作'>继续工作</button></main></div></>;
    }createRoot(document.getElementById('root')).render(<App/>);
  ` }, bundle: true, write: false, outdir: join(root, 'artifacts/unused-device-switch'), format: 'iife', jsx: 'automatic', target: 'es2022',
    alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')), ...await officialUiEntries() },
    nodePaths: [join(root, 'plugins/benchgo/node_modules'), join(root, 'plugins/link/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')],
    plugins: [shellUi()], loader: { '.css': 'text', '.svg': 'text', ...officialUiLoaders }, logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.DSH_CLIENT_VERSION': 'undefined', 'process.env.DSH_CLIENT_COMMIT_HASH': 'undefined', 'process.env.DSH_CLIENT_GIT_DIRTY': 'undefined' } });
  return { script: result.outputFiles.find(file => file.path.endsWith('.js')).text, css: result.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n') };
}

test('sidebar device selector renders real menus, preserves drafts and remains reachable in remote workbenches', { skip: !executablePath && 'Chromium/Edge is required', timeout: 90_000 }, async () => {
  const assets = await fixtureAssets(), browser = await chromium.launch({ headless: true, executablePath });
  const screenshots = process.env.BENCHGO_DEVICE_SCREENSHOTS;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  try {
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 850 }, colorScheme: theme });
      const page = await context.newPage(), errors = [], requests = [];
      page.setDefaultTimeout(6000); page.on('pageerror', error => errors.push(error.message));
      let mode = 'single', failing = false, holdSelection = false, releaseSelection, holdWorkbench = false, releaseWorkbench, serial = 0;
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/api/commander-devices') {
          const body = route.request().postDataJSON(); requests.push({ origin: url.origin, body });
          if (body.action === 'devices') return route.fulfill({ json: { devices: mode === 'empty' ? [] : mode === 'single' ? [devices[0]] : mode === 'unknown' ? devices.map(device => device.kind === 'local' ? device : { ...device, status: 'unknown' }) : devices } });
          if (body.action === 'select') {
            if (holdSelection) await new Promise(resolve => { releaseSelection = resolve; });
            return route.fulfill(failing ? { status: 503, json: { error: '目标设备暂时无法连接，请重试' } } : { json: { device: devices[1], url: remoteOrigin + '/s/work/?theme=' + theme } });
          }
          return route.fulfill({ status: 400, json: { error: 'Unexpected device action' } });
        }
        if (url.pathname === '/app.js') return route.fulfill({ contentType: 'text/javascript', body: assets.script });
        if (url.pathname === '/app.css') return route.fulfill({ contentType: 'text/css', body: assets.css });
        const embedded = url.origin === remoteOrigin;
        if (embedded && url.pathname === '/s/work/' && holdWorkbench) await new Promise(resolve => { releaseWorkbench = resolve; });
        return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"' + (embedded ? '' : ' data-windows-titlebar') + '><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><style>html{--dsh-windows-titlebar-height:40px}body{margin:0}#root{height:100dvh}main{min-width:0;flex:1;padding:80px 36px}h1{font-size:32px}textarea{display:block;max-width:100%;box-sizing:border-box;width:440px;min-height:110px;margin-top:40px;padding:16px;background:var(--dsw-alias-bg-layer-2);color:inherit;border:1px solid var(--dsw-alias-border-l2);border-radius:14px}main>button{margin-top:16px;color:inherit;background:transparent;border:0;padding:8px}@media(max-width:600px){main{padding:40px 12px}main h1{font-size:24px}}</style></head><body><div id="root"></div><script src="/app.js"></script></body></html>' });
      });
      const trigger = page.locator('.dsh-device-switch-trigger'), menu = page.locator('.dsh-device-switch-menu');
      const capture = async label => {
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), label + ': viewport overflow');
        if (screenshots) await page.screenshot({ path: join(screenshots, theme + '-' + label + '.png'), animations: 'allow' });
      };
      const inspectMenuEntry = async motion => {
        await page.evaluate(() => {
          document.documentElement.setAttribute('data-input-modality', 'pointer');
          window.deviceMenuFrames = []; window.deviceMenuAnimations = []; window.deviceMenuFrameReady = false;
          const sample = (phase, element) => {
            const css = getComputedStyle(element), content = element.querySelector(':scope > [role="presentation"]');
            const color = css.backgroundColor, parts = color.match(/^rgba?\((.*)\)$/)?.[1].split(',');
            window.deviceMenuFrames.push({ phase, opacity: css.opacity, background: color, alpha: parts?.length === 4 ? Number(parts[3]) : parts?.length === 3 ? 1 : 0,
              transform: css.transform, transitionDuration: css.transitionDuration, contentOpacity: content ? Number(getComputedStyle(content).opacity) : null,
              contentTransition: content ? getComputedStyle(content).transitionDuration : null, modality: document.documentElement.getAttribute('data-input-modality'), reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
              rootAnimations: element.getAnimations().map(animation => animation.effect.getKeyframes().map(frame => Object.keys(frame))) });
          };
          window.sampleDeviceMenu = phase => sample(phase, document.querySelector('.dsh-device-switch-menu'));
          const observer = new MutationObserver(() => {
            const element = document.querySelector('.dsh-device-switch-menu'); if (!element) return;
            observer.disconnect(); sample('created', element);
            requestAnimationFrame(() => {
              sample('first-frame', element);
              const content = element.querySelector(':scope > [role="presentation"]');
              window.deviceMenuAnimations = element.getAnimations({ subtree: true }).filter(animation => animation.effect.target === content);
              for (const animation of window.deviceMenuAnimations) { animation.pause(); animation.currentTime = 0; }
              sample('held-first-frame', element); window.deviceMenuFrameReady = true;
            });
          });
          observer.observe(document.body, { childList: true, subtree: true });
          document.querySelector('.dsh-device-switch-trigger').click();
        });
        await page.waitForFunction(() => window.deviceMenuFrameReady);
        const initial = await page.evaluate(() => ({ frames: window.deviceMenuFrames, animationCount: window.deviceMenuAnimations.length }));
        for (const frame of initial.frames) {
          assert.equal(frame.opacity, '1', theme + '/' + motion + '/' + frame.phase + ': menu surface must be opaque immediately');
          assert.equal(frame.alpha, 1, JSON.stringify(frame));
          assert.equal(frame.transform, 'none', JSON.stringify(frame));
          assert.equal(frame.transitionDuration, '0s', JSON.stringify(frame));
          assert.deepEqual(frame.rootAnimations, [], 'the material surface must never animate opacity or background');
        }
        if (motion === 'normal') {
          assert.equal(initial.frames.at(-1).contentTransition, '0.125s, 0.125s');
          if (initial.animationCount) assert.equal(initial.frames.at(-1).contentOpacity, 0, 'first frame keeps the solid surface while content enters');
        } else {
          assert.equal(initial.animationCount, 0, 'reduced motion must not animate content');
          assert.equal(initial.frames.at(-1).contentOpacity, 1);
        }
        await capture('menu-entry-' + motion + '-first-frame');
        const middle = await page.evaluate(async () => {
          if (!window.deviceMenuAnimations.length) await new Promise(resolve => setTimeout(resolve, 62));
          for (const animation of window.deviceMenuAnimations) animation.currentTime = Number(animation.effect.getTiming().duration) / 2;
          await new Promise(requestAnimationFrame); window.sampleDeviceMenu('middle-frame'); return window.deviceMenuFrames.at(-1);
        });
        assert.equal(middle.opacity, '1'); assert.equal(middle.alpha, 1); assert.deepEqual(middle.rootAnimations, []);
        if (motion === 'normal' && initial.animationCount) assert(middle.contentOpacity > 0 && middle.contentOpacity < 1, JSON.stringify(middle));
        else assert.equal(middle.contentOpacity, 1);
        await capture('menu-entry-' + motion + '-middle-frame');
        await page.evaluate(() => { for (const animation of window.deviceMenuAnimations) animation.finish(); });
      };
      const open = async next => { mode = next; await page.goto(origin + '/?theme=' + theme + '&scenario=' + (++serial)); await page.getByRole('button', { name: '搜索对话', exact: true }).waitFor(); };
      await open('empty'); assert.equal(await trigger.count(), 0); await capture('empty');
      await open('single'); assert.equal(await trigger.count(), 0);
      await open('unknown'); await trigger.click();
      const savedDevice = menu.getByRole('menuitem').filter({ hasText: remoteName });
      assert.equal(await savedDevice.locator('small').innerText(), '电脑');
      assert.equal(await savedDevice.locator('[data-device-available]').getAttribute('data-device-available'), 'false');
      await capture('saved-device');
      await page.setViewportSize({ width: 390, height: 850 }); await capture('saved-device-narrow');
      await page.setViewportSize({ width: 1280, height: 850 });
      await open('data'); await trigger.waitFor();
      assert.equal(await trigger.getAttribute('aria-label'), '当前工作台：' + localName);
      for (const [width, collapsed, drawer] of [[1280, false, false], [1280, true, false]]) {
        await page.setViewportSize({ width, height: 850 });
        await page.evaluate(args => window.scenario(...args), [collapsed, drawer]);
        if (collapsed) {
          await trigger.waitFor({ state: 'hidden' });
          await capture('collapsed');
          continue;
        }
        await trigger.waitFor();
        const geometry = await trigger.evaluate(element => {
          const r = element.getBoundingClientRect(), nav = element.closest('.cmd-sidebar-nav').getBoundingClientRect(), panels = document.querySelector('.cmd-sidebar-panels').getBoundingClientRect(), search = document.querySelector('[aria-label="搜索对话"]').getBoundingClientRect();
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, navRight: nav.right, panelTop: panels.top, searchRight: search.right, searchBottom: search.bottom, clipped: [...element.querySelectorAll('span')].some(span => span.scrollWidth > span.clientWidth + 1) };
        });
        assert(geometry.left >= 0 && geometry.right <= 301, JSON.stringify(geometry));
        assert(geometry.panelTop >= geometry.bottom, 'selector must remain above panel navigation');
        if (!collapsed) { assert(geometry.left >= geometry.searchRight, 'selector must follow quick actions'); assert(geometry.clipped, 'long current device names must ellipsize'); }
        else assert(geometry.top >= geometry.searchBottom - 1, 'collapsed selector must follow search');
        await inspectMenuEntry('normal'); await menu.waitFor();
        assert.equal(await menu.getByRole('menuitem').count(), devices.length);
        const box = await menu.boundingBox();
        assert(box.x >= 0 && box.x + box.width <= width && box.y >= 0 && box.y + box.height <= 850, JSON.stringify(box));
        await capture(collapsed ? 'rail-menu' : drawer ? 'drawer-menu' : 'data-menu');
        await page.keyboard.press('ArrowDown');
        assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('role')), 'menuitem');
        const focused = await page.evaluate(() => document.activeElement?.textContent);
        await page.keyboard.press('ArrowDown');
        assert.notEqual(await page.evaluate(() => document.activeElement?.textContent), focused);
        await page.keyboard.press('Escape'); await menu.waitFor({ state: 'detached' });
        assert.equal(await trigger.evaluate(element => element === document.activeElement), true);
        await trigger.click(); await menu.waitFor();
        await page.getByRole('button', { name: '正文操作' }).click(); await menu.waitFor({ state: 'detached' });
      }
      await page.setViewportSize({ width: 1280, height: 850 }); await page.evaluate(() => window.scenario(false, false));
      failing = true; await trigger.click();
      await menu.getByRole('menuitem').filter({ hasText: remoteName }).click();
      await menu.getByRole('alert').getByText('目标设备暂时无法连接，请重试', { exact: false }).waitFor();
      await capture('error');
      assert.equal(await page.getByRole('textbox', { name: '尚未发送的消息' }).inputValue(), '保留本机草稿');
      failing = false; holdSelection = true;
      await menu.getByRole('menuitem').filter({ hasText: remoteName }).click();
      await page.waitForFunction(() => document.querySelector('.dsh-device-switch-trigger')?.disabled === true);
      await capture('loading');
      assert.equal(await menu.count(), 0);
      holdWorkbench = true; holdSelection = false; releaseSelection();
      const stageLoading = page.locator('.dsh-device-switch-loading'), loadingCharacters = stageLoading.locator('.bg-loading-character');
      await stageLoading.getByRole('status', { name: '正在打开设备工作台…', exact: true }).waitFor();
      assert.equal(await stageLoading.locator('.bg-loading-compact').count(), 1);
      assert(await loadingCharacters.count() > 1, 'workbench loading must reuse animated grapheme characters');
      assert.equal(await loadingCharacters.first().evaluate(element => getComputedStyle(element).animationName), 'bg-loading-hit');
      await capture('workbench-loading-motion');
      await page.emulateMedia({ reducedMotion: 'reduce' });
      assert.equal(await loadingCharacters.first().evaluate(element => getComputedStyle(element).animationName), 'none');
      assert.equal(await loadingCharacters.first().evaluate(element => getComputedStyle(element).opacity), '1');
      await capture('workbench-loading-reduced-motion');
      await stageLoading.getByRole('button', { name: '返回本机', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.dsh-device-switch-stage')?.hidden === true);
      assert.equal(await page.locator('.cmd-shell-frame[inert]').count(), 0);
      assert.equal(await page.getByRole('textbox', { name: '尚未发送的消息' }).inputValue(), '保留本机草稿');
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await trigger.click(); await menu.getByRole('menuitem').filter({ hasText: remoteName }).click();
      await stageLoading.getByRole('button', { name: '返回本机', exact: true }).waitFor();
      assert.equal(await loadingCharacters.first().evaluate(element => getComputedStyle(element).animationName), 'bg-loading-hit');
      holdWorkbench = false; releaseWorkbench();
      const remote = page.frameLocator('.dsh-device-switch-stage iframe');
      const remoteTrigger = remote.locator('.dsh-device-switch-trigger');
      await remoteTrigger.waitFor();
      assert.equal(await remoteTrigger.getAttribute('aria-label'), '当前工作台：' + remoteName);
      const captionToggle = page.locator('[data-sidebar-toggle]');
      const uniqueCaptionToggle = async () => {
        assert.equal(await captionToggle.count(), 1);
        assert.equal(await captionToggle.evaluate(element => !!element.closest('[inert]')), false, 'caption control is outside the inert retained shell');
        assert.equal(await remote.locator('[data-sidebar-toggle]:visible').count(), 0, 'desktop embedded page has no second sidebar toggle');
        const toggle = await captionToggle.boundingBox(), app = await page.locator('[data-caption-app]').boundingBox();
        assert(toggle.x + toggle.width <= app.x, 'caption toggle stays left of the application menu');
        assert(Math.abs(toggle.y + toggle.height / 2 - app.y - app.height / 2) <= 1, 'caption controls share one vertical center');
      };
      await remote.locator('html[data-benchgo-desktop-embedded]').waitFor({ state: 'attached' });
      await uniqueCaptionToggle();
      await capture('remote');
      const remoteFrame = page.frames().find(frame => frame.url().startsWith(remoteOrigin));
      assert(remoteFrame);
      assert.deepEqual(await alternateSidebarEntrypoints(remoteFrame), ['none', 'none'], 'desktop embedded page hides alternate narrow and mobile sidebar openers');
      assert.equal(await page.locator('.cmd-shell-frame[inert]').count(), 1);
      await captionToggle.click();
      await remote.locator('.cmd-shell-frame[data-sidebar-collapsed=true]').waitFor();
      await page.getByRole('button', { name: 'toggle.open', exact: true }).waitFor();
      assert.equal(await page.locator('.cmd-shell-frame').getAttribute('data-sidebar-collapsed'), null, 'remote toggle does not change the local layout');
      await uniqueCaptionToggle(); await capture('remote-caption-collapsed');
      await captionToggle.click();
      await remote.locator('.cmd-shell-frame:not([data-sidebar-collapsed])').waitFor();
      await page.getByRole('button', { name: 'toggle.collapse', exact: true }).waitFor();
      await uniqueCaptionToggle(); await capture('remote-caption-expanded');
      await captionToggle.click();
      await remote.locator('.cmd-shell-frame[data-sidebar-collapsed=true]').waitFor();
      await remoteTrigger.waitFor();
      assert(await remoteTrigger.locator('.cmd-ui-icon').first().isVisible(), 'collapsed remote selector keeps its device icon');
      await remoteTrigger.click(); await remote.locator('.dsh-device-switch-menu').waitFor();
      await capture('remote-rail');
      await page.keyboard.press('Escape'); await remote.locator('.dsh-device-switch-menu').waitFor({ state: 'detached' });
      await page.setViewportSize({ width: 390, height: 850 });
      await remoteFrame.evaluate(() => window.scenario(false, true));
      await uniqueCaptionToggle();
      await remoteTrigger.click(); await remote.locator('.dsh-device-switch-menu').waitFor();
      const drawerMenuBox = await remote.locator('.dsh-device-switch-menu').boundingBox();
      assert(drawerMenuBox.x >= 0 && drawerMenuBox.x + drawerMenuBox.width <= 390, JSON.stringify(drawerMenuBox));
      await capture('drawer-menu');
      await page.mouse.click(370, 400); await remote.locator('.dsh-device-switch-menu').waitFor({ state: 'detached' });
      await page.setViewportSize({ width: 1280, height: 850 });
      await remoteFrame.evaluate(() => window.scenario(false, false));
      await remoteTrigger.click();
      await remote.locator('.dsh-device-switch-menu').getByRole('menuitem').filter({ hasText: localName }).click();
      await page.waitForFunction(() => document.querySelector('.dsh-device-switch-stage')?.hidden === true);
      assert.equal(await page.locator('.cmd-shell-frame[inert]').count(), 0);
      assert.equal(await page.getByRole('textbox', { name: '尚未发送的消息' }).inputValue(), '保留本机草稿');
      await captionToggle.click(); await page.locator('.cmd-shell-frame[data-sidebar-collapsed=true]').waitFor();
      await captionToggle.click(); await page.locator('.cmd-shell-frame:not([data-sidebar-collapsed])').waitFor();
      assert.equal(requests.filter(call => call.body.action === 'select').length, 2);
      assert(requests.filter(call => call.body.action === 'select').every(call => call.body.deviceId === 'cloud' && call.origin === origin));
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await inspectMenuEntry('reduced'); await menu.waitFor();
      assert.equal(await menu.evaluate(element => getComputedStyle(element).transitionDuration), '0s');
      await page.keyboard.press('Escape'); await menu.waitFor({ state: 'detached' });
      assert.deepEqual(errors, []);
      const standalone = await context.newPage();
      await standalone.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/app.js') return route.fulfill({ contentType: 'text/javascript', body: assets.script });
        if (url.pathname === '/app.css') return route.fulfill({ contentType: 'text/css', body: assets.css });
        return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><style>body{margin:0}#root{height:100vh}</style></head><body><div id="root"></div><script src="/app.js"></script></body></html>' });
      });
      for (const width of [1280, 390]) {
        await standalone.setViewportSize({ width, height: 850 }); await standalone.goto(remoteOrigin + '/standalone/?theme=' + theme);
        const toggle = standalone.locator('[data-sidebar-toggle]'); await toggle.waitFor();
        assert.equal(await standalone.locator('html[data-benchgo-desktop-embedded]').count(), 0);
        assert((await alternateSidebarEntrypoints(standalone)).every(display => display !== 'none'), 'standalone browser and mobile sidebar entrypoints remain available');
        await toggle.click(); await standalone.locator('.cmd-shell-frame[data-sidebar-collapsed=true]').waitFor();
        await toggle.click(); await standalone.locator('.cmd-shell-frame:not([data-sidebar-collapsed])').waitFor();
        if (screenshots) await standalone.screenshot({ path: join(screenshots, theme + '-standalone-' + width + '.png') });
      }
      await standalone.close();
      await context.close();
    }
  } finally { await browser.close(); }
});

test('legacy workbench handshake times out with a fresh-entry retry and device-center selection reuses its frame', { skip: !executablePath && 'Chromium/Edge is required', timeout: 45_000 }, async () => {
  const assets = await fixtureAssets(), browser = await chromium.launch({ headless: true, executablePath });
  try {
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 850 }, colorScheme: theme });
      const page = await context.newPage();
      let compatible = false, selections = 0;
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/api/commander-devices') {
          const { action } = route.request().postDataJSON();
          return route.fulfill({ json: action === 'devices' ? { devices } : { url: remoteOrigin + '/s/work/?ticket=' + (++selections) + '&theme=' + theme } });
        }
        if (url.pathname === '/app.js') return route.fulfill({ contentType: 'text/javascript', body: assets.script });
        if (url.pathname === '/app.css') return route.fulfill({ contentType: 'text/css', body: assets.css });
        const legacy = url.origin === remoteOrigin && !compatible;
        return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"' + (url.origin === remoteOrigin ? '' : ' data-windows-titlebar') + '><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html{--dsh-windows-titlebar-height:40px}body{margin:0}#root{height:100dvh}main{min-width:0;flex:1;padding:80px 36px}textarea{display:block;width:440px;max-width:100%;min-height:110px}</style><link rel="stylesheet" href="/app.css"></head><body><div id="root">旧设备工作台</div>' + (legacy ? '' : '<script src="/app.js"></script>') + '</body></html>' });
      });
      await page.goto(origin + '/?theme=' + theme);
      await page.locator('.dsh-device-switch-trigger').waitFor();
      await page.clock.install();
      await page.evaluate(() => document.dispatchEvent(new CustomEvent('benchgo:device-select', { detail: { deviceId: 'cloud' } })));
      await page.locator('.dsh-device-switch-stage iframe').waitFor();
      await page.clock.runFor(15_100);
      await page.getByRole('alert').filter({ hasText: '设备工作台未响应' }).waitFor();
      if (process.env.BENCHGO_DEVICE_SCREENSHOTS) await page.screenshot({ path: join(process.env.BENCHGO_DEVICE_SCREENSHOTS, theme + '-handshake-timeout.png') });
      compatible = true;
      await page.getByRole('button', { name: '重试', exact: true }).click();
      const remote = page.frameLocator('.dsh-device-switch-stage iframe');
      await remote.locator('.dsh-device-switch-trigger').waitFor();
      await page.locator('.dsh-device-switch-loading').waitFor({ state: 'detached' });
      assert.equal(selections, 2);
      assert.equal(await page.locator('.dsh-device-switch-stage iframe').count(), 1);
      await remote.locator('.dsh-device-switch-trigger').click();
      await remote.locator('.dsh-device-switch-menu').getByRole('menuitem').filter({ hasText: localName }).click();
      await page.waitForFunction(() => document.querySelector('.dsh-device-switch-stage')?.hidden === true);
      await page.evaluate(() => document.dispatchEvent(new CustomEvent('benchgo:device-select', { detail: { deviceId: 'cloud' } })));
      await page.waitForFunction(() => document.querySelector('.dsh-device-switch-stage')?.hidden === false);
      assert.equal(selections, 2, 'healthy retained workbench must be reused without another authorization request');
      assert.equal(await page.getByRole('textbox', { name: '尚未发送的消息' }).inputValue(), '保留本机草稿');
      await context.close();
    }
  } finally { await browser.close(); }
});
