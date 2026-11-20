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

test('mobile shell keeps one reachable drawer and restores taps and scrolling across header changes', { skip: !executablePath, timeout: 30000 }, async () => {
  const bundle = await build({
    stdin: { resolveDir: root, loader: 'jsx', contents: `
      import React, {useState, useSyncExternalStore} from 'react'; import {createRoot} from 'react-dom/client';
      import {AppFrame} from './deepseek-harness/packages/client/ui-layout/src/client/AppFrame.tsx';
      import {SidebarRoot} from './deepseek-harness/packages/client/ui-sidebar/src/client/SidebarRoot.tsx';
      import {ConversationHeader} from './deepseek-harness/packages/client/ui-conversation/src/client/skeleton/ConversationHeader.tsx';
      import {createLayoutStore} from './deepseek-harness/packages/client/ui-layout/src/client/stores.ts';
      import {applyMobileWorkbench} from './plugins/base/client/mobile-workbench.jsx';
      import {mobileLayoutSnapshot, subscribeMobileLayout} from './plugins/base/client/responsive-layout.mjs';
      import styles from './plugins/base/client/style.css';
      import tokens from './deepseek-harness/packages/client/ui-theme/src/styles/design-platform.css';
      import theme from './deepseek-harness/packages/client/ui-theme/src/styles/base.css';
      const layout = createLayoutStore().create(), slots = new Map(), nothing = select => select([]), absent = () => undefined, t = key => key;
      const ctx = {layout:layout.actions, effect:fn=>fn(), slots:{inject:(_name, fn)=>fn(), register:(entry, component)=>slots.set(entry.name,component)}};
      applyMobileWorkbench(ctx);
      const useStore = select => select(useSyncExternalStore(layout.subscribe, layout.getSnapshot));
      const MobileWorkbench = slots.get('shell.overlay'), Leading = slots.get('conversation.header.leading');
      function Fixture() {
        const [activePanelId, selectPanel] = useState(null);
        const mobileNavigation = useSyncExternalStore(subscribeMobileLayout, mobileLayoutSnapshot);
        const usePanelInfo = select => select({activePanelId});
        const renderSlot = (name, props) => {
          if (name === 'shell.overlay') return <MobileWorkbench ctx={ctx}/>;
          if (name === 'sidebar') return <SidebarRoot {...props} usePanels={nothing} useEntryPins={nothing} useEntryActions={()=>false}
            useRemoteAccess={()=>true} useShortcuts={nothing} usePanelInfo={usePanelInfo} t={t} toggleSidebar={layout.actions.toggleSidebar}
            renderFactorySlot={()=>null} renderSlot={key=>key==='sidebar.workspaces' && <section className="cmd-projects">
              <nav className="cmd-sidebar-nav" aria-label="快捷工具栏">
                <button className="dsh-device-launcher">连接</button><button className="dsh-device-launcher-target">设备中心</button>
                <div className="dsh-device-switch"><button>切换设备</button></div><button>新聊天</button>
              </nav>
              <div className="cmd-sidebar-content"><button className="ba-card" onClick={()=>selectPanel('assistant')}>SuperAgent</button>
              <button className="cmd-session" onClick={()=>selectPanel(null)}>普通对话</button></div></section>}/>;
          if (name === 'main') return <div className="fixture-main">
            {!activePanelId && <ConversationHeader useSession={absent} useConversation={absent} renderSlot={()=> <Leading/>}/>}
            <section key={activePanelId ?? 'chat'} data-conversation-scroll=""><h1>{activePanelId ? 'SuperAgent 聊天' : '普通对话聊天'}</h1>
              <button onClick={event=>{event.currentTarget.textContent='已点按'}}>点按正文</button>
              {Array.from({length:50},(_,i)=><p key={i}>消息 {i+1}</p>)}</section></div>;
          return null;
        };
        return <><style>{tokens}{theme}{styles}</style><AppFrame mobileNavigation={mobileNavigation} useStore={useStore} useSessions={select=>select({byId:{}})}
          usePanelInfo={usePanelInfo} useFoldedLandscape={()=>false} actions={layout.actions} renderSlot={renderSlot} t={t}/></>;
      }
      createRoot(document.getElementById('root')).render(<Fixture/>);
    ` },
    bundle: true, write: false, format: 'iife', outdir: join(root, 'artifacts/unused-mobile-workbench'), jsx: 'automatic',
    alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')),
      '@deepseek-ai/dsh-client-store': join(root, 'deepseek-harness/packages/client/store/src/index.ts'),
      '@deepseek-ai/dsh-client-ui-primitives': join(root, 'deepseek-harness/packages/client/ui-primitives/src/index.ts') },
    nodePaths: [join(root, 'plugins/base/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')],
    loader: { '.css': 'text', '.module.css': 'local-css', '.svg': 'text' },
    plugins: [{ name: 'unused-device-launcher', setup(build) {
      build.onResolve({ filter: /device-launcher\.jsx$/ }, () => ({ path: 'launcher', namespace: 'fixture' }));
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const DeviceLauncher = () => null;' }));
    } }, shellUi()],
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.DSH_CLIENT_TITLE': 'undefined', 'process.env.DSH_CLIENT_VERSION': 'undefined', 'process.env.DSH_CLIENT_COMMIT_HASH': 'undefined', 'process.env.DSH_CLIENT_GIT_DIRTY': 'undefined' }, logLevel: 'silent',
  });
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 780 }, isMobile: true, hasTouch: true });
    page.setDefaultTimeout(4000);
    await page.route('http://workbench.test/', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>
      html,body,#root{height:100%;margin:0}.fixture-main{height:100%;display:flex;flex-direction:column}[data-conversation-scroll]{min-height:0;flex:1;overflow:auto;padding:12px}h1{margin:0 0 12px}
      </style><div id="root"></div>` }));
    await page.goto('http://workbench.test/');
    for (const file of bundle.outputFiles.filter(file => file.path.endsWith('.css'))) await page.addStyleTag({ content: file.text });
    await page.addScriptTag({ content: bundle.outputFiles.find(file => file.path.endsWith('.js')).text });
    const toggle = page.locator('.cmd-mobile-navigation > button');
    const drawer = page.locator('[data-plus-sidebar]');
    const mask = page.locator('.cmd-mobile-drawer-mask');
    const scroll = page.locator('[data-conversation-scroll]');
    const cdp = await page.context().newCDPSession(page);
    for (const [theme, entry, heading] of [['light', 'SuperAgent', 'SuperAgent 聊天'], ['dark', '普通对话', '普通对话聊天']]) {
      await page.emulateMedia({ colorScheme: theme });
      await page.locator('body').evaluate((node, dark) => node.toggleAttribute('data-ds-dark-theme', dark), theme === 'dark');
      await toggle.tap();
      await page.getByRole('button', { name: '收起侧边栏', exact: true }).waitFor();
      assert.equal(await page.locator('[data-sidebar-mask]').count(), 0);
      await page.waitForFunction(() => document.querySelector('[data-plus-sidebar]').getBoundingClientRect().x === 0);
      const toolbar = drawer.getByRole('navigation', { name: '快捷工具栏' });
      assert.deepEqual(await toolbar.getByRole('button').allTextContents(), ['新聊天']);
      const bar = await toggle.boundingBox();
      assert.equal((await drawer.boundingBox()).y, bar.y + bar.height);
      assert.equal((await mask.boundingBox()).y, bar.y + bar.height);
      const screenshots = process.env.BENCHGO_MOBILE_SCREENSHOTS;
      if (screenshots) { await mkdir(screenshots, { recursive: true }); await page.screenshot({ path: join(screenshots, `${theme}-drawer.png`) }); }
      await drawer.getByRole('button', { name: entry, exact: true }).tap();
      await page.getByRole('heading', { name: heading }).waitFor();
      await mask.waitFor({ state: 'detached' });
      await page.getByRole('button', { name: '点按正文', exact: true }).tap();
      await page.getByRole('button', { name: '已点按', exact: true }).waitFor();
      if (theme === 'light') assert.equal((await scroll.boundingBox()).y, bar.y + bar.height);
      const scrollBox = await scroll.boundingBox();
      assert(await scroll.evaluate(node => node.scrollHeight > node.clientHeight), 'conversation has overflowing messages');
      await scroll.evaluate(node => node.addEventListener('scrollend', () => { node.dataset.scrollEnded = ''; }, { once: true }));
      const x = Math.round(scrollBox.x + scrollBox.width / 2), y = Math.round(scrollBox.y + Math.min(scrollBox.height - 20, 400));
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      for (let offset = 30; offset <= 240; offset += 30) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - offset }] });
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.waitForFunction(() => document.querySelector('[data-conversation-scroll]').scrollTop > 50);
      await scroll.and(page.locator('[data-scroll-ended]')).waitFor();
    }
    await toggle.tap();
    await page.getByRole('button', { name: '收起侧边栏', exact: true }).tap();
    await mask.waitFor({ state: 'detached' });
    await page.getByRole('button', { name: '打开侧边栏', exact: true }).tap();
    await mask.tap({ position: { x: 375, y: 300 } });
    await mask.waitFor({ state: 'detached' });
    await page.getByRole('button', { name: '打开侧边栏', exact: true }).waitFor();
  } finally { await browser.close(); }
});
