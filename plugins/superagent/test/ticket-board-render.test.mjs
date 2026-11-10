import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sharedUiStyles } from '../../benchgo/scripts/shared-ui.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const webRequire = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url));
const { chromium } = webRequire('playwright');
const { build } = createRequire(new URL('../../benchgo/package.json', import.meta.url))('esbuild');
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || [chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);

async function fixture() {
  const result = await build({
    stdin: { resolveDir: root, loader: 'jsx', contents: `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {Tickets} from './plugins/superagent/client/tickets.jsx';
      import css from './plugins/superagent/client/style.css';
      import hostCss from './plugins/benchgo/client/style.css';
      const root=createRoot(document.getElementById('root'));let serial=0;
      window.renderScenario=(state='data')=>{
        window.calls=[];window.control={state};
        const sample=(id,title,status,extra={})=>({id,title,target:title+'：按要求完成并提供证据',status,instructionRevision:1,resultVersion:0,
          createdAt:'2026-11-07T08:00:00Z',updatedAt:'2026-11-07T08:05:00Z',taskCanOrganize:false,...extra});
        const rows=[sample('queued','准备周报','waiting'),sample('running','运行兼容测试','running',{assignments:[{state:'claimed'}],executionSession:{available:true,sessionId:'real-execution',ticketId:'running'}}),
          sample('paused','确认发布范围','waiting',{executionControl:{paused:true},acceptance:'旧验收条件不应盖过暂停原因'}),sample('done','交付设计稿','completed',{taskCanOrganize:true,resultVersion:1,results:[{instructionRevision:1,version:1,outcome:'completed',summary:'设计稿已完成并交付，相关素材可在原执行会话查看。'}]})];
        if(state==='long'){
          rows[0].title='无分隔符的长标题'.repeat(50);rows[0].target='LongUnbrokenRequirement'.repeat(100);rows[0].acceptance='Acceptance'.repeat(100);
          rows[2].status='waiting';rows[2].executionControl={};rows[2].attentions=[{id:'question',origin:'worker',state:'waiting',instructionRevision:1,question:{question:'请确认允许继续执行的范围：'+ 'UnbrokenScope'.repeat(80)}}];
          rows[3].resultVersion=1;rows[3].results=[{version:1,instructionRevision:1,summary:'结果摘要：'+ 'LongReadableResult'.repeat(100)}];
        }
        const api=async(action,input)=>{
          window.calls.push([action,input]);
          if(window.control.state==='loading')return new Promise(()=>{});
          if(window.control.state==='error')throw Error(window.control.errorMessage||'连接暂不可用');
          if(action==='tickets')return {tickets:window.control.state==='empty'?[]:rows};
          if(action==='checkpointList')return {checkpoints:[]};
          if(action==='state')return {config:{revision:1,workerConcurrency:2}};
          if(action==='ticketPause'&&window.control.actionError)throw Error(window.control.actionError);
          return {queued:true};
        };
        root.render(<div className='ba-root' key={++serial}><style>{hostCss}{css}</style><main className='ba-studio-body' style={{padding:24,width:'100%',boxSizing:'border-box'}}>
          <Tickets api={api} onCreateGoal={()=>window.calls.push(['createGoal'])} onSchedule={()=>window.calls.push(['openSchedule'])} onOpenExecution={async value=>{window.calls.push(['openExecution',value]);if(window.control.openError)throw Error('原会话尚未连接');}}/>
        </main></div>);
      };
    ` },
    bundle: true, write: false, outdir: join(root, 'artifacts', 'unused-ticket-board-test'), format: 'iife', jsx: 'automatic',
    nodePaths: [join(root, 'plugins/benchgo/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')],
    alias: { react: dirname(webRequire.resolve('react/package.json')), 'react-dom': dirname(webRequire.resolve('react-dom/package.json')),
      '@deepseek-ai/dsh-client-ui-primitives': join(root, 'deepseek-harness/packages/client/ui-primitives/src/index.ts') },
    loader: { '.css': 'text', '.module.css': 'local-css', '.svg': 'text', '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
    plugins: [sharedUiStyles()], define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
  });
  const css = result.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n');
  const themeRoot=join(root,'deepseek-harness/packages/client/ui-theme/src/styles');
  const theme=(await Promise.all(['base.css','design-platform.css','focus.css'].map(name=>readFile(join(themeRoot,name),'utf8')))).join('\n');
  const js = result.outputFiles.find(file => file.path.endsWith('.js')).text.replaceAll('</script', '<\\/script');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${theme}body{margin:0;font-family:Arial,sans-serif;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}${css}</style></head><body><div id="root"></div><script>${js}</script></body></html>`;
}

test('ticket board renders four states, filters, retains details and routes real controls on desktop and phone', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const html = await fixture(), browser = await chromium.launch({ headless: true, executablePath });
  const screenshots = process.env.BENCHGO_TICKET_SCREENSHOTS;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(5000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.request().url() === 'http://localhost/' ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
    await page.goto('http://localhost/');
    const render = state => page.evaluate(state => window.renderScenario(state), state);
    const shot = async name => { if (screenshots) await page.screenshot({ path: join(screenshots, name + '.png'), fullPage: true }); };
    for(const dark of [false,true])for(const width of [1440,390])for (const [state, title] of [['loading', '正在读取工单'], ['error', '工单暂时无法读取'], ['empty', '暂无工单'],['data','工单视图']]) {
      await page.setViewportSize({width,height:900});await page.evaluate(dark=>document.body.toggleAttribute('data-ds-dark-theme',dark),dark);
      if(state==='data'){await render(state);await page.getByRole('tablist',{name:title}).waitFor();}else{
      await render(state); await page.getByText(title, { exact: true }).waitFor(); await shot(state);
      }
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${dark}/${width}/${state} must fit`);
      await shot(`${dark?'dark':'light'}-${width}-${state}`);
      if (state === 'empty') assert.equal(await page.getByRole('button', { name: '新建持续目标', exact: true }).count(), 1, 'empty state reuses the header action');
    }
    await page.setViewportSize({width:1440,height:1000});await page.evaluate(()=>document.body.removeAttribute('data-ds-dark-theme'));
    await render('data'); await page.getByRole('tab', { name: '看板', exact: true }).click();
    const board = page.getByLabel('工单看板', { exact: true }); await board.waitFor();
    assert.equal(await board.getByRole('checkbox').count(), 0, 'Ticket completion is a system fact, not a manual checkbox');
    const searchLayout = await page.locator('.ba-ticket-view-controls').evaluate(element => {
      const tab = element.querySelector('.bg-segments').getBoundingClientRect();
      const input = element.querySelector('input').getBoundingClientRect();
      const icon = element.querySelector('.ba-ticket-search>.cmd-ui-icon').getBoundingClientRect();
      return { tabCenter: tab.y + tab.height / 2, inputCenter: input.y + input.height / 2, iconCenter: icon.y + icon.height / 2, inside: icon.x > input.x && icon.right < input.right };
    });
    assert(Math.abs(searchLayout.tabCenter - searchLayout.inputCenter) < 1, 'search and tabs must share a vertical center');
    assert(Math.abs(searchLayout.iconCenter - searchLayout.inputCenter) < 1 && searchLayout.inside, 'search icon must sit inside and center on its field');
    assert.equal(await board.locator('.ba-task-state[data-state="running"]').evaluate(element => getComputedStyle(element).backgroundColor), 'rgba(0, 0, 0, 0)');
    assert.equal(await board.locator('.ba-ticket-lane').count(), 3);
    assert(await board.getByText('工单已暂停，已有成果保留。',{exact:true}).isVisible(),'waiting reason is the row summary');
    assert.equal(await board.getByText('旧验收条件不应盖过暂停原因',{exact:true}).count(),0);
    const boardTab=page.getByRole('tab',{name:'看板',exact:true});
    assert.equal(await boardTab.getAttribute('aria-controls'),await page.getByRole('tabpanel').getAttribute('id'));
    assert.equal(await page.getByRole('tabpanel').getAttribute('aria-labelledby'),await boardTab.getAttribute('id'));
    await boardTab.focus();await page.keyboard.press('ArrowLeft');
    assert.equal(await page.getByRole('tab',{name:'列表',exact:true}).getAttribute('aria-selected'),'true');
    await page.keyboard.press('End');assert.equal(await boardTab.getAttribute('aria-selected'),'true');
    for (const [title,count] of [['进行',1],['等待',2],['完成',1]]) assert.equal(await board.getByRole('region', { name: `${title}，${count} 项`, exact: true }).count(), 1);
    await shot('board-desktop');
    await page.getByRole('button', { name: '定时任务', exact: true }).click();
    assert((await page.evaluate(() => window.calls)).some(([name]) => name === 'openSchedule'));
    await page.getByRole('searchbox', { name: '搜索工单' }).fill('兼容');
    assert.equal(await board.locator('.ba-task-list-row').count(), 1);
    await page.getByRole('searchbox', { name: '搜索工单' }).fill('不存在');
    await page.getByText('没有匹配的工单', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '清除搜索', exact: true }).count(), 1, 'search has one clear action');
    await page.getByRole('button', { name: '清除搜索', exact: true }).click();
    assert(await page.getByRole('searchbox',{name:'搜索工单'}).evaluate(node=>node===document.activeElement),'clearing search restores input focus');
    await page.getByRole('searchbox',{name:'搜索工单'}).fill('兼容');await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('searchbox',{name:'搜索工单'}).inputValue(),'');
    await board.getByRole('region', { name: '等待，2 项', exact: true }).getByRole('button', { name: '继续工单', exact: true }).click();
    assert((await page.evaluate(() => window.calls)).some(([name, input]) => name === 'ticketResume' && input.ticketId === 'paused'));
    const pausedOpen=board.getByRole('button', { name: /确认发布范围.*等待/ });await pausedOpen.focus();await page.keyboard.press('Enter');
    await page.getByRole('dialog').waitFor();
    assert(await page.getByRole('dialog').getByText('工单已暂停，已有成果保留。', { exact: true }).isVisible());
    assert.equal(await page.getByRole('button', { name: '查看执行会话', exact: true }).count(), 0);
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({state:'hidden'});
    await pausedOpen.evaluate(node=>new Promise(resolve=>requestAnimationFrame(()=>resolve())));
    assert(await pausedOpen.evaluate(node=>node===document.activeElement),'board detail closing returns focus');
    await board.getByRole('button', { name: /运行兼容测试.*进行/ }).click();
    await page.getByRole('dialog').waitFor();
    const detail=page.getByRole('dialog');
    assert.equal(await detail.locator('.bg-ui-dialog-title .ba-activity-detail-status').getAttribute('aria-label'),'进行','task management uses the shared title status');
    assert.equal(await detail.locator('.ba-goal-status').count(),0,'detail body omits the duplicated state label');
    assert.equal(await detail.getByText(/任务要求|验收条件|创建：|更新：/).count(),0,'requirements and record timestamps stay out of the default detail');
    assert.equal(await detail.locator('.ba-task-execution').count(),0,'missing execution data renders no empty activity section');
    assert(await detail.getByRole('heading',{name:'当前进展',exact:true}).isVisible(),'a running task retains a progress summary');
    for(const action of ['查看执行会话','停止工单']) assert(await detail.getByRole('button',{name:action,exact:true}).evaluate(node=>!!node.closest('.ba-task-dialog-footer')),'detail actions share the bottom footer');
    assert.equal(await detail.locator('.ba-activity-detail-status').evaluate(node=>getComputedStyle(node).backgroundColor),'rgba(0, 0, 0, 0)');
    assert(await page.getByRole('button', { name: '修订要求', exact: true }).isEnabled(), 'ordinary follow-up must remain available while Worker runs');
    await page.evaluate(() => window.control.openError = true);
    await page.getByRole('button', { name: '查看执行会话', exact: true }).click();
    await page.getByRole('alert').getByText(/执行会话暂时无法打开/).waitFor();
    await page.evaluate(() => window.control.openError = false);
    await page.getByRole('button', { name: '查看执行会话', exact: true }).click();
    assert((await page.evaluate(() => window.calls)).some(([name, value]) => name === 'openExecution' && value.sessionId === 'real-execution'));
    await detail.getByRole('button',{name:'停止工单',exact:true}).click();
    const stopConfirmation=page.getByRole('dialog',{name:'停止“运行兼容测试”？',exact:true});
    await stopConfirmation.getByRole('button',{name:'取消',exact:true}).click();
    assert.equal((await page.evaluate(()=>window.calls.filter(([action])=>action==='ticketStop'))).length,0,'cancelled stop has no side effects');
    await detail.getByRole('button',{name:'停止工单',exact:true}).click();
    await stopConfirmation.getByRole('button',{name:'停止工单',exact:true}).click();
    await page.waitForFunction(()=>window.calls.some(([action])=>action==='ticketStop'));
    await page.keyboard.press('Escape');
    await page.getByRole('tab', { name: '列表', exact: true }).click();
    assert.equal(await page.locator('.ba-task-list > .ba-task-list-row').count(), 4);
    const listOpen=page.locator('.ba-task-list .ba-task-open').first();await listOpen.focus();await page.keyboard.press('Enter');await page.getByRole('dialog').waitFor();
    await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});await listOpen.evaluate(node=>new Promise(resolve=>requestAnimationFrame(()=>resolve())));assert(await listOpen.evaluate(node=>node===document.activeElement),'list detail closing returns focus');
    await page.getByRole('button', { name: '重命名', exact: true }).first().click();
    await page.getByRole('textbox', { name: '任务名称', exact: true }).fill('保留名称草稿');
    assert(await page.getByRole('tab', { name: '看板', exact: true }).isDisabled());
    assert(await page.getByRole('searchbox', { name: '搜索工单' }).isDisabled());
    await page.getByRole('button', { name: '取消重命名', exact: true }).click();
    await page.getByRole('tab', { name: '看板', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await shot('board-mobile');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'phone layout must not overflow horizontally');
    assert.equal(await board.locator('.ba-ticket-lane').count(), 3);
    for(const dark of [false,true])for(const width of [1440,390]){
      await page.setViewportSize({width,height:900});await page.evaluate(dark=>document.body.toggleAttribute('data-ds-dark-theme',dark),dark);await render('long');
      for(const view of ['列表','看板']){
        await page.getByRole('tab',{name:view,exact:true}).click();
        assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${dark}/${width}/${view} long text fits`);
        await shot(`${dark?'dark':'light'}-${width}-long-${view==='列表'?'list':'board'}`);
      }
      await page.evaluate(()=>window.control.actionError='无法暂停当前任务：'+ 'ConnectionUnavailable'.repeat(80));
      await page.getByRole('button',{name:'暂停工单',exact:true}).first().click();
      await page.getByRole('alert').getByText(/无法暂停当前任务/).waitFor();
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${dark}/${width} long error fits`);
      const longError=page.getByLabel('工单错误详情');
      assert(await longError.evaluate(node=>node.clientHeight<120&&node.scrollHeight>node.clientHeight),'long errors retain content in a compact scrollable region');
      await longError.focus();await page.keyboard.press('End');
      await shot(`${dark?'dark':'light'}-${width}-long-error`);
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
