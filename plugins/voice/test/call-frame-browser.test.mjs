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

test('call frame keeps resident drafts mounted, isolates session seats and restores focus and scroll', { skip: !executablePath && 'Chromium/Edge required' }, async () => {
  const buildResult = await build({ stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React,{useState,useRef,useEffect} from 'react';import {createRoot} from 'react-dom/client';import {createPortal} from 'react-dom';
    import {CallFrame,createCallFrameRegistry,useCallFrame,useCallFrameActive} from './plugins/voice/client/call-frame.jsx';
    const registry=createCallFrameRegistry();window.mounts=0;window.unmounts=0;
    function Resident({sessionId}){const ref=useRef(),[active,setActive]=useState(false);const host=useCallFrame(registry,sessionId,ref);useCallFrameActive(host,active);useEffect(()=>{window.mounts++;return()=>window.unmounts++;},[]);return <div ref={ref}><textarea aria-label={'草稿'+sessionId} defaultValue={'保留草稿'+sessionId}/><button onClick={()=>setActive(true)}>收起到{sessionId}</button>{active&&host&&createPortal(<section role="region" aria-label={'通话'+sessionId}><p>交互记录{sessionId}</p><button onClick={()=>setActive(false)}>展开{sessionId}</button><button onClick={()=>setActive(false)}>挂断{sessionId}</button></section>,host.element)}</div>}
    function App(){const[show,setShow]=useState(true);window.hideFirst=()=>setShow(false);return <><div data-conversation-session="a" className="owner" hidden={!show}><CallFrame registry={registry}><div data-conversation-scroll=""><div className="long">原始执行记录a</div><Resident sessionId="a"/></div></CallFrame></div><div data-conversation-session="b" className="owner"><CallFrame registry={registry}><div data-conversation-scroll=""><div className="long">原始执行记录b</div><Resident sessionId="b"/></div></CallFrame></div></>};createRoot(document.getElementById('root')).render(<App/>);
  ` }, bundle: true, write: false, outdir: join(root, 'artifacts/unused-call-frame'), format: 'iife', jsx: 'automatic', nodePaths: [join(root, 'deepseek-harness/apps/web/node_modules')], alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')) }, loader: { '.css': 'text' }, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  const script = buildResult.outputFiles.find(file => file.path.endsWith('.js')).text;
  const browser = await chromium.launch({executablePath,headless:true});
  try {
    const page = await browser.newPage(); const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.setContent('<html><head><style>body{display:flex;font:14px Arial}#root{display:flex;width:100%;gap:20px}.owner{display:flex;flex-direction:column;width:48%;height:400px}.owner[hidden]{display:none}[data-conversation-scroll]{overflow:auto;flex:1;min-height:0}.long{height:800px}section{background:#fff;height:100%;width:100%}</style></head><body><div id="root"></div></body></html>');await page.addScriptTag({content:script});
    await page.getByRole('button',{name:'收起到a',exact:true}).click();
    await page.getByRole('region',{name:'通话a',exact:true}).waitFor();
    assert.equal(await page.locator('[data-conversation-session=a] .voice-call-frame-content').getAttribute('aria-hidden'),'true');
    assert.equal(await page.locator('[data-conversation-session=b] .voice-call-frame-content').getAttribute('aria-hidden'),null);
    assert(await page.locator('[data-conversation-session=a] .voice-call-frame-content').evaluate(node=>node.inert));
    assert.equal(await page.evaluate(()=>window.unmounts),0);
    await page.getByRole('button',{name:'展开a',exact:true}).click();
    assert.equal(await page.getByRole('textbox',{name:'草稿a',exact:true}).inputValue(),'保留草稿a');
    assert.equal(await page.locator('[data-conversation-session=a] .voice-call-frame-content').evaluate(node=>node.inert),false);
    const scroll=page.locator('[data-conversation-session=a] [data-conversation-scroll]');const previous=await scroll.evaluate(node=>node.scrollTop);
    await page.getByRole('button',{name:'收起到a',exact:true}).click();await page.getByRole('button',{name:'挂断a',exact:true}).click();
    assert.equal(await scroll.evaluate(node=>node.scrollTop),previous);
    assert.equal(await page.evaluate(()=>document.activeElement.textContent),'收起到a');
    await page.evaluate(()=>window.hideFirst());await page.getByRole('button',{name:'收起到b',exact:true}).click();
    await page.getByRole('region',{name:'通话b',exact:true}).waitFor();
    assert.equal(await page.getByRole('region',{name:'通话a',exact:true}).count(),0);
    assert.equal(await page.evaluate(()=>window.mounts),2);assert.equal(await page.evaluate(()=>window.unmounts),0);assert.deepEqual(errors,[]);
  } finally {await browser.close();}
});

test('enhanced pending confirmation reveals the original controls and hangup never approves', { skip: !executablePath && 'Chromium/Edge required' }, async () => {
  const result=await build({stdin:{resolveDir:root,loader:'jsx',contents:`
    import React,{useSyncExternalStore} from 'react';import{createRoot}from'react-dom/client';
    import{VoiceActivity}from'./plugins/voice/client/index.jsx';import{CallFrame,createCallFrameRegistry}from'./plugins/voice/client/call-frame.jsx';
    const registry=createCallFrameRegistry(),listeners=new Set(),statusListeners=new Set();
    let state={config:{dictation:true,readAloud:true,call:true,asr:{configured:true,model:'asr'},tts:{configured:true,model:'tts',stream:true}},sessionId:'s',mode:'call',phase:'speaking',conversationMode:'enhanced',conversationMessages:[]},statuses=new Map();
    const sessionStatus={subscribe:fn=>{statusListeners.add(fn);return()=>statusListeners.delete(fn)},getSnapshot:()=>statuses};
    window.approved=0;window.ended=0;window.pending=()=>{statuses=new Map([['s',{pendingInteraction:{kind:'approval'}}]]);statusListeners.forEach(fn=>fn());};
    const resolve=()=>{window.approved++;statuses=new Map();statusListeners.forEach(fn=>fn());};
    const controller={state:{subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},getSnapshot:()=>state},selectSession(){},readConversationHistory:async()=>({items:[]}),setMuted:async()=>{},hangup:async()=>{window.ended++;state={...state,mode:'idle',phase:'idle',conversationMode:'direct'};listeners.forEach(fn=>fn());}};
    function App(){const pending=useSyncExternalStore(sessionStatus.subscribe,()=>!!statuses.get('s')?.pendingInteraction);return <div data-conversation-session="s" className="owner"><CallFrame registry={registry}><div data-conversation-scroll="" className="resident"><p>原执行消息流</p>{pending&&<section aria-label="原审批"><p>是否允许本次操作？</p><button onClick={resolve}>确认本次</button></section>}<div data-composer-card=""><textarea aria-label="原输入"/><VoiceActivity controller={controller} callFrames={registry} sessionStatus={sessionStatus} sessionId="s" inputActions={{}}/></div></div></CallFrame></div>};createRoot(document.getElementById('root')).render(<App/>);
  `},bundle:true,write:false,outdir:join(root,'artifacts/unused-call-approval'),format:'iife',jsx:'automatic',nodePaths:[join(root,'plugins/benchgo/node_modules'),join(root,'deepseek-harness/apps/web/node_modules')],alias:{react:dirname(require.resolve('react/package.json')),'react-dom':dirname(require.resolve('react-dom/package.json')),'@deepseek-ai/dsh-client-ui-primitives':join(root,'deepseek-harness/packages/client/ui-primitives/src/index.ts')},plugins:[{name:'voice-fixture',setup(build){build.onLoad({filter:/voice[\\/]client[\\/]index\.jsx$/},async args=>({contents:await readFile(args.path,'utf8')+'\nexport {VoiceActivity};',loader:'jsx'}));}}],loader:{'.css':'text','.module.css':'local-css','.svg':'text'},define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
  const css=await readFile(new URL('../client/style.css',import.meta.url),'utf8'),script=result.outputFiles.find(file=>file.path.endsWith('.js')).text;
  const browser=await chromium.launch({executablePath,headless:true});
  try{
    const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(6000);
    await page.setContent('<html><head><style>html,body,#root{height:100%;margin:0}body{font:14px Arial}.owner,.resident{display:flex;flex:1;flex-direction:column;min-height:0}.owner{height:100%}[data-composer-card]{margin-top:auto}'+css+'</style></head><body><div id="root"></div></body></html>');await page.addScriptTag({content:script});
    await page.getByRole('button',{name:'收起通话',exact:true}).click();await page.getByRole('region',{name:'语音对话',exact:true}).waitFor();
    assert(await page.locator('.voice-call-frame-content').evaluate(node=>node.inert));
    await page.evaluate(()=>window.pending());await page.getByRole('region',{name:'原审批',exact:true}).waitFor();
    assert.equal(await page.getByRole('region',{name:'语音对话',exact:true}).count(),0);
    assert.equal(await page.locator('.voice-call-frame-content').evaluate(node=>node.inert),false);
    assert.equal(await page.getByRole('textbox',{name:'原输入',exact:true}).evaluate(node=>node.inert),false);
    await page.getByRole('button',{name:'返回语音通话',exact:true}).click();await page.getByRole('button',{name:'处理确认',exact:true}).click();
    await page.getByRole('button',{name:'确认本次',exact:true}).click();await page.getByRole('region',{name:'语音对话',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>window.approved),1);
    await page.evaluate(()=>window.pending());await page.getByRole('button',{name:'结束语音通话',exact:true}).click();
    await page.getByRole('region',{name:'原审批',exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.approved),1);assert.equal(await page.evaluate(()=>window.ended),1);
    assert.equal(await page.locator('.voice-call-frame-content').evaluate(node=>node.inert),false);assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
