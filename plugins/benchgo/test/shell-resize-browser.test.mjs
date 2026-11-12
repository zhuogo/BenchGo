import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { shellUi } from '../scripts/shell-ui.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url));
const { chromium } = require('playwright');
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || [chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);

test('real shell resizes both columns directly and scopes the Windows fullscreen axis to its consumer', { skip: !executablePath }, async () => {
  const bundle = await build({
    stdin: { resolveDir: root, loader: 'jsx', contents: `
      import React, {useSyncExternalStore} from 'react'; import {createRoot} from 'react-dom/client';
      import {AppFrame} from './deepseek-harness/packages/client/ui-layout/src/client/AppFrame.tsx';
      import {SidebarRoot} from './deepseek-harness/packages/client/ui-sidebar/src/client/SidebarRoot.tsx';
      import css from './plugins/benchgo/client/style.css';
      const listeners=new Set(); let state={layoutInfo:{sidebar:280,viewportWidth:1440,narrowExpanded:false,rightbar:400,rightbarShown:true,rightbarTrack:true,rightbarFullscreen:false,rightbarInstant:false}};
      const subscribe=fn=>{listeners.add(fn);return()=>listeners.delete(fn)};
      const update=patch=>{state={layoutInfo:{...state.layoutInfo,...patch}};for(const fn of listeners)fn()};
      const actions={setViewportWidth:viewportWidth=>{if(viewportWidth!==state.layoutInfo.viewportWidth)update({viewportWidth})},setSidebar:px=>update({sidebar:Math.min(400,Math.max(200,px))}),setRightbar:px=>update({rightbar:Math.min(900,Math.max(300,px))}),toggleSidebar:()=>update({sidebar:state.layoutInfo.sidebar===0?280:0})}; window.actions=actions;
      const useStore=select=>select(useSyncExternalStore(subscribe,()=>state)),usePanelInfo=select=>select({activePanelId:null}),useSessions=select=>select({byId:{}});
      const panels=[{id:'plugins',label:'工具'},{id:'schedules',label:'自动化任务'}];
      function sidebarSlot(name,p={}){if(name==='sidebar.settings')return <button>设置</button>;if(name!=='sidebar.workspaces')return null;return <section className={'cmd-projects '+(p.wide?'':'cmd-narrow')}><nav className='cmd-sidebar-nav'><button>连接</button><button>搜索</button></nav>{p.panelNavigation}{p.wide&&<div className='cmd-sidebar-content'>{Array.from({length:100},(_,i)=><div key={i} className='cmd-session-row'><button className='cmd-session'><span>会话 {i+1}：继续讨论产品与实现</span></button></div>)}</div>}</section>}
      const main=<div className='fixture-conversation'><h2>工作会话</h2>{Array.from({length:60},(_,i)=><article key={i}><p>第 {i+1} 条消息。拖动两侧边界时正文随实际宽度排版，滚动、选择和输入仍由原来的容器负责。</p><pre>const result = await readState();</pre></article>)}</div>;
      function renderSlot(name,p){if(name==='sidebar')return <SidebarRoot {...p} toggleSidebar={actions.toggleSidebar} startSession={()=>{}} setPinned={()=>{}} trackEntryClick={()=>{}} selectPanel={()=>{}} usePanels={s=>s(panels)} useEntryPins={s=>s([])} useEntryActions={s=>s(false)} useRemoteAccess={()=>true} useShortcuts={s=>s([])} usePanelInfo={usePanelInfo} t={k=>k} renderFactorySlot={()=>null} renderSlot={sidebarSlot}/>;if(name==='main')return main;if(name==='rightbar')return <div className='fixture-rightbar' style={{width:p.width}}><h3>看板</h3>{Array.from({length:12},(_,i)=><p key={i}>任务 {i+1} · 正在执行</p>)}</div>;return null}
      createRoot(document.getElementById('app')).render(<><style>{css}</style><AppFrame useStore={useStore} useSessions={useSessions} usePanelInfo={usePanelInfo} useFoldedLandscape={s=>s(false)} actions={actions} renderSlot={renderSlot} t={k=>k}/></>);
    ` }, bundle: true, write: false, format: 'iife', jsx: 'automatic',
    alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')) },
    nodePaths: [join(root, 'plugins/benchgo/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')], loader: { '.css': 'text' },
    plugins: [{ name: 'fixture-primitives', setup(build) {
      build.onResolve({ filter: /^@deepseek-ai\/dsh-client-ui-primitives$/ }, () => ({ path: 'primitives', namespace: 'fixture' }));
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ loader: 'jsx', contents: `import React from 'react';const Icon=()=> <svg width="16" height="16"/>;export const FishLogo=Icon,IconAppsAddOutlineRegular=Icon,IconNewChatOutlineMedium=Icon,IconNewChatOutlineRegular=Icon,IconPanelLeftOutlineRegular=Icon,IconPinFillRegular=Icon;export const Tooltip=({children})=>children,Menu=()=>null,ShortcutKeys=()=>null,Toast=()=>null;export const useModalLayer=()=>{},isBehindModal=()=>false,isDarwinDesktop=()=>false,focusWithoutRing=el=>el.focus(),writeClipboard=async()=>true;` }));
    } }, shellUi()], define: { 'process.env.NODE_ENV': '"production"', 'process.env.DSH_CLIENT_TITLE': 'undefined', 'process.env.DSH_CLIENT_VERSION': 'undefined', 'process.env.DSH_CLIENT_COMMIT_HASH': 'undefined', 'process.env.DSH_CLIENT_GIT_DIRTY': 'undefined' }, logLevel: 'silent',
  });
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent(`<!doctype html><html data-windows-titlebar><head><style>
      html,body,#app{height:100%;margin:0;font:14px/1.6 'Segoe UI',sans-serif}*{box-sizing:border-box}button{font:inherit}
      :root{--dsw-alias-bg-base:#fff;--dsw-specific-sidebar-fill:#f4f5f7;--dsw-alias-label-primary:#222;--dsw-alias-label-secondary:#777;--dsw-alias-interactive-bg-hover:#8881;--dsh-windows-titlebar-height:36px;--ds-transition-duration-slow:300ms;--ds-ease-in-out:ease-in-out}
      html[data-dark]{--dsw-alias-bg-base:#19191b;--dsw-specific-sidebar-fill:#222225;--dsw-alias-label-primary:#ededee;--dsw-alias-label-secondary:#a3a3a8}
      body{color:var(--dsw-alias-label-primary)}.fixture-conversation{height:100%;overflow:auto;padding:16px}.fixture-conversation article{padding:12px 16px;border-radius:16px;background:#8881;margin-bottom:16px}
      .fixture-rightbar{position:absolute;right:0;height:100%;overflow:auto;padding:16px;background:var(--dsw-specific-sidebar-fill)}
      .fixture-rightbar[data-fullscreen]{width:100vw!important}html[data-windows-titlebar] .fixture-rightbar[data-fullscreen]{max-width:calc(100vw - var(--dsh-windows-sidebar-width))}
    </style></head><body><div id="app"></div></body></html>`);
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.locator('[data-side="sidebar"]').waitFor();
    const frame = page.locator('.cmd-shell-frame');
    for (const side of ['sidebar', 'rightbar']) {
      const handle = page.locator('[data-side="' + side + '"]'), box = await handle.boundingBox();
      const start = box.x + box.width / 2, target = start + (side === 'sidebar' ? 60 : -60), y = box.y + 200;
      await page.mouse.move(start, y); await page.mouse.down();
      await page.mouse.move(target, y, { steps: 8 });
      await page.waitForFunction(({ side, target }) => {
        const rect = document.querySelector('[data-side="' + side + '"]').getBoundingClientRect();
        return Math.abs(rect.x + rect.width / 2 - target) < 1;
      }, { side, target });
      assert.equal(await frame.getAttribute('data-dragging'), 'true');
      assert.equal(await frame.evaluate(node => getComputedStyle(node).transitionDuration), '0s');
      await page.mouse.up();
      await page.waitForFunction(() => !document.querySelector('.cmd-shell-frame').hasAttribute('data-dragging'));
    }
    const axis = await page.evaluate(() => ({
      frame: getComputedStyle(document.querySelector('.cmd-shell-frame')).getPropertyValue('--dsh-windows-sidebar-width'),
      main: getComputedStyle(document.querySelector('.fixture-conversation')).getPropertyValue('--dsh-windows-sidebar-width'),
      rightbar: getComputedStyle(document.querySelector('[data-rightbar-col]')).getPropertyValue('--dsh-windows-sidebar-width'),
    }));
    assert.equal(axis.frame, ''); assert.equal(axis.main, ''); assert.equal(axis.rightbar, '340px');
    await page.evaluate(() => document.querySelector('.fixture-rightbar').setAttribute('data-fullscreen', ''));
    assert.equal(Math.round((await page.locator('.fixture-rightbar').boundingBox()).width), 1100);
    await page.evaluate(() => { document.documentElement.removeAttribute('data-windows-titlebar'); window.actions.setSidebar(300); });
    await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-rightbar-col]')).getPropertyValue('--dsh-windows-sidebar-width') === '');
    assert.equal(Math.round((await page.locator('.fixture-rightbar').boundingBox()).width), 1440);
    await page.evaluate(() => { document.documentElement.setAttribute('data-windows-titlebar', ''); window.actions.setSidebar(340); });
    await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-rightbar-col]')).getPropertyValue('--dsh-windows-sidebar-width') === '340px');
    await page.evaluate(() => document.querySelector('.fixture-rightbar').removeAttribute('data-fullscreen'));
    for (let count = 0; count < 6; count++) {
      await page.evaluate(() => window.actions.toggleSidebar());
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.cmd-shell-frame')).transitionDuration === '0s');
    }
    assert.equal(await page.locator('.cmd-session').count(), 100);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(() => document.documentElement.setAttribute('data-dark', ''));
    assert.equal(await frame.evaluate(node => getComputedStyle(node).transitionDuration), '0s');
    if (process.env.BENCHGO_SHELL_SCREENSHOTS) {
      await mkdir(process.env.BENCHGO_SHELL_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: join(process.env.BENCHGO_SHELL_SCREENSHOTS, 'shell-resize-dark.png') });
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
