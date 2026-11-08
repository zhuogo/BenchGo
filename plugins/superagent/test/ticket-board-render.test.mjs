import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
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
        const rows=[sample('queued','准备周报','open'),sample('running','运行兼容测试','open',{assignments:[{state:'claimed'}],executionSession:{available:true,sessionId:'real-execution',ticketId:'running'}}),
          sample('paused','确认发布范围','paused'),sample('done','交付设计稿','completed',{taskCanOrganize:true})];
        const api=async(action,input)=>{
          window.calls.push([action,input]);
          if(window.control.state==='loading')return new Promise(()=>{});
          if(window.control.state==='error')throw Error('连接暂不可用');
          if(action==='tickets')return {tickets:window.control.state==='empty'?[]:rows};
          if(action==='checkpointList')return {checkpoints:[]};
          if(action==='state')return {config:{revision:1,workerConcurrency:2}};
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
  const js = result.outputFiles.find(file => file.path.endsWith('.js')).text.replaceAll('</script', '<\\/script');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>body{margin:0;font-family:Arial,sans-serif}${css}</style></head><body><div id="root"></div><script>${js}</script></body></html>`;
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
    for (const [state, title] of [['loading', '正在读取工单'], ['error', '工单暂时无法读取'], ['empty', '暂无工单']]) {
      await render(state); await page.getByText(title, { exact: true }).waitFor(); await shot(state);
    }
    await render('data'); await page.getByRole('tab', { name: '看板', exact: true }).click();
    const board = page.getByLabel('工单看板', { exact: true }); await board.waitFor();
    assert.equal(await board.locator('.ba-ticket-lane').count(), 4);
    for (const title of ['待执行', '执行中', '待处理', '已结束']) assert.equal(await board.getByRole('region', { name: `${title}，1 项`, exact: true }).count(), 1);
    await shot('board-desktop');
    await page.getByRole('button', { name: '定时任务', exact: true }).click();
    assert((await page.evaluate(() => window.calls)).some(([name]) => name === 'openSchedule'));
    await page.getByRole('searchbox', { name: '搜索工单' }).fill('兼容');
    assert.equal(await board.locator('.ba-task-list-row').count(), 1);
    await page.getByRole('searchbox', { name: '搜索工单' }).fill('不存在');
    await page.getByText('没有匹配的工单', { exact: true }).waitFor();
    await page.getByRole('button', { name: '清除搜索', exact: true }).first().click();
    await board.getByRole('region', { name: '待处理，1 项', exact: true }).getByRole('button', { name: '继续工单', exact: true }).click();
    assert((await page.evaluate(() => window.calls)).some(([name, input]) => name === 'ticketResume' && input.ticketId === 'paused'));
    await board.getByRole('button', { name: /确认发布范围.*已暂停/ }).click();
    await page.getByRole('dialog').waitFor();
    assert(await page.getByRole('dialog').getByText('确认发布范围：按要求完成并提供证据', { exact: true }).isVisible());
    assert.equal(await page.getByRole('button', { name: '查看执行会话', exact: true }).count(), 0);
    await page.keyboard.press('Escape');
    await board.getByRole('button', { name: /运行兼容测试.*执行中/ }).click();
    await page.getByRole('dialog').waitFor();
    assert(await page.getByRole('button', { name: '修订要求', exact: true }).isEnabled(), 'ordinary follow-up must remain available while Worker runs');
    await page.evaluate(() => window.control.openError = true);
    await page.getByRole('button', { name: '查看执行会话', exact: true }).click();
    await page.getByRole('alert').getByText(/执行会话暂时无法打开/).waitFor();
    await page.evaluate(() => window.control.openError = false);
    await page.getByRole('button', { name: '查看执行会话', exact: true }).click();
    assert((await page.evaluate(() => window.calls)).some(([name, value]) => name === 'openExecution' && value.sessionId === 'real-execution'));
    await page.keyboard.press('Escape');
    await page.getByRole('tab', { name: '列表', exact: true }).click();
    assert.equal(await page.locator('.ba-task-list > .ba-task-list-row').count(), 4);
    await page.getByRole('button', { name: '重命名', exact: true }).first().click();
    await page.getByRole('textbox', { name: '任务名称', exact: true }).fill('保留名称草稿');
    assert(await page.getByRole('tab', { name: '看板', exact: true }).isDisabled());
    assert(await page.getByRole('searchbox', { name: '搜索工单' }).isDisabled());
    await page.getByRole('button', { name: '取消重命名', exact: true }).click();
    await page.getByRole('tab', { name: '看板', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await shot('board-mobile');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'phone layout must not overflow horizontally');
    assert.equal(await board.locator('.ba-ticket-lane').count(), 4);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
