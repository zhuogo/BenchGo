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
      const inputMode=/^(steering|queue)-/.test(mode),stage=mode.split('-')[1],queued=mode.startsWith('queue-');
      const placement=queued?'queued':'steering';
      const human={id:'human',source:{kind:'user',rpcId:'human-rpc'},content:[{type:'text',text:'这是运行中补充的真实要求'}]};
      const ordering=['mixed','reordered'].includes(stage),second={...human,id:'second',source:{kind:'user',rpcId:'second-rpc'},content:[{type:'text',text:'这是第二条排队要求'}]};
      const inbox=ordering?{'next-turn':stage==='reordered'?[second,human]:[human,second]}:inputMode&&stage==='inbox'?{[queued?'next-turn':'next-step']:[human,{...human,id:'private',source:{kind:'benchgo-task-reply'},content:[{type:'text',text:'PRIVATE_NOTICE'}]}]}:{};
      let Official, retains=0;
      const ctx={effect:fn=>fn(),slots:{inject:(_name,fn)=>fn(),register:(_meta,Component)=>{Official=Component;return()=>{}}},
        uiConversation:{binding:()=>({activate:()=>{}})},sessions:{retain:()=>{retains++;if(mode==='error')throw Error('offline');return {binding:{session:{getSnapshot:()=>({openState:mode==='settled-error'&&retains===1?'error':'open'})}},ready:mode==='loading'?new Promise(()=>{}):Promise.resolve(),release(){}}}}};
      mountAssistantConversation(ctx);
      const session={openState:'open',running:inputMode||mode.startsWith('activity-')||mode==='segments-live',blank:!inputMode,awaitingFirstTurn:!inputMode,pendingSubmissions:inputMode&&stage!=='inbox'?[{requestId:'human-rpc',placement,text:human.content[0].text,time:1794218400100,attachments:[]}]:[]};
      if(ordering)session.pendingSubmissions=[{requestId:'second-rpc',placement:'queued',text:second.content[0].text,time:1,attachments:[]}];
      const chat={legacy:{nodes:inputMode?(stage==='admitted'?[{...human,kind:'steering',messageId:'human',seq:7,time:1794218400100}]:[]):mode==='empty'?[]:[...nodes,{kind:'context',seq:6,source:{kind:'system'},content:[{type:'text',text:'PRIVATE_CONTEXT'}]}]}};
      if(mode==='activity-thinking')chat.legacy.partial={blocks:[{kind:'reasoning',text:'PRIVATE_REASONING'}]};
      if(mode==='activity-search')chat.legacy.runningCalls=[{name:'assistant_memory_search'}];
      if(mode==='segments-live')Object.assign(chat.legacy,{nodes:[{kind:'user',messageId:'human',seq:1,source:{kind:'user'}},{kind:'assistant',messageId:'model-one',seq:2,turn:1,step:1,blocks:[{kind:'text',text:'我先检查服务器的状态。'}]}],partial:{turn:1,step:2,blocks:[{kind:'text',text:'检查完成，服务运行正常。'}]}});
      if(mode==='segments-history')chat.legacy.nodes=[];
      const conversation={activeTargets:new Set(),views:new Map([['chat',chat]])};
      const select=value=>selector=>selector(value),noop=()=>{};
      const hooks={useSession:select(session),useConversation:select(conversation),useInput:select({phase:'plain',draft:''}),useProjection:name=>name==='inbox'?inbox:undefined,inputActions:{setDraft:noop,persistDraft:noop}};
      const renderFactorySlot=(_name,_props,children)=>{const View=children.slots.views;return <View {...hooks}/>};
      const renderSlot=()=> <Official {...hooks} renderFactorySlot={renderFactorySlot}/>;
      const history={sessionId:'feishu-session',threadId:inputMode?'main':'channel-thread',messages:inputMode&&stage==='history'?[{id:'human',rpcId:'human-rpc',seq:7,role:'user',text:human.content[0].text,time:1794218400100},{id:'formal',role:'assistant',kind:'final',text:'正式回复保持可见',time:1794218400200}]:mode==='history'?messages:[],hasMore:false,
        requests:inputMode?[{threadId:'main',requestId:'internal',status:'failed',text:'PRIVATE_NOTICE',error:'PRIVATE_ERROR',taskReply:{}}]:[]};
      if(ordering)history.messages=[{id:'formal',role:'assistant',kind:'final',text:'正式回复保持可见',time:1794218400200}];
      if(mode.startsWith('segments-')){history.messages=[{id:'human',role:'user',seq:1,text:'检查服务器状态'}];history.activeReply={turn:1,requestId:'human'};if(mode==='segments-history')history.messages.push(...['我先检查服务器的状态。','检查完成，服务运行正常。'].map((text,i)=>({id:'reply:human:1:'+(i+1),role:'assistant',kind:'final',requestId:'human',segment:true,text})));}
      const api=async name=>name==='petCatalog'?{}:name==='tasks'?{tasks:[]}:name==='goals'?{goals:[]}:{};
      const id=++serial;
      root.render(<ActivityProvider><div key={mode==='history'?'data':mode.startsWith('segments-')?'segments':mode} data-render={id} className='ba-root' style={{height:720,display:'flex',flexDirection:'column',maxWidth:960,margin:'auto'}}><style>{css}</style><header style={{padding:16}}>{inputMode?'BenchGo 主聊天':'feishu · oc_exact'}</header><AssistantConversation ctx={ctx} sessionId='feishu-session' threadId={inputMode?'main':'channel-thread'} history={history} api={api} assistantName='BenchGo' assistantConfig={{cardMotion:false,cardHtml:'<b>PRIVATE_CUSTOM_CARD</b>'}} SessionProvider={({children})=>children} renderSlot={renderSlot} onRefresh={noop} onOpenResources={noop}/></div></ActivityProvider>);
      return id;
    };
  ` }, bundle: true, write: false, outdir: join(root, 'artifacts/unused-channel-quiet-ui-test'), format: 'iife', jsx: 'automatic',
    nodePaths: [join(root, 'plugins/benchgo/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')],
    alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')),
      '@deepseek-ai/dsh-client-ui-primitives':join(root,'deepseek-harness/packages/client/ui-primitives/src/index.ts'),
      '@deepseek-ai/dsh-util-workspace-path':join(root,'deepseek-harness/packages/util/workspace-path/src/index.ts') },
    loader: { '.css': 'text', '.module.css': 'local-css', '.svg': 'text', '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl', '.png': 'dataurl' },
    plugins:[sharedUiStyles()],define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  const script = bundle.outputFiles.find(file => file.path.endsWith('.js')).text;
  const styles = bundle.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n');
  const theme=(await Promise.all(['base.css','design-platform.css','focus.css'].map(name=>readFile(join(root,'deepseek-harness/packages/client/ui-theme/src/styles',name),'utf8')))).join('\n');
  return `<!doctype html><html lang='zh-CN'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><style>${theme}${styles}body{margin:0;font:14px/1.6 var(--dsw-font-family);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}</style></head><body><div id='root'></div><script>${script.replaceAll('</script','<\\/script')}</script></body></html>`;
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
      for(const mode of ['loading','error','settled-error','empty','data','history','activity-thinking','activity-search','activity-waiting','segments-live','segments-history']){
        const id=await page.evaluate(mode=>window.renderScenario(mode),mode);await page.locator('[data-render="'+id+'"]').waitFor();
        if(mode==='loading')await page.getByText('正在连接聊天',{exact:true}).waitFor();
        else if(mode==='error'||mode==='settled-error')await page.getByText('聊天暂未连接',{exact:true}).waitFor();
        else if(mode==='empty'){await page.locator('.ba-quiet-chat').waitFor();assert.equal(await page.locator('[data-chat-key]').count(),0);}
        else if(mode.startsWith('segments-')){await page.getByText('检查完成，服务运行正常。',{exact:true}).waitFor();assert.equal(await page.locator('[data-role=assistant]').count(),2);assert.deepEqual(await page.locator('[data-role=assistant]').evaluateAll(nodes=>nodes.map(node=>node.dataset.chatKey)),['message:reply:human:1:1','message:reply:human:1:2']);const fonts=await page.locator('.ba-chat-content,.ba-chat-content p,.ba-chat-identity-link').evaluateAll(nodes=>nodes.map(node=>getComputedStyle(node).fontFamily));assert(fonts.every(font=>/Segoe UI|YaHei/.test(font)),JSON.stringify(fonts));}
        else {await page.getByText('飞书收到的真实消息',{exact:true}).waitFor();await page.getByText('已交付到飞书的结果',{exact:true}).waitFor();assert.equal(await page.locator('[data-chat-key]').count(),2);assert.equal(await page.getByText('PRIVATE_CONTEXT',{exact:true}).count(),0);assert.equal(await page.locator('.ba-home').count(),0,'channel records must not display the empty conversation home');}
        if(mode==='settled-error'){await page.getByRole('button',{name:'\u91cd\u65b0\u8fde\u63a5',exact:true}).click();await page.locator('.ba-quiet-chat').waitFor();}
        if(mode.startsWith('activity-')){const kind=mode==='activity-thinking'?'waiting':mode.slice(9);assert.equal(await page.locator('.ba-quiet-chat [data-activity="'+kind+'"]').count(),1);assert.equal(await page.getByText('PRIVATE_REASONING',{exact:true}).count(),0);assert.equal(await page.getByText(/等待模型响应|assistant_memory_search/).count(),0);if(kind==='waiting')assert.equal(await page.locator('.ba-quiet-chat .ba-chat-dots i').count(),3);}
        if(!['loading','error','settled-error'].includes(mode)){assert.equal(await page.locator('.ba-chat-heading iframe').count(),0);assert.equal(await page.locator('.ba-chat-heading .ba-chat-identity-link').count(),1);}
        if(mode==='activity-waiting'){await page.emulateMedia({reducedMotion:'reduce'});assert(await page.locator('.ba-chat-dots i').evaluateAll(nodes=>nodes.every(node=>getComputedStyle(node).animationName==='none')));await page.emulateMedia({reducedMotion:'no-preference'});}
        assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
        if(screenshots)await page.screenshot({path:join(screenshots,mode+'-'+theme+'-'+width+'.png'),fullPage:true,animations:'disabled'});
      }
    }
    assert.deepEqual(errors,[]);
  }finally{await browser.close()}
});

test('running main chat input survives echo, durable inbox, admission and history without receipt hints or private notices', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const html=await fixture(),browser=await chromium.launch({headless:true,executablePath});
  const screenshots=process.env.BENCHGO_CHANNEL_QUIET_SCREENSHOTS;
  if(screenshots)await mkdir(screenshots,{recursive:true});
  try {
    const page=await browser.newPage(),errors=[];page.setDefaultTimeout(6000);page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',route=>route.request().url()==='http://localhost/'?route.fulfill({contentType:'text/html',body:html}):route.abort());await page.goto('http://localhost/');
    for(const width of [1440,390])for(const theme of ['light','dark']){
      await page.setViewportSize({width,height:800});await page.evaluate(theme=>document.body.toggleAttribute('data-ds-dark-theme',theme==='dark'),theme);
      for(const kind of ['steering','queue'])for(const stage of ['echo','inbox','admitted','history']){
        const mode=kind+'-'+stage,id=await page.evaluate(mode=>window.renderScenario(mode),mode);
        await page.locator('[data-render="'+id+'"]').waitFor();
        await page.getByText('这是运行中补充的真实要求',{exact:true}).waitFor();
        assert.equal(await page.getByText('这是运行中补充的真实要求',{exact:true}).count(),1);
        assert.equal(await page.getByText(/已收到，将在下一步处理|已排队，当前回复结束后处理/).count(),0);
        if(stage==='history')await page.getByText('正式回复保持可见',{exact:true}).waitFor();
        assert.equal(await page.getByText(/PRIVATE/).count(),0);
        assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
        if(screenshots)await page.screenshot({path:join(screenshots,mode+'-'+theme+'-'+width+'.png'),fullPage:true,animations:'disabled'});
      }
      for(const stage of ['mixed','reordered']){
        const mode='queue-'+stage,id=await page.evaluate(mode=>window.renderScenario(mode),mode);
        await page.locator('[data-render="'+id+'"]').waitFor();
        await page.getByText('这是第二条排队要求',{exact:true}).waitFor();
        const texts=await page.locator('[data-chat-key] .ba-chat-user-text').allTextContents();
        assert.deepEqual(texts,stage==='mixed'?['这是运行中补充的真实要求','这是第二条排队要求']:['这是第二条排队要求','这是运行中补充的真实要求']);
        assert.equal(await page.locator('[data-chat-key]').count(),3);
        assert.equal(await page.locator('[data-chat-key]').first().getAttribute('data-role'),'assistant');
        assert.equal(await page.getByText(/PRIVATE/).count(),0);
        assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
        if(screenshots)await page.screenshot({path:join(screenshots,mode+'-'+theme+'-'+width+'.png'),fullPage:true,animations:'disabled'});
      }
    }
    assert.deepEqual(errors,[]);
  }finally{await browser.close()}
});
