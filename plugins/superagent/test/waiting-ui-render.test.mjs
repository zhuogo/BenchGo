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

// Render production components. Only service responses and the host session boundary are fixtures.
// This is functional validation, not a live Desktop restart or visual acceptance.
async function fixture() {
  const result = await build({
    stdin: { resolveDir: root, loader: 'jsx', contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { TicketWaiting } from './plugins/superagent/client/ticket-waiting.jsx';
      import { Tickets } from './plugins/superagent/client/tickets.jsx';
      import { QuietChat } from './plugins/superagent/client/quiet-chat.jsx';
      import { AssistantConversation } from './plugins/superagent/client/conversation.jsx';
      import { AssistantHome } from './plugins/superagent/client/home.jsx';
      import { Evaluations } from './plugins/superagent/client/evaluations.jsx';
      import css from './plugins/superagent/client/style.css';
      import hostCss from './plugins/benchgo/client/style.css';
      const root = createRoot(document.getElementById('root')); let serial = 0;
      window.renderScenario = (surface, state='data', overrides={}) => {
        window.calls=[];
        const control=window.control={state,fail:false};
        const ticket={id:'original',title:'核验工作结果',target:'核验工作结果',status:'waiting',instructionRevision:2,resultVersion:3,
          mandate:{source:{channel:'desktop'}}, createdAt:'2026-11-05T10:00:00Z',updatedAt:'2026-11-05T10:02:00Z',
          results:[{instructionRevision:2,version:3,summary:'原结果正文',outcome:'completed',selfCheck:{summary:'已按要求自检'}}],...overrides};
        const api=async(name,input)=>{
          window.calls.push([name,input]);
          if(control.state==='loading') return new Promise(()=>{});
          if(control.state==='error'||control.fail) throw Error('测试连接暂不可用');
          if(name==='tickets') return {tickets:control.state==='empty'?[]:[ticket]};
          if(name==='goalList') return {goals:[]};
          if(name==='checkpointList') return {checkpoints:[]};
          if(name==='state') return {config:{revision:1,workerConcurrency:2}};
          if(name==='evaluations') return {candidates:control.state==='empty'?[]:[{id:'audit',threadId:'remote',retryCount:2,intakeEvent:{id:'raw',intakeStage:'pending',content:'原始评估正文\\n完整原始证据',source:{channel:'feishu'}}}]};
          if(name==='ticketResume') return control.blocked ? {queued:false,code:'MANDATE_REVOKED'} : {queued:true};
          return {};
        };
        const refresh=()=>{window.calls.push(['refresh']);};
        const resources=(...args)=>window.calls.push(['resources',...args]);
        const home={api,onRefresh:refresh,onOpenResources:resources,threadId:'main',history:{messages:[],notifications:[]},assistantName:'BenchGo'};
        let content;
        if(surface==='waiting') content=<TicketWaiting api={api} ticket={ticket} onRefresh={refresh} onOpenResources={resources}/>;
        if(surface==='tickets') content=<Tickets api={api} requestedTicket={state==='linked'?{ticketId:'original'}:state==='missing'?{ticketId:'missing'}:undefined} onCreateGoal={()=>window.calls.push(['createGoal'])} onOpenGoals={()=>resources('goals')}/>;
        if(surface==='evaluations') content=<Evaluations api={api}/>;
        if(surface==='chat') {
          const notification={eventId:'wait',type:'ticket.attention',threadId:'main',ticketId:ticket.id,ticketStatus:ticket.status,currentInstructionRevision:2,currentResultVersion:3,
            currentExecutionControl:ticket.executionControl,currentResult:ticket.results[0],currentAttention:ticket.attentions?.[0],continuationWait:ticket.continuationWait,text:'请选择本次范围',createdAt:'2026-11-05T10:01:00Z'};
          const events=state==='schedule'?['created','triggered','completed','failed'].map((phase,index)=>({eventId:phase,threadId:'main',type:'schedule.lifecycle',origin:'system',text:'系统定时记录',createdAt:'2026-11-05T10:02:00Z',schedule:{id:'schedule',title:'每日总结',phase,at:'2026-11-05T10:02:00Z',occurrenceAt:'2026-11-05T10:00:00Z',...(index>1?{ticketId:'original'}:{})}})):[notification];
          home.history.notifications=state==='empty'?[]:events;
          content=state==='empty'||state==='home'?<AssistantHome {...home} input={{draft:''}} inputActions={{setDraft(){},persistDraft(){}}}/>:<QuietChat home={home} session={{running:false}}/>;
        }
        if(surface==='connection') {
          const ctx={sessions:{retain(){if(control.state==='error')throw Error('test connection');return {ready:control.state==='loading'?new Promise(()=>{}):Promise.resolve(),release(){window.calls.push(['release']);}}}},uiConversation:{binding(){return {activate:view=>window.calls.push(['activate',view])}}}};
          content=<AssistantConversation ctx={ctx} sessionId='session' SessionProvider={({children})=><>{children}</>} renderSlot={()=><div data-connected=''>聊天已就绪</div>}/>;
        }
        const renderId=++serial;
        root.render(<div className='ba-root' key={renderId} data-fixture-render={renderId}><style>{hostCss}{css}</style><main style={{width:'100%',padding:24}}>{content}</main></div>);
        return renderId;
      };
    ` },
    bundle: true, write: false, outdir: join(root, 'artifacts', 'unused-waiting-test-output'), format: 'iife', jsx: 'automatic',
    nodePaths: [join(root, 'plugins/benchgo/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')],
    alias: { react: dirname(webRequire.resolve('react/package.json')), 'react-dom': dirname(webRequire.resolve('react-dom/package.json')),
      '@deepseek-ai/dsh-client-ui-primitives': join(root, 'deepseek-harness/packages/client/ui-primitives/src/index.ts') },
    loader: { '.css': 'text', '.module.css': 'local-css', '.svg': 'text', '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
    plugins: [sharedUiStyles()], define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
  });
  const css = result.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n');
  const js = result.outputFiles.find(file => file.path.endsWith('.js')).text.replaceAll('</script', '<\\/script');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{--dsw-alias-label-primary:#252528;--dsw-alias-label-secondary:#74747c;--dsw-alias-bg-base:#ffffff}html[data-theme=dark]{--dsw-alias-label-primary:#ededf1;--dsw-alias-label-secondary:#a7a7b2;--dsw-alias-bg-base:#1b1b20}body{margin:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:system-ui,sans-serif}${css}</style></head><body><div id="root"></div><script>${js}</script></body></html>`;
}

test('real waiting controls and chat/ticket connection states remain actionable and version-bound', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const html = await fixture();
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.request().url() === 'http://localhost/' ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
    page.setDefaultTimeout(5000);
    await page.goto('http://localhost/');
    const scenario = async (surface, state = 'data', overrides = {}) => {
      const renderId = await page.evaluate(args => window.renderScenario(...args), [surface, state, overrides]);
      await page.locator(`[data-fixture-render="${renderId}"]`).waitFor();
    };
    const calls = () => page.evaluate(() => window.calls);
    const button = name => page.getByRole('button', { name, exact: true });
    const detail = page.getByRole('region', { name: '任务详情', exact: true });
    await scenario('waiting');
    assert.equal(await button('重试核验').count(), 0);
    await button('刷新记录').click();
    assert.deepEqual((await calls()).slice(0, 1), [['refresh']]);
    await page.evaluate(() => window.control.fail = true);
    await button('停止工单').click();
    await page.getByRole('alert').waitFor();
    assert.match(await page.getByRole('alert').innerText(), /可刷新记录/);
    // Tickets parked by the execution-time gate removed on 2026-11-06 resume without added time.
    await scenario('waiting', 'data', { continuationWait: { code: 'EXECUTION_BUDGET_EXHAUSTED', sourceResultVersion: 3 } });
    assert.equal(await page.getByRole('button', { name: /增加10分钟|额度/ }).count(), 0);
    await button('恢复原单').click();
    assert.deepEqual((await calls())[0], ['ticketResume', { ticketId: 'original', expectedResultVersion: 3 }]);
    await page.evaluate(() => window.control.blocked = true);
    await button('恢复原单').click();
    await page.getByRole('alert').waitFor();
    assert.match(await page.getByRole('alert').innerText(), /MANDATE_REVOKED/);
    for (const code of ['EXECUTION_EFFECTS_UNKNOWN', 'EXECUTION_NOT_VERIFIED', 'EXECUTION_STOP_UNCONFIRMED']) {
      await scenario('waiting', 'data', { continuationWait: { code, sourceResultVersion: 3 } });
      await button('刷新记录').waitFor();
      assert.equal(await page.getByRole('button', { name: /继续|恢复|重试核验/ }).count(), 0);
      await button('刷新记录').click();
      assert.deepEqual(await calls(), [['refresh']]);
      await button('停止工单').click();
      assert((await calls()).some(([name, input]) => name === 'ticketStop' && input.ticketId === 'original'));
    }
    const screenshots = process.env.BENCHGO_WAITING_SCREENSHOTS;
    if (screenshots) await mkdir(screenshots, { recursive: true });
    const uncertainty = { reasonCode: 'WORKER_TURN_INCOMPLETE', reason: '执行回合未提交完整结束记录。', attempts: 2, nextCheckAt: 1794218400000, escalated: false };
    for (const theme of ['light', 'dark']) for (const width of [1440, 390]) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      await page.setViewportSize({ width, height: 960 });
      for (const [name, overrides] of [
        ['checking', { status: 'waiting', execution: { uncertainty } }],
        ['escalated', { status: 'waiting', execution: { uncertainty: { ...uncertainty, attempts: 4, escalated: true } } }],
        ['missing-evidence', { status: 'waiting', execution: { uncertainty: { ...uncertainty, attempts: 0, nextCheckAt: null, automatic: false, recoveryBlocked: '缺少完整结束证据，不据此重跑。' } } }],
        ['stopping', { status: 'waiting', executionControl: { stopRequested: true }, execution: { stopRequestedAt: 1794218300000, stopConfirmationOverdue: false } }],
        ['stop-overdue', { status: 'waiting', executionControl: { stopRequested: true }, execution: { uncertainty, stopRequestedAt: 1794218300000, stopConfirmationOverdue: true } }],
      ]) {
        await scenario('waiting', 'data', overrides);
        const waiting = page.getByLabel('工单等待状态');
        await waiting.getByText(name.startsWith('stop') ? /后续动作已拦截/ : uncertainty.reason, { exact: !name.startsWith('stop') }).waitFor();
        if (name === 'checking' || name === 'stop-overdue') await waiting.getByText('已查 2 次', { exact: true }).waitFor();
        if (name === 'missing-evidence') {
          await waiting.getByText('等待完整恢复证据后安排', { exact: true }).waitFor();
          await waiting.getByText('缺少完整结束证据，不据此重跑。', { exact: true }).waitFor();
          assert.equal(await waiting.getByText(/正在自动核查|继续自动核查/).count(), 0);
        }
        if (name === 'escalated') {
          await waiting.getByText('已查 4 次', { exact: true }).waitFor();
          await waiting.getByText('已提请 Router 跟进，系统继续自动核查。', { exact: true }).waitFor();
        }
        if (name === 'stop-overdue') await waiting.getByText(/执行端仍未确认退出/).waitFor();
        if (name.startsWith('stop')) assert.equal(await button('停止工单').count(), 0, 'a stopping ticket cannot issue a second stop');
        assert.equal(await waiting.getByText(/请先核实|核实当前状态/).count(), 0);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name}/${width} fits viewport`);
        assert.deepEqual(await calls(), [], 'status facts do not dispatch verification or repeat Worker work');
        if (screenshots) await page.screenshot({ path: join(screenshots, `${name}-${theme}-${width}.png`), fullPage: true });
      }
    }
    await page.evaluate(() => document.documentElement.dataset.theme = 'light');
    await page.setViewportSize({ width: 1440, height: 960 });
    await scenario('tickets', 'data', { status: 'waiting', execution: { instructionRevision: 2, uncertainty } });
    const row = page.locator('.ba-task-list-row').first();
    await row.locator('.ba-task-verification').getByText(/已查 2 次.*下次/).waitFor();
    await row.locator('.ba-task-summary').getByText(uncertainty.reason, { exact: true }).waitFor();
    await page.getByRole('tab', { name: '看板', exact: true }).click();
    await page.locator('.ba-ticket-board .ba-task-verification').getByText(/已查 2 次.*下次/).waitFor();
    assert.equal((await calls()).some(([name]) => ['ticketResume', 'ticketStop'].includes(name)), false);
    const question = { id: 'question', state: 'waiting', origin: 'worker', instructionRevision: 2, resultVersion: 3,
      question: { question: '请选择本次范围', options: [{ label: '全部' }] } };
    await scenario('chat', 'data', { attentions: [question] });
    await page.getByRole('radio', { name: '全部' }).check();
    await button('提交答复').click();
    await page.waitForFunction(() => window.calls.some(([name]) => name === 'ticketAnswer'));
    const answer = (await calls()).find(([name]) => name === 'ticketAnswer')[1];
    assert.equal(answer.ticketId, 'original'); assert.equal(answer.attentionId, 'question'); assert.equal(answer.instructionRevision, 2);
    assert.deepEqual(answer.answer, { selected: ['全部'] });
    await scenario('chat', 'schedule');
    await page.getByLabel('主助手对话', { exact: true }).waitFor();
    assert.equal(await page.getByText('系统定时记录', { exact: true }).count(), 0);
    assert.equal(await page.getByLabel('定时任务状态', { exact: true }).count(), 0);
    await scenario('chat', 'home');
    await button('管理任务').first().click();
    assert((await calls()).some(([name, next]) => name === 'resources' && next === 'tasks'));
    await scenario('tickets');
    await page.locator('.ba-task-list').getByText('核验工作结果', { exact: true }).click();
    await detail.getByRole('heading').filter({ hasText: '核验工作结果' }).waitFor();
    assert.equal(await page.getByRole('dialog').count(), 0, 'ticket details remain inside their original container');
    assert(await detail.evaluate(node => !!node.closest('.ba-tasks')));
    await detail.getByRole('button', { name: '返回列表', exact: true }).click();
    await detail.waitFor({ state: 'hidden' });
    await page.locator('.ba-task-list').getByText('核验工作结果', { exact: true }).waitFor();
    await scenario('chat', 'empty');
    await page.locator('.ba-home').waitFor();
    for (const state of ['loading', 'error', 'data']) {
      await scenario('connection', state);
      if (state === 'loading') await page.getByText('正在连接聊天', { exact: true }).waitFor();
      if (state === 'error') {
        await page.getByRole('alert').waitFor();
        await page.evaluate(() => window.control.state = 'data');
        await button('重新连接').click();
      }
      if (state !== 'loading') await page.locator('[data-connected]').waitFor();
    }
    for (const state of ['loading', 'empty', 'error', 'data']) {
      await scenario('tickets', state);
      if (state === 'loading') await page.getByText('正在读取工单', { exact: true }).waitFor();
      if (state === 'empty') {
        await page.getByText('暂无工单', { exact: true }).waitFor();
        assert(await button('新建持续目标').count() > 0);
      }
      if (state === 'error') {
        await page.getByRole('alert').waitFor();
        await page.evaluate(() => window.control.state = 'data');
        await button('重试').click();
      }
      if (state === 'data' || state === 'error') await page.locator('.ba-task-list').getByText('核验工作结果', { exact: true }).waitFor();
    }
    await page.locator('.ba-task-list').getByText('核验工作结果', { exact: true }).click();
    await detail.waitFor();
    assert.equal(await detail.getByRole('button', { name: '停止工单', exact: true }).count(), 1);
    assert.equal(await button('重试核验').count(), 0);
    assert(await button('刷新记录').isVisible());
    await scenario('tickets', 'linked');
    await detail.waitFor();
    assert.equal(await detail.getByRole('heading').filter({ hasText: '核验工作结果' }).count(), 1);
    await scenario('tickets', 'missing');
    await page.getByText('关联工单暂不可用', { exact: true }).waitFor();
    const retriesBefore = (await calls()).filter(([name, input]) => name === 'tickets' && input?.ticketId === 'missing').length;
    await detail.getByRole('button', { name: '重试', exact: true }).click();
    await page.waitForFunction(before => window.calls.filter(([name, input]) => name === 'tickets' && input?.ticketId === 'missing').length > before, retriesBefore);
    await detail.getByText('关联工单暂不可用', { exact: true }).waitFor();
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('intake audit evaluations render loading, empty, error and original data at desktop and mobile widths', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const html = await fixture(), browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.request().url() === 'http://localhost/' ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
    await page.goto('http://localhost/');
    for (const theme of ['light', 'dark']) for (const width of [1440, 390]) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      await page.setViewportSize({ width, height: 900 });
      for (const [state, label] of [['loading', '正在读取评估'], ['empty', '暂无待处置评估'], ['error', '评估暂时无法读取'], ['data', '原始评估正文']]) {
        await page.evaluate(state => window.renderScenario('evaluations', state), state);
        await page.getByText(label, { exact: true }).waitFor();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
      }
      await page.getByText('原始评估正文', { exact: true }).click();
      await page.getByRole('dialog').getByText(/完整原始证据/).waitFor();
      assert.match(await page.getByRole('dialog').innerText(), /feishu/);
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
