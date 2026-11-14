import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sharedUiStyles } from '../../benchgo/scripts/shared-ui.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url));
const { chromium } = require('playwright');
const { build } = createRequire(new URL('../../benchgo/package.json', import.meta.url))('esbuild');
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || [chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);

async function fixture() {
  const bundle = await build({ stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React from 'react';import {createRoot} from 'react-dom/client';
    import {AssistantPage,openAssistantThread} from './plugins/superagent/client/index.jsx';
    import {AssistantConversation} from './plugins/superagent/client/conversation.jsx';
    import {installIconSprite} from './deepseek-harness/packages/client/ui-theme/src/client/icon-sprite.ts';
    import css from './plugins/superagent/client/style.css';
    installIconSprite({effect:fn=>fn(),on(){}},undefined);
    const root=createRoot(document.getElementById('root'));let serial=0;
    const pending=new Promise(()=>{}),info={activePanelId:'benchgo-assistant'};
    const ctx={inject:()=>({dispose(){}}),layout:{selectPanel(){},panelInfo:{getSnapshot:()=>info,subscribe:()=>()=>{}}}},
      SessionProvider=({children})=>children;
    window.fetch=async(_url,options)=>{
      const {action}=JSON.parse(options.body);
      if(action==='ensure')return pending;
      return new Response(JSON.stringify({config:{revision:1,models:[{providerId:'opaque',modelId:'exact'}]},state:{threads:[]}}),{status:200});
    };
    window.renderOpening=thread=>{openAssistantThread(ctx,thread);root.render(<React.Fragment key={++serial}><style>{css}</style><AssistantPage ctx={ctx} SessionProvider={SessionProvider} renderSlot={()=>null}/></React.Fragment>)};
    window.renderConnection=(mode='loading')=>{
      const reference={ready:mode==='loading'?pending:mode==='error'?Promise.reject(Error('offline')):Promise.resolve(),release(){}};
      const current={...ctx,sessions:{retain:()=>reference},uiConversation:{binding:()=>({activate(){}})}};
      const renderSlot=()=> <div className='host-content'><div className='fixture-feed' aria-label='聊天记录'>{mode==='empty'?<div className='fixture-empty' role='status'><strong>开始对话</strong><p>在下方输入消息。</p></div>:Array.from({length:40},(_,i)=><p key={i}>消息 {i+1}：聊天内容可以正常滚动。</p>)}</div><div className='fixture-composer'>输入消息</div></div>;
      root.render(<React.Fragment key={++serial}><style>{css}</style><div className='ba-root'><main className='ba-main'><AssistantConversation ctx={current} sessionId='session' SessionProvider={SessionProvider} renderSlot={renderSlot}/></main></div></React.Fragment>);
    };
  ` }, bundle: true, write: false, format: 'iife', jsx: 'automatic', outdir: join(root, 'artifacts/unused-chat-opening-test'),
    nodePaths: [join(root, 'plugins/benchgo/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')],
    alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')), '@deepseek-ai/dsh-client-ui-primitives': join(root, 'deepseek-harness/packages/client/ui-primitives/src/index.ts'), '@deepseek-ai/dsh-util-workspace-path': join(root, 'deepseek-harness/packages/util/workspace-path/src/index.ts'), '@deepseek-ai/dsh-api-gateway/client': join(root,'deepseek-harness/packages/api/gateway/lib/client.node.js') },
    plugins: [{ name: 'opening-fixture', setup(build) {
      build.onLoad({filter:/superagent[\\/]client[\\/]index\.jsx$/},async({path})=>({contents:await readFile(path,'utf8')+'\nexport {openAssistantThread};',loader:'jsx'}));
      build.onLoad({filter:/superagent[\\/]client[\\/]activity-panel\.jsx$/},()=>({contents:'import React from "react";export const ActivityProvider=({children})=><>{children}</>;export const ActivityPanel=()=>null;export const ActivityTrigger=()=>null;',loader:'jsx'}));
    } },sharedUiStyles()], loader: {'.css':'text','.module.css':'local-css','.svg':'text','.woff2':'dataurl','.woff':'dataurl','.ttf':'dataurl'}, define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent' });
  const script=bundle.outputFiles.find(file=>file.path.endsWith('.js')).text;
  const styles=bundle.outputFiles.filter(file=>file.path.endsWith('.css')).map(file=>file.text).join('\n');
  return `<!doctype html><html lang='zh-CN'><head><base href='http://localhost/'><meta charset='utf-8'><style>${styles}
    :root{--dsw-alias-bg-base:#fff;--dsw-alias-label-primary:#242424;--dsw-alias-label-secondary:#797b83}body[data-dark]{--dsw-alias-bg-base:#191a1e;--dsw-alias-label-primary:#ededee;--dsw-alias-label-secondary:#a3a5af}body{margin:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:14px/1.6 Arial,sans-serif}#shell{height:100dvh;display:flex;flex-direction:column}#titlebar{height:48px;flex:none;border-bottom:1px solid #8882;padding:12px;box-sizing:border-box}#root{display:flex;flex-direction:column;flex:1;min-height:0}.host-content{display:flex;flex-direction:column;flex:1;min-height:0}.fixture-feed{flex:1;min-height:0;overflow:auto;padding:16px}.fixture-composer{flex:none;padding:24px;border-top:1px solid #8882}.fixture-empty{height:100%;display:flex;align-items:center;justify-content:center;flex-direction:column}
    </style></head><body><div id='shell'><div id='titlebar'>BenchGo</div><div id='root'></div></div><script>${script.replaceAll('</script','<\\/script')}</script></body></html>`;
}

test('main and side chat opening states center in remaining panel height and release the area to the host content', { skip: !executablePath && 'Chromium/Edge required' }, async()=>{
  const browser=await chromium.launch({headless:true,executablePath}), screenshots=process.env.BENCHGO_CHAT_OPENING_SCREENSHOTS;
  if(screenshots)await mkdir(screenshots,{recursive:true});
  try{
    const page=await browser.newPage({reducedMotion:'reduce'}),errors=[];page.setDefaultTimeout(5000);page.on('pageerror',error=>errors.push(error.message));
    await page.setContent(await fixture());
    for(const width of [1440,390])for(const dark of [false,true]){
      await page.setViewportSize({width,height:800});await page.evaluate(dark=>document.body.toggleAttribute('data-dark',dark),dark);
      const capture=async name=>{if(screenshots)await page.screenshot({path:join(screenshots,`${name}-${width}-${dark?'dark':'light'}.png`)});};
      const centered=async label=>{
        const status=page.getByRole('status',{name:label,exact:true});await status.waitFor();
        const rects=await status.evaluate(node=>{const text=node.querySelector('.bg-loading-text').getBoundingClientRect(),panel=document.querySelector('.ba-main').getBoundingClientRect();return {dx:Math.abs(text.x+text.width/2-panel.x-panel.width/2),dy:Math.abs(text.y+text.height/2-panel.y-panel.height/2)}});
        assert(rects.dx<2&&rects.dy<2,JSON.stringify({label,width,dark,...rects}));
      };
      for(const thread of ['main','side']){await page.evaluate(thread=>window.renderOpening(thread),thread);await centered(thread==='main'?'正在打开主聊天':'正在打开旁聊');await capture('opening-'+thread);}
      await page.evaluate(()=>window.renderConnection('loading'));await centered('正在连接聊天');await capture('loading');
      await page.evaluate(()=>window.renderConnection('error'));const error=page.getByRole('alert');await error.getByRole('button',{name:'重新连接'}).waitFor();
      const box=await error.boundingBox(),main=await page.locator('.ba-main').boundingBox();assert(Math.abs(box.y+box.height/2-main.y-main.height/2)<2);await capture('error');
      await page.evaluate(()=>window.renderConnection('empty'));await page.getByText('开始对话',{exact:true}).waitFor();assert.equal(await page.locator('.ba-resource-initial').count(),0);await capture('empty');
      await page.evaluate(()=>window.renderConnection('data'));await page.getByText('消息 40：聊天内容可以正常滚动。',{exact:true}).waitFor();
      assert(await page.locator('.fixture-feed').evaluate(node=>node.scrollHeight>node.clientHeight));await page.locator('.fixture-feed').evaluate(node=>node.scrollTop=node.scrollHeight);assert(await page.locator('.fixture-feed').evaluate(node=>node.scrollTop>0));
      const composer=await page.locator('.fixture-composer').boundingBox();assert(composer.y+composer.height<=801);await capture('data');
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth&&document.documentElement.scrollHeight<=innerHeight));
    }
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
