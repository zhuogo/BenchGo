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

test('real panel icons support published slot owners and newer factory owners', { skip: !executablePath }, async () => {
  const result = await build({ stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
    import {SlotCore} from './deepseek-harness/packages/client/ui-slots/src/index.ts';
    import {createSlotRenderer} from './deepseek-harness/packages/client/ui-renderer/src/client/scoped-slots.tsx';
    import {PanelIcon} from './deepseek-harness/packages/client/ui-sidebar/src/client/PanelIcon.tsx';
    import {SidebarRoot} from './deepseek-harness/packages/client/ui-sidebar/src/client/SidebarRoot.tsx';
    import {UIIcon} from './plugins/benchgo/client/iconsax.jsx';
    import css from './plugins/benchgo/client/style.css';
    const mode=new URLSearchParams(location.search).get('owner')||'published';
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
    if(mode==='factory')core.registerFactory({name:'sidebar.panel.icon',scope:'root',children:{'sidebar.panellist':{kind:'list',scope:'root'}}},props=><span data-real-icon-factory>{PanelIcon(props)}</span>);
    else children['sidebar.panellist']={kind:'list',scope:'root'};
    core.register({name:'sidebar',children},props=>{
      const [active,setActive]=useState(null),[collapsed,setCollapsed]=useState(false);
      return <div style={{width:collapsed?56:300,height:'100vh'}}><SidebarRoot {...props}
        renderFactorySlot={mode==='legacy-renderer'?undefined:props.renderFactorySlot}
        collapsed={collapsed} drawer={false} width={300} toggleSidebar={()=>setCollapsed(!collapsed)}
        startSession={()=>{}} setPinned={()=>{}} trackEntryClick={()=>{}} selectPanel={setActive}
        usePanels={select=>select([{id:'plugins',label:'工具'},{id:'schedules',label:'定时任务'}])}
        useEntryPins={select=>select([])} useEntryActions={select=>select(false)} useRemoteAccess={()=>true}
        useShortcuts={select=>select([])} usePanelInfo={select=>select({activePanelId:active})} t={key=>key}/></div>;
    });
    core.register({name:'sidebar.workspaces'},({wide,panelNavigation})=><section className={'cmd-projects '+(wide?'':'cmd-narrow')}><nav className='cmd-sidebar-nav'><button>新对话</button></nav><div className='cmd-sidebar-navigation'>{panelNavigation}</div><p>最近会话</p></section>);
    core.register({name:'sidebar.settings'},()=><button>设置</button>);
    for(const id of ['plugins','schedules'])core.register({name:'sidebar.panellist',id},({size,active})=><UIIcon name={id} size={size} selected={active}/>);
    createRoot(document.getElementById('app')).render(createSlotRenderer().renderRoot(host,{}));
  ` }, bundle: true, write: false, format: 'iife', jsx: 'automatic',
    alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')), '@deepseek-ai/dsh-client-ui-slots': join(root, 'deepseek-harness/packages/client/ui-slots/src/index.ts') },
    nodePaths: [join(root, 'plugins/benchgo/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')], loader: { '.css': 'text' },
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
      await page.goto('https://sidebar.test/?owner=' + owner);
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
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
