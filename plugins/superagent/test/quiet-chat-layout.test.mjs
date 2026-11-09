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

test('Router public text stays mounted across tool and reasoning steps, completion and request boundaries', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const html = await fixture(), browser = await chromium.launch({ headless:true, executablePath });
  try {
    const page = await browser.newPage({ reducedMotion:'reduce' }), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent(html);
    for (const path of ['tool', 'reasoning', 'tool-end']) {
      await page.evaluate(path => window.renderTurn('text',path),path);
      const message = page.locator('[data-chat-key="message:reply:human"]');
      await message.getByText('先看资料。',{exact:true}).waitFor();
      await page.evaluate(() => {
        window.turnMessage = document.querySelector('[data-chat-key="message:reply:human"]');
        window.turnRemoved = false;
        window.turnObserver = new MutationObserver(records => {
          if(records.some(record => [...record.removedNodes].some(node => node === window.turnMessage || node.contains?.(window.turnMessage)))) window.turnRemoved = true;
        });
        window.turnObserver.observe(document.querySelector('.ba-chat-feed'),{childList:true,subtree:true});
      });
      const phases = path === 'tool-end' ? ['tool','completed','history'] : ['tool','reasoning','reasoning','next-text','settled','completed','history'];
      for(const phase of phases) {
        await page.evaluate(({phase,path}) => window.renderTurn(phase,path),{phase,path});
        await message.getByText('先看资料。',{exact:true}).waitFor();
        if(path !== 'tool-end' && ['next-text','settled','completed','history'].includes(phase)) await message.getByText('找到结果。',{exact:true}).waitFor();
        assert.equal(await message.count(),1);
        assert(await message.evaluate(node => node === window.turnMessage),`${path}/${phase}: the reply article stays mounted`);
        assert.equal(await page.evaluate(() => window.turnRemoved),false,`${path}/${phase}: earlier text never disappears`);
        assert.equal(await page.getByText(/PRIVATE|LATE/).count(),0);
        if(captureDir) {
          await mkdir(captureDir,{recursive:true});
          await page.screenshot({path:join(captureDir,`continuity-${path}-${phase}.png`),fullPage:true});
        }
      }
      await page.evaluate(() => window.turnObserver.disconnect());
    }
    for(const reason of ['aborted','error']) {
      await page.evaluate(() => window.renderTurn('reasoning','tool'));
      await page.getByText('先看资料。',{exact:true}).waitFor();
      await page.evaluate(reason => window.renderTurn(reason,'tool'),reason);
      await page.locator('[data-chat-key="message:reply:human"]').waitFor({state:'detached'});
      await page.evaluate(reason => window.renderTurn(reason,'published'),reason);
      await page.getByText('已正式发表。',{exact:true}).waitFor();
    }
    for(const phase of ['switch-session','next-request']) {
      await page.evaluate(() => window.renderTurn('reasoning','tool'));
      await page.getByText('先看资料。',{exact:true}).waitFor();
      await page.evaluate(phase => window.renderTurn(phase,'tool'),phase);
      await page.locator('[data-chat-key="message:reply:human"]').waitFor({state:'detached'});
      assert.equal(await page.getByText(/PRIVATE|LATE/).count(),0);
    }
    assert.deepEqual(errors,[]);
  } finally { await browser.close(); }
});

test('Router streaming message keeps its mounted identity through official settlement and delayed history', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const html = await fixture(), browser = await chromium.launch({ headless:true, executablePath });
  try {
    const page = await browser.newPage({ reducedMotion:'reduce' }), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent(html);
    for (const kind of ['text', 'assistant_reply']) {
      await page.evaluate(kind => window.renderHandoff('stream', kind), kind);
      const message = page.locator('[data-chat-key="message:reply:human"]');
      await message.getByText('同一条完整回复',{exact:true}).waitFor();
      await page.evaluate(() => {
        window.streamMessage = document.querySelector('[data-chat-key="message:reply:human"]');
        window.removedStream = false;
        window.handoffObserver = new MutationObserver(records => {
          if (records.some(record => [...record.removedNodes].some(node => node === window.streamMessage || node.contains?.(window.streamMessage)))) window.removedStream = true;
        });
        window.handoffObserver.observe(document.querySelector('.ba-chat-feed'),{childList:true,subtree:true});
      });
      for (const phase of ['settled', 'completed', 'history']) {
        await page.evaluate(({phase,kind}) => window.renderHandoff(phase,kind),{phase,kind});
        await message.getByText('同一条完整回复',{exact:true}).waitFor();
        assert.equal(await message.count(),1);
        assert(await message.evaluate(node=>node===window.streamMessage),`${kind}/${phase}: same mounted article`);
        assert.equal(await page.evaluate(()=>window.removedStream),false,`${kind}/${phase}: message never disappears`);
        assert.equal(await page.getByText('PRIVATE',{exact:true}).count(),0);
        if(captureDir) {
          await mkdir(captureDir,{recursive:true});
          await page.screenshot({path:join(captureDir,`handoff-${kind}-${phase}.png`),fullPage:true});
        }
      }
      await page.evaluate(()=>window.handoffObserver.disconnect());
    }
    for(const reason of ['aborted','error']) {
      await page.evaluate(reason=>window.renderHandoff(reason,'text'),reason);
      await page.locator('[data-chat-key="message:reply:human"]').waitFor({state:'detached'});
    }
    assert.deepEqual(errors,[],'no browser runtime errors during the handoff');
  } finally { await browser.close(); }
});

test('Router natural chat excludes execution metadata, deduplicates delivery and retains real questions', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const html = await fixture();
  const browser = await chromium.launch({ headless:true, executablePath });
  const errors = [];
  try {
    const page = await browser.newPage({ reducedMotion:'reduce' });
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://localhost/', route => route.fulfill({contentType:'text/html',body:html}));
    await page.goto('http://localhost/');
    for (const dark of [false,true]) for (const width of [1440,390]) {
      await page.setViewportSize({ width,height:900 });
      await page.evaluate(dark => document.body.toggleAttribute('data-ds-dark-theme',dark),dark);
      for (const state of ['state-error','state-reported','router-delivered','send-error']) {
        await page.evaluate(state => window.renderScenario(state),state);
        await page.getByLabel('主助手对话',{exact:true}).waitFor();
        assert.equal(await page.getByText('系统状态',{exact:true}).count(),0);
        assert.equal(await page.getByRole('button',{name:'查看执行会话',exact:true}).count(),0);
        if (state==='state-error') {
          assert.equal(await page.locator('.ba-chat-message').count(),0,'legacy system records and Worker drafts stay in task details');
        } else if(state==='send-error') {
          await page.getByRole('alert').getByText('连接中断，消息发送失败',{exact:true}).waitFor();
          await page.getByRole('button',{name:'重新核实',exact:true}).click();
          assert.equal(await page.evaluate(()=>window.refreshes),1,'failed sends can recheck the original receipt without replay');
          assert.deepEqual(await page.evaluate(()=>window.apiCalls),[]);
        } else {
          await page.getByText('调研任务暂时受阻，已有记录已保留。',{exact:true}).waitFor();
          assert.equal(await page.locator('[data-chat-key="notification:old-notification-uuid"]').count(),0);
          assert.equal(await page.getByText('调研任务暂时受阻，已有记录已保留。',{exact:true}).count(),1);
          assert.equal(await page.getByLabel('定时任务状态',{exact:true}).count(),0);
        }
        assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no page overflow');
        assert(await page.locator('.ba-chat-feed').evaluate(node=>node.scrollWidth<=node.clientWidth),'no chat overflow');
        if(captureDir) {
          await mkdir(captureDir,{recursive:true});
          await page.screenshot({path:join(captureDir,`${state}-${dark?'dark':'light'}-${width}.png`),fullPage:true});
        }
      }
    }
    await page.evaluate(()=>window.renderScenario('ticket-question'));
    await page.getByText('需要你的答复',{exact:true}).waitFor();
    assert.equal(await page.getByLabel('工单问题',{exact:true}).count(),1);
    assert.equal(await page.getByLabel('工单等待状态',{exact:true}).count(),0);
    for (const name of ['查看执行会话','刷新状态','停止工单']) assert.equal(await page.getByRole('button',{name,exact:true}).count(),0);
    await page.getByRole('radio',{name:'B',exact:true}).check();
    if(captureDir) await page.screenshot({path:join(captureDir,'question-B-before-submit.png'),fullPage:true});
    await page.getByRole('button',{name:'提交答复',exact:true}).click();
    await page.getByText('答复已保存 · 原工单继续处理',{exact:true}).waitFor();
    const answer = await page.evaluate(()=>window.apiCalls.find(([name])=>name==='ticketAnswer'));
    assert.equal(answer[1].ticketId,'ticket');
    assert.deepEqual(answer[1].answer,{selected:['B']});
    if(captureDir) await page.screenshot({path:join(captureDir,'question-without-status-panel.png'),fullPage:true});
    assert.deepEqual(errors,[]);
  } finally { await browser.close(); }
});

// Real components and host theme; only data/API responses are fixtures. No model or user data is accessed.
async function fixture() {
  const result = await build({
    stdin: { resolveDir: root, loader: 'jsx', contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { QuietChat } from './plugins/superagent/client/quiet-chat.jsx';
      import { AssistantHome } from './plugins/superagent/client/home.jsx';
      import { PartialArguments } from '@deepseek-ai/dsh-util-values';
      const root = createRoot(document.getElementById('root'));
      window.renderTurn = (phase, path) => {
        const first='先看资料。', second='找到结果。';
        const user={id:'human',role:'user',seq:8,text:'请检查',time:1793808000000};
        const stopped=['aborted','error'].includes(phase);
        const ended=stopped||['completed','history'].includes(phase);
        const end=ended?{seq:18,time:1793808001000,data:{reason:{kind:stopped?phase:'completed'}}}:undefined;
        const turn={turn:2,start:{seq:7},...(end?{end}:{}),steps:[{step:1,start:{seq:7.5},...(phase==='text'?{}:{end:{seq:11}})}]};
        const blocks=[{kind:'text',text:first},...(path==='reasoning'?[]:[{kind:'tool-call',name:'read',argsRaw:'PRIVATE_ARGS'}])];
        const legacy={nodes:[{kind:'user',messageId:'human',seq:8,source:{kind:'user'}}],turnEnds:new Map(end?[[2,18]]:[])};
        if(phase==='text') legacy.partial={turn:2,step:1,blocks:[{kind:'text',text:first}]};
        else {
          legacy.nodes.push({kind:'assistant',messageId:'first-step',seq:10,turn:2,step:1,blocks});
          if(path!=='reasoning') legacy.nodes.push({kind:'tool-result',seq:11,turn:2,step:1,content:[{type:'text',text:'PRIVATE_RESULT'}]});
          if(path!=='tool-end' && phase!=='tool') {
            turn.steps.push({step:2,start:{seq:12},...(['settled','completed','history'].includes(phase)?{end:{seq:16}}:{})});
            if(['settled','completed','history'].includes(phase)) {
              legacy.nodes.push({kind:'assistant',messageId:'second-step',seq:15,turn:2,step:2,blocks:[{kind:'text',text:second}]});
              legacy.partial={turn:2,step:1,blocks:[{kind:'text',text:'LATE_PARTIAL'}]};
            } else legacy.partial={turn:2,step:2,blocks:[{kind:'reasoning',text:'PRIVATE_REASONING'},...(phase==='next-text'?[{kind:'text',text:second}]:[])]};
          }
        }
        if(path==='published') legacy.nodes.push({kind:'tool-result',name:'assistant_reply',turn:2,args:PartialArguments.fromObject({text:'已正式发表。'}),content:[{type:'text',text:JSON.stringify({published:true,requestId:'human'})}]});
        const history={sessionId:'turn-session',activeReply:ended?null:{turn:2,requestId:'human'},messages:[user]};
        if(phase==='history') history.messages.push({id:'reply:human',requestId:'human',role:'assistant',kind:'final',text:path==='tool-end'?first:first+'\\n\\n'+second,time:1793808001000});
        const timeline={turnOrder:[2],turns:new Map([[2,turn]])};
        if(phase==='next-request') {
          const next={id:'next',role:'user',seq:21,text:'下一次问题',time:1793808002000};
          history.messages.push(next); history.activeReply={turn:3,requestId:'next'};
          legacy.nodes.push({kind:'user',messageId:'next',seq:21,source:{kind:'user'}});
          legacy.partial={turn:2,step:2,blocks:[{kind:'text',text:'LATE_OLD_REQUEST'}]};
          timeline.turnOrder.push(3);timeline.turns.set(3,{turn:3,start:{seq:20}});
        }
        const home={sessionId:phase==='switch-session'?'other-session':'turn-session',threadId:'main',assistantName:'BenchGo',history};
        root.render(<div className="ba-root ba-official-conversation" data-assistant-chat=""><div className="ba-chat-viewport"><div className="ba-chat-feed" data-assistant-scroll=""><QuietChat home={home} session={{running:!ended}} chat={{legacy,timeline}} /></div></div></div>);
      };
      window.renderHandoff = (phase, kind) => {
        const text = '同一条完整回复';
        const user = { id:'human', role:'user', seq:8, text:'请回复', time:1793808000000 };
        const reply = { id:'reply:human', requestId:'human', role:'assistant', kind:'final', text, time:1793808001000 };
        const running = ['stream','settled'].includes(phase);
        const end = running ? undefined : {seq:12,time:1793808001000,data:{reason:{kind:['aborted','error'].includes(phase)?phase:'completed'}}};
        const turn = {turn:2,start:{seq:7},...(end?{end}:{})};
        const args = PartialArguments.fromObject({text});
        const legacy = {nodes:[{kind:'user',messageId:'human',seq:8,source:{kind:'user'}}],turnEnds:new Map(end?[[2,12]]:[])};
        if(phase==='stream') {
          if(kind==='assistant_reply') legacy.runningCalls=[{name:kind,turn:2,args}];
          else legacy.partial={turn:2,blocks:[{kind:'reasoning',text:'PRIVATE'},{kind:'text',text}]};
        } else if(kind==='assistant_reply') legacy.nodes.push({kind:'tool-result',name:kind,turn:2,args,content:[{type:'text',text:JSON.stringify({published:true,requestId:'human'})}]});
        else legacy.nodes.push({kind:'assistant',messageId:'model-message',seq:10,turn:2,step:1,blocks:[{kind:'reasoning',text:'PRIVATE'},{kind:'text',text}]});
        const home = {sessionId:'handoff',threadId:'main',assistantName:'BenchGo',history:{sessionId:'handoff',activeReply:running?{turn:2,requestId:'human'}:null,messages:phase==='history'?[user,reply]:[user]}};
        root.render(<div className="ba-root ba-official-conversation" data-assistant-chat=""><div className="ba-chat-viewport"><div className="ba-chat-feed" data-assistant-scroll=""><QuietChat home={home} session={{running}} chat={{legacy,timeline:{turnOrder:[2],turns:new Map([[2,turn]])}}} /></div></div></div>);
      };
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
        window.resourceOpens = [];
        window.refreshes = 0;
        const api = async (name, args) => {
          window.apiCalls.push([name,args]);
          if (state === 'loading') return new Promise(() => {});
          if (state === 'error') throw new Error('测试连接暂不可用');
          return { tickets:[], goals:[] };
        };
        const statuses = new Map(state==='question' ? [['test-question',{pendingInteraction:{kind:'question',key:'q',sessionId:'test-question'}}]] : []);
        const home = { api, threadId:'main', assistantName:'BenchGo', sessionId:'test-'+state, sessionStatus:{ subscribe:()=>()=>{}, getSnapshot:()=>statuses },
          assistantConfig:{cardMotion:false}, onOpenResources:(...args)=>window.resourceOpens.push(args),
          onOpenExecution:async execution=>{window.executionOpens.push(execution);if(window.failExecution)throw new Error('执行会话打开失败');if(window.holdExecution)await new Promise(resolve=>window.finishExecution=resolve);},
          onRefresh:async()=>{window.refreshes++}, history:{ messages:state==='data'?messages:state==='state-reported'?[{id:'router-state',role:'assistant',kind:'final',ticketStateEventKey:'failure:1',text:'调研任务暂时受阻，已有记录已保留。',time:1793808005000}]:[],
            requests:state==='send-error'?[{threadId:'main',requestId:'failed-send',text:'请整理资料',status:'failed',error:'连接中断，消息发送失败',createdAt:1793808004000}]:[], reactions:{'message:reply':'👍'},
            notifications:state==='ticket-question'?[{eventId:'ask',type:'ticket.attention',threadId:'main',ticketId:'ticket',ticketStatus:'waiting',instructionRevision:1,currentInstructionRevision:1,currentResultVersion:0,text:'结果选哪个标记？',attention:{id:'attention',state:'waiting',instructionRevision:1,resultVersion:0,question:{question:'结果选哪个标记？',options:[{label:'A'},{label:'B'}]}}}]:state==='data'?[{eventId:'delivery',type:'ticket.result',origin:'router',publication:{action:'deliver',origin:'router'},threadId:'main',ticketId:'ticket',ticketStatus:'completed',executionSession:{available:true,ticketId:'ticket',sessionId:'official-execution',placement:'ungrouped',closed:true},text:'布局已调整，窄容器也保持侧边操作。',createdAt:1793808004000,options:['继续检查']}]:['state-error','state-reported','router-delivered'].includes(state)?[
              {eventId:'old-notification-uuid',ticketStateEventKey:'failure:1',type:'ticket.result',threadId:'main',ticketId:'ticket',title:'AI获客调研',ticketStatus:'uncertain',publication:{action:'deliver',origin:'system',systemState:{state:'continuation_wait',code:'NETWORK',stage:'execution'},text:'系统状态：执行记录已保留，等待恢复条件。'},origin:'system',text:'系统状态：执行记录已保留，等待恢复条件。',createdAt:1793808004000},
              {eventId:'worker-draft',type:'ticket.result',threadId:'main',ticketId:'ticket',publication:{action:'deliver',origin:'worker'},text:'旧执行报告：任务状态、验收记录和执行细节',createdAt:1793808004000},
              {eventId:'old-unmarked-worker',type:'ticket.result',threadId:'main',ticketId:'ticket',publication:{action:'deliver'},text:'旧版Worker原始结果',createdAt:1793808004000},
              {eventId:'schedule',type:'schedule.lifecycle',threadId:'main',origin:'system',text:'系统定时记录',schedule:{phase:'completed'},createdAt:1793808004000},
              ...(state==='state-error'?[]:['router-delivery','router-replay'].map(eventId=>({eventId,ticketStateEventKey:'failure:1',type:'ticket.result',threadId:'main',ticketId:'ticket',origin:'router',publication:{action:'deliver',origin:'router'},text:'调研任务暂时受阻，已有记录已保留。',createdAt:1793808005000})))
            ]:[] } };
        root.render(<div className="ba-root ba-official-conversation" data-assistant-chat="">
          <div className="ba-chat-viewport"><div className="ba-chat-feed" data-assistant-scroll="" tabIndex={0}>
            {!['data','waiting','question','state-error','state-reported','router-delivered','send-error','ticket-question'].includes(state) && <AssistantHome key={'home-'+state} {...home} input={{phase:'plain',draft:''}} inputActions={{captureInsertion(){},insertText(){return true},persistDraft(){}}}/>}
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
      const replyFrame=await page.locator('[data-chat-key="message:reply"] .ba-chat-content').evaluate(node=>({label:node.getAttribute('aria-label'),header:getComputedStyle(node,'::before').content,border:getComputedStyle(node).borderLeftWidth,background:getComputedStyle(node).backgroundColor,animation:getComputedStyle(node,'::before').animationName}));
      assert.equal(replyFrame.header,JSON.stringify(replyFrame.label),`${scenario}: identity uses the existing accessible assistant name`);
      assert.equal(replyFrame.border,'2px');assert.notEqual(replyFrame.background,'rgba(0, 0, 0, 0)');assert.equal(replyFrame.animation,'none');
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
    assert.equal(await page.getByRole('button',{name:'查看执行会话',exact:true}).count(),0);
    assert.equal(await page.getByLabel('工单等待状态',{exact:true}).count(),0);
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
    for(const dark of [false,true]) for(const width of [1440,390]) for(const state of ['empty','loading','error','waiting','question']) {
      await page.setViewportSize({width,height:1000});
      await page.evaluate(({dark,state})=>{document.body.toggleAttribute('data-ds-dark-theme',dark);window.renderScenario(state)},{dark,state});
      await page.locator(state==='question'?'.ba-chat-await':state==='waiting'?'.ba-chat-work':state==='error'?'.ba-home-error':state==='loading'?'.ba-home-loading':'.ba-home-starters').waitFor();
      await shot(page,`${dark?'dark':'light'}-${state}-${width}`);
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'four states fit the viewport');
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
