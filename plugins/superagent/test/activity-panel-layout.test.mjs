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
      import { assistantConfigSync } from './plugins/superagent/client/config-sync.mjs';
      import css from './plugins/superagent/client/style.css';
      const root = createRoot(document.getElementById('root'));
      let serial = 0;
      function App({ api, initialConfig }) {
        const [config,setConfig] = useState(initialConfig);
        window.updateConfig = config => { assistantConfigSync.accept({...config,revision:++serial},assistantConfigSync.begin());setConfig(config); };
        return <ActivityProvider><style>{css}</style><div className="ba-root">
          <main className="ba-main fixture-chat"><header><h1>主聊天</h1><ActivityTrigger api={api}/></header><p>BenchGo · 看板组件验收</p></main>
          <ActivityPanel api={api} assistantConfig={config} onOpenResources={(tab,selection)=>{window.resourceCalls.push(tab);window.resourceSelections.push(selection);}}/>
        </div></ActivityProvider>;
      }
      window.renderScenario = (state='data', supplied=true) => {
        window.apiCalls=[];window.resourceCalls=[];window.resourceSelections=[];
        const control=window.scenarioControl={state,fail:false};
        const now=new Date(), at=minutes=>new Date(+now-minutes*60000).toISOString();
        const tickets=[
          {id:'running',title:'检查主聊天右侧面板的响应式布局与操作路径',target:'检查主聊天右侧面板的响应式布局与操作路径',acceptance:'检查桌面与窄屏的任务入口、键盘导航及四种状态。',status:'claimed',createdAt:at(12),updatedAt:at(1),assignments:[{state:'claimed'}]},
          {id:'waiting',title:'补充模型配置的必要信息',status:'waiting',instructionRevision:1,resultVersion:0,createdAt:at(20),updatedAt:at(2),results:[],attentions:[{id:'model-question',origin:'worker',state:'waiting',instructionRevision:1,question:{question:'请提供要使用的供应商模型ID。'}}]},
          {id:'failed',title:'重新验证离线恢复',status:'failed',createdAt:at(30),updatedAt:at(3),results:[{summary:'连接中断，恢复后可以重新验证。'}]},
          {id:'blocked',title:'补充项目访问权限',status:'blocked',createdAt:at(40),updatedAt:at(4)},
          {id:'uncertain',title:'核实交付文件的版本',status:'uncertain',createdAt:at(50),updatedAt:at(5)},
          {id:'done',title:'整理今天的工作记录',status:'completed',createdAt:at(60),updatedAt:at(6),results:[{version:1,summary:'内部工作摘要',selfCheck:{summary:'已检查要求与执行结果'},outcome:'completed',delivery:{action:'deliver',text:'已归档工作记录，保留了相关文件与说明。'}}],deliveries:[{state:'sent',payload:{type:'ticket.result',instructionRevision:1,resultVersion:1}}]},
        ];
        const goals=[{id:'goal',target:'持续维护 BenchGo 的一致体验',status:'active',rowVersion:7,createdAt:at(120),updatedAt:at(7),ticketIds:['running']}];
        window.updateExecution = step => {
          const row=tickets[0], finished=step==='delivered', verifying=step==='verifying';
          const worker={id:'worker-main',label:'主 Worker',status:finished||verifying?'completed':step==='unknown'?'waiting':'running',activity:finished||verifying?'正在保存结果':step==='unknown'?'等待后续事件':'正在搜索网页',updatedAt:at(0)};
          const children=[
            {id:'child-search',label:'查找候选项目',status:step==='running'?'running':'completed',activity:step==='running'?'正在搜索网页':'已返回父 Worker',updatedAt:at(0)},
            {id:'child-check',label:'核对项目页面',status:step==='child-completed'?'failed':step==='unknown'?'unknown':finished||verifying?'completed':'running',activity:step==='child-completed'?'执行失败':step==='unknown'?'未读取到结束记录':finished||verifying?'已返回父 Worker':'正在读取网页',updatedAt:at(0)},
          ];
          Object.assign(row,{status:finished?'completed':step==='paused'?'paused':'open',instructionRevision:1,resultVersion:finished?1:0,updatedAt:at(0),
            assignments:[{id:'assignment-main',instructionRevision:1,state:finished?'completed':'claimed'}],results:finished?[{instructionRevision:1,version:1,summary:'内部结果',selfCheck:{summary:'已检查要求与执行结果'},outcome:'completed',delivery:{text:'已完成调研，来源与限制随结果交付。'}}]:[],
            deliveries:finished?[{state:'sent',payload:{type:'ticket.result',instructionRevision:1,resultVersion:1}}]:[],
            execution:{assignmentId:'assignment-main',runId:'run-main',sessionId:'worker-main',instructionRevision:1,phase:verifying?'verifying':'executing',updatedAt:at(0),observed:step!=='unknown',worker,children,
              childCounts:{total:children.length,running:children.filter(c=>c.status==='running').length,completed:children.filter(c=>c.status==='completed').length,failed:children.filter(c=>c.status==='failed').length},
              ...(step==='unknown'?{limitation:'历史会话尚未加载，部分执行状态无法确认。'}:{})}});
          document.dispatchEvent(new Event('benchgo:assistant-changed'));
        };
        if(state==='dynamic'){tickets.splice(1);goals.splice(0);window.updateExecution('running');}
        const config={name:'BenchGo',models:[{modelId:'provider/opaque-model@2026-11'}],cardMotion:false};
        const api=async(name,args)=>{
          window.apiCalls.push([name,args]);
          if(control.state==='loading') return new Promise(()=>{});
          if(control.state==='error'||control.fail) throw new Error('测试连接暂不可用');
          if(name==='state') return {config};
          if(name==='ticketStop'){tickets.find(row=>row.id===args.ticketId).status='cancelled';return {};}
          if(name==='goalCancel'){goals.find(row=>row.id===args.id).status='cancelled';return {};}
          if(name==='tickets') return {tickets:control.state==='empty'?[]:tickets};
          if(name==='goalList') return {goals:control.state==='empty'?[]:goals};
          return {};
        };
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
    *{box-sizing:border-box}body{margin:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:14px/1.6 var(--dsw-font-family)}
    #root{height:100vh}.fixture-chat{min-width:0;flex:1;padding:24px}.fixture-chat>header{display:flex;align-items:center;justify-content:space-between;gap:12px}.fixture-chat h1{font-size:18px;margin:0}.fixture-chat>p{color:var(--dsw-alias-label-secondary);font-size:13px}
  </style></head><body><div id="root"></div><script>${js}</script></body></html>`;
}

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
    await panel.locator('[data-task-key="ticket:running"]').waitFor();
    assert(await panel.locator('.benchgo-pet-avatar img').first().evaluate(node=>node.complete&&node.naturalWidth>0),'default identity renders the brand pet');
    assert.equal(await panel.getByText('已连接',{exact:false}).count(),0,'task fetch success does not claim a live connection');
    assert.equal(await panel.getByRole('tab',{name:/审核/}).count(),0,'tasks do not have a separate confirmation page');
    assert.equal(await panel.getByRole('button',{name:'查看记录',exact:true}).count(),0,'the task itself opens details');
    const focusedTask=panel.locator('[data-task-key="ticket:running"] .ba-board-task-open');
    await focusedTask.focus();
    const oldButton=await focusedTask.elementHandle();
    const requestCount=await page.evaluate(()=>window.apiCalls.filter(([name])=>name==='tickets').length);
    await page.evaluate(()=>document.dispatchEvent(new Event('benchgo:assistant-changed')));
    await page.waitForFunction(count=>window.apiCalls.filter(([name])=>name==='tickets').length>count,requestCount);
    assert(await oldButton.evaluate(node=>node.isConnected&&node===document.activeElement),'background polling preserves task DOM and focus');
    await page.evaluate(()=>{window.scenarioControl.fail=true;document.dispatchEvent(new Event('benchgo:assistant-changed'));});
    await panel.getByRole('alert').first().waitFor();
    assert.equal(await panel.locator('[data-task-key]').count(),7,'failed refresh retains previously loaded tasks');
    assert(await panel.getByText('已保留上次的任务记录，请重试。',{exact:true}).isVisible());
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
          const rows=await panel.locator('.ba-board-row').evaluateAll(nodes=>nodes.map(node=>{
            const title=node.querySelector('strong'),summary=node.querySelector('.ba-board-summary');
            return {height:node.getBoundingClientRect().height,title:title.getBoundingClientRect().height,summary:summary.getBoundingClientRect().height,button:node.querySelector('button').getBoundingClientRect().height};
          }));
          assert(rows.every(row=>row.height<=66&&row.title<=20&&row.summary<=18&&row.button>=44),'each task stays on two lines with a full-size click target');
        }
        await shot(`${dark?'dark':'light'}-${width}-${{'任务':'tasks','身份':'identity'}[name]}`);
      }
    }
    assert(await panel.getByText('6 条 · 进行中 1',{exact:true}).isVisible(),'active ticket count excludes the active goal');
    assert(await panel.getByText('1 个',{exact:true}).isVisible(),'goal count is reported separately');
    await tab('任务').focus();await page.keyboard.press('ArrowRight');
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
    assert(await page.evaluate(()=>!['ticket:running','goal:goal'].includes(document.activeElement.closest('[data-task-key]')?.dataset.taskKey)),'collapsed tasks are skipped in the tab order');
    await activeHeading.click();
    await panel.locator('[data-task-key="ticket:running"] .ba-board-task-open').click({position:{x:4,y:4}});
    await page.getByRole('dialog').waitFor();
    assert.equal(Array.from(await page.getByRole('dialog').getByRole('heading',{level:2}).innerText()).length,10,'ticket display titles have at most ten Unicode characters');
    assert(await page.getByRole('dialog').getByText('检查主聊天右侧面板的响应式布局与操作路径',{exact:true}).isVisible());
    assert(await page.getByRole('dialog').getByText('检查桌面与窄屏的任务入口、键盘导航及四种状态。',{exact:true}).isVisible(),'full acceptance remains visible after shortening the display title');
    await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});
    assert(await panel.isVisible(),'closing task details keeps the board open');
    await page.waitForFunction(()=>document.activeElement?.closest('[data-task-key]')?.dataset.taskKey==='ticket:running');
    assert(await focusedTask.evaluate(node=>node===document.activeElement),'closing details restores focus to the task');
    await focusedTask.press('Enter');
    await page.getByRole('dialog').getByRole('button',{name:'停止任务',exact:true}).click();
    await page.waitForFunction(()=>window.apiCalls.some(([name,args])=>name==='ticketStop'&&args.ticketId==='running'));
    await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});
    await panel.locator('[data-task-key="ticket:running"]').getByText('已停止',{exact:true}).waitFor();
    await panel.locator('[data-task-key="ticket:done"] .ba-board-task-open').click();
    const detail=page.getByRole('dialog');
    assert(await detail.getByText('已完成 · 结果已交付',{exact:true}).isVisible());
    assert(await detail.getByText('已归档工作记录，保留了相关文件与说明。',{exact:true}).isVisible());
    assert.equal(await detail.getByRole('button',{name:/确认|完成|停止/}).count(),0,'completed tasks require no acknowledgement');
    assert(!await page.evaluate(()=>window.apiCalls.some(([name])=>name==='taskUpdate')),'opening a result never changes completion');
    if(captureDir)await page.screenshot({path:join(captureDir,'completed-detail.png')});
    await page.keyboard.press('Escape');await detail.waitFor({state:'hidden'});
    await tab('身份').click();
    assert(await panel.getByText('provider/opaque-model@2026-11',{exact:true}).isVisible(),'model ID remains opaque and unchanged');
    for(const dark of [false,true])for(const state of ['empty','loading','error']){
      await page.setViewportSize({width:390,height:900});
      await page.evaluate(dark=>document.body.toggleAttribute('data-ds-dark-theme',dark),dark);
      await scenario(state,false);
      for(const name of ['任务','身份']){
        await tab(name).click();
        if(state==='loading') assert(await panel.locator('[aria-busy="true"]').count()>0,'loading has an explicit pending region');
        if(name==='身份'&&state!=='empty')assert.deepEqual(await panel.locator('.ba-board-facts dd').allTextContents(),['—','—','—'],'unavailable counts stay unknown instead of becoming zero');
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
        await panel.locator('[data-task-key="ticket:running"]').waitFor();
        assert.equal(await panel.getByRole('alert').count(),0,'refresh recovers data and clears the error');
      }
    }
    await tab('身份').click();
    await page.evaluate(()=>window.updateConfig({name:'小伴 · 已保存的新身份',models:[{modelId:'tenant/custom:model#v2'}],pet:{kind:'builtin',expression:'happy'}}));
    await panel.getByText('小伴 · 已保存的新身份',{exact:true}).first().waitFor();
    assert(await panel.getByText('tenant/custom:model#v2',{exact:true}).isVisible(),'saved config updates without reopening');
    assert(await panel.locator('.benchgo-pet-avatar img').first().evaluate(node=>node.complete&&node.naturalWidth>0),'updated builtin pet renders');
    await panel.getByRole('button',{name:/助手形象/}).click();
    await panel.waitFor({state:'hidden'});
    assert.deepEqual(await page.evaluate(()=>window.resourceCalls),['pet'],'identity appearance action opens the correct resource');
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
    const row=panel.locator('[data-task-key="ticket:running"]');
    await row.waitFor();
    assert.equal(await panel.locator('[data-task-key]').count(),1,'child workers never become top-level tickets');
    assert(await row.getByText(/正在搜索网页/).isVisible(),'current activity appears in the two-line list');
    assert.equal(await row.locator('.ba-board-children-count').innerText(),'子任务 0/2','list includes the count of returned children');
    for(const width of [1440,768,390]){
      await page.setViewportSize({width,height:900});
      assert(await row.locator('.ba-board-children-count').evaluate(node=>node.scrollWidth<=node.clientWidth),'running child count is never truncated');
      if(captureDir)await panel.screenshot({path:join(captureDir,`light-${width}-dynamic-list.png`)});
    }
    await row.locator('.ba-board-task-open').click();
    const detail=page.getByRole('dialog');
    await detail.waitFor();
    assert.equal(await detail.locator('[data-worker-id]').count(),3,'one Worker and its two children are visible');
    assert.equal(await detail.locator('[data-worker-status="running"]').count(),3);
    assert.equal(await detail.getByRole('progressbar').count(),0,'observed work has no estimated completion percentage');
    assert.equal(await detail.locator('.ba-execution-timeline').count(),1,'execution uses a single task line');
    assert.equal(await detail.locator('.ba-task-execution time').count(),1,'task line has one shared freshness stamp');
    assert.equal(await detail.locator('.ba-execution-status').count(),0,'current activity replaces repeated running labels');
    assert(await detail.getByText('正在执行',{exact:true}).isVisible(),'execution phase appears once above the task line');
    const handle=await detail.locator('[data-worker-id="child-search"]').elementHandle();
    await page.evaluate(()=>window.updateExecution('child-completed'));
    await detail.locator('[data-worker-id="child-search"][data-worker-status="completed"]').waitFor();
    assert(await handle.evaluate(node=>node.isConnected),'child updates preserve the existing DOM row');
    assert(await detail.locator('[data-worker-id="child-check"]').getByText('执行失败',{exact:true}).first().isVisible());
    assert.equal(await detail.getByText('已完成',{exact:true}).count(),0,'one child ending does not complete the ticket');
    for(const dark of [false,true])for(const width of [1440,768,390]){
      await page.setViewportSize({width,height:900});
      await page.evaluate(dark=>document.body.toggleAttribute('data-ds-dark-theme',dark),dark);
      assert(await row.locator('.ba-board-children-count').evaluate(node=>node.scrollWidth<=node.clientWidth),'child count remains fully visible on the compact row');
      assert(await detail.evaluate(node=>node.scrollWidth<=node.clientWidth),'execution tree fits the task dialog');
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'execution tree never widens the document');
      if(captureDir)await page.screenshot({path:join(captureDir,`${dark?'dark':'light'}-${width}-execution.png`)});
    }
    await page.evaluate(()=>{window.scenarioControl.fail=true;document.dispatchEvent(new Event('benchgo:assistant-changed'));});
    await detail.getByText('动态更新暂不可用，以下保留上次记录。',{exact:true}).waitFor();
    assert.equal(await detail.locator('[data-worker-id]').count(),3,'refresh errors keep observed children with a stale-state notice');
    await page.evaluate(()=>{window.scenarioControl.fail=false;window.updateExecution('verifying');});
    await detail.getByText('动态更新暂不可用，以下保留上次记录。',{exact:true}).waitFor({state:'hidden'});
    await row.getByText('正在保存结果',{exact:true}).waitFor();
    assert.equal(await detail.locator('[data-worker-status="completed"]').count(),3);
    assert.equal(await detail.getByText('已完成',{exact:true}).count(),0,'Worker completion still waits for ticket result persistence and delivery');
    if(captureDir)await page.screenshot({path:join(captureDir,'verifying-detail.png')});
    await page.evaluate(()=>window.updateExecution('delivered'));
    await detail.getByText('已完成 · 结果已交付',{exact:true}).waitFor();
    assert(await detail.getByText('已完成调研，来源与限制随结果交付。',{exact:true}).isVisible());
    assert.equal(await detail.getByRole('button',{name:'停止任务',exact:true}).count(),0);
    if(captureDir)await page.screenshot({path:join(captureDir,'delivered-detail.png')});
    await page.evaluate(()=>window.updateExecution('paused'));
    await detail.getByRole('heading',{name:'最近执行记录',exact:true}).waitFor();
    assert(await detail.getByText('以下为最近一次执行记录，不代表 Worker 当前仍在运行。',{exact:true}).isVisible(),'paused tickets label old activity as historical');
    assert(await detail.locator('[data-worker-id="worker-main"]').getByText('上次记录为运行中',{exact:true}).isVisible(),'paused ticket does not present its previous Worker state as live');
    await page.evaluate(()=>window.updateExecution('unknown'));
    await detail.locator('[data-worker-id="child-check"][data-worker-status="unknown"]').waitFor();
    assert(await detail.getByText('历史会话尚未加载，部分执行状态无法确认。',{exact:true}).isVisible());
    assert(await detail.locator('[data-worker-id="worker-main"]').getByText('等待后续',{exact:true}).isVisible(),'idle worker does not become completed');
    await detail.getByRole('button',{name:'前往任务管理',exact:true}).click();
    await panel.waitFor({state:'hidden'});
    assert.deepEqual(await page.evaluate(()=>window.resourceCalls),['tasks']);
    assert.deepEqual(await page.evaluate(()=>window.resourceSelections),[{ticketId:'running'}],'management opens the selected ticket for revisions');
    assert.deepEqual(errors,[],'dynamic updates produce no browser errors');
  }finally{await browser.close();}
});
