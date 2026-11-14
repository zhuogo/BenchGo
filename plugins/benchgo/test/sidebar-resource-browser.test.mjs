import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { sharedUiStyles } from '../scripts/shared-ui.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url));
const { chromium } = require('playwright');
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || [chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);

test('cross-device sidebar persists scope and renders device states while retaining the owner view', { skip: !executablePath }, async () => {
  const bundle = await build({ stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React from 'react';import {createRoot} from 'react-dom/client';
    import {Projects,setFixtureState} from './plugins/benchgo/client/index.jsx';
    import {moduleSource} from './plugins/benchgo/client/modules.mjs';
    import hostCss from './plugins/benchgo/client/style.css';
    import tokens from './deepseek-harness/packages/client/ui-theme/src/styles/design-platform.css';
    import themeBase from './deepseek-harness/packages/client/ui-theme/src/styles/base.css';
    import {installIconSprite} from './deepseek-harness/packages/client/ui-theme/src/client/icon-sprite.ts';
    installIconSprite({effect:effect=>effect(),on(){}},undefined);
    moduleSource.update({base:true,harness:true,superagent:false,link:true});
    const ids=Array.from({length:40},(_,i)=>'session-'+i);
    const sessions={ids,byId:Object.fromEntries(ids.map((id,i)=>[id,{id,title:'测试对话 '+i,blank:false,updatedAt:40-i}]))};
    const workspaceItems=[{workspaceId:'recent-local',title:'default-workspace',path:'/local/recent',sessionIds:ids,isDefault:true},{workspaceId:'local-project',title:'本机项目',path:'/local/project',sessionIds:[]}];
    const workspaces={phase:'ready',items:workspaceItems,archivedSessionIds:[],pinnedSessionIds:[]},statuses=new Map();
    const source=snapshot=>({getSnapshot:()=>snapshot,subscribe:()=>()=>{}});
    window.navigationCalls=[];
    const host={layout:{panelInfo:source({activePanelId:null})},sessions:{list:source(sessions)},workspaces:{list:source(workspaces)},uiSession:{sessionStatus:source(statuses)},remoteAccess:{source:()=>source(true)},uiWorkspace:{openSession:id=>window.navigationCalls.push({kind:'session',id})}};
    window.scenario=mode=>{sessions.ids=mode==='data'?ids:[];sessions.byId=mode==='data'?Object.fromEntries(ids.map((id,i)=>[id,{id,title:'测试对话 '+i,blank:false,updatedAt:40-i}])):{};workspaces.phase=mode==='loading'?'loading':'ready';workspaces.items=mode==='data'?workspaceItems:[];setFixtureState({projects:[],sessions:[],loaded:mode!=='loading',error:mode==='error'?'连接失败，请重试':''});};
    window.scenario('data');
    const panels=<nav className="cmd-sidebar-panels">{['工具','定时任务'].map(label=><button type="button" key={label}>{label}</button>)}</nav>;
    createRoot(document.getElementById('root')).render(<><style>{tokens}{themeBase}{hostCss}</style><aside className="cmd-shell-sidebar" style={{display:'flex',flexDirection:'column',width:280,height:'100vh'}}><Projects host={host} open={async id=>window.navigationCalls.push({kind:'native',id})} newSession={async id=>window.navigationCalls.push({kind:'new',id})} renderSlot={()=>null} panelNavigation={panels}/></aside><main><p>工作台内容</p><textarea aria-label="本机草稿" defaultValue="保留的草稿"/></main></>);
  ` }, bundle: true, write: false, outdir: join(root, 'artifacts/unused-sidebar-menu'), format: 'iife', jsx: 'automatic',
    alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')) },
    nodePaths: [join(root, 'plugins/benchgo/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')],
    loader: { '.css': 'text', '.module.css': 'local-css', '.svg': 'text' },
    plugins: [{ name: 'sidebar-fixture', setup(build) {
      build.onLoad({ filter: /benchgo[\\/]client[\\/]index\.jsx$/ }, async ({ path }) => {
        // Mount the real sidebar without loading unrelated application entry points.
        const keep = ['shared/client/ui/index', 'sidebar-state.mjs', 'resource-navigation.jsx', 'resource-state.mjs', 'resource-creation.jsx', 'device-launcher.jsx', 'device-switch.jsx', "from 'react'", 'icons.json', 'dsh-client-ui-primitives', 'iconsax.jsx', 'modules.mjs', 'session-info.mjs'];
        const source = (await readFile(path, 'utf8')).split('\n').filter(line => !line.startsWith('import ') || keep.some(value => line.includes(value))).join('\n');
        return { loader: 'jsx', resolveDir: dirname(path), contents: source + '\nexport {Projects}; export function setFixtureState(value){update(value);}' };
      });
      build.onResolve({ filter: /^@deepseek-ai\/dsh-client-ui-primitives$/ }, () => ({ path: 'primitives', namespace: 'official-source' }));
      build.onLoad({ filter: /.*/, namespace: 'official-source' }, () => ({ loader: 'ts', resolveDir: root, contents: `
        export {Tooltip} from './deepseek-harness/packages/client/ui-primitives/src/Tooltip.tsx';
        export {Modal} from './deepseek-harness/packages/client/ui-primitives/src/Modal.tsx';
        export {Menu} from './deepseek-harness/packages/client/ui-primitives/src/Menu.tsx';
        export {FishLogo} from './deepseek-harness/packages/client/ui-primitives/src/FishLogo.tsx';
        export {LinkIconMedium} from './deepseek-harness/packages/client/ui-primitives/src/LinkIcon.tsx';
        export * from './deepseek-harness/packages/client/ui-primitives/src/icons/index.tsx';
      ` }));
    } }, sharedUiStyles()], define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  const browser=await chromium.launch({headless:true,executablePath});
  const screenshots=process.env.BENCHGO_SIDEBAR_SCREENSHOTS||await mkdtemp(join(tmpdir(),'benchgo-sidebar-'));await mkdir(screenshots,{recursive:true});
  try {
    const page=await browser.newPage({viewport:{width:1200,height:850},reducedMotion:'reduce'});page.setDefaultTimeout(6000);
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    const receiver=(await readFile(join(root,'plugins/link/client/resource-navigation.jsx'),'utf8')).split('export function installResourceReceiver')[1];
    let mode='data',scope={mode:'current',deviceIds:[]},saved=0,queries=0,deviceApiCalls=0,failSave=false,holdProject=false,releaseProject,holdResources=false;
    const resourceGates=new Set(),resourceQueries=[];
    let recentCount=1;
    const devices=[{id:'local',name:'当前主机',kind:'local',status:'online'},{id:'remote',name:'开发设备',kind:'computer',status:'unknown'},{id:'second',name:'第二设备',kind:'computer',status:'online'}];
    const styles=bundle.outputFiles.filter(f=>f.path.endsWith('.css')).map(f=>f.text).join('\n');
    await page.route('**/*',async route=>{const url=new URL(route.request().url());
      if(url.pathname==='/api/commander-devices'){
        deviceApiCalls++;
        const body=route.request().postDataJSON();
        if(body.action==='devices')return route.fulfill({json:{activeId:'local',devices}});
        if(body.action==='resourceScope')return route.fulfill({json:{scope}});
        if(body.action==='setResourceScope'){if(failSave)return route.fulfill({status:503,json:{error:'保存暂不可用'}});scope=body.scope;saved++;return route.fulfill({json:{scope}});}
        if(body.action==='resources'){
          queries++;
          resourceQueries.push(body);
          const requestMode=mode;
          if(body.kind==='sessions'&&holdProject){await new Promise(resolve=>releaseProject=resolve);return route.fulfill({json:{devices:[{deviceId:'remote',available:true,items:[{deviceId:'remote',kind:'sessions',resourceId:'late',title:'迟到对话'}]}]}});}
          if(holdResources)await new Promise(resolve=>resourceGates.add(resolve));
          if(requestMode==='loading')await new Promise(resolve=>setTimeout(resolve,700));
          const failed=requestMode==='error'||requestMode==='offline';
          const source=requestMode==='empty'||requestMode==='error'?[]:body.kind==='projects'?[{deviceId:body.deviceId,kind:'projects',resourceId:'default-id',id:'default-id',title:'default-workspace',isDefault:true},{deviceId:body.deviceId,kind:'projects',resourceId:'same-id',id:'same-id',title:body.deviceId==='second'?'第二设备项目':'远端项目',path:'/target/project'}]:Array.from({length:body.kind==='recent'&&body.deviceId==='remote'?recentCount:1},(_,i)=>({deviceId:body.deviceId,kind:body.kind,resourceId:'session-'+i,id:'session-'+i,projectId:'default-id',title:(body.deviceId==='second'?'第二设备最近':'远端最近')+(i?' '+i:''),updatedAt:(body.deviceId==='second'?35.5:50)-i,native:false}));
          const offset=body.offset||0,limit=body.limit||30,items=source.slice(offset,offset+limit);
          devices.find(device=>device.id===body.deviceId).status=failed?'offline':'online';
          return route.fulfill({json:{devices:[{deviceId:body.deviceId,available:!failed,reason:failed?'连接失败，请重试':null,items,freshness:requestMode==='offline'?'stale':'fresh',observedAt:Date.now(),offset,limit,hasMore:offset+items.length<source.length}],partial:failed}});
        }
        if(body.action==='select')return route.fulfill({json:{url:'http://127.0.0.1:17992/remote'}});
        return route.fulfill({json:{}});
      }
      if(url.pathname==='/remote')return route.fulfill({contentType:'text/html',body:'<html><head><meta charset="utf-8"></head><body>目标设备工作台<script>window.calls=[];function installResourceReceiver'+receiver+';installResourceReceiver({sessions:{list:{getSnapshot:()=>({phase:"ready",ids:["session-0","target-session"]})}},workspaces:{list:{getSnapshot:()=>({phase:"ready",items:[{workspaceId:"same-id",sessionIds:["target-session"]}]})}},uiWorkspace:{openSession:id=>window.calls.push({kind:"official",id})}},{open:async id=>window.calls.push({kind:"native",id}),newSession:async id=>window.calls.push({kind:"new",id}),addProject:()=>window.calls.push({kind:"project"})});</script></body></html>'});
      return route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>'+styles+'body{margin:0;font-family:Arial;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}#root{display:flex}main{position:relative;flex:1;min-width:0;padding:40px}textarea{max-width:100%;box-sizing:border-box}</style></head><body><div id="root"></div></body></html>'});
    });
    await page.goto('http://127.0.0.1:17991/');await page.clock.install();await page.addScriptTag({content:bundle.outputFiles.find(f=>f.path.endsWith('.js')).text});
    const deviceSnapshot=()=>page.waitForResponse(response=>new URL(response.url()).pathname==='/api/commander-devices'&&response.request().postDataJSON().action==='devices');
    const refresh=async()=>{const finished=deviceSnapshot();await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await finished;};
    const releaseResources=()=>{holdResources=false;for(const release of resourceGates)release();resourceGates.clear();};
    const waitForHeldBatch=async()=>{const end=Date.now()+6000;while(resourceGates.size<4&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(resourceGates.size,4);};
    await page.getByRole('button',{name:'显示范围',exact:true}).waitFor();assert.equal(queries,0,'current scope never queries other devices');
    const assertNavigation=async()=>{
      const geometry=await page.evaluate(()=>{
        const row=document.querySelector('.cmd-sidebar-navigation').getBoundingClientRect();
        const buttons=[...document.querySelectorAll('.cmd-sidebar-navigation button')].map(button=>{const r=button.getBoundingClientRect();return {left:r.left,right:r.right,center:r.y+r.height/2};});
        return {left:row.left,right:row.right,buttons,inToolbar:!!document.querySelector('.cmd-sidebar-nav .cmd-resource-scope')};
      });
      assert.equal(geometry.inToolbar,false);assert.equal(geometry.buttons.length,3);
      const widths=geometry.buttons.map(button=>button.right-button.left);assert(widths[1]>widths[0]&&widths[0]>widths[2],JSON.stringify(geometry));
      geometry.buttons.forEach((button,i)=>{assert(button.left>=geometry.left&&button.right<=geometry.right,JSON.stringify(geometry));assert(Math.abs(button.center-geometry.buttons[0].center)<1,JSON.stringify(geometry));if(i)assert(geometry.buttons[i-1].right<=button.left,JSON.stringify(geometry));});
    };
    for(const width of [240,280,400]){await page.locator('aside').evaluate((node,width)=>node.style.width=width+'px',width);await assertNavigation();}
    await page.locator('aside').evaluate(node=>node.style.width='280px');
    mode='loading';holdResources=true;
    const firstSnapshot=deviceSnapshot();
    await page.getByRole('button',{name:'显示范围',exact:true}).click();await page.getByRole('menuitem',{name:'所有已连接设备'}).click();
    await page.getByText('正在读取 开发设备…',{exact:true}).first().waitFor();
    assert.equal(await page.locator('.cmd-resource-group-title').filter({hasText:'开发设备'}).locator('small').count(),0);
    assert.equal(await page.getByText('未检测',{exact:true}).count(),0);
    await page.screenshot({path:join(screenshots,'light-loading.png')});
    await page.evaluate(()=>document.body.setAttribute('data-ds-dark-theme',''));await page.setViewportSize({width:500,height:700});
    await page.screenshot({path:join(screenshots,'dark-loading.png')});
    await page.evaluate(()=>document.body.removeAttribute('data-ds-dark-theme'));await page.setViewportSize({width:1200,height:850});
    releaseResources();await firstSnapshot;
    await page.locator('.cmd-resource-group-title').filter({hasText:'开发设备'}).locator('small').filter({hasText:'可连接'}).waitFor();
    mode='data';
    await page.getByText('远端项目',{exact:true}).waitFor();await page.locator('#cmd-recent-section').getByText('远端最近',{exact:true}).waitFor();assert.equal(scope.mode,'all');assert.equal(saved,1);
    await page.locator('#cmd-recent-section').getByText('第二设备最近',{exact:true}).waitFor();
    assert.equal(await page.locator('#cmd-project-section').getByText('default-workspace',{exact:true}).count(),0,'default workspaces belong to Recent on every device');
    assert.equal(await page.locator('#cmd-recent-section .cmd-resource-group-title').count(),0,'Recent has no device grouping or disclosure');
    const recentTitles=(await page.locator('#cmd-recent-section .cmd-session > span').allTextContents()).filter(title=>title.trim());
    assert.deepEqual(recentTitles.slice(0,3),['远端最近','测试对话 0','测试对话 1']);
    assert(recentTitles.indexOf('第二设备最近')>recentTitles.indexOf('测试对话 4')&&recentTitles.indexOf('第二设备最近')<recentTitles.indexOf('测试对话 5'),'devices share one activity order');
    assert.equal(recentTitles.length,42,'opaque matching session ids remain separate across devices');
    await page.screenshot({path:join(screenshots,'light-data.png')});
    holdProject=true;await page.getByRole('button',{name:'展开 开发设备 的 远端项目 对话',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.cmd-project-children'));
    await page.getByRole('button',{name:'显示范围',exact:true}).click();await page.getByRole('menuitem',{name:'当前设备（工作台主机）',exact:true}).click();holdProject=false;releaseProject();
    await page.getByRole('button',{name:'显示范围',exact:true}).click();await page.getByRole('menuitem',{name:'所有已连接设备',exact:true}).click();await page.getByText('远端项目',{exact:true}).waitFor();await page.getByRole('button',{name:'展开 开发设备 的 远端项目 对话',exact:true}).click();await page.locator('.cmd-project-children').getByText('远端最近',{exact:true}).waitFor();assert.equal(await page.getByText('迟到对话',{exact:true}).count(),0);

    await page.getByLabel('本机草稿',{exact:true}).fill('未发送的本机草稿');
    const openRemote=async()=>{await page.locator('#cmd-recent-section').getByText('远端最近',{exact:true}).click();await page.locator('.cmd-resource-stage iframe').waitFor();await page.waitForFunction(()=>document.querySelector('.cmd-resource-stage-status')?.hidden);};
    const assertLocalRestored=async()=>{await page.locator('.cmd-resource-stage').waitFor({state:'detached'});assert.equal(await page.getByLabel('本机草稿',{exact:true}).inputValue(),'未发送的本机草稿');assert.equal(await page.getByLabel('本机草稿',{exact:true}).isEditable(),true);};
    await openRemote();
    assert.equal(await page.frameLocator('.cmd-resource-stage iframe').locator('body').innerText(),'目标设备工作台');assert.deepEqual(await page.frameLocator('.cmd-resource-stage iframe').locator('body').evaluate(()=>window.calls),[{kind:'official',id:'session-0'}]);assert.equal(await page.locator('.cmd-sidebar-content').isVisible(),true);
    assert.equal(await page.locator('.cmd-resource-stage header').count(),0);
    await page.locator('#cmd-recent-section .cmd-session').filter({hasText:'测试对话 0'}).click();await assertLocalRestored();
    assert.deepEqual(await page.evaluate(()=>window.navigationCalls.at(-1)),{kind:'session',id:'session-0'});
    const localProject=page.getByRole('button',{name:'本机项目',exact:true});
    for(const expanded of [true,false]){await openRemote();await localProject.click();await assertLocalRestored();assert.equal(await localProject.getAttribute('aria-expanded'),String(expanded));}
    await openRemote();await page.getByRole('button',{name:'在 本机项目 新聊天',exact:true}).click();await assertLocalRestored();
    assert.deepEqual(await page.evaluate(()=>window.navigationCalls.at(-1)),{kind:'new',id:'local-project'});
    await openRemote();await page.getByRole('button',{name:'工具',exact:true}).click();await assertLocalRestored();
    for(const name of ['最近新聊天','创建新聊天']){
      await openRemote();await page.getByRole('button',{name,exact:true}).click();
      await page.getByRole('dialog',{name:'新会话',exact:true}).waitFor();
      await page.getByRole('button',{name:'取消',exact:true}).click();
      assert.equal(await page.locator('.cmd-resource-stage').count(),1,'cancelling creation preserves the remote resource view');
      await page.getByRole('button',{name,exact:true}).click();
      await page.getByRole('button',{name:'创建会话',exact:true}).click();await assertLocalRestored();
      assert.equal(await page.evaluate(()=>window.navigationCalls.at(-1).kind),'new');
      assert.equal(await page.evaluate(()=>window.navigationCalls.at(-1).id),undefined);
    }
    // The next scheduled refresh keeps the sidebar stable while requests are in flight.
    holdResources=true;
    const pendingResource=page.waitForRequest(request=>new URL(request.url()).pathname==='/api/commander-devices'&&request.postDataJSON().action==='resources');
    await page.clock.runFor(30_001);await pendingResource;await waitForHeldBatch();
    const activeQueries=queries;
    assert.equal(resourceGates.size,4,'one bounded refresh queries each remote list once');
    assert.equal(await page.getByText('正在读取 开发设备…',{exact:true}).count(),0,'cached navigation refreshes silently');
    assert.equal(await page.getByText('远端项目',{exact:true}).count(),1);
    await page.screenshot({path:join(screenshots,'light-background-refresh.png')});
    await page.evaluate(()=>{document.dispatchEvent(new Event('visibilitychange'));document.dispatchEvent(new Event('visibilitychange'));});
    await page.clock.runFor(60_001);
    assert.equal(queries,activeQueries,'visibility and elapsed periods never overlap an active refresh');
    const completedRefresh=deviceSnapshot();releaseResources();await completedRefresh;

    // Hidden pages cancel the active read and do not start work until visible again.
    mode='error';holdResources=true;
    const beforeHide=page.waitForRequest(request=>new URL(request.url()).pathname==='/api/commander-devices'&&request.postDataJSON().action==='resources');
    await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await beforeHide;await waitForHeldBatch();
    const hiddenQueries=queries;
    await page.evaluate(()=>{window.sidebarHidden=true;Object.defineProperty(document,'hidden',{configurable:true,get:()=>window.sidebarHidden});document.dispatchEvent(new Event('visibilitychange'));});
    await page.clock.runFor(60_001);
    assert.equal(queries,hiddenQueries,'hidden sidebar starts no polling requests');
    mode='data';holdResources=false;
    await page.evaluate(()=>{window.sidebarHidden=false;});await refresh();
    releaseResources();await page.evaluate(()=>Promise.resolve());
    await page.locator('#cmd-recent-section').getByText('远端最近',{exact:true}).waitFor();
    assert.equal(await page.locator('.cmd-resource-warning').count(),0,'cancelled late errors cannot replace the successful visible refresh');

    // Loaded coverage reaches the real hook and is refreshed in one bounded request.
    recentCount=95;await refresh();
    const recent=page.locator('#cmd-recent-section');
    await recent.getByText('远端最近 29',{exact:true}).waitFor();
    for(const last of [59,89]){
      await recent.getByRole('button',{name:'加载更多 · 开发设备',exact:true}).click();
      await recent.getByText('远端最近 '+last,{exact:true}).waitFor();
    }
    const queryStart=resourceQueries.length;
    await refresh();
    assert.deepEqual(resourceQueries.slice(queryStart).filter(row=>row.deviceId==='remote'&&row.kind==='recent').map(({offset,limit})=>[offset,limit]),[[0,90]]);
    await recent.getByText('远端最近 89',{exact:true}).waitFor();
    assert.equal(await recent.getByText('远端最近 90',{exact:true}).count(),0,'refresh does not fetch unloaded history');
    assert.equal(await recent.getByRole('button',{name:'加载更多 · 开发设备',exact:true}).isEnabled(),true);
    recentCount=1;await refresh();
    assert.equal(await recent.getByText('远端最近 1',{exact:true}).count(),0,'shrinking lists remove deleted summaries');
    assert.equal(await recent.getByRole('button',{name:'加载更多 · 开发设备',exact:true}).count(),0);

    for(const state of ['empty','error','offline','data']) {
      mode=state;
      await page.evaluate(state=>window.scenario(state==='empty'?'empty':'data'),state);
      await refresh();
      if(state==='empty')await page.getByText('暂无最近对话',{exact:true}).waitFor();
      else if(state==='error'||state==='offline')await page.getByText('连接失败，请重试',{exact:false}).first().waitFor();
      else await page.locator('#cmd-recent-section').getByText('远端最近',{exact:true}).waitFor();
      for(const theme of ['light','dark']){
        await page.evaluate(dark=>document.body.toggleAttribute('data-ds-dark-theme',dark),theme==='dark');
        await page.setViewportSize(theme==='dark'?{width:500,height:700}:{width:1200,height:850});
        await page.screenshot({path:join(screenshots,theme+'-'+state+'.png')});
      }
    }
    await page.evaluate(()=>document.body.setAttribute('data-ds-dark-theme',''));await page.setViewportSize({width:500,height:700});await page.screenshot({path:join(screenshots,'dark-narrow.png')});
    await page.getByRole('button',{name:'显示范围',exact:true}).click();await page.getByRole('menuitem',{name:'指定设备',exact:true}).click();await page.getByLabel('开发设备',{exact:false}).check();await page.keyboard.press('Escape');assert.deepEqual(scope.deviceIds,['remote']);
    await page.reload();await page.addScriptTag({content:bundle.outputFiles.find(f=>f.path.endsWith('.js')).text});await page.locator('#cmd-recent-section').getByText('远端最近',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'对话操作：测试对话 0',exact:true}).count(),0,'selected scope restores without showing local resources');
    failSave=true;await page.getByRole('button',{name:'显示范围',exact:true}).click();await page.getByRole('menuitem',{name:'当前设备（工作台主机）',exact:true}).click();await page.locator('.cmd-resource-save-error').waitFor();assert.equal(scope.mode,'selected');failSave=false;await page.getByRole('button',{name:'重试保存',exact:true}).click();await page.locator('.cmd-resource-save-error').waitFor({state:'detached'});assert.equal(scope.mode,'current');
    await page.goto('http://127.0.0.1:17991/link/workbench/');
    await page.evaluate(()=>{window.__DSH_LINK_WORKBENCH__=true;window.__DSH_TRANSPORT__={ownsHost:false};});
    deviceApiCalls=0;
    await page.addScriptTag({content:bundle.outputFiles.find(f=>f.path.endsWith('.js')).text});
    await page.getByRole('button',{name:'对话操作：测试对话 0',exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'显示范围',exact:true}).count(),0,'paired workbench has no owner-only resource scope');
    await page.getByRole('button',{name:'本机项目',exact:false}).first().click();
    await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
    assert.equal(deviceApiCalls,0,'paired workbench never requests owner device APIs');
    assert.equal(await page.locator('#cmd-recent-section').getByText('测试对话 0',{exact:true}).count(),1);
    await page.screenshot({path:join(screenshots,'remote-authorized-workbench.png')});
    assert.deepEqual(errors,[]);
  }finally{await browser.close();if(!process.env.BENCHGO_SIDEBAR_SCREENSHOTS)await rm(screenshots,{recursive:true,force:true});}
});
