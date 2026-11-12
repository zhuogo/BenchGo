import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sharedUiStyles } from '../../benchgo/scripts/shared-ui.mjs';
import { officialUiEntries } from '../../link/scripts/official-ui.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url));
const { chromium } = require('playwright');
const { build } = createRequire(new URL('../../benchgo/package.json', import.meta.url))('esbuild');
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || [chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);

async function fixture() {
  const bundle = await build({ stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React,{createContext,useContext} from 'react';import {createRoot} from 'react-dom/client';
    import {ApprovalReview,OfficialReviewApproval} from './plugins/superagent/client/approval-review.jsx';
    import {QuietChat} from './plugins/superagent/client/quiet-chat.jsx';
    import {approvalReminderNavigation} from './plugins/superagent/client/approval-flow.mjs';
    import {ApprovalCard} from './deepseek-harness/packages/client/ui-approval/src/client/ApprovalCard.tsx';
    import {PendingApproval} from './deepseek-harness/packages/client/ui-approval/src/client/contract/slots.ts';
    import css from './plugins/superagent/client/style.css';import hostCss from './plugins/benchgo/client/style.css';
    const root=createRoot(document.getElementById('root')), Scope=createContext(null);let serial=0;
    const SessionProvider=({session,children})=><Scope.Provider value={session.id}>{children}</Scope.Provider>;
    const labels={waiting:'等待你的决定',reject:'拒绝',allowOnce:'允许本次',allowAlways:'始终允许','detail.aria':'本次动作详情'};
    function CardSlot(){const sessionId=useContext(Scope);return <OfficialReviewApproval renderFactorySlot={(name,props)=>{
      if(name!=='conversation.approval.card'||props.onAlways)throw Error('wrong official factory or persistent choice');
      return <div data-session-scope={sessionId}><ApprovalCard {...props} t={key=>labels[key]||key} renderSlot={(_name,{callId})=><pre data-call-id={callId}>原会话工具调用详情</pre>}/></div>;
    }}/>;}
    window.renderScenario=(mode='data')=>{
      window.answers=[];window.calls=[];window.retains=[];window.releases=[];window.trace=[];window.reviewCounts=[];window.mode=mode;const listeners=new Set();
      const controller=new AbortController();
      const frozen={actionId:'action-original',category:'external-send',origin:null,target:{channel:'feishu',chatId:'private-chat'},content:{text:'BENCHGO_APPROVAL_ONCE'}};
      const worker=new PendingApproval('worker-session',{toolName:'assistant_external_action',callId:'call-original',reason:'批准本次具体外部动作（仅本次有效）：\\n'+JSON.stringify(frozen),signal:controller.signal});
      const router=new PendingApproval('router-side',{toolName:'assistant_ticket_change',callId:'router-call',reason:'扩大任务范围以调查新的站点？'});
      const unrelated=new PendingApproval('unrelated-session',{toolName:'other',reason:'不得出现的无来源审批'});unrelated.result.catch(()=>{});
      let statuses=new Map([['worker-session',{pendingInteraction:worker}],['router-side',{pendingInteraction:router}],['unrelated-session',{pendingInteraction:unrelated}],['question-session',{pendingInteraction:{kind:'question',answerable:true,sessionId:'question-session'}}]]);
      const publish=()=>{for(const listener of listeners)listener();};
      worker.result.then(value=>{window.answers.push({sessionId:worker.sessionId,value});statuses=new Map(statuses);statuses.delete(worker.sessionId);publish();},()=>{});
      router.result.then(value=>{window.answers.push({sessionId:router.sessionId,value});statuses=new Map(statuses);statuses.delete(router.sessionId);publish();},()=>{});
      const origin={kind:'worker',ticketId:'ticket',title:'发送飞书验证消息',sourceTitle:'主聊天',assignmentId:'assignment',runId:'run',sessionId:'worker-session',ownerThreadId:'main',ownerSessionId:'router-main'};
      const routerOrigin={kind:'router',title:'扩展调研范围',sourceTitle:'客户研究旁聊',sessionId:'router-side',ownerSessionId:'router-side',ownerThreadId:'side'};
      const reminder={id:'reply:reminder',requestId:'reminder',seq:1,role:'assistant',kind:'final',text:'飞书消息已备好，请你决定是否发送。',approval:{sessionId:'worker-session',callId:'call-original',approvalId:'asked-original',actionId:'action-original',ticketId:'ticket',assignmentId:'assignment',runId:'run',ownerThreadId:'main',eventKey:'approval:worker-session:asked-original'}};
      let origins=[origin,routerOrigin,{kind:'router',title:'普通提问',sessionId:'question-session',ownerSessionId:'question-session',ownerThreadId:'question'}];
      window.addReviewCopies=()=>{for(let index=0;index<24;index++){const sessionId='extra-'+index;const pending=new PendingApproval(sessionId,{toolName:'assistant_external_action',reason:'受控验证动作 '+index});pending.result.catch(()=>{});statuses.set(sessionId,{pendingInteraction:pending});origins.push({...origin,title:'受控验证动作 '+index,sessionId,runId:'run-'+index});}statuses=new Map(statuses);publish();document.dispatchEvent(new Event('benchgo:assistant-changed'));};
      window.stop=()=>{origins=origins.filter(item=>item!==origin);controller.abort(Error('工单已停止'));statuses=new Map(statuses);statuses.delete(worker.sessionId);publish();document.dispatchEvent(new Event('benchgo:assistant-changed'));};
      window.answerElsewhere=()=>worker.answer('rejected');window.removeRouter=()=>{origins=origins.filter(item=>item!==routerOrigin);document.dispatchEvent(new Event('benchgo:assistant-changed'));};
      const opened=new Map();window.failOpened=(id)=>{const entry=opened.get(id);entry.state={openState:'error',openError:Error('会话已断开',{cause:Error('原始日志无法读取')})};for(const listener of entry.listeners)listener();};
      const ctx={uiSession:{sessionStatus:{subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},getSnapshot:()=>statuses}},sessions:{retain:(id)=>{window.retains.push(id);window.trace.push('retain:'+id);if(window.mode==='connection-error')throw Error('断开连接');const entry={listeners:new Set(),state:{openState:window.mode==='open-error'?'error':'open',openError:window.mode==='open-error'?Error('读取会话失败',{cause:Error('system event must be first')}):null}};opened.set(id,entry);const binding={session:{getSnapshot:()=>entry.state,subscribe:fn=>{entry.listeners.add(fn);return()=>entry.listeners.delete(fn);}}};return {id,sessionId:id,binding,ready:window.mode==='open-reject'?Promise.reject(Error('打开请求被拒绝')):Promise.resolve(binding),release(){window.releases.push(id);}};}}};
      const api=async(action,input,signal)=>{window.calls.push({action,input});if(action==='history')return {messages:input.before?[reminder]:[],hasMore:!input.before,nextBefore:input.before?null:100};if(!['approvalOrigins','ensure'].includes(action))throw Error('obsolete API');
        if(action==='ensure'){window.trace.push('ensure:'+input.threadId);if(input.threadId==='side'&&window.mode==='ensure-error')throw Error('对话准备失败');
          if(input.threadId==='side'&&window.mode==='ensure-wait')return new Promise(resolve=>{window.completeEnsure=resolve;signal?.addEventListener('abort',()=>window.trace.push('abort-ensure:side'),{once:true});});
          return {sessionId:input.threadId==='side'?(window.mode==='replacement'?'router-new':'router-side'):'question-session'};}
        if(window.mode==='loading')return new Promise(()=>{});if(window.mode==='transient')throw new TypeError('Failed to fetch');if(window.mode==='error')throw Error('审核服务暂时不可用');
        return {origins:window.mode==='empty'?[]:input.sessionId?origins.filter(origin=>origin.sessionId===input.sessionId):origins};};
      let active=true;const scenarioKey=++serial;const counts=value=>window.reviewCounts.push(value);
      let loaded=false;window.loadCalls=0;
      const render=()=>root.render(<div key={scenarioKey} className='ba-root'><style>{hostCss}{css}</style><main style={{padding:24,maxWidth:1120,margin:'auto',boxSizing:'border-box'}}><ApprovalReview ctx={ctx} api={api} SessionProvider={SessionProvider} renderSlot={()=> <CardSlot/>} compact={mode==='compact'} active={active} onCountChange={counts} onOpenReminder={mode==='inline'?()=>{window.navigated=true;render();}:undefined}/>{mode==='inline'&&<QuietChat home={{ctx,api,threadId:'main',sessionId:'router-main',sessionStatus:ctx.uiSession.sessionStatus,SessionProvider,renderSlot:()=> <CardSlot/>,history:{messages:loaded?[reminder]:[],hasMore:!loaded},onLoadEarlier:async()=>{window.loadCalls++;loaded=true;render();}}} session={{running:false}}/>}{mode==='double'&&<ApprovalReview ctx={ctx} api={api} SessionProvider={SessionProvider} renderSlot={()=> <CardSlot/>}/>}</main></div>);
      window.loadReminder=()=>{loaded=true;render();};
      window.approvalTarget=()=>approvalReminderNavigation.getSnapshot();
      window.setReviewActive=value=>{active=value;render();};render();
    };
  ` }, bundle: true, write: false, outdir: join(root, 'artifacts', 'unused-review-ui-test'), format: 'iife', jsx: 'automatic',
    nodePaths: [join(root, 'plugins/benchgo/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')],
    alias: { ...await officialUiEntries(), react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')) },
    loader: { '.css': 'text', '.module.css': 'local-css', '.svg': 'text', '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' }, plugins: [sharedUiStyles()], define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  const script = bundle.outputFiles.find(file => file.path.endsWith('.js')).text;
  const styles = bundle.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n');
  const theme = (await Promise.all(['base.css', 'design-platform.css', 'focus.css'].map(name => readFile(join(root, 'deepseek-harness/packages/client/ui-theme/src/styles', name), 'utf8')))).join('\n');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
    ${theme}
    body{margin:0;font:14px/1.6 var(--dsw-font-family);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}.ba-root{height:auto!important;min-width:0!important}
    ${styles}</style></head><body><div id="root"></div><script>${script.replaceAll('</script', '<\\/script')}</script></body></html>`;
}

test('review Tab renders official Worker and Router approvals in four states; decisions, stale source and another-view settlement use the same pending', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const screenshots = process.env.BENCHGO_REVIEW_SCREENSHOTS;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  try {
    const page = await browser.newPage(), errors = [];
    page.setDefaultTimeout(6000); page.on('pageerror', error => errors.push(error.message));
    const openWorker = async () => { await page.getByRole('button', { name: /发送飞书验证消息 主聊天/ }).click(); await page.getByRole('button', { name: '允许本次', exact: true }).waitFor(); };
    const html = await fixture();
    await page.route('**/*', route => route.request().url() === 'http://localhost/' ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
    await page.goto('http://localhost/');
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 960 });
      for (const [mode, text] of [['loading', '正在同步待审核操作'], ['empty', '没有待审核的操作'], ['error', '审核列表暂时无法读取'], ['data', 'BENCHGO_APPROVAL_ONCE']]) {
        await page.evaluate(mode => window.renderScenario(mode), mode);
        if (mode === 'data') await page.getByRole('button', { name: /发送飞书验证消息 主聊天/ }).click();
        await page.getByText(text, { exact: true }).first().waitFor();
        if (mode === 'data') await page.getByRole('button', { name: '允许本次', exact: true }).waitFor();
        else assert.equal(await page.locator('[data-approval-key]').count(), 0, mode);
        assert.equal(await page.getByText('始终允许', { exact: true }).count(), 0);
        assert.equal(await page.getByText('不得出现的无来源审批', { exact: true }).count(), 0);
        assert.equal(await page.getByText('普通提问', { exact: true }).count(), 0);
        assert.equal(await page.getByRole('button', { name: '刷新审核', exact: true }).count(), 1);
        assert.equal(await page.getByRole('button', { name: '刷新审核', exact: true }).textContent(), '', 'refresh uses an icon with an accessible tooltip label');
        assert.equal(await page.locator('.ba-review-heading h2, .ba-review-heading p').count(), 0, 'page title and description are supplied by the task page');
        assert.equal(await page.getByRole('button', { name: /^(刷新列表|重新读取|重新连接)$/ }).count(), 0);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${mode}/${width} overflow`);
        if (screenshots) await page.screenshot({ path: join(screenshots, `${mode}-${width}.png`), fullPage: true });
      }
    }
    assert.equal(await page.locator('[data-session-scope="worker-session"] [data-call-id="call-original"]').count(), 1);
    assert(await page.evaluate(() => window.trace.indexOf('ensure:side') < window.trace.indexOf('retain:router-side')));
    assert(await page.evaluate(() => !window.calls.some(call => call.action === 'ensure' && call.input.threadId === 'main')));
    await page.getByRole('button', { name: '允许本次', exact: true }).click();
    await page.waitForFunction(() => window.answers.length === 1);
    assert.deepEqual(await page.evaluate(() => window.answers), [{ sessionId: 'worker-session', value: 'allowed-once' }]);
    assert(await page.evaluate(() => window.calls.some(call => call.action === 'approvalOrigins' && call.input.sessionId === 'worker-session' && call.input.toolName === 'assistant_external_action')));
    await page.evaluate(() => window.renderScenario('data'));
    await page.getByRole('button', { name: /扩展调研范围 客户研究旁聊/ }).click();
    await page.getByText('扩大任务范围以调查新的站点？', { exact: true }).waitFor();
    assert.equal(await page.locator('[data-session-scope="router-side"]').count(), 1);
    await page.getByRole('button', { name: '拒绝', exact: true }).click();
    await page.waitForFunction(() => window.answers.length === 1);
    assert.deepEqual(await page.evaluate(() => window.answers), [{ sessionId: 'router-side', value: 'rejected' }]);
    await page.evaluate(() => window.renderScenario('data'));
    await openWorker();
    await page.evaluate(() => window.stop());
    await page.waitForFunction(() => !document.querySelector('[data-session-scope="worker-session"]'));
    assert.deepEqual(await page.evaluate(() => window.answers), []);
    await page.evaluate(() => window.renderScenario('data'));
    await openWorker();
    await page.evaluate(() => window.answerElsewhere());
    await page.waitForFunction(() => !document.querySelector('[data-session-scope="worker-session"]'));
    assert.deepEqual(await page.evaluate(() => window.answers), [{ sessionId: 'worker-session', value: 'rejected' }]);
    await page.evaluate(() => window.renderScenario('data'));
    await openWorker();
    const approval = await page.locator('[data-approval-key]').elementHandle();
    const releasedBefore = await page.evaluate(() => window.releases.length);
    await page.evaluate(() => { window.mode = 'transient'; document.dispatchEvent(new Event('benchgo:assistant-changed')); });
    await page.waitForFunction(() => document.querySelector('.ba-approval-review').dataset.syncState === 'reconnecting');
    assert.equal(await page.getByText('审核列表暂时无法读取', { exact: true }).count(), 0,'background transport read stays silent');
    assert(await approval.evaluate(node => node.isConnected),'the original approval remains mounted');
    assert.equal(await page.evaluate(() => window.releases.length),releasedBefore,'background reconnect retains official sessions');
    assert.equal(await page.evaluate(() => window.reviewCounts.at(-1)),null,'a stale origin index is not reported as complete');
    await page.getByRole('button', { name: '允许本次', exact: true }).click();
    await page.getByText('Failed to fetch', { exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.answers),[],'a user decision still revalidates its origin and exposes failure');
    await page.getByRole('button', { name: '刷新审核', exact: true }).click();
    await page.getByText('审核列表暂时无法读取', { exact: true }).waitFor();
    await page.evaluate(() => { window.mode = 'data'; });
    await page.getByRole('button', { name: '刷新审核', exact: true }).click();
    await page.getByRole('button', { name: '允许本次', exact: true }).waitFor();
    await page.evaluate(() => { window.mode = 'error'; document.dispatchEvent(new Event('benchgo:assistant-changed')); });
    await page.getByText('审核列表暂时无法读取', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.releases.length),releasedBefore,'a read error does not dispose valid official sessions');
    assert.equal(await page.locator('[data-approval-key]').count(), 0);
    await page.evaluate(() => window.renderScenario('error'));
    await page.getByRole('button', { name: '刷新审核', exact: true }).waitFor();
    await page.evaluate(() => { window.mode = 'data'; });
    await page.getByRole('button', { name: '刷新审核', exact: true }).click();
    await openWorker();
    await page.evaluate(() => window.renderScenario('replacement'));
    await openWorker();
    await page.waitForFunction(() => window.calls.some(call => call.action === 'ensure' && call.input.threadId === 'side'));
    assert(!(await page.evaluate(() => window.retains.includes('router-side'))));
    assert.equal(await page.getByRole('button', { name: /扩展调研范围 客户研究旁聊/ }).count(), 0);
    await page.evaluate(() => window.renderScenario('ensure-error'));
    await openWorker();
    await page.getByRole('button', { name: '返回审核列表', exact: true }).click();
    await page.getByText('以下会话尚未连接，无法确认其中的待审核操作。', {exact:true}).waitFor();
    await page.getByText('对话准备失败', {exact:true}).waitFor();
    await page.getByText('准备对话（ensure）', {exact:true}).waitFor();
    assert(!(await page.evaluate(() => window.retains.includes('router-side'))));
    await page.evaluate(() => window.renderScenario('ensure-wait'));
    await page.waitForFunction(() => typeof window.completeEnsure === 'function');
    await page.evaluate(() => window.removeRouter());
    await page.waitForFunction(() => window.trace.includes('abort-ensure:side'));
    await page.evaluate(() => window.completeEnsure({sessionId:'router-side'}));
    assert(!(await page.evaluate(() => window.retains.includes('router-side'))));
    await page.evaluate(() => window.renderScenario('connection-error'));
    await page.getByText('部分会话暂未连接', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '允许本次', exact: true }).count(), 0);
    await page.getByText('保留会话（retain）', { exact: true }).first().waitFor();
    await page.getByText('断开连接', { exact: true }).first().waitFor();
    assert.equal(await page.getByText('没有待审核的操作', { exact: true }).count(), 0);
    for(const mode of ['open-error','open-reject']) {
      await page.evaluate(mode=>window.renderScenario(mode),mode);
      await page.getByText('打开会话（open）', { exact: true }).first().waitFor();
      await page.getByText(mode==='open-error'?'读取会话失败；原因：system event must be first':'打开请求被拒绝', { exact: true }).first().waitFor();
      assert.equal(await page.getByRole('button', { name: '允许本次', exact: true }).count(), 0);
      assert.equal(await page.getByText('没有待审核的操作', { exact: true }).count(), 0);
      if(screenshots)await page.screenshot({path:join(screenshots,mode+'.png'),fullPage:true});
    }
    await page.evaluate(()=>window.renderScenario('data'));
    await openWorker();
    await page.evaluate(()=>window.failOpened('worker-session'));
    await page.getByText('会话已断开；原因：原始日志无法读取', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '允许本次', exact: true }).count(), 0); // A stale detail never automatically switches to another approval.
    assert.equal(await page.locator('[data-session-scope="worker-session"]').count(), 0);
    assert.deepEqual(await page.evaluate(()=>window.answers), []);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('trusted Router reminder mounts the same official card and review navigation loads and focuses its exact historical message', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage(), errors = [];
    page.setDefaultTimeout(6000); page.on('pageerror', error => errors.push(error.message));
    const html = await fixture();
    await page.route('**/*', route => route.request().url() === 'http://localhost/' ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
    await page.goto('http://localhost/');
    await page.evaluate(() => window.renderScenario('inline'));
    await page.getByRole('button', { name: /发送飞书验证消息 主聊天/ }).click();
    await page.getByRole('button', { name: '查看对话中的审批', exact: true }).click();
    const message = page.locator('[data-approval-request="reminder"]');
    await message.locator('[data-call-id="call-original"]').waitFor();
    assert.equal(await page.evaluate(() => window.loadCalls), 1, 'loads only the missing history page');
    assert(await message.evaluate(node => document.activeElement === node), 'focuses the exact original reminder');
    assert.equal(await page.evaluate(() => window.approvalTarget()), null, 'consumes only the matched navigation intent');
    assert.deepEqual(await page.evaluate(() => window.calls.filter(call => call.action === 'history').map(call => call.input)), [{ threadId: 'main' }, { threadId: 'main', before: 100 }]);
    assert.equal(await page.getByRole('button', { name: '允许本次', exact: true }).count(), 2, 'review and inline display one native PendingApproval');
    if (process.env.BENCHGO_REVIEW_SCREENSHOTS) await page.screenshot({ path: join(process.env.BENCHGO_REVIEW_SCREENSHOTS, 'inline-pending.png'), fullPage: true });
    await message.getByRole('button', { name: '允许本次', exact: true }).click();
    await page.waitForFunction(() => window.answers.length === 1);
    assert.deepEqual(await page.evaluate(() => window.answers), [{ sessionId: 'worker-session', value: 'allowed-once' }]);
    await page.getByRole('button', { name: '允许本次', exact: true }).waitFor({ state: 'hidden' });
    assert.equal(await message.count(), 1, 'settlement preserves the Router message');
    await page.evaluate(() => window.renderScenario('inline'));
    await page.getByRole('button', { name: /发送飞书验证消息 主聊天/ }).click();
    await page.evaluate(() => window.loadReminder());
    await message.getByRole('button', { name: '拒绝', exact: true }).waitFor();
    await page.evaluate(() => window.stop());
    await message.getByRole('button', { name: '拒绝', exact: true }).waitFor({ state: 'hidden' });
    assert.deepEqual(await page.evaluate(() => window.answers), [], 'stop invalidates both cards without answering');
    assert.deepEqual(errors, []);
    if (process.env.BENCHGO_REVIEW_SCREENSHOTS) await page.screenshot({ path: join(process.env.BENCHGO_REVIEW_SCREENSHOTS, 'inline-settled.png'), fullPage: true });
  } finally { await browser.close(); }
});

test('review preserves its list through compact detail navigation and shares one approval across both mounted views', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 }, reducedMotion: 'reduce' }), errors = [];
    page.setDefaultTimeout(6000); page.on('pageerror', error => errors.push(error.message));
    const html = await fixture();
    await page.route('**/*', route => route.request().url() === 'http://localhost/' ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
    await page.goto('http://localhost/');
    await page.evaluate(() => window.renderScenario('compact'));
    await page.waitForFunction(() => window.reviewCounts.at(-1) === 2);
    assert.equal(await page.getByRole('button', { name: '允许本次', exact: true }).count(), 0, 'list does not open an approval implicitly');
    await page.evaluate(() => window.addReviewCopies());
    await page.waitForFunction(() => window.reviewCounts.at(-1) === 26);
    const last = page.getByRole('button', { name: /受控验证动作 23 主聊天/ });
    await last.scrollIntoViewIfNeeded(); await last.focus();
    const node = await last.elementHandle(), scroll = await page.evaluate(() => document.documentElement.scrollTop);
    await last.click();
    await page.getByRole('button', { name: '返回审核列表', exact: true }).waitFor();
    assert.equal(await page.getByRole('dialog').count(), 0, 'detail stays inside the review container');
    assert(await node.evaluate(element => element.isConnected), 'the hidden list keeps its original rows');
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), '返回审核列表');
    await page.keyboard.press('Escape');
    assert.equal(await last.evaluate(element => document.activeElement === element), true, 'return restores the original trigger focus');
    assert.equal(await page.evaluate(() => document.documentElement.scrollTop), scroll, 'return restores the list scroll position');
    await page.getByRole('button', { name: /发送飞书验证消息 主聊天/ }).click();
    let lightBackground;
    for (const dark of [false, true]) {
      await page.evaluate(dark => document.body.toggleAttribute('data-ds-dark-theme', dark), dark);
      const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      if (dark) assert.notEqual(background, lightBackground, 'the actual official dark theme is applied'); else lightBackground = background;
      assert(await page.locator('.ba-approval-review').evaluate(element => element.scrollWidth <= element.clientWidth), 'compact detail fits its container');
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (process.env.BENCHGO_REVIEW_SCREENSHOTS) await page.screenshot({ path: join(process.env.BENCHGO_REVIEW_SCREENSHOTS, `${dark ? 'dark' : 'light'}-compact-detail.png`), fullPage: true });
    }
    await page.evaluate(() => window.setReviewActive(false));
    await page.locator('.ba-approval-review').waitFor({ state: 'hidden' });
    await page.evaluate(() => window.answerElsewhere());
    await page.waitForFunction(() => window.reviewCounts.at(-1) === 25);
    await page.evaluate(() => window.setReviewActive(true));
    await page.getByText('此审核已处理或失效', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '允许本次', exact: true }).count(), 0, 'a hidden, settled card cannot revive');
    await page.evaluate(() => window.renderScenario('double'));
    const views = page.locator('.ba-approval-review');
    await views.nth(0).getByRole('button', { name: /发送飞书验证消息 主聊天/ }).click();
    await views.nth(1).getByRole('button', { name: /发送飞书验证消息 主聊天/ }).click();
    await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('[data-approval-key] button')].filter(button => button.textContent.trim() === '允许本次');
      buttons.forEach(button => button.click());
    });
    await page.waitForFunction(() => window.answers.length === 1);
    assert.deepEqual(await page.evaluate(() => window.answers), [{ sessionId: 'worker-session', value: 'allowed-once' }], 'simultaneous review entries consume the official pending once');
    await page.waitForFunction(() => [...document.querySelectorAll('.ba-approval-review')].every(element => element.textContent.includes('此审核已处理或失效')));
    assert.equal(await page.getByRole('button', { name: '允许本次', exact: true }).count(), 0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
