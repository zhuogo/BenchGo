import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sharedUiStyles } from '../../benchgo/scripts/shared-ui.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const webRequire = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url));
const { chromium } = webRequire('playwright');
const { build } = createRequire(new URL('../../benchgo/package.json', import.meta.url))('esbuild');
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || [chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const captureDir = process.env.BENCHGO_CHAT_SCREENSHOTS;

// Real components and host theme; only data/API responses are fixtures. No model or user data is accessed.
async function fixture() {
  const result = await build({
    stdin: { resolveDir: root, loader: 'jsx', contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { QuietChat } from './plugins/superagent/client/quiet-chat.jsx';
      import { AssistantHome } from './plugins/superagent/client/home.jsx';
      const root = createRoot(document.getElementById('root'));
      const messages = [
        { id:'short', role:'user', text:'好的', time:1793808000000 },
        { id:'reply', role:'assistant', kind:'final', text:'已经记下。接下来按计划推进。', usage:{inputTokens:120,outputTokens:32}, time:1793808001000 },
        { id:'question:c1', role:'user', kind:'question-reply', questions:[{id:'use',question:'这台服务器主要用来做什么？',header:'用途'},{id:'old',question:'旧服务器怎么处理？'},{id:'note',question:'还有补充吗？'}], answers:[{id:'use',selected:['网站','文件共享']},{id:'old',selected:[],custom:'先保留观察'},{id:'note',selected:[]}], text:'用途：网站、文件共享', time:1793808001500 },
        { id:'long', role:'user', text:'请检查暗主题下输入消息的可读性。\\n长消息也要清楚显示，工具栏不能遮住文字。'.repeat(3), time:1793808002000 },
        { id:'code', role:'assistant', kind:'final', text:'检查结果：\\n\\n~~~js\\nconst message = "BenchGo keeps your messages readable";\\nconsole.log(message);\\n~~~\\n\\n| 项目 | 结果 |\\n| --- | --- |\\n| 暗主题 | 文字和气泡清晰可辨 |\\n| 操作 | 复制、表情、用量 |', time:1793808003000 }
      ];
      window.renderScenario = (state = 'data') => {
        window.apiCalls = [];
        window.executionOpens = [];
        const api = async (name, args) => {
          window.apiCalls.push([name,args]);
          if (state === 'loading') return new Promise(() => {});
          if (state === 'error') throw new Error('测试连接暂不可用');
          return { tickets:[], goals:[] };
        };
        const statuses = new Map(state==='question' ? [['test-question',{pendingInteraction:{kind:'question',key:'q',sessionId:'test-question'}}]] : []);
        const home = { api, threadId:'main', assistantName:'BenchGo', sessionId:'test-'+state, sessionStatus:{ subscribe:()=>()=>{}, getSnapshot:()=>statuses },
          assistantConfig:{cardMotion:false}, onOpenResources(){},
          onOpenExecution:async execution=>{window.executionOpens.push(execution);if(window.failExecution)throw new Error('执行会话打开失败');if(window.holdExecution)await new Promise(resolve=>window.finishExecution=resolve);},
          onRefresh:async()=>{}, history:{ messages:state==='data'?messages:[], reactions:{'message:reply':'👍'},
            notifications:state==='data'?[{eventId:'delivery',threadId:'main',ticketId:'ticket',ticketStatus:'completed',executionSession:{available:true,ticketId:'ticket',sessionId:'official-execution',placement:'ungrouped',closed:true},text:'布局已调整，窄容器也保持侧边操作。',createdAt:1793808004000,options:['继续检查']}]:[] } };
        root.render(<div className="ba-root ba-official-conversation" data-assistant-chat="">
          <div className="ba-chat-viewport"><div className="ba-chat-feed" data-assistant-scroll="" tabIndex={0}>
            {!['data','waiting','question'].includes(state) && <AssistantHome key={'home-'+state} {...home} input={{phase:'plain',draft:''}} inputActions={{captureInsertion(){},insertText(){return true},persistDraft(){}}}/>}
            <QuietChat key={'chat-'+state} home={home} session={{running:state==='waiting'||state==='question'}} />
          </div></div>
        </div>);
      };
      window.renderScenario(location.hash.slice(1)||'data');
    ` },
    bundle: true, write: false, outdir: join(root, 'artifacts', 'unused-chat-test-output'), format: 'iife', jsx: 'automatic',
    nodePaths: [join(root, 'plugins/benchgo/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')],
    alias: {
      react: dirname(webRequire.resolve('react/package.json')), 'react-dom': dirname(webRequire.resolve('react-dom/package.json')),
      '@deepseek-ai/dsh-client-ui-primitives': join(root, 'deepseek-harness/packages/client/ui-primitives/src/index.ts'),
    },
    loader: { '.css':'text', '.module.css':'local-css', '.svg':'text', '.woff2':'dataurl', '.woff':'dataurl', '.ttf':'dataurl' },
    plugins: [sharedUiStyles()], define: {'process.env.NODE_ENV':'"production"'}, logLevel:'silent',
  });
  const themeRoot = join(root, 'deepseek-harness/packages/client/ui-theme/src/styles');
  const theme = (await Promise.all(['base.css','design-platform.css','focus.css'].map(name => readFile(join(themeRoot,name),'utf8')))).join('\n');
  const css = result.outputFiles.filter(file=>file.path.endsWith('.css')).map(file=>file.text).join('\n');
  const js = result.outputFiles.find(file=>file.path.endsWith('.js')).text.replaceAll('</script', '<\\/script');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BenchGo 消息布局回归</title><style>${theme}${css}
    *{box-sizing:border-box}body{margin:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:14px/1.6 var(--dsw-font-family)}
    #root,.ba-official-conversation{height:100vh;display:flex;flex-direction:column;min-height:0}.ba-root{--dsh-composer-side-clearance:16px}
  </style></head><body><div id="root"></div><script>${js}</script></body></html>`;
}

test('quiet chat theme, hover geometry, keyboard and touch controls in a real browser', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const html = await fixture();
  if (captureDir) { await mkdir(captureDir, { recursive:true }); await writeFile(join(captureDir,'index.html'),html); }
  const browser = await chromium.launch({ headless:true, executablePath });
  const errors=[];
  const shot = async (page,name) => { if(captureDir) await page.screenshot({path:join(captureDir,name+'.png'),fullPage:true}); };
  try {
    const page = await browser.newPage({ reducedMotion:'reduce' });
    page.on('pageerror',error=>errors.push(error.message));
    await page.setContent(html);
    await page.locator('[data-chat-key="message:short"]').waitFor();
    await page.evaluate(()=>document.fonts.ready);
    const geometry = page => page.locator('.ba-chat-feed').evaluate(feed => {
      const origin=feed.getBoundingClientRect();
      const box=node=>{const r=node.getBoundingClientRect();return {left:r.left-origin.left,top:r.top-origin.top+feed.scrollTop,width:r.width,height:r.height}};
      return {scrollHeight:feed.scrollHeight,rows:[...feed.querySelectorAll('.ba-chat-message')].map(node=>({key:node.dataset.chatKey,message:box(node),body:box(node.querySelector('.ba-chat-body')),toolbar:box(node.querySelector('.ba-message-toolbar'))}))};
    });
    for(const dark of [false,true]) for(const [width,containerWidth] of [[1440,null],[768,null],[390,null],[1440,390]]) {
      await page.setViewportSize({width,height:1000});
      await page.evaluate(({dark,containerWidth})=>{
        document.body.toggleAttribute('data-ds-dark-theme',dark);
        document.querySelector('.ba-official-conversation').style.width=containerWidth?containerWidth+'px':'';
      },{dark,containerWidth});
      await page.locator('.ba-chat-feed').evaluate(node=>node.scrollTop=0);
      await page.mouse.move(1,1);
      await page.locator('.ba-chat-feed').focus();
      const scenario=`${width}${containerWidth?'-container-'+containerWidth:''}/${dark}`;
      const baseline=await geometry(page);
      for(const row of await page.locator('.ba-chat-message').all()) {
        await row.hover();
        assert.deepEqual(await geometry(page),baseline,`${scenario}: hovering any message must leave all message positions and scroll height unchanged`);
        assert.equal(await row.locator('.ba-message-toolbar').evaluate(node=>getComputedStyle(node).opacity),'1','hover reveals side tools');
        await page.mouse.move(width-1,999);
        assert.deepEqual(await geometry(page),baseline,`${scenario}: leaving a message must not collapse or move a toolbar row`);
      }
      const short=page.locator('[data-chat-key="message:short"]');
      await short.hover();
      const measurements=await page.locator('.ba-chat-message').evaluateAll(nodes=>nodes.map(node=>{
        const rect=target=>{const r=target.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width}};
        const content=node.querySelector('.ba-chat-content'), toolbar=node.querySelector('.ba-message-toolbar');
        return {role:node.dataset.role,body:rect(node.querySelector('.ba-chat-body')),content:rect(content),toolbar:rect(toolbar),feed:rect(node.closest('.ba-chat-feed')),buttons:[...toolbar.querySelectorAll('button')].map(button=>rect(button).width),color:getComputedStyle(content).color,background:getComputedStyle(content).backgroundColor};
      }));
      for(const row of measurements){
        assert(row.role==='user'?row.toolbar.right<=row.body.left:row.toolbar.left>=row.body.right,`${scenario}: ${row.role} toolbar must stay on its fixed side`);
        assert(row.toolbar.top<row.content.bottom&&row.toolbar.bottom>row.content.top,`${scenario}: tools must remain beside the text, never below it`);
        assert(row.toolbar.left>=row.feed.left&&row.toolbar.right<=row.feed.right,`${scenario}: toolbar outside chat container`);
        assert(row.buttons.every(size=>size>=32),`${scenario}: toolbar buttons must not shrink`);
        if(row.role==='user') {
          const luminance=color=>{const rgb=color.match(/[\d.]+/g).slice(0,3).map(Number).map(x=>x/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4);return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722};
          const a=luminance(row.color),b=luminance(row.background);
          assert((Math.max(a,b)+.05)/(Math.min(a,b)+.05)>=4.5,`${scenario}: user text contrast`);
        }
      }
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no page overflow');
      assert(await page.locator('.ba-chat-feed').evaluate(node=>node.scrollWidth<=node.clientWidth),'no chat horizontal overflow');
      if((containerWidth||width)<=390) {
        assert.equal(await short.locator('.ba-message-time-label').evaluate(node=>getComputedStyle(node).display),'none','narrow chat uses the time icon even in a wide window');
        assert.notEqual(await short.locator('.ba-message-time-icon').evaluate(node=>getComputedStyle(node).display),'none','full timestamp remains accessible through the time icon');
        assert(await short.locator('time').getAttribute('aria-label'),'time icon has a full accessible timestamp');
      }
      const choice=page.locator('[data-chat-key="message:question:c1"]');
      assert.equal(await choice.getAttribute('data-role'),'user','answered choices sit on the user side');
      assert(await choice.getByText('用途 · 这台服务器主要用来做什么？',{exact:true}).count(),'question keeps its header');
      assert(await choice.getByText('网站、文件共享',{exact:true}).count(),'selected options are shown');
      assert(await choice.getByText('先保留观察',{exact:true}).count(),'custom answer is shown');
      assert(await choice.getByText('已跳过',{exact:true}).count(),'skipped question is explicit');
      const tone=await choice.evaluate(node=>[getComputedStyle(node.querySelector('.ba-chat-question-text')).color,getComputedStyle(node.querySelector('.ba-chat-question-answer')).color]);
      assert.notEqual(tone[0],tone[1],'question is muted relative to the answer');
      const delivery=page.locator('[data-chat-key="notification:delivery"]');
      assert.equal(await delivery.getAttribute('data-role'),'assistant','delivery is a normal assistant message');
      assert(await delivery.getByText('布局已调整，窄容器也保持侧边操作。',{exact:true}).count());
      assert(await delivery.getByRole('button',{name:'继续检查',exact:true}).count());
      assert.equal(await page.getByText('交付通知',{exact:true}).count(),0);
      assert.equal(await page.getByRole('button',{name:'标记已读',exact:true}).count(),0);
      const deliveryStyle=await delivery.evaluate(node=>{const s=getComputedStyle(node);return [s.borderTopWidth,s.borderRightWidth,s.borderBottomWidth,s.borderLeftWidth,s.backgroundColor]});
      assert.deepEqual(deliveryStyle,await page.locator('[data-chat-key="message:reply"]').evaluate(node=>{const s=getComputedStyle(node);return [s.borderTopWidth,s.borderRightWidth,s.borderBottomWidth,s.borderLeftWidth,s.backgroundColor]}),'delivery must not retain a separate card frame');
      const next=page.locator('[data-chat-key="message:reply"]');
      const nextBounds=await next.boundingBox(), shortBounds=await short.boundingBox();
      assert(nextBounds.y-(shortBounds.y+shortBounds.height)<=20,'messages must not retain the old blank toolbar row');
      await shot(page,`${dark?'dark':'light'}-${width}${containerWidth?'-container-'+containerWidth:''}`);
      const toolbarBounds=await short.locator('.ba-message-toolbar').boundingBox();
      await page.mouse.move(toolbarBounds.x+toolbarBounds.width/2,toolbarBounds.y+toolbarBounds.height/2,{steps:8});
      assert.equal(await short.locator('.ba-message-toolbar').evaluate(node=>getComputedStyle(node).opacity),'1','side tools remain reachable from the bubble');
      await short.getByRole('button',{name:'表情回应',exact:true}).click();
      const panel=page.locator('[data-action-panel]');
      await panel.waitFor();
      const bounds=await panel.boundingBox();
      assert(bounds.x>=0&&bounds.x+bounds.width<=width&&bounds.y>=0&&bounds.y+bounds.height<=1000,'popover remains in viewport');
      const triggerBounds=await short.getByRole('button',{name:'表情回应',exact:true}).boundingBox();
      assert(bounds.y>=triggerBounds.y+triggerBounds.height||bounds.y+bounds.height<=triggerBounds.y,'popover must not cover its trigger');
      if(width===390) await shot(page,`${dark?'dark':'light'}-reactions`);
      await page.keyboard.press('Escape');
      assert.equal(await short.getByRole('button',{name:'表情回应',exact:true}).evaluate(node=>node===document.activeElement),true,'Escape returns to the real trigger');
      await page.locator('.ba-chat-feed').focus();
      await page.locator('[data-chat-key="message:code"]').hover();
      if(width===390) await shot(page,`${dark?'dark':'light'}-wide-content`);
    }
    await page.locator('[data-chat-key="notification:delivery"]').getByRole('button',{name:'继续检查',exact:true}).click();
    assert.deepEqual(await page.evaluate(()=>window.apiCalls.filter(([name])=>name.startsWith('notification'))),[['notificationOption',{eventId:'delivery',threadId:'main',text:'继续检查'}]],'delivery options retain the validated reply endpoint without a read action');
    const execution=page.getByRole('button',{name:'查看执行会话',exact:true});
    await page.evaluate(()=>window.holdExecution=true);
    await execution.click();
    assert(await execution.isDisabled(),'navigation stays busy while the official session opens');
    assert.equal(await page.getByLabel('工单执行会话',{exact:true}).getAttribute('aria-busy'),'true');
    await page.evaluate(()=>{window.holdExecution=false;window.finishExecution();});
    await execution.waitFor({state:'visible'});
    await page.waitForFunction(()=>!document.querySelector('[aria-label="工单执行会话"] button').disabled);
    assert.equal(await page.evaluate(()=>window.executionOpens[0].sessionId),'official-execution');
    await page.evaluate(()=>window.failExecution=true);
    await execution.click();
    await page.getByRole('alert').filter({hasText:'执行会话打开失败'}).waitFor();
    assert(await execution.isEnabled(),'navigation failure keeps a retry entry on the same message');
    await page.evaluate(()=>window.failExecution=false);
    await execution.click();
    assert.equal(await page.getByRole('alert').filter({hasText:'执行会话打开失败'}).count(),0);
    await shot(page,'dark-delivery');
    const reply=page.locator('[data-chat-key="message:reply"]');
    await reply.getByRole('button',{name:'本条回复用量',exact:true}).focus();
    assert.equal(await reply.locator('.ba-message-toolbar').evaluate(node=>getComputedStyle(node).opacity),'1','keyboard focus reveals toolbar');
    await page.keyboard.press('Enter');
    await page.locator('[data-action-panel]').waitFor();
    await shot(page,'dark-usage');
    await page.keyboard.press('Escape');
    assert.equal(await reply.getByRole('button',{name:'本条回复用量',exact:true}).evaluate(node=>node===document.activeElement),true,'usage Escape returns to usage trigger');
    await page.locator('.ba-chat-feed').focus(); await page.mouse.move(1,1);
    assert.equal(await reply.locator('.ba-reaction-chip').evaluate(node=>getComputedStyle(node).opacity),'1','saved reaction stays visible');
    for(const state of ['empty','loading','error','waiting','question']) {
      await page.evaluate(state=>window.renderScenario(state),state);
      await page.locator(state==='question'?'.ba-chat-await':state==='waiting'?'.ba-chat-work':state==='error'?'.ba-home-error':state==='loading'?'.ba-home-loading':'.ba-home-starters').waitFor();
      await shot(page,'dark-'+state);
      if(state==='error') assert(await page.getByRole('button',{name:'重试',exact:true}).isVisible());
      if(state==='question') { assert.equal(await page.locator('.ba-loading-dots').count(),0,'an open question card replaces the busy dots'); assert(await page.getByText('在下方选项卡中作答后继续',{exact:true}).isVisible()); }
    }
    const touch=await browser.newPage({viewport:{width:390,height:1000},hasTouch:true,isMobile:true,reducedMotion:'reduce'});
    await touch.setContent(html);
    await touch.locator('.ba-message-toolbar').first().waitFor();
    const targets=await touch.locator('.ba-message-toolbar button').evaluateAll(nodes=>nodes.map(node=>({width:node.getBoundingClientRect().width,height:node.getBoundingClientRect().height,opacity:getComputedStyle(node.parentElement).opacity})));
    assert(targets.every(node=>node.width>=44&&node.height>=44&&node.opacity==='1'),'touch targets are visible and 44px');
    const touchSides=await touch.locator('.ba-chat-message').evaluateAll(nodes=>nodes.map(node=>{const body=node.querySelector('.ba-chat-body').getBoundingClientRect(),tools=node.querySelector('.ba-message-toolbar').getBoundingClientRect();return {side:node.dataset.role==='user'?tools.right<=body.left:tools.left>=body.right,inside:tools.left>=0&&tools.right<=innerWidth}}));
    assert(touchSides.every(row=>row.side&&row.inside),'touch tools also remain on the sides without overflow');
    await shot(touch,'touch-390');
    assert.deepEqual(errors,[],'no browser runtime errors');
  } finally { await browser.close(); }
});
