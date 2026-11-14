import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { officialUiEntries, officialUiLoaders } from '../scripts/official-ui.mjs';
import { sharedUiStyles } from '../../benchgo/scripts/shared-ui.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(new URL('../package.json', import.meta.url));
const { build } = require('esbuild');
const { chromium } = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url))('playwright');
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || [chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);

test('remote resources announce late readiness, reuse a live device document and preserve the owner workspace', { skip: !executablePath && 'Chromium/Edge is required', timeout: 60000 }, async () => {
  const options = { bundle: true, write: false, outdir: join(root, 'artifacts/unused-resource-stage'), format: 'iife', jsx: 'automatic', target: 'es2022', minify: true,
    alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')), ...await officialUiEntries() },
    nodePaths: [join(root, 'plugins/link/node_modules'), join(root, 'plugins/benchgo/node_modules')], plugins: [sharedUiStyles()],
    loader: { '.css': 'text', '.svg': 'text', ...officialUiLoaders }, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' };
  const built = await build({ stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React, { useState } from 'react'; import { createRoot } from 'react-dom/client';
    import { ResourceStage } from './plugins/link/client/resource-navigation.jsx';
    import css from './plugins/benchgo/client/style.css';
    function App() { const [target,setTarget]=useState(null); window.resourceScenario=(mode,options={})=>{window.mode=mode;setTarget(mode==='empty'?null:{device:{id:options.deviceId||mode,name:'襄阳服务器'},resource:options.resource||{kind:'sessions',resourceId:'session'},requestId:options.requestId||String(Math.random())});};
      return <><style>{css}{'body{margin:0;font-family:Arial;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}.cmd-shell-frame{height:100vh;display:grid;grid-template-columns:180px 1fr}.cmd-shell-frame>aside{padding:16px}.fixture-centerCol{position:relative;padding:16px}html{--dsw-alias-bg-base:#fff;--dsw-alias-label-primary:#202020}html[data-theme=dark]{--dsw-alias-bg-base:#19191b;--dsw-alias-label-primary:#ededee}'}</style><div className="cmd-shell-frame"><aside><button onClick={()=>document.dispatchEvent(new CustomEvent('benchgo:workbench-selected',{detail:{deviceId:'local'}}))}>本机工作台</button></aside><main className="fixture-centerCol"><p>本机草稿</p><textarea defaultValue="保留的草稿"/></main></div><ResourceStage target={target} onClose={()=>setTarget(null)}/></>;
    } createRoot(document.getElementById('root')).render(<App/>);
  ` }, ...options });
  const receiver = await build({ stdin: { resolveDir: root, loader: 'jsx', contents: `
    import {installResourceReceiver} from './plugins/link/client/resource-navigation.jsx';
    window.operations=[];window.received=[];window.replies=[];window.probes=0;
    const run=(kind,id)=>{operations.push({kind,id});document.querySelector('p').textContent='远端会话内容 '+id;};
    addEventListener('message',event=>{if(event.data?.type==='benchgo:resource:probe')probes++;if(event.data?.type==='benchgo:resource:open')received.push(event.data);});
    const listeners=new Set();let snapshot={phase:'ready',items:[{workspaceId:'project',sessionIds:['project-session']}]};
    window.setProjects=ready=>{snapshot={...snapshot,phase:ready?'ready':'pending',items:ready?[{workspaceId:'project',sessionIds:['project-session']}]:[]};listeners.forEach(fn=>fn());};
    let sessionSnapshot={phase:'ready',ids:['session','project-session','last-session']};const sessionListeners=new Set();
    window.setSessions=ready=>{sessionSnapshot={...sessionSnapshot,phase:ready?'ready':'pending',ids:ready?['session','project-session','last-session']:[]};sessionListeners.forEach(fn=>fn());};
    const host={sessions:{list:{getSnapshot:()=>sessionSnapshot,subscribe:fn=>{sessionListeners.add(fn);return()=>sessionListeners.delete(fn);}}},uiWorkspace:{openSession:id=>run('session',id)},workspaces:{list:{getSnapshot:()=>snapshot,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);}}}};
    addEventListener('load',()=>setTimeout(()=>{window.installedAfterLoad=document.readyState==='complete';window.stopReceiver=installResourceReceiver(host,{open:async id=>run('native',id),newSession:async id=>{window.creating=true;await new Promise(resolve=>setTimeout(resolve,100));window.creating=false;if(id==='fail')throw Error('创建失败，请重试');run('newSession',id);},addProject:()=>run('addProject')});},150));
  ` }, ...options });
  const script = built.outputFiles.find(file => file.path.endsWith('.js')).text;
  const receiverScript = receiver.outputFiles.find(file => file.path.endsWith('.js')).text;
  const screenshots = process.env.BENCHGO_RESOURCE_SCREENSHOTS || await mkdtemp(join(tmpdir(), 'benchgo-resource-stage-')); await mkdir(screenshots, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 850 } }); page.setDefaultTimeout(5000); const errors = [], selections = [], replies = []; page.on('pageerror', error => errors.push(error.message));
    await page.exposeFunction('resourceReply', value => replies.push(value));
    await page.addInitScript(() => { window.resourceReplies = []; addEventListener('message', event => { if(event.data?.type==='benchgo:resource:opened'){window.resourceReplies.push(event.data);window.resourceReply(event.data);} }); });
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.pathname === '/api/commander-devices') {
        selections.push(request.postDataJSON());
        const mode = await page.evaluate(() => window.mode);
        if (mode === 'loading') return route.fulfill({ json: { url: 'http://127.0.0.1:17883/pending/' } });
        if (mode === 'error') return route.fulfill({ status: 503, json: { error: '服务器工作台暂不可用' } });
        return route.fulfill({ json: { url: 'http://127.0.0.1:17883/remote/?ticket=' + selections.length } });
      }
      if (url.pathname === '/receiver.js') return route.fulfill({ contentType: 'text/javascript', body: receiverScript });
      if (url.pathname === '/remote/') {
        const dark = await page.evaluate(() => document.documentElement.dataset.theme === 'dark');
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<html><head><meta charset="utf-8"></head><body style="font:15px Arial;background:' + (dark ? '#19191b;color:#ededee' : '#fff;color:#202020') + '"><p>远端加载中</p><script src="/receiver.js"></script></body></html>' });
      }
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>' });
    });
    await page.goto('http://127.0.0.1:17880/'); await page.addScriptTag({ content: script });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => document.documentElement.setAttribute('data-theme', theme), theme);
      for (const mode of ['empty', 'loading', 'error', 'data']) {
        await page.evaluate(mode => window.resourceScenario(mode), mode);
        if (mode === 'empty') await page.locator('.cmd-resource-stage').waitFor({ state: 'detached' });
        else if (mode === 'loading') await page.getByRole('status', { name: '正在打开远端资源…' }).waitFor();
        else if (mode === 'error') await page.getByRole('alert').filter({ hasText: '服务器工作台暂不可用' }).waitFor();
        else {
          try { await page.frameLocator('iframe').getByText('远端会话内容 session').waitFor(); await page.locator('.cmd-resource-stage-status').waitFor({ state: 'hidden' }); }
          catch (error) { throw new Error(JSON.stringify({ text: await page.locator('body').innerText(), frameText: await page.frames().at(-1).locator('body').innerText(), frameRect: await page.locator('iframe').boundingBox(), frames: page.frames().map(frame => frame.url()), errors }), { cause: error }); }
        }
        assert.equal(await page.locator('.cmd-resource-stage > header').count(), 0);
        assert.equal(await page.getByText('目标设备操作', { exact: true }).count(), 0);
        assert.equal(await page.getByRole('button', { name: '本机工作台', exact: true }).isEnabled(), true);
        await page.screenshot({ path: join(screenshots, mode + '-' + theme + '.png') });
      }
      await page.getByRole('button', { name: '本机工作台', exact: true }).click(); await page.locator('.cmd-resource-stage').waitFor({ state: 'detached' });
      assert.equal(await page.locator('textarea').inputValue(), '保留的草稿');
      assert.equal(await page.locator('main').getAttribute('inert'), null);
    }
    // SuperAgent emits these existing navigation events even when reselecting
    // its current panel; either intent must reveal the local view immediately.
    for (const event of ['benchgo:assistant-thread', 'benchgo:assistant-tab']) {
      await page.evaluate(() => window.resourceScenario('data', { deviceId: 'assistant-navigation' }));
      await page.locator('.cmd-resource-stage-status').waitFor({ state: 'hidden' });
      await page.evaluate(event => document.dispatchEvent(new CustomEvent(event, { detail: event.endsWith('thread') ? 'main' : 'resources' })), event);
      await page.locator('.cmd-resource-stage').waitFor({ state: 'detached' });
      assert.equal(await page.locator('textarea').inputValue(), '保留的草稿');
      assert.equal(await page.locator('textarea').isEditable(), true);
      assert.equal(await page.locator('main > [inert]').count(), 0);
    }
    // The actual receiver mounts after iframe load; no second probe is needed.
    await page.evaluate(() => window.resourceScenario('data', { deviceId: 'reuse', requestId: 'first' }));
    await page.locator('.cmd-resource-stage-status').waitFor({ state: 'hidden' });
    let remote = page.frames().find(frame => frame.url().includes('/remote/'));
    assert.equal(await remote.evaluate(() => installedAfterLoad), true);
    assert.equal(await remote.evaluate(() => probes), 1);
    const frameElement = await page.locator('iframe').elementHandle(), selected = selections.length;
    await page.evaluate(() => window.resourceScenario('data', { deviceId: 'reuse', requestId: 'project', resource: { kind: 'projects', resourceId: 'project' } }));
    await remote.getByText('远端会话内容 project-session').waitFor();
    await page.locator('.cmd-resource-stage-status').waitFor({ state: 'hidden' });
    assert.equal(selections.length, selected, 'same device must not consume another entry ticket');
    assert.equal(await frameElement.evaluate(node => node === document.querySelector('iframe')), true);
    // Duplicate requests during an async creation resend the result, without running twice.
    await page.evaluate(() => {
      window.resourceScenario('data', { deviceId: 'reuse', requestId: 'new', resource: { kind: 'projects', resourceId: 'project', intent: 'newSession' } });
    });
    await remote.waitForFunction(() => creating);
    await page.evaluate(() => document.querySelector('iframe').contentWindow.postMessage({ type: 'benchgo:resource:open', requestId: 'new', resource: { kind: 'projects', resourceId: 'project', intent: 'newSession' } }, 'http://127.0.0.1:17883'));
    await page.locator('.cmd-resource-stage-status').waitFor({ state: 'hidden' });
    assert.equal(await remote.evaluate(() => operations.filter(item => item.kind === 'newSession').length), 1);
    await page.waitForFunction(() => resourceReplies.filter(reply => reply.requestId === 'new').length >= 2);
    assert(replies.filter(reply => reply.requestId === 'new').length >= 2, 'duplicate receives a cached acknowledgement');
    // A slow earlier creation cannot replace the more recent selection.
    await page.evaluate(() => window.resourceScenario('data', { deviceId: 'reuse', requestId: 'slow', resource: { kind: 'projects', resourceId: 'project', intent: 'newSession' } }));
    await remote.waitForFunction(() => creating);
    await page.evaluate(() => window.resourceScenario('data', { deviceId: 'reuse', requestId: 'last', resource: { kind: 'sessions', resourceId: 'last-session' } }));
    await page.waitForFunction(() => resourceReplies.some(reply => reply.requestId === 'last'));
    assert.equal(await remote.locator('p').innerText(), '远端会话内容 last-session');
    await remote.evaluate(() => setProjects(false));
    await page.evaluate(() => window.resourceScenario('data', { deviceId: 'reuse', requestId: 'cold', resource: { kind: 'projects', resourceId: 'project' } }));
    await remote.waitForFunction(() => received.some(item => item.requestId === 'cold'));
    assert.equal(await page.getByRole('alert').count(), 0, 'a pending project snapshot is not a missing project');
    await remote.evaluate(() => setProjects(true));
    await page.waitForFunction(() => resourceReplies.some(reply => reply.requestId === 'cold'));
    assert.equal(await remote.locator('p').innerText(), '远端会话内容 project-session');
    await remote.evaluate(() => setSessions(false));
    await page.evaluate(() => window.resourceScenario('data', { deviceId: 'reuse', requestId: 'cold-session', resource: { kind: 'projects', resourceId: 'project' } }));
    await remote.waitForFunction(() => received.some(item => item.requestId === 'cold-session'));
    assert.equal(await page.getByRole('alert').count(), 0, 'the session catalog may load later than projects');
    await remote.evaluate(() => setSessions(true));
    await page.waitForFunction(() => resourceReplies.some(reply => reply.requestId === 'cold-session'));
    assert.equal(await remote.locator('p').innerText(), '远端会话内容 project-session');
    await page.evaluate(() => window.resourceScenario('data', { deviceId: 'reuse', requestId: 'failed-create', resource: { kind: 'projects', resourceId: 'fail', intent: 'newSession' } }));
    await page.getByRole('alert').filter({ hasText: '创建失败，请重试' }).waitFor();
    // Correct origin with the wrong window, and correct window with the wrong origin, are ignored.
    const operationCount = await remote.evaluate(() => operations.length);
    await remote.evaluate(() => {
      for (const [source, origin] of [[window, 'http://127.0.0.1:17880'], [parent, 'http://127.0.0.1:17881']]) dispatchEvent(new MessageEvent('message', { source, origin, data: { type: 'benchgo:resource:open', requestId: 'forged', resource: { kind: 'sessions', resourceId: 'forged' } } }));
    });
    assert.equal(await remote.evaluate(() => operations.length), operationCount);
    await page.evaluate(() => window.resourceScenario('data', { deviceId: 'reuse', requestId: 'missing', resource: { kind: 'projects', resourceId: 'missing' } }));
    await page.getByRole('alert').filter({ hasText: '项目不可用' }).waitFor();
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await page.waitForFunction(expected => document.querySelector('iframe')?.src.includes('ticket=' + expected), selected + 1);
    await page.getByRole('alert').filter({ hasText: '项目不可用' }).waitFor();
    assert.equal(selections.length, selected + 1, 'retry obtains a fresh ticket');
    // A different device must never send its request to the previous live frame.
    remote = page.frames().find(frame => frame.url().includes('/remote/'));
    await remote.evaluate(() => addEventListener('message', event => { if(event.data?.type==='benchgo:resource:open')parent.postMessage({type:'benchgo:resource:opened',requestId:'old-frame:'+event.data.requestId},'http://127.0.0.1:17880'); }));
    const replyStart = replies.length;
    await page.evaluate(() => window.resourceScenario('data', { deviceId: 'another', requestId: 'other-device' }));
    await page.waitForFunction(() => resourceReplies.some(reply => reply.requestId === 'other-device'));
    await page.locator('.cmd-resource-stage-status').waitFor({ state: 'hidden' });
    assert.equal(selections.length, selected + 2);
    assert.equal(replies.slice(replyStart).some(reply => reply.requestId === 'old-frame:other-device'), false);
    await page.clock.install();
    await page.evaluate(() => window.resourceScenario('loading', { deviceId: 'silent', requestId: 'timeout' }));
    await page.waitForFunction(() => document.querySelector('iframe')?.src.includes('/pending/'));
    await page.clock.fastForward(15_001);
    await page.getByRole('alert').filter({ hasText: '目标工作台未响应' }).waitFor();
    await page.evaluate(() => { window.mode = 'data'; });
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await page.clock.resume();
    await page.locator('.cmd-resource-stage-status').waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '本机工作台', exact: true }).click();
    assert.equal(await page.locator('textarea').inputValue(), '保留的草稿');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); if (!process.env.BENCHGO_RESOURCE_SCREENSHOTS) await rm(screenshots, { recursive: true, force: true }); }
});
