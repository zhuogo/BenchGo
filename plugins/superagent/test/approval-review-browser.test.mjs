import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sharedUiStyles } from '../../benchgo/scripts/shared-ui.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url));
const { chromium } = require('playwright');
const { build } = createRequire(new URL('../../benchgo/package.json', import.meta.url))('esbuild');
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || [chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);

async function fixture() {
  const bundle = await build({ stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React,{createContext,useContext} from 'react';import {createRoot} from 'react-dom/client';
    import {ApprovalReview,OfficialReviewApproval} from './plugins/superagent/client/approval-review.jsx';
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
      window.answers=[];window.calls=[];window.retains=[];window.releases=[];window.trace=[];window.mode=mode;const listeners=new Set();
      const controller=new AbortController();
      const frozen={category:'external-send',origin:null,target:{channel:'feishu',chatId:'private-chat'},content:{text:'BENCHGO_APPROVAL_ONCE'}};
      const worker=new PendingApproval('worker-session',{toolName:'assistant_external_action',callId:'call-original',reason:'批准本次具体外部动作（仅本次有效）：\\n'+JSON.stringify(frozen),signal:controller.signal});
      const router=new PendingApproval('router-side',{toolName:'assistant_ticket_change',callId:'router-call',reason:'扩大任务范围以调查新的站点？'});
      const unrelated=new PendingApproval('unrelated-session',{toolName:'other',reason:'不得出现的无来源审批'});unrelated.result.catch(()=>{});
      let statuses=new Map([['worker-session',{pendingInteraction:worker}],['router-side',{pendingInteraction:router}],['unrelated-session',{pendingInteraction:unrelated}],['question-session',{pendingInteraction:{kind:'question',answerable:true,sessionId:'question-session'}}]]);
      const publish=()=>{for(const listener of listeners)listener();};
      worker.result.then(value=>{window.answers.push({sessionId:worker.sessionId,value});statuses=new Map(statuses);statuses.delete(worker.sessionId);publish();},()=>{});
      router.result.then(value=>{window.answers.push({sessionId:router.sessionId,value});statuses=new Map(statuses);statuses.delete(router.sessionId);publish();},()=>{});
      const origin={kind:'worker',ticketId:'ticket',title:'发送飞书验证消息',sourceTitle:'主聊天',assignmentId:'assignment',runId:'run',sessionId:'worker-session',ownerThreadId:'main',ownerSessionId:'router-main'};
      const routerOrigin={kind:'router',title:'扩展调研范围',sourceTitle:'客户研究旁聊',sessionId:'router-side',ownerSessionId:'router-side',ownerThreadId:'side'};
      let origins=[origin,routerOrigin,{kind:'router',title:'普通提问',sessionId:'question-session',ownerSessionId:'question-session',ownerThreadId:'question'}];
      window.stop=()=>{origins=origins.filter(item=>item!==origin);controller.abort(Error('工单已停止'));statuses=new Map(statuses);statuses.delete(worker.sessionId);publish();document.dispatchEvent(new Event('benchgo:assistant-changed'));};
      window.answerElsewhere=()=>worker.answer('rejected');window.removeRouter=()=>{origins=origins.filter(item=>item!==routerOrigin);document.dispatchEvent(new Event('benchgo:assistant-changed'));};
      const opened=new Map();window.failOpened=(id)=>{const entry=opened.get(id);entry.state={openState:'error',openError:Error('会话已断开',{cause:Error('原始日志无法读取')})};for(const listener of entry.listeners)listener();};
      const ctx={uiSession:{sessionStatus:{subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},getSnapshot:()=>statuses}},sessions:{retain:(id)=>{window.retains.push(id);window.trace.push('retain:'+id);if(window.mode==='connection-error')throw Error('断开连接');const entry={listeners:new Set(),state:{openState:window.mode==='open-error'?'error':'open',openError:window.mode==='open-error'?Error('读取会话失败',{cause:Error('system event must be first')}):null}};opened.set(id,entry);const binding={session:{getSnapshot:()=>entry.state,subscribe:fn=>{entry.listeners.add(fn);return()=>entry.listeners.delete(fn);}}};return {id,sessionId:id,binding,ready:window.mode==='open-reject'?Promise.reject(Error('打开请求被拒绝')):Promise.resolve(binding),release(){window.releases.push(id);}};}}};
      const api=async(action,input,signal)=>{window.calls.push({action,input});if(!['approvalOrigins','ensure'].includes(action))throw Error('obsolete API');
        if(action==='ensure'){window.trace.push('ensure:'+input.threadId);if(input.threadId==='side'&&window.mode==='ensure-error')throw Error('对话准备失败');
          if(input.threadId==='side'&&window.mode==='ensure-wait')return new Promise(resolve=>{window.completeEnsure=resolve;signal?.addEventListener('abort',()=>window.trace.push('abort-ensure:side'),{once:true});});
          return {sessionId:input.threadId==='side'?(window.mode==='replacement'?'router-new':'router-side'):'question-session'};}
        if(window.mode==='loading')return new Promise(()=>{});if(window.mode==='error')throw Error('审核服务暂时不可用');
        return {origins:window.mode==='empty'?[]:input.sessionId?origins.filter(origin=>origin.sessionId===input.sessionId):origins};};
      root.render(<div key={++serial} className='ba-root'><style>{hostCss}{css}</style><main style={{padding:24,maxWidth:1120,margin:'auto',boxSizing:'border-box'}}><ApprovalReview ctx={ctx} api={api} SessionProvider={SessionProvider} renderSlot={()=> <CardSlot/>}/></main></div>);
    };
  ` }, bundle: true, write: false, outdir: join(root, 'artifacts', 'unused-review-ui-test'), format: 'iife', jsx: 'automatic',
    nodePaths: [join(root, 'plugins/benchgo/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')],
    alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')) },
    loader: { '.css': 'text', '.module.css': 'local-css', '.svg': 'text', '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' }, plugins: [sharedUiStyles()], define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  const script = bundle.outputFiles.find(file => file.path.endsWith('.js')).text;
  const styles = bundle.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
    body{margin:0;font-family:Arial,sans-serif;background:#fafafa;color:#202124}.ba-root{height:auto!important;min-width:0!important}
    :root{--dsw-radius-xl:12px;--dsw-alias-state-warn-secondary:#ddd4bb;--dsw-specific-input-major:white;--dsw-alias-state-warn-tertiary:#fff9eb;--dsw-alias-state-warn-primary:#88641c;--dsw-alias-label-primary:#202124}
    ${styles}</style></head><body><div id="root"></div><script>${script.replaceAll('</script', '<\\/script')}</script></body></html>`;
}

test('review Tab renders official Worker and Router approvals in four states; decisions, stale source and another-view settlement use the same pending', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const screenshots = process.env.BENCHGO_REVIEW_SCREENSHOTS;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  try {
    const page = await browser.newPage(), errors = [];
    page.setDefaultTimeout(6000); page.on('pageerror', error => errors.push(error.message));
    const html = await fixture();
    await page.route('**/*', route => route.request().url() === 'http://localhost/' ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
    await page.goto('http://localhost/');
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 960 });
      for (const [mode, text] of [['loading', '正在同步待审核操作'], ['empty', '没有待审核的操作'], ['error', '审核列表暂时无法读取'], ['data', 'BENCHGO_APPROVAL_ONCE']]) {
        await page.evaluate(mode => window.renderScenario(mode), mode);
        await page.getByText(text, { exact: true }).first().waitFor();
        if (mode === 'data') await page.getByRole('button', { name: '允许本次', exact: true }).waitFor();
        else assert.equal(await page.locator('[data-approval-key]').count(), 0, mode);
        assert.equal(await page.getByText('始终允许', { exact: true }).count(), 0);
        assert.equal(await page.getByText('不得出现的无来源审批', { exact: true }).count(), 0);
        assert.equal(await page.getByText('普通提问', { exact: true }).count(), 0);
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
    await page.getByRole('button', { name: '允许本次', exact: true }).waitFor();
    await page.evaluate(() => window.stop());
    await page.waitForFunction(() => !document.querySelector('[data-session-scope="worker-session"]'));
    assert.deepEqual(await page.evaluate(() => window.answers), []);
    await page.evaluate(() => window.renderScenario('data'));
    await page.getByRole('button', { name: '允许本次', exact: true }).waitFor();
    await page.evaluate(() => window.answerElsewhere());
    await page.waitForFunction(() => !document.querySelector('[data-session-scope="worker-session"]'));
    assert.deepEqual(await page.evaluate(() => window.answers), [{ sessionId: 'worker-session', value: 'rejected' }]);
    await page.evaluate(() => window.renderScenario('data'));
    await page.getByRole('button', { name: '允许本次', exact: true }).waitFor();
    await page.evaluate(() => { window.mode = 'error'; document.dispatchEvent(new Event('benchgo:assistant-changed')); });
    await page.getByText('审核列表暂时无法读取', { exact: true }).waitFor();
    await page.waitForFunction(() => window.releases.includes('worker-session') && window.releases.includes('router-side'));
    assert.equal(await page.locator('[data-approval-key]').count(), 0);
    await page.evaluate(() => window.renderScenario('error'));
    await page.getByRole('button', { name: '重新读取', exact: true }).waitFor();
    await page.evaluate(() => { window.mode = 'data'; });
    await page.getByRole('button', { name: '重新读取', exact: true }).click();
    await page.getByRole('button', { name: '允许本次', exact: true }).waitFor();
    await page.evaluate(() => window.renderScenario('replacement'));
    await page.getByRole('button', { name: '允许本次', exact: true }).waitFor();
    await page.waitForFunction(() => window.calls.some(call => call.action === 'ensure' && call.input.threadId === 'side'));
    assert(!(await page.evaluate(() => window.retains.includes('router-side'))));
    assert.equal(await page.getByRole('button', { name: /扩展调研范围 客户研究旁聊/ }).count(), 0);
    await page.evaluate(() => window.renderScenario('ensure-error'));
    await page.getByRole('button', { name: '允许本次', exact: true }).waitFor();
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
    await page.getByRole('button', { name: '允许本次', exact: true }).waitFor();
    await page.evaluate(()=>window.failOpened('worker-session'));
    await page.getByText('会话已断开；原因：原始日志无法读取', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '允许本次', exact: true }).count(), 1); // Only the unrelated, still-open Router request remains.
    assert.equal(await page.locator('[data-session-scope="worker-session"]').count(), 0);
    assert.deepEqual(await page.evaluate(()=>window.answers), []);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
