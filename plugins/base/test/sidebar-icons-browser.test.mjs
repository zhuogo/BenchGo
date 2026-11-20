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

test('real sidebar keeps panel labels, icons and quick actions usable', { skip: !executablePath }, async () => {
  const result = await build({ stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
    import {SlotCore} from './deepseek-harness/packages/client/ui-slots/src/index.ts';
    import {createSlotRenderer} from './deepseek-harness/packages/client/ui-renderer/src/client/scoped-slots.tsx';
    import * as panelFactories from './deepseek-harness/packages/client/ui-sidebar/src/client/PanelIcon.tsx';
    import {SidebarRoot} from './deepseek-harness/packages/client/ui-sidebar/src/client/SidebarRoot.tsx';
    import {SIDEBAR_MIN,SIDEBAR_COLLAPSED} from './deepseek-harness/packages/client/ui-layout/src/client/columns.ts';
    import {UIIcon} from './plugins/base/client/iconsax.jsx';
    import css from './plugins/base/client/style.css';
    const query=new URLSearchParams(location.search);
    const mode=query.get('owner')||'published',link=query.has('link'),withActions=query.has('actions');
    const {PanelIcon,PanelTrailing}=panelFactories;
    window.hasSidebarActions=!!PanelTrailing;
    document.documentElement.toggleAttribute('data-windows-titlebar',query.has('windows'));
    const core=new SlotCore(),errors=[];window.slotErrors=errors;
    const source=value=>({getSnapshot:()=>value,subscribe:()=>()=>{}});
    const binding=source({key:undefined,hooks:{},keyedHooks:{},props:{}}),adapter={current:binding,bindingSource:()=>binding};
    const host={
      subscribe:(key,fn)=>core.subscribe(key,fn),getVersion:key=>core.getVersion(key),
      entriesOf:key=>core.entries(key),entriesOfSlot:key=>core.entriesOfSlot(key),
      reportEntryError:(key,entry,error,info)=>{errors.push(error.message);core.reportEntryError(key,entry,error,info)},
      reportFactoryError:(name,definition,error)=>{errors.push(error.message);core.reportFactoryError(name,definition,error)},
      specOf:key=>core.specDynamic(key),isLive:entry=>core.isLive(entry),storeOf:()=>undefined,
      factoryStoreOf:()=>undefined,retainFactoryOccurrence:()=>()=>{},
      subscribeFactory:(name,fn)=>core.subscribeFactory(name,fn),getFactoryVersion:name=>core.factoryVersion(name),
      factoryOf:name=>core.factory(name),isFactoryLive:definition=>core.isFactoryLive(definition),
      root:binding,scopeRevision:source(0),scope:()=>adapter,
    };
    core.register({name:'root',children:{sidebar:{kind:'single',scope:'root'}}},({renderSlot})=><><style>{css}</style>{renderSlot('sidebar',{})}</>);
    const children=Object.fromEntries(['sidebar.brand.mark','sidebar.brand.name','sidebar.toggle.badge','sidebar.workspaces','sidebar.settings'].map(name=>[name,{kind:'single',scope:'root'}]));
    for(const name of ['sidebar.panellist.actions','sidebar.footer.action'])children[name]={kind:'list',scope:'root'};
    if(PanelTrailing){
      children['sidebar.session.action']={kind:'hoc',scope:'root'};
      core.registerFactory({name:'sidebar.panel.trailing',scope:'root',children:{'sidebar.panellist.trailing':{kind:'list',scope:'root',inline:true}}},PanelTrailing);
    }
    if(mode==='factory')core.registerFactory({name:'sidebar.panel.icon',scope:'root',children:{'sidebar.panellist':{kind:'list',scope:'root'}}},props=><span data-real-icon-factory>{PanelIcon(props)}</span>);
    else children['sidebar.panellist']={kind:'list',scope:'root'};
    core.register({name:'sidebar',children},props=>{
      const [active,setActive]=useState(null),[collapsed,setCollapsed]=useState(false);
      return <div style={{width:collapsed?SIDEBAR_COLLAPSED:SIDEBAR_MIN,height:'100vh'}}><SidebarRoot {...props}
        renderFactorySlot={mode==='legacy-renderer'?undefined:props.renderFactorySlot}
        collapsed={collapsed} drawer={false} width={SIDEBAR_MIN} toggleSidebar={()=>setCollapsed(!collapsed)}
        startSession={()=>{}} setPinned={()=>{}} trackEntryClick={()=>{}} selectPanel={setActive}
        usePanels={select=>select([{id:'plugins',label:'工具'},{id:'schedules',label:'定时任务'}])}
        useEntryPins={select=>select([])} useEntryActions={select=>select(false)} useRemoteAccess={()=>!query.has('no-create')}
        useShortcuts={select=>select([])} usePanelInfo={select=>select({activePanelId:active})} t={key=>key}/></div>;
    });
    core.register({name:'sidebar.workspaces'},({wide,panelNavigation})=><section className={'cmd-projects '+(wide?'':'cmd-narrow')}><nav className='cmd-sidebar-nav'><button aria-label='新对话' className='cmd-new-chat'><UIIcon name='new-chat' size={16}/></button></nav><div className='cmd-sidebar-navigation'>{panelNavigation}{link&&<div className='cmd-resource-scope'><button aria-label='显示' aria-haspopup='menu'><UIIcon name='settings' size={16}/>{wide&&<span className='cmd-resource-scope-label'>显示</span>}</button></div>}</div><p>最近会话</p></section>);
    core.register({name:'sidebar.settings'},()=><button>设置</button>);
    for(const id of ['plugins','schedules'])core.register({name:'sidebar.panellist',id},({size,active})=><UIIcon name={id} size={size} selected={active}/>);
    if(PanelTrailing && withActions){
      core.register({name:'sidebar.panellist.trailing',id:'schedules'},()=><span data-schedule-badge>2</span>);
      core.register({name:'sidebar.session.action',id:'import'},({children})=><>{children}<button type='button' onClick={()=>document.body.dataset.importClicked='true'}>导入</button></>);
    }
    createRoot(document.getElementById('app')).render(createSlotRenderer().renderRoot(host,{}));
  ` }, bundle: true, write: false, format: 'iife', jsx: 'automatic',
    alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')), '@deepseek-ai/dsh-client-ui-slots': join(root, 'deepseek-harness/packages/client/ui-slots/src/index.ts') },
    nodePaths: [join(root, 'plugins/base/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')], loader: { '.css': 'text' },
    plugins: [{ name: 'host-primitives-fixture', setup(build) {
      build.onResolve({ filter: /^@deepseek-ai\/dsh-client-ui-primitives$/ }, () => ({ path: 'primitives', namespace: 'fixture' }));
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ loader: 'jsx', resolveDir: root, contents: `import React from 'react';const Icon=()=> <svg width="16" height="16"/>;export const FishLogo=Icon,IconAppsAddOutlineRegular=Icon,IconNewChatOutlineMedium=Icon,IconNewChatOutlineRegular=Icon,IconPanelLeftOutlineRegular=Icon,IconPinFillRegular=Icon;export const Tooltip=({children})=>children,Menu=()=>null,ShortcutKeys=()=>null,Toast=()=>null;export const useModalLayer=()=>{},isBehindModal=()=>false,isDarwinDesktop=()=>false,focusWithoutRing=el=>el.focus(),writeClipboard=async()=>true;` }));
    } }, shellUi()], define: { 'process.env.NODE_ENV': '"production"', 'process.env.DSH_CLIENT_VERSION': 'undefined', 'process.env.DSH_CLIENT_COMMIT_HASH': 'undefined', 'process.env.DSH_CLIENT_GIT_DIRTY': 'undefined' }, logLevel: 'silent' });
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 780 } }), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://sidebar.test/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font-family:Arial,sans-serif;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary);--dsw-specific-sidebar-fill:#f4f5f7;--dsw-alias-label-primary:#242424;--dsw-alias-label-secondary:#666;--dsw-alias-interactive-bg-hover:#e8eaf0}body[data-ds-dark-theme]{color-scheme:dark;--dsw-alias-bg-base:#19191b;--dsw-specific-sidebar-fill:#222225;--dsw-alias-label-primary:#ededee;--dsw-alias-label-secondary:#a3a3a8;--dsw-alias-interactive-bg-hover:#ffffff12}</style></head><body><div id="app"></div></body></html>' }));
    for (const owner of ['published', 'legacy-renderer', 'factory']) {
      await page.goto('https://sidebar.test/?owner=' + owner + (owner === 'published' ? '' : '&link&windows'));
      await page.addScriptTag({ content: result.outputFiles[0].text });
      for (const theme of ['light', 'dark']) {
        await page.evaluate(dark => document.body.toggleAttribute('data-ds-dark-theme', dark), theme === 'dark');
        for (const label of ['工具', '定时任务']) {
          const button = page.getByRole('button', { name: label, exact: true });
          await button.waitFor({ timeout: 5000 }).catch(async error => { throw new Error(JSON.stringify({ owner, errors, slots: await page.evaluate(() => window.slotErrors), body: await page.locator('body').innerText() }), { cause: error }); });
          const icon = button.locator('.cmd-ui-icon');
          assert.equal(await icon.count(), 1, owner + ': missing real icon for ' + label);
          assert.equal(await icon.locator('svg').count(), 2, 'Iconsax linear and bold variants must both exist');
          assert(await icon.locator('.cmd-ui-linear svg path').count() > 0, 'The actual icon asset must contain geometry');
          const rect = await icon.boundingBox();
          assert(rect.width >= 16 && rect.height >= 16, 'Panel icon must have visible dimensions');
          const title = button.locator('[class*="_panelTitle"]');
          assert(await title.evaluate(node => node.clientWidth >= node.scrollWidth && node.clientWidth > 0), owner + ': clipped label ' + label);
          await button.click();
          assert.equal(await button.getAttribute('aria-current'), 'page');
          assert(await icon.evaluate(node => node.classList.contains('is-selected')));
        }
        assert.equal(await page.locator('[data-real-icon-factory]').count(), owner === 'factory' ? 2 : 0, 'New hosts must keep their real factory');
        assert.deepEqual(await page.evaluate(() => window.slotErrors), []);
        if (process.env.BENCHGO_SIDEBAR_SCREENSHOTS) {
          await mkdir(process.env.BENCHGO_SIDEBAR_SCREENSHOTS, { recursive: true });
          await page.screenshot({ path: join(process.env.BENCHGO_SIDEBAR_SCREENSHOTS, 'icons-' + owner + '-' + theme + '.png') });
        }
      }
    }
    const quickActions = page.locator('.cmd-sidebar-nav');
    await page.goto('https://sidebar.test/?owner=factory&link&windows&no-create');
    await page.addScriptTag({ content: result.outputFiles[0].text });
    await quickActions.waitFor();
    const withoutOfficialAction = await quickActions.boundingBox();
    await page.goto('https://sidebar.test/?owner=factory&link&windows');
    await page.addScriptTag({ content: result.outputFiles[0].text });
    await quickActions.waitFor();
    assert.equal((await quickActions.boundingBox()).y, withoutOfficialAction.y, 'Hidden official action must not move Windows quick actions');
    const tools = page.getByRole('button', { name: '工具', exact: true });
    const schedules = page.getByRole('button', { name: '定时任务', exact: true });
    const scope = page.getByRole('button', { name: '显示', exact: true });
    const [toolsBox, schedulesBox, scopeBox] = await Promise.all([tools.boundingBox(), schedules.boundingBox(), scope.boundingBox()]);
    assert(toolsBox.x < schedulesBox.x && schedulesBox.x < scopeBox.x && toolsBox.y === schedulesBox.y && schedulesBox.y === scopeBox.y, 'Link navigation must fit in one row');
    if (await page.evaluate(() => window.hasSidebarActions)) {
      await page.goto('https://sidebar.test/?owner=factory&link&windows&actions');
      await page.addScriptTag({ content: result.outputFiles[0].text });
      await page.getByRole('button', { name: '导入', exact: true }).click();
      assert.equal(await page.locator('body').getAttribute('data-import-clicked'), 'true');
      assert(await schedules.locator('[data-schedule-badge]').isVisible());
      assert(await schedules.locator('[class*="_panelTitle"]').evaluate(node => node.clientWidth >= node.scrollWidth));
    }
    await page.goto('https://sidebar.test/?owner=factory&link');
    await page.addScriptTag({ content: result.outputFiles[0].text });
    await page.locator('[data-sidebar-toggle]').click();
    await page.locator('.cmd-projects.cmd-narrow').waitFor();
    const [railTools, railSchedules] = await Promise.all([tools.boundingBox(), schedules.boundingBox()]);
    assert(railTools.y < railSchedules.y && railTools.x === railSchedules.x, 'Rail navigation must stack vertically');
    assert.equal(await page.locator('[class*="_panelTitle"]').count(), 0, 'Rail only shows panel icons');
    await schedules.click();
    assert.equal(await schedules.getAttribute('aria-current'), 'page');
    assert.deepEqual(await page.evaluate(() => window.slotErrors), []);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
