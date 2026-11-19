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
    import React, {useState} from 'react';import {createRoot} from 'react-dom/client';
    import {Projects,setFixtureState} from './plugins/base/client/index.jsx';
    import {SessionDevicePicker} from './plugins/base/client/session-device-picker.jsx';
    import {ConversationContent} from './deepseek-harness/packages/client/ui-conversation/src/client/skeleton/ConversationContent.tsx';
    import conversationCss from './deepseek-harness/packages/client/ui-conversation/src/client/skeleton/ConversationRoot.module.css';
    import {moduleSource} from './plugins/base/client/modules.mjs';
    import hostCss from './plugins/base/client/style.css';
    import tokens from './deepseek-harness/packages/client/ui-theme/src/styles/design-platform.css';
    import themeBase from './deepseek-harness/packages/client/ui-theme/src/styles/base.css';
    import surfaces from './deepseek-harness/packages/client/ui-theme/src/styles/gradient-shadow-text.css';
    import {installIconSprite} from './deepseek-harness/packages/client/ui-theme/src/client/icon-sprite.ts';
    installIconSprite({effect:effect=>effect(),on(){}},undefined);
    moduleSource.update({base:true,harness:true,superagent:false,link:true});
    const ids=Array.from({length:40},(_,i)=>'session-'+i);
    const sessions={ids,byId:Object.fromEntries(ids.map((id,i)=>[id,{id,title:'测试对话 '+i,blank:false,updatedAt:40-i}]))};
    const workspaceItems=[{workspaceId:'recent-local',title:'default-workspace',path:'/local/recent',sessionIds:ids,isDefault:true},{workspaceId:'local-project',title:'本机项目',path:'/local/project',sessionIds:[]}];
    const workspaces={phase:'ready',items:workspaceItems,archivedSessionIds:[],pinnedSessionIds:[]},statuses=new Map();
    const source=snapshot=>({getSnapshot:()=>snapshot,subscribe:()=>()=>{}});
    window.navigationCalls=[];
    window.localMutationCalls=[];
    const unexpectedLocal=(operation,id)=>{window.localMutationCalls.push({operation,id});throw Error('不能修改同 ID 的本机会话');};
    const host={layout:{panelInfo:source({activePanelId:null})},sessions:{list:source(sessions),using:id=>unexpectedLocal('rename',id)},workspaces:{list:source(workspaces),delete:id=>unexpectedLocal('deleteProject',id),archiveSession:id=>unexpectedLocal('archive',id),unarchiveSession:id=>unexpectedLocal('unarchive',id)},uiSession:{sessionStatus:source(statuses)},remoteAccess:{source:()=>source(true)},uiWorkspace:{openSession:id=>window.navigationCalls.push({kind:'session',id}),pinSession:id=>unexpectedLocal('pin',id),unpinSession:id=>unexpectedLocal('unpin',id),forkSession:id=>unexpectedLocal('fork',id)}};
    window.scenario=mode=>{sessions.ids=mode==='data'?ids:[];sessions.byId=mode==='data'?Object.fromEntries(ids.map((id,i)=>[id,{id,title:'测试对话 '+i,blank:false,updatedAt:40-i}])):{};workspaces.phase=mode==='loading'?'loading':'ready';workspaces.items=mode==='data'?workspaceItems:[];setFixtureState({projects:[],sessions:[],loaded:mode!=='loading',error:mode==='error'?'连接失败，请重试':''});};
    window.scenario('data');
    const panels=<nav className="cmd-sidebar-panels">{['工具','定时任务'].map(label=><button type="button" key={label}>{label}</button>)}</nav>;
    const styles=<style>{tokens}{themeBase}{surfaces}{hostCss}</style>;
    const NoViews=()=>null;
    const useFactorySlot=(name,fallback)=>name==='views'?NoViews:fallback;
    const translations={'hero.chooseWorkspace':'工作区','workspace.defaultName':'最近'};
    function FixtureConversation({hero, label, onSend}) {
      const renderSlot=(name,props)=>name==='conversation.composer.bar'?<div data-composer-card><textarea aria-label={label} defaultValue={label==='本机草稿'?'保留的草稿':''}/><button type="button" onClick={onSend}>发送</button></div>:name==='conversation.hero.agentPreset'?<button type="button">标准模式</button>:null;
      return <div className={conversationCss.root} data-phase={hero?'hero':'active'}><ConversationContent sessionId="fixture" phase={hero?'hero':'active'} hero={hero} variant="standalone" useSession={fn=>fn({id:'fixture'})} useSessions={fn=>fn({byId:{fixture:{}}})} useSessionStatus={fn=>fn(new Map())} useWorkspaces={fn=>fn({phase:'ready',items:[{workspaceId:'fixture',title:'default-workspace',sessionIds:['fixture']}]})} useInput={fn=>fn({draft:''})} useComposerBlock={fn=>fn(undefined)} renderSlot={(name,props,options)=>name==='conversation.hero.frame'?options.children:renderSlot(name,props)} renderSlotChain={(name,props,options)=>options.fallback} selectWorkspace={async()=>{}} t={key=>translations[key]||key} useFactorySlot={useFactorySlot}/></div>;
    }
    function Local() {
      const [hero,setHero]=useState(false);
      return <>{styles}<aside className="cmd-shell-sidebar" style={{display:'flex',flexDirection:'column',width:280,height:'100vh'}}><Projects host={host} open={async id=>window.navigationCalls.push({kind:'native',id})} newSession={async id=>{window.navigationCalls.push({kind:'new',id});setHero(true);}} renderSlot={()=>null} panelNavigation={panels}/></aside><main><p>工作台内容</p><FixtureConversation hero={hero} label="本机草稿" onSend={()=>setHero(false)}/></main></>;
    }
    function Remote() {
      const [phase,setPhase]=useState(null),[directory,setDirectory]=useState(null);
      window.openFixtureConversation=()=>setPhase('hero');
      window.updateFixtureSessionDevices=setDirectory;
      return <>{styles}<main>{phase&&<FixtureConversation hero={phase==='hero'} label="目标设备草稿" onSend={()=>{window.calls.push({kind:'send',text:document.querySelector('textarea').value});setPhase('active');}}/>}</main><SessionDevicePicker directory={directory} onSelect={id=>directory?.select(id)}/></>;
    }
    const owner=document.getElementById('root'), remote=document.getElementById('remote-root');
    if(owner)createRoot(owner).render(<Local/>);
    if(remote)createRoot(remote).render(<Remote/>);
  ` }, bundle: true, write: false, outdir: join(root, 'artifacts/unused-sidebar-menu'), format: 'iife', jsx: 'automatic',
    alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')),
      '@deepseek-ai/dsh-util-workspace-path': join(root, 'deepseek-harness/packages/util/workspace-path/src/index.ts') },
    nodePaths: [join(root, 'plugins/base/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')],
    loader: { '.css': 'text', '.module.css': 'local-css', '.svg': 'text' },
    plugins: [{ name: 'sidebar-fixture', setup(build) {
      build.onLoad({ filter: /base[\\/]client[\\/]index\.jsx$/ }, async ({ path }) => {
        // Mount the real sidebar without loading unrelated application entry points.
        const keep = ['shared/client/ui/index', 'shared/client/ui/tooltip', 'sidebar-state.mjs', 'resource-navigation.jsx', 'resource-navigation-store.mjs', 'resource-state.mjs', 'resource-creation.jsx', 'session-device-picker.jsx', 'device-launcher.jsx', 'device-switch.jsx', "from 'react'", 'icons.json', 'dsh-client-ui-primitives', 'iconsax.jsx', 'modules.mjs', 'session-info.mjs'];
        const source = (await readFile(path, 'utf8')).split('\n').filter(line => !line.startsWith('import ') || keep.some(value => line.includes(value))).join('\n');
        return { loader: 'jsx', resolveDir: dirname(path), contents: source + '\nexport {Projects}; export function setFixtureState(value){update(value);}' };
      });
      build.onResolve({ filter: /^@deepseek-ai\/dsh-client-ui-primitives$/ }, () => ({ path: 'primitives', namespace: 'official-source' }));
      build.onLoad({ filter: /.*/, namespace: 'official-source' }, () => ({ loader: 'ts', resolveDir: root, contents: `
        export {Tooltip} from './deepseek-harness/packages/client/ui-primitives/src/Tooltip.tsx';
        export {Modal} from './deepseek-harness/packages/client/ui-primitives/src/Modal.tsx';
        export {Menu} from './deepseek-harness/packages/client/ui-primitives/src/Menu.tsx';
        export {FishLogo, FISH_LOGO_PATH, FISH_LOGO_VIEWBOX} from './deepseek-harness/packages/client/ui-primitives/src/FishLogo.tsx';
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
    let mode='data',scope={mode:'current',deviceIds:[]},saved=0,queries=0,deviceApiCalls=0,selectCalls=0,failSave=false,holdProject=false,releaseProject,holdResources=false,directoryState='held',releaseDirectory;
    const resourceGates=new Set(),resourceQueries=[];
    const mutations=new Map(),sessionActions=[];
    let capabilityMode='data',failSessionAction=false,holdCapabilities=false,releaseCapabilities;
    let recentCount=1,projectCount=1,projectMode='data';
    let deleteMode='data',changedSelection=false,holdDefault=false;const projectDeletes=[],deletedProjects=new Set();
    let holdSelection=false, failSelection=false, releaseSelection;
    const longDeviceName='第二设备超长名称用于验证窄屏设备列表workbench-without-breaks';
    const devices=[{id:'local',name:'当前主机',kind:'local',status:'online'},{id:'remote',hostId:'target-host',authorizationId:'target-pair',name:'开发设备',kind:'computer',status:'unknown'},{id:'second',hostId:'second-host',authorizationId:'second-pair',name:longDeviceName,kind:'computer',status:'online'}];
    const styles=bundle.outputFiles.filter(f=>f.path.endsWith('.css')).map(f=>f.text).join('\n');
    const script=bundle.outputFiles.find(f=>f.path.endsWith('.js')).text;
    await page.route('**/*',async route=>{const url=new URL(route.request().url());
      if(url.pathname==='/sidebar-fixture.js')return route.fulfill({contentType:'text/javascript',body:script});
      if(url.pathname==='/api/commander-devices'){
        deviceApiCalls++;
        const body=route.request().postDataJSON();
        if(body.action==='devices'){
          if(directoryState==='held')await new Promise(resolve=>releaseDirectory=resolve);
          if(directoryState==='failed')return route.fulfill({status:503,json:{error:'设备目录暂不可用，请重试'}});
          return route.fulfill({json:{activeId:'remote',devices}});
        }
        if(body.action==='resourceScope')return route.fulfill({json:{scope}});
        if(body.action==='setResourceScope'){if(failSave)return route.fulfill({status:503,json:{error:'保存暂不可用'}});scope=body.scope;saved++;return route.fulfill({json:{scope}});}
        if(body.action==='sessionAction'){
          sessionActions.push(body);
          if(failSessionAction)return route.fulfill({status:503,json:{error:'所属设备操作失败，请重试'}});
          const key=body.deviceId+'\0'+body.id,previous=mutations.get(key)||{};
          mutations.set(key,{...previous,...({pin:{pinned:true},unpin:{pinned:false},archive:{archived:true},unarchive:{archived:false},rename:{title:body.title},delete:{deleted:true}}[body.operation])});
          return route.fulfill({json:{accepted:true,id:body.id,operation:body.operation,requestId:body.requestId,refreshRequired:true,...(body.operation==='delete'?{deleted:true}:{})}});
        }
        if(body.action==='resources'){
          queries++;
          resourceQueries.push(body);
          const requestMode=mode,stableCode=body.deviceId==='remote'?({revoked:'UNAUTHORIZED',identity:'IDENTITY_CHANGED',unsupported:'UNSUPPORTED'})[mode]:null;
          if(body.kind==='sessions'&&holdProject){const late=holdProject==='late';await new Promise(resolve=>releaseProject=resolve);if(late)return route.fulfill({json:{devices:[{deviceId:'remote',available:true,items:[{deviceId:'remote',kind:'sessions',resourceId:'late',title:'迟到对话'}]}]}});}
          if(holdResources)await new Promise(resolve=>resourceGates.add(resolve));
          if(requestMode==='loading')await new Promise(resolve=>setTimeout(resolve,700));
          if(stableCode)return route.fulfill({json:{devices:[{deviceId:body.deviceId,available:false,code:stableCode,reason:stableCode==='UNSUPPORTED'?'目标尚不支持该资源':'授权失效，请在设备中心重新核验',items:[],hasMore:false}]}});
          if(body.kind==='capabilities'){
            if(holdCapabilities&&body.deviceId==='remote')await new Promise(resolve=>releaseCapabilities=resolve);
            return route.fulfill({json:{devices:[{deviceId:body.deviceId,available:capabilityMode!=='error',reason:capabilityMode==='error'?'能力读取失败，请重试':null,items:capabilityMode==='legacy'?[]:[{id:'sessionActions',available:true,operations:capabilityMode==='restricted'?['archive']:['pin','unpin','archive','unarchive','rename','delete']},{id:'nativeSessionActions',available:true,operations:['archive','unarchive','delete']}],observedAt:Date.now(),hasMore:false}]}});
          }
          const failed=requestMode==='error'||requestMode==='offline'||body.kind==='sessions'&&projectMode==='error';
          const source=requestMode==='empty'||requestMode==='error'||body.kind==='sessions'&&projectMode==='empty'?[]:body.kind==='projects'?[{deviceId:body.deviceId,kind:'projects',resourceId:'default-id',id:'default-id',title:'default-workspace',isDefault:true},{deviceId:body.deviceId,kind:'projects',resourceId:'same-id',id:'same-id',title:body.deviceId==='second'?'第二设备项目':'远端项目',path:'/target/project'}]:Array.from({length:body.kind==='sessions'?projectCount:body.deviceId==='remote'?recentCount:1},(_,i)=>({deviceId:body.deviceId,kind:body.kind==='recent'?'sessions':body.kind,resourceId:'session-'+i,id:'session-'+i,projectId:body.kind==='sessions'?'same-id':'default-id',title:(body.kind==='sessions'?'项目对话':body.deviceId==='second'?'第二设备最近':'远端最近')+(i?' '+i:''),updatedAt:(body.deviceId==='second'?35.5:50)-i,native:false,provider:body.kind==='sessions'?'codex':'deepseek',model:body.kind==='sessions'?'exact-model-id':undefined,status:body.kind==='sessions'&&i===1?'running':'idle',pinned:body.kind==='sessions'&&i===2,archived:body.archived===true,...mutations.get(body.deviceId+'\0session-'+i)})).filter(row=>!row.deleted&&!!row.archived===!!body.archived);
          const visibleSource=body.kind==='projects'?source.filter(row=>!deletedProjects.has(body.deviceId+'\0'+row.resourceId)):source;
          const offset=body.offset||0,limit=body.limit||30,items=visibleSource.slice(offset,offset+limit);
          devices.find(device=>device.id===body.deviceId).status=failed?'offline':'online';
          return route.fulfill({json:{devices:[{deviceId:body.deviceId,available:!failed,code:failed?'QUERY_FAILED':'OK',reason:failed?'设备资源查询失败，请重试':null,items,freshness:requestMode==='offline'?'stale':'fresh',observedAt:Date.now(),offset,limit,hasMore:offset+items.length<visibleSource.length}],partial:failed}});
        }
        if(body.action==='select'){
          selectCalls++;
          if(holdSelection)await new Promise(resolve=>{releaseSelection=resolve;});
          if(failSelection)return route.fulfill({status:503,json:{error:'设备连接暂不可用'}});
          const device=devices.find(device=>device.id===body.deviceId);
          return route.fulfill({json:{device:{...device,...(changedSelection?{authorizationId:'unexpected-pair'}:{})},url:'http://127.0.0.1:17992/remote?device='+encodeURIComponent(body.deviceId)}});
        }
        return route.fulfill({json:{}});
      }
      if(url.pathname==='/target-project-delete'){const input=route.request().postDataJSON();projectDeletes.push(input);if(deleteMode==='error')return route.fulfill({status:503,json:{error:'目标项目移除失败，请重试'}});deletedProjects.add(input.deviceId+'\0'+input.id);return route.fulfill({json:{deleted:true}});}
      if(url.pathname==='/remote')return route.fulfill({contentType:'text/html; charset=utf-8',body:`<html><head><meta charset="utf-8"><style>${styles}</style></head><body>目标设备工作台<div id="remote-root"></div><script src="/sidebar-fixture.js"></script><script>
        window.calls=[];const deviceId=new URLSearchParams(location.search).get('device');
        let items=[{workspaceId:'default-id',path:'/target/default',isDefault:true,sessionIds:['session-0']},{workspaceId:'same-id',path:'/target/project',sessionIds:['target-session']}];
        const remove=async id=>{const response=await fetch('/target-project-delete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({deviceId,id})});const result=await response.json();if(!response.ok)throw Error(result.error);items=items.filter(item=>item.workspaceId!==id);};
        function installResourceReceiver${receiver};
        installResourceReceiver({sessions:{list:{getSnapshot:()=>({phase:'ready',ids:['session-0','target-session']})}},workspaces:{list:{getSnapshot:()=>({phase:'ready',items})},${deleteMode==='legacy'?'':'delete:remove,'}},uiWorkspace:{openSession:id=>window.calls.push({kind:'official',id})}}, {
          open:async id=>window.calls.push({kind:'native',id}),newSession:async id=>{window.calls.push({kind:'new',id});window.openFixtureConversation();},addProject:()=>window.calls.push({kind:'project'}),projectApi:async()=>({}),
          getDefaultProjectId:()=>${holdDefault?'new Promise(resolve=>{window.releaseDefault=()=>resolve("default-id");})':'"default-id"'},onSessionDevices:value=>window.updateFixtureSessionDevices(value),
        });</script></body></html>`});
      return route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>'+styles+'body{margin:0;font-family:Arial;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}#root{display:flex}main{position:relative;flex:1;min-width:0;padding:40px}textarea{max-width:100%;box-sizing:border-box}</style></head><body><div id="root"></div></body></html>'});
    });
    await page.goto('http://127.0.0.1:17991/');await page.clock.install();await page.addScriptTag({content:script});
    const deviceSnapshot=(count=1)=>{let observed=0;return page.waitForResponse(response=>new URL(response.url()).pathname==='/api/commander-devices'&&response.request().postDataJSON().action==='devices'&&++observed===count);};
    const refresh=async()=>{const finished=deviceSnapshot();await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await finished;};
    const releaseResources=()=>{holdResources=false;for(const release of resourceGates)release();resourceGates.clear();};
    const waitForHeldBatch=async(expected=4)=>{const end=Date.now()+6000;while(resourceGates.size<expected&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,10));assert(resourceGates.size>=expected&&resourceGates.size<=4,'resource reads keep their bounded worker pool');};
    await page.getByRole('button',{name:'显示范围',exact:true}).waitFor().catch(error=>{ throw Error(errors.join('\n') || error.message); });assert.equal(queries,0,'current scope never queries other devices');
    // Local project ownership does not depend on the optional device directory.
    // In particular, choosing All before that request completes must never
    // remove every project and Recent row from an otherwise healthy workspace.
    await page.getByRole('button',{name:'显示范围',exact:true}).click();await page.getByRole('menuitem',{name:'所有已连接设备',exact:true}).click();
    await page.getByRole('button',{name:'本机项目',exact:true}).waitFor();
    assert.equal(await page.locator('#cmd-recent-section').getByText('测试对话 0',{exact:true}).isVisible(),true);
    await page.screenshot({path:join(screenshots,'device-directory-loading-all.png')});
    directoryState='failed';releaseDirectory();
    await page.getByRole('button',{name:'重新连接设备',exact:true}).waitFor();
    assert.equal(await page.getByText('设备目录暂不可用，请重试',{exact:true}).count(),0,'startup read failures have no inline error paragraph');
    assert.equal(await page.getByRole('button',{name:'本机项目',exact:true}).isVisible(),true);
    assert.equal(await page.locator('#cmd-recent-section').getByText('测试对话 0',{exact:true}).isVisible(),true);
    assert.equal(await page.locator('.cmd-resource-group').count(),0);
    await page.screenshot({path:join(screenshots,'device-directory-failed-all.png')});
    await page.evaluate(()=>document.body.setAttribute('data-ds-dark-theme',''));await page.setViewportSize({width:500,height:700});
    await page.screenshot({path:join(screenshots,'device-directory-failed-all-dark.png')});
    await page.evaluate(()=>document.body.removeAttribute('data-ds-dark-theme'));await page.setViewportSize({width:1200,height:850});
    holdCapabilities=true;directoryState='ready';await page.clock.runFor(1001);
    await page.getByText('远端项目',{exact:true}).waitFor();await page.getByText('第二设备项目',{exact:true}).waitFor();
    await page.locator('#cmd-recent-section').getByText('远端最近',{exact:true}).waitFor();
    await page.getByRole('button',{name:'对话操作：远端最近',exact:true}).click();
    await page.locator('.cmd-actions-popover').getByText(/正在读取所属设备的会话操作能力/).waitFor();
    assert.equal(await page.getByRole('menuitem',{name:'置顶会话',exact:true}).isDisabled(),true);
    assert.equal(await page.getByRole('menuitem',{name:'复制对话 ID',exact:true}).isEnabled(),true);
    await page.screenshot({path:join(screenshots,'remote-capability-loading.png')});
    holdCapabilities=false;releaseCapabilities();
    await page.waitForFunction(()=>[...document.querySelectorAll('[role="menuitem"]')].find(node=>node.textContent==='置顶会话')?.disabled===false);
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('button',{name:'本机项目',exact:true}).count(),1);
    await page.screenshot({path:join(screenshots,'device-directory-recovered-all.png')});
    directoryState='failed';await page.evaluate(()=>document.dispatchEvent(new Event('benchgo:devices-changed')));
    await page.getByRole('button',{name:'重新连接设备',exact:true}).waitFor();
    assert.equal(await page.getByText('远端项目',{exact:true}).isVisible(),true,'directory failures retain discovered devices and their last resource summaries');
    assert.equal(await page.getByRole('button',{name:'本机项目',exact:true}).isVisible(),true);
    directoryState='ready';await page.clock.runFor(1001);
    await page.locator('.cmd-resource-save-error').waitFor({state:'detached'});
    await page.clock.pauseAt(await page.evaluate(()=>Date.now()));
    mode='error';await refresh();
    await page.locator('.cmd-resource-connection[data-resource-state=connecting]').first().waitFor();
    assert.equal(await page.getByText('远端项目',{exact:true}).isVisible(),true,'failed remote reads keep previously loaded project summaries');
    assert.equal(await page.locator('#cmd-recent-section').getByText('远端最近',{exact:true}).isVisible(),true);
    assert.equal(await page.getByRole('button',{name:'本机项目',exact:true}).isVisible(),true);
    await page.screenshot({path:join(screenshots,'remote-resource-failed-all.png')});
    assert.equal(await page.getByText('设备资源查询失败，请重试',{exact:true}).count(),0,'resource reconnects have no visible failure paragraph');
    const failedBatch=resourceQueries.length;
    await page.clock.runFor(999);assert.equal(resourceQueries.length,failedBatch,'the first reconnect waits for its backoff');
    {const retried=deviceSnapshot();await page.clock.runFor(2);await retried;}
    const afterFirstRetry=resourceQueries.length;
    assert.equal(afterFirstRetry-failedBatch,4,'only failed project and Recent pages reconnect');
    assert(resourceQueries.slice(failedBatch).every(query=>query.kind!=='capabilities'),'healthy pages retain the normal refresh cadence');
    await page.clock.runFor(1999);assert.equal(resourceQueries.length,afterFirstRetry,'a repeated failure doubles the backoff');
    mode='data';{const recovered=deviceSnapshot();await page.clock.runFor(2);await recovered;}
    await page.locator('.cmd-resource-connection').first().waitFor({state:'detached'});
    await page.clock.resume();
    await page.getByRole('button',{name:'显示范围',exact:true}).click();await page.getByRole('menuitem',{name:'当前设备（工作台主机）',exact:true}).click();
    await page.getByText('远端项目',{exact:true}).waitFor({state:'detached'});
    devices.find(device=>device.id==='remote').status='unknown';
    {const reset=deviceSnapshot();await page.evaluate(()=>document.dispatchEvent(new Event('benchgo:devices-changed')));await reset;}
    saved=0;queries=0;
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
    await page.getByRole('button',{name:'开发设备 · 正在自动连接',exact:true}).first().waitFor();
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
    // The folder title and its chevron share the same local disclosure behavior.
    // Neither disclosure nor pagination is allowed to open a target or create a chat.
    const remoteProject=page.locator('.cmd-resource-group').filter({has:page.locator('.cmd-resource-group-title').filter({hasText:'开发设备'})}).locator('.cmd-project');
    const folder=remoteProject.locator('.cmd-project-name > button').first();
    assert.equal(await folder.getAttribute('aria-expanded'),'false');
    projectCount=35;
    const selectedBefore=selectCalls;
    const projectScreenshots=async state=>{for(const theme of ['light','dark']){
      await page.evaluate(dark=>document.body.toggleAttribute('data-ds-dark-theme',dark),theme==='dark');
      await page.setViewportSize(theme==='dark'?{width:500,height:700}:{width:1200,height:850});
      if(state==='data')assert.equal(await remoteProject.locator('.cmd-codex img').first().evaluate(node=>getComputedStyle(node).filter),theme==='dark'?'invert(1)':'none','monochrome provider icons stay visible in both themes');
      await folder.scrollIntoViewIfNeeded();await page.screenshot({path:join(screenshots,'project-sessions-'+state+'-'+theme+'.png')});
    }await page.evaluate(()=>document.body.removeAttribute('data-ds-dark-theme'));await page.setViewportSize({width:1200,height:850});};
    holdProject=true;
    {const read=page.waitForRequest(request=>new URL(request.url()).pathname==='/api/commander-devices'&&request.postDataJSON().kind==='sessions');await folder.click();await read;}
    await remoteProject.getByRole('button',{name:'开发设备 · 正在自动连接',exact:true}).waitFor();
    assert.equal(await remoteProject.getByText('还没有对话',{exact:true}).count(),0,'pending summaries never appear empty');
    await projectScreenshots('loading');holdProject=false;releaseProject();
    await remoteProject.locator('.cmd-project-children .cmd-session').first().waitFor();
    assert.equal(await folder.getAttribute('aria-expanded'),'true');
    assert.equal(await folder.locator('.cmd-project-chevron.cmd-rotated').count(),1);
    assert.equal(await remoteProject.locator('.cmd-session').count(),30);
    assert.equal(await remoteProject.locator('.cmd-session > span:not(.cmd-icon):not(.cmd-activity)').first().innerText(),'项目对话 2','pinned rows use the same ordering as local rows');
    assert.equal(await remoteProject.locator('.cmd-session .cmd-codex').count(),29,'idle rows use the actual Harness brand icon');
    assert.equal(await remoteProject.locator('.cmd-status-running').count(),1,'remote status uses the local Activity component');
    assert.equal(await remoteProject.locator('.cmd-session-more').count(),30);
    await page.screenshot({path:join(screenshots,'project-sessions-data.png')});
    await projectScreenshots('data');
    await remoteProject.getByRole('button',{name:'加载更多对话',exact:true}).click();await page.waitForFunction(()=>[...document.querySelectorAll('.cmd-resource-group')].find(node=>node.querySelector('.cmd-resource-group-title')?.textContent.includes('开发设备'))?.querySelectorAll('.cmd-session').length===35);
    assert.equal(await remoteProject.getByRole('button',{name:'加载更多对话',exact:true}).count(),0);
    assert.equal(selectCalls,selectedBefore);
    assert.deepEqual(await page.evaluate(()=>window.navigationCalls),[]);
    await folder.press('Enter');assert.equal(await remoteProject.locator('.cmd-project-children').count(),0);
    {const read=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/commander-devices'&&response.request().postDataJSON().kind==='sessions');await folder.press('Space');await read;await remoteProject.locator('.cmd-project-children .cmd-session').first().waitFor();}
    assert.equal(await remoteProject.locator('.cmd-session').count(),35,'collapse and reopen preserve loaded coverage');
    await remoteProject.getByRole('button',{name:'对话操作：项目对话 2',exact:true}).click();
    await page.getByRole('menuitem',{name:'取消置顶',exact:true}).waitFor();
    assert.equal(await page.getByRole('menuitem',{name:'归档对话',exact:true}).isEnabled(),true);
    assert.equal(await page.getByRole('menuitem',{name:'分叉会话',exact:true}).isDisabled(),true,'unimplemented target actions stay explicitly unavailable');
    await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw Error('clipboard denied');}}}));
    await page.getByRole('menuitem',{name:'复制对话 ID',exact:true}).click();
    const fallback=page.getByRole('textbox',{name:'会话引用',exact:true});
    await fallback.waitFor();
    assert.deepEqual(JSON.parse(await fallback.inputValue()),{deviceId:'remote',kind:'sessions',resourceId:'session-2',native:false,title:'项目对话 2',projectId:'same-id'});
    await page.keyboard.press('Escape');
    await remoteProject.getByRole('button',{name:'对话操作：项目对话 2',exact:true}).click();
    await page.screenshot({path:join(screenshots,'remote-actions-light.png')});
    await page.evaluate(()=>document.body.setAttribute('data-ds-dark-theme',''));await page.setViewportSize({width:500,height:700});
    await page.screenshot({path:join(screenshots,'remote-actions-dark-narrow.png')});
    await page.evaluate(()=>document.body.removeAttribute('data-ds-dark-theme'));await page.setViewportSize({width:1200,height:850});
    await page.getByRole('menuitem',{name:'取消置顶',exact:true}).click();
    const remoteRow=title=>remoteProject.locator('.cmd-session-row').filter({has:page.getByRole('button',{name:'对话操作：'+title,exact:true})});
    await remoteRow('项目对话 2').getByRole('button',{name:'置顶会话',exact:true}).waitFor();
    await remoteRow('项目对话 2').getByRole('button',{name:'置顶会话',exact:true}).click();
    await remoteRow('项目对话 2').getByRole('button',{name:'取消置顶',exact:true}).waitFor();
    await remoteRow('项目对话 2').getByRole('button',{name:'对话操作：项目对话 2',exact:true}).click();
    await page.getByRole('menuitem',{name:'重命名',exact:true}).click();
    await page.getByRole('textbox',{name:'会话名称',exact:true}).fill('远端改名');
    await page.getByRole('button',{name:'保存',exact:true}).click();
    await page.getByRole('dialog',{name:'重命名会话',exact:true}).waitFor({state:'detached'});
    await remoteRow('远端改名').waitFor();
    assert.equal(await page.locator('#cmd-recent-section').getByText('测试对话 2',{exact:true}).count(),1,'renaming remote session-2 never changes the local session with that id');
    failSessionAction=true;
    await remoteRow('远端改名').getByRole('button',{name:'归档对话',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'所属设备操作失败，请重试'}).waitFor();
    assert.equal(await remoteRow('远端改名').count(),1,'failed archive never pretends the owner removed it');
    await page.screenshot({path:join(screenshots,'remote-action-failure.png')});
    failSessionAction=false;
    await remoteRow('远端改名').getByRole('button',{name:'归档对话',exact:true}).click();
    await remoteRow('远端改名').waitFor({state:'detached'});
    await page.evaluate(()=>document.dispatchEvent(new Event('commander:toggle-archive')));
    await remoteProject.getByText('远端改名',{exact:true}).waitFor();
    const archivedRow=remoteProject.locator('.cmd-session-row').filter({hasText:'远端改名'});
    assert.equal(await archivedRow.getByRole('button',{name:'删除对话',exact:true}).isEnabled(),true);
    await archivedRow.getByRole('button',{name:'取消归档对话',exact:true}).click();
    await archivedRow.waitFor({state:'detached'});
    await page.evaluate(()=>document.dispatchEvent(new Event('commander:toggle-archive')));
    await remoteRow('远端改名').waitFor();
    await remoteRow('项目对话 3').getByRole('button',{name:'对话操作：项目对话 3',exact:true}).click();
    await page.getByRole('menuitem',{name:'删除对话',exact:true}).click();
    await page.getByRole('dialog',{name:'删除这条对话？',exact:true}).waitFor();
    const beforeCancel=sessionActions.length;
    await page.getByRole('button',{name:'取消',exact:true}).click();
    assert.equal(sessionActions.length,beforeCancel,'cancelled confirmation never sends an action');
    await remoteRow('项目对话 3').getByRole('button',{name:'对话操作：项目对话 3',exact:true}).click();
    await page.getByRole('menuitem',{name:'删除对话',exact:true}).click();
    await page.getByRole('dialog',{name:'删除这条对话？',exact:true}).getByRole('button',{name:'删除对话',exact:true}).click();
    await remoteRow('项目对话 3').waitFor({state:'detached'});
    assert.deepEqual(sessionActions.map(row=>row.operation),['unpin','pin','rename','archive','archive','unarchive','delete']);
    assert(sessionActions.every(row=>row.deviceId==='remote'&&row.expectedHostId==='target-host'&&row.expectedAuthorizationId==='target-pair'&&row.native===false&&row.id.startsWith('session-')&&/^sa:\d+:[\w-]+$/.test(row.requestId)),'each write binds the displayed host, pairing and opaque session to its request identity');
    assert.equal(new Set(sessionActions.map(row=>row.requestId)).size,sessionActions.length);
    assert.deepEqual(await page.evaluate(()=>window.localMutationCalls),[]);
    assert.equal(await page.locator('#cmd-recent-section').getByText('测试对话 3',{exact:true}).count(),1);
    mutations.clear();await refresh();await remoteRow('项目对话 2').waitFor();await remoteRow('项目对话 3').waitFor();
    await remoteProject.getByRole('button',{name:'加载更多对话',exact:true}).click();
    await page.waitForFunction(()=>[...document.querySelectorAll('.cmd-resource-group')].find(node=>node.querySelector('.cmd-resource-group-title')?.textContent.includes('开发设备'))?.querySelectorAll('.cmd-session').length===35);
    for(const [capability,reason] of [['legacy','升级目标设备'],['error','能力读取失败'],['restricted',null]]){
      capabilityMode=capability;await refresh();
      await remoteRow('项目对话 2').getByRole('button',{name:'对话操作：项目对话 2',exact:true}).click();
      await page.waitForFunction(()=>document.querySelector('[role="menuitem"]:disabled'));
      if(reason)await page.locator('.cmd-actions-popover').getByText(new RegExp(reason)).waitFor();
      assert.equal(await page.getByRole('menuitem',{name:'取消置顶',exact:true}).isDisabled(),true);
      assert.equal(await page.getByRole('menuitem',{name:'重命名',exact:true}).isDisabled(),true);
      if(capability==='restricted')assert.equal(await page.getByRole('menuitem',{name:'归档对话',exact:true}).isEnabled(),true);
      await page.screenshot({path:join(screenshots,'remote-capability-'+capability+'.png')});
      await page.keyboard.press('Escape');
    }
    capabilityMode='data';await refresh();
    await remoteRow('项目对话 2').getByRole('button',{name:'取消置顶',exact:true}).waitFor({state:'visible'});
    assert.equal(sessionActions.length,7,'unavailable controls never send management requests');
    mutations.set('remote\0session-4',{native:true,resourceId:'native:session-4'});await refresh();
    await remoteRow('项目对话 4').getByRole('button',{name:'对话操作：项目对话 4',exact:true}).click();
    assert.equal(await page.getByRole('menuitem',{name:'重命名',exact:true}).count(),0,'native sessions retain the local menu semantics');
    assert.equal(await remoteRow('项目对话 4').getByRole('button',{name:'置顶会话',exact:true}).isDisabled(),true);
    assert.equal(await page.getByRole('menuitem',{name:'归档对话',exact:true}).isEnabled(),true,'native capability is independent of official session management');
    await page.keyboard.press('Escape');mutations.clear();await refresh();
    await page.keyboard.press('Escape');
    projectMode='error';await folder.click();await folder.click();
    await remoteProject.getByRole('button',{name:'开发设备 · 正在自动连接',exact:true}).waitFor();
    assert.equal(await remoteProject.locator('.cmd-session').count(),35,'session failures keep the loaded summaries');
    await projectScreenshots('error');projectMode='data';
    await page.clock.runFor(1001);await remoteProject.locator('.cmd-resource-connection').waitFor({state:'detached'});
    projectMode='empty';await folder.click();await folder.click();
    await remoteProject.getByText('还没有对话',{exact:true}).waitFor();
    assert.equal(await remoteProject.locator('.cmd-session').count(),0,'successful empty refresh removes stale summaries');
    assert.equal(await remoteProject.getByRole('button',{name:'在 开发设备 的 远端项目 新聊天',exact:true}).isVisible(),true);
    await projectScreenshots('empty');projectMode='data';
    assert.equal(selectCalls,selectedBefore,'all session states stay inside the sidebar');
    assert.deepEqual(await page.evaluate(()=>window.navigationCalls),[]);
    await folder.click();
    projectCount=1;
    holdProject='late';{const read=page.waitForRequest(request=>new URL(request.url()).pathname==='/api/commander-devices'&&request.postDataJSON().kind==='sessions');await folder.click();await read;await remoteProject.locator('.cmd-project-children').waitFor();}
    await page.getByRole('button',{name:'显示范围',exact:true}).click();await page.getByRole('menuitem',{name:'当前设备（工作台主机）',exact:true}).click();holdProject=false;releaseProject();
    await page.getByRole('button',{name:'显示范围',exact:true}).click();await page.getByRole('menuitem',{name:'所有已连接设备',exact:true}).click();await page.getByText('远端项目',{exact:true}).waitFor();await folder.click();await remoteProject.locator('.cmd-project-children').getByText('项目对话',{exact:true}).waitFor();assert.equal(await page.getByText('迟到对话',{exact:true}).count(),0);

    await page.getByLabel('本机草稿',{exact:true}).fill('未发送的本机草稿');
    const openRemote=async()=>{await page.locator('#cmd-recent-section').getByText('远端最近',{exact:true}).click();await page.locator('.cmd-resource-stage iframe').waitFor();await page.waitForFunction(()=>document.querySelector('.cmd-resource-stage-status')?.hidden);};
    const assertLocalRestored=async()=>{await page.locator('.cmd-resource-stage').waitFor({state:'detached'});assert.equal(await page.getByLabel('本机草稿',{exact:true}).inputValue(),'未发送的本机草稿');assert.equal(await page.getByLabel('本机草稿',{exact:true}).isEditable(),true);};
    await openRemote();
    assert.equal(await page.frameLocator('.cmd-resource-stage iframe').locator('body').innerText(),'目标设备工作台');assert.deepEqual(await page.frameLocator('.cmd-resource-stage iframe').locator('body').evaluate(()=>window.calls),[{kind:'official',id:'session-0'}]);assert.equal(await page.locator('.cmd-sidebar-content').isVisible(),true);
    assert.equal(await page.locator('.cmd-resource-stage header').count(),0);
    await page.locator('#cmd-recent-section .cmd-session').filter({hasText:'测试对话 0'}).click();await assertLocalRestored();
    assert.deepEqual(await page.evaluate(()=>window.navigationCalls.at(-1)),{kind:'session',id:'session-0'});
    const captureRemote=async()=>{
      const element=await page.locator('.cmd-resource-stage iframe').elementHandle(),remote=await element.contentFrame(),selected=selectCalls;
      const operations=await remote.evaluate(()=>{
        const draft=document.createElement('textarea');draft.setAttribute('aria-label','远端草稿');draft.value='未发送的远端草稿';document.body.append(draft);
        const history=document.createElement('div');history.id='remote-history';history.style.cssText='height:80px;overflow:auto';
        const content=document.createElement('div');content.style.height='600px';content.textContent='远端历史消息';history.append(content);document.body.append(history);history.scrollTop=145;
        return window.calls.length;
      });
      return async reason=>{
        assert.equal(await element.evaluate(node=>node.isConnected&&node===document.querySelector('.cmd-resource-stage iframe')),true,reason+': same iframe remains mounted');
        assert.deepEqual(await remote.evaluate(()=>({draft:document.querySelector('[aria-label="远端草稿"]').value,scroll:document.getElementById('remote-history').scrollTop,operations:window.calls.length})),{draft:'未发送的远端草稿',scroll:145,operations},reason+': live document, draft, scroll and active resource survive');
        assert.equal(selectCalls,selected,reason+': no new entry ticket');
      };
    };
    const localProject=page.getByRole('button',{name:'本机项目',exact:true});
    await openRemote();
    await remoteProject.locator('.cmd-session').first().click();await page.waitForFunction(()=>document.querySelector('.cmd-resource-stage-status')?.hidden);
    let assertRemoteRetained=await captureRemote();
    // Disclosure and list visibility never navigate away from the open resource.
    for(const expanded of [true,false]){await localProject.click();assert.equal(await localProject.getAttribute('aria-expanded'),String(expanded));await assertRemoteRetained('local project disclosure');}
    for(const expanded of [false,true]){await folder.click();assert.equal(await folder.getAttribute('aria-expanded'),String(expanded));await assertRemoteRetained('active remote project disclosure');}
    const deviceGroup=page.locator('.cmd-resource-group-title').filter({hasText:'开发设备'});
    for(const expanded of [false,true]){await deviceGroup.click();assert.equal(await deviceGroup.getAttribute('aria-expanded'),String(expanded));await assertRemoteRetained('active device disclosure');}
    for(const id of ['cmd-project-section','cmd-recent-section'])for(let i=0;i<2;i++){await page.locator('[aria-controls="'+id+'"]').click();await assertRemoteRetained('sidebar section disclosure');}
    await page.getByRole('button',{name:'搜索对话',exact:true}).click();await page.getByRole('textbox',{name:'搜索对话内容',exact:true}).fill('没有匹配的会话');
    assert.equal(await page.locator('.cmd-session').count(),0);await assertRemoteRetained('search hides active row');
    await page.getByRole('button',{name:'关闭搜索',exact:true}).click();
    for(const name of ['当前设备（工作台主机）','所有已连接设备']){await page.getByRole('button',{name:'显示范围',exact:true}).click();await page.getByRole('menuitem',{name,exact:true}).click();await assertRemoteRetained('resource scope hides active device');}
    await page.getByText('远端项目',{exact:true}).waitFor();
    await openRemote();await page.getByRole('button',{name:'在 本机项目 新聊天',exact:true}).click();await assertLocalRestored();
    assert.deepEqual(await page.evaluate(()=>window.navigationCalls.at(-1)),{kind:'new',id:'local-project'});
    await openRemote();await page.getByRole('button',{name:'工具',exact:true}).click();await assertLocalRestored();
    for(const name of ['最近新聊天','创建新聊天']){
      await openRemote();await page.getByRole('button',{name,exact:true}).click();
      await assertLocalRestored();
      assert.equal(await page.getByRole('dialog',{name:'新会话',exact:true}).count(),0);
      assert.equal(await page.evaluate(()=>window.navigationCalls.at(-1).kind),'new');
      assert.equal(await page.evaluate(()=>window.navigationCalls.at(-1).id),undefined);
    }
    const openDevicePicker= async surface => surface.getByRole('button',{name:'选择设备',exact:true}).click();
    const localPicker=page.getByRole('button',{name:'选择设备',exact:true});
    await localPicker.waitFor();
    assert.equal(await localPicker.evaluate(button=>button.closest('[class*="heroWorkspaceRow"]').firstElementChild.contains(button)),true);
    await page.screenshot({path:join(screenshots,'new-session-desktop.png')});
    const narrowComposer=await page.addStyleTag({content:'@media(max-width:600px){#root>.cmd-shell-sidebar{display:none!important}#root>main{padding:16px}}'});
    await page.setViewportSize({width:390,height:760});
    await page.evaluate(()=>document.body.setAttribute('data-ds-dark-theme',''));
    const deviceBox=await localPicker.boundingBox(), workspaceBox=await page.getByRole('button',{name:'工作区',exact:true}).boundingBox();
    assert(deviceBox.x+deviceBox.width<=workspaceBox.x && Math.abs(deviceBox.y+deviceBox.height/2-workspaceBox.y-workspaceBox.height/2)<2);
    const deviceList=page.getByRole('listbox',{name:'选择设备'});
    await localPicker.focus();await page.keyboard.press('ArrowDown');await deviceList.waitFor();
    assert.equal(await deviceList.getByRole('option',{name:new RegExp('^'+longDeviceName)}).count(),1);
    const options=await deviceList.getByRole('option').evaluateAll(rows=>rows.map(row=>{
      const name=row.querySelector('.cmd-session-device-name'), status=row.querySelector('.cmd-creation-device-status');
      return {height:row.offsetHeight, nameClipped:name.scrollWidth>name.clientWidth, ellipsis:getComputedStyle(name).textOverflow, statusClipped:status.scrollWidth>status.clientWidth};
    }));
    assert(options.every(option=>option.height===options[0].height && !option.statusClipped),JSON.stringify(options));
    assert(options[2].nameClipped && options[2].ellipsis==='ellipsis',JSON.stringify(options[2]));
    await page.screenshot({path:join(screenshots,'new-session-narrow-dark.png')});
    await page.keyboard.press('Escape');
    await narrowComposer.evaluate(node=>node.remove());
    await page.evaluate(()=>document.body.removeAttribute('data-ds-dark-theme'));
    await page.setViewportSize({width:1200,height:850});
    holdSelection=true;failSelection=true;
    await page.evaluate(()=>document.body.setAttribute('data-ds-dark-theme',''));
    await openDevicePicker(page);await page.getByRole('option',{name:/^开发设备/}).click();
    const loading=page.getByRole('status',{name:'正在打开远端资源…'});
    const returnToLocal=page.getByRole('button',{name:'返回本机',exact:true});
    await loading.waitFor();
    const loadingText=await loading.locator('.bg-loading-text').boundingBox(), returnBox=await returnToLocal.boundingBox();
    assert(returnBox.y>loadingText.y+loadingText.height && returnBox.y-loadingText.y-loadingText.height<28, 'return sits directly below the loading text');
    assert(Math.abs(returnBox.x+returnBox.width/2-loadingText.x-loadingText.width/2)<2, 'return is centered under the loading text');
    await page.screenshot({path:join(screenshots,'new-session-connecting.png')});
    holdSelection=false;releaseSelection();
    await page.getByRole('alert').filter({hasText:'设备连接暂不可用'}).waitFor();
    const retryBox=await page.locator('.cmd-resource-stage-actions').getByRole('button',{name:'重试',exact:true}).boundingBox();
    const errorReturnBox=await returnToLocal.boundingBox();
    assert(Math.abs(retryBox.y-errorReturnBox.y)<1 && retryBox.x+retryBox.width<=errorReturnBox.x, 'retry and return share one row');
    await page.screenshot({path:join(screenshots,'new-session-error.png')});
    await returnToLocal.click();await assertLocalRestored();
    await page.evaluate(()=>document.body.removeAttribute('data-ds-dark-theme'));
    failSelection=false;
    await openDevicePicker(page);
    await page.getByRole('option',{name:/^开发设备/}).click();
    const remoteComposer=page.frameLocator('.cmd-resource-stage iframe');
    await remoteComposer.getByRole('button',{name:'选择设备',exact:true}).waitFor();
    assert.match(await remoteComposer.getByRole('button',{name:'选择设备',exact:true}).innerText(),/开发设备/);
    await openDevicePicker(remoteComposer);
    await remoteComposer.getByRole('option',{name:/^当前主机/}).click();
    await assertLocalRestored();
    await openDevicePicker(page);
    await page.getByRole('option',{name:/^第二设备/}).click();
    await remoteComposer.getByRole('button',{name:'选择设备',exact:true}).waitFor();
    await remoteComposer.getByRole('textbox',{name:'目标设备草稿'}).fill('首条消息');
    await remoteComposer.getByRole('button',{name:'发送',exact:true}).click();
    await remoteComposer.getByRole('button',{name:'选择设备',exact:true}).waitFor({state:'detached'});
    const targetFrame=page.frames().find(frame=>new URL(frame.url()).searchParams.get('device')==='second');
    assert.deepEqual(await targetFrame.evaluate(()=>window.calls),[{kind:'new',id:undefined},{kind:'send',text:'首条消息'}]);
    await page.getByRole('button',{name:'创建新聊天',exact:true}).click();await assertLocalRestored();
    // Idle/background navigation reads must not own the live remote document.
    await openRemote();assertRemoteRetained=await captureRemote();
    // The next scheduled refresh keeps the sidebar stable while requests are in flight.
    holdResources=true;
    const pendingResource=page.waitForRequest(request=>new URL(request.url()).pathname==='/api/commander-devices'&&request.postDataJSON().action==='resources');
    await page.clock.runFor(30_001);await pendingResource;await waitForHeldBatch(1);
    const activeQueries=queries;
    assert(resourceGates.size>0&&resourceGates.size<=4,'one bounded refresh queries only lists whose refresh is due');
    assert.equal(await page.getByText('正在读取 开发设备…',{exact:true}).count(),0,'cached navigation refreshes silently');
    assert.equal(await page.getByText('远端项目',{exact:true}).count(),1);
    await page.screenshot({path:join(screenshots,'light-background-refresh.png')});
    await assertRemoteRetained('idle refresh is pending');
    await page.evaluate(()=>{document.dispatchEvent(new Event('visibilitychange'));document.dispatchEvent(new Event('visibilitychange'));});
    await page.clock.runFor(10_001);
    assert.equal(queries,activeQueries,'visibility and elapsed periods never overlap an active refresh');
    // Finish both the active batch and its coalesced visibility invalidation
    // before holding the next independent hidden-page scenario.
    const completedRefresh=deviceSnapshot(2);releaseResources();await completedRefresh;

    // Hidden pages cancel the active read and do not start work until visible again.
    mode='error';holdResources=true;
    const beforeHide=page.waitForRequest(request=>new URL(request.url()).pathname==='/api/commander-devices'&&request.postDataJSON().action==='resources');
    await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await beforeHide;await waitForHeldBatch();
    await page.evaluate(()=>{window.sidebarHidden=true;Object.defineProperty(document,'hidden',{configurable:true,get:()=>window.sidebarHidden});document.dispatchEvent(new Event('visibilitychange'));});
    const hiddenQueries=queries;
    await page.clock.runFor(60_001);
    assert.equal(queries,hiddenQueries,'hidden sidebar starts no polling requests');
    await assertRemoteRetained('one minute in the background');
    mode='data';holdResources=false;
    await page.evaluate(()=>{window.sidebarHidden=false;});await refresh();
    releaseResources();await page.evaluate(()=>Promise.resolve());
    await page.locator('#cmd-recent-section').getByText('远端最近',{exact:true}).waitFor();
    assert.equal(await page.locator('.cmd-resource-connection').count(),0,'cancelled late errors cannot replace the successful visible refresh');
    await assertRemoteRetained('returning from background');

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

    // A failed archive query must never reuse normal-view offsets or cache.
    recentCount=60;await refresh();await recent.getByText('远端最近 29',{exact:true}).waitFor();
    assert.equal(await recent.getByRole('button',{name:'加载更多 · 开发设备',exact:true}).isVisible(),true);
    mode='error';await page.evaluate(()=>document.dispatchEvent(new Event('commander:toggle-archive')));
    await recent.locator('.cmd-resource-connection[data-resource-state=connecting]').first().waitFor();
    assert.equal(await recent.locator('.cmd-session').count(),0);
    assert.equal(await recent.getByRole('button',{name:'加载更多 · 开发设备',exact:true}).count(),0,'archive errors cannot expose normal pagination');
    mode='data';const archiveQueryStart=resourceQueries.length;await refresh();
    await recent.getByText('远端最近 29',{exact:true}).waitFor();
    assert.deepEqual(resourceQueries.slice(archiveQueryStart).filter(row=>row.deviceId==='remote'&&row.kind==='recent').map(({offset,archived})=>[offset,archived]),[[0,true]]);
    recentCount=1;await page.evaluate(()=>document.dispatchEvent(new Event('commander:toggle-archive')));
    await recent.getByText('远端最近',{exact:true}).waitFor();
    await page.locator('.cmd-resource-connection').first().waitFor({state:'detached'});

    for(const state of ['empty','error','offline','data']) {
      mode=state;
      await page.evaluate(state=>window.scenario(state==='empty'?'empty':'data'),state);
      await refresh();
      if(state==='empty')await page.getByText('暂无最近对话',{exact:true}).waitFor();
      else if(state==='error'||state==='offline')await page.locator('.cmd-resource-connection[data-resource-state=connecting]').first().waitFor();
      else await page.locator('#cmd-recent-section').getByText('远端最近',{exact:true}).waitFor();
      await assertRemoteRetained('resource list '+state);
      for(const theme of ['light','dark']){
        await page.evaluate(dark=>document.body.toggleAttribute('data-ds-dark-theme',dark),theme==='dark');
        await page.setViewportSize(theme==='dark'?{width:500,height:700}:{width:1200,height:850});
        await page.screenshot({path:join(screenshots,theme+'-'+state+'.png')});
      }
    }
    // Stable authorization failures clear their own cache and never spin in the short retry loop.
    mode='revoked';await refresh();
    await assertLocalRestored();
    await page.getByRole('button',{name:'开发设备 · 授权失效，请在设备中心重新核验',exact:true}).first().waitFor();
    assert.equal(await page.locator('#cmd-recent-section').getByText('远端最近',{exact:true}).count(),0);
    assert.equal(await page.getByText('远端项目',{exact:true}).count(),0);
    assert.equal(await page.getByText('第二设备项目',{exact:true}).isVisible(),true);
    const rejectedQueries=resourceQueries.length;await page.clock.runFor(5001);
    assert.equal(resourceQueries.length,rejectedQueries,'stable permission rejections do not reconnect automatically');
    await page.screenshot({path:join(screenshots,'remote-authorization-state.png')});
    mode='data';devices.find(device=>device.id==='remote').authorizationId='renewed-pair';
    await page.evaluate(()=>document.dispatchEvent(new Event('benchgo:devices-changed')));
    await page.getByText('远端项目',{exact:true}).waitFor();
    await page.locator('#cmd-recent-section').getByText('远端最近',{exact:true}).waitFor();

    // The existing local confirmation now controls a target-bound project removal.
    const deleteRemote=page.getByRole('button',{name:'删除 开发设备 的项目 远端项目',exact:true});
    const projectConfirmation=page.getByRole('dialog',{name:'删除这个项目？',exact:true});
    assert.equal(await page.getByRole('button',{name:/删除.*default-workspace/}).count(),0,'default workspaces have no project deletion entry');
    deleteMode='legacy';await deleteRemote.click();
    await projectConfirmation.getByText(/目标设备尚不支持删除项目/).waitFor();
    assert.equal(await projectConfirmation.getByRole('button',{name:'删除项目',exact:true}).isDisabled(),true);
    await projectConfirmation.getByRole('button',{name:'取消',exact:true}).click();assert.equal(projectDeletes.length,0);
    changedSelection=true;await deleteRemote.click();
    await projectConfirmation.getByText(/目标设备身份或授权已变化/).waitFor();
    assert.equal(await projectConfirmation.getByRole('button',{name:'删除项目',exact:true}).isDisabled(),true);
    await projectConfirmation.getByRole('button',{name:'取消',exact:true}).click();changedSelection=false;assert.equal(projectDeletes.length,0);
    deleteMode='data';await deleteRemote.click();
    await page.waitForFunction(()=>[...document.querySelectorAll('[role="dialog"] button')].find(button=>button.textContent==='删除项目')?.disabled===false);
    await projectConfirmation.getByRole('button',{name:'取消',exact:true}).click();assert.equal(projectDeletes.length,0,'cancelled confirmation never removes a target project');
    deleteMode='error';await deleteRemote.click();
    await page.waitForFunction(()=>[...document.querySelectorAll('[role="dialog"] button')].find(button=>button.textContent==='删除项目')?.disabled===false);
    await projectConfirmation.getByRole('button',{name:'删除项目',exact:true}).click();
    await projectConfirmation.getByText('目标项目移除失败，请重试',{exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'远端项目',exact:true}).isVisible(),true);
    assert.equal(await page.getByRole('button',{name:'本机项目',exact:true}).isVisible(),true);
    assert.equal(await page.getByRole('button',{name:'第二设备项目',exact:true}).isVisible(),true);
    await page.screenshot({path:join(screenshots,'remote-project-delete-failed.png')});
    await projectConfirmation.getByRole('button',{name:'取消',exact:true}).click();
    deleteMode='data';if(await folder.getAttribute('aria-expanded')!=='true')await folder.click();
    await remoteProject.locator('.cmd-session').first().click();
    await page.waitForFunction(()=>document.querySelector('.cmd-resource-stage-status')?.hidden);
    holdDefault=true;await deleteRemote.click();
    await page.waitForFunction(()=>[...document.querySelectorAll('[role="dialog"] button')].find(button=>button.textContent==='删除项目')?.disabled===false);
    await projectConfirmation.getByRole('button',{name:'删除项目',exact:true}).click();
    const projectConnection=await page.locator('iframe[hidden]').elementHandle();
    const coldReceiver=await projectConnection.contentFrame();
    await coldReceiver.waitForFunction(()=>typeof window.releaseDefault==='function');
    assert.equal(projectDeletes.length,1,'cold target waits for its existing default initialization before its first removal');
    assert.equal(await projectConfirmation.getByRole('alert').count(),0,'cold initialization is not reported as a default-project deletion error');
    await page.screenshot({path:join(screenshots,'remote-project-default-initializing.png')});
    await coldReceiver.evaluate(()=>window.releaseDefault());holdDefault=false;
    await projectConfirmation.waitFor({state:'detached'});await page.getByRole('button',{name:'远端项目',exact:true}).waitFor({state:'detached'});
    await page.locator('.cmd-resource-stage').waitFor({state:'detached'});
    assert.deepEqual(projectDeletes,[{deviceId:'remote',id:'same-id'},{deviceId:'remote',id:'same-id'}]);
    assert.equal(await page.getByRole('button',{name:'本机项目',exact:true}).isVisible(),true);
    assert.equal(await page.getByRole('button',{name:'第二设备项目',exact:true}).isVisible(),true,'matching project IDs on another device remain untouched');
    assert.deepEqual(await page.evaluate(()=>window.localMutationCalls),[]);
    assert.equal(await page.getByLabel('本机草稿',{exact:true}).inputValue(),'未发送的本机草稿');
    await page.screenshot({path:join(screenshots,'remote-project-deleted.png')});
    await page.evaluate(()=>document.body.setAttribute('data-ds-dark-theme',''));await page.setViewportSize({width:500,height:700});await page.screenshot({path:join(screenshots,'dark-narrow.png')});
    await page.getByRole('button',{name:'显示范围',exact:true}).click();await page.getByRole('menuitem',{name:'指定设备',exact:true}).click();await page.getByLabel('开发设备',{exact:false}).check();await page.keyboard.press('Escape');assert.deepEqual(scope.deviceIds,['remote']);
    await page.reload();await page.addScriptTag({content:bundle.outputFiles.find(f=>f.path.endsWith('.js')).text});await page.locator('#cmd-recent-section').getByText('远端最近',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'对话操作：测试对话 0',exact:true}).count(),0,'selected scope restores without showing local resources');
    failSave=true;await page.getByRole('button',{name:'显示范围',exact:true}).click();await page.getByRole('menuitem',{name:'当前设备（工作台主机）',exact:true}).click();await page.locator('.cmd-resource-save-error').waitFor();assert.equal(scope.mode,'selected');failSave=false;await page.getByRole('button',{name:'重试保存',exact:true}).click();await page.locator('.cmd-resource-save-error').waitFor({state:'detached'});assert.equal(scope.mode,'current');
    // A sidebar first mounted in a hidden tab still discovers and reconnects when shown.
    scope={mode:'all',deviceIds:[]};await page.reload();deviceApiCalls=0;
    await page.evaluate(()=>{window.sidebarHidden=true;Object.defineProperty(document,'hidden',{configurable:true,get:()=>window.sidebarHidden});});
    await page.addScriptTag({content:bundle.outputFiles.find(f=>f.path.endsWith('.js')).text});
    await page.getByRole('button',{name:'显示范围',exact:true}).waitFor();assert.equal(deviceApiCalls,0);
    await page.evaluate(()=>{window.sidebarHidden=false;document.dispatchEvent(new Event('visibilitychange'));});
    await page.locator('#cmd-recent-section').getByText('远端最近',{exact:true}).waitFor();
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
