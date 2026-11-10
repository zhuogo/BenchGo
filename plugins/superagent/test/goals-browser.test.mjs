import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
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
  const result = await build({ stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React from 'react';import {createRoot} from 'react-dom/client';
    import {Goals} from './plugins/superagent/client/goals.jsx';
    import css from './plugins/superagent/client/style.css';import hostCss from './plugins/benchgo/client/style.css';
    const root=createRoot(document.getElementById('root'));let serial=0;
    window.renderScenario=(mode='data')=>{
      window.calls=[];window.mode=mode;window.catalogMode='data';window.catalogFailures=0;
      let rows=mode==='empty'?[]:[{id:'goal-one',objective:'推进发布准备',projectId:'project:opaque',status:'active',rowVersion:7,ticketIds:['ticket-one'],updatedAt:'2026-11-08T08:00:00Z',taskCanOrganize:false,provider:'historical-provider',model:'historical-model'}];
      const api=async(action,input)=>{
        window.calls.push({action,input});
        if(action==='goalList'){
          if(window.mode==='loading')return new Promise(()=>{});
          if(window.mode==='error')throw Error('目标服务暂时不可用');
          return {goals:rows};
        }
        if(action==='catalog'){
          if(window.catalogMode==='loading')return new Promise(()=>{});
          if(window.catalogFailures-->0)throw Error('项目目录暂时不可用');
          return {projects:[{id:'project:opaque',title:'正式项目',available:true},{id:'project:disabled',title:'不可用项目',available:false}],providers:[{id:'legacy-provider',models:['legacy-model']}]};
        }
        if(action==='goalPause'||action==='goalResume'||action==='goalCancel'){
          rows=rows.map(row=>row.id===input.id?{...row,status:action==='goalPause'?'paused':action==='goalResume'?'active':'cancelled',rowVersion:row.rowVersion+1}:row);return {goal:rows[0]};
        }
        if(action==='goalCreate'){rows=[...rows,{...input.goal,id:'created',status:'active',rowVersion:1,ticketIds:[]}];return {goal:rows.at(-1)};}
      };
      root.render(<div className='ba-root' key={++serial}><style>{hostCss}{css}</style><main style={{padding:24,maxWidth:1000,margin:'auto',boxSizing:'border-box'}}><Goals api={api} refresh={async()=>window.calls.push({action:'refresh'})} onViewTickets={()=>window.calls.push({action:'viewTickets'})}/></main></div>);
    };
  ` }, bundle: true, write: false, outdir: join(root, 'artifacts', 'unused-goals-ui-test'), format: 'iife', jsx: 'automatic',
    nodePaths: [join(root, 'plugins/benchgo/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')],
    alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')) },
    loader: { '.css': 'text', '.svg': 'text' }, plugins: [sharedUiStyles()], define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font-family:Arial,sans-serif}.ba-root{height:auto!important;min-width:0!important}</style></head><body><div id="root"></div><script>${result.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script></body></html>`;
}

test('production goals render four states, use system worker model, recover catalog and submit only the goal whitelist', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const screenshots = process.env.BENCHGO_GOALS_SCREENSHOTS;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  try {
    const page = await browser.newPage(), errors = [];
    page.setDefaultTimeout(6000);page.on('pageerror', error => errors.push(error.message));
    const nativeDialogs = []; page.on('dialog', dialog => { nativeDialogs.push(dialog.message()); void dialog.dismiss(); });
    const html = await fixture();
    await page.route('**/*', route => route.request().url() === 'http://localhost/' ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
    await page.goto('http://localhost/');
    for (const width of [1440,390]) {
      await page.setViewportSize({ width, height: 960 });
      for (const [mode,title] of [['loading','正在读取持续目标'],['error','持续目标暂时无法读取'],['empty','还没有持续目标'],['data','推进发布准备']]) {
        await page.evaluate(mode => window.renderScenario(mode), mode);
        await page.getByText(title, { exact: true }).first().waitFor();
        if (mode === 'empty') assert.equal(await page.getByRole('button', { name: '新建目标', exact: true }).count(), 1, 'empty state reuses the header action');
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${mode}/${width} horizontal overflow`);
        if(screenshots)await page.screenshot({path:join(screenshots,`${mode}-${width}.png`),fullPage:true});
      }
    }
    await page.getByRole('button',{name:/推进发布准备/}).click();
    const detail=page.getByRole('dialog');await detail.waitFor();
    await detail.getByText('项目：project:opaque · 系统工作模型',{exact:true}).waitFor();
    assert.equal(await detail.getByText(/historical-provider|historical-model/).count(),0);
    if(screenshots)await page.screenshot({path:join(screenshots,'detail-390.png'),fullPage:true});
    await detail.getByRole('button',{name:'暂停目标',exact:true}).click();
    await detail.getByRole('button',{name:'恢复目标',exact:true}).waitFor();
    await detail.getByRole('button',{name:'恢复目标',exact:true}).click();
    await detail.getByRole('button',{name:'停止目标',exact:true}).click();
    const stopConfirmation=page.getByRole('dialog',{name:'停止这个持续目标？',exact:true});
    await stopConfirmation.getByRole('button',{name:'取消',exact:true}).click();
    assert.equal((await page.evaluate(()=>window.calls.filter(row=>row.action==='goalCancel'))).length,0,'cancelling the confirmation never stops the goal');
    await detail.getByRole('button',{name:'停止目标',exact:true}).click();
    await stopConfirmation.getByRole('button',{name:'停止目标',exact:true}).click();
    await detail.getByText('已取消 · 1 项工单',{exact:true}).waitFor();
    const controls=await page.evaluate(()=>window.calls.filter(row=>['goalPause','goalResume','goalCancel'].includes(row.action)));
    assert.deepEqual(controls.map(row=>[row.action,row.input]),[['goalPause',{id:'goal-one',rowVersion:7}],['goalResume',{id:'goal-one',rowVersion:8}],['goalCancel',{id:'goal-one',rowVersion:9}]]);
    await page.keyboard.press('Escape');
    await page.evaluate(()=>{window.catalogFailures=1;});
    await page.getByRole('button',{name:'新建目标',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'项目目录暂时不可用'}).waitFor();
    assert(await page.getByRole('button',{name:'创建目标',exact:true}).isDisabled());
    await page.getByRole('button',{name:'刷新目录',exact:true}).click();
    await page.getByRole('button',{name:'项目',exact:true}).click();
    await page.getByRole('option',{name:'正式项目',exact:true}).click();
    assert.equal(await page.getByRole('option',{name:'不可用项目',exact:true}).count(),0);
    const form=page.getByRole('form',{name:'新建持续目标'});
    await form.getByLabel('目标',{exact:true}).fill('准备下次发布');
    await form.getByLabel('执行要求',{exact:true}).fill('仅整理项目发布说明');
    await form.getByLabel('验收条件（可选）',{exact:true}).fill('说明文件完整');
    await form.getByText('系统工作模型',{exact:true}).waitFor();
    assert.equal(await form.getByRole('button', {name:/供应商|模型/}).count(),0);
    assert.equal(await form.getByText(/legacy-provider|legacy-model|historical-provider|historical-model/).count(),0);
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'creation phone overflow');
    if(screenshots)await page.screenshot({path:join(screenshots,'create-390.png'),fullPage:true});
    await form.getByRole('button',{name:'创建目标',exact:true}).click();
    await page.getByText('准备下次发布',{exact:true}).waitFor();
    const creation=await page.evaluate(()=>window.calls.find(row=>row.action==='goalCreate'));
    assert.deepEqual(Object.keys(creation.input),['goal']);
    assert.deepEqual(Object.keys(creation.input.goal).sort(),['acceptance','objective','projectId','requestId','text']);
    assert.deepEqual({...creation.input.goal,requestId:'redacted'},{objective:'准备下次发布',projectId:'project:opaque',text:'仅整理项目发布说明',acceptance:'说明文件完整',requestId:'redacted'});
    assert.match(creation.input.goal.requestId,/^[0-9a-f-]{36}$/);
    assert((await page.evaluate(()=>window.calls)).some(row=>row.action==='refresh'));
    assert((await page.evaluate(()=>window.calls)).some(row=>row.action==='viewTickets'));
    assert.deepEqual(errors,[]);assert.deepEqual(nativeDialogs,[],'goal controls use custom confirmations');
  } finally {await browser.close();}
});
