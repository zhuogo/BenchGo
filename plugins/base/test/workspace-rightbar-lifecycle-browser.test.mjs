import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { shellUi } from '../scripts/shell-ui.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url));
const { chromium } = require('playwright');
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || [chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);

// Use real slot/session/layout/rightbar owners; host services and main-view selection remain test fixtures.
test('official rightbar and corner share session lifetimes across selection, shell replacement and plugin reload', { skip: !executablePath }, async () => {
  const bundle = await build({
    stdin: { resolveDir: root, loader: 'jsx', contents: `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
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
      import {createSidebarRightStore} from './deepseek-harness/packages/client/ui-sidebar-right/src/client/stores.ts';
      import {ResponsiveAppFrame} from './plugins/base/client/shell-ui.jsx';
      import {mountWorkbenchRightbarLifecycle} from './plugins/base/workbench/client/rightbar-lifecycle.jsx';
      import {createModuleSource,startModuleLifecycle} from './plugins/base/client/modules.mjs';
      import {installIconSprite} from './deepseek-harness/packages/client/ui-theme/src/client/icon-sprite.ts';
      import css from './plugins/base/client/style.css';
      import tokens from './deepseek-harness/packages/client/ui-theme/src/styles/design-platform.css';
      import theme from './deepseek-harness/packages/client/ui-theme/src/styles/base.css';

      window.ready=(async()=>{
        const style=document.createElement('style');style.textContent=tokens+theme+css;document.head.append(style);
        document.documentElement.setAttribute('data-windows-titlebar','');
        document.documentElement.style.setProperty('--dsh-windows-titlebar-height','40px');
        const ctx=new Context();await ctx.plugin(SlotRegistry).await();
        installIconSprite(ctx,undefined);
        const slots=ctx.slots,renderer=createSlotRenderer();let host;
        slots.install({renderRoot(value,owner){host=value;return renderer.renderRoot(value,owner);}});
        const sessions=new TestSessions(async fn=>{await fn();},ctx);
        ctx.provide('sessions',sessions);new TestRemote(ctx);
        await ctx.plugin(allowAllAccessPlugin).await();
        await ctx.plugin(uiSession).await();
        const locale=new LocaleRuntime(ctx);locale.setLocale('en');ctx.provide('locale',locale);slots.installLocale(locale);
        ctx.provide('shortcuts',{runtime:'desktop',register:()=>()=>{},catalog:createSnapshotStore([])});
        ctx.provide('theme',{getTheme:()=>({preference:'light',active:{colorScheme:'light',tokens:{}},fontSizes:{text:14,code:13,terminal:13},fontFamilies:{text:'',code:'',terminal:''}})});
        ctx.provide('resources',{pin(){}});
        await ctx.plugin(uiLayout).await();await ctx.plugin(uiMenus).await();
        for(const id of ['a','b'])await sessions.add({id});
        // Persist before any renderer store is minted: startup must need no toggle.
        const seed=()=>({kind:'guide',title:'Guide'});
        const coldClick=location.search.includes('cold-click');
        if(!localStorage.getItem('dsh.sidebar-right.v1.a'))createSidebarRightStore(seed).create('a').actions.setExpanded('a',!coldClick);
        slots.register({name:'sidebar'},()=> <aside className='cmd-shell-sidebar'>Projects</aside>);
        const selection=createSnapshotStore(undefined);
        function Conversation({SessionProvider,renderSlot,useSelection}){
          const selected=useSelection(value=>value);
          return <SessionProvider session={selected}>{renderSlot('rightbar.lifecycle.conversation',{})}</SessionProvider>;
        }
        function Header({sessionId,renderSlot}){
          return <section data-conversation={sessionId}><header style={{display:'flex',justifyContent:'space-between',padding:16}}><span>{sessionId}</span>{renderSlot('conversation.session.header.corner',{})}</header><textarea aria-label='Draft' defaultValue={'draft-'+sessionId}/></section>;
        }
        slots.register({name:'main',key:'conversation',inject:()=>({hooks:{selection}}),children:{'rightbar.lifecycle.conversation':{kind:'single',scope:'session'}}},Conversation);
        slots.register({name:'rightbar.lifecycle.conversation',children:{'conversation.session.header.corner':{kind:'single',scope:'session'}}},Header);
        let reference,retiredBinding;
        const select=id=>{const previous=reference;reference=id===undefined?undefined:sessions.retainFor(ctx,id,{source:'mainView'});selection.set(reference);previous?.release();};
        select('a');await reference.ready;
        let rightbar=ctx.plugin(uiRightbar);await rightbar.await();
        let guard;
        const installGuard=async()=>{guard=ctx.plugin({inject:['slots','sidebarRight'],apply:mountWorkbenchRightbarLifecycle});await guard.await();};
        const officialFrame=slots.entries('root')[0].component;
        const officialRightbar=slots.entries('rightbar')[0].component;
        let handoffListeners=0;
        const onEntryError=slots.onEntryError.bind(slots);
        slots.onEntryError=listener=>{handoffListeners++;const stop=onEntryError(listener);return()=>{handoffListeners--;stop();};};
        if(coldClick)await installGuard();
        const moduleSource=createModuleSource();let refreshProbe,baseMounts=0;
        if(coldClick){
          const modules=ctx.plugin({apply(owner){
            baseMounts++;
            owner.effect(()=>{slots.entries('root')[0].component=ResponsiveAppFrame;return()=>{slots.entries('root')[0].component=officialFrame;};});
            owner.effect(()=>startModuleLifecycle(owner,{}, {source:moduleSource,poll:options=>{refreshProbe=options.refresh;return()=>{};}}));
          }});
          await modules.await();await refreshProbe(new AbortController().signal);
        }
        const root=createRoot(document.getElementById('root'));
        let generation=0;
        const render=()=>root.render(<React.Fragment key={generation++}>{slots.renderSlot('root',{})}</React.Fragment>);
        render();
        window.fixture={
          select,
          async probe(){try{await refreshProbe(new AbortController().signal);return null;}catch(error){return error.status;}},
          modules(){return {available:moduleSource.getSnapshot().base,baseMounts};},
          installGuard,
          async removeGuard(){await guard.dispose();render();return slots.entries('rightbar')[0].component===officialRightbar;},
          async reloadGuard(){await guard.dispose();guard=ctx.plugin({inject:['slots','sidebarRight'],apply:mountWorkbenchRightbarLifecycle});await guard.await();render();},
          retainBackground(){
            ctx.sidebarRightTabs.register({id:'lifecycle-retained',kind:'lifecycle-retained',title:()=> 'Retained page',keepMounted:true});
            slots.inject('sidebar.right.pane.tab',()=>slots.register({name:'sidebar.right.pane.tab',key:'lifecycle-retained'},({sessionId})=><div data-retained-page={sessionId}>Retained page</div>));
            ctx.sidebarRight.openTab('lifecycle-retained',{sessionId:'a'});
          },
          read(){
            const binding=reference&&ctx.uiSession.adapter.bindingSource(reference).getSnapshot();
            const panel=slots.entries('rightbar.session')[0],corner=slots.entries('conversation.session.header.corner')[0];
            const panelStore=binding&&panel&&host.storeOf(panel,binding),cornerStore=binding&&corner&&host.storeOf(corner,binding);
            return {sameStore:panelStore!==undefined&&panelStore===cornerStore,expanded:panelStore?.getSnapshot().bySession[reference?.sessionId]?.layout.expanded,binding:binding?.key,handoffListeners};
          },
          replaceShell(){slots.entries('root')[0].component=ResponsiveAppFrame;render();},
          restoreShell(){slots.entries('root')[0].component=officialFrame;render();},
          backgroundReleased(){return sessions.binding('a')===undefined;},
          closeRetained(){
            const tab=ctx.sidebarRight.openTabs.getSnapshot().find(tab=>tab.sessionId==='a'&&tab.kind==='lifecycle-retained');
            ctx.sidebarRight.closeIn('a',tab.tabId);
            render();
          },
          remount:render,
          async reloadRightbar(){await rightbar.dispose();rightbar=ctx.plugin(uiRightbar);await rightbar.await();await guard?.await();render();},
          async retireSession(){retiredBinding=reference.binding;select(undefined);await rightbar.dispose();},
          released(){return ['a','b'].every(id=>sessions.binding(id)===undefined);},
          async restoreSession(){select('a');await reference.ready;rightbar=ctx.plugin(uiRightbar);await rightbar.await();await guard?.await();render();return reference.binding!==retiredBinding;},
          async dispose(){root.unmount();reference?.release();await ctx.fiber.dispose();},
        };
      })();
    ` },
    bundle: true, write: false, format: 'iife', outdir: join(root, 'artifacts/unused-workspace-rightbar-lifecycle'), jsx: 'automatic',
    alias: {
      react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')),
      '@deepseek-ai/dsh-client-store': join(root, 'deepseek-harness/packages/client/store/src/index.ts'),
      '@deepseek-ai/dsh-client-ui-slots': join(root, 'deepseek-harness/packages/client/ui-slots/src/index.ts'),
      '@deepseek-ai/dsh-client-ui-dockkit': join(root, 'deepseek-harness/packages/client/ui-dockkit/src/index.ts'),
      '@deepseek-ai/dsh-client-ui-primitives': join(root, 'deepseek-harness/packages/client/ui-primitives/src/index.ts'),
      '@deepseek-ai/dsh-client-ui-conversation/client': join(root, 'deepseek-harness/packages/client/ui-conversation/src/client/index.ts'),
      '@deepseek-ai/dsh-client-ui-chat/client': join(root, 'deepseek-harness/packages/client/ui-chat/src/client/index.ts'),
      '@deepseek-ai/dsh-api-gateway/client': join(root, 'deepseek-harness/packages/api/gateway/src/client/index.ts'),
    },
    nodePaths: [join(root, 'plugins/base/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')],
    loader: { '.css': 'text', '.module.css': 'local-css', '.svg': 'text', '.png': 'dataurl' },
    plugins: [{ name: 'workspace-lifecycle-fixture', setup(build) {
      build.onLoad({ filter: /benchgo[\\/]client[\\/]shell-ui\.jsx$/ }, async ({ path }) => ({ loader: 'jsx', resolveDir: dirname(path), contents: (await readFile(path, 'utf8')) + '\nexport {ResponsiveAppFrame};' }));
    } }, shellUi()],
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.DSH_CLIENT_TITLE': 'undefined', 'process.env.DSH_CLIENT_VERSION': 'undefined', 'process.env.DSH_CLIENT_COMMIT_HASH': 'undefined', 'process.env.DSH_CLIENT_GIT_DIRTY': 'undefined' }, logLevel: 'silent',
  });
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    for (const reducedMotion of ['reduce', 'no-preference']) for(const scenario of ['lifecycle','cold-click']) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 850 }, reducedMotion });
      page.setDefaultTimeout(5000);
      const errors = [];
      let probeStatus=200;
      page.on('pageerror', error => errors.push(error.stack));
      page.on('console', message => { if (message.type() === 'error' && !message.location().url.includes('/api/benchgo/modules')) errors.push(message.text()); });
      await page.route('http://workspace.test/**', route => new URL(route.request().url()).pathname==='/api/benchgo/modules'
        ? route.fulfill({status:probeStatus,contentType:probeStatus===200?'application/json':'text/plain',body:probeStatus===200?JSON.stringify({modules:Object.fromEntries(['base','harness','superagent','voice','link'].map(name=>[name,{available:name==='base'}]))}):'not found'})
        : route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><style>html,body,#root{height:100%;margin:0;font:14px "Segoe UI",sans-serif}</style></head><body><div id="root"></div></body></html>' }));
      await page.goto('http://workspace.test/?'+scenario);
      const mount = async () => {
        for (const file of bundle.outputFiles.filter(file => file.path.endsWith('.css'))) await page.addStyleTag({ content: file.text });
        await page.addScriptTag({ content: bundle.outputFiles.find(file => file.path.endsWith('.js')).text });
        await page.evaluate(() => {
          if (!window.ready) throw new Error('Workspace fixture failed before bootstrap');
          return window.ready;
        });
      };
      const verify = async (id, expanded) => {
        await page.locator('[data-conversation="' + id + '"]').waitFor({ state: 'visible' });
        await page.waitForFunction(({ id, expanded }) => {
          const value = window.fixture.read();
          return value.sameStore && value.binding === id && value.expanded === expanded;
        }, { id, expanded });
        const seat = page.locator('[data-sidebar-right-session="' + id + '"]');
        if (expanded) {
          await seat.locator('[data-sidebar-right-open]').waitFor();
          await seat.getByRole('button', { name: 'Collapse right sidebar' }).waitFor({ state: 'visible' });
          assert.equal(await page.locator('[data-sidebar-right-expand]').count(), 0);
          await page.waitForFunction(() => !document.querySelector('.cmd-shell-frame').hasAttribute('data-rightbar-collapsed'));
        } else {
          await page.locator('[data-sidebar-right-expand]').waitFor({ state: 'visible' });
          await page.waitForFunction(() => document.querySelector('.cmd-shell-frame').hasAttribute('data-rightbar-collapsed'));
        }
        assert.equal(await page.getByLabel('Draft').inputValue(), 'draft-' + id);
        assert.equal(await page.locator('[data-slot-error]').count(), 0);
        assert.equal(await page.evaluate(()=>window.fixture.read().handoffListeners),0,'installation handoff observers are released after commit');
      };
      await mount();
      if(scenario==='cold-click'){
        await verify('a',false);
        await page.getByLabel('Draft').fill('unsent follow-up');
        probeStatus=404;
        assert.equal(await page.evaluate(()=>window.fixture.probe()),404);
        assert.deepEqual(await page.evaluate(()=>window.fixture.modules()),{available:true,baseMounts:1},'a missing probe route cannot dismantle the shell');
        probeStatus=200;await page.evaluate(()=>window.fixture.probe());
        assert.deepEqual(await page.evaluate(()=>window.fixture.modules()),{available:true,baseMounts:1},'feed recovery must reuse the mounted base');
        assert.equal(await page.getByLabel('Draft').inputValue(),'unsent follow-up');
        await page.getByLabel('Draft').fill('draft-a');
        for(let count=0;count<6;count++){
          await page.locator('[data-sidebar-right-expand]').click();await verify('a',true);
          await page.getByRole('button',{name:'Collapse right sidebar'}).click();await verify('a',false);
        }
        await page.evaluate(()=>window.fixture.dispose());
        assert.deepEqual(errors,[],reducedMotion+' cold first click');
        await page.close();continue;
      }
      await verify('a', true);
      await page.evaluate(() => window.fixture.replaceShell());await verify('a', true);
      await page.getByRole('button', { name: 'Collapse right sidebar' }).click();await verify('a', false);
      await page.evaluate(() => window.fixture.select('b'));await verify('b', false);
      await page.locator('[data-sidebar-right-expand]').click();await verify('b', true);
      await page.evaluate(() => window.fixture.select('a'));await verify('a', false);
      await page.locator('[data-sidebar-right-expand]').click();await verify('a', true);
      await page.evaluate(() => window.fixture.retainBackground());
      await page.locator('[data-retained-page="a"]').waitFor({state:'visible'});
      await page.evaluate(() => window.fixture.select('b'));await verify('b', true);
      assert.equal(await page.locator('[data-retained-page="a"]').count(),1,'the background page is retained before shell replacement');
      await page.evaluate(() => window.fixture.installGuard());
      await page.evaluate(() => window.fixture.remount());
      await page.waitForFunction(()=>document.querySelector('[data-slot-error]') || document.querySelector('[data-sidebar-right-session="b"] [data-sidebar-right-open]'));
      assert.deepEqual(errors, [], 'retained background views must remain owned throughout the shell commit');
      await verify('b', true);
      await page.locator('[data-retained-page="a"]').waitFor({state:'detached'});
      await page.waitForFunction(()=>window.fixture.backgroundReleased());
      const backgroundA=async()=>{
        await page.evaluate(() => window.fixture.select('a'));await verify('a', true);
        await page.locator('[data-retained-page="a"]').waitFor({state:'visible'});
        await page.evaluate(() => window.fixture.select('b'));await verify('b', true);
        assert.equal(await page.locator('[data-retained-page="a"]').count(),1);
      };
      for (const transition of ['restoreShell','replaceShell','removeGuard','installGuard','reloadGuard']) {
        await backgroundA();
        const restored=await page.evaluate(async transition=>{
          const result=await window.fixture[transition]();
          if(transition==='installGuard')window.fixture.remount();
          return result;
        },transition);
        if(transition==='removeGuard')assert.equal(restored,true,'unloading restores the original component');
        await verify('b',true);
        await page.waitForFunction(()=>window.fixture.backgroundReleased());
      }
      await backgroundA();
      await page.evaluate(() => window.fixture.closeRetained());await verify('b', true);
      await page.waitForFunction(()=>window.fixture.backgroundReleased());
      await page.evaluate(() => window.fixture.select('a'));await verify('a', true);
      await page.evaluate(() => window.fixture.reloadRightbar());await verify('a', true);
      await page.evaluate(() => window.fixture.remount());await verify('a', true);
      await page.evaluate(() => window.fixture.retireSession());
      await page.waitForFunction(() => window.fixture.released());
      await page.locator('[data-conversation]').waitFor({ state: 'detached' });
      await page.locator('[data-sidebar-right-panel]').waitFor({ state: 'detached' });
      assert.equal(await page.evaluate(() => window.fixture.restoreSession()), true, 'restoration must mint a new session generation');
      await verify('a', true);
      await page.reload();await mount();await verify('a', true);
      await page.evaluate(() => window.fixture.select('b'));await verify('b', true);
      await page.evaluate(() => window.fixture.dispose());
      assert.deepEqual(errors, [], reducedMotion);
      await page.close();
    }
  } finally { await browser.close(); }
});
