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
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || [chromium.executablePath(),
  'C:/Users/DraftGo/AppData/Local/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-win64/chrome-headless-shell.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);

async function fixture() {
  const bundle = await build({ stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React from 'react';import {createRoot} from 'react-dom/client';
    import {voiceMessageDefinition,registerVoiceConversationRows} from './plugins/voice/client/conversation-records.jsx';
    import {ChatView} from './deepseek-harness/packages/client/ui-chat/src/client/chat/ChatView.tsx';
    import {UserMessageNodeView} from './deepseek-harness/packages/client/ui-chat/src/client/chat/MessageItem.tsx';
    import {UserContent} from './deepseek-harness/packages/client/ui-chat/src/client/chat/UserContent.tsx';
    import {installIconSprite} from './deepseek-harness/packages/client/ui-theme/src/client/icon-sprite.ts';
    installIconSprite({effect:fn=>fn(),on:()=>{}},undefined);
    const root=createRoot(document.getElementById('root'));let serial=0,VoiceRow;
    registerVoiceConversationRows({effect:fn=>fn(),uiConversation:{events:{register:()=>()=>{}}},slots:{inject:(_name,fn)=>fn(),register:(_meta,Component)=>{VoiceRow=Component;return()=>{}}}});
    const t=(key,input)=>key==='chat.loadingHistory'?'正在加载会话记录':key==='chat.loadError'?'会话记录读取失败：'+input.message:key;
    window.renderScenario=(mode='data')=>{
      const nodes=new Map(),contexts=new Map();
      if(mode==='data'||mode==='voice-only'){
        const payloads=[{kind:'call-start',requestId:'call',startedAt:1731000000000},...(mode==='voice-only'?[]:[{kind:'user',text:'帮我检查页面'},{kind:'assistant',text:'好，我看一下。'},{kind:'handoff',userMessageId:'original-user'},{kind:'execution',text:'内部执行事实不显示'},
          {kind:'user',requestId:'greeting',text:'你好'},{kind:'assistant',requestId:'greeting',text:'你好呀。'}])];
        for(const [index,patch]of payloads.entries()){
          const event={type:'plugin:benchgo-plugin/voice-conversation',ignorable:true,seq:index+1,time:1731000000000+index,data:{callId:'call',requestId:'task',messageId:'message-'+index,...patch}};
          const identity=voiceMessageDefinition.match(event),match={...identity,event,location:{kind:'session'}},previous=contexts.get(identity.id);
          contexts.set(identity.id,{key:identity.id,id:identity.id,start:previous?.start||match,state:previous?voiceMessageDefinition.update(previous,match):voiceMessageDefinition.start({},match)});
        }
        for(const context of contexts.values()) {const node=voiceMessageDefinition.buildViewNode(context);if(node.visibility==='visible')nodes.set(node.key,node);}
        if(mode==='data')nodes.set('official-user',{key:'official-user',id:'official-user',kind:'user',target:'chat',anchorSeq:3,location:{kind:'session'},visibility:'visible',data:{seq:3,time:1731000000003,content:[{type:'text',text:'帮我检查页面'}],source:{kind:'user'}}});
      }
      const state={openState:mode==='loading'?'loading':mode==='error'?'error':'open',openError:mode==='error'?Error('连接暂不可用'):null,running:false,hasMore:false,loadingOlder:false,pendingSubmissions:[]};
      const chat={order:[...nodes.values()].sort((a,b)=>a.anchorSeq-b.anchorSeq).map(node=>node.key),nodes,navigation:{items:()=>[]}},conversation={views:{grouped:()=>undefined}};
      const select=value=>selector=>selector(value),noop=()=>{};const renderId=++serial;
      root.render(<div key={renderId} data-fixture-render={renderId} style={{height:640,display:'flex',flexDirection:'column',maxWidth:800,margin:'auto',padding:20}}><ChatView sessionId='test' useSession={select(state)} useChat={select(chat)} useConversation={select(conversation)} useSessions={select({byId:{}})} usePresentation={select({collapseTiming:'immediate',mode:'all'})} useProjection={()=>undefined} useInteractionIds={select([])} dispatchInteraction={noop} useContextMenu={()=>({getTriggerProps:()=>({})})} resolveFilePath={value=>value} openFile={noop} openExternalLink={noop} loadOlder={noop} loadThrough={noop} loadImage={noop} inspectCall={noop} forkAt={noop} chatScroll={{read:()=>null,save:noop}} t={t} renderSlot={(name,props)=>name==='conversation.chat.flow'?props.entries.map(entry=>{const node=nodes.get(entry.key);return node.kind==='benchgo-voice-message'?<VoiceRow key={entry.key} node={node}/>:<UserMessageNodeView key={entry.key} node={node} t={t} renderFactorySlot={(name,props)=><UserContent {...props} t={t} renderSlot={()=>null} renderFactorySlot={(_name,props)=><span>{props.text}</span>}/>} renderSlotChain={()=>null} loadImage={noop}/>;}):null}/></div>);return renderId;
    };
  ` }, bundle: true, write: false, outdir: join(root, 'artifacts/unused-voice-record-ui'), format: 'iife', jsx: 'automatic',
    nodePaths: [join(root, 'plugins/benchgo/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')],
    alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')),
      '@deepseek-ai/dsh-client-ui-primitives': join(root, 'deepseek-harness/packages/client/ui-primitives/src/index.ts'),
      '@deepseek-ai/dsh-util-workspace-path': join(root, 'deepseek-harness/packages/util/workspace-path/src/index.ts'),
      '@deepseek-ai/dsh-session/types': join(root, 'deepseek-harness/packages/core/session/src/types.ts'),
      '@deepseek-ai/dsh-brand': join(root, 'deepseek-harness/packages/util/brand/src/index.ts'),
      '@deepseek-ai/dsh-util-code-language': join(root, 'deepseek-harness/packages/util/code-language/src/index.ts') },
    loader: { '.css': 'text', '.module.css': 'local-css', '.svg': 'text', '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl', '.png': 'dataurl' },
    define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  const script = bundle.outputFiles.find(file => file.path.endsWith('.js')).text;
  const styles = bundle.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n');
  return `<!doctype html><html lang='zh-CN'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><style>
    body{margin:0;font-family:Arial,sans-serif;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}:root{--dsh-composer-side-clearance:0px;--dsh-chat-content-width:800px;--dsw-alias-bg-base:#fafafa;--dsw-alias-label-primary:#202124;--dsw-alias-label-secondary:#666;--dsw-alias-label-tertiary:#777;--dsw-alias-markdown-code-block:#f1f1f1;--dsw-radius-md:8px;--ds-font-family-code:monospace}:root[data-dark=true]{--dsw-alias-bg-base:#19191b;--dsw-alias-label-primary:#ededee;--dsw-alias-label-secondary:#a3a3a8}${styles}
    </style></head><body><div id='root'></div><script>${script.replaceAll('</script', '<\\/script')}</script></body></html>`;
}

test('official executor ChatView shows the handed-off user while voice-only dialogue stays hidden in four states', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const screenshots = process.env.BENCHGO_VOICE_RECORD_SCREENSHOTS;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  try {
    const page = await browser.newPage(), errors = [];
    page.setDefaultTimeout(6000); page.on('pageerror', error => errors.push(error.message));
    const html = await fixture(); await page.route('**/*', route => route.request().url() === 'http://localhost/' ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
    await page.goto('http://localhost/');
    for (const width of [1440, 390]) for (const dark of [false, true]) {
      await page.setViewportSize({ width, height: 800 }); await page.evaluate(dark => document.documentElement.dataset.dark = dark, dark);
      for (const mode of ['empty', 'loading', 'error', 'voice-only', 'data']) {
        const renderId = await page.evaluate(mode => window.renderScenario(mode), mode);
        await page.locator(`[data-fixture-render="${renderId}"]`).waitFor();
        if (mode === 'loading') await page.getByText('正在加载会话记录', { exact: true }).waitFor();
        if (mode === 'error') await page.getByText('会话记录读取失败：连接暂不可用', { exact: true }).waitFor();
        if (mode === 'data') {
          await page.getByText('帮我检查页面', { exact: true }).waitFor();
          assert.equal(await page.getByText('好，我看一下。', { exact: true }).count(), 0);
          assert.equal(await page.getByText('你好呀。', { exact: true }).count(), 0);
          assert.equal(await page.getByText('帮我检查页面', { exact: true }).count(), 1);
          assert.equal(await page.locator('[data-voice-message=user]').count(), 0);
          assert.equal(await page.locator('[data-voice-message=assistant]').count(), 0);
          assert.equal(await page.getByText('内部执行事实不显示', { exact: true }).count(), 0);
        } else assert.equal(await page.locator('[data-voice-message]').count(), 0);
        if (mode === 'data' || mode === 'voice-only') {
          await page.getByText('语音通话已开始', { exact: true }).waitFor();
          assert.equal(await page.locator('[data-voice-call-start]').count(), 1);
          assert.equal(await page.locator('[data-voice-call-start] time').getAttribute('datetime'), '2024-11-07T17:20:00.000Z');
        }
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        if (screenshots) await page.screenshot({ path: join(screenshots, mode + '-' + width + '-' + (dark ? 'dark' : 'light') + '.png'), fullPage: true });
      }
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
