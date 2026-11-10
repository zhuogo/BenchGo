import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sharedUiStyles } from '../../benchgo/scripts/shared-ui.mjs';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url));
const { chromium } = require('playwright');
const { build } = createRequire(new URL('../../benchgo/package.json', import.meta.url))('esbuild');
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || [chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);

async function fixture() {
  const bundle = await build({ stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React from 'react';import {createRoot} from 'react-dom/client';
    import {ActivityProvider} from './plugins/superagent/client/activity-panel.jsx';
    import {AssistantConversation,mountAssistantConversation} from './plugins/superagent/client/conversation.jsx';
    import {channelMessageDefinition} from './plugins/superagent/client/channel-session.jsx';
    import css from './plugins/superagent/client/style.css';
    const root=createRoot(document.getElementById('root'));let serial=0;
    const source={channel:'feishu',sourceType:'direct',conversationId:'oc_exact'};
    const events=['inbound','delivery'].map((direction,i)=>({type:'plugin:benchgo-plugin/channel-message',ignorable:true,seq:i+3,time:1794218400000+i,
      data:{mirrorKey:direction+':one',direction,source,text:direction==='inbound'?'飞书收到的真实消息':'已交付到飞书的结果'}}));
    const nodes=events.map(event=>{const match={...channelMessageDefinition.match(event),event,location:{kind:'session'}};return channelMessageDefinition.start({},match)});
    const messages=nodes.map(node=>({id:'channel:'+node.source.mirrorKey,kind:'channel-message',mirrorKey:node.source.mirrorKey,direction:node.source.direction,
      role:node.source.direction==='inbound'?'user':'assistant',source:node.source,text:node.content[0].text,content:node.content,seq:node.seq,time:node.time}));
    window.renderScenario=(mode='data')=>{
      let Official;
      const ctx={effect:fn=>fn(),slots:{inject:(_name,fn)=>fn(),register:(_meta,Component)=>{Official=Component;return()=>{}}},
        uiConversation:{binding:()=>({activate:()=>{}})},sessions:{retain:()=>{if(mode==='error')throw Error('offline');return {ready:mode==='loading'?new Promise(()=>{}):Promise.resolve(),release(){}}}}};
      mountAssistantConversation(ctx);
      const session={openState:'open',running:false,blank:true,awaitingFirstTurn:true,pendingSubmissions:[]};
      const chat={legacy:{nodes:mode==='empty'?[]:[...nodes,{kind:'context',seq:6,source:{kind:'system'},content:[{type:'text',text:'PRIVATE_CONTEXT'}]}]}};
      const conversation={activeTargets:new Set(),views:new Map([['chat',chat]])};
      const select=value=>selector=>selector(value),noop=()=>{};
      const hooks={useSession:select(session),useConversation:select(conversation),useInput:select({phase:'plain',draft:''}),inputActions:{setDraft:noop,persistDraft:noop}};
      const renderFactorySlot=(_name,_props,children)=>{const View=children.slots.views;return <View {...hooks}/>};
      const renderSlot=()=> <Official {...hooks} renderFactorySlot={renderFactorySlot}/>;
      const history={sessionId:'feishu-session',threadId:'channel-thread',messages:mode==='history'?messages:[],hasMore:false};
      const api=async name=>name==='petCatalog'?{}:name==='tickets'?{tickets:[]}:name==='goals'?{goals:[]}:{};
      const id=++serial;
      root.render(<ActivityProvider><div key={mode==='history'?'data':mode} data-render={id} className='ba-root' style={{height:720,display:'flex',flexDirection:'column',maxWidth:960,margin:'auto'}}><style>{css}</style><header style={{padding:16}}>feishu · oc_exact</header><AssistantConversation ctx={ctx} sessionId='feishu-session' threadId='channel-thread' history={history} api={api} assistantName='BenchGo' assistantConfig={{cardMotion:false}} SessionProvider={({children})=>children} renderSlot={renderSlot} onRefresh={noop} onOpenResources={noop}/></div></ActivityProvider>);
      return id;
    };
  ` }, bundle: true, write: false, outdir: join(root, 'artifacts/unused-channel-quiet-ui-test'), format: 'iife', jsx: 'automatic',
    nodePaths: [join(root, 'plugins/benchgo/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')],
    alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')),
      '@deepseek-ai/dsh-client-ui-primitives':join(root,'deepseek-harness/packages/client/ui-primitives/src/index.ts') },
    loader: { '.css': 'text', '.module.css': 'local-css', '.svg': 'text', '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl', '.png': 'dataurl' },
    plugins:[sharedUiStyles()],define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  const script = bundle.outputFiles.find(file => file.path.endsWith('.js')).text;
  const styles = bundle.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n');
  const theme=(await Promise.all(['base.css','design-platform.css','focus.css'].map(name=>readFile(join(root,'deepseek-harness/packages/client/ui-theme/src/styles',name),'utf8')))).join('\n');
  return `<!doctype html><html lang='zh-CN'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><style>${theme}${styles}body{margin:0;font:14px/1.6 Arial,sans-serif;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}</style></head><body><div id='root'></div><script>${script.replaceAll('</script','<\\/script')}</script></body></html>`;
}

test('real assistant side conversation displays channel mirrors across connection states and history handoff', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const html=await fixture(),browser=await chromium.launch({headless:true,executablePath});
  const screenshots=process.env.BENCHGO_CHANNEL_QUIET_SCREENSHOTS;
  if(screenshots)await mkdir(screenshots,{recursive:true});
  try {
    const page=await browser.newPage(),errors=[];page.setDefaultTimeout(6000);page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',route=>route.request().url()==='http://localhost/'?route.fulfill({contentType:'text/html',body:html}):route.abort());await page.goto('http://localhost/');
    for(const width of [1440,390])for(const theme of ['light','dark']){
      await page.setViewportSize({width,height:800});await page.evaluate(theme=>document.body.toggleAttribute('data-ds-dark-theme',theme==='dark'),theme);
      for(const mode of ['loading','error','empty','data','history']){
        const id=await page.evaluate(mode=>window.renderScenario(mode),mode);await page.locator('[data-render="'+id+'"]').waitFor();
        if(mode==='loading')await page.getByText('正在连接聊天',{exact:true}).waitFor();
        else if(mode==='error')await page.getByText('聊天暂未连接',{exact:true}).waitFor();
        else if(mode==='empty'){await page.locator('.ba-quiet-chat').waitFor();assert.equal(await page.locator('[data-chat-key]').count(),0);}
        else {await page.getByText('飞书收到的真实消息',{exact:true}).waitFor();await page.getByText('已交付到飞书的结果',{exact:true}).waitFor();assert.equal(await page.locator('[data-chat-key]').count(),2);assert.equal(await page.getByText('PRIVATE_CONTEXT',{exact:true}).count(),0);assert.equal(await page.locator('.ba-home').count(),0,'channel records must not display the empty conversation home');}
        assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
        if(screenshots)await page.screenshot({path:join(screenshots,mode+'-'+theme+'-'+width+'.png'),fullPage:true});
      }
    }
    assert.deepEqual(errors,[]);
  }finally{await browser.close()}
});
