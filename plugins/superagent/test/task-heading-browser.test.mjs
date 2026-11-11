import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sharedUiStyles } from '../../benchgo/scripts/shared-ui.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const webRequire = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url));
const { chromium } = webRequire('playwright');
const { build } = createRequire(new URL('../../benchgo/package.json', import.meta.url))('esbuild');
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || [chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);

async function fixture() {
  const result = await build({
    stdin: { resolveDir: root, loader: 'jsx', contents: `
      import React from 'react';import {createRoot} from 'react-dom/client';
      import {Studio,api} from './plugins/superagent/client/index.jsx';
      import {configureAssistantActivity} from './plugins/superagent/client/use-activity.jsx';
      import {createTaskManagement} from './plugins/superagent/src/task-management.mjs';
      import css from './plugins/superagent/client/style.css';
      import hostCss from './plugins/benchgo/client/style.css';
      const root=createRoot(document.getElementById('root'));
      window.renderScenario=(state='data')=>{
        window.calls=[];window.resourceState=state;
        const tasks=createTaskManagement({database:{meta:()=>undefined}});
        const rows=tasks.project('ticket',[{id:'done',title:'检索并汇总 2026',target:'检索公开资料并整理结果',status:'completed',instructionRevision:1,resultVersion:1,
          taskCanOrganize:true,createdAt:'2026-11-07T08:00:00Z',updatedAt:'2026-11-07T08:05:00Z',
          results:[{version:1,summary:'已完成检索。汇总事实，并附上来源与下一步。',evidenceRefs:[]}]}]);
        window.fetch=async(_url,options)=>{
          const input=JSON.parse(options.body);window.calls.push(input);
          if(window.resourceState==='loading')return new Promise(()=>{});
          if(window.resourceState==='error')throw Error('连接暂不可用');
          let value={};
          if(input.action==='tickets')value={tickets:window.resourceState==='empty'||input.archived?[]:rows};
          if(input.action==='goalList')value={goals:[]};
          if(input.action==='state')value={config:{revision:1,workerConcurrency:2}};
          if(input.action==='catalog')value={projects:[]};
          return new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}});
        };
        configureAssistantActivity(api,{connect(sink){const snapshot=()=>{
          if(window.resourceState==='loading')return;
          if(window.resourceState==='error'){sink.failed(Error('连接暂不可用'));return;}
          sink.replace({cursor:0,tickets:window.resourceState==='empty'?[]:rows});
        };return {start(){queueMicrotask(snapshot);},restart:snapshot,dispose(){}};}});
        const info={activePanelId:'benchgo-assistant'};
        const ctx={layout:{selectPanel:id=>window.calls.push({panel:id}),panelInfo:{getSnapshot:()=>info,subscribe:()=>()=>{}}}};
        root.render(<div className='ba-root'><style>{hostCss}{css}</style><Studio snapshot={{config:{revision:1},memories:[]}} ctx={ctx} refresh={async()=>{}} threadId='main' initialSection='tasks' SessionProvider={({children})=>children} renderSlot={()=>null}/></div>);
      };
    ` },
    bundle: true, write: false, outdir: join(root, 'artifacts/unused-task-heading-test'), format: 'iife', jsx: 'automatic',
    nodePaths: [join(root, 'plugins/benchgo/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')],
    alias: { react: dirname(webRequire.resolve('react/package.json')), 'react-dom': dirname(webRequire.resolve('react-dom/package.json')),
      '@deepseek-ai/dsh-client-ui-primitives': join(root, 'deepseek-harness/packages/client/ui-primitives/src/index.ts'),
      '@deepseek-ai/dsh-api-gateway/client': join(root, 'deepseek-harness/packages/api/gateway/lib/client.node.js') },
    plugins: [{ name: 'task-heading-fixture', setup(build) {
      build.onLoad({ filter: /superagent[\\/]client[\\/]index\.jsx$/ }, async ({ path }) => ({ contents: await readFile(path, 'utf8') + '\nexport {Studio,api};', loader: 'jsx' }));
      build.onLoad({ filter: /superagent[\\/]client[\\/]activity-panel\.jsx$/ }, () => ({ contents: 'import React from "react";export const ActivityProvider=({children})=><>{children}</>;export const ActivityPanel=()=>null;export const ActivityTrigger=()=>null;', loader: 'jsx' }));
    } }, sharedUiStyles()],
    loader: { '.css': 'text', '.module.css': 'local-css', '.svg': 'text', '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
    define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
  });
  const css = result.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n');
  const js = result.outputFiles.find(file => file.path.endsWith('.js')).text.replaceAll('</script', '<\\/script');
  const theme = (await Promise.all(['base.css', 'design-platform.css', 'focus.css'].map(name => readFile(join(root, 'deepseek-harness/packages/client/ui-theme/src/styles', name), 'utf8')))).join('\n');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>${theme}${css}body{margin:0;font:14px/1.6 Arial,sans-serif;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}#root,.ba-root{height:100dvh}</style></head><body><div id="root"></div><script>${js}</script></body></html>`;
}

test('task heading aligns category tabs and icon tools remain usable in four resource states and narrow layouts', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const html = await fixture(), browser = await chromium.launch({ headless: true, executablePath });
  const screenshots = process.env.BENCHGO_TASK_HEADING_SCREENSHOTS;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(5000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.request().url() === 'http://localhost/' ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
    const render = async (state, width, dark = false) => {
      await page.setViewportSize({ width, height: 900 }); await page.goto('http://localhost/');
      await page.evaluate(({ state, dark }) => { document.body.toggleAttribute('data-ds-dark-theme', dark); document.documentElement.style.colorScheme = dark ? 'dark' : 'light'; window.renderScenario(state); }, { state, dark });
      await page.getByRole('heading', { name: '任务', exact: true }).waitFor();
    };
    const capture = async name => { if (screenshots) await page.screenshot({ path: join(screenshots, name + '.png'), fullPage: true }); };
    const noOverflow = async () => {
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'page must not overflow horizontally');
      assert(await page.locator('.ba-studio-body').evaluate(node => node.scrollWidth <= node.clientWidth + 1), 'task body must not overflow horizontally');
    };
    for (const width of [1440, 390]) for (const [state, title] of [['loading', '正在读取工单'], ['error', '工单暂时无法读取'], ['empty', '暂无工单'], ['data', '检索并汇总 2026']]) {
      await render(state, width); await page.getByText(title, { exact: true }).waitFor();
      assert(await page.getByRole('tablist', { name: '工作分类', exact: true }).isVisible());
      for (const label of ['归档已结束工单', '定时任务', '设置']) {
        const button = page.getByRole('button', { name: label, exact: true });
        assert(await button.isVisible()); assert.equal((await button.textContent()).trim(), '', label + ' is an icon action');
      }
      await noOverflow(); await capture(`${state}-${width}-light`);
    }
    for (const width of [1440, 1120, 768, 390]) for (const dark of [false, true]) {
      await render('data', width, dark); await page.getByText('检索并汇总 2026', { exact: true }).waitFor();
      const tabs = page.getByRole('tablist', { name: '工作分类', exact: true });
      assert(await page.locator('.ba-studio-heading-row').getByRole('tablist', { name: '工作分类' }).isVisible());
      if (width >= 1120) {
        const title = await page.getByRole('heading', { name: '任务', exact: true }).boundingBox(), box = await tabs.boundingBox();
        assert(Math.abs(title.y + title.height / 2 - box.y - box.height / 2) < 2, JSON.stringify({ width, title, box }));
      }
      await noOverflow(); await capture(`data-${width}-${dark ? 'dark' : 'light'}`);
    }
    const schedule = page.getByRole('button', { name: '定时任务', exact: true });
    await schedule.hover(); await page.getByRole('tooltip').getByText('定时任务', { exact: true }).waitFor();
    await capture('tooltip-mobile-dark');
    await schedule.click(); assert((await page.evaluate(() => window.calls)).some(input => input.panel === 'schedules'));
    await page.getByRole('button', { name: '设置', exact: true }).click();
    assert((await page.evaluate(() => window.calls)).some(input => input.action === 'state'));
    await page.keyboard.press('Escape');
    const categories = page.getByRole('tablist', { name: '工作分类', exact: true });
    await categories.getByRole('tab', { name: '工单', exact: true }).focus(); await page.keyboard.press('ArrowRight');
    assert.equal(await categories.getByRole('tab', { name: '审核', exact: true }).getAttribute('aria-selected'), 'true');
    await page.keyboard.press('ArrowRight');
    const goal = categories.getByRole('tab', { name: '持续目标', exact: true });
    assert.equal(await goal.getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator(`[id="${await goal.getAttribute('aria-controls')}"]`).getAttribute('aria-labelledby'), await goal.getAttribute('id'));
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
