import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { shellUi } from '../../scripts/shell-ui.mjs';
import { sharedUiStyles } from '../../scripts/shared-ui.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const require = createRequire(new URL('../../../../deepseek-harness/apps/web/package.json', import.meta.url));
const { chromium } = require('playwright');
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || [chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const screenshotDirectory = process.env.ASSISTANT_SESSION_SURFACE_SCREENSHOTS
  ? join(root, 'artifacts/assistant-session-surface-20261115') : undefined;

test('assistant session surfaces share official file panes, corner and lifecycle without taking mainView ownership', { skip: !executablePath, timeout: 90000 }, async () => {
  const bundle = await build({
    stdin: { resolveDir: root, loader: 'jsx', contents: `
      import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
      import {Context} from '@deepseek-ai/cordis';
      import {SlotRegistry} from './deepseek-harness/packages/client/ui-renderer/src/client/registry.ts';
      import {createSlotRenderer} from './deepseek-harness/packages/client/ui-renderer/src/client/scoped-slots.tsx';
      import * as uiSession from './deepseek-harness/packages/client/ui-session/src/client/index.ts';
      import * as uiLayout from './deepseek-harness/packages/client/ui-layout/src/client/index.ts';
      import * as uiMenus from './deepseek-harness/packages/client/ui-context-menu/src/client/index.ts';
      import * as uiRightbar from './deepseek-harness/packages/client/ui-sidebar-right/src/client/index.ts';
      import {LocaleRuntime} from './deepseek-harness/packages/client/locale/src/client/index.ts';
      import {TestSessions} from './deepseek-harness/packages/test-support/client-runtime/src/sessions.ts';
      import {TestRemote} from './deepseek-harness/packages/test-support/client-runtime/src/remote.ts';
      import {allowAllAccessPlugin} from './deepseek-harness/packages/test-support/client-runtime/src/access.ts';
      import {createSnapshotStore} from '@deepseek-ai/dsh-client-store';
      import {mountWorkbenchRightbarLifecycle} from './plugins/base/workbench/client/rightbar-lifecycle.jsx';
      import {mountWorkbenchSessionSurface,activateWorkbenchSessionSurface,workbenchSessionSurfaceChildren,WORKBENCH_SESSION_CORNER} from './plugins/base/workbench/client/session-surface.jsx';
      import {AssistantConversation,assistantConversationChildren,ASSISTANT_CONVERSATION_SLOT,mountAssistantConversation} from './plugins/superagent/client/conversation.jsx';
      import {ActivityProvider,ActivityPanel} from './plugins/superagent/client/activity-panel.jsx';
      import {installIconSprite} from './deepseek-harness/packages/client/ui-theme/src/client/icon-sprite.ts';
      import {ResponsiveAppFrame} from './plugins/base/client/shell-ui.jsx';
      import css from './plugins/base/client/style.css';
      import assistantCss from './plugins/superagent/client/style.css';
      import tokens from './deepseek-harness/packages/client/ui-theme/src/styles/design-platform.css';
      import theme from './deepseek-harness/packages/client/ui-theme/src/styles/base.css';
      window.ready=(async()=>{
        const style=document.createElement('style');style.textContent=tokens+theme+css;document.head.append(style);
        const productionHeader=location.search.includes('production-header');
        const ctx=new Context();await ctx.plugin(SlotRegistry).await();installIconSprite(ctx,undefined);
        const slots=ctx.slots,renderer=createSlotRenderer();let host;
        slots.install({renderRoot(value,owner){host=value;return renderer.renderRoot(value,owner);}});
        const sessions=new TestSessions(async fn=>{await fn();},ctx);ctx.provide('sessions',sessions);new TestRemote(ctx);
        await ctx.plugin(allowAllAccessPlugin).await();await ctx.plugin(uiSession).await();
        ctx.provide('uiConversation',{binding:()=>({activate(){}})});
        const locale=new LocaleRuntime(ctx);locale.setLocale('en');ctx.provide('locale',locale);slots.installLocale(locale);
        ctx.provide('shortcuts',{runtime:'desktop',register:()=>()=>{},catalog:createSnapshotStore([])});
        ctx.provide('theme',{getTheme:()=>({preference:'light',active:{colorScheme:'light',tokens:{}},fontSizes:{text:14,code:13,terminal:13},fontFamilies:{text:'',code:'',terminal:''}})});
        ctx.provide('resources',{pin(){}});
        await ctx.plugin(uiLayout).await();await ctx.plugin(uiMenus).await();
        for(const id of ['normal','router','side'])await sessions.add({id});
        const normal=sessions.retainFor(ctx,'normal',{source:'mainView'});await normal.ready;
        const selection=createSnapshotStore(undefined);let auxiliary;
        const assistantConfig={name:'BenchGo',revision:1,cardMotion:false,pet:{kind:'builtin',assetId:'builtin',decorations:[],palette:'default'}};
        const history={messages:[],images:[]};
        const api=async action=>action==='tasks'?{tasks:[]}:action==='goalList'?{goals:[]}:action==='state'?{config:assistantConfig}:{};
        const openResources=()=>{window.identityOpened=(window.identityOpened||0)+1;};
        function Normal({SessionProvider,renderSlot}){return <SessionProvider session={normal}>{renderSlot('surface.normal',{})}</SessionProvider>;}
        function Assistant({SessionProvider,renderSlot,useSelection}){
          const selected=useSelection(value=>value);
          if(!selected)return null;
          const conversation=<AssistantConversation ctx={ctx} sessionId={selected.sessionId} SessionProvider={SessionProvider} renderSlot={renderSlot} {...(productionHeader?{api,assistantConfig,assistantName:'BenchGo',threadId:selected.sessionId==='router'?'main':'side',history,onOpenResources:openResources}:{})}/>;
          return productionHeader?<ActivityProvider><style>{assistantCss}</style><div className='ba-root'><main className='ba-main'>{conversation}</main><ActivityPanel api={api} ctx={ctx} sessionId={selected.sessionId} assistantConfig={assistantConfig} onOpenResources={openResources}/></div></ActivityProvider>:conversation;
        }
        function Header({sessionId,renderSlot}){
          return <section data-conversation={sessionId}><header style={{display:'flex',justifyContent:'space-between',padding:16}}><span>{sessionId}</span>{renderSlot(sessionId==='normal'?'conversation.session.header.corner':WORKBENCH_SESSION_CORNER,{})}</header><textarea aria-label='Chat draft' defaultValue={'chat-'+sessionId}/><button onClick={()=>ctx.sidebarRight.openResource('dsh-resource://file/session/'+sessionId+'/note.md')}>Open file</button></section>;
        }
        slots.register({name:'sidebar'},()=> <aside className='cmd-shell-sidebar'>Projects</aside>);
        slots.register({name:'main',key:'conversation',children:{'surface.normal':{kind:'single',scope:'session'}}},Normal);
        slots.register({name:'main',key:'benchgo-assistant',children:assistantConversationChildren,inject:()=>({hooks:{selection}})},Assistant);
        slots.register({name:'main',key:'tools'},()=> <p>Tools</p>);
        slots.register({name:'surface.normal',children:{'conversation.session.header.corner':{kind:'single',scope:'session'}}},Header);
        if(productionHeader){
          // Exercise the shipped Pet/header registration, replacing only the
          // conversation source and content factory with deterministic data.
          mountAssistantConversation(ctx);
          const conversation=createSnapshotStore({activeTargets:new Set(),views:new Map()});
          slots.entries(ASSISTANT_CONVERSATION_SLOT)[0].inject=()=>({hooks:{conversation}});
          slots.registerFactory({name:'conversation.content',scope:'session-maybe',slots:{views:{scope:'session'},widthControls:{scope:'root'}}},({sessionId})=><section data-conversation={sessionId}><p>真实 Pet 顶栏与官方右工作区集成</p><textarea aria-label='Chat draft' defaultValue={'chat-'+sessionId}/><button onClick={()=>ctx.sidebarRight.openResource('dsh-resource://file/session/'+sessionId+'/note.md')}>Open file</button></section>);
        }else slots.register({name:ASSISTANT_CONVERSATION_SLOT,children:workbenchSessionSurfaceChildren},Header);
        await ctx.plugin(uiRightbar).await();
        const nativeMounted=ctx.sidebarRight.mounted;
        let guard,surface;
        const addGuard=async()=>{guard=ctx.plugin({inject:['slots','sidebarRight'],apply:mountWorkbenchRightbarLifecycle});await guard.await();};
        const addSurface=async()=>{surface=ctx.plugin({inject:['slots','sidebarRight','layout','sessions'],apply:mountWorkbenchSessionSurface});await surface.await();};
        if(location.search.includes('surface-first')){await addSurface();await addGuard();}else{await addGuard();await addSurface();}
        ctx.sidebarRightTabs.register({id:'surface-file',kind:'surface-file',patterns:['dsh-resource://file/**'],keepMounted:true,title:()=> 'note.md'});
        function Editor({sessionId,useTabInfo}){const {tab}=useTabInfo();const [value,setValue]=useState('file-'+sessionId);return <div data-editor={sessionId} data-address={tab.contentId}><textarea aria-label='File content' value={value} onChange={event=>setValue(event.target.value)}/><button onClick={()=>{window.saved={sessionId,value};}}>Save</button></div>;}
        slots.inject('sidebar.right.pane.tab',()=>slots.register({name:'sidebar.right.pane.tab',key:'surface-file'},Editor));
        slots.entries('root')[0].component=ResponsiveAppFrame;
        const root=createRoot(document.getElementById('root'));let generation=0;
        const render=()=>root.render(<React.Fragment key={generation++}>{slots.renderSlot('root',{})}</React.Fragment>);
        render();
        window.fixture={
          async assistant(id){const previous=auxiliary;auxiliary=sessions.retainFor(ctx,id,{source:'workspaceOperation'});await auxiliary.ready;selection.set(auxiliary);ctx.layout.selectPanel('benchgo-assistant');previous?.release();},
          panel(id){ctx.layout.selectPanel(id);},
          closeAssistant(){selection.set(undefined);auxiliary?.release();auxiliary=undefined;},
          read(){const id=ctx.sidebarRight.mounted.getSnapshot();return {id,rootId:ctx.uiSession.adapter.current.getSnapshot().key,views:[...document.querySelectorAll('[data-sidebar-right-session]')].map(node=>({id:node.dataset.sidebarRightSession,hidden:node.hidden})),retained:Object.fromEntries(['normal','router','side'].map(id=>[id,sessions.retainInfo(id).getSnapshot().retainedBy])),tabs:ctx.sidebarRight.openTabs.getSnapshot().map(tab=>({sessionId:tab.sessionId,tabId:tab.tabId,kind:tab.kind}))};},
          duplicate(){return activateWorkbenchSessionSurface({sidebarRight:ctx.sidebarRight},auxiliary.sessionId)();},
          async share(){const mounted=ctx.sidebarRight.mounted,extra=ctx.plugin({inject:['slots','sidebarRight','layout','sessions'],apply:mountWorkbenchSessionSurface});await extra.await();await extra.dispose();return mounted===ctx.sidebarRight.mounted;},
          contract(){try{mountWorkbenchSessionSurface({sidebarRight:{},effect:fn=>fn(),slots:{entries:()=>[]}});}catch(error){return error.message;}},
          otherHost(){
            let refs=0,cleanup;const source=value=>({getSnapshot:()=>value,subscribe:()=>()=>{}});
            const entry={component:()=>null,children:{'rightbar.session':{}},inject:()=>({mountView:()=>()=>{},hooks:{views:source([])}})};
            const corner={locale:'sidebarRight',component:()=>null,store:{},inject:()=>({})};
            const other={sidebarRight:{mounted:source(undefined),openResourceIn(){}},layout:{panelInfo:source({activePanelId:'benchgo-assistant'})},sessions:{retain(){refs++;let held=true;return {ready:Promise.resolve(),release(){if(held){held=false;refs--;}}};}},slots:{entries:name=>name==='rightbar'?[entry]:[corner],inject:()=>()=>{}},effect:fn=>{cleanup=fn();}};
            mountWorkbenchSessionSurface(other);const release=activateWorkbenchSessionSurface(other,'other');
            const isolated=other.sidebarRight.mounted.getSnapshot()==='other'&&ctx.sidebarRight.mounted.getSnapshot()==='router'&&refs===1;
            release();cleanup();return isolated&&refs===0;
          },
          toggle(){ctx.sidebarRight.toggleExpanded();},fullscreen(){ctx.sidebarRight.toggleFullscreen(ctx.sidebarRight.commandTarget());},split(){ctx.sidebarRight.split();},
          closeFiles(id){for(const tab of ctx.sidebarRight.openTabs.getSnapshot().filter(tab=>tab.sessionId===id&&tab.kind==='surface-file'))ctx.sidebarRight.closeIn(id,tab.tabId);},
          remount:render,
          async reloadSurface(){await surface.dispose();await addSurface();render();},
          async removeSurface(){await surface.dispose();render();return ctx.sidebarRight.mounted===nativeMounted;},
          async removeGuard(){await guard.dispose();render();},
          async addSurface(){await addSurface();render();},
          async dispose(){root.unmount();normal.release();auxiliary?.release();await ctx.fiber.dispose();return ['normal','router','side'].every(id=>sessions.binding(id)===undefined);},
        };
      })();
    ` },
    bundle: true, write: false, format: 'iife', outdir: join(root, 'artifacts/unused-session-surface'), jsx: 'automatic',
    alias: {
      react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')),
      '@deepseek-ai/dsh-client-store': join(root, 'deepseek-harness/packages/client/store/src/index.ts'),
      '@deepseek-ai/dsh-client-ui-slots': join(root, 'deepseek-harness/packages/client/ui-slots/src/index.ts'),
      '@deepseek-ai/dsh-client-ui-dockkit': join(root, 'deepseek-harness/packages/client/ui-dockkit/src/index.ts'),
      '@deepseek-ai/dsh-client-ui-primitives': join(root, 'deepseek-harness/packages/client/ui-primitives/src/index.ts'),
      '@deepseek-ai/dsh-client-ui-conversation/client': join(root, 'deepseek-harness/packages/client/ui-conversation/src/client/index.ts'),
      '@deepseek-ai/dsh-client-ui-chat/client': join(root, 'deepseek-harness/packages/client/ui-chat/src/client/index.ts'),
      '@deepseek-ai/dsh-api-gateway/client': join(root, 'deepseek-harness/packages/api/gateway/src/client/index.ts'),
      '@deepseek-ai/dsh-util-workspace-path':join(root,'deepseek-harness/packages/util/workspace-path/src/index.ts'),
    },
    nodePaths: [join(root, 'plugins/base/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')],
    loader: { '.css': 'text', '.module.css': 'local-css', '.svg': 'text', '.png': 'dataurl' },
    plugins: [{name:'surface-shell',setup(build){build.onLoad({filter:/benchgo[\\/]client[\\/]shell-ui\.jsx$/},async({path})=>({loader:'jsx',resolveDir:dirname(path),contents:(await readFile(path,'utf8'))+'\nexport {ResponsiveAppFrame};'}));}},shellUi(),sharedUiStyles()],
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.DSH_CLIENT_TITLE': 'undefined', 'process.env.DSH_CLIENT_VERSION': 'undefined', 'process.env.DSH_CLIENT_COMMIT_HASH': 'undefined', 'process.env.DSH_CLIENT_GIT_DIRTY': 'undefined' }, logLevel: 'silent',
  });
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    if(screenshotDirectory)await mkdir(screenshotDirectory,{recursive:true});
    for (const order of ['guard-first', 'surface-first', 'production-header']) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 850 }, reducedMotion: 'reduce' });page.setDefaultTimeout(6000);
      const errors=[];page.on('pageerror',error=>errors.push(error.stack));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
      await page.route('http://surface.test/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><style>html,body,#root{height:100%;margin:0;font:14px "Segoe UI",sans-serif}</style></head><body><div id="root"></div></body></html>'}));
      await page.goto('http://surface.test/?'+order);
      for(const file of bundle.outputFiles.filter(file=>file.path.endsWith('.css')))await page.addStyleTag({content:file.text});
      await page.addScriptTag({content:bundle.outputFiles.find(file=>file.path.endsWith('.js')).text});await page.evaluate(()=>window.ready);
      const mounted=async id=>{await page.locator('[data-conversation="'+id+'"]').waitFor();await page.waitForFunction(id=>window.fixture.read().id===id,id);};
      const editor=id=>page.locator('[data-editor="'+id+'"]').filter({visible:true});
      const open=async id=>{await mounted(id);await page.getByRole('button',{name:'Open file',exact:true}).click();await editor(id).waitFor();};
      const screenshot=async(name,dark=false)=>{
        if(!screenshotDirectory||order==='surface-first')return;
        await page.evaluate(dark=>document.body.toggleAttribute('data-ds-dark-theme',dark),dark);
        await page.screenshot({path:join(screenshotDirectory,name+'.png'),fullPage:true});
        await page.evaluate(()=>document.body.removeAttribute('data-ds-dark-theme'));
      };
      if(order==='production-header'){
        await page.evaluate(()=>window.fixture.assistant('router'));await open('router');
        assert.equal((await page.evaluate(()=>window.fixture.read())).rootId,'normal');
        const identity=page.getByRole('button',{name:'查看BenchGo的身份',exact:true});
        const heading=page.locator('.ba-chat-heading');
        await identity.waitFor();await identity.click();assert.equal(await page.evaluate(()=>window.identityOpened),1);
        const collapse=page.getByRole('button',{name:'Collapse right sidebar',exact:true});
        const activity=heading.getByRole('button',{name:'展开看板',exact:true});
        assert.equal(await collapse.count(),1);assert.equal(await activity.count(),1);
        const restingIcon=await activity.locator('.cmd-ui-linear').innerHTML();
        assert.equal(await activity.getAttribute('aria-expanded'),'false');
        await activity.click();await heading.getByRole('button',{name:'收起看板',exact:true}).waitFor();
        const expandedActivity=heading.getByRole('button',{name:'收起看板',exact:true});
        assert.equal(await expandedActivity.getAttribute('aria-expanded'),'true');
        assert.notEqual(await expandedActivity.locator('.cmd-ui-linear').innerHTML(),restingIcon,'board launcher changes from the board grid to a collapse arrow');
        assert.equal(await expandedActivity.locator('.ba-board-arrow').count(),1,'collapse arrow points toward the right edge');
        await page.getByText('下一件事，一起完成',{exact:true}).waitFor();
        await screenshot('production-header-board-light-wide');await screenshot('production-header-board-dark-wide',true);
        assert.equal(await page.getByRole('button',{name:'收起看板',exact:true}).count(),1,'only the header toggle can collapse the wide board');
        assert.equal(await page.getByRole('complementary',{name:'助手看板',exact:true}).getByRole('button',{name:'收起看板',exact:true}).count(),0,'wide board has no duplicate collapse button');
        await expandedActivity.click();
        assert.equal(await activity.locator('.cmd-ui-linear').innerHTML(),restingIcon,'collapsing restores the board grid');
        await collapse.click();await heading.locator('[data-sidebar-right-expand]').waitFor();
        assert.equal(await heading.locator('[data-sidebar-right-expand]').count(),1,'real Pet header renders the aliased official corner');
        await screenshot('production-header-light-wide');await screenshot('production-header-dark-wide',true);
        await page.locator('[data-sidebar-right-expand]').click();await editor('router').waitFor();
        await screenshot('production-header-file-light-wide');await screenshot('production-header-file-dark-wide',true);
        await page.setViewportSize({width:500,height:700});await page.locator('.cmd-shell-frame[data-rightbar-fullscreen]').waitFor();
        await page.evaluate(()=>window.fixture.toggle());await heading.waitFor();
        await screenshot('production-header-light-narrow');await screenshot('production-header-dark-narrow',true);
        assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
        const boxes=await heading.locator('button').evaluateAll(nodes=>nodes.map(node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};}));
        assert(boxes.every(box=>box.left>=0&&box.right<=500),'production identity and actions fit the narrow viewport');
        await page.getByRole('button',{name:'展开看板',exact:true}).click();await page.getByRole('button',{name:'收起看板',exact:true}).waitFor();
        await screenshot('production-header-board-light-narrow');await screenshot('production-header-board-dark-narrow',true);
        assert.equal(await page.getByRole('button',{name:'收起看板',exact:true}).count(),1,'narrow overlay reuses the single toggle');
        await page.getByRole('button',{name:'收起看板',exact:true}).click();
        await heading.getByRole('button',{name:'展开看板',exact:true}).waitFor();
        assert.equal(await page.evaluate(()=>window.fixture.dispose()),true);assert.deepEqual(errors,[],order);await page.close();continue;
      }
      await open('normal');await editor('normal').getByRole('textbox',{name:'File content'}).fill('normal draft');
      await page.evaluate(()=>window.fixture.assistant('router'));await open('router');
      assert.equal((await page.evaluate(()=>window.fixture.read())).rootId,'normal','auxiliary sessions do not claim mainView');
      await editor('router').getByRole('textbox',{name:'File content'}).fill('router draft');
      await editor('router').getByRole('button',{name:'Save',exact:true}).click();assert.deepEqual(await page.evaluate(()=>window.saved),{sessionId:'router',value:'router draft'});
      await screenshot('router-light-wide');await screenshot('router-dark-wide',true);
      await page.evaluate(()=>window.fixture.duplicate());
      assert.equal(await page.locator('[data-sidebar-right-session="router"]:not([data-sidebar-right-panel])').count(),1,'same-session activation has one rendered view');
      const retained=await page.evaluate(()=>window.fixture.read().retained.router);
      assert.equal(retained.sidebarView,1);assert.equal(retained.mainView,undefined);
      assert.equal(await page.evaluate(()=>window.fixture.share()),true,'another owning effect reuses the installation');
      assert.equal(await page.evaluate(()=>window.fixture.otherHost()),true,'different Sidebar services keep independent claims and lifetimes');
      assert.match(await page.evaluate(()=>window.fixture.contract()),/Official rightbar session-surface contract changed/);
      await page.evaluate(()=>window.fixture.assistant('side'));await open('side');await editor('side').getByRole('textbox',{name:'File content'}).fill('side draft');
      await screenshot('side-light-wide');
      if(screenshotDirectory&&order==='guard-first'){
        await page.setViewportSize({width:500,height:700});await page.locator('.cmd-shell-frame[data-rightbar-fullscreen]').waitFor();
        await screenshot('side-light-narrow');await screenshot('side-dark-narrow',true);
        await page.setViewportSize({width:1280,height:850});
      }
      await page.evaluate(()=>window.fixture.assistant('router'));await mounted('router');await editor('router').waitFor();assert.equal(await editor('router').getByRole('textbox',{name:'File content'}).inputValue(),'router draft');
      await page.getByRole('button',{name:'Collapse right sidebar',exact:true}).click();await page.locator('[data-sidebar-right-expand]').waitFor();
      await page.locator('[data-sidebar-right-expand]').click();await editor('router').waitFor();
      await page.evaluate(()=>window.fixture.panel('tools'));await page.getByText('Tools',{exact:true}).waitFor();
      assert.equal(await page.evaluate(()=>window.fixture.read().id),undefined);assert.equal(await editor('router').count(),0);
      await page.evaluate(()=>window.fixture.panel(null));await mounted('normal');await editor('normal').waitFor();assert.equal(await editor('normal').getByRole('textbox',{name:'File content'}).inputValue(),'normal draft');
      await page.evaluate(()=>window.fixture.assistant('router'));await mounted('router');await editor('router').waitFor();
      // Ordinary frame controls and keyboard-command service paths use the same auxiliary target.
      await page.evaluate(()=>window.fixture.split());assert.equal((await page.evaluate(()=>window.fixture.read())).id,'router');
      await page.evaluate(()=>window.fixture.fullscreen());await page.locator('.cmd-shell-frame[data-rightbar-fullscreen]').waitFor();
      await page.evaluate(()=>window.fixture.fullscreen());await page.locator('.cmd-shell-frame:not([data-rightbar-fullscreen])').waitFor();
      await page.setViewportSize({width:500,height:700});await page.locator('.cmd-shell-frame[data-rightbar-fullscreen]').waitFor();await screenshot('router-dark-narrow',true);await page.setViewportSize({width:1280,height:850});
      await page.evaluate(()=>window.fixture.remount());await mounted('router');await editor('router').waitFor();
      await page.evaluate(()=>window.fixture.reloadSurface());await mounted('router');await editor('router').waitFor();
      await page.evaluate(()=>window.fixture.closeFiles('side'));await page.evaluate(()=>window.fixture.closeAssistant());
      await page.waitForFunction(()=>window.fixture.read().id===undefined);
      assert.equal(await page.evaluate(()=>window.fixture.read().retained.side?.sidebarView??0),0,'closed inactive files release their view');
      assert.equal(await page.evaluate(()=>window.fixture.removeSurface()),true,'unload restores the original mounted face');
      await page.evaluate(()=>window.fixture.panel(null));await mounted('normal');
      await page.evaluate(()=>window.fixture.removeGuard());
      assert.equal(await page.evaluate(()=>window.fixture.dispose()),true,'all session references release at host teardown');
      assert.deepEqual(errors,[],order);
      await page.close();
    }
  } finally {await browser.close();}
});
