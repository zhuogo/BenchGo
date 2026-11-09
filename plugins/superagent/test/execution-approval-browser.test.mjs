import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url));
const { chromium } = require('playwright');
const { build } = createRequire(new URL('../../benchgo/package.json', import.meta.url))('esbuild');
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || [chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);

async function fixture() {
  const bundle = await build({ stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React,{createContext,useContext} from 'react';import {createRoot} from 'react-dom/client';
    import {ExecutionApprovals,OfficialExecutionApproval} from './plugins/superagent/client/execution-approvals.jsx';
    import {ApprovalCard} from './deepseek-harness/packages/client/ui-approval/src/client/ApprovalCard.tsx';
    import {PendingApproval} from './deepseek-harness/packages/client/ui-approval/src/client/contract/slots.ts';
    const root=createRoot(document.getElementById('root')), Scope=createContext(null);let serial=0;
    const SessionProvider=({session,children})=><Scope.Provider value={session.id}>{children}</Scope.Provider>;
    const labels={waiting:'等待你的决定',reject:'拒绝',allowOnce:'允许本次',allowAlways:'始终允许','detail.aria':'本次动作详情'};
    function CardSlot(){const sessionId=useContext(Scope);return <OfficialExecutionApproval renderFactorySlot={(name,props)=>{
      if(name!=='conversation.approval.card'||props.onAlways)throw Error('wrong official factory or persistent choice');
      return <div data-worker-scope={sessionId}><ApprovalCard {...props} t={key=>labels[key]||key} renderSlot={(_name,{callId})=><pre data-call-id={callId}>飞书私聊 · BENCHGO_APPROVAL_ONCE</pre>}/></div>;
    }}/>;}
    window.renderScenario=(mode='data',threadId='main')=>{
      window.answers=[];window.calls=[];window.retains=[];window.mode=mode;const listeners=new Set();
      const controller=new AbortController();
      const pending=new PendingApproval('worker-session',{toolName:'assistant_external_action',callId:'call-original',reason:'允许向已确认的飞书私聊发送以下正文？',signal:controller.signal});
      pending.result.then(value=>{window.answers.push(value);statuses=new Map();publish();},()=>{});
      const unrelated=new PendingApproval('worker-other',{toolName:'assistant_external_action',reason:'不得出现的其他旁聊审批'});unrelated.result.catch(()=>{});
      let statuses=new Map([['worker-session',{pendingInteraction:pending}],['worker-other',{pendingInteraction:unrelated}]]);
      const publish=()=>{for(const listener of listeners)listener();};
      const origin={ticketId:'ticket',title:'高危发送验证',assignmentId:'assignment',runId:'run',sessionId:'worker-session',ownerThreadId:'main',ownerSessionId:'router-main'};
      let origins=[origin];
      window.stop=()=>{origins=[];controller.abort(Error('工单已停止'));statuses=new Map();publish();document.dispatchEvent(new Event('benchgo:assistant-changed'));};
      const ctx={uiSession:{sessionStatus:{subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},getSnapshot:()=>statuses}},
        sessions:{retain:(id)=>{window.retains.push(id);return {id,ready:Promise.resolve(),release(){}};}}};
      const api=async(action,input)=>{window.calls.push({action,input});if(window.mode==='loading')return new Promise(()=>{});
        if(window.mode==='error')throw Error('offline');return {origins:window.mode==='empty'||input.threadId!=='main'||input.ownerSessionId!=='router-main'?[]:origins};};
      root.render(<main key={++serial}><ExecutionApprovals ctx={ctx} api={api} threadId={threadId} ownerSessionId={threadId==='main'?'router-main':'router-side'} SessionProvider={SessionProvider} renderSlot={()=> <CardSlot/>}/></main>);
    };
  ` }, bundle: true, write: false, outdir: join(root, 'artifacts', 'unused-execution-approval-ui-test'), format: 'iife', jsx: 'automatic',
    nodePaths: [join(root, 'plugins/benchgo/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')],
    alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')) },
    loader: { '.css': 'css', '.module.css': 'local-css', '.svg': 'text', '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' }, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  const script = bundle.outputFiles.find(file => file.path.endsWith('.js')).text;
  const styles = bundle.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
    body{margin:0;font-family:Arial,sans-serif;background:#fafafa;color:#202124}main{max-width:840px;margin:32px auto}
    :root{--dsh-composer-side-clearance:0px;--dsh-chat-content-width:780px;--dsh-composer-text-max-height:360px;--dsw-radius-xl:16px;--dsw-alias-state-warn-secondary:#ddd4bb;--dsw-specific-input-major:white;--dsw-alias-state-warn-tertiary:#fff9eb;--dsw-alias-state-warn-primary:#88641c;--dsw-alias-label-primary:#202124}
    ${styles}</style></head><body><div id="root"></div><script>${script.replaceAll('</script', '<\\/script')}</script></body></html>`;
}

test('source chat renders the official Worker approval in four states; one-shot decisions and cancellation preserve the original pending', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const screenshots = process.env.BENCHGO_APPROVAL_SCREENSHOTS;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  try {
    const page = await browser.newPage(), errors = [];
    page.setDefaultTimeout(6000); page.on('pageerror', error => errors.push(error.message));
    const html = await fixture();
    await page.route('**/*', route => route.request().url() === 'http://localhost/' ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
    await page.goto('http://localhost/');
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const mode of ['loading', 'empty', 'error', 'data']) {
        await page.evaluate(mode => window.renderScenario(mode), mode);
        await page.waitForFunction(() => window.calls.length > 0);
        if (mode === 'data') await page.getByRole('button', { name: '允许本次', exact: true }).waitFor();
        else assert.equal(await page.locator('[data-approval-key]').count(), 0, mode);
        assert.equal(await page.getByText('始终允许', { exact: true }).count(), 0);
        assert.equal(await page.getByText('不得出现的其他旁聊审批', { exact: true }).count(), 0);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        if (screenshots) await page.screenshot({ path: join(screenshots, `${mode}-${width}.png`), fullPage: true });
      }
    }
    assert.equal(await page.locator('[data-worker-scope="worker-session"] [data-call-id="call-original"]').count(), 1);
    await page.getByRole('button', { name: '允许本次', exact: true }).click();
    await page.waitForFunction(() => window.answers.length === 1);
    assert.deepEqual(await page.evaluate(() => window.answers), ['allowed-once']);
    await page.evaluate(() => window.renderScenario('data'));
    await page.getByRole('button', { name: '拒绝', exact: true }).click();
    await page.waitForFunction(() => window.answers.length === 1);
    assert.deepEqual(await page.evaluate(() => window.answers), ['rejected']);
    await page.evaluate(() => window.renderScenario('data'));
    await page.getByRole('button', { name: '允许本次', exact: true }).waitFor();
    await page.evaluate(() => window.stop());
    await page.waitForFunction(() => !document.querySelector('[data-approval-key]'));
    assert.deepEqual(await page.evaluate(() => window.answers), []);
    await page.evaluate(() => window.renderScenario('data', 'side'));
    await page.waitForFunction(() => window.calls.length > 0);
    assert.equal(await page.locator('[data-approval-key]').count(), 0);
    assert.deepEqual(await page.evaluate(() => window.retains), []);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
