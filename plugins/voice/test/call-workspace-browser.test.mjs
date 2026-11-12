import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url));
const { chromium } = require('playwright');
const { build } = createRequire(new URL('../../benchgo/package.json', import.meta.url))('esbuild');
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || [chromium.executablePath(), 'C:/Users/DraftGo/AppData/Local/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-win64/chrome-headless-shell.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);

test('minimized enhanced call leaves work records visible and pending confirmation remains independent', { skip: !executablePath && 'Chromium/Edge required' }, async () => {
  const result=await build({stdin:{resolveDir:root,loader:'jsx',contents:`
    import React,{useSyncExternalStore} from 'react';import{createRoot}from'react-dom/client';
    import{VoiceActivity}from'./plugins/voice/client/index.jsx';
    import{VoiceCallHost}from'./plugins/voice/client/call-host.jsx';import{createCallPresentation}from'./plugins/voice/client/call-presentation.mjs';
    const listeners=new Set(),statusListeners=new Set();
    let state={config:{dictation:true,readAloud:true,call:true,asr:{configured:true,model:'asr'},tts:{configured:true,model:'tts',stream:true}},sessionId:'s',mode:'call',phase:'speaking',conversationMode:'enhanced',conversationMessages:[]},statuses=new Map();
    const sessionStatus={subscribe:fn=>{statusListeners.add(fn);return()=>statusListeners.delete(fn)},getSnapshot:()=>statuses};
    window.approved=0;window.ended=0;window.pending=()=>{statuses=new Map([['s',{pendingInteraction:{kind:'approval'}}]]);statusListeners.forEach(fn=>fn());};
    const resolve=()=>{window.approved++;statuses=new Map();statusListeners.forEach(fn=>fn());};
    const controller={state:{subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},getSnapshot:()=>state},selectSession(){},releaseSessionView(){},readConversationHistory:async()=>({items:[]}),setMuted:async()=>{},toggleMute(){},hangup:async()=>{window.ended++;state={...state,mode:'idle',phase:'idle',conversationMode:'direct'};listeners.forEach(fn=>fn());}};
    const callView=createCallPresentation(controller,{title:()=> '原会话',openSession:async()=>{}});callView.expand();
    function App(){const pending=useSyncExternalStore(sessionStatus.subscribe,()=>!!statuses.get('s')?.pendingInteraction);return <><div data-conversation-session="s" className="owner"><div data-conversation-scroll="" className="resident"><p>原执行消息流</p>{pending&&<section aria-label="原审批"><p>是否允许本次操作？</p><button onClick={resolve}>确认本次</button></section>}<div data-composer-card=""><textarea aria-label="原输入"/><VoiceActivity controller={controller} callView={callView} sessionStatus={sessionStatus} sessionId="s" inputActions={{}}/></div></div></div><VoiceCallHost controller={controller} callView={callView} sessionStatus={sessionStatus}/></>};createRoot(document.getElementById('root')).render(<App/>);
  `},bundle:true,write:false,outdir:join(root,'artifacts/unused-call-approval'),format:'iife',jsx:'automatic',nodePaths:[join(root,'plugins/benchgo/node_modules'),join(root,'deepseek-harness/apps/web/node_modules')],alias:{react:dirname(require.resolve('react/package.json')),'react-dom':dirname(require.resolve('react-dom/package.json')),'@deepseek-ai/dsh-client-ui-primitives':join(root,'deepseek-harness/packages/client/ui-primitives/src/index.ts')},plugins:[{name:'voice-fixture',setup(build){build.onLoad({filter:/voice[\\/]client[\\/]index\.jsx$/},async args=>({contents:await readFile(args.path,'utf8')+'\nexport {VoiceActivity};',loader:'jsx'}));}}],loader:{'.css':'text','.module.css':'local-css','.svg':'text'},define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
  const css=await readFile(new URL('../client/style.css',import.meta.url),'utf8'),script=result.outputFiles.find(file=>file.path.endsWith('.js')).text;
  const browser=await chromium.launch({executablePath,headless:true});
  try{
    const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(6000);
    await page.setContent('<html><head><style>html,body,#root{height:100%;margin:0}body{font:14px Arial}.owner,.resident{display:flex;flex:1;flex-direction:column;min-height:0}.owner{height:100%}[data-composer-card]{margin-top:auto}'+css+'</style></head><body><div id="root"></div></body></html>');await page.addScriptTag({content:script});
    await page.getByRole('button',{name:'收起通话',exact:true}).click();await page.getByRole('dialog',{name:'实时语音通话',exact:true}).waitFor({state:'hidden'});
    assert(await page.getByText('原执行消息流',{exact:true}).isVisible());
    assert.equal(await page.locator('.resident').evaluate(node=>node.inert),false);
    await page.evaluate(()=>window.pending());await page.getByRole('region',{name:'原审批',exact:true}).waitFor();
    assert.equal(await page.getByRole('dialog',{name:'实时语音通话',exact:true}).count(),0);
    assert.equal(await page.locator('.resident').evaluate(node=>node.inert),false);
    assert.equal(await page.getByRole('textbox',{name:'原输入',exact:true}).evaluate(node=>node.inert),false);
    await page.getByRole('button',{name:'返回语音通话',exact:true}).click();await page.getByRole('button',{name:'处理确认',exact:true}).click();
    await page.getByRole('button',{name:'确认本次',exact:true}).click();
    assert(await page.getByText('原执行消息流',{exact:true}).isVisible());
    assert.equal(await page.evaluate(()=>window.approved),1);
    await page.evaluate(()=>window.pending());await page.getByRole('button',{name:'结束语音通话',exact:true}).click();
    await page.getByRole('region',{name:'原审批',exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.approved),1);assert.equal(await page.evaluate(()=>window.ended),1);
    assert.equal(await page.locator('.resident').evaluate(node=>node.inert),false);assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
