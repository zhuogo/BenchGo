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

for (const reducedMotion of ['reduce', 'no-preference']) test('ordinary project workspace preserves its official rightbar, entry and resize across embedded navigation (' + reducedMotion + ')', { skip: !executablePath }, async () => {
  const bundle = await build({
    stdin: { resolveDir: root, loader: 'jsx', contents: `
      import React,{useSyncExternalStore} from 'react';import {createRoot} from 'react-dom/client';
      import {ResponsiveAppFrame} from './plugins/base/client/shell-ui.jsx';
      import {RightbarSeat} from './deepseek-harness/packages/client/ui-sidebar-right/src/client/shell/SidebarRight.tsx';
      import {RightbarRoot} from './deepseek-harness/packages/client/ui-sidebar-right/src/client/shell/RightbarRoot.tsx';
      import {ExpandButton} from './deepseek-harness/packages/client/ui-sidebar-right/src/client/shell/ExpandButton.tsx';
      import {ConversationHeader} from './deepseek-harness/packages/client/ui-conversation/src/client/skeleton/ConversationHeader.tsx';
      import {ConversationSessionHeader} from './deepseek-harness/packages/client/ui-conversation/src/client/skeleton/ConversationSession.tsx';
      import {createSidebarRightStore} from './deepseek-harness/packages/client/ui-sidebar-right/src/client/stores.ts';
      import {createLayoutStore} from './deepseek-harness/packages/client/ui-layout/src/client/stores.ts';
      import css from './plugins/base/client/style.css';
      import mobileCss from './plugins/base/client/mobile-workbench.css';
      import tokens from './deepseek-harness/packages/client/ui-theme/src/styles/design-platform.css';
      import theme from './deepseek-harness/packages/client/ui-theme/src/styles/base.css';
      import {installIconSprite} from './deepseek-harness/packages/client/ui-theme/src/client/icon-sprite.ts';
      installIconSprite({effect:effect=>effect(),on(){}},undefined);
      const sessionId='ordinary-project',seed=()=>({kind:'guide',title:'项目工作区'});
      if(!localStorage.getItem('dsh.sidebar-right.v1.'+sessionId))createSidebarRightStore(seed).create(sessionId).actions.setExpanded(sessionId,true);
      const layout=createLayoutStore().create(), sidebar=createSidebarRightStore(seed).create(sessionId);
      const hook=instance=>selector=>selector(useSyncExternalStore(instance.subscribe,instance.getSnapshot));
      const useStore=hook(layout),useSidebar=hook(sidebar),usePanelInfo=selector=>selector(useStore(state=>state.panelInfo));
      const t=key=>({'chrome.expandAria':'展开项目工作区','chrome.collapseAria':'收起项目工作区'}[key]||key);
      const views=[{sessionId,reference:{},selected:true,retainTab:()=>()=>{}}];
      const useViews=selector=>selector(views),mountView=()=>()=>{},SessionProvider=({children})=>children;
      const occurrences=new Map(), occurrence=tab=>{if(!occurrences.has(tab.id))occurrences.set(tab.id,{id:tab.id,signal:new AbortController().signal,tabActions:{}});return occurrences.get(tab.id);};
      const emptyShortcuts=selector=>selector([]),types=selector=>selector([{id:'guide',kind:'guide'}]);
      const seat={sessionId,useStore:useSidebar,actions:sidebar.actions,t,useShortcuts:emptyShortcuts,useContextMenu:()=>({getTriggerProps:(_target,handlers)=>handlers||{}}),useContextMenuTarget:selector=>selector(undefined),useTabTypes:types,useTabNavigation:()=>({}),useFlash:selector=>selector(undefined),occurrence,retainTab:()=>()=>{},measureRoom:()=>{},reportAutoFullscreen:()=>{},openTab:()=>{},closeTab:()=>{},splitPane:()=>{},toggleFullscreen:()=>{}};
      const syncPresentation=({shown,track,fullscreen})=>shown?layout.actions.openRightbar(track,fullscreen):layout.actions.closeRightbar();
      const session={blank:false,openState:'open'},conversation={messages:[{}]},sessions={byId:{[sessionId]:{id:sessionId,displayTitle:'项目开发会话',retainedBy:{mainView:1}}}};
      const header={sessionId,t,useSessions:select=>select(sessions),useSession:select=>select(session),useConversation:select=>select(conversation),useConversationViews:select=>select([{id:'chat',label:'对话'}]),useStore:select=>select({view:'chat'}),useContextMenu:seat.useContextMenu,useEntryPins:select=>select([]),useEntryActions:select=>select(false),open(){},selectView(){},setPinned(){},renderFactorySlot:()=> <button type='button' aria-label='更多操作'>···</button>};
      function renderHeader(name,owner={}){
        if(name==='conversation.session.header')return <ConversationSessionHeader {...header} {...owner} renderSlot={renderHeader}/>;
        if(name==='conversation.session.header.corner')return <ExpandButton {...seat}/>;
        if(name==='conversation.session.header.utilities')return <button type='button' aria-label='底部工作台'>▤</button>;
        return null;
      }
      function renderSlot(name,owner={}){
        if(name==='sidebar')return <aside className='cmd-shell-sidebar'><div className='cmd-projects'>普通项目</div></aside>;
        if(name==='main')return <section className='fixture-conversation'><ConversationHeader {...header} renderSlot={renderHeader}/><p>继续开发这个项目。</p><textarea aria-label='会话草稿' defaultValue='保留的草稿'/></section>;
        if(name==='rightbar')return <RightbarRoot {...owner} usePanelInfo={usePanelInfo} useViews={useViews} mountView={mountView} SessionProvider={SessionProvider} renderSlot={(_name,props)=><RightbarSeat {...seat} {...props} syncPresentation={syncPresentation} renderSlot={(key)=>key.endsWith('.title')?'项目工作区':<div className='fixture-workspace'><nav>文件 · Git · 终端</nav><p>src / index.js</p></div>}/>}/>;
        return null;
      }
      window.fixture={layout:layout.actions,sidebar:sidebar.actions,restored:sidebar.getSnapshot().bySession[sessionId]?.layout.expanded,read:()=>layout.getSnapshot().layoutInfo};
      // A restored expanded Session has no header expand button to recover it.
      // Its root must report the initial presentation before the first interaction.
      document.documentElement.setAttribute('data-windows-titlebar','');
      document.documentElement.style.setProperty('--dsh-windows-titlebar-height','40px');
      const root=createRoot(document.getElementById('root'));let generation=0;
      const mount=()=>root.render(<React.Fragment key={generation++}><style>{tokens}{theme}{css}{mobileCss}</style><ResponsiveAppFrame useStore={useStore} usePanelInfo={usePanelInfo} useSessions={selector=>selector({byId:{}})} useFoldedLandscape={selector=>selector(false)} actions={layout.actions} renderSlot={renderSlot} t={t}/></React.Fragment>);
      window.fixture.remount=mount;mount();
    ` }, bundle: true, write: false, format: 'iife', outdir: join(root, 'artifacts/unused-workspace-rightbar'), jsx: 'automatic',
    alias: {
      react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')),
      '@deepseek-ai/dsh-client-store': join(root, 'deepseek-harness/packages/client/store/src/index.ts'),
      '@deepseek-ai/dsh-client-ui-dockkit': join(root, 'deepseek-harness/packages/client/ui-dockkit/src/index.ts'),
      '@deepseek-ai/dsh-client-ui-primitives': join(root, 'deepseek-harness/packages/client/ui-primitives/src/index.ts'),
    },
    nodePaths: [join(root, 'plugins/base/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')],
    loader: { '.css': 'text', '.module.css': 'local-css', '.svg': 'text' },
    plugins: [{ name: 'workspace-fixture', setup(build) {
      build.onLoad({ filter: /base[\\/]client[\\/]shell-ui\.jsx$/ }, async ({ path }) => ({ loader: 'jsx', resolveDir: dirname(path), contents: (await readFile(path, 'utf8')) + '\nexport {ResponsiveAppFrame};' }));
    } }, shellUi()],
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.DSH_CLIENT_TITLE': 'undefined', 'process.env.DSH_CLIENT_VERSION': 'undefined', 'process.env.DSH_CLIENT_COMMIT_HASH': 'undefined', 'process.env.DSH_CLIENT_GIT_DIRTY': 'undefined' }, logLevel: 'silent',
  });
  const browser = await chromium.launch({ headless: true, executablePath });
  const screenshots = process.env.BENCHGO_WORKSPACE_SCREENSHOTS;
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 850 }, reducedMotion });
    page.setDefaultTimeout(5000); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://workspace.test/',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><style>html,body,#root{height:100%;margin:0;font:14px/1.6 "Segoe UI",sans-serif}body{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}.fixture-conversation{height:100%;box-sizing:border-box}.fixture-workspace{padding:16px}.fixture-conversation textarea{display:block;width:80%;height:80px;font:inherit;color:inherit;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l3);border-radius:8px;padding:8px}</style></head><body><div id="root"></div></body></html>'}));
    await page.goto('http://workspace.test/');
    const mount=async()=>{
      for (const file of bundle.outputFiles.filter(file => file.path.endsWith('.css'))) await page.addStyleTag({ content: file.text });
      await page.addScriptTag({ content: bundle.outputFiles.find(file => file.path.endsWith('.js')).text });
    };
    await mount();
    const panel = page.locator('[data-sidebar-right-panel]');
    const geometry = () => page.evaluate(() => ({
      tracks: getComputedStyle(document.querySelector('.cmd-shell-frame')).gridTemplateColumns.split(' ').map(parseFloat),
      center: document.querySelector('.fixture-conversation').getBoundingClientRect().toJSON(),
      panel: document.querySelector('[data-sidebar-right-panel]').getBoundingClientRect().toJSON(),
      layout: window.fixture.read(),
    }));
    const verifyOpen = async embedded => {
      await page.locator('[data-sidebar-right-panel][data-sidebar-right-open]').waitFor();
      await page.waitForFunction(() => window.fixture.read().rightbarShown);
      await page.locator('.fixture-workspace').waitFor({state:'visible'});
      await page.getByRole('button',{name:'收起项目工作区'}).waitFor({state:'visible'});
      await page.waitForFunction(embedded => {
        const frame=document.querySelector('.cmd-shell-frame'),tracks=getComputedStyle(frame).gridTemplateColumns.split(' ').map(parseFloat);
        const center=document.querySelector('.fixture-conversation').getBoundingClientRect(),panel=document.querySelector('[data-sidebar-right-panel]').getBoundingClientRect();
        return tracks[2]>=300 && Math.abs(center.right-panel.left)<2 && (!embedded || tracks[0]===0);
      },embedded);
      const value = await geometry();
      assert(value.tracks[2] >= 300, JSON.stringify(value));
      assert(Math.abs(value.center.right - value.panel.left) < 2, JSON.stringify(value));
      assert.equal(await page.locator('[data-side="rightbar"]').isVisible(), true);
      if (embedded) assert.equal(value.tracks[0], 0);
      assert.equal(await page.getByLabel('会话草稿').inputValue(), '保留的草稿');
    };
    const verifyMotion = async () => {
      const movement=await page.evaluate(async()=>{
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        const frame=document.querySelector('.cmd-shell-frame');
        const transitions=frame.getAnimations({subtree:true}).filter(animation=>'transitionProperty' in animation);
        const track=transitions.find(animation=>animation.effect.target===frame && animation.transitionProperty==='grid-template-columns');
        const slide=transitions.find(animation=>animation.transitionProperty==='transform' && animation.effect.target.matches('[data-dockkit-host="dock"],[data-dockkit-empty]'));
        if(!track || !slide)return {track:!!track,slide:!!slide};
        for(const animation of transitions){animation.pause();animation.currentTime=animation.effect.getTiming().duration/2;}
        const center=document.querySelector('.fixture-conversation').getBoundingClientRect(),pane=slide.effect.target.getBoundingClientRect();
        const duration=animation=>animation.effect.getTiming().duration,easing=animation=>animation.effect.getTiming().easing;
        return {track:true,slide:true,centerEdge:center.right,paneEdge:pane.left,duration:duration(track),slideDuration:duration(slide),easing:easing(track),slideEasing:easing(slide)};
      });
      if(reducedMotion==='reduce')assert.deepEqual(movement,{track:false,slide:false});
      else {
        assert.equal(movement.track,true,'conversation width must transition with the sidebar');
        assert.equal(movement.slide,true,'the official panel slide stays enabled');
        assert.equal(movement.duration,movement.slideDuration);
        assert.equal(movement.easing,movement.slideEasing);
        assert(Math.abs(movement.centerEdge-movement.paneEdge)<2,JSON.stringify(movement));
        if(screenshots){await mkdir(screenshots,{recursive:true});await page.screenshot({path:join(screenshots,'workspace-motion-midpoint.png')});}
        await page.evaluate(()=>document.querySelector('.cmd-shell-frame').getAnimations({subtree:true}).filter(animation=>'transitionProperty' in animation).forEach(animation=>animation.finish()));
      }
    };
    assert.equal(await page.evaluate(()=>window.fixture.restored),true,'a fresh session store restores the saved expanded state');
    await verifyOpen(false);
    assert.equal(await page.locator('[data-sidebar-right-expand]').count(), 0);
    await page.getByRole('button',{name:'收起项目工作区'}).click();
    await verifyMotion();
    await page.getByRole('button',{name:'展开项目工作区'}).waitFor();
    await page.reload();await mount();
    assert.equal(await page.evaluate(()=>window.fixture.restored),false,'reload preserves an explicitly collapsed session');
    await page.getByRole('button', { name: '展开项目工作区' }).click(); await verifyMotion(); await verifyOpen(false);
    await page.reload();await mount();await verifyOpen(false);
    assert.equal(await page.evaluate(()=>window.fixture.restored),true,'reload restores an expanded session without a shortcut');
    await page.evaluate(()=>window.fixture.remount());await verifyOpen(false);
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
      await page.getByRole('button',{name:'收起项目工作区'}).click();
      await page.getByRole('button', { name: '展开项目工作区' }).waitFor();
      if (screenshots && reducedMotion === 'reduce') { await mkdir(screenshots, { recursive: true }); await page.screenshot({ path: join(screenshots, 'workspace-entry-' + theme + '.png') }); }
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
