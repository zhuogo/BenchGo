import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url));
const { chromium } = require('playwright');
const { build } = createRequire(new URL('../../benchgo/package.json', import.meta.url))('esbuild');
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || [chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);

async function fixture() {
  const bundle = await build({ stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React from 'react';import {createRoot} from 'react-dom/client';
    import {channelMessageDefinition,registerChannelSessionRows} from './plugins/superagent/client/channel-session.jsx';
    import {ChatView} from './deepseek-harness/packages/client/ui-chat/src/client/chat/ChatView.tsx';
    import {ContextMessageNodeView} from './deepseek-harness/packages/client/ui-chat/src/client/chat/MessageItem.tsx';
    import {installIconSprite} from './deepseek-harness/packages/client/ui-theme/src/client/icon-sprite.ts';
    installIconSprite({effect:fn=>fn(),on:()=>{}},undefined);
    const root=createRoot(document.getElementById('root'));let serial=0;
    const source={channel:'feishu',sourceType:'direct',conversationId:'private-chat',senderId:'owner'};
    const labels={'chat.loadingHistory':'正在加载会话记录','message.contextInjection':'注入上下文'};
    const t=(key,input)=>key==='chat.loadError'?'会话记录读取失败：'+input.message:labels[key]||key;
    let SourceLabel;const disposes=[];
    registerChannelSessionRows({effect:fn=>fn(),uiConversation:{events:{register:definition=>{window.registered=definition.kind;return()=>disposes.push('definition');}}},slots:{inject:(_name,fn)=>fn(),register:(_meta,Component)=>{SourceLabel=Component;return()=>{};}}});
    window.renderScenario=(mode='data')=>{
      const nodes=new Map();
      if(mode==='data')for(const [index,direction]of ['inbound','delivery'].entries()){
        const event={type:'plugin:benchgo-plugin/channel-message',ignorable:true,seq:index+2,time:1731000000000+index,data:{mirrorKey:direction+':fixture',direction,source,text:direction==='inbound'?'飞书私聊原文':'Router 已交付结果'}};
        const identity=channelMessageDefinition.match(event),start={...identity,event,location:{kind:'session'}};
        const context={key:identity.id,id:identity.id,start,state:channelMessageDefinition.start({},start)};
        nodes.set(context.key,channelMessageDefinition.buildViewNode(context));
      }
      const state={openState:mode==='loading'?'loading':mode==='error'?'error':'open',openError:mode==='error'?Error('system event must be first'):null,running:false,hasMore:false,loadingOlder:false,pendingSubmissions:[]};
      const chat={order:[...nodes.keys()],nodes,navigation:{items:()=>[]}},conversation={views:{grouped:()=>undefined}},sessions={byId:{channel:{projectionValues:{benchgoChannelSource:source}}}};
      const select=value=>selector=>selector(value),noop=()=>{};
      const renderId=++serial; root.render(<div key={renderId} data-fixture-render={renderId} style={{height:640,display:'flex',flexDirection:'column',maxWidth:1000,margin:'auto'}}><aside aria-label='来源'><SourceLabel sessionId='channel' useSessions={select(sessions)}/></aside><ChatView sessionId='channel' useSession={select(state)} useChat={select(chat)} useConversation={select(conversation)} useSessions={select(sessions)} usePresentation={select({collapseTiming:'immediate',mode:'all'})} useProjection={()=>undefined} useInteractionIds={select([])} dispatchInteraction={noop} useContextMenu={()=>({getTriggerProps:()=>({})})} resolveFilePath={value=>value} openFile={noop} openExternalLink={noop} loadOlder={noop} loadThrough={noop} loadImage={noop} inspectCall={noop} forkAt={noop} chatScroll={{read:()=>null,save:noop}} t={t} renderSlot={(name,props)=>name==='conversation.chat.flow'?props.entries.map(entry=><ContextMessageNodeView key={entry.key} node={nodes.get(entry.key)} t={t}/>):null}/></div>);
      return serial;
    };
  ` }, bundle: true, write: false, outdir: join(root, 'artifacts/unused-channel-ui-test'), format: 'iife', jsx: 'automatic',
    nodePaths: [join(root, 'plugins/benchgo/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')],
    alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')),
      '@deepseek-ai/dsh-client-ui-primitives':join(root,'deepseek-harness/packages/client/ui-primitives/src/index.ts'),
      '@deepseek-ai/dsh-util-workspace-path':join(root,'deepseek-harness/packages/util/workspace-path/src/index.ts'),
      '@deepseek-ai/dsh-session/types':join(root,'deepseek-harness/packages/core/session/src/types.ts'),
      '@deepseek-ai/dsh-brand':join(root,'deepseek-harness/packages/util/brand/src/index.ts'),
      '@deepseek-ai/dsh-util-code-language':join(root,'deepseek-harness/packages/util/code-language/src/index.ts') },
    loader: { '.css': 'text', '.module.css': 'local-css', '.svg': 'text', '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl', '.png': 'dataurl' },
    define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  const script = bundle.outputFiles.find(file => file.path.endsWith('.js')).text;
  const styles = bundle.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n');
  return `<!doctype html><html lang='zh-CN'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><style>
    body{margin:0;font-family:Arial,sans-serif;background:#fafafa;color:#202124}:root{--dsh-composer-side-clearance:0px;--dsh-chat-content-width:800px;--dsw-alias-label-primary:#202124;--dsw-alias-label-secondary:#666;--dsw-alias-label-tertiary:#777;--dsw-alias-markdown-code-block:#f1f1f1;--dsw-radius-md:8px;--ds-font-family-code:monospace}aside{padding:16px;font-size:12px}${styles}
    </style></head><body><div id='root'></div><script>${script.replaceAll('</script', '<\\/script')}</script></body></html>`;
}

test('channel plugin record renders through original ChatView and context disclosure in four states', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const screenshots = process.env.BENCHGO_CHANNEL_SCREENSHOTS;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  try {
    const page = await browser.newPage(), errors = []; page.setDefaultTimeout(6000); page.on('pageerror', error => errors.push(error.message));
    const html = await fixture(); await page.route('**/*', route => route.request().url() === 'http://localhost/' ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
    await page.goto('http://localhost/');
    for (const width of [1440,390]) {
      await page.setViewportSize({ width, height: 800 });
      for (const mode of ['empty','loading','error','data']) {
        const renderId=await page.evaluate(mode=>window.renderScenario(mode),mode);
        await page.locator(`[data-fixture-render="${renderId}"]`).waitFor();
        await page.getByLabel('来源').getByText('feishu',{exact:true}).waitFor();
        if(mode==='loading')await page.getByText('正在加载会话记录',{exact:true}).waitFor();
        if(mode==='error')await page.getByText('会话记录读取失败：system event must be first',{exact:true}).waitFor();
        if(mode==='data'){
          await page.getByText('渠道消息',{exact:true}).waitFor();await page.getByText('渠道交付回执',{exact:true}).waitFor();
          assert.equal(await page.locator('[data-context-source]').count(),2);
          await page.getByRole('button',{name:/注入上下文.*渠道消息/}).click();
          await page.locator('[data-context-text]').getByText('飞书私聊原文',{exact:true}).waitFor();
          await page.getByRole('button',{name:/注入上下文.*渠道交付回执/}).click();
          await page.locator('[data-context-text]').getByText('Router 已交付结果',{exact:true}).waitFor();
          assert.equal(await page.locator('[data-context-form="notice"]').count(),2);
        }else assert.equal(await page.locator('[data-context-source]').count(),0);
        assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),mode+'/'+width+' overflow');
        if(screenshots)await page.screenshot({path:join(screenshots,mode+'-'+width+'.png'),fullPage:true});
      }
    }
    assert.equal(await page.evaluate(()=>window.registered),'benchgo-channel-message');assert.deepEqual(errors,[]);
  } finally { await browser.close(); }
});
