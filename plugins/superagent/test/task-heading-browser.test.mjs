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
const longRequirements = ['# 发布要求', '', '- 核查运行环境', '- 保留验证记录', '', '| 检查项 | 验证目标 |', '| --- | --- |', '| 请求标识 | opaque-' + 'identifier'.repeat(45) + ' |', '', '```js', 'const requestId = "' + 'opaque-identifier-'.repeat(30) + '";', 'console.log(requestId);', '```', '', ...Array.from({ length: 45 }, (_, index) => `长文段落 ${String(index + 1).padStart(2, '0')}：滚动阅读任务要求，并保持标题与操作入口可达。\n`)].join('\n');
const resultMarkdown = ['# 交付结果', '', '- 环境检查完成', '- 证据已整理', '', '| 检查项 | 结果 |', '| --- | --- |', '| 兼容性 | 通过 |', '', '```json', '{"status":"completed"}', '```'].join('\n');

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
      window.renderScenario=(state='data',section='tasks')=>{
        window.calls=[];window.resourceState=state;
        const tasks=createTaskManagement({database:{meta:()=>undefined}});
        const rows=tasks.project('ticket',[{id:'done',title:'检索并汇总 2026',target:'检索公开资料并整理结果',status:'completed',instructionRevision:1,resultVersion:1,
          taskCanOrganize:true,createdAt:'2026-11-07T08:00:00Z',updatedAt:'2026-11-07T08:05:00Z',
          results:[{version:1,summary:'已完成检索。汇总事实，并附上来源与下一步。',evidenceRefs:[]}],
          ...(state==='waiting'?{status:'waiting',resultVersion:0,results:[],executionControl:{stopRequested:true},execution:{instructionRevision:1,summary:{text:'已请求停止，等待执行端确认',history:[]},worker:{id:'main',status:'running',activity:'执行状态待核实'}}}:{}),
          ...(state==='markdown'?{instructionRevision:2,target:${JSON.stringify(longRequirements)},acceptance:'- 验证通过\\n- 保留证据',
            revisions:[{instructionRevision:1,operation:'original',target:'# 初始要求\\n\\n- 检查基础服务',createdAt:'2026-11-07T08:00:00Z'},
              {instructionRevision:2,operation:'revise',target:${JSON.stringify(longRequirements)},acceptance:'- 验证通过\\n- 保留证据',reason:'补充完整验证范围',createdAt:'2026-11-07T08:05:00Z'}],
            results:[{version:1,instructionRevision:2,summary:'已完成检查并整理证据。',finalSummary:${JSON.stringify(resultMarkdown)},evidenceRefs:[]}]}:{})}]);
        const goals=state==='empty'?[]:[{id:'goal-one',objective:'推进发布准备',executionKind:'checklist',status:'active',rowVersion:1,updatedAt:'2026-11-07T08:05:00Z'}];
        window.fetch=async(_url,options)=>{
          const input=JSON.parse(options.body);window.calls.push(input);
          if(window.resourceState==='loading')return new Promise(()=>{});
          if(window.resourceState==='error')throw Error('连接暂不可用');
          let value={};
          if(input.action==='tickets')value={tickets:window.resourceState==='empty'||input.archived?[]:rows};
          if(input.action==='goalList')value={goals};
          if(input.action==='state')value={config:{revision:1,workerConcurrency:2}};
          if(input.action==='catalog')value={projects:[{id:'project',title:'正式项目',available:true}]};
          return new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}});
        };
        configureAssistantActivity(api,{connect(sink){const snapshot=()=>{
          if(window.resourceState==='loading')return;
          if(window.resourceState==='error'){sink.failed(Error('连接暂不可用'));return;}
          sink.replace({cursor:0,tickets:window.resourceState==='empty'?[]:rows});
        };return {start(){queueMicrotask(snapshot);},restart:snapshot,dispose(){}};}});
        const info={activePanelId:'benchgo-assistant'};
        const ctx={layout:{selectPanel:id=>window.calls.push({panel:id}),panelInfo:{getSnapshot:()=>info,subscribe:()=>()=>{}}}};
        root.render(<div className='ba-root'><style>{hostCss}{css}</style><Studio snapshot={{config:{revision:1},memories:[]}} ctx={ctx} refresh={async()=>{}} threadId='main' initialSection={section} SessionProvider={({children})=>children} renderSlot={()=>null}/></div>);
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
    const render = async (state, width, dark = false, section = 'tasks') => {
      await page.setViewportSize({ width, height: 900 }); await page.goto('http://localhost/');
      await page.evaluate(({ state, dark, section }) => { document.body.toggleAttribute('data-ds-dark-theme', dark); document.documentElement.style.colorScheme = dark ? 'dark' : 'light'; window.renderScenario(state, section); }, { state, dark, section });
      await page.getByRole('heading', { name: section === 'goals' ? '目标' : '工单', exact: true }).waitFor();
    };
    const capture = async name => {
      if (!screenshots) return;
      await page.evaluate(async () => { await Promise.all(document.getAnimations().filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation => animation.finished.catch(() => {}))); });
      await page.screenshot({ path: join(screenshots, name + '.png'), fullPage: true, animations: 'disabled' });
    };
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
      assert.equal(await page.getByRole('heading', { name: '工单', exact: true }).count(), 1, 'the page title follows the selected category');
      assert.equal(await page.getByText('查看执行进展，确认结果与下一步。', { exact: true }).count(), 0);
      assert.equal(await page.locator('.ba-ticket-count').count(), 0, 'ticket totals do not add a separate toolbar label');
      const controls = page.locator('.ba-ticket-view-controls');
      assert(await controls.getByRole('button', { name: '归档已结束工单', exact: true }).isVisible(), 'batch archive reuses the former count position');
      const actions = page.locator('.ba-task-list-actions');
      assert.equal(await actions.getByRole('button', { name: '归档已结束工单', exact: true }).count(), 0);
      const tools = await actions.getByRole('button').allTextContents();
      assert.deepEqual(tools.map(text => text.trim()), ['', ''], 'the action row contains schedule and settings');
      assert.equal(await page.getByRole('button', { name: '添加目标', exact: true }).count(), 0);
      for (const label of ['当前工单', '已归档', '列表', '看板']) {
        const tab = controls.getByRole('tab', { name: label, exact: true });
        assert(await tab.isVisible());
        assert.equal((await tab.innerText()).trim(), '', label + ' is an icon tab');
        await tab.focus();
        await page.getByRole('tooltip').getByText(new RegExp('^' + label)).waitFor();
        await tab.blur();
      }
      const searchLayout = await page.getByRole('searchbox', { name: '搜索工单' }).evaluate(input => {
        const icon = input.parentElement.querySelector('.cmd-ui-icon'), box = input.getBoundingClientRect(), glyph = icon.getBoundingClientRect();
        const padding = parseFloat(getComputedStyle(input).paddingLeft);
        return { padding, textStart: box.left + padding, iconEnd: glyph.right };
      });
      assert(searchLayout.padding >= 35 && searchLayout.textStart > searchLayout.iconEnd + 4, 'search placeholder clears its icon: ' + JSON.stringify(searchLayout));
      await noOverflow(); await capture(`${state}-${width}-light`);
    }
    for (const width of [1440, 1120, 768, 390]) for (const dark of [false, true]) {
      await render('data', width, dark); await page.getByText('检索并汇总 2026', { exact: true }).waitFor();
      const tabs = page.getByRole('tablist', { name: '工作分类', exact: true });
      assert(await page.locator('.ba-studio-heading-row').getByRole('tablist', { name: '工作分类' }).isVisible());
      if (width >= 1120) {
        const title = await page.getByRole('heading', { name: '工单', exact: true }).boundingBox(), box = await tabs.boundingBox();
        assert(Math.abs(title.y + title.height / 2 - box.y - box.height / 2) < 2, JSON.stringify({ width, title, box }));
        const toolbar = await page.locator('.ba-ticket-view-controls').evaluate(node => [...node.children].filter(child => child.tagName !== 'STYLE').map(child => { const box = child.getBoundingClientRect(); return box.y + box.height / 2; }));
        assert(Math.max(...toolbar) - Math.min(...toolbar) < 2, `desktop tools share one row: ${toolbar}`);
      }
      await page.locator('.ba-task-open').click();
      const detail = page.getByRole('region', { name: '任务详情', exact: true });
      await detail.waitFor();
      await page.locator('.ba-studio-heading').waitFor({ state: 'detached' });
      assert.equal(await page.locator('.ba-studio-heading').count(), 0, 'ticket details replace the page navigation');
      assert.equal(await page.getByRole('tablist', { name: '工作分类' }).count(), 0);
      assert(await detail.locator('.ba-task-inline-head').getByRole('button', { name: '创建关联调整单', exact: true }).isVisible());
      assert.equal(await detail.getByText(/桌面 ·|渠道已接收|执行尚未结束或已中断，已有记录保留/).count(), 0);
      const contentTabs = detail.getByRole('tablist', { name: '工单详情内容', exact: true });
      assert(await detail.locator('.ba-task-inline-head').getByRole('tablist', { name: '工单详情内容', exact: true }).isVisible(), 'content tabs live beside the ticket title');
      for (const [name, label] of [['执行记录', '记录'], ['任务要求', '要求'], ['结果与证据', '结果']]) {
        const tab = contentTabs.getByRole('tab', { name, exact: true });
        assert.equal((await tab.innerText()).trim(), label);
        assert(await tab.locator('svg').count() >= 1, 'each short tab retains its icon');
      }
      if (width >= 1120) {
        const headingBox = await detail.getByRole('heading', { name: /检索并汇总 2026/ }).boundingBox(), tabsBox = await contentTabs.boundingBox(), actionBox = await detail.getByRole('button', { name: '创建关联调整单', exact: true }).boundingBox();
        assert(headingBox.x + headingBox.width <= tabsBox.x && tabsBox.x + tabsBox.width <= actionBox.x, 'desktop header places content tabs between title and action');
        assert(Math.abs(headingBox.y + headingBox.height / 2 - tabsBox.y - tabsBox.height / 2) < 2, 'title and content tabs share a row');
      }
      assert.equal(await contentTabs.getByRole('tab', { name: '执行记录', exact: true }).getAttribute('aria-selected'), 'true');
      await noOverflow(); await capture(`detail-${width}-${dark ? 'dark' : 'light'}`);
      for (const label of ['任务要求', '结果与证据', '执行记录']) {
        const tab = contentTabs.getByRole('tab', { name: label, exact: true });
        await tab.click();
        const panel = detail.getByRole('tabpanel', { name: label, exact: true });
        await panel.waitFor();
        assert.equal(await panel.getAttribute('id'), await tab.getAttribute('aria-controls'));
        await noOverflow(); await capture(`detail-${label}-${width}-${dark ? 'dark' : 'light'}`);
      }
      for (let repeat = 0; repeat < 2; repeat++) {
        await detail.getByRole('button', { name: '创建关联调整单', exact: true }).click();
        assert.equal(await contentTabs.getByRole('tab', { name: '任务要求', exact: true }).getAttribute('aria-selected'), 'true');
        await detail.getByRole('heading', { name: /创建关联调整单 · 要求版本/ }).waitFor();
        await detail.getByRole('button', { name: '取消', exact: true }).click();
      }
      await detail.getByRole('button', { name: '返回列表', exact: true }).click();
      await tabs.waitFor();
      await noOverflow(); await capture(`data-${width}-${dark ? 'dark' : 'light'}`);
    }
    for (const width of [1440, 390]) for (const dark of [false, true]) {
      await render('markdown', width, dark);
      await page.locator('.ba-task-open').click();
      const detail = page.getByRole('region', { name: '任务详情', exact: true });
      await detail.waitFor();
      await detail.getByRole('tab', { name: '任务要求', exact: true }).click();
      const requirements = detail.getByRole('tabpanel', { name: '任务要求', exact: true });
      const current = requirements.getByRole('button', { name: '要求版本 2 当前', exact: true });
      const original = requirements.getByRole('button', { name: '要求版本 1', exact: true });
      assert.equal(await current.getAttribute('aria-expanded'), 'true', 'current requirements start expanded');
      assert.equal(await original.getAttribute('aria-expanded'), 'false', 'older requirements start collapsed');
      assert.equal(await requirements.getByRole('button', { name: '要求修订历史', exact: true }).count(), 0, 'versions have one authoritative presentation');
      await requirements.getByRole('heading', { name: '发布要求', level: 1, exact: true }).waitFor();
      assert.equal(await requirements.getByRole('listitem').filter({ hasText: '核查运行环境' }).count(), 1);
      assert.equal(await requirements.getByRole('table').count(), 1, 'GFM tables use the official renderer');
      assert.equal(await requirements.locator('pre code').filter({ hasText: 'const requestId' }).count(), 1, 'fenced code is rendered as code');
      await original.click();
      await requirements.getByRole('heading', { name: '初始要求', exact: true }).waitFor();
      await original.click();
      assert.equal(await original.getAttribute('aria-expanded'), 'false');
      await current.click();
      assert.equal(await current.getAttribute('aria-expanded'), 'false');
      await capture(`requirements-versions-${width}-${dark ? 'dark' : 'light'}`);
      await current.click();
      await noOverflow(); await capture(`requirements-markdown-${width}-${dark ? 'dark' : 'light'}`);
      const text = requirements.getByText('长文段落 08：滚动阅读任务要求，并保持标题与操作入口可达。', { exact: true });
      await text.scrollIntoViewIfNeeded();
      const scroller = page.locator('.ba-studio-body');
      const before = await scroller.evaluate(node => node.scrollTop);
      await text.hover();
      await page.mouse.wheel(0, 480);
      await page.waitForFunction(top => document.querySelector('.ba-studio-body').scrollTop > top + 100, before);
      const headerBox = await detail.locator('.ba-task-inline-head').boundingBox();
      assert(headerBox.y >= 0 && headerBox.y + headerBox.height <= 900, 'long document scrolling keeps the title and content tabs within reach');
      assert(await requirements.evaluate(node => {
        const scrolls = element => /(auto|scroll)/.test(getComputedStyle(element).overflowY) && element.scrollHeight > element.clientHeight + 1;
        for (let element = node; element && !element.matches('.ba-studio-body'); element = element.parentElement) if (scrolls(element)) return false;
        return true;
      }), 'inline Markdown leaves vertical scrolling to the task container');
      assert(await requirements.getByRole('table').evaluate(node => node.scrollWidth >= node.clientWidth));
      await noOverflow();
      await capture(`requirements-markdown-scroll-${width}-${dark ? 'dark' : 'light'}`);
      await scroller.evaluate(node => { node.scrollTop = 0; });
      await detail.getByRole('tab', { name: '结果与证据', exact: true }).click();
      const result = detail.getByRole('tabpanel', { name: '结果与证据', exact: true });
      await result.getByRole('heading', { name: '交付结果', level: 1, exact: true }).waitFor();
      assert.equal(await result.getByRole('table').count(), 1);
      assert.equal(await result.getByRole('listitem').filter({ hasText: '环境检查完成' }).count(), 1);
      assert.equal(await result.locator('pre code').filter({ hasText: '"status":"completed"' }).count(), 1);
      await noOverflow(); await capture(`result-markdown-${width}-${dark ? 'dark' : 'light'}`);
      await detail.getByRole('tab', { name: '任务要求', exact: true }).click();
      assert.equal(await original.getAttribute('aria-expanded'), 'false', 'version choices survive content tab switches');
      assert.equal(await current.getAttribute('aria-expanded'), 'true');
      await detail.getByRole('button', { name: '返回列表', exact: true }).click();
    }
    for (const width of [1440, 390]) for (const dark of [false, true]) {
      await render('waiting', width, dark);
      await page.locator('.ba-task-open').click();
      const waiting = page.getByRole('region', { name: '工单等待状态', exact: true });
      await waiting.waitFor();
      const row = await waiting.evaluate(node => {
        const reason = node.querySelector('.ba-ticket-waiting-reason'), icon = node.querySelector('[role=img]'), actions = node.querySelector('.ba-row-actions');
        const center = item => { const box = item.getBoundingClientRect(); return box.y + box.height / 2; };
        return { height: node.getBoundingClientRect().height, centers: [reason, icon, actions].map(center), whiteSpace: getComputedStyle(reason).whiteSpace };
      });
      assert.equal(row.whiteSpace, 'nowrap');
      assert(row.height <= 52 && Math.max(...row.centers) - Math.min(...row.centers) < 2, JSON.stringify(row));
      await noOverflow(); await capture(`waiting-detail-${width}-${dark ? 'dark' : 'light'}`);
      await page.getByRole('button', { name: '返回列表', exact: true }).click();
      await page.getByRole('tablist', { name: '工作分类', exact: true }).waitFor();
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
    await page.getByRole('heading', { name: '审核', level: 1, exact: true }).waitFor();
    assert.equal(await page.getByText('跟进工单，在审核中集中处理待授权操作。', { exact: true }).count(), 0);
    assert.equal(await page.locator('.ba-review-heading h2,.ba-review-heading p').count(), 0);
    await page.keyboard.press('ArrowRight');
    const tickets = categories.getByRole('tab', { name: '工单', exact: true });
    assert.equal(await tickets.getAttribute('aria-selected'), 'true');
    assert.equal(await categories.getByRole('tab').count(), 2);
    assert.equal(await page.locator(`[id="${await tickets.getAttribute('aria-controls')}"]`).getAttribute('aria-labelledby'), await tickets.getAttribute('id'));
    const choose = async (label, width) => {
      if (width > 760) await page.getByRole('navigation', { name: '资源分区', exact: true }).getByRole('button', { name: new RegExp('^' + label + '(?:\\s|$)') }).click();
      else {
        await page.getByRole('button', { name: '资源分区', exact: true }).click();
        await page.getByRole('option', { name: new RegExp('工作区 · ' + label) }).click();
      }
    };
    for (const width of [1440, 390]) {
      for (const [state, title] of [['loading', '正在读取目标'], ['error', '目标暂时无法读取'], ['empty', '还没有目标'], ['data', '推进发布准备']]) {
        await render(state, width, false, 'goals');
        await page.getByText(title, { exact: true }).waitFor();
        assert.equal(await page.getByRole('tablist', { name: '工作分类' }).count(), 0);
        assert.equal(await page.getByText('待处置评估', { exact: true }).count(), 0);
        assert.equal(await page.getByRole('heading', { level: 1 }).count(), 1);
        assert.equal(await page.getByRole('heading', { name: '持续目标', exact: true }).count(), 0);
        await noOverflow(); await capture(`goals-${state}-${width}-light`);
        if (state === 'error') {
          await page.evaluate(() => { window.resourceState = 'data'; });
          await page.getByRole('button', { name: '重试', exact: true }).click();
          await page.getByText('推进发布准备', { exact: true }).waitFor();
        }
      }
      await render('data', width, true, 'goals');
      await page.getByText('推进发布准备', { exact: true }).waitFor();
      await capture(`goals-data-${width}-dark`);
      await choose('任务', width);
      assert.equal(await page.getByRole('button', { name: '添加目标', exact: true }).count(), 0);
      await choose('目标', width);
      await page.getByRole('heading', { name: '目标', exact: true }).waitFor();
      assert.equal(await page.getByRole('form', { name: '添加目标' }).count(), 0);
      await page.getByRole('button', { name: '编辑目标', exact: true }).click();
      const form = page.getByRole('form', { name: '编辑目标' });
      await form.getByRole('textbox', { name: '目标内容', exact: true }).fill('保留跨页目标草稿');
      await choose('任务', width);
      await page.getByRole('heading', { name: '工单', exact: true }).waitFor();
      await choose('目标', width);
      await capture(`goals-draft-return-${width}`);
      assert.equal(await page.locator('.ba-studio-body').getAttribute('data-section'), 'goals');
      assert.equal(await form.getByRole('textbox', { name: '目标内容', exact: true }).inputValue(), '保留跨页目标草稿');
      await form.getByRole('button', { name: '取消', exact: true }).click();
      await page.getByText('推进发布准备', { exact: true }).waitFor();
      assert(await page.getByRole('heading', { name: '目标', exact: true }).isVisible());
      assert.equal((await page.evaluate(() => window.calls)).some(input => input.action === 'catalog'), false);
      assert.equal((await page.evaluate(() => window.calls)).filter(input => input.action === 'goalCreate').length, 0);
      await noOverflow();
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
