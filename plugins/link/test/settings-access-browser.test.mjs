import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { officialUiEntries, officialUiLoaders } from '../scripts/official-ui.mjs';
import { sharedUiStyles } from '../../benchgo/scripts/shared-ui.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(new URL('../package.json', import.meta.url));
const { build } = require('esbuild');
const { chromium } = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url))('playwright');
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || [chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const options = async () => ({ bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', target: 'es2022', minify: true,
  nodePaths: [join(root, 'plugins/link/node_modules'), join(root, 'plugins/benchgo/node_modules')],
  alias: { react: fileURLToPath(new URL('../node_modules/react', import.meta.url)), 'react-dom': fileURLToPath(new URL('../node_modules/react-dom', import.meta.url)), ...await officialUiEntries() },
  plugins: [sharedUiStyles()], loader: { '.css': 'text', '.svg': 'text', '.json': 'json', ...officialUiLoaders },
  logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"' } });

test('device-center grants and relay approvals render real controls across states, themes and narrow screens',{skip:!executablePath,timeout:60000},async()=>{
 const result=await build({...await options(),outfile:join(root,'artifacts/link-access/app.js'),stdin:{resolveDir:root,loader:'jsx',contents:`
 import React from 'react';import {createRoot} from 'react-dom/client';import {DeviceCenter} from './plugins/link/client/device-center.jsx';
 import {connectDeviceTheme} from './plugins/link/client/device-theme.mjs';connectDeviceTheme();
 import tokens from './deepseek-harness/packages/client/ui-theme/src/styles/design-platform.css';import base from './deepseek-harness/packages/client/ui-theme/src/styles/base.css';
 const root=createRoot(document.getElementById('root'));let serial=0;window.calls=[];window.operationState='applied';window.failGrant=false;
 window.renderScenario=mode=>{let status={enabled:true,hostName:'主机工作台',host:'0.0.0.0',port:48721,addresses:['https://192.168.1.4:48721'],pending:[],devices:mode==='empty'?[]:[{id:'legacy',name:'旧设备',capabilities:['management']}],relay:{nodes:[{id:'relay',url:'https://relay.example.com',priority:1,enabled:true}]},pendingManagement:mode==='data'?[{id:'operation',deviceName:'开发设备',ops:[{path:['nodes',0,'priority'],value:7},{path:['nodes',0,'enabled'],value:false}]}]:[]};
 const runtime={bootstrap:()=>null,isNative:()=>false,clientName:()=> '本机',call:async action=>({devices:[],capabilities:{hostAdmin:true,ssh:false}}),hostCall:async(action,input)=>{window.calls.push({action,input});if(action==='status'){if(mode==='loading')return new Promise(()=>{});if(mode==='error')throw Error('连接状态读取失败');return {...status};}if(action==='pairing')return {mode:input.mode,code:'CODE',uri:'benchgo://pair?code=CODE'};if(action==='grant-device'){if(window.failGrant)throw Error('授权保存失败');status.devices[0].capabilities=['management','collaboration'];return {...status};}if(action==='management-decide'){status.pendingManagement=[];return {id:input.operationId,state:window.operationState,error:{message:'中继不可用'}};}throw Error('Unexpected action '+action);}};
 root.render(<><style>{tokens}{base}</style><DeviceCenter key={++serial} runtime={runtime}/></>);};
 `}});
 const script=result.outputFiles.find(f=>f.path.endsWith('.js')).text,css=result.outputFiles.filter(f=>f.path.endsWith('.css')).map(f=>f.text).join('\n');
 const screenshots=join(root,'artifacts/link-access');await mkdir(screenshots,{recursive:true});const browser=await chromium.launch({headless:true,executablePath});
 try{const page=await browser.newPage();page.setDefaultTimeout(5000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+css+'body{margin:0;font-family:Arial;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}</style></head><body><div id="root"></div></body></html>'}));await page.goto('http://localhost/');await page.addScriptTag({content:script});
 for(const width of [1280,390])for(const theme of ['light','dark']){await page.setViewportSize({width,height:850});await page.emulateMedia({colorScheme:theme});await page.waitForFunction(theme=>document.documentElement.getAttribute('data-dsh-device-theme')===theme,theme);
  for(const mode of ['loading','empty','error','data']){await page.evaluate(mode=>window.renderScenario(mode),mode);
   if(mode==='loading')await page.getByRole('status',{name:'正在读取连接状态…'}).waitFor();else if(mode==='empty')await page.getByText('还没有配对设备',{exact:true}).waitFor();else if(mode==='error')await page.getByText('连接状态读取失败',{exact:true}).waitFor();else {await page.getByText('https://relay.example.com：优先级改为 7',{exact:true}).waitFor();await page.getByLabel('旧设备：任务协作',{exact:true}).waitFor();}
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),mode+'/'+width+'/'+theme+' overflow');await page.screenshot({path:join(screenshots,mode+'-'+width+'-'+theme+'.png'),fullPage:true});
  }
 }
 await page.getByRole('button',{name:'生成连接信息',exact:true}).click();await page.getByRole('dialog').waitFor();assert.deepEqual(await page.evaluate(()=>window.calls.findLast(c=>c.action==='pairing').input),{mode:'lan'});await page.getByRole('button',{name:'关闭配对窗口',exact:true}).click();
 await page.getByRole('button',{name:'协作权限',exact:true}).click();await page.getByLabel('允许委派和跟进本机任务',{exact:true}).check();await page.getByLabel('允许查询连接及申请修改中继',{exact:true}).check();await page.getByRole('button',{name:'生成连接信息',exact:true}).click();await page.getByRole('dialog').waitFor();assert.deepEqual(await page.evaluate(()=>window.calls.findLast(c=>c.action==='pairing').input),{mode:'lan',collaboration:true,management:true});await page.getByRole('button',{name:'关闭配对窗口',exact:true}).click();
 await page.getByRole('button',{name:'应用这次修改',exact:true}).click();await page.getByText('修改已保存并应用；远端连通性以连接状态为准。',{exact:true}).waitFor();await page.getByText('旧设备',{exact:true}).waitFor();assert.deepEqual(await page.evaluate(()=>window.calls.slice(-2).map(c=>c.action)),['management-decide','status']);
 await page.evaluate(()=>window.failGrant=true);await page.getByLabel('旧设备：任务协作',{exact:true}).click();await page.getByRole('alert').getByText('授权保存失败',{exact:true}).waitFor();assert.equal(await page.getByLabel('旧设备：任务协作',{exact:true}).isChecked(),false);assert.equal(await page.getByLabel('旧设备：连接与中继管理',{exact:true}).isChecked(),true);
 for(const state of ['failed','expired']){await page.evaluate(state=>{window.operationState=state;window.renderScenario('data');},state);await page.getByRole('button',{name:'应用这次修改',exact:true}).click();await page.getByRole('status').filter({hasText:state==='failed'?'修改未完成：中继不可用':'请求已过期'}).waitFor();await page.getByText('旧设备',{exact:true}).waitFor();await page.screenshot({path:join(screenshots,state+'-390-dark.png'),fullPage:true});}
 assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
