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
const captureDir = process.env.BENCHGO_ACTIVITY_SCREENSHOTS;

// Actual panel, shared controls and host theme; requests stay inside this synthetic fixture.
async function fixture() {
  const result = await build({
    stdin: { resolveDir: root, loader: 'jsx', contents: `
      import React, { useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { ActivityProvider, ActivityTrigger, ActivityPanel } from './plugins/superagent/client/activity-panel.jsx';
      import { AssistantCard } from './plugins/superagent/client/card.jsx';
      import { assistantConfigSync } from './plugins/superagent/client/config-sync.mjs';
      import { configureAssistantActivity, assistantActivityStore } from './plugins/superagent/client/use-activity.jsx';
      import css from './plugins/superagent/client/style.css';
      const root = createRoot(document.getElementById('root'));
      let serial = 0;
      function App({ api, initialConfig }) {
        const [config,setConfig] = useState(initialConfig);
        window.updateConfig = config => { assistantConfigSync.accept({...config,revision:++serial},assistantConfigSync.begin());setConfig(config); };
        return <ActivityProvider><style>{css}</style><div className="ba-root">
          <main className="ba-main fixture-chat"><header><h1>主聊天</h1><ActivityTrigger api={api}/></header><p>BenchGo · 看板组件验收</p><div className="ba-assistant-section" style={{width:200}}><div className="ba-assistant-heading"><AssistantCard name="BenchGo" status="running" action="focus" onOpen={()=>{}}/></div></div><div data-composer-seat style={{position:'absolute',bottom:0,left:0,right:0,zIndex:7,background:'white',padding:12}}><textarea aria-label="发送内容" defaultValue="保留草稿"/><button type="button" aria-label="发送消息" onClick={()=>window.sentMessages=(window.sentMessages||0)+1}>发送</button></div></main>
          <ActivityPanel api={api} sessionId={window.scenarioControl.state==='stream'?'router-main':undefined} assistantConfig={config} onOpenResources={(tab,selection)=>{window.resourceCalls.push(tab);window.resourceSelections.push(selection);}} onOpenExecution={session=>window.executionCalls.push(session)}/>
        </div></ActivityProvider>;
      }
      window.renderScenario = (state='data', supplied=true) => {
        window.apiCalls=[];window.resourceCalls=[];window.resourceSelections=[];window.executionCalls=[];
        const control=window.scenarioControl={state,fail:false};
        const now=new Date(), at=minutes=>new Date(+now-minutes*60000).toISOString();
        const tasks=[
          {id:'running',title:'检查主聊天右侧面板的响应式布局与操作路径',target:'检查主聊天右侧面板的响应式布局与操作路径',acceptance:'检查桌面与窄屏的任务入口、键盘导航及四种状态。',status:'running',createdAt:at(12),updatedAt:at(1),assignments:[{state:'claimed'}]},
          {id:'waiting',title:'补充模型配置的必要信息',status:'waiting',instructionRevision:1,resultVersion:0,createdAt:at(20),updatedAt:at(2),results:[],attentions:[{id:'model-question',origin:'worker',state:'waiting',instructionRevision:1,question:{question:'请提供要使用的供应商模型ID。'}}]},
          {id:'failed',title:'重新验证离线恢复',status:'waiting',createdAt:at(30),updatedAt:at(3),results:[{summary:'连接中断，恢复后可以重新验证。'}]},
          {id:'blocked',title:'补充项目访问权限',status:'waiting',assignments:[{state:'blocked'}],createdAt:at(40),updatedAt:at(4)},
          {id:'uncertain',title:'核实交付文件的版本',status:'waiting',createdAt:at(50),updatedAt:at(5)},
          {id:'done',title:'整理今天的工作记录',status:'completed',createdAt:at(60),updatedAt:at(6),results:[{version:1,summary:'内部工作摘要',outcome:'completed',delivery:{action:'deliver',text:'已归档工作记录，保留了相关文件与说明。'}}],deliveries:[{state:'sent',payload:{type:'task.result',instructionRevision:1,resultVersion:1}}]},
          {id:'archived-waiting',title:'已归档等待任务',status:'waiting',archived:true,createdAt:at(8)},
          {id:'cleaned-waiting',title:'已整理等待任务',status:'waiting',cleanup:{id:'cleanup-receipt'},createdAt:at(9)},
          {id:'deleted-running',title:'已删除进行任务',status:'running',taskMeta:{deleted:true},createdAt:at(10)},
        ];
        const goals=[{id:'goal',objective:'持续维护 BenchGo 的一致体验',status:'active',rowVersion:7,createdAt:at(120),updatedAt:at(7)}];
        window.updateExecution = step => {
          const row=tasks[0], finished=step==='delivered', verifying=step==='verifying';
          const worker={id:'worker-main',label:'主 Worker',status:finished||verifying?'completed':step==='unknown'?'waiting':'running',activity:finished||verifying?'正在保存结果':step==='unknown'?'等待后续事件':'正在搜索网页',updatedAt:at(0)};
          const children=[
            {id:'child-search',label:'查找候选项目',status:step==='running'?'running':'completed',activity:step==='running'?'正在搜索网页':'已返回父 Worker',updatedAt:at(0)},
            {id:'child-check',label:'核对项目页面',status:step==='child-completed'?'failed':step==='unknown'?'unknown':finished||verifying?'completed':'running',activity:step==='child-completed'?'执行失败':step==='unknown'?'未读取到结束记录':finished||verifying?'已返回父 Worker':'正在读取网页',updatedAt:at(0)},
          ];
          if(step==='main-only'){children.splice(0);worker.activity='';}
          if(step==='many'){
            worker.activity='正在核对交付文件与页面状态';
            children.splice(0,children.length,...Array.from({length:32},(_,index)=>({id:'long-'+index,label:index===0?'需要核实的远端资源 '+ 'long-segment-'.repeat(18):'执行步骤 '+(index+1),status:index<24?'completed':index===24?'failed':'running',activity:index===24?'读取失败：'+ 'network-response-'.repeat(35):index<24?'已核对当前项目并返回父 Worker':'正在读取项目与检查链接',updatedAt:at(0)})));
          }
          Object.assign(row,{status:finished?'completed':step==='paused'?'waiting':'running',executionControl:step==='paused'?{paused:true}:{},instructionRevision:1,resultVersion:finished?1:0,updatedAt:at(0),
            executionSession:{available:true,sessionId:'worker-main',taskId:'running'},
            assignments:[{id:'assignment-main',instructionRevision:1,state:finished?'completed':'claimed'}],results:finished?[{instructionRevision:1,version:1,summary:'内部结果',outcome:'completed',delivery:{text:'已完成调研，来源与限制随结果交付。'}}]:[],
            deliveries:finished?[{state:'sent',payload:{type:'task.result',instructionRevision:1,resultVersion:1}}]:[],
            execution:{assignmentId:'assignment-main',runId:'run-main',sessionId:'worker-main',instructionRevision:1,phase:verifying?'verifying':'executing',updatedAt:at(0),observed:step!=='unknown',worker,children,
              childCounts:{total:children.length,running:children.filter(c=>c.status==='running').length,completed:children.filter(c=>c.status==='completed').length,failed:children.filter(c=>c.status==='failed').length},
              ...(step==='unknown'?{limitation:'历史会话尚未加载，部分执行状态无法确认。'}:{})}});
          document.dispatchEvent(new Event('benchgo:assistant-changed'));
        };
        if(state==='dynamic'){tasks.splice(1);goals.splice(0);window.updateExecution('running');}
        if(state==='interrupted'){
          tasks.splice(1);goals.splice(0);
          Object.assign(tasks[0],{status:'waiting',instructionRevision:1,resultVersion:0,
            executionSession:{available:true,sessionId:'worker-main',taskId:'running'},
            execution:{instructionRevision:1,worker:{id:'worker-main',status:'waiting',activity:'已完成 SelfGo 握手，等待后续配置'},
              uncertainty:{reasonCode:'session-interrupted',instructionRevision:1,
                reason:'原执行会话已中断，缺少可核对的完整结束记录。',recoveryBlocked:'请查看原执行记录并排除该阻塞，再继续原任务。'}}});
        }
        window.updateSummary = (text,historyTruncated=false) => {
          const previous=tasks[0].execution.summary?.history||[];
          const entry={text,generatedAt:Date.now(),watermark:previous.length+1,source:'model'};
          tasks[0].execution.summary={...entry,history:[...previous,entry],historyTruncated};
          tasks[0].execution.milestones=[{seq:1,kind:'step/end',time:at(1)},{seq:2,kind:'step/end',time:at(0)}];
          document.dispatchEvent(new Event('benchgo:assistant-changed'));
        };
        window.updateWorkerHistory = (history,historyTruncated=false) => {
          const worker=tasks[0].execution.worker;
          Object.assign(worker,{history,historyTruncated,activity:history.at(-1).activity,activitySource:history.at(-1).activitySource,status:history.at(-1).status,updatedAt:history.at(-1).time});
          document.dispatchEvent(new Event('benchgo:assistant-changed'));
        };
        window.patchExecution = (patch,taskPatch={}) => {
          Object.assign(tasks[0],taskPatch);
          Object.assign(tasks[0].execution,patch);
          document.dispatchEvent(new Event('benchgo:assistant-changed'));
        };
        window.updateUncertainty = stopping => {
          const row=tasks.find(row=>row.id==='uncertain');
          Object.assign(row,{status:'waiting',executionControl:stopping?{stopRequested:true}:{},instructionRevision:1,updatedAt:at(0),
            execution:{instructionRevision:1,stopRequestedAt:stopping?at(1):null,stopConfirmationOverdue:stopping,
              uncertainty:stopping?null:{reason:'执行回合缺少完整结束记录',attempts:3,nextCheckAt:at(-1),escalated:true},
              worker:{id:'uncertain-worker',label:'主 Worker',status:'running',activity:'停止前正在读取资料',updatedAt:at(1)}}});
          document.dispatchEvent(new Event('benchgo:assistant-changed'));
        };
        const config=state==='empty'?{}:{name:'',models:[{modelId:'provider/opaque-model@2026-11'}],cardMotion:false};
        const api=async(name,args)=>{
          window.apiCalls.push([name,args]);
          if(control.state==='loading') return new Promise(()=>{});
          if(control.state==='error'||control.fail) throw new TypeError('Failed to fetch');
          if(name==='tasks'&&control.holdRefresh) await new Promise(resolve=>{window.finishRefresh=()=>{control.holdRefresh=false;resolve();};});
          if(name==='state') return {config};
          if(name==='taskStop'){Object.assign(tasks.find(row=>row.id===args.taskId),{status:'waiting',executionControl:{stopped:true}});return {};}
          if(name==='taskResume') return control.resumeBlocked?{queued:false,code:'SESSION_STILL_LIVE',reason:'原执行仍在退出，请稍后重试。'}:{queued:true};
          if(name==='tasks') return {tasks:control.state==='empty'?[]:args.taskId?tasks.filter(row=>row.id===args.taskId):tasks.filter(row=>!!row.archived===args.archived).slice(args.offset||0,(args.offset||0)+(args.limit||1000))};
          if(name==='goalList') return {goals:control.state==='empty'?[]:goals};
          return {};
        };
        if(state==='stream') {
          tasks.forEach((row,index)=>row.mandate={source:{sessionId:index<2?'router-main':'router-other'}});
          for(let index=0;index<18;index++) tasks.push({id:'stable-'+index,title:'稳定任务'+index,target:'保留原始任务要求',status:'waiting',createdAt:at(20+index),updatedAt:at(10+index),mandate:{source:{sessionId:'router-other'}}});
          let cursor=0;window.streamRestarts=0;
          configureAssistantActivity(api,{connect(sink){window.streamSink=sink;return {start(){sink.replace({cursor,tasks});},restart(){window.streamRestarts++;if(control.streamFail){sink.carrierFailed(new TypeError('Failed to fetch'));return;}if(control.holdSnapshot){window.finishSnapshot=()=>{control.holdSnapshot=false;sink.replace({cursor,tasks});};}else sink.replace({cursor,tasks});},dispose(){}};}});
          window.activitySnapshot=()=>assistantActivityStore(api).getSnapshot();
          window.addArchivedTasks=count=>{for(let index=0;index<count;index++)tasks.push({id:'archive-'+index,title:'历史任务'+index,status:'completed',archived:true});window.streamSink.replace({cursor,tasks});};
          window.streamUpdate=()=>{window.updateExecution('running');window.streamSink.update({cursor:++cursor,entries:[{seq:cursor,taskId:'running',kind:'execution'}]});};
          window.streamGoals=()=>{goals[0].objective='持续目标已同步';window.streamSink.update({cursor:++cursor,entries:[{seq:cursor,taskId:null,kind:'goal'}]});};
        }
        root.render(<App key={++serial} api={api} initialConfig={supplied?config:undefined}/>);
      };
      window.renderScenario(location.hash.slice(1)||'data');
    ` },
    bundle:true, write:false, outdir:join(root,'artifacts','unused-activity-test-output'), format:'iife', jsx:'automatic',
    nodePaths:[join(root,'plugins/benchgo/node_modules'),join(root,'deepseek-harness/apps/web/node_modules')],
    alias:{react:dirname(webRequire.resolve('react/package.json')),'react-dom':dirname(webRequire.resolve('react-dom/package.json')),
      '@deepseek-ai/dsh-client-ui-primitives':join(root,'deepseek-harness/packages/client/ui-primitives/src/index.ts')},
    loader:{'.css':'text','.module.css':'local-css','.svg':'text','.woff2':'dataurl','.woff':'dataurl','.ttf':'dataurl'},
    plugins:[sharedUiStyles()],define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent',
  });
  const themeRoot=join(root,'deepseek-harness/packages/client/ui-theme/src/styles');
  const theme=(await Promise.all(['base.css','design-platform.css','focus.css'].map(name=>readFile(join(themeRoot,name),'utf8')))).join('\n');
  const hostCss=await readFile(join(root,'plugins/benchgo/client/style.css'),'utf8');
  let fonts=await readFile(join(root,'plugins/benchgo/client/fonts.css'),'utf8');
  const fontUrls=[...fonts.matchAll(/\.\/api\/commander-fonts\/([^"\)]+)/g)];
  const embedded=await Promise.all(fontUrls.map(async([url,name])=>[url,(await readFile(join(root,'plugins/benchgo/assets/fonts/web',name))).toString('base64')]));
  for(const [url,content] of embedded)fonts=fonts.replaceAll(url,'data:font/woff2;base64,'+content);
  const css=result.outputFiles.filter(file=>file.path.endsWith('.css')).map(file=>file.text).join('\n');
  const js=result.outputFiles.find(file=>file.path.endsWith('.js')).text.replaceAll('</script','<\\/script');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BenchGo 看板布局回归</title><style>${theme}${fonts}${hostCss}${css}
    body{margin:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:14px/1.6 var(--dsw-font-family)}
    #root{height:100vh}.fixture-chat{min-width:0;flex:1;padding:24px}.fixture-chat>header{display:flex;align-items:center;justify-content:space-between;gap:12px}.fixture-chat h1{font-size:18px;margin:0}.fixture-chat>p{color:var(--dsw-alias-label-secondary);font-size:13px}
  </style></head><body><div id="root"></div><script>${js}</script></body></html>`;
}

test('interrupted board details keep continuation in the bottom footer without repeating interruption guidance', {skip:!executablePath&&'Chromium/Edge is required'}, async()=>{
  const browser=await chromium.launch({headless:true,executablePath});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'reduce'});
    page.setDefaultTimeout(5000);
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.setContent(await fixture());
    for(const dark of [false,true])for(const width of [1440,390]){
      await page.setViewportSize({width,height:900});
      await page.evaluate(dark=>document.body.toggleAttribute('data-ds-dark-theme',dark),dark);
      await page.evaluate(()=>window.renderScenario('interrupted'));
      await page.locator('.ba-activity-trigger').click();
      const panel=page.locator('.ba-activity-panel');
      await panel.locator('[data-task-key="task:running"]').waitFor();
      assert.equal(await panel.getByText(/原执行会话已中断|缺少可核对的完整结束记录|请查看原执行记录并排除该阻塞/).count(),0,'the board list also uses actual progress rather than removed guidance');
      await panel.locator('[data-task-key="task:running"] button').click();
      const detail=panel.getByRole('region',{name:'任务详情',exact:true});
      const resume=detail.getByRole('button',{name:'继续原任务',exact:true});
      await resume.waitFor();
      assert(await resume.evaluate(node=>!!node.closest('.ba-task-dialog-footer')),'continuation uses the existing bottom action area');
      assert.equal(await detail.locator('.ba-task-dialog-body').getByRole('button',{name:'继续原任务',exact:true}).count(),0);
      assert.equal(await detail.getByText(/原执行会话已中断|缺少可核对的完整结束记录|请查看原执行记录并排除该阻塞/).count(),0);
      assert.equal(await detail.locator('[aria-label*="缺少可核对的完整结束记录"]').count(),0,'removed guidance does not remain in a tooltip');
      assert(await detail.getByRole('button',{name:'查看执行会话',exact:true}).isVisible());
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      await page.evaluate(()=>window.scenarioControl.resumeBlocked=true);
      await resume.click();
      await detail.getByRole('alert').waitFor();
      assert.match(await detail.getByRole('alert').innerText(),/原执行仍在退出/,'real continuation failures remain actionable');
      await page.evaluate(()=>window.scenarioControl.resumeBlocked=false);
      await resume.click();
      await detail.getByRole('alert').waitFor({state:'hidden'});
      assert(await page.evaluate(()=>window.apiCalls.some(([name,args])=>name==='taskResume'&&args.taskId==='running')));
      if(captureDir){await mkdir(captureDir,{recursive:true});await panel.screenshot({path:join(captureDir,`interrupted-footer-${dark?'dark':'light'}-${width}.png`)});}
    }
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('activity count matches current task rows and narrow overlays cover the complete composer', {skip:!executablePath&&'Chromium/Edge is required'}, async()=>{
  const browser=await chromium.launch({headless:true,executablePath});
  try{
    const page=await browser.newPage({viewport:{width:768,height:900},reducedMotion:'reduce'});
    page.setDefaultTimeout(5000);
    await page.setContent(await fixture());
    const trigger=page.locator('.ba-activity-trigger'), panel=page.locator('.ba-activity-panel');
    await page.waitForFunction(()=>document.querySelector('.ba-activity-count')?.textContent==='6');
    for(const width of [768,390]){
      await page.setViewportSize({width,height:900});
      await trigger.click();await panel.waitFor();
      assert.equal(await panel.locator('[data-task-key]').count(),6);
      assert.equal(await panel.locator('[role="tab"]').filter({hasText:'任务'}).locator('.ba-board-tab-count').innerText(),'6');
      assert.equal(await page.locator('.ba-main').evaluate(node=>node.inert),true,'narrow open board makes the whole conversation inert');
      const covered=await page.locator('[data-composer-seat]').evaluate(node=>{
        const box=node.getBoundingClientRect(), samples=[box.left+8,(box.left+box.right)/2,box.right-8];
        return samples.every(x=>document.elementFromPoint(x,box.bottom-8)?.closest('.ba-activity-panel,.ba-activity-backdrop'));
      });
      assert.equal(covered,true,'the complete composer surface is below the board or its backdrop');
      await page.locator('[aria-label="发送消息"]').evaluate(node=>node.focus());
      assert.equal(await page.locator('[aria-label="发送消息"]').evaluate(node=>node===document.activeElement),false,'covered send controls cannot receive keyboard focus');
      if(captureDir){await mkdir(captureDir,{recursive:true});await page.screenshot({path:join(captureDir,`overlay-composer-${width}.png`)});}
      await page.keyboard.press('Escape');await panel.waitFor({state:'hidden'});
      await page.waitForFunction(()=>!document.querySelector('.ba-main').inert&&document.activeElement===document.querySelector('.ba-activity-trigger'));
      assert.equal(await page.getByRole('textbox',{name:'发送内容'}).inputValue(),'保留草稿');
      await page.getByRole('button',{name:'发送消息',exact:true}).click();
    }
    assert.equal(await page.evaluate(()=>window.sentMessages),2,'closing restores send controls');
    await page.evaluate(()=>window.renderScenario('dynamic'));
    await page.waitForFunction(()=>document.querySelector('.ba-activity-count')?.textContent==='1');
    await trigger.click();await panel.locator('[data-task-key="task:running"] button').click();
    await page.evaluate(()=>window.updateExecution('delivered'));
    await panel.getByRole('region',{name:'任务详情',exact:true}).locator('[data-worker-status="completed"]').first().waitFor();
    assert.equal(await trigger.locator('.ba-activity-count').innerText(),'1','completion retains the trigger count');
    await panel.getByRole('region',{name:'任务详情',exact:true}).waitFor();
    await panel.getByRole('button',{name:'返回列表',exact:true}).click();
    await panel.locator('[data-task-key="task:running"]').waitFor();
    assert.equal(await panel.locator('[data-task-key]').count(),1,'completed task remains in the list after returning from detail');
    await panel.locator('h3').filter({hasText:/^已完成/}).waitFor();
    await panel.locator('[data-task-key="task:running"] .ba-board-chip[data-status="completed"]').waitFor();
    await panel.locator('[data-task-key="task:running"] button').click();
    await panel.getByRole('region',{name:'任务详情',exact:true}).waitFor();
  }finally{await browser.close();}
});

test('activity board renders honest states, keyboard navigation and responsive task actions', {skip:!executablePath&&'Chromium/Edge is required'}, async()=>{
  const html=await fixture();
  if(captureDir){await mkdir(captureDir,{recursive:true});await writeFile(join(captureDir,'index.html'),html);}
  const browser=await chromium.launch({headless:true,executablePath});
  const errors=[];
  try{
    const page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'reduce'});
    page.setDefaultTimeout(5000);
    page.on('pageerror',error=>errors.push(error.message));
    await page.setContent(html);
    const panel=page.locator('.ba-activity-panel');
    const tab=name=>panel.getByRole('tab',{name:new RegExp('^'+name)});
    const open=async()=>{await page.locator('.ba-activity-trigger').click();await panel.waitFor({state:'visible'});};
    const scenario=async(state,supplied=true)=>{await page.evaluate(({state,supplied})=>window.renderScenario(state,supplied),{state,supplied});await open();};
    const shot=async name=>{if(captureDir)await panel.screenshot({path:join(captureDir,name+'.png')});};
    const geometry=async label=>{
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),label+': no document overflow');
      const measured=await panel.evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth,left:node.getBoundingClientRect().left,right:node.getBoundingClientRect().right,viewport:innerWidth}));
      assert(measured.scroll<=measured.client&&measured.left>=0&&measured.right<=measured.viewport+1,label+': panel fits viewport');
      const targets=await panel.getByRole('tab').evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().width));
      assert(targets.every(width=>width>=72),label+': navigation remains usable');
    };
    await open();
    await panel.locator('[data-task-key="task:running"]').waitFor();
    assert(await panel.locator('.benchgo-pet-avatar img').first().evaluate(node=>node.complete&&node.naturalWidth>0),'default identity renders the brand pet');
    assert.equal(await panel.getByText('已连接',{exact:false}).count(),0,'task fetch success does not claim a live connection');
    assert.equal(await panel.getByRole('tab',{name:/审核/}).count(),1,'board exposes the existing approval view');
    assert.equal(await panel.getByRole('button',{name:'查看记录',exact:true}).count(),0,'the task itself opens details');
    const focusedTask=panel.locator('[data-task-key="task:running"] .ba-board-task-open');
    await focusedTask.focus();
    const oldButton=await focusedTask.elementHandle();
    const requestCount=await page.evaluate(()=>window.apiCalls.filter(([name])=>name==='tasks').length);
    await page.evaluate(()=>document.dispatchEvent(new Event('benchgo:assistant-changed')));
    await page.waitForFunction(count=>window.apiCalls.filter(([name])=>name==='tasks').length>count,requestCount);
    assert(await oldButton.evaluate(node=>node.isConnected&&node===document.activeElement),'background polling preserves task DOM and focus');
    await page.evaluate(()=>{window.scenarioControl.fail=true;document.dispatchEvent(new Event('benchgo:assistant-changed'));});
    await page.waitForTimeout(220);
    assert.equal(await panel.getByRole('alert').count(),0,'background transport failures stay silent');
    await panel.getByRole('button',{name:'刷新看板',exact:true}).click();
    await panel.getByRole('alert').first().waitFor();
    assert.equal(await panel.locator('[data-task-key]').count(),6,'failed refresh retains only current visible tasks');
    assert.equal(await panel.locator('[data-task-key="task:done"]').count(),1,'completed tasks remain in the current board');
    assert.equal(await panel.locator('[data-task-key="goal:goal"]').count(),0,'goals do not appear in the task board');
    assert.equal(await panel.locator('[data-task-key="task:failed"]').count(),1,'failed execution still appears through its waiting task');
    assert(await panel.getByText('已保留上次的任务记录，请重试。',{exact:false}).isVisible());
    await page.evaluate(()=>{window.scenarioControl.fail=false;});
    await panel.getByRole('button',{name:'刷新看板',exact:true}).click();
    await panel.getByRole('alert').waitFor({state:'hidden'});
    for(const dark of [false,true])for(const width of [1440,768,390]){
      await page.setViewportSize({width,height:900});
      await page.evaluate(dark=>document.body.toggleAttribute('data-ds-dark-theme',dark),dark);
      for(const name of ['任务','身份']){
        await tab(name).click();
        await geometry(`${dark}/${width}/${name}`);
        assert.equal(await tab(name).getAttribute('aria-selected'),'true');
        assert(await page.locator('[role="tabpanel"]').getAttribute('aria-labelledby'),'tabpanel has a labelled tab relationship');
        if(name==='任务'){
          assert.equal(await panel.locator('.ba-board-chip').first().evaluate(node=>getComputedStyle(node).backgroundColor),'rgba(0, 0, 0, 0)','status labels have no white background');
          assert.equal(await page.locator('.ba-card-status').evaluate(node=>getComputedStyle(node).backgroundColor),'rgba(0, 0, 0, 0)','sidebar running indicator has no white background');
          const rows=await panel.locator('.ba-board-row').evaluateAll(nodes=>nodes.map(node=>{
            const title=node.querySelector('strong'),summary=node.querySelector('.ba-board-summary');
            return {height:node.getBoundingClientRect().height,title:title.getBoundingClientRect().height,summary:summary.getBoundingClientRect().height,button:node.querySelector('button').getBoundingClientRect().height};
          }));
          assert(rows.every(row=>row.height<=66&&row.title<=20&&row.summary<=18&&row.button>=44),'each task stays on two lines with a full-size click target');
        }
        await shot(`${dark?'dark':'light'}-${width}-${{'任务':'tasks','身份':'identity'}[name]}`);
      }
    }
    assert.deepEqual(await panel.locator('.ba-board-card').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('aria-label'))),['形象','SO','目标','记忆','Identity']);
    assert.equal(await panel.getByText(/身份与概览|你的助手，你的工作方式|首选模型|持续目标|待处理|条 · 进行中/).count(),0,'identity cards replace repeated profile facts and task statistics');
    await tab('审核').focus();await page.keyboard.press('ArrowRight');
    assert.equal(await tab('身份').getAttribute('aria-selected'),'true','arrow key changes the active tab');
    await page.keyboard.press('End');assert.equal(await tab('身份').getAttribute('aria-selected'),'true');
    await page.keyboard.press('Home');assert.equal(await tab('任务').getAttribute('aria-selected'),'true');
    assert.equal(await panel.getByRole('tab').evaluateAll(nodes=>nodes.filter(node=>node.tabIndex===0).length),1,'only active tab is in the tab order');
    await page.keyboard.press('Escape');await panel.waitFor({state:'hidden'});
    assert(await page.locator('.ba-activity-trigger').evaluate(node=>node===document.activeElement),'Escape returns focus to the launcher');
    await open();
    const focusable=panel.locator('button:not(:disabled):not([tabindex="-1"])');
    await focusable.last().focus();await page.keyboard.press('Tab');
    assert(await focusable.first().evaluate(node=>node===document.activeElement),'narrow overlay traps Tab');
    await page.keyboard.press('Shift+Tab');
    assert(await focusable.last().evaluate(node=>node===document.activeElement),'narrow overlay traps Shift+Tab');
    await tab('任务').click();
    const activeHeading=panel.locator('.ba-board-section-head');
    await activeHeading.click();
    assert.equal(await activeHeading.getAttribute('aria-expanded'),'false');
    await page.keyboard.press('Tab');
    assert(await page.evaluate(()=>!['task:running','goal:goal'].includes(document.activeElement.closest('[data-task-key]')?.dataset.taskKey)),'collapsed tasks are skipped in the tab order');
    await activeHeading.click();
    await panel.locator('[data-task-key="task:running"] .ba-board-task-open').click({position:{x:4,y:4}});
    await page.getByRole('region',{name:'任务详情',exact:true}).waitFor();
    assert.equal(Array.from(await page.getByRole('region',{name:'任务详情',exact:true}).getByRole('heading',{level:2}).innerText()).length,10,'task display titles have at most ten Unicode characters');
    assert.equal(await page.getByRole('region',{name:'任务详情',exact:true}).getByRole('button',{name:'任务要求',exact:true}).count(),0,'the board only presents progress');
    assert.equal(await page.getByRole('region',{name:'任务详情',exact:true}).getByText('验收条件',{exact:true}).count(),0);
    assert.equal(await page.getByRole('region',{name:'任务详情',exact:true}).locator('.ba-task-execution').count(),1,'unobserved execution has a truthful empty progress state');
    await page.getByRole('region',{name:'任务详情',exact:true}).getByText('还没有执行记录',{exact:true}).waitFor();
    assert.equal(await page.getByRole('region',{name:'任务详情',exact:true}).locator('.ba-activity-detail-status').count(),1,'task state is beside its title');
    const actionAlignment=await page.getByRole('region',{name:'任务详情',exact:true}).locator('.ba-activity-detail-actions').evaluate(node=>({justify:getComputedStyle(node).justifyContent,footer:!!node.closest('.ba-task-dialog-footer')}));
    assert.deepEqual(actionAlignment,{justify:'flex-end',footer:true},'detail actions stay together in the fixed bottom footer');
    await page.keyboard.press('Escape');await page.getByRole('region',{name:'任务详情',exact:true}).waitFor({state:'hidden'});
    assert(await panel.isVisible(),'closing task details keeps the board open');
    await page.waitForFunction(()=>document.activeElement?.closest('[data-task-key]')?.dataset.taskKey==='task:running');
    assert(await focusedTask.evaluate(node=>node===document.activeElement),'closing details restores focus to the task');
    await focusedTask.press('Enter');
    assert.equal(await page.getByRole('region',{name:'任务详情',exact:true}).getByRole('button',{name:/停止任务|暂停任务/}).count(),0);
    await page.keyboard.press('Escape');await page.getByRole('region',{name:'任务详情',exact:true}).waitFor({state:'hidden'});
    assert.equal(await page.evaluate(()=>window.apiCalls.some(([name])=>['taskStop','taskPause'].includes(name))),false);
    assert.equal(await panel.locator('[data-task-key="task:done"]').count(),1,'completed records remain available in the board');
    assert(!await page.evaluate(()=>window.apiCalls.some(([name])=>name==='taskUpdate')),'activity polling never changes completion');
    await tab('身份').click();
    assert.equal(await panel.locator('.ba-board-identity strong').innerText(),'未命名','an empty name is a placeholder, never the product brand');
    assert.equal(await panel.getByText('provider/opaque-model@2026-11',{exact:true}).count(),0,'the identity board no longer exposes the preferred model');
    for(const dark of [false,true])for(const state of ['empty','loading','error']){
      await page.setViewportSize({width:390,height:900});
      await page.evaluate(dark=>document.body.toggleAttribute('data-ds-dark-theme',dark),dark);
      await scenario(state,false);
      for(const name of ['任务','身份']){
        await tab(name).click();
        if(state==='loading') assert(await panel.locator('[aria-busy="true"]').count()>0,'loading has an explicit pending region');
        if(name==='身份')assert.equal(await panel.locator('.ba-board-card').count(),state==='loading'?0:5,'loading waits for identity; empty and failed identity retain all five resource entrances');
        if(state==='error'){
          await panel.getByRole('alert').first().waitFor();
          assert(await panel.getByRole('button',{name:/重试/}).count()>0,'error offers a direct retry');
          assert.equal(await panel.getByText('已连接',{exact:false}).count(),0,'errors do not show a connected badge');
        }
        await geometry(`${dark}/${state}/${name}`);
        await shot(`${dark?'dark':'light'}-${state}-${{'任务':'tasks','身份':'identity'}[name]}`);
      }
      if(state==='empty')assert(await panel.locator('.benchgo-pet-avatar img').count()>0,'empty state retains identity');
      if(state==='error'){
        await page.evaluate(()=>window.scenarioControl.state='data');
        await panel.getByRole('button',{name:'刷新看板',exact:true}).click();
        await tab('任务').click();
        await panel.locator('[data-task-key="task:running"]').waitFor();
        assert.equal(await panel.getByRole('alert').count(),0,'refresh recovers data and clears the error');
      }
    }
    await tab('身份').click();
    await page.evaluate(()=>window.updateConfig({name:'小伴 · 已保存的新身份',models:[{modelId:'tenant/custom:model#v2'}],pet:{kind:'builtin',expression:'happy'}}));
    await panel.getByText('小伴 · 已保存的新身份',{exact:true}).first().waitFor();
    assert.equal(await panel.getByText('tenant/custom:model#v2',{exact:true}).count(),0,'saved model configuration does not recreate removed fields');
    assert(await panel.locator('.benchgo-pet-avatar img').first().evaluate(node=>node.complete&&node.naturalWidth>0),'updated builtin pet renders');
    await page.evaluate(()=>window.updateConfig({name:'',models:[],cardMotion:false}));
    await panel.locator('.ba-board-identity strong').filter({hasText:'未命名'}).waitFor();
    assert.equal(await panel.getByText('小伴 · 已保存的新身份',{exact:true}).count(),0,'clearing a saved name does not revive a cached name');
    for(const [label,resource] of [['形象','pet'],['SO','soul'],['目标','goals'],['记忆','memory'],['Identity','identity-document']]){
      const card=panel.getByRole('button',{name:label,exact:true});
      await card.focus();await page.keyboard.press('Enter');
      await panel.waitFor({state:'hidden'});
      assert.equal((await page.evaluate(()=>window.resourceCalls)).at(-1),resource,'each card opens its own resource through keyboard activation');
      await open();await tab('身份').click();
    }
    assert.deepEqual(errors,[],'no browser runtime errors');
  }finally{await browser.close();}
});

test('activity board updates Worker and child execution in place without declaring early completion', {skip:!executablePath&&'Chromium/Edge is required'}, async()=>{
  const html=await fixture();
  const browser=await chromium.launch({headless:true,executablePath});
  const errors=[];
  try{
    const page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'reduce'});
    page.setDefaultTimeout(5000);
    page.on('pageerror',error=>errors.push(error.message));
    await page.setContent(html);
    await page.evaluate(()=>window.renderScenario('dynamic'));
    await page.locator('.ba-activity-trigger').click();
    const panel=page.locator('.ba-activity-panel');
    const row=panel.locator('[data-task-key="task:running"]');
    await row.waitFor();
    assert.equal(await panel.locator('[data-task-key]').count(),1,'child workers never become top-level tasks');
    assert(await row.getByText(/正在搜索网页/).isVisible(),'current activity appears in the two-line list');
    assert.equal(await row.locator('.ba-board-children-count').innerText(),'子任务 0/2','list includes the count of returned children');
    for(const width of [1440,768,390]){
      await page.setViewportSize({width,height:900});
      assert(await row.locator('.ba-board-children-count').evaluate(node=>node.scrollWidth<=node.clientWidth),'running child count is never truncated');
      if(captureDir)await panel.screenshot({path:join(captureDir,`light-${width}-dynamic-list.png`)});
    }
    await row.locator('.ba-board-task-open').click();
    const detail=page.getByRole('region',{name:'任务详情',exact:true});
    await detail.waitFor();
    assert.equal(await detail.locator('[data-worker-id]').count(),3,'one Worker and its two children are visible');
    assert.equal(await detail.locator('[data-worker-status="running"]').count(),3);
    assert.equal(await detail.getByRole('progressbar').count(),0,'observed work has no estimated completion percentage');
    assert.equal(await detail.locator('.ba-execution-timeline').count(),1,'execution uses a single task line');
    assert.equal(await detail.locator('.ba-task-execution time').count(),3,'each observed node carries its own time');
    assert.equal(await detail.locator('.ba-execution-status').count(),0,'current activity replaces repeated running labels');
    assert(await detail.getByRole('img',{name:'进行',exact:true}).isVisible(),'execution phase is accessible on the title status icon');
    assert.equal(await detail.getByText('正在执行',{exact:true}).count(),0,'no standalone phase paragraph remains');
    assert.equal(await detail.locator('.ba-execution-worker-body p').count(),0,'generic tool activity is represented only by its marker and time');
    assert.equal(await detail.locator('.ba-execution-mark[data-active="true"]').count(),3,'only the three current running executions carry active marks');
    assert.equal(await detail.getByText(/正在搜索网页|正在读取网页/).count(),0);
    assert.equal(await detail.getByText(/主 Worker|子 Worker|阶段进展/).count(),0,'actions replace repeated executor and stage labels');
    assert.equal(await detail.locator('.ba-execution-mark').first().evaluate(node=>getComputedStyle(node).backgroundColor),'rgba(0, 0, 0, 0)','execution marks have no white background');
    const handle=await detail.locator('[data-worker-id="child-search"]').elementHandle();
    await page.evaluate(()=>window.updateExecution('child-completed'));
    assert(await handle.evaluate(node=>node.isConnected),'completed workers stay in the same timeline');
    await detail.locator('[data-worker-id="child-search"][data-worker-status="completed"]').waitFor();
    assert(await detail.locator('[data-worker-id="child-check"]').getByText('执行失败',{exact:true}).isVisible());
    assert.equal(await detail.getByText('已完成',{exact:true}).count(),0,'one child ending does not complete the task');
    for(const dark of [false,true])for(const width of [1440,768,390]){
      await page.setViewportSize({width,height:900});
      await page.evaluate(dark=>document.body.toggleAttribute('data-ds-dark-theme',dark),dark);
      assert(await row.locator('.ba-board-children-count').evaluate(node=>node.scrollWidth<=node.clientWidth),'child count remains fully visible on the compact row');
      assert(await detail.evaluate(node=>node.scrollWidth<=node.clientWidth),'execution tree fits the task dialog');
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'execution tree never widens the document');
      if(captureDir)await page.screenshot({path:join(captureDir,`${dark?'dark':'light'}-${width}-execution.png`)});
    }
    await page.evaluate(()=>{window.scenarioControl.fail=true;document.dispatchEvent(new Event('benchgo:assistant-changed'));});
    await page.waitForTimeout(220);
    assert.equal(await detail.getByText('动态更新暂不可用，以下保留上次记录。',{exact:true}).count(),0,'background transport failure keeps the detail quiet');
    assert.equal(await detail.locator('[data-worker-id]').count(),3,'refresh errors keep observed children with a stale-state notice');
    await page.evaluate(()=>{window.scenarioControl.fail=false;window.updateExecution('verifying');});
    await detail.getByText('动态更新暂不可用，以下保留上次记录。',{exact:true}).waitFor({state:'hidden'});
    await row.getByText('执行已结束',{exact:true}).waitFor({state:'attached'});
    assert.equal(await detail.locator('[data-worker-status="completed"]').count(),3);
    assert.equal(await detail.getByText('正在保存结果',{exact:true}).count(),0,'completed Worker records override stale session activity');
    if(captureDir)await page.screenshot({path:join(captureDir,'verifying-detail.png')});
    await page.evaluate(()=>window.updateExecution('delivered'));
    await detail.getByRole('img',{name:'完成',exact:true}).waitFor();
    assert(await detail.getByText('内部结果',{exact:true}).isVisible());
    await row.waitFor({state:'attached'});
    assert.equal(await row.locator('.ba-board-chip').innerText(),'完成','completed task remains in its board group');
    assert(await detail.isVisible(),'closing record keeps its existing detail readable');
    assert.equal(await detail.locator('.ba-activity-detail').count(),0,'the result belongs to the unified timeline');
    assert.equal(await detail.getByRole('button',{name:'停止任务',exact:true}).count(),0);
    if(captureDir)await page.screenshot({path:join(captureDir,'delivered-detail.png')});
    await page.evaluate(()=>window.updateExecution('paused'));
    await detail.getByRole('heading',{name:'全执行记录',exact:true}).waitFor();
    await page.keyboard.press('Tab');await detail.locator('[data-worker-id="worker-main"] .ba-execution-mark').focus();
    await page.getByRole('tooltip').getByText('上次记录为运行中',{exact:true}).waitFor();
    assert.equal(await detail.locator('.ba-execution-mark[data-active="true"]').count(),0,'paused execution never animates stale running facts');
    await page.evaluate(()=>window.updateExecution('unknown'));
    await detail.locator('[data-worker-id="child-check"][data-worker-status="unknown"]').waitFor();
    assert(await detail.getByText('历史会话尚未加载，部分执行状态无法确认。',{exact:true}).isVisible());
    assert.equal(await detail.locator('[data-worker-id="worker-main"]').getAttribute('data-worker-status'),'waiting','idle worker does not become completed');
    await page.evaluate(()=>window.updateExecution('main-only'));
    await detail.locator('[data-worker-id="worker-main"] .ba-execution-mark[data-active="true"]').waitFor();
    assert.equal(await detail.getByText('等待新的执行动态',{exact:true}).count(),0,'missing activity keeps only the accessible current marker');
    assert.equal(await detail.getByRole('heading',{name:'子 Worker',exact:true}).count(),0,'no empty child Worker section remains');
    await detail.getByRole('button',{name:'前往任务管理',exact:true}).click();
    await panel.waitFor({state:'hidden'});
    assert.deepEqual(await page.evaluate(()=>window.resourceCalls),['tasks']);
    assert.deepEqual(await page.evaluate(()=>window.resourceSelections),[{taskId:'running'}],'management opens the selected task for revisions');
    assert.deepEqual(errors,[],'dynamic updates produce no browser errors');
  }finally{await browser.close();}
});

test('task details lead with real progress, retain summary history and expose icon actions with tooltips', {skip:!executablePath&&'Chromium/Edge is required'}, async()=>{
  const browser=await chromium.launch({headless:true,executablePath});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'reduce'});
    page.setDefaultTimeout(5000);
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.setContent(await fixture());
    await page.evaluate(()=>{window.renderScenario('dynamic');window.updateSummary('已读取项目说明，确认服务器使用 SSH 连接。');window.updateSummary('已连通目标服务器，正在核对磁盘与关键服务。');});
    await page.getByRole('button',{name:'展开看板',exact:true}).click();
    await page.locator('[data-task-key="task:running"] .ba-board-task-open').click();
    const detail=page.getByRole('region',{name:'任务详情',exact:true});
    await detail.getByRole('heading',{name:'全执行记录',exact:true}).waitFor();
    assert.equal(await detail.locator('.ba-task-dialog-body').evaluate(node=>node.firstElementChild.className),'ba-task-execution','progress is the first content');
    assert.equal(await detail.getByRole('button',{name:'任务要求',exact:true}).count(),0);
    assert.equal(await detail.getByText(/最近执行记录|关键工作流|完成一个执行阶段|系统状态/).count(),0,'neither duplicate timelines nor generic step labels are shown');
    assert.equal(await detail.getByText('已连通目标服务器，正在核对磁盘与关键服务。',{exact:true}).count(),1,'latest summary is not repeated in history');
    await detail.getByRole('list',{name:'执行时间线',exact:true}).getByText('已读取项目说明，确认服务器使用 SSH 连接。',{exact:true}).waitFor();
    const execution=detail.getByRole('button',{name:'查看执行会话',exact:true}), management=detail.getByRole('button',{name:'前往任务管理',exact:true});
    for(const [button,label] of [[execution,'查看执行会话'],[management,'前往任务管理']]){
      assert.equal((await button.innerText()).trim(),'','secondary actions display only icons');
      await page.keyboard.press('Tab');await button.focus();await page.getByRole('tooltip').getByText(label,{exact:true}).waitFor();
      await button.blur();
    }
    await execution.click();
    assert.deepEqual(await page.evaluate(()=>window.executionCalls),[{available:true,sessionId:'worker-main',taskId:'running'}]);
    await page.evaluate(()=>window.updateSummary('磁盘与关键服务检查完成，正在整理报告。',true));
    await detail.getByText('磁盘与关键服务检查完成，正在整理报告。',{exact:true}).waitFor();
    assert.equal(await detail.getByRole('list',{name:'执行时间线',exact:true}).getByText('已连通目标服务器，正在核对磁盘与关键服务。',{exact:true}).count(),1);
    await detail.getByRole('button',{name:'记录范围',exact:true}).click();
    await page.getByRole('tooltip').getByText(/仅保留最近的阶段进展/).waitFor();
    await page.keyboard.press('Tab');
    assert.equal(await detail.getByText('检查桌面与窄屏的任务入口、键盘导航及四种状态。',{exact:true}).count(),0,'long requirements do not enter the progress view');
    assert.deepEqual(await detail.locator('.ba-execution-timeline > li:not([data-worker-id]) p').allTextContents(),['磁盘与关键服务检查完成，正在整理报告。','已连通目标服务器，正在核对磁盘与关键服务。','已读取项目说明，确认服务器使用 SSH 连接。'],'newest progress appears first even when timestamps coincide');
    await detail.focus();await page.mouse.move(0,0);
    for(const dark of [false,true])for(const width of [1440,390]){
      await page.setViewportSize({width,height:900});await page.evaluate(dark=>document.body.toggleAttribute('data-ds-dark-theme',dark),dark);
      assert(await detail.evaluate(node=>node.scrollWidth<=node.clientWidth),'progress fits the board');
      assert((await management.boundingBox()).width>=36,'icon action remains a full touch target');
      const alignment=await detail.locator('.ba-task-inline-head').evaluate(node=>{
        const center=element=>{const box=element.getBoundingClientRect();return box.top+box.height/2;};
        return [center(node.querySelector('button')),center(node.querySelector('h2')),center(node.querySelector('.ba-activity-detail-status'))];
      });
      assert(Math.max(...alignment)-Math.min(...alignment)<1,'back icon, title and status share the same vertical center');
      if(captureDir){await mkdir(captureDir,{recursive:true});await page.screenshot({path:join(captureDir,`${dark?'dark':'light'}-${width}-progress-detail.png`)});}
    }
    await management.click();
    assert.deepEqual(await page.evaluate(()=>window.resourceSelections),[{taskId:'running'}]);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('worker updates append a retained timeline through completion and reopening', {skip:!executablePath&&'Chromium/Edge is required'}, async()=>{
  const browser=await chromium.launch({headless:true,executablePath});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'reduce'});
    page.setDefaultTimeout(5000);
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.setContent(await fixture());
    const history=[
      {seq:1,time:'2026-11-12T10:00:00.000Z',status:'running',activity:'搜索 URnetwork 注册流程',activitySource:'report'},
      {seq:2,time:'2026-11-12T10:00:01.000Z',status:'running',activity:'读取 ~/MEMORY.md，核对邮箱验证限制',activitySource:'report'},
    ];
    await page.evaluate(history=>{window.renderScenario('dynamic');window.updateWorkerHistory(history);},history);
    await page.getByRole('button',{name:'展开看板',exact:true}).click();
    await page.locator('[data-task-key="task:running"] .ba-board-task-open').click();
    const detail=page.getByRole('region',{name:'任务详情',exact:true});
    const main=detail.locator('[data-worker-id="worker-main"], [data-history-worker-id="worker-main"]');
    await detail.locator('[data-history-worker-id="worker-main"]').waitFor();
    assert.deepEqual(await main.locator('p').allTextContents(),['读取 ~/MEMORY.md，核对邮箱验证限制','搜索 URnetwork 注册流程']);
    history.push({seq:3,time:'2026-11-12T10:00:02.000Z',status:'running',activity:'验证注册页面能否正常访问',activitySource:'report'});
    await page.evaluate(history=>window.updateWorkerHistory(history),history);
    await detail.getByText('验证注册页面能否正常访问',{exact:true}).waitFor();
    assert.deepEqual(await main.locator('p').allTextContents(),['验证注册页面能否正常访问','读取 ~/MEMORY.md，核对邮箱验证限制','搜索 URnetwork 注册流程']);
    await page.evaluate(()=>window.updateSummary('验证注册页面能否正常访问'));
    assert.equal(await detail.getByText('验证注册页面能否正常访问',{exact:true}).count(),1,'matching phase summaries and current history render once');
    await page.evaluate(()=>window.updateSummary('正在执行'));
    await page.locator('[data-task-key="task:running"] .ba-board-summary').filter({hasText:'验证注册页面能否正常访问'}).waitFor({state:'attached'});
    assert.equal(await detail.getByText('正在执行',{exact:true}).count(),0,'generic phase summaries do not duplicate detailed activity');
    await page.keyboard.press('Tab');await detail.locator('[data-history-worker-id="worker-main"] p').first().focus();
    await page.getByRole('tooltip').getByText('历史动态 · 当时运行中',{exact:true}).waitFor();
    history.push({seq:4,time:'2026-11-12T10:00:03.000Z',status:'completed',activity:'本轮执行已结束'});
    await page.evaluate(history=>{window.updateExecution('delivered');window.updateWorkerHistory(history,true);},history);
    await detail.locator('[data-worker-id="worker-main"][data-worker-status="completed"]').waitFor();
    assert.deepEqual(await main.locator('p').allTextContents(),['验证注册页面能否正常访问','读取 ~/MEMORY.md，核对邮箱验证限制','搜索 URnetwork 注册流程']);
    assert.equal(await main.locator('.ba-execution-mark[data-active="true"]').count(),0);
    assert.equal(await detail.locator('[data-worker-id="worker-main"] .ba-execution-mark').getAttribute('data-status'),'completed','the last reported action changes from running to completed');
    await detail.getByRole('button',{name:'返回列表',exact:true}).click();
    await page.locator('[data-task-key="task:running"] .ba-board-task-open').click();
    await detail.locator('[data-worker-status="completed"]').first().waitFor();
    assert.equal(await main.count(),3,'reopening preserves reports without an extra generic completion row');
    for(const dark of [false,true])for(const width of [1440,390]){
      await page.setViewportSize({width,height:900});await page.evaluate(dark=>document.body.toggleAttribute('data-ds-dark-theme',dark),dark);
      assert(await detail.evaluate(node=>node.scrollWidth<=node.clientWidth),'timestamps and activity history fit the detail');
      if(captureDir){await mkdir(captureDir,{recursive:true});await page.screenshot({path:join(captureDir,`${dark?'dark':'light'}-${width}-worker-history.png`)});}
    }
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('timeline marks show real activity without generic tool prose and stop animating at settled or stale states', {skip:!executablePath&&'Chromium/Edge is required'}, async()=>{
  const browser=await chromium.launch({headless:true,executablePath});
  try{
    const page=await browser.newPage({viewport:{width:390,height:900},reducedMotion:'no-preference'});
    page.setDefaultTimeout(5000);
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.setContent(await fixture());
    const worker={id:'worker-main',status:'running',activity:'正在执行命令...',activitySource:'runtime',updatedAt:'2026-11-13T10:00:03.000Z',history:[
      {seq:1,status:'running',activity:'正在处理任务',time:'2026-11-13T10:00:00.000Z'},
      {seq:2,status:'running',activity:'正在读取文件…',time:'2026-11-13T10:00:01.000Z'},
      {seq:3,status:'running',activity:'正在执行命令。',time:'2026-11-13T10:00:03.000Z'},
    ]};
    await page.evaluate(worker=>{window.renderScenario('dynamic');window.patchExecution({worker,children:[],childCounts:{total:0},summary:{text:'正在处理任务...',history:[{text:'正在搜索网页',generatedAt:'2026-11-13T10:00:02.000Z'}]}});},worker);
    await page.getByRole('button',{name:'展开看板',exact:true}).click();
    await page.locator('[data-task-key="task:running"] .ba-board-task-open').click();
    const detail=page.getByRole('region',{name:'任务详情',exact:true});
    const marker=detail.locator('[data-worker-id="worker-main"] .ba-execution-mark');
    const active=detail.locator('.ba-execution-mark[data-active="true"]');
    const animating=()=>marker.evaluate(node=>node.getAnimations({subtree:true}).some(animation=>animation.playState==='running'));
    await detail.locator('.ba-execution-mark[data-active="true"]').waitFor();
    assert.equal(await marker.getAttribute('role'),'img');
    assert.equal(await marker.getAttribute('aria-label'),'运行中');
    assert.equal(await detail.locator('.ba-execution-worker-body p').count(),0,'generic current/history/summary prose is absent');
    assert.equal(await detail.locator('.ba-execution-timeline > li').count(),1,'generic history does not leave empty rows');
    assert.equal(await detail.locator('.ba-execution-worker-body time').count(),1);
    assert(await animating(),'the current indicator rotates when motion is allowed');
    await page.keyboard.press('Tab');await marker.focus();await page.getByRole('tooltip').getByText('运行中',{exact:true}).waitFor();
    await marker.blur();
    if(captureDir){await mkdir(captureDir,{recursive:true});await page.screenshot({path:join(captureDir,'timeline-marker-only-390.png')});}
    const history=[
      {seq:1,status:'running',activity:'正在读取文件',activitySource:'runtime',time:'2026-11-13T10:00:00.000Z'},
      {seq:2,status:'running',activity:'读取注册记录，确认验证邮箱地址',activitySource:'report',time:'2026-11-13T10:00:01.000Z'},
      {seq:3,status:'running',activity:'正在处理任务',activitySource:'runtime',time:'2026-11-13T10:00:02.000Z'},
      {seq:4,status:'running',activity:'正在核对邮箱验证限制，准备重新注册',activitySource:'report',time:'2026-11-13T10:00:03.000Z'},
    ];
    await page.evaluate(history=>window.updateWorkerHistory(history),history);
    await detail.getByText(history.at(-1).activity,{exact:true}).waitFor();
    assert.deepEqual(await detail.locator('.ba-execution-worker-body p').allTextContents(),[history.at(-1).activity,history[1].activity],'specific action prose survives the generic-text filter');
    assert.equal(await active.count(),1,'old running records do not animate');
    assert.equal(await detail.locator('[data-history-worker-id] .ba-execution-mark').getAttribute('data-status'),'history','past running activity is not invented as successful');
    await page.emulateMedia({reducedMotion:'reduce'});
    assert.equal(await active.count(),1,'reduced motion preserves the active-state meaning');
    assert.equal(await animating(),false,'reduced motion uses a stationary blue indicator');
    await page.emulateMedia({reducedMotion:'no-preference'});
    assert(await animating());
    for(const dark of [false,true])for(const width of [1440,390]){
      await page.setViewportSize({width,height:900});await page.evaluate(dark=>document.body.toggleAttribute('data-ds-dark-theme',dark),dark);
      assert(await detail.evaluate(node=>node.scrollWidth<=node.clientWidth));
      if(captureDir)await page.screenshot({path:join(captureDir,`timeline-running-${width}-${dark?'dark':'light'}.png`)});
    }
    const reported={...worker,activity:history.at(-1).activity,activitySource:'report',history};
    const activate=async()=>{
      await page.evaluate(worker=>window.patchExecution({worker,phase:'executing',observed:true},{status:'running',executionControl:{}}),reported);
      await detail.locator('.ba-execution-mark[data-active="true"]').waitFor();
    };
    for(const [patch,taskPatch] of [
      [{phase:'waiting'},{}],[{phase:'unknown'},{}],[{phase:'finished'},{}],[{phase:'preparing'},{}],
      [{observed:false},{}],[{worker:{...reported,historical:true}},{}],[{worker:{...reported,status:'waiting'}},{}],
      [{worker:{...reported,status:'unknown'}},{}],[{},{status:'waiting'}],[{},{executionControl:{paused:true}}],[{},{executionControl:{stopRequested:true}}],
    ]){
      await activate();await page.evaluate(([patch,taskPatch])=>window.patchExecution(patch,taskPatch),[patch,taskPatch]);
      await active.waitFor({state:'hidden'});
      assert.equal(await animating(),false,JSON.stringify({patch,taskPatch}));
    }
    await activate();
    await page.evaluate(()=>{window.scenarioControl.fail=true;});
    await detail.getByRole('button',{name:'刷新记录',exact:true}).click();
    await detail.getByText('动态更新暂不可用，以下保留上次记录。',{exact:true}).waitFor();
    await active.waitFor({state:'hidden'});
    assert.equal(await animating(),false,'a stale observation cannot keep spinning');
    await page.evaluate(()=>{window.scenarioControl.fail=false;});
    await detail.getByRole('button',{name:'刷新记录',exact:true}).click();
    await active.waitFor();
    await page.evaluate(worker=>window.patchExecution({worker:{...worker,status:'completed',activity:'本轮执行已结束',activitySource:'runtime',history:[...worker.history,{seq:5,status:'completed',activity:'本轮执行已结束',time:'2026-11-13T10:00:04.000Z'}]}}),reported);
    await detail.locator('[data-worker-id="worker-main"] .ba-execution-mark[data-status="completed"]').waitFor();
    assert.equal(await active.count(),0);
    assert.equal(await marker.locator('svg path').count(),1,'completed execution has a check mark');
    assert.equal(await detail.getByText(reported.activity,{exact:true}).count(),1,'completion retains the last meaningful action once');
    assert.equal(await detail.getByText('执行结束',{exact:true}).count(),0);
    if(captureDir)await page.screenshot({path:join(captureDir,'timeline-completed-390.png')});
    for(const [status,activity] of [['failed','工具调用失败，正在处理'],['cancelled','执行已停止']]){
      await page.evaluate(([worker,status,activity])=>window.patchExecution({worker:{...worker,status,activity,activitySource:'runtime'}}),[reported,status,activity]);
      await detail.locator(`[data-worker-id="worker-main"] .ba-execution-mark[data-status="${status}"]`).waitFor();
      assert.equal(await active.count(),0);assert.equal(await animating(),false);
      assert(await detail.getByText(activity,{exact:true}).isVisible(),'failure and stop facts remain readable');
    }
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('running and waiting details refresh once from the footer with icon motion and retained focus', {skip:!executablePath&&'Chromium/Edge is required'}, async()=>{
  const browser=await chromium.launch({headless:true,executablePath});
  try{
    const page=await browser.newPage({viewport:{width:390,height:900},reducedMotion:'no-preference'});
    page.setDefaultTimeout(5000);
    await page.setContent(await fixture());
    for(const id of ['running','waiting']){
      await page.evaluate(()=>window.renderScenario('data'));
      await page.getByRole('button',{name:'展开看板',exact:true}).click();
      await page.locator(`[data-task-key="task:${id}"] .ba-board-task-open`).click();
      const detail=page.getByRole('region',{name:'任务详情',exact:true});
      const refresh=detail.getByRole('button',{name:'刷新记录',exact:true});
      assert.equal(await refresh.count(),1);
      assert(await refresh.evaluate(node=>!!node.closest('.ba-task-dialog-footer')),'all task states use the fixed footer');
      assert.equal(await detail.locator('.ba-task-dialog-body').getByRole('button',{name:'刷新记录',exact:true}).count(),0);
      await page.evaluate(()=>{window.apiCalls=[];window.scenarioControl.holdRefresh=true;});
      await refresh.click();
      await page.waitForFunction(()=>document.querySelector('.ba-task-dialog-footer [aria-label="刷新记录"]')?.getAttribute('aria-busy')==='true');
      assert.equal((await refresh.innerText()).trim(),'');
      const icon=refresh.locator('.cmd-ui-icon');
      assert.equal(await icon.evaluate(node=>getComputedStyle(node).animationName),'ba-task-icon-spin');
      const first=await icon.evaluate(node=>getComputedStyle(node).transform);
      await page.waitForTimeout(100);
      assert.notEqual(await icon.evaluate(node=>getComputedStyle(node).transform),first,'the visible icon rotates');
      if(captureDir){await mkdir(captureDir,{recursive:true});await page.screenshot({path:join(captureDir,`${id}-refreshing-390.png`)});}
      await refresh.click({force:true});
      assert.deepEqual(await page.evaluate(()=>window.apiCalls.filter(([name])=>name==='tasks')), [['tasks',{taskId:id}]],'a second click never starts another request');
      assert.equal(await detail.getByText(/正在处理，请稍候|更新中/).count(),0,'refresh produces no progress paragraph');
      await page.evaluate(()=>window.finishRefresh());
      await page.waitForFunction(()=>!document.querySelector('.ba-task-dialog-footer [aria-label="刷新记录"]')?.hasAttribute('aria-busy'));
      assert.equal(await icon.evaluate(node=>getComputedStyle(node).animationName),'none');
      assert(await refresh.evaluate(node=>node===document.activeElement),'refresh preserves the action focus');
      await page.emulateMedia({reducedMotion:'reduce'});
      await refresh.click();
      assert.equal(await icon.evaluate(node=>getComputedStyle(node).animationName),'none','reduced motion is respected');
      await page.waitForFunction(()=>!document.querySelector('.ba-task-dialog-footer [aria-label="刷新记录"]')?.hasAttribute('aria-busy'));
      await page.emulateMedia({reducedMotion:'no-preference'});
    }
    await page.evaluate(()=>{window.renderScenario('dynamic');window.updateSummary('Saved result is awaiting persistence');});
    await page.getByRole('button',{name:'展开看板',exact:true}).click();
    await page.locator('[data-task-key="task:running"] .ba-board-task-open').click();
    const detail=page.getByRole('region',{name:'任务详情',exact:true});
    assert.equal(await detail.getByText('Saved result is awaiting persistence',{exact:true}).count(),0);
    assert.equal(await detail.getByText('执行结果已暂存，尚未完成正式保存。',{exact:true}).count(),1,'legacy summary history is translated without duplication');
  }finally{await browser.close();}
});

test('long activity timelines keep all worker nodes and icon actions reachable', {skip:!executablePath&&'Chromium/Edge is required'}, async()=>{
  const html=await fixture();
  const browser=await chromium.launch({headless:true,executablePath});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'reduce'});
    page.setDefaultTimeout(5000);
    await page.setContent(html);
    for(const dark of [false,true])for(const width of [1440,390]){
      await page.setViewportSize({width,height:900});
      await page.evaluate(dark=>{document.body.toggleAttribute('data-ds-dark-theme',dark);window.renderScenario('dynamic');window.updateExecution('many');},dark);
      await page.locator('.ba-activity-trigger').click();
      await page.locator('[data-task-key="task:running"] .ba-board-task-open').click();
      const detail=page.getByRole('region',{name:'任务详情',exact:true}), body=detail.locator('.ba-task-dialog-body');
      await detail.waitFor();
      assert.equal(await detail.locator('[data-worker-id]').count(),33,'all worker facts share the timeline');
      assert.equal(await detail.locator('[data-worker-status=failed]').count(),1,'failed steps are never hidden with completion history');
      assert.equal(await detail.getByRole('list',{name:'执行时间线',exact:true}).count(),1);
      const footer=detail.locator('.ba-task-dialog-footer');
      const bounds=await detail.evaluate(node=>{
        const outer=node.getBoundingClientRect();
        return {left:outer.left,right:outer.right,width:outer.width,viewport:innerWidth,children:[...node.querySelectorAll(':scope>.ba-root')].map(child=>{const r=child.getBoundingClientRect();return {left:r.left,right:r.right};})};
      });
      assert(bounds.left>=0&&bounds.right<=bounds.viewport&&bounds.width<=Math.max(380,Math.min(390,bounds.viewport)),'detail remains inside the board');
      assert(bounds.children.every(child=>child.left>=bounds.left&&child.right<=bounds.right+1),'dialog body and footer fit the outer width: '+JSON.stringify(bounds));
      const before=await footer.boundingBox();
      assert(before.y+before.height<=900,'actions fit the viewport before scrolling');
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      const expanded=await footer.boundingBox();
      await body.evaluate(node=>{node.scrollTop=node.scrollHeight;});
      const after=await footer.boundingBox();
      assert(Math.abs(expanded.y-after.y)<1&&after.y+after.height<=900,'footer stays in place as expanded history scrolls');
      assert(await detail.getByRole('button',{name:'前往任务管理',exact:true}).isVisible());
      assert.equal(await detail.getByRole('button',{name:/停止任务|暂停任务/}).count(),0);
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'long step labels and errors never widen the viewport');
      assert(await body.evaluate(node=>node.scrollWidth<=node.clientWidth),'long step summaries wrap inside the body');
      if(captureDir)await page.screenshot({path:join(captureDir,`${dark?'dark':'light'}-${width}-long-history.png`)});
      await page.keyboard.press('Escape');
      await detail.waitFor({state:'hidden'});
      await page.waitForFunction(()=>document.activeElement?.closest('[data-task-key]')?.dataset.taskKey==='task:running');

    }
  }finally{await browser.close();}
});


test('activity board keeps verification facts visible and distinguishes a stopped gate from unconfirmed executor exit', {skip:!executablePath&&'Chromium/Edge is required'}, async()=>{
  const html=await fixture();
  const browser=await chromium.launch({headless:true,executablePath});
  try{
    const page=await browser.newPage({viewport:{width:390,height:960},reducedMotion:'reduce'});
    await page.route('**/*',route=>route.request().url()==='http://localhost/'?route.fulfill({contentType:'text/html',body:html}):route.abort());
    await page.goto('http://localhost/');
    await page.getByRole('button',{name:'展开看板',exact:true}).click();
    await page.evaluate(()=>window.updateUncertainty(false));
    const row=page.locator('[data-task-key="task:uncertain"]');
    await row.getByText('执行回合缺少完整结束记录',{exact:true}).waitFor();
    assert.equal(await row.getByText(/自动核查|下次核查|已查 3 次/).count(),0,'interrupted execution adds no verification stage');
    await row.getByText('等待',{exact:true}).waitFor();
    if(captureDir)await page.screenshot({path:join(captureDir,'verification-visible-390.png'),fullPage:true});
    await page.evaluate(()=>window.updateUncertainty(true));
    await row.getByText(/后续动作已拦截，但执行端仍未确认退出/).waitFor();
    await row.getByRole('button').click();
    const detail=page.getByRole('region',{name:'任务详情',exact:true});
    await detail.getByLabel('停止前正在读取资料 · 等待执行端退出',{exact:true}).waitFor();
    assert.equal(await detail.getByRole('button',{name:'停止任务',exact:true}).count(),0);
    await detail.getByText(/后续动作已拦截，但执行端仍未确认退出/).waitFor();
    assert.equal(await page.evaluate(()=>window.apiCalls.some(([name])=>['taskStop','taskResume'].includes(name))),false);
    assert(await detail.evaluate(node=>node.scrollWidth<=node.clientWidth),'status detail fits the narrow dialog');
    if(captureDir)await page.screenshot({path:join(captureDir,'stop-unconfirmed-390.png'),fullPage:true});
  }finally{await browser.close();}
});



test('healthy board shows all tasks without scope controls and preserves list DOM, scroll and focus across incremental details', {skip:!executablePath&&'Chromium/Edge is required'}, async()=>{
  const browser=await chromium.launch({headless:true,executablePath});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'reduce'});
    await page.setContent(await fixture()); await page.evaluate(()=>window.renderScenario('stream'));
    await page.getByRole('button',{name:'展开看板',exact:true}).click();
    const panel=page.locator('.ba-activity-panel'), body=panel.locator('.ba-activity-body');
    await panel.locator('[data-task-key="task:running"]').waitFor();
    assert.equal(await panel.locator('[data-task-key]').count(),24,'current running, waiting and completed tasks are shown across true source sessions');
    assert.equal(await panel.getByRole('tab',{name:/^(本会话|全部)$/}).count(),0,'scope switch is removed');
    assert.equal(await page.evaluate(()=>window.apiCalls.filter(([name])=>name==='tasks').length),0,'opening baseline is used directly');
    await panel.locator('[data-task-key="task:stable-4"]').waitFor();
    const row=panel.locator('[data-task-key="task:stable-4"]'), button=row.getByRole('button');
    await button.scrollIntoViewIfNeeded();await button.focus();
    const before=await body.evaluate(node=>node.scrollTop), handle=await button.elementHandle();
    await page.evaluate(()=>window.streamUpdate());
    await page.waitForFunction(()=>window.apiCalls.some(([name,args])=>name==='tasks'&&args.taskId==='running'));
    assert(await handle.evaluate(node=>node.isConnected&&node===document.activeElement),'unaffected row keeps DOM and keyboard focus');
    assert.equal(await body.evaluate(node=>node.scrollTop),before,'execution facts do not reset scroll');
    await button.click();const detail=panel.getByRole('region',{name:'任务详情',exact:true});await detail.waitFor();
    assert.equal(await page.getByRole('dialog').count(),0,'task details are not a modal');
    await detail.getByRole('button',{name:'返回列表',exact:true}).click();
    assert(await handle.evaluate(node=>node.isConnected&&node===document.activeElement),'return restores the original DOM focus');
    assert.equal(await body.evaluate(node=>node.scrollTop),before);
    await page.evaluate(()=>window.streamGoals());
    await page.waitForFunction(()=>window.apiCalls.some(([name])=>name==='goalList'));
    assert.equal(await panel.locator('[data-task-key="goal:goal"]').count(),0,'goal refresh never adds a non-task row to the board');
    await page.waitForTimeout(2200);
    assert.equal(await page.evaluate(()=>window.apiCalls.filter(([name,args])=>name==='tasks'&&!args.taskId).length),0,'healthy stream does not periodically pull the ledger');
    assert.equal(await panel.getByText('已同步',{exact:true}).count(),0,'quiet updates have no flashing sync message');
  }finally{await browser.close();}
});

test('refreshing a large streamed board waits honestly, keeps its rows, and retries through one transport', {skip:!executablePath&&'Chromium/Edge is required'}, async()=>{
  const browser=await chromium.launch({headless:true,executablePath});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'reduce'}), errors=[];
    page.setDefaultTimeout(5000);page.on('pageerror',error=>errors.push(error.message));
    await page.setContent(await fixture());await page.evaluate(()=>window.renderScenario('stream'));
    await page.getByRole('button',{name:'展开看板',exact:true}).click();
    const panel=page.locator('.ba-activity-panel'), refresh=panel.getByRole('button',{name:'刷新看板',exact:true});
    await panel.locator('[data-task-key="task:running"]').waitFor();
    await page.evaluate(()=>{window.addArchivedTasks(1000);window.scenarioControl.holdSnapshot=true;});
    await page.waitForFunction(()=>window.activitySnapshot().rows.filter(row=>row.kind==='task').length===1027);
    const stable=await panel.locator('[data-task-key="task:stable-4"]').elementHandle();
    await refresh.click();await page.waitForFunction(()=>window.streamRestarts===1);
    await page.waitForTimeout(700);
    assert.equal(await refresh.getAttribute('aria-busy'),'true','the spinner remains until the replacement arrives');
    assert.equal(await panel.locator('[data-task-key]').count(),24,'saved rows remain visible while archived records stay hidden');
    await refresh.evaluate(node=>node.click());assert.equal(await page.evaluate(()=>window.streamRestarts),1,'duplicate click cannot open another replacement');
    assert.equal(await page.evaluate(()=>window.apiCalls.filter(([name])=>name==='tasks').length),0);
    if(captureDir){await mkdir(captureDir,{recursive:true});await panel.screenshot({path:join(captureDir,'stream-refresh-pending.png')});}
    await page.evaluate(()=>window.finishSnapshot());
    await page.waitForFunction(()=>!document.querySelector('[aria-label="刷新看板"]').hasAttribute('aria-busy'));
    assert(await stable.evaluate(node=>node.isConnected),'unchanged rows preserve their DOM');
    await page.evaluate(()=>window.scenarioControl.streamFail=true);await refresh.click();
    await panel.getByRole('alert').first().waitFor();
    await page.waitForFunction(()=>!document.querySelector('[aria-label="刷新看板"]').hasAttribute('aria-busy'));
    assert.equal(await panel.locator('[data-task-key]').count(),24);
    assert(await panel.getByText('已保留上次的任务记录，请重试。',{exact:false}).isVisible());
    if(captureDir)await panel.screenshot({path:join(captureDir,'stream-refresh-error.png')});
    await page.evaluate(()=>window.scenarioControl.streamFail=false);await refresh.click();
    await panel.getByRole('alert').waitFor({state:'hidden'});
    await page.waitForFunction(()=>!document.querySelector('[aria-label="刷新看板"]').hasAttribute('aria-busy'));
    assert.equal(await page.evaluate(()=>window.streamRestarts),3);
    assert.equal(await page.evaluate(()=>window.apiCalls.filter(([name])=>name==='tasks').length),0);
    assert.equal(await page.evaluate(()=>window.activitySnapshot().rows.filter(row=>row.kind==='task').length),1027);
    if(captureDir)await panel.screenshot({path:join(captureDir,'stream-refresh-recovered.png')});
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('incremental activity updates do not synchronously measure every task row, including while closed', {skip:!executablePath&&'Chromium/Edge is required'}, async()=>{
  const browser=await chromium.launch({headless:true,executablePath});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'no-preference'});
    await page.setContent(await fixture());await page.evaluate(()=>window.renderScenario('stream'));
    await page.getByRole('button',{name:'展开看板',exact:true}).click();
    await page.locator('[data-task-key="task:running"]').waitFor();
    await page.evaluate(()=>{
      window.taskMeasurements=0;
      const measure=Element.prototype.getBoundingClientRect;
      Element.prototype.getBoundingClientRect=function(...args){if(this.matches('[data-task-key]'))window.taskMeasurements++;return measure.apply(this,args);};
    });
    for(const open of [true,false]){
      if(!open)await page.getByRole('button',{name:'收起看板',exact:true}).last().click();
      await page.evaluate(()=>{window.taskMeasurements=0;window.streamUpdate();});
      await page.waitForTimeout(250);
      assert.equal(await page.evaluate(()=>window.taskMeasurements),0,`an existing task update does not measure the entire ${open?'open':'closed'} board`);
    }
  }finally{await browser.close();}
});

test('the board slides with the conversation when opening and closing, reverses mid-flight and stays still under reduced motion', {skip:!executablePath&&'Chromium/Edge is required'}, async()=>{
  const browser=await chromium.launch({headless:true,executablePath});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'no-preference'});
    page.setDefaultTimeout(5000);
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.setContent(await fixture());
    await page.evaluate(()=>window.renderScenario('interrupted'));
    const cdp=await page.context().newCDPSession(page);await cdp.send('Animation.enable');
    const pace=playbackRate=>cdp.send('Animation.setPlaybackRate',{playbackRate});
    const panel=page.locator('.ba-activity-panel'), backdrop=page.locator('.ba-activity-backdrop'), trigger=page.locator('.ba-activity-trigger');
    const toggle=()=>trigger.evaluate(node=>node.click());
    const motion=locator=>locator.evaluate(node=>node.getAnimations().map(animation=>({rate:animation.playbackRate,frames:JSON.stringify(animation.effect.getKeyframes())})));
    const settle=()=>panel.evaluate(node=>Promise.all(node.getAnimations().map(animation=>animation.finished.catch(()=>{}))));
    const edges=()=>page.evaluate(()=>({main:document.querySelector('.ba-main').getBoundingClientRect().right,panel:document.querySelector('.ba-activity-panel').getBoundingClientRect().left}));
    const full=(await edges()).main;
    await pace(0.1);await toggle();
    assert.match((await motion(panel))[0]?.frames||'',/marginRight/,'a wide board pushes in from the right edge');
    await page.waitForTimeout(400);
    const mid=(await edges()).main;
    assert.ok(mid<full-1&&mid>full-400,`the conversation narrows gradually (${full} -> ${mid})`);
    await pace(1);await settle();
    const opened=await edges();
    assert.ok(Math.abs(opened.main-opened.panel)<1&&full-opened.main>300,'the open board settles beside the narrowed conversation');
    assert.equal((await motion(panel)).length,0,'no animation lingers once the board is open');
    await pace(0.1);await toggle();
    assert.equal(await panel.getAttribute('data-state'),'closing','the board stays rendered while it slides out');
    assert.equal(await panel.isVisible(),true);
    await toggle();
    assert.ok((await motion(panel))[0]?.rate<0,'reopening mid-flight reverses the running slide instead of snapping');
    await pace(1);await settle();
    assert.equal(await panel.getAttribute('data-state'),null);
    assert.equal(await panel.isVisible(),true,'the reversed slide ends open');
    await toggle();await panel.waitFor({state:'hidden'});
    assert.ok(Math.abs((await edges()).main-full)<1,'closing returns the full conversation width');
    await page.setViewportSize({width:390,height:900});
    await pace(0.1);await toggle();
    assert.match((await motion(panel))[0]?.frames||'',/translateX\(100%\)/,'a narrow board slides over the conversation');
    assert.match((await motion(backdrop))[0]?.frames||'',/opacity/,'the narrow backdrop fades in');
    await pace(1);await settle();
    await page.keyboard.press('Escape');
    assert.equal(await backdrop.getAttribute('data-state'),'closing','the backdrop lets clicks through while it fades out');
    await panel.waitFor({state:'hidden'});await backdrop.waitFor({state:'hidden'});
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.setViewportSize({width:1440,height:900});
    await toggle();
    assert.equal(await panel.isVisible(),true);
    assert.equal((await motion(panel)).length,0,'reduced motion opens without sliding');
    await toggle();
    assert.equal(await panel.isHidden(),true,'reduced motion closes at once');
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
