import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { officialUiEntries, officialUiLoaders } from '../scripts/official-ui.mjs';
import { sharedUiStyles } from '../../base/scripts/shared-ui.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(new URL('../package.json', import.meta.url));
const { build } = require('esbuild');
const { chromium } = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url))('playwright');
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || [chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);

async function bundles() {
  const options = { bundle: true, write: false, outdir: join(root, 'artifacts/unused-resource-file'), format: 'iife', jsx: 'automatic', target: 'es2022',
    alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')), ...await officialUiEntries() },
    nodePaths: [join(root, 'plugins/link/node_modules'), join(root, 'plugins/base/node_modules')], plugins: [sharedUiStyles()],
    loader: { '.css': 'text', '.svg': 'text', ...officialUiLoaders }, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' };
  const scripts = [
    `import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{ResourceStage}from'./plugins/link/client/resource-navigation.jsx';
    function App(){const[target,setTarget]=useState(null);window.showFile=(requestId,resource,deviceId='remote')=>setTarget({device:{id:deviceId,name:'远端设备'},requestId,resource});window.closeStage=()=>setTarget(null);return<><main style={{position:'relative',height:600}}>本机主聊<textarea defaultValue='本机草稿'/></main><ResourceStage target={target} onClose={()=>setTarget(null)}/></>};createRoot(document.getElementById('root')).render(<App/>);`,
    `import{installResourceReceiver}from'./plugins/link/client/resource-navigation.jsx';import{parseFileAddress}from'@deepseek-ai/dsh-util-workspace-path';
    window.opens=[];window.navigations=[];window.messages=[];window.bindingReads=[];window.failOpen=false;window.failBinding=false;window.autoMount=false;window.currentDirectory='/srv/live';
    const listeners=new Set();let mounted='wrong-session';window.setMounted=id=>{mounted=id;for(const fn of listeners)fn()};window.listenerCount=()=>listeners.size;
    const blocks=new Map();window.readBlock=id=>blocks.get(id);
    const host={conversation:{blocks:{storeFor:id=>({getSnapshot:()=>blocks.get(id)}),set:(id,value)=>blocks.set(id,value)}},uiWorkspace:{openSession:async id=>{navigations.push(id);if(autoMount)setMounted(id)}},
      sessions:{list:{getSnapshot:()=>({phase:'ready',ids:['worker','next'],byId:{worker:{cwd:'/srv/original'},next:{cwd:'/srv/next'}}})},binding:id=>{bindingReads.push(id);return failBinding?null:{session:{projections:{faceOf:()=>({getSnapshot:()=>currentDirectory})}}}}},
      sidebarRight:{mounted:{getSnapshot:()=>mounted,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)}},openResource:(address,options)=>{if(failOpen)throw Error('远端文件暂不可用');opens.push({file:parseFileAddress(address),options,mounted});}}};
    window.stopReceiver=installResourceReceiver(host,{});addEventListener('message',event=>messages.push(event.data));`
  ];
  return Promise.all(scripts.map(async contents => (await build({ ...options, stdin: { resolveDir: root, loader: 'jsx', contents } })).outputFiles.find(file=>file.path.endsWith('.js')).text));
}

test('cross-device delivery opens files only after its exact remote Session workspace is mounted', { skip: !executablePath && 'Chromium/Edge required', timeout: 60000 }, async () => {
  const [ownerScript, receiverScript] = await bundles(), browser = await chromium.launch({ headless:true, executablePath });
  try {
    const page = await browser.newPage(); page.setDefaultTimeout(5000); const errors=[];
    page.on('pageerror', error=>errors.push(error.message));
    await page.route('**/*', async route=>{
      const url=new URL(route.request().url());
      if(url.pathname==='/api/commander-devices') return route.fulfill({json:{url:'http://127.0.0.1:17883/remote/',device:{id:route.request().postDataJSON().deviceId}}});
      if(url.pathname==='/remote/') return route.fulfill({contentType:'text/html; charset=utf-8',body:'<!doctype html><p>远端执行工作区</p><script>'+receiverScript.replaceAll('</script','<\\/script')+'</script>'});
      return route.fulfill({contentType:'text/html',body:'<!doctype html><div id="root"></div>'});
    });
    await page.goto('http://127.0.0.1:17880/');await page.addScriptTag({content:ownerScript});
    const resource={kind:'sessions',resourceId:'worker',ownerTask:{taskId:'task',ownerHostId:'owner',executionId:'execution'},file:{path:'report.md',line:12}};
    const show=async(id,value=resource)=>page.evaluate(({id,value})=>showFile(id,value),{id,value});
    await show('wait');await page.frameLocator('iframe').getByText('远端执行工作区').waitFor();
    const remote=page.frames().find(frame=>frame.url().includes('/remote/'));
    await remote.waitForFunction(()=>listenerCount()===1);
    assert.deepEqual(await remote.evaluate(()=>opens),[]);assert.deepEqual(await remote.evaluate(()=>bindingReads),[]);
    assert.match((await remote.evaluate(()=>readBlock('worker'))).reason,/原任务/);
    await remote.evaluate(()=>setMounted('another-session'));assert.deepEqual(await remote.evaluate(()=>opens),[]);
    await remote.evaluate(()=>setMounted('worker'));await page.locator('.cmd-resource-stage-status').waitFor({state:'hidden'});
    assert.deepEqual(await remote.evaluate(()=>opens),[{file:{scope:'session',sessionId:'worker',path:'/srv/live/report.md'},options:{params:{line:12}},mounted:'worker'}]);
    assert.equal(await remote.evaluate(()=>listenerCount()),0);
    // Absolute remote paths remain in this exact Session, never in the owner's host.
    await show('absolute',{...resource,file:{path:'/srv/elsewhere/shared.txt'}});await remote.waitForFunction(()=>opens.length===2);
    assert.deepEqual(await remote.evaluate(()=>opens[1]),{file:{scope:'session',sessionId:'worker',path:'/srv/elsewhere/shared.txt'},options:undefined,mounted:'worker'});
    // Duplicate resource notifications do not open another editor.
    await page.evaluate(resource=>document.querySelector('iframe').contentWindow.postMessage({type:'benchgo:resource:open',resource,requestId:'absolute'},'http://127.0.0.1:17883'),resource);
    await remote.waitForFunction(()=>messages.filter(row=>row.requestId==='absolute').length>=2);assert.equal(await remote.evaluate(()=>opens.length),2);
    for(const [id,value]of[['project',{...resource,kind:'projects'}],['native',{...resource,native:true}],['intent',{...resource,intent:'newSession'}],['empty',{...resource,file:{path:''}}],['control',{...resource,file:{path:'bad\nfile.md'}}],['line',{...resource,file:{path:'report.md',line:0}}],['large',{...resource,file:{path:'x'.repeat(32769)}}]]){
      const count=await remote.evaluate(()=>navigations.length);await show(id,value);await page.getByRole('alert').filter({hasText:'文件引用无效'}).waitFor();assert.equal(await remote.evaluate(()=>navigations.length),count);
    }
    await remote.evaluate(()=>{failOpen=true});await show('provider-error');await page.getByRole('alert').filter({hasText:'远端文件暂不可用'}).waitFor();await remote.evaluate(()=>{failOpen=false;failBinding=true});
    await show('binding-error');await page.getByRole('alert').filter({hasText:'目标会话尚未连接'}).waitFor();await remote.evaluate(()=>{failBinding=false;setMounted('wrong-session')});
    // A newer navigation cancels a pending file wait without opening the stale file.
    await show('superseded');await remote.waitForFunction(()=>listenerCount()===1);await show('next',{kind:'sessions',resourceId:'next'});
    await remote.waitForFunction(()=>navigations.at(-1)==='next');assert.equal(await remote.evaluate(()=>listenerCount()),0);assert.equal(await remote.evaluate(()=>opens.length),2);
    await remote.evaluate(()=>setMounted('worker'));assert.equal(await remote.evaluate(()=>opens.length),2);
    // Waiting is event-driven and bounded, with no leftover subscriptions.
    await remote.evaluate(()=>setMounted('wrong-session'));await page.clock.install();await show('timeout');await remote.waitForFunction(()=>listenerCount()===1);await page.clock.fastForward(10001);
    await page.getByRole('alert').filter({hasText:'目标会话文件工作区仍在加载'}).waitFor();assert.equal(await remote.evaluate(()=>listenerCount()),0);await page.clock.resume();
    await show('dispose');await remote.waitForFunction(()=>listenerCount()===1);await remote.evaluate(()=>stopReceiver());assert.equal(await remote.evaluate(()=>listenerCount()),0);assert.equal(await remote.evaluate(()=>opens.length),2);
    assert.equal(await page.locator('textarea').inputValue(),'本机草稿');assert.deepEqual(errors,[]);
    // An old receiver must not acknowledge only the Session and lose the file intent.
    await page.evaluate(()=>closeStage());await page.locator('iframe').waitFor({state:'detached'});
    await page.route('**/remote/',route=>route.fulfill({contentType:'text/html',body:`<script>parent.postMessage({type:'benchgo:resource:ready',executionReadOnly:true},'http://127.0.0.1:17880');addEventListener('message',e=>{if(e.data.type==='benchgo:resource:probe')parent.postMessage({type:'benchgo:resource:ready',executionReadOnly:true},'http://127.0.0.1:17880');window.received=e.data.type==='benchgo:resource:open'})</script>`}));
    await page.evaluate(resource=>showFile('old',resource,'old-device'),resource);await page.getByRole('alert').filter({hasText:'尚不支持交付文件工作区'}).waitFor();
    assert.notEqual(await page.frames().find(frame=>frame.url().includes('/remote/')).evaluate(()=>window.received),true);
  } finally { await browser.close(); }
});
