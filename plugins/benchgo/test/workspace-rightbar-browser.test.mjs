import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { shellUi } from '../scripts/shell-ui.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url));
const { chromium } = require('playwright');
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || [chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);

test('ordinary project workspace preserves its official rightbar, entry and resize across embedded navigation', { skip: !executablePath }, async () => {
  const bundle = await build({
    stdin: { resolveDir: root, loader: 'jsx', contents: `
      import React,{useSyncExternalStore} from 'react';import {createRoot} from 'react-dom/client';
      import {ResponsiveAppFrame} from './plugins/benchgo/client/shell-ui.jsx';
      import {RightbarSeat} from './deepseek-harness/packages/client/ui-sidebar-right/src/client/shell/SidebarRight.tsx';
      import {ExpandButton} from './deepseek-harness/packages/client/ui-sidebar-right/src/client/shell/ExpandButton.tsx';
      import {createSidebarRightStore} from './deepseek-harness/packages/client/ui-sidebar-right/src/client/stores.ts';
      import {createLayoutStore} from './deepseek-harness/packages/client/ui-layout/src/client/stores.ts';
      import css from './plugins/benchgo/client/style.css';
      import mobileCss from './plugins/benchgo/client/mobile-workbench.css';
      import tokens from './deepseek-harness/packages/client/ui-theme/src/styles/design-platform.css';
      import theme from './deepseek-harness/packages/client/ui-theme/src/styles/base.css';
      import {installIconSprite} from './deepseek-harness/packages/client/ui-theme/src/client/icon-sprite.ts';
      installIconSprite({effect:effect=>effect(),on(){}},undefined);
      const layout=createLayoutStore().create(), sidebar=createSidebarRightStore(()=>({kind:'guide',title:'项目工作区'})).create();
      const hook=instance=>selector=>selector(useSyncExternalStore(instance.subscribe,instance.getSnapshot));
      const useStore=hook(layout),useSidebar=hook(sidebar),usePanelInfo=selector=>selector(useStore(state=>state.panelInfo));
      const sessionId='ordinary-project', t=key=>({'chrome.expandAria':'展开项目工作区','chrome.collapseAria':'收起项目工作区'}[key]||key);
      const occurrences=new Map(), occurrence=tab=>{if(!occurrences.has(tab.id))occurrences.set(tab.id,{id:tab.id,signal:new AbortController().signal,tabActions:{}});return occurrences.get(tab.id);};
      const emptyShortcuts=selector=>selector([]),types=selector=>selector([{id:'guide',kind:'guide'}]);
      const seat={sessionId,useStore:useSidebar,actions:sidebar.actions,t,useShortcuts:emptyShortcuts,useContextMenu:()=>({getTriggerProps:(_target,handlers)=>handlers||{}}),useContextMenuTarget:selector=>selector(undefined),useTabTypes:types,useTabNavigation:()=>({}),useFlash:selector=>selector(undefined),occurrence,retainTab:()=>()=>{},measureRoom:()=>{},reportAutoFullscreen:()=>{},openTab:()=>{},closeTab:()=>{},splitPane:()=>{},toggleFullscreen:()=>{}};
      const syncPresentation=({shown,track,fullscreen})=>shown?layout.actions.openRightbar(track,fullscreen):layout.actions.closeRightbar();
      function renderSlot(name,owner={}){
        if(name==='sidebar')return <aside className='cmd-shell-sidebar'><div className='cmd-projects'>普通项目</div></aside>;
        if(name==='main')return <section className='fixture-conversation'><header><h2>项目开发会话</h2><ExpandButton {...seat}/></header><p>继续开发这个项目。</p><textarea aria-label='会话草稿' defaultValue='保留的草稿'/></section>;
        if(name==='rightbar')return <RightbarSeat {...seat} {...owner} active syncPresentation={syncPresentation} renderSlot={(key)=>key.endsWith('.title')?'项目工作区':<div className='fixture-workspace'><nav>文件 · Git · 终端</nav><p>src / index.js</p></div>}/>;
        return null;
      }
      window.fixture={layout:layout.actions,sidebar:sidebar.actions,read:()=>layout.getSnapshot().layoutInfo};
      createRoot(document.getElementById('root')).render(<><style>{tokens}{theme}{css}{mobileCss}</style><ResponsiveAppFrame useStore={useStore} usePanelInfo={usePanelInfo} useSessions={selector=>selector({byId:{}})} useFoldedLandscape={selector=>selector(false)} actions={layout.actions} renderSlot={renderSlot} t={t}/></>);
    ` }, bundle: true, write: false, format: 'iife', outdir: join(root, 'artifacts/unused-workspace-rightbar'), jsx: 'automatic',
    alias: {
      react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')),
      '@deepseek-ai/dsh-client-store': join(root, 'deepseek-harness/packages/client/store/src/index.ts'),
      '@deepseek-ai/dsh-client-ui-dockkit': join(root, 'deepseek-harness/packages/client/ui-dockkit/src/index.ts'),
      '@deepseek-ai/dsh-client-ui-primitives': join(root, 'deepseek-harness/packages/client/ui-primitives/src/index.ts'),
    },
    nodePaths: [join(root, 'plugins/benchgo/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')],
    loader: { '.css': 'text', '.module.css': 'local-css', '.svg': 'text' },
    plugins: [{ name: 'workspace-fixture', setup(build) {
      build.onLoad({ filter: /benchgo[\\/]client[\\/]shell-ui\.jsx$/ }, async ({ path }) => ({ loader: 'jsx', resolveDir: dirname(path), contents: (await readFile(path, 'utf8')) + '\nexport {ResponsiveAppFrame};' }));
    } }, shellUi()],
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.DSH_CLIENT_TITLE': 'undefined', 'process.env.DSH_CLIENT_VERSION': 'undefined', 'process.env.DSH_CLIENT_COMMIT_HASH': 'undefined', 'process.env.DSH_CLIENT_GIT_DIRTY': 'undefined' }, logLevel: 'silent',
  });
  const browser = await chromium.launch({ headless: true, executablePath });
  const screenshots = process.env.BENCHGO_WORKSPACE_SCREENSHOTS;
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 850 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(5000); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<!doctype html><html><head><style>html,body,#root{height:100%;margin:0;font:14px/1.6 "Segoe UI",sans-serif}body{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}.fixture-conversation{height:100%;padding:16px;box-sizing:border-box}.fixture-conversation header{display:flex;justify-content:space-between;align-items:center}.fixture-workspace{padding:16px}.fixture-conversation textarea{display:block;width:80%;height:80px;font:inherit;color:inherit;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l3);border-radius:8px;padding:8px}</style></head><body><div id="root"></div></body></html>');
    await page.addScriptTag({ content: bundle.outputFiles.find(file => file.path.endsWith('.js')).text });
    for (const file of bundle.outputFiles.filter(file => file.path.endsWith('.css'))) await page.addStyleTag({ content: file.text });
    const frame = page.locator('.cmd-shell-frame'), panel = page.locator('[data-sidebar-right-panel]');
    const geometry = () => page.evaluate(() => ({
      tracks: getComputedStyle(document.querySelector('.cmd-shell-frame')).gridTemplateColumns.split(' ').map(parseFloat),
      center: document.querySelector('.fixture-conversation').getBoundingClientRect().toJSON(),
      panel: document.querySelector('[data-sidebar-right-panel]').getBoundingClientRect().toJSON(),
      layout: window.fixture.read(),
    }));
    const verifyOpen = async embedded => {
      await page.locator('[data-sidebar-right-panel][data-sidebar-right-open]').waitFor();
      await page.waitForFunction(() => window.fixture.read().rightbarShown);
      const value = await geometry();
      assert(value.tracks[2] >= 300, JSON.stringify(value));
      assert(Math.abs(value.center.right - value.panel.left) < 2, JSON.stringify(value));
      assert.equal(await page.locator('[data-side="rightbar"]').isVisible(), true);
      if (embedded) assert.equal(value.tracks[0], 0);
      assert.equal(await page.getByLabel('会话草稿').inputValue(), '保留的草稿');
    };
    await page.getByRole('button', { name: '展开项目工作区' }).click(); await verifyOpen(false);
    // The target workbench starts after its iframe has already mounted the shell.
    await page.evaluate(() => document.documentElement.setAttribute('data-resource-embedded', ''));
    await verifyOpen(true);
    const handle = page.locator('[data-side="rightbar"]'), box = await handle.boundingBox();
    const beforeDrag = (await geometry()).panel.width, x = box.x + box.width / 2, y = box.y + 160;
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x - 40, y, { steps: 5 }); await page.mouse.up();
    await page.waitForFunction(before => document.querySelector('[data-sidebar-right-panel]').getBoundingClientRect().width > before + 30, beforeDrag);
    await verifyOpen(true);
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => document.body.toggleAttribute('data-ds-dark-theme', theme === 'dark'), theme);
      for (const width of [1000, 800, 740, 710, 800, 1000]) {
        await page.setViewportSize({ width, height: 850 });
        await page.waitForFunction(width => window.fixture.read().viewportWidth === width, width);
        await page.evaluate(() => window.fixture.sidebar.setExpanded('ordinary-project', true));
        await panel.waitFor({ state: 'visible' });
        assert.equal(await panel.getAttribute('data-sidebar-right-panel'), width < 768 ? 'fullscreen' : 'push');
        if (width >= 768) await verifyOpen(true);
        else if (screenshots && width === 740) { await mkdir(screenshots, { recursive: true }); await page.screenshot({ path: join(screenshots, 'workspace-narrow-' + theme + '.png') }); }
      }
      await page.evaluate(() => window.fixture.sidebar.setExpanded('ordinary-project', false));
      await page.getByRole('button', { name: '展开项目工作区' }).waitFor();
      if (screenshots) { await mkdir(screenshots, { recursive: true }); await page.screenshot({ path: join(screenshots, 'workspace-entry-' + theme + '.png') }); }
      await page.getByRole('button', { name: '展开项目工作区' }).click(); await verifyOpen(true);
      if (screenshots) { await mkdir(screenshots, { recursive: true }); await page.screenshot({ path: join(screenshots, 'workspace-embedded-' + theme + '.png') }); }
    }
    await page.setViewportSize({ width: 1280, height: 850 });
    await page.evaluate(() => document.documentElement.removeAttribute('data-resource-embedded'));
    await page.waitForFunction(() => parseFloat(getComputedStyle(document.querySelector('.cmd-shell-frame')).gridTemplateColumns) >= 264);
    await verifyOpen(false);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
