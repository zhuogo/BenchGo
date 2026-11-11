import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, transformSync } from 'esbuild';

const root=fileURLToPath(new URL('../../../',import.meta.url));
const require=createRequire(new URL('../../../deepseek-harness/apps/web/package.json',import.meta.url));
const {chromium}=require('playwright');
const executablePath=process.env.CHROMIUM_EXECUTABLE_PATH||[chromium.executablePath(),'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const sidebar=transformSync(readFileSync(new URL('../client/index.jsx',import.meta.url),'utf8')+'\nexport {Projects};export function setFixture(snapshot){defaultWorkspaceId="recent";update(snapshot);}',{loader:'jsx',format:'cjs'}).code;
const helpers=transformSync(readFileSync(new URL('../client/sidebar-state.mjs',import.meta.url),'utf8'),{format:'cjs'}).code;

test('real sidebar buttons create fresh views, preserve voice history and recover from failures', {skip:!executablePath},async()=>{
 const bundle=await build({stdin:{resolveDir:root,loader:'jsx',contents:`
 import React from 'react';import {createRoot} from 'react-dom/client';
 import css from './plugins/benchgo/client/style.css';
 const helperModule={exports:{}};new Function('module','exports',${JSON.stringify(helpers)})(helperModule,helperModule.exports);
 const helpers=helperModule.exports,modules={base:true,harness:true,voice:true,superagent:false,link:false};
 const Empty=()=>null,Icon=()=> <span aria-hidden>◇</span>,Wrap=({children})=>children;
 const stub=new Proxy({},{get:()=>Empty});
 const mod={exports:{}};
 new Function('require','module','exports',${JSON.stringify(sidebar)})(id=>id==='react'?React:id.endsWith('sidebar-state.mjs')?helpers:id.endsWith('modules.mjs')?{moduleSource:{subscribe:()=>()=>{},getSnapshot:()=>modules}}:id==='@deepseek-ai/dsh-client-ui-primitives'?{Tooltip:Wrap,Menu:Empty,Modal:Empty,FishLogo:Icon,LinkIconMedium:Icon,IconPinFillRegular:Icon,IconPinOutlineRegular:Icon}:id.endsWith('iconsax.jsx')?{UIIcon:Icon}:stub,mod,mod.exports);
 const store=value=>{const listeners=new Set();return{getSnapshot:()=>value,subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener)},set:next=>{value=next;listeners.forEach(fn=>fn())}}};
 const old={id:'voice-old',title:'历史语音',blank:true,running:false,retainedBy:{mainView:1},updatedAt:20,projectionValues:{benchgoVoice:{used:true,startedAt:20,lastActivityAt:20}}};
 const projects=[{id:'recent',isDefault:true},{id:'project',title:'Project'}];
 const sessions=store({phase:'ready',ids:[old.id],byId:{[old.id]:old}}),workspaces=store({phase:'ready',items:[{workspaceId:'recent',sessionIds:[old.id]},{workspaceId:'project',title:'Project',sessionIds:[]}],archivedSessionIds:[]}),statuses=store(new Map());
 const requests=[],opened=[];let failure=false;
 const host={layout:{panelInfo:store({activePanelId:null})},uiSession:{sessionStatus:statuses},remoteAccess:{source:()=>store(true)},workspaces:{list:workspaces},sessions:{list:sessions,create:async request=>{requests.push(request);if(failure)throw Error('创建失败');return 'fresh-'+requests.length;}},uiWorkspace:{startSession:()=>{throw Error('blank reuse forbidden')},openSession:id=>{opened.push(id);document.querySelector('#conversation').textContent=id===old.id?'嘿你好':''}}};
 window.result=()=>({requests,opened,old});window.setFailure=value=>failure=value;
 const newSession=projectId=>helpers.startSidebarSession(host,projects,projectId,'recent',async()=>({workspaceId:'recent'})).then(()=>mod.exports.setFixture({error:''})).catch(error=>mod.exports.setFixture({error:error.message}));
 window.scenario=mode=>{const hasData=mode==='data';sessions.set({phase:mode==='loading'?'pending':'ready',ids:hasData?[old.id]:[],byId:hasData?{[old.id]:old}:{}});workspaces.set({phase:mode==='loading'?'pending':'ready',items:mode==='loading'?[]:[{workspaceId:'recent',sessionIds:hasData?[old.id]:[]},{workspaceId:'project',title:'Project',sessionIds:[]}],archivedSessionIds:[]});mod.exports.setFixture({projects:mode==='loading'?[]:projects,sessions:[],loaded:mode!=='loading',error:mode==='error'?'连接失败':''});};
 mod.exports.setFixture({projects,sessions:[],loaded:true,error:''});
 createRoot(document.getElementById('app')).render(<><style>{css}</style><aside style={{width:300,height:'100vh'}}><mod.exports.Projects host={host} open={()=>{}} newSession={newSession} renderSlot={()=>null}/></aside><main id='conversation'>嘿你好</main></>);
 `},bundle:true,write:false,format:'iife',jsx:'transform',alias:{react:dirname(require.resolve('react/package.json')),'react-dom':dirname(require.resolve('react-dom/package.json'))},loader:{'.css':'text'},define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
 const browser=await chromium.launch({headless:true,executablePath});
 try{
  const page=await browser.newPage(),errors=[];page.setDefaultTimeout(5000);page.on('pageerror',error=>errors.push(error.message));
  await page.setContent('<!doctype html><style>body{margin:0;display:flex;font-family:Arial}</style><div id="app"></div>');
  await page.addScriptTag({content:bundle.outputFiles[0].text});
  for(const width of [1440,390]){
   await page.setViewportSize({width,height:900});
   for(const state of ['loading','empty','error','data']){
    await page.evaluate(state=>window.scenario(state),state);
    await page.getByRole('button',{name:'创建新聊天',exact:true}).waitFor();
    await page.waitForFunction(state=>state==='data'?document.querySelectorAll('.cmd-session').length===1:document.querySelectorAll('.cmd-session').length===0,state);
    if(state==='data')await page.getByText('历史语音',{exact:true}).waitFor();
    assert(await page.getByRole('button',{name:'最近新聊天',exact:true}).isVisible());
   }
  }
  for(const name of ['最近新聊天','创建新聊天','在 Project 新聊天']){
   const before=(await page.evaluate(()=>window.result())).opened.length;
   await page.getByRole('button',{name,exact:true}).click();
   await page.waitForFunction(count=>window.result().opened.length===count+1,before);
   assert.equal(await page.locator('#conversation').innerText(),'');
   await page.getByText('历史语音',{exact:true}).waitFor();
  }
  await page.evaluate(()=>window.setFailure(true));
  await page.getByRole('button',{name:'最近新聊天',exact:true}).click();
  await page.getByText('创建失败',{exact:true}).waitFor();
  assert.equal((await page.evaluate(()=>window.result())).opened.length,3);
  await page.evaluate(()=>window.setFailure(false));
  await page.getByRole('button',{name:'最近新聊天',exact:true}).click();
  await page.waitForFunction(()=>window.result().opened.length===4);
  const result=await page.evaluate(()=>window.result());
  assert.deepEqual(result.requests.map(request=>request.workspaceId),['recent','recent','project','recent','recent']);
  assert(result.requests.every(request=>!Object.hasOwn(request,'sessionId')));
  assert.equal(result.old.projectionValues.benchgoVoice.used,true);assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
