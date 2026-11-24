import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sharedUiStyles } from '../../base/scripts/shared-ui.mjs';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url));
const { chromium } = require('playwright');
const { build } = createRequire(new URL('../../base/package.json', import.meta.url))('esbuild');
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || [chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);

async function fixture() {
  const bundle = await build({ stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
    import {ActivityProvider} from './plugins/superagent/client/activity-panel.jsx';
    import {AssistantConversation,mountAssistantConversation} from './plugins/superagent/client/conversation.jsx';
    import {channelMessageDefinition} from './plugins/superagent/client/channel-session.jsx';
    import css from './plugins/superagent/client/style.css';
    import hostCss from './plugins/base/client/style.css';
    import native from './deepseek-harness/packages/client/ui-conversation/src/client/skeleton/ConversationRoot.module.css';
    import input from './deepseek-harness/packages/client/ui-conversation/src/client/skeleton/InputBar.module.css';
    const root=createRoot(document.getElementById('root'));let serial=0;
    const source={channel:'feishu',sourceType:'direct',conversationId:'oc_exact'};
    const events=['inbound','delivery'].map((direction,i)=>({type:'plugin:benchgo-plugin/channel-message',ignorable:true,seq:i+3,time:1794218400000+i,
      data:{mirrorKey:direction+':one',direction,source,text:direction==='inbound'?'飞书收到的真实消息':'已交付到飞书的结果'}}));
    const nodes=events.map(event=>{const match={...channelMessageDefinition.match(event),event,location:{kind:'session'}};return channelMessageDefinition.start({},match)});
    const messages=nodes.map(node=>({id:'channel:'+node.source.mirrorKey,kind:'channel-message',mirrorKey:node.source.mirrorKey,direction:node.source.direction,
      role:node.source.direction==='inbound'?'user':'assistant',source:node.source,text:node.content[0].text,content:node.content,seq:node.seq,time:node.time}));
    window.renderScenario=async(mode='data',imageCount=0)=>{
      const inputMode=/^(steering|queue|idle)-/.test(mode),idleMode=mode.startsWith('idle-'),stage=mode.split('-')[1],queued=mode.startsWith('queue-');
      const threadId=inputMode||mode.startsWith('main-')?'main':'channel-thread';
      const replyError=mode==='reply-error'||mode==='main-reply-error';
      const placement=idleMode?'transcript':queued?'queued':'steering';
      const human={id:'human',source:{kind:'user',rpcId:'human-rpc'},content:[{type:'text',text:imageCount===1?'':idleMode?'这是已发送的真实要求':'这是运行中补充的真实要求'}]};
      const uploads=await Promise.all(Array.from({length:imageCount},async(_,index)=>{
        const canvas=document.createElement('canvas');canvas.width=320;canvas.height=200;
        const paint=canvas.getContext('2d');paint.fillStyle=['#218876','#c35930'][index];paint.fillRect(0,0,320,200);
        const blob=await new Promise(resolve=>canvas.toBlob(resolve));
        const name='截图 '+(index+1)+'.png',attachmentId='upload-'+index;
        return {attachment:{attachmentId,name,mediaType:'image/png',bytes:blob.size,width:320,height:200},url:URL.createObjectURL(blob)};
      }));
      human.content.push(...uploads.map(({attachment})=>({type:'image',attachment})));
      const ordering=!idleMode&&['mixed','reordered'].includes(stage),second={...human,id:'second',source:{kind:'user',rpcId:'second-rpc'},content:[{type:'text',text:'这是第二条排队要求'}]};
      const inbox=ordering?{'next-turn':stage==='reordered'?[second,human]:[human,second]}:inputMode&&stage==='inbox'?{[queued?'next-turn':'next-step']:[human,{...human,id:'private',source:{kind:'benchgo-task-reply'},content:[{type:'text',text:'PRIVATE_NOTICE'}]}]}:{};
      let Official, ModelSetup, retains=0;
      const ctx={effect:fn=>fn(),slots:{inject:(_name,fn)=>fn(),register:({name},Component)=>{
        if(name==='benchgo.assistant.conversation')Official=Component;
        if(name==='conversation.input.dock')ModelSetup=Component;
        return()=>{};
      }},
        uiConversation:{binding:()=>({activate:()=>{}}),peekImageUrl:()=>undefined,async imageUrl(sessionId,{attachmentId}){
          if(sessionId!=='feishu-session')throw Error('wrong image session');
          return uploads.find(item=>item.attachment.attachmentId===attachmentId).url;
        }},sessions:{retain:()=>{retains++;if(mode==='error')throw Error('offline');return {binding:{session:{getSnapshot:()=>({openState:mode==='settled-error'&&retains===1?'error':'open'})}},ready:mode==='loading'?new Promise(()=>{}):Promise.resolve(),release(){}}}}};
      mountAssistantConversation(ctx);
      const session={sessionId:'feishu-session',openState:'open',running:inputMode&&!idleMode||mode.startsWith('activity-')||mode==='segments-live',blank:!inputMode,awaitingFirstTurn:!inputMode,pendingSubmissions:inputMode&&stage!=='inbox'&&(!imageCount||stage!=='history')?[{requestId:'human-rpc',placement,text:human.content[0].text,time:1794218400100,
        attachments:uploads.map(({attachment,url})=>({type:'image',value:{name:attachment.name,previewUrl:url}}))}]:[]};
      if(ordering)session.pendingSubmissions=[{requestId:'second-rpc',placement:'queued',text:second.content[0].text,time:1,attachments:[]}];
      if(idleMode&&stage==='mixed')session.pendingSubmissions.push({requestId:'second-rpc',placement:'transcript',text:second.content[0].text,time:1794218400200,attachments:[]});
      const chat={legacy:{nodes:inputMode?(stage==='admitted'||idleMode&&stage==='mixed'?[{...human,kind:idleMode?'user':'steering',messageId:'human',seq:7,time:1794218400100}]:[]):['empty','main-model-setup'].includes(mode)?[]:[...nodes,{kind:'context',seq:6,source:{kind:'system'},content:[{type:'text',text:'PRIVATE_CONTEXT'}]}]}};
      if(mode==='activity-thinking')chat.legacy.partial={blocks:[{kind:'reasoning',text:'PRIVATE_REASONING'}]};
      if(mode==='activity-search')chat.legacy.runningCalls=[{name:'assistant_memory_search'}];
      if(mode==='segments-live')Object.assign(chat.legacy,{nodes:[{kind:'user',messageId:'human',seq:1,source:{kind:'user'}},{kind:'assistant',messageId:'model-one',seq:2,turn:1,step:1,blocks:[{kind:'text',text:'我先检查服务器的状态。'}]}],partial:{turn:1,step:2,blocks:[{kind:'text',text:'检查完成，服务运行正常。'}]}});
      if(mode==='segments-history')chat.legacy.nodes=[];
      const conversation={activeTargets:new Set(),views:new Map([['chat',chat]])};
      const select=value=>selector=>selector(value),noop=()=>{};
      const hooks={useSession:select(session),useConversation:select(conversation),useInput:select({phase:'plain',draft:''}),useProjection:name=>name==='inbox'?inbox:undefined,inputActions:{setDraft:noop,persistDraft:noop}};
      const renderFactorySlot=(_name,_props,children)=>{
        const View=children.slots.views;
        return mode==='main-model-setup'?<div className={native.body} data-conversation-content=''><div className={native.scrollBody} data-conversation-scroll=''><View {...hooks}/><div className={native.composerSeat} data-composer-seat=''><div className={native.composerStack}><div data-slot='conversation.input.dock' style={{display:'contents'}}><ModelSetup/></div><div className={input.root}><div className={input.card} data-composer-card=''><textarea aria-label='消息草稿' style={{width:'100%',minHeight:76,padding:10,border:0,background:'transparent',color:'inherit',font:'inherit',resize:'none'}}/></div></div></div></div></div></div>:<View {...hooks}/>;
      };
      const renderSlot=name=>name==='benchgo.assistant.conversation'?<Official {...hooks} renderSlot={()=>null} renderFactorySlot={renderFactorySlot}/>:null;
      const history={sessionId:'feishu-session',threadId,messages:inputMode&&stage==='history'?[{id:'human',rpcId:'human-rpc',seq:7,role:'user',text:human.content[0].text,content:human.content,time:1794218400100},{id:'formal',role:'assistant',kind:'final',text:'正式回复保持可见',time:1794218400200}]:mode==='history'?messages:[],hasMore:false,
        requests:inputMode?[{threadId:'main',requestId:'internal',status:'failed',text:'PRIVATE_NOTICE',error:'PRIVATE_ERROR',taskReply:{}}]:[]};
      if(ordering)history.messages=[{id:'formal',role:'assistant',kind:'final',text:'正式回复保持可见',time:1794218400200}];
      if(replyError){
        history.error={message:'模型响应超时 '+ 'diagnostic'.repeat(50)};
        history.failures=[{model:{modelId:'opaque-model'},reason:'连接超时'}];
      }
      if(mode.startsWith('segments-')){history.messages=[{id:'human',role:'user',seq:1,text:'检查服务器状态'}];history.activeReply={turn:1,requestId:'human'};if(mode==='segments-history')history.messages.push(...['我先检查服务器的状态。','检查完成，服务运行正常。'].map((text,i)=>({id:'reply:human:1:'+(i+1),role:'assistant',kind:'final',requestId:'human',segment:true,text})));}
      if(mode==='main-media'){
        chat.legacy.nodes=[];
        history.messages=[{id:'human',role:'user',seq:1,text:'生成图片和语音'},{id:'next',role:'user',seq:8,text:'下一条消息'}];
        history.images=[{groupId:'turn:1',seq:3,url:'/first.png'},{groupId:'turn:1',seq:4,url:'/second.png'}];
        history.media=[{groupId:'turn:1',seq:5,url:'/voice.wav',name:'voice.wav',mimeType:'audio/wav'}];
      }
      const api=async name=>{if(name==='petCatalog'&&mode==='reply-error')throw Error('形象读取失败');return name==='tasks'?{tasks:[]}:name==='goals'?{goals:[]}:{};};
      window.clearCalls=0;
      const onClear=()=>{window.clearCalls++;return new Promise(resolve=>{window.finishClear=resolve;});};
      const id=++serial;
      const SessionProvider=({children})=>children;
      function SetupScenario(){
        const [configured,setConfigured]=useState(false);
        window.setModelConfigured=setConfigured;
        return <AssistantConversation active={false} ctx={ctx} sessionId='feishu-session' threadId={threadId} history={history} api={api} assistantName='BenchGo' SessionProvider={SessionProvider} renderSlot={renderSlot} onOpenResources={noop} onConfigureModel={configured?undefined:()=>document.dispatchEvent(new CustomEvent('fixture:open-models'))}/>;
      }
      root.render(<ActivityProvider><div key={mode==='history'?'data':mode.startsWith('segments-')?'segments':mode} data-render={id} className='ba-root' style={{height:720,display:'flex',flexDirection:'column',maxWidth:960,margin:'auto'}}><style>{hostCss}{css}</style><header style={{padding:16}}>{threadId==='main'?'BenchGo 主聊天':'feishu · oc_exact'}</header>{mode==='main-model-setup'?<SetupScenario/>:<AssistantConversation active={false} ctx={ctx} sessionId='feishu-session' threadId={threadId} channel={threadId==='channel-thread'} history={history} api={api} assistantName='BenchGo' assistantConfig={{cardMotion:false,cardHtml:'<b>PRIVATE_CUSTOM_CARD</b>'}} SessionProvider={SessionProvider} renderSlot={renderSlot} onRefresh={noop} onOpenResources={noop} onClear={onClear}/>}</div></ActivityProvider>);
      return id;
    };
    window.renderRetry=(threadId,channel=false)=>{
      const sessionId='router-'+threadId, select=value=>selector=>selector(value), noop=()=>{};
      const input={phase:'plain',draft:'保留这段草稿',attachmentIds:['draft-image'],queue:[]};
      const session={sessionId,openState:'open',running:false,subagent:null,pendingSubmissions:[]};
      let history={sessionId,threadId,lastEndSeq:11,error:'服务器历史中的旧错误',messages:[{id:'human',role:'user',seq:7,text:'请检查服务是否正常'}]};
      let continuation=11, turnEnd={seq:11,data:{reason:{kind:'error',error:{message:'模型响应超时'}}}}, blocked, inbox={}, statuses=new Map(), promptAllowed=true;
      const ctx={effect:fn=>fn(),slots:{inject:(_name,fn)=>fn(),register:({name},Component)=>{if(name==='benchgo.assistant.conversation')Official=Component;return noop}},
        uiConversation:{binding:()=>({activate:noop})},uiSession:{sessionStatus:{getSnapshot:()=>statuses,subscribe:()=>noop}},
        remoteAccess:{source:(resource,id,action)=>({getSnapshot:()=>resource==='session'&&id===sessionId&&action==='session/prompt'&&promptAllowed})},
        conversation:{input:{for:scope=>{if(scope!==binding.ctx)throw Error('wrong input scope');return {state:{getSnapshot:()=>input}}}},
          blocks:{storeFor:()=>({getSnapshot:()=>blocked,subscribe:()=>noop})}},
        sessions:{retain:()=>({binding,ready:Promise.resolve(),release:noop}),binding:id=>id===sessionId?binding:undefined}};
      let Official;
      const binding={ctx:{},session:{getSnapshot:()=>session,projections:{faceOf:key=>({getSnapshot:()=>key==='inbox'?inbox:continuation})},
        prompt:(content,mode)=>{window.retryCalls.push({sessionId,content,mode});return new Promise(resolve=>{window.finishRetry=message=>resolve(message?{ok:false,error:{message}}:{ok:true});});}}};
      mountAssistantConversation(ctx);
      const SessionProvider=({children})=>children, api=async()=>({});
      const renderSlot=name=>name==='benchgo.assistant.conversation'?<Official {...hooks} renderSlot={()=>null} renderFactorySlot={renderFactorySlot}/>:null;
      const renderFactorySlot=(_name,_props,children)=>{
        const View=children.slots.views;
        return <><View {...hooks}/><div style={{padding:16,borderTop:'1px solid #8883'}}><textarea aria-label='消息草稿' readOnly value={input.draft}/>{input.attachmentIds.includes('draft-image')&&<span>已添加图片附件</span>}</div></>;
      };
      let hooks;
      const render=()=>{
        const chat={timeline:{turnOrder:[1],turns:new Map([[1,{end:turnEnd}]])},legacy:{nodes:[]}};
        const conversation={activeTargets:new Set(['chat']),views:new Map([['chat',chat]])};
        hooks={useSession:select({...session}),useConversation:select(conversation),useInput:select({...input}),inputActions:{setDraft:noop,persistDraft:noop},
          useProjection:key=>key==='inbox'?inbox:continuation,useAccess:action=>action==='session/prompt'&&promptAllowed};
        root.render(<ActivityProvider><div key={threadId} className='ba-root' style={{height:720,display:'flex',flexDirection:'column',maxWidth:960,margin:'auto'}}>
          <style>{hostCss}{css}</style><header style={{padding:16}}>{threadId==='main'?'BenchGo 主聊天':'BenchGo 旁聊'}</header>
          <AssistantConversation active={false} ctx={ctx} sessionId={sessionId} threadId={threadId} channel={channel} history={history} api={api}
            assistantName='BenchGo' SessionProvider={SessionProvider} renderSlot={renderSlot} onRefresh={noop} onOpenResources={noop}/>
        </div></ActivityProvider>);
      };
      window.retryCalls=[];
      window.patchRetry=(changed,paint=true)=>{
        if('continuation' in changed)continuation=changed.continuation;
        if('turnEnd' in changed)turnEnd=changed.turnEnd;
        if('blocked' in changed)blocked=changed.blocked;
        if('pendingInteraction' in changed)statuses=new Map([[sessionId,{pendingInteraction:changed.pendingInteraction}]]);
        if('inbox' in changed)inbox=changed.inbox;
        if('promptAllowed' in changed)promptAllowed=changed.promptAllowed;
        if(changed.history)history={...history,...changed.history};
        Object.assign(session,changed.session);Object.assign(input,changed.input);
        if(paint)render();
      };
      render();
    };
  ` }, bundle: true, write: false, outdir: join(root, 'artifacts/unused-channel-quiet-ui-test'), format: 'iife', jsx: 'automatic',
    nodePaths: [join(root, 'plugins/base/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')],
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

test('model setup stays attached to the native composer and leaves its draft intact', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const html = await fixture(), browser = await chromium.launch({ headless: true, executablePath });
  const screenshots = process.env.BENCHGO_NOTEBOOK_SCREENSHOTS;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  try {
    for (const width of [1440, 390, 320]) {
      const page = await browser.newPage({ viewport: { width, height: 760 }, hasTouch: width < 400 });
      page.setDefaultTimeout(6000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('http://localhost/', route => route.fulfill({ contentType: 'text/html', body: html }));
      await page.goto('http://localhost/');
      await page.evaluate(() => {
        window.modelOpens = 0;
        document.addEventListener('fixture:open-models', () => window.modelOpens++);
        window.renderScenario('main-model-setup');
      });
      const dock = page.locator('[data-composer-seat] .ba-model-setup');
      const copy = '还没有给你的助手配置模型';
      const action = dock.getByRole('button', { name: '配置模型' });
      const draft = page.getByRole('textbox', { name: '消息草稿' });
      await dock.getByText(copy, { exact: true }).waitFor();
      assert.equal(await page.getByLabel('聊天记录').getByText(copy).count(), 0);
      for (const dark of [false, true]) {
        await page.evaluate(async dark => {
          document.body.toggleAttribute('data-ds-dark-theme', dark);
          await new Promise(requestAnimationFrame);
          await new Promise(requestAnimationFrame);
          await Promise.allSettled(document.getAnimations().map(animation => animation.finished));
        }, dark);
        const note = await dock.boundingBox(), card = await page.locator('[data-composer-card]').boundingBox();
        assert(note.x > card.x && note.x + note.width < card.x + card.width);
        assert(Math.abs(note.y + note.height - card.y) < 1, 'note ends at the input card edge');
        assert(await dock.evaluate(node => node.scrollWidth <= node.clientWidth));
        assert(await dock.getByText(copy, { exact: true }).evaluate(node => {
          const text = document.createRange();
          text.selectNodeContents(node);
          return new Set(Array.from(text.getClientRects(), rect => rect.top)).size === 1;
        }), `note copy stays on one line at ${width}px`);
        assert(note.height <= (width < 400 ? 48 : 32));
        if (width < 400) assert((await action.boundingBox()).height >= 44);
        if (screenshots) await page.screenshot({ path: join(screenshots, `notebook-${width}-${dark ? 'dark' : 'light'}.png`) });
      }
      await draft.fill('保留草稿');
      await action.focus();
      await page.keyboard.press('Enter');
      assert.equal(await page.evaluate(() => window.modelOpens), 1);
      await page.evaluate(() => window.setModelConfigured(true));
      await dock.waitFor({ state: 'detached' });
      assert.equal(await draft.inputValue(), '保留草稿');
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally { await browser.close(); }
});

test('real assistant conversations display connection states, channel history and main chat recovery', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const html=await fixture(),browser=await chromium.launch({headless:true,executablePath});
  const screenshots=process.env.BENCHGO_CHANNEL_QUIET_SCREENSHOTS;
  if(screenshots)await mkdir(screenshots,{recursive:true});
  try {
    const page=await browser.newPage(),errors=[];page.setDefaultTimeout(6000);page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',route=>route.request().url()==='http://localhost/'?route.fulfill({contentType:'text/html',body:html}):route.abort());await page.goto('http://localhost/');
    for(const width of [1440,390])for(const theme of ['light','dark']){
      await page.setViewportSize({width,height:800});await page.evaluate(theme=>document.body.toggleAttribute('data-ds-dark-theme',theme==='dark'),theme);
      for(const mode of ['loading','error','settled-error','empty','data','history','reply-error','main-reply-error','main-data','activity-thinking','activity-search','activity-waiting','segments-live','segments-history','main-media']){
        const id=await page.evaluate(mode=>window.renderScenario(mode),mode);await page.locator('[data-render="'+id+'"]').waitFor();
        if(mode==='loading')await page.getByText('正在连接聊天',{exact:true}).waitFor();
        else if(mode==='error'||mode==='settled-error')await page.getByText('聊天暂未连接',{exact:true}).waitFor();
        else if(mode==='empty'){await page.locator('.ba-quiet-chat').waitFor();assert.equal(await page.locator('[data-chat-key]').count(),0);}
        else if(mode==='reply-error'||mode==='main-reply-error'){
          const feed=page.getByLabel('聊天记录',{exact:true});
          const notice=feed.locator('[data-chat-key="notice:reply-failed"][data-role="assistant"]');
          await notice.getByText(mode==='reply-error'?'本次回复未完成，对话记录已保留。请重试或检查模型连接。':'本次回复未完成，对话记录已保留。',{exact:true}).waitFor();
          assert.equal(await notice.getByRole('button',{name:'重试回复',exact:true}).count(),0);
          assert.equal(await page.getByText(/本次回复未完成/).count(),1);
          if(mode==='reply-error'){
            assert.deepEqual(await feed.locator('[data-chat-key]').evaluateAll(rows=>rows.map(row=>row.dataset.role)),['user','assistant','assistant','assistant']);
            assert.equal(await feed.getByRole('alert').filter({hasText:'形象读取失败'}).count(),1);
          }
          assert.equal(await notice.getByRole('button',{name:'清理主聊天记录'}).count(),0);
          assert.equal(await notice.getByText(/模型响应超时/).count(),0);
          const diagnostics=notice.getByRole('button',{name:'诊断详情'}), models=notice.getByRole('button',{name:'模型连接记录'});
          const tagColor=button=>button.evaluate(node=>getComputedStyle(node).color);
          assert.notEqual(await tagColor(diagnostics),await tagColor(models));
          assert((await models.boundingBox()).width<(await notice.boundingBox()).width);
          await diagnostics.click();
          await notice.getByText(/模型响应超时/).waitFor();
          await models.click();
          await notice.getByText('opaque-model',{exact:true}).waitFor();
          await notice.getByText('连接超时',{exact:true}).waitFor();
          assert(await notice.locator('.ba-chat-content').evaluate(node=>node.scrollWidth<=node.clientWidth));
        }
        else if(mode==='main-media'){
          const delivery=page.locator('[data-chat-key="generated-media:turn:1"]');
          await delivery.getByRole('button',{name:'展开 2 张图片'}).waitFor();
          await delivery.getByRole('button',{name:'播放 voice.wav'}).waitFor();
          assert.deepEqual(await page.locator('[data-chat-key]').evaluateAll(rows=>rows.map(row=>row.dataset.chatKey)),['message:human','generated-media:turn:1','message:next']);
        }
        else if(mode.startsWith('segments-')){await page.getByText('检查完成，服务运行正常。',{exact:true}).waitFor();assert.equal(await page.locator('[data-role=assistant]').count(),2);assert.deepEqual(await page.locator('[data-role=assistant]').evaluateAll(nodes=>nodes.map(node=>node.dataset.chatKey)),['message:reply:human:1:1','message:reply:human:1:2']);const fonts=await page.locator('.ba-chat-content,.ba-chat-content p,.ba-chat-identity-link').evaluateAll(nodes=>nodes.map(node=>getComputedStyle(node).fontFamily));assert(fonts.every(font=>/Segoe UI|YaHei/.test(font)),JSON.stringify(fonts));}
        else {await page.getByText('飞书收到的真实消息',{exact:true}).waitFor();await page.getByText('已交付到飞书的结果',{exact:true}).waitFor();assert.equal(await page.locator('[data-chat-key]').count(),2);assert.equal(await page.getByText('PRIVATE_CONTEXT',{exact:true}).count(),0);assert.equal(await page.locator('.ba-home').count(),0,'channel records must not display the empty conversation home');}
        if(mode==='settled-error'){await page.getByRole('button',{name:'\u91cd\u65b0\u8fde\u63a5',exact:true}).click();await page.locator('.ba-quiet-chat').waitFor();}
        if(mode.startsWith('activity-')){const kind=mode==='activity-thinking'?'waiting':mode.slice(9);assert.equal(await page.locator('.ba-quiet-chat [data-activity="'+kind+'"]').count(),1);assert.equal(await page.getByText('PRIVATE_REASONING',{exact:true}).count(),0);assert.equal(await page.getByText(/等待模型响应|assistant_memory_search/).count(),0);if(kind==='waiting')assert.equal(await page.locator('.ba-quiet-chat .ba-chat-dots i').count(),3);}
        if(!['loading','error','settled-error'].includes(mode)){assert.equal(await page.locator('.ba-chat-heading iframe').count(),0);assert.equal(await page.locator('.ba-chat-heading .ba-chat-identity-link').count(),1);}
        if(mode==='activity-waiting'){await page.emulateMedia({reducedMotion:'reduce'});assert(await page.locator('.ba-chat-dots i').evaluateAll(nodes=>nodes.every(node=>getComputedStyle(node).animationName==='none')));await page.emulateMedia({reducedMotion:'no-preference'});}
        assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
        if(screenshots)await page.screenshot({path:join(screenshots,mode+'-'+theme+'-'+width+'.png'),fullPage:true,animations:'disabled'});
        const clear=page.getByRole('button',{name:'清理主聊天记录',exact:true});
        if(mode==='main-reply-error'){
          assert.equal(await page.locator('.ba-chat-heading-actions').getByRole('button',{name:'清理主聊天记录',exact:true}).count(),1);
          assert.equal(await clear.locator('.cmd-ui-linear svg').count(),1);
          assert.notEqual(await clear.evaluate(button=>getComputedStyle(button).backgroundColor),'rgba(0, 0, 0, 0)');
          await clear.press('Enter');
          await page.locator('.ba-chat-clear[aria-busy=true]:disabled').waitFor();
          assert.equal(await page.evaluate(()=>window.clearCalls),1);
          await page.evaluate(()=>window.finishClear());
          await page.locator('.ba-chat-clear:enabled').waitFor();
        }else assert.equal(await clear.count(),0);
      }
    }
    assert.deepEqual(errors,[]);
  }finally{await browser.close()}
});

test('Router main and side chats retry the current failed turn once without consuming the composer draft', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const html = await fixture(), browser = await chromium.launch({ headless: true, executablePath });
  const screenshots = process.env.BENCHGO_REPLY_RETRY_SCREENSHOTS;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  try {
    const page = await browser.newPage(), errors = [];
    page.setDefaultTimeout(6000);
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.request().url() === 'http://localhost/'
      ? route.fulfill({ contentType: 'text/html', body: html })
      : route.abort());
    await page.goto('http://localhost/');
    const notice = page.locator('[data-chat-key="notice:reply-failed"]');
    const retry = notice.getByRole('button', { name: '重试回复', exact: true });
    const patch = (change, paint = true) => page.evaluate(([changed, visible]) => window.patchRetry(changed, visible), [change, paint]);
    const calls = () => page.evaluate(() => window.retryCalls);
    const draft = page.getByRole('textbox', { name: '消息草稿' });
    const failure = (seq, message) => ({ seq, data: { reason: { kind: 'error', error: { message } } } });
    for (const [thread, width, dark] of [['main', 1440, false], ['local-side', 390, true]]) {
      await page.setViewportSize({ width, height: 800 });
      await page.evaluate(dark => document.body.toggleAttribute('data-ds-dark-theme', dark), dark);
      await page.evaluate(thread => window.renderRetry(thread), thread);
      await retry.waitFor();
      await notice.getByRole('button', { name: '诊断详情' }).click();
      await notice.getByText('模型响应超时', { exact: true }).waitFor();
      assert.equal(await notice.getByText('服务器历史中的旧错误').count(), 0);
      assert.equal(await draft.inputValue(), '保留这段草稿');
      await page.getByText('已添加图片附件', { exact: true }).waitFor();
      assert.equal(await page.locator('[data-role=user]').count(), 1);
      if (screenshots) await page.screenshot({ path: join(screenshots, thread + '-retry.png'), animations: 'disabled' });

      // An enabled old DOM button can outlive the Store update by one paint.
      await patch({ continuation: 12 }, false);
      await retry.click();
      assert.deepEqual(await calls(), []);
      await patch({ continuation: 11 }, false);
      await patch({ promptAllowed: false }, false);
      await retry.click();
      assert.deepEqual(await calls(), []);
      await patch({ promptAllowed: false });
      await retry.waitFor({ state: 'hidden' });
      await patch({ promptAllowed: true });
      await retry.waitFor();
      await patch({ pendingInteraction: { kind: 'question' } }, false);
      await retry.click();
      assert.deepEqual(await calls(), []);
      for (const [blocked, unblocked] of [
        [{ pendingInteraction: { kind: 'permission' } }, { pendingInteraction: null }],
        [{ inbox: { 'next-turn': [{ id: 'queued' }] } }, { inbox: {} }],
        [{ inbox: { 'next-step': [{ id: 'steering', source: { kind: 'user' } }] } }, { inbox: {} }],
        [{ blocked: { reason: '模型不可用' } }, { blocked: null }],
        [{ session: { pendingSubmissions: [{ requestId: 'pending' }] } }, { session: { pendingSubmissions: [] } }],
      ]) {
        await patch(blocked);
        await notice.locator('button:disabled').getByText('重试回复', { exact: true }).waitFor();
        await patch(unblocked);
        await notice.locator('button:enabled').getByText('重试回复', { exact: true }).waitFor();
      }
      await patch({ input: { phase: 'sending' } });
      await notice.waitFor({ state: 'hidden' });
      await patch({ input: { phase: 'plain' }, continuation: 11 });
      await retry.waitFor();

      await retry.evaluate(button => { button.click(); button.click(); });
      assert.deepEqual(await calls(), [{ sessionId: 'router-' + thread, content: [], mode: 'queue' }]);
      await notice.locator('button:disabled[aria-busy=true]').getByText('正在重试…', { exact: true }).waitFor();
      await page.evaluate(() => window.finishRetry('路由连接已断开'));
      await notice.getByRole('alert').filter({ hasText: '路由连接已断开' }).waitFor();
      await retry.click();
      assert.equal((await calls()).length, 2);
      await page.evaluate(() => window.finishRetry());
      await notice.waitFor({ state: 'hidden' });
      assert.equal(await draft.inputValue(), '保留这段草稿');
      await page.getByText('已添加图片附件', { exact: true }).waitFor();
      assert.equal(await page.locator('[data-role=user]').count(), 1);

      await patch({ continuation: 16, turnEnd: failure(16, '重试后遇到新的超时') });
      await retry.waitFor();
      await patch({
        continuation: null,
        turnEnd: { seq: 19, data: { reason: { kind: 'completed' } } },
        session: { lastAgentError: '重试后遇到新的超时' },
        history: { lastEndSeq: 16, error: '重试后遇到新的超时', failures: [{ model: { modelId: 'old-model' }, reason: '连接超时' }] },
      });
      await notice.waitFor({ state: 'hidden' });
      await patch({ history: { lastEndSeq: 19, error: null, failures: [], messages: [
        { id: 'human', role: 'user', seq: 7, text: '请检查服务是否正常' },
        { id: 'final', role: 'assistant', kind: 'final', seq: 18, text: '检查完成，服务运行正常。' },
      ] } });
      await page.getByText('检查完成，服务运行正常。', { exact: true }).waitFor();
      assert.equal(await notice.count(), 0);
      assert.equal(await page.getByRole('button', { name: '模型连接记录' }).count(), 0);
      await patch({ history: { lastEndSeq: 19, error: '交付状态结算失败' } });
      await notice.getByRole('button', { name: '诊断详情' }).click();
      await notice.getByText('交付状态结算失败', { exact: true }).waitFor();
      assert.equal(await retry.count(), 0);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    await page.evaluate(() => window.renderRetry('channel-thread', true));
    await notice.waitFor();
    assert.equal(await retry.count(), 0);
    await patch({ continuation: null, turnEnd: { seq: 19, data: { reason: { kind: 'completed' } } } });
    await notice.waitFor({ state: 'hidden' });
    await patch({ history: { lastEndSeq: 19, error: '渠道交付失败' } });
    await notice.getByRole('button', { name: '诊断详情' }).click();
    await notice.getByText('渠道交付失败', { exact: true }).waitFor();
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
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

test('Router user images use the shared gallery in echoes, the inbox, admitted turns and reopened history', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const html = await fixture(), browser = await chromium.launch({ headless: true, executablePath });
  const screenshots = process.env.BENCHGO_UPLOAD_GALLERY_SCREENSHOTS;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  try {
    const page = await browser.newPage({ reducedMotion: 'reduce' }), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(6000);
    await page.route('http://localhost/', route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.goto('http://localhost/');
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 800 });
      for (const mode of ['idle-echo', 'queue-inbox', 'idle-admitted', 'idle-history']) {
        await page.evaluate(mode => window.renderScenario(mode, 2), mode);
        const gallery = page.locator('[data-role=user] .bg-image-gallery');
        const trigger = gallery.getByRole('button', { name: '展开 2 张图片' });
        await trigger.waitFor();
        await gallery.locator('[data-state=ready]').first().waitFor();
        assert.equal(await gallery.count(), 1);
        const { right } = await gallery.boundingBox().then(({ x, width }) => ({ right: x + width }));
        assert(right <= width);
        if (screenshots && mode === 'idle-history') await page.screenshot({ path: join(screenshots, `upload-${width}.png`) });
        await trigger.click();
        const dialog = page.getByRole('dialog');
        await dialog.waitFor();
        await dialog.getByRole('button', { name: '下一张图片' }).click();
        await dialog.locator('[data-current=true][data-presented=true]').getByRole('img', { name: '截图 2.png' }).waitFor();
        await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'hidden' });
      }
      await page.evaluate(() => window.renderScenario('idle-history', 1));
      const single = page.locator('[data-role=user]');
      await single.getByRole('button', { name: '放大图片 1：截图 1.png' }).waitFor();
      assert.equal(await single.locator('.ba-chat-content').count(), 0);
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('idle accepted echoes show waiting only until their own public admission or history handoff', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const html=await fixture(),browser=await chromium.launch({headless:true,executablePath});
  const screenshots=process.env.BENCHGO_CHANNEL_QUIET_SCREENSHOTS;
  if(screenshots)await mkdir(screenshots,{recursive:true});
  try {
    const page=await browser.newPage(),errors=[];page.setDefaultTimeout(6000);page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',route=>route.request().url()==='http://localhost/'?route.fulfill({contentType:'text/html',body:html}):route.abort());await page.goto('http://localhost/');
    for(const width of [1440,390])for(const theme of ['light','dark']){
      await page.setViewportSize({width,height:800});await page.evaluate(theme=>document.body.toggleAttribute('data-ds-dark-theme',theme==='dark'),theme);
      for(const stage of ['echo','admitted','history','mixed']){
        const mode='idle-'+stage,id=await page.evaluate(mode=>window.renderScenario(mode),mode);
        await page.locator('[data-render="'+id+'"]').waitFor();
        await page.getByText('这是已发送的真实要求',{exact:true}).waitFor();
        assert.equal(await page.getByText('这是已发送的真实要求',{exact:true}).count(),1);
        const waiting=stage==='echo'||stage==='mixed';
        assert.equal(await page.locator('.ba-chat-heading [data-activity="waiting"]').count(),Number(waiting));
        assert.equal(await page.locator('.ba-quiet-chat [data-activity="waiting"]').count(),Number(waiting));
        assert.equal(await page.locator('.ba-chat-heading .ba-conversation-ready').count(),Number(!waiting));
        assert.equal(await page.getByText('等待处理',{exact:true}).count(),waiting?2:0);
        assert.equal(await page.getByText('等待会话接收',{exact:true}).count(),0);
        assert.equal(await page.locator('[data-chat-key]').count(),stage==='history'||stage==='mixed'?2:1);
        if(stage==='history')await page.getByText('正式回复保持可见',{exact:true}).waitFor();
        if(stage==='mixed')await page.getByText('这是第二条排队要求',{exact:true}).waitFor();
        assert.equal(await page.getByText(/PRIVATE/).count(),0);
        assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
        if(screenshots)await page.screenshot({path:join(screenshots,mode+'-'+theme+'-'+width+'.png'),fullPage:true,animations:'disabled'});
      }
    }
    assert.deepEqual(errors,[]);
  }finally{await browser.close()}
});
