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

test('sidebar keeps panel navigation below quick actions across rail, drawer and resource states', { skip: !executablePath }, async () => {
  const result = await build({ stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
    import {SidebarRoot} from './deepseek-harness/packages/client/ui-sidebar/src/client/SidebarRoot.tsx';
    import css from './plugins/benchgo/client/style.css';
    import {UIIcon} from './plugins/benchgo/client/iconsax.jsx';
    function App(){const [mode,setMode]=useState('data'),[collapsed,setCollapsed]=useState(false),[drawer,setDrawer]=useState(false),[active,setActive]=useState(null);
      window.scenario=(mode,collapsed,drawer)=>{setMode(mode);setCollapsed(collapsed);setDrawer(drawer)};
      const panels=[{id:'plugins',label:'工具'},{id:'schedules',label:'定时任务'}];
      return <><style>{css}</style><div style={{width:collapsed&&!drawer?56:300,height:'100vh'}}><SidebarRoot collapsed={collapsed} drawer={drawer} width={300}
        toggleSidebar={()=>setCollapsed(!collapsed)} startSession={()=>{}} setPinned={()=>{}} trackEntryClick={()=>{}} selectPanel={setActive}
        usePanels={select=>select(panels)} useEntryPins={select=>select([])} useEntryActions={select=>select(false)} useRemoteAccess={()=>true}
        useShortcuts={select=>select([])} usePanelInfo={select=>select({activePanelId:active})} t={key=>key}
        renderSlot={(name,props={},options={})=>name==='sidebar.panellist'?<UIIcon name={options.only} size={props.size} selected={props.active}/>:name==='sidebar.workspaces'?
          <section className={'cmd-projects '+(props.wide?'':'cmd-narrow')}><nav className='cmd-sidebar-nav' aria-label='快捷工具栏'>{['连接','新对话','搜索'].map(label=><button aria-label={label} key={label}>{label.slice(0,1)}</button>)}</nav><div className='cmd-sidebar-navigation'>{props.panelNavigation}<div className='cmd-resource-scope'><button aria-label='显示范围' aria-haspopup='menu'><UIIcon name="filter" size={16}/><span className="cmd-resource-scope-label">显示</span></button></div></div>{props.wide&&<div className='cmd-sidebar-content'>{mode==='data'?Array.from({length:60},(_,i)=><p key={i}>会话 {i+1}</p>):<p role={mode==='error'?'alert':'status'}>{mode==='loading'?'正在加载':mode==='error'?'连接失败，请重试':'暂无对话'}</p>}</div>}</section>:
          name==='sidebar.settings'?<button aria-label='设置'>设置</button>:null}/></div></>;
    }createRoot(document.getElementById('app')).render(<App/>);
  ` }, bundle: true, write: false, format: 'iife', jsx: 'automatic',
    alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')) },
    nodePaths: [join(root, 'plugins/benchgo/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')], loader: { '.css': 'text' },
    plugins: [{name:'host-primitives-fixture',setup(build){
      build.onResolve({filter:/^@deepseek-ai\/dsh-client-ui-primitives$/},()=>({path:'primitives',namespace:'fixture'}));
      build.onLoad({filter:/.*/,namespace:'fixture'},()=>({loader:'jsx',resolveDir:root,contents:`import React from 'react';const Icon=()=> <svg width="16" height="16"/>;export const FishLogo=Icon,IconAppsAddOutlineRegular=Icon,IconNewChatOutlineMedium=Icon,IconNewChatOutlineRegular=Icon,IconPanelLeftOutlineRegular=Icon,IconPinFillRegular=Icon;export const Tooltip=({children})=>children,Menu=()=>null,ShortcutKeys=()=>null,Toast=()=>null;export const useModalLayer=()=>{},isBehindModal=()=>false,isDarwinDesktop=()=>false,focusWithoutRing=el=>el.focus(),writeClipboard=async()=>true;`}));
    }},shellUi()], define: { 'process.env.NODE_ENV':'"production"', 'process.env.DSH_CLIENT_VERSION':'undefined', 'process.env.DSH_CLIENT_COMMIT_HASH':'undefined', 'process.env.DSH_CLIENT_GIT_DIRTY':'undefined' },logLevel:'silent' });
  const browser=await chromium.launch({headless:true,executablePath});
  try{
    const page=await browser.newPage(),errors=[];page.setDefaultTimeout(5000);page.on('pageerror',error=>errors.push(error.message));
    await page.setContent('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font-family:Arial,sans-serif;--dsw-specific-sidebar-fill:#f4f5f7;--dsw-alias-label-primary:#242424;--dsw-alias-label-secondary:#666;--dsw-alias-interactive-bg-hover:#e8eaf0}</style></head><body><div id="app"></div></body></html>');
    await page.addScriptTag({content:result.outputFiles[0].text});
    for(const [width,collapsed,drawer] of [[1440,false,false],[1440,true,false],[390,false,true]]){
      await page.setViewportSize({width,height:900});
      for(const mode of ['loading','error','empty','data']){
        await page.evaluate(args=>window.scenario(...args),[mode,collapsed,drawer]);
        await page.getByRole('button',{name:'定时任务',exact:true}).waitFor().catch(async error=>{throw new Error(JSON.stringify({width,collapsed,mode,errors,body:await page.locator('body').innerText()}),{cause:error})});
        const geometry=await page.evaluate(()=>{
          const quick=document.querySelector('.cmd-sidebar-nav'),panels=document.querySelector('.cmd-sidebar-panels'),footer=document.querySelector('[class*="_footArea"]');
          const a=quick.getBoundingClientRect(),b=panels.getBoundingClientRect(),c=footer.getBoundingClientRect();
          const buttons=[...panels.querySelectorAll('button'),document.querySelector('.cmd-resource-scope button')],rows=buttons.map(button=>{const r=button.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,center:r.y+r.height/2}});
          return {quickBottom:a.bottom,panelTop:b.top,footerBottom:c.bottom,rows,labels:buttons.map(button=>button.getAttribute('aria-label')),overflow:document.documentElement.scrollWidth>innerWidth,ordered:!!(quick.compareDocumentPosition(panels)&Node.DOCUMENT_POSITION_FOLLOWING)};
        });
        assert(geometry.ordered && geometry.panelTop>=geometry.quickBottom,JSON.stringify({width,mode,geometry}));
        assert(!geometry.overflow);assert(geometry.footerBottom<=901);
        assert.deepEqual(geometry.labels,['工具','定时任务','显示范围']);
        for(const label of ['工具','定时任务'])assert.equal(await page.getByRole('button',{name:label,exact:true}).locator('.cmd-ui-icon svg').count(),2,'Panel entries must render their real Iconsax assets');
        if(!collapsed || drawer){
          assert(Math.abs(geometry.rows[0].center-geometry.rows[1].center)<1,'工具与定时任务必须在同一行：'+JSON.stringify(geometry.rows));
          assert(geometry.rows[0].right<=geometry.rows[1].left,'两个入口不可重叠');
          assert(Math.abs(geometry.rows[1].center-geometry.rows[2].center)<1,'显示范围必须与工具、定时任务同行');
          assert(geometry.rows[1].right<=geometry.rows[2].left,'显示范围不可与定时任务重叠');
          const widths=geometry.rows.map(row=>row.right-row.left);
          assert(widths[1]>widths[0]&&widths[0]>widths[2],'Schedule entry needs more room: '+JSON.stringify(widths));
          assert.equal(await page.locator('.cmd-resource-scope-label').innerText(),'显示');
          assert(await page.locator('.cmd-resource-scope-label').isVisible());
        }else{
          assert(geometry.rows[1].bottom<=geometry.rows[2].top,'收起后显示范围应位于面板入口下方');
          assert.equal(await page.locator('.cmd-resource-scope-label').isVisible(),false);
        }
        assert.equal(await page.getByRole('button',{name:'工作台',exact:true}).count(),0);
        if(!collapsed)await page.getByText(mode==='data'?'会话 1':mode==='loading'?'正在加载':mode==='error'?'连接失败，请重试':'暂无对话',{exact:true}).waitFor();
      }
      await page.getByRole('button',{name:'定时任务',exact:true}).click();
      assert.equal(await page.getByRole('button',{name:'定时任务',exact:true}).getAttribute('aria-current'),'page');
      if(process.env.BENCHGO_SIDEBAR_SCREENSHOTS){await mkdir(process.env.BENCHGO_SIDEBAR_SCREENSHOTS,{recursive:true});await page.screenshot({path:join(process.env.BENCHGO_SIDEBAR_SCREENSHOTS,`sidebar-${width}-${collapsed?'rail':drawer?'drawer':'wide'}.png`)});}
    }
    assert.deepEqual(errors,[]);
    const workbench=await readFile(new URL('../../workbench/client/index.jsx',import.meta.url),'utf8');
    assert(!/name: 'sidebar\.panellist', id: PANEL/.test(workbench));
  }finally{await browser.close();}
});
