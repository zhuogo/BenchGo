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
    import React,{useState,useContext,useSyncExternalStore} from 'react';import{createRoot}from'react-dom/client';
    import{ExecutionSessionPanel}from'./plugins/superagent/client/execution-session.jsx';
    import{mountAssistantConversation}from'./plugins/superagent/client/conversation.jsx';
    import{executionSessionNavigation as nav}from'./plugins/superagent/client/execution-session-navigation.mjs';
    import{ConversationContent}from'./deepseek-harness/packages/client/ui-conversation/src/client/skeleton/ConversationContent.tsx';
    import css from'./plugins/superagent/client/style.css';
    const Scope=React.createContext(null),sources=new Map(),refs=new Map();let scenario='data',Official;
    function observable(value){const listeners=new Set();return{getSnapshot:()=>value,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},set:next=>{value=next;for(const fn of listeners)fn()}}}
    const blocks={storeFor(id){if(!sources.has(id))sources.set(id,observable(undefined));return sources.get(id)},set(id,value){this.storeFor(id).set(value)}};
    const ctx={effect:fn=>fn(),slots:{inject:(_name,fn)=>fn(),register:(_meta,Component)=>{Official=Component;return()=>{}}},uiConversation:{binding:()=>({activate(){}})},conversation:{blocks},sessions:{retain(id){window.retained.push(id);if(scenario==='connection-error')throw Error('offline');const ref={sessionId:id,ready:Promise.resolve(),release(){window.released.push(id)}};refs.set(id,ref);return ref}}};
    mountAssistantConversation(ctx);window.retained=[];window.released=[];window.submitted=[];
    const select=value=>selector=>selector(value),SessionProvider=({session,children})=><Scope.Provider value={session.sessionId}>{children}</Scope.Provider>;
    function InputBar({blocked}){const id=useContext(Scope),[draft,setDraft]=useState('');return<form onSubmit={e=>{e.preventDefault();if(!blocked){window.submitted.push([id,draft]);setDraft('')}}}><textarea aria-label='官方执行输入' value={draft} disabled={!!blocked} placeholder={blocked?.reason||'补充工单要求'} onChange={e=>setDraft(e.target.value)}/><button type='submit' disabled={!!blocked||!draft}>发送</button></form>}
    function Content({props,options}){const id=useContext(Scope),useComposerBlock=selector=>selector(useSyncExternalStore(blocks.storeFor(id).subscribe,blocks.storeFor(id).getSnapshot));const session={openState:'open',blank:false,running:false};
      const hooks={sessionId:id,useSession:select(session),useConversation:select({activeTargets:new Set()}),useSessions:select({byId:{[id]:{cwd:'E:/project'}}}),useInput:select({phase:'plain',draft:''}),useSessionStatus:select(new Map()),useWorkspaces:select({phase:'ready',items:[]}),useComposerBlock};
      const renderSlot=(name,owner,opts)=>name==='conversation.hero.frame'?opts.children:name==='conversation.session'?<p data-official-transcript={id}>{id==='child'?'子 Worker 原会话记录':'Worker 原会话记录'}</p>:name==='conversation.composer.bar'?<InputBar {...owner}/>:null;
      return<ConversationContent {...hooks} {...props} renderSlot={renderSlot} renderSlotChain={(_name,_owner,opts)=>opts.fallback} useFactorySlot={(name,fallback)=>name==='widthControls'?()=>null:()=>{const View=options.slots[name]||fallback;return<View {...hooks} renderSlot={renderSlot}/>}} selectWorkspace={()=>{}} t={key=>key}/>;
    }
    function RenderOfficial(){return<Official useSession={select({openState:'open',blank:false,running:false})} useConversation={select({activeTargets:new Set()})} renderFactorySlot={(_name,props,options)=><Content props={props} options={options}/>}/>}
    const entries=[{available:true,sessionId:'worker',ticketId:'ticket',role:'worker',title:'完成指定工作',promptable:true,runId:'run'},{available:true,sessionId:'child',parentSessionId:'worker',ticketId:'ticket',role:'child-worker',title:'核对结果',promptable:false,reason:'子 Worker 仅供查看，请在原工单调整要求。'}];
    const api=async()=>{if(scenario==='loading')return new Promise(()=>{});if(scenario==='error')throw Error('服务暂不可用');return{sessions:scenario==='empty'?[]:entries.map(row=>scenario==='readonly'?{...row,promptable:false,reason:'本次执行已完成，请在原工单创建关联调整单。'}:row)}};
    function App(){const execution=useSyncExternalStore(nav.subscribe,nav.getSnapshot);return<div className='ba-root' style={{height:720,maxWidth:960,margin:'auto'}}><style>{css}</style><main className='ba-main'><div hidden={!!execution} data-main><textarea aria-label='主聊草稿' defaultValue='未发送的主聊草稿'/><p>原主聊仍保留</p></div>{execution&&<ExecutionSessionPanel ctx={ctx} execution={execution} api={api} SessionProvider={SessionProvider} renderSlot={()=><RenderOfficial/>} onClose={()=>nav.close()} onOpenTicket={id=>{window.ticket=id;nav.close()}}/>}</main></div>}
    const root=createRoot(document.getElementById('root'));window.renderScenario=mode=>{scenario=mode;nav.select(entries[0]);root.render(<App key={mode}/>)};
  ` },bundle:true,write:false,outdir:join(root,'artifacts/unused-execution-ui-test'),format:'iife',jsx:'automatic',
    nodePaths:[join(root,'plugins/benchgo/node_modules'),join(root,'deepseek-harness/apps/web/node_modules')],
    alias:{react:dirname(require.resolve('react/package.json')),'react-dom':dirname(require.resolve('react-dom/package.json')),'@deepseek-ai/dsh-client-ui-primitives':join(root,'deepseek-harness/packages/client/ui-primitives/src/index.ts')},
    loader:{'.css':'text','.module.css':'local-css','.svg':'text','.woff2':'dataurl','.woff':'dataurl','.ttf':'dataurl','.png':'dataurl'},plugins:[sharedUiStyles()],define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
  const script=bundle.outputFiles.find(file=>file.path.endsWith('.js')).text,styles=bundle.outputFiles.filter(file=>file.path.endsWith('.css')).map(file=>file.text).join('\n');
  const theme=(await Promise.all(['base.css','design-platform.css','focus.css'].map(name=>readFile(join(root,'deepseek-harness/packages/client/ui-theme/src/styles',name),'utf8')))).join('\n');
  return `<!doctype html><html lang='zh-CN'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><style>${theme}${styles}body{margin:0;font:14px/1.6 system-ui;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}form{padding:16px}textarea{box-sizing:border-box;width:100%;padding:12px;min-height:100px;background:transparent;color:inherit;border:1px solid #888;border-radius:8px}button{font:inherit}p[data-official-transcript]{padding:24px}</style></head><body><div id='root'></div><script>${script.replaceAll('</script','<\\/script')}</script></body></html>`;
}

test('internal execution viewer renders four states and switches original Worker sessions without losing main draft', {skip:!executablePath&&'Chromium/Edge required'},async()=>{
 const html=await fixture(),browser=await chromium.launch({headless:true,executablePath}),screenshots=process.env.BENCHGO_EXECUTION_SCREENSHOTS;
 if(screenshots)await mkdir(screenshots,{recursive:true});
 try{const page=await browser.newPage(),errors=[];page.setDefaultTimeout(5000);page.on('pageerror',error=>errors.push(error.message));await page.setContent(html);
 for(const width of[1440,390])for(const theme of['light','dark']){await page.setViewportSize({width,height:800});await page.evaluate(theme=>document.body.toggleAttribute('data-ds-dark-theme',theme==='dark'),theme);
 for(const mode of['loading','error','empty','data','readonly']){await page.evaluate(mode=>window.renderScenario(mode),mode);
 if(mode==='loading')await page.getByText('正在读取执行会话',{exact:true}).waitFor();
 else if(mode==='error'){await page.getByText('无法读取执行会话',{exact:true}).waitFor();await page.getByRole('button',{name:'重试',exact:true}).click();}
 else if(mode==='empty')await page.getByText('执行会话暂不可用',{exact:true}).waitFor();
 else{try{await page.getByText('Worker 原会话记录',{exact:true}).waitFor()}catch(cause){throw Error(JSON.stringify({errors,body:await page.locator('body').innerText()}),{cause})}assert.equal(await page.getByRole('textbox',{name:'官方执行输入'}).isDisabled(),mode==='readonly');}
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));if(screenshots)await page.screenshot({path:join(screenshots,mode+'-'+theme+'-'+width+'.png'),fullPage:true});}
 }
 await page.evaluate(()=>window.renderScenario('data'));const input=page.getByRole('textbox',{name:'官方执行输入'});await input.waitFor();await input.fill('补充原工单要求');await page.getByRole('button',{name:'发送',exact:true}).click();assert.deepEqual(await page.evaluate(()=>window.submitted),[['worker','补充原工单要求']]);
 await page.getByRole('button',{name:'切换执行会话',exact:true}).click();await page.getByRole('option',{name:'子 Worker · 核对结果',exact:true}).click();await page.getByText('子 Worker 原会话记录',{exact:true}).waitFor();assert(await input.isDisabled());assert((await page.evaluate(()=>window.retained)).includes('child'));
 await page.getByRole('button',{name:'返回',exact:true}).click();assert.equal(await page.getByRole('textbox',{name:'主聊草稿'}).inputValue(),'未发送的主聊草稿');assert.equal(await page.locator('[data-official-transcript]').count(),0);
 await page.evaluate(()=>window.renderScenario('readonly'));await page.getByText('Worker 原会话记录',{exact:true}).waitFor();await page.getByRole('button',{name:'原工单',exact:true}).click();assert.equal(await page.evaluate(()=>window.ticket),'ticket');assert.deepEqual(errors,[]);
 }finally{await browser.close()}
});
