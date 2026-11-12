import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url));
const { chromium } = require('playwright');
const { build } = createRequire(new URL('../../benchgo/package.json', import.meta.url))('esbuild');
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || [chromium.executablePath(), 'C:/Users/DraftGo/AppData/Local/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-win64/chrome-headless-shell.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);

async function fixture() {
  const result = await build({ stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React,{useEffect,useState} from 'react';import {createRoot} from 'react-dom/client';
    import {VoiceCallHost} from './plugins/voice/client/call-host.jsx';
    import {createCallPresentation} from './plugins/voice/client/call-presentation.mjs';
    import {Modal} from '@deepseek-ai/dsh-client-ui-primitives';
    import {installIconSprite} from './deepseek-harness/packages/client/ui-theme/src/client/icon-sprite.ts';
    installIconSprite({effect:fn=>fn(),on:()=>{}},undefined);
    function store(value){const listeners=new Set();return {getSnapshot:()=>value,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},set:next=>{value=next;for(const fn of listeners)fn()}}}
    const root=createRoot(document.getElementById('root'));let serial=0;
    window.renderScenario=async(scenario='active',mode='direct')=>{
      const key=++serial;window.actions=[];
      const state=store({mode:'idle',phase:'idle',sessionId:'A',muted:false,level:.3,conversationMode:mode,conversationMessages:[],error:''});
      const statuses=store(new Map());let route;
      const controller={state,async startCall({sessionId}){window.actions.push(['start',sessionId]);if(scenario==='loading')return new Promise(()=>{});state.set({...state.getSnapshot(),sessionId,mode:'call',phase:'listening'});},async hangup(){window.actions.push(['hangup']);state.set({...state.getSnapshot(),mode:'idle',phase:'idle'})},toggleMute(){state.set({...state.getSnapshot(),muted:!state.getSnapshot().muted})},readConversationHistory:async()=>({items:[{id:'u',role:'user',text:'帮我检查首页。'},{id:'a',role:'assistant',text:'好，我看看页面。'}],hasMore:false})};
      const view=createCallPresentation(controller,{title:id=>id==='A'?'官网改版':'其他会话',openSession:async id=>{window.actions.push(['open',id]);route(id)}});
      window.patchCall=patch=>state.set({...state.getSnapshot(),...patch});window.voiceSnapshot=()=>state.getSnapshot();
      window.pendingApproval=()=>statuses.set(new Map([['A',{pendingInteraction:{kind:'approval'}}]]));
      window.otherCall=()=>view.start({sessionId:'B'});
      window.beginCall=()=>view.start({sessionId:'A'});
      function Conversation({id}){useEffect(()=>()=>{window.actions.push(['leave',id]);view.leave(id)},[id]);return <section data-conversation-session={id}><div className="conversation-body"><h2>{id==='A'?'官网改版':'其他会话'}</h2><p>原会话与执行记录</p><div data-composer-card><textarea aria-label="输入消息" defaultValue="保留草稿"/></div><div className="work-output">{Array.from({length:12},(_,i)=><p key={i}>已读取项目文件，正在核对首页布局与交互。<span>src / components / workspace · {i+1}</span></p>)}</div></div></section>}
      function App(){const[current,setCurrent]=useState('A'),[settingsOpen,setSettingsOpen]=useState(false);route=setCurrent;window.goTo=setCurrent;window.openSettingsModal=()=>setSettingsOpen(true);return <><nav><button onClick={()=>setCurrent('A')}>原会话</button><button onClick={()=>setCurrent('B')}>其他会话</button><button onClick={()=>setCurrent('settings')}>切换设置</button></nav>{current==='settings'?<section><h2>设置</h2><p>媒体与外观</p></section>:<Conversation key={current} id={current}/>}<Modal open={settingsOpen} onClose={()=>setSettingsOpen(false)} title="设置面板" closeLabel="关闭设置" shortcutModal="settings"><button>外观设置</button><button>媒体设置</button></Modal><VoiceCallHost controller={controller} callView={view} sessionStatus={statuses} openSettings={()=>{window.actions.push(['settings']);setSettingsOpen(true)}}/></>}
      root.render(<App key={key}/>);
      await new Promise(requestAnimationFrame);
      if(scenario!=='empty'){const start=view.start({sessionId:'A'});if(scenario!=='loading')await start;view.minimize();if(scenario==='error')state.set({...state.getSnapshot(),mode:'idle',phase:'idle',error:'网络连接已中断，请重新连接'});}
    };
  ` }, bundle: true, write: false, outdir: join(root, 'artifacts/unused-call-host'), format: 'iife', jsx: 'automatic',
    nodePaths: [join(root, 'plugins/benchgo/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')],
    alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')), '@deepseek-ai/dsh-client-ui-primitives': join(root, 'deepseek-harness/packages/client/ui-primitives/src/index.ts') },
    loader: { '.css': 'text', '.module.css': 'local-css', '.svg': 'text' }, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  const script = result.outputFiles.find(file => file.path.endsWith('.js')).text;
  const css = (await readFile(new URL('../client/style.css', import.meta.url), 'utf8')) + result.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{--dsw-alias-bg-base:#fafafa;--dsw-alias-bg-layer-2:#fff;--dsw-alias-label-primary:#242424;--dsw-alias-label-secondary:#797b83;--dsw-alias-state-business-primary:#4d6bfe}html[data-dark=true]{--dsw-alias-bg-base:#191a1e;--dsw-alias-bg-layer-2:#202126;--dsw-alias-label-primary:#ededee;--dsw-alias-label-secondary:#a3a5af}body{margin:0;font:14px Arial,"Microsoft YaHei",sans-serif;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}nav{padding:20px;display:flex;gap:12px}nav button{font:inherit;border:0;background:transparent;color:inherit;padding:10px}section[data-conversation-session],#root>section{padding:20px}.conversation-body{min-height:500px}textarea{font:inherit;min-height:80px}.work-output{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px 24px;line-height:1.8}.work-output p{margin:0;padding:16px 0;border-bottom:1px solid color-mix(in srgb,currentColor 10%,transparent)}.work-output span{display:block;color:var(--dsw-alias-label-secondary);font-size:12px} ${css}</style></head><body><div id="root"></div><script>${script.replaceAll('</script', '<\\/script')}</script></body></html>`;
}

test('all call views retain ordinary controls without conversation or standby modes', { skip: !executablePath && 'Chromium/Edge required' }, async () => {
  const browser = await chromium.launch({ executablePath, headless: true }), screenshots = process.env.BENCHGO_DECISION_CALL_SCREENSHOTS;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  try {
    const page = await browser.newPage(), errors = []; page.setDefaultTimeout(6000); page.on('pageerror', failure => errors.push(failure.message));
    const html = await fixture(); await page.route('**/*', route => route.request().url() === 'http://localhost/' ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort()); await page.goto('http://localhost/');
    for (const width of [1280, 390, 320]) for (const dark of [false, true]) {
      await page.setViewportSize({ width, height: 900 }); await page.evaluate(dark => document.documentElement.dataset.dark = dark, dark);
      for (const surface of ['dock', 'stage', 'enhanced']) {
        await page.evaluate(mode => window.renderScenario('active', mode), surface === 'enhanced' ? 'enhanced' : 'direct');
        if (surface === 'stage') await page.locator('.voice-global-open').click();
        const call = page.locator(surface === 'stage' ? '.voice-call-stage' : '.voice-global-call');
        await call.waitFor();
        await page.evaluate(() => window.patchCall({ config: { listening: { enabled: true, configured: true } } }));
        assert.equal(await call.getByRole('tablist', { name: '通话模式', exact: true }).count(), 0);
        assert.equal(await call.getByRole('tab', { name: /^(对话|静默)$/ }).count(), 0);
        assert.equal(await call.getByRole('button', { name: /切换静默|切换对话|对助手说话/ }).count(), 0);
        assert.equal(await call.locator('.voice-call-input-mode,.voice-global-mode').count(), 0);
        assert.doesNotMatch(await call.innerText(), /静默|待机监听|正在判断|已唤起|判断暂不可用|判断不可用/);
        await page.evaluate(() => window.patchCall({ phase: 'speaking' })); await call.getByText('正在回应', { exact: true }).waitFor();
        await page.evaluate(() => window.patchCall({ phase: 'listening', muted: true })); await call.getByText('麦克风已关闭', { exact: true }).waitFor();
        await page.evaluate(() => window.patchCall({ muted: false }));
        if (screenshots) await page.screenshot({ path: join(screenshots, `${surface}-${width}-${dark?'dark':'light'}.png`), animations: 'disabled' });
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      }
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('global call survives conversation unmount, stays bound, handles controls and renders four states', { skip: !executablePath && 'Chromium/Edge required' }, async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  const screenshots = process.env.BENCHGO_VOICE_GLOBAL_SCREENSHOTS;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  try {
    const page = await browser.newPage(), errors = []; page.setDefaultTimeout(6000); page.on('pageerror', error => errors.push(error.message));
    const html = await fixture(); await page.route('**/*', route => route.request().url() === 'http://localhost/' ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort()); await page.goto('http://localhost/');
    for (const width of [1440, 390, 320]) for (const dark of [false, true]) {
      await page.setViewportSize({ width, height: 800 }); await page.evaluate(dark => document.documentElement.dataset.dark = dark, dark);
      for (const scenario of ['empty', 'loading', 'error', 'active']) {
        await page.evaluate(scenario => window.renderScenario(scenario), scenario);
        await page.getByRole('heading', {name:'官网改版',exact:true}).waitFor();
        if (scenario === 'empty') assert.equal(await page.locator('.voice-global-call').count(), 0);
        else {
          await page.locator('.voice-global-call').waitFor();
          if (scenario === 'loading') { assert(await page.getByRole('button', { name: '关闭麦克风', exact: true }).isDisabled()); await page.getByRole('status').getByText('正在连接').waitFor(); }
          if (scenario === 'error') await page.getByRole('status').getByText('连接已中断').waitFor();
          const bounds = await page.locator('.voice-global-call').boundingBox(); assert(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
        }
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        if (screenshots) await page.screenshot({ path: join(screenshots, `${scenario}-${width}-${dark?'dark':'light'}.png`) });
      }
    }
    await page.setViewportSize({width:1280,height:800}); await page.evaluate(()=>window.renderScenario('active'));
    await page.getByRole('button',{name:'切换设置',exact:true}).click();
    await page.getByRole('heading',{name:'设置',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>window.voiceSnapshot().sessionId),'A');
    assert.equal(await page.evaluate(()=>window.actions.filter(row=>row[0]==='hangup').length),0);
    await page.locator('.voice-global-call').getByRole('button',{name:'关闭麦克风',exact:true}).click();
    await page.getByRole('status').getByText('麦克风已关闭').waitFor();
    await page.getByRole('button',{name:'展开语音通话：官网改版',exact:true}).click();
    await page.getByRole('dialog').waitFor();
    await page.getByRole('button',{name:'收起通话',exact:true}).click();
    await page.getByRole('dialog').waitFor({state:'hidden'});
    await page.evaluate(()=>window.otherCall()); await page.getByRole('dialog').waitFor();
    assert.equal(await page.evaluate(()=>window.voiceSnapshot().sessionId),'A');
    assert.equal(await page.evaluate(()=>window.actions.filter(row=>row[0]==='start').length),1);
    await page.getByRole('button',{name:'收起通话',exact:true}).click();
    await page.evaluate(()=>window.pendingApproval());
    await page.getByRole('button',{name:'处理确认',exact:true}).click();
    await page.getByRole('heading',{name:'官网改版',exact:true}).waitFor();
    assert.deepEqual(await page.evaluate(()=>window.actions.find(row=>row[0]==='open')),['open','A']);
    await page.getByRole('button',{name:'结束语音通话',exact:true}).click();
    await page.locator('.voice-global-call').waitFor({state:'hidden'});
    assert.equal(await page.evaluate(()=>window.voiceSnapshot().mode),'idle');
    await page.evaluate(()=>window.renderScenario('active','enhanced'));
    await page.locator('.voice-global-call').waitFor();
    assert.equal(await page.locator('.voice-call-stage').count(),0); assert(await page.getByText('原会话与执行记录',{exact:true}).isVisible());
    await page.getByRole('button',{name:'切换设置',exact:true}).click();
    await page.locator('.voice-global-call').waitFor();
    assert.equal(await page.evaluate(()=>window.voiceSnapshot().mode),'call');
    await page.evaluate(()=>window.renderScenario('active'));
    await page.evaluate(()=>window.openSettingsModal());
    const settings = page.getByRole('dialog',{name:'设置面板',exact:true});
    await settings.waitFor();
    const dock = page.locator('.voice-global-call');
    await dock.getByRole('button',{name:'关闭麦克风',exact:true}).click();
    assert.equal(await page.evaluate(()=>window.voiceSnapshot().muted),true);
    await dock.getByRole('button',{name:'展开语音通话：官网改版',exact:true}).focus();
    await page.keyboard.press('Tab');
    assert(await dock.getByRole('button',{name:'隐藏语音文字',exact:true}).evaluate(node=>node===document.activeElement));
    await dock.getByRole('button',{name:'展开语音通话：官网改版',exact:true}).click();
    const stage = page.getByRole('dialog',{name:'实时语音通话',exact:true}); await stage.waitFor();
    const stageButtons = stage.getByRole('button');
    await stageButtons.first().focus(); await page.keyboard.press('Tab');
    assert(await stage.evaluate(node=>node.contains(document.activeElement)));
    await stageButtons.last().focus(); await page.keyboard.press('Tab');
    assert(await stageButtons.first().evaluate(node=>node===document.activeElement));
    await stage.getByRole('button',{name:'收起通话',exact:true}).click();
    await stage.waitFor({state:'hidden'}); assert(await settings.isVisible());
    await dock.getByRole('button',{name:'结束语音通话',exact:true}).focus();
    await page.keyboard.press('Tab');
    assert(await settings.evaluate(node=>node.contains(document.activeElement)));
    if(screenshots)await page.screenshot({path:join(screenshots,'settings-modal-call.png')});
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('direct wait hint opens settings and keeps the call running in the dock', { skip: !executablePath && 'Chromium/Edge required' }, async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } }), errors = []; page.setDefaultTimeout(6000); page.on('pageerror', error => errors.push(error.message));
    const html = await fixture(); await page.route('**/*', route => route.request().url() === 'http://localhost/' ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort()); await page.goto('http://localhost/');
    await page.evaluate(() => window.renderScenario('active'));
    await page.getByRole('button', { name: '展开语音通话：官网改版', exact: true }).click();
    const stage = page.getByRole('dialog', { name: '实时语音通话', exact: true }); await stage.waitFor();
    assert.equal(await stage.getByRole('button', { name: '去设置', exact: true }).count(), 0);
    await page.evaluate(() => window.patchCall({ phase: 'thinking', conversationReason: '未配置通话交互模型，当前直接使用原会话模型', conversationConfigurable: true }));
    await stage.getByRole('button', { name: '去设置', exact: true }).click();
    const settings = page.getByRole('dialog', { name: '设置面板', exact: true }); await settings.waitFor(); await stage.waitFor({ state: 'hidden' });
    assert(await page.locator('.voice-global-call').isVisible());
    assert.equal(await page.evaluate(() => window.voiceSnapshot().mode), 'call');
    assert.deepEqual(await page.evaluate(() => window.actions.filter(row => ['settings', 'hangup'].includes(row[0]))), [['settings']]);
    assert(await settings.evaluate(node => node.contains(document.activeElement)), 'focus moves into settings');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('call capsule distinguishes drag from click, preserves placement and remains reachable after resize', { skip: !executablePath && 'Chromium/Edge required' }, async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  const screenshots = process.env.BENCHGO_VOICE_DRAG_SCREENSHOTS;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, hasTouch: true }), errors = [];
    page.setDefaultTimeout(6000); page.on('pageerror', error => errors.push(error.message));
    const html = await fixture(); await page.route('**/*', route => route.request().url() === 'http://localhost/' ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort()); await page.goto('http://localhost/');
    await page.evaluate(() => window.renderScenario('active'));
    const dock = page.locator('.voice-global-call'), handle = dock.locator('.voice-global-open');
    await dock.waitFor();
    const initial = await dock.boundingBox(), start = await handle.boundingBox();
    await page.mouse.move(start.x + 20, start.y + 20); await page.mouse.down();
    await page.mouse.move(start.x - 230, start.y - 160, { steps: 8 }); await page.mouse.up();
    const dragged = await dock.boundingBox();
    assert(Math.abs(dragged.x - (initial.x - 250)) < 3); assert(Math.abs(dragged.y - (initial.y - 180)) < 3);
    assert.equal(await page.getByRole('dialog', { name: '实时语音通话', exact: true }).count(), 0);
    await handle.click(); await page.getByRole('dialog', { name: '实时语音通话', exact: true }).waitFor();
    await page.getByRole('button', { name: '收起通话', exact: true }).click();
    const restored = await dock.boundingBox(); assert(Math.abs(restored.x - dragged.x) < 2 && Math.abs(restored.y - dragged.y) < 2);
    await page.getByRole('button', { name: '切换设置', exact: true }).click();
    const navigated = await dock.boundingBox(); assert(Math.abs(navigated.x - dragged.x) < 2 && Math.abs(navigated.y - dragged.y) < 2);
    await dock.getByRole('button', { name: '关闭麦克风', exact: true }).click();
    assert.equal(await page.evaluate(() => window.voiceSnapshot().muted), true);
    assert(Math.abs((await dock.boundingBox()).x - dragged.x) < 2);
    await handle.focus(); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('Shift+ArrowUp');
    const keyboard = await dock.boundingBox(); assert(Math.abs(keyboard.x - (dragged.x - 10)) < 2 && Math.abs(keyboard.y - (dragged.y - 40)) < 2);
    await page.keyboard.press('Home');
    const reset = await dock.boundingBox(); assert(Math.abs(reset.x - initial.x) < 2 && Math.abs(reset.y - initial.y) < 2);
    await handle.focus(); await page.keyboard.press('ArrowLeft');
    await page.setViewportSize({ width: 320, height: 480 });
    await page.waitForFunction(() => { const box = document.querySelector('.voice-global-call')?.getBoundingClientRect(); return box && box.x >= 0 && box.right <= innerWidth + 1 && box.top >= 0 && box.bottom <= innerHeight + 1; });
    if (screenshots) await page.screenshot({ path: join(screenshots, 'drag-clamped-320-light.png') });
    await page.evaluate(() => document.documentElement.dataset.dark = 'true');
    if (screenshots) await page.screenshot({ path: join(screenshots, 'drag-clamped-320-dark.png') });
    const touch = await page.context().newCDPSession(page);
    const touchBox = await handle.boundingBox(), touchStart = { x: touchBox.x + 18, y: touchBox.y + 18, id: 1 };
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touchStart] });
    await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...touchStart, y: touchStart.y - 75 }] });
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    assert.equal(await page.getByRole('dialog', { name: '实时语音通话', exact: true }).count(), 0);
    const touchMoved = await dock.boundingBox(); assert(touchMoved.y < touchBox.y - 50);
    const cancelled = await handle.boundingBox();
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cancelled.x + 18, y: cancelled.y + 18, id: 1 }] });
    await touch.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    assert.equal(await page.getByRole('dialog', { name: '实时语音通话', exact: true }).count(), 0);
    await handle.tap(); await page.getByRole('dialog', { name: '实时语音通话', exact: true }).waitFor();
    await page.getByRole('button', { name: '收起通话', exact: true }).click();
    const multi = await handle.boundingBox(), one = { x: multi.x + 18, y: multi.y + 18, id: 1 }, two = { x: multi.x + 38, y: multi.y + 18, id: 2 };
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [one] });
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [one, two] });
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    assert.equal(await page.getByRole('dialog', { name: '实时语音通话', exact: true }).count(), 0);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.evaluate(() => { document.documentElement.setAttribute('data-windows-titlebar', ''); document.documentElement.style.setProperty('--dsh-windows-titlebar-height', '36px'); });
    const top = await handle.boundingBox(); await page.mouse.move(top.x + 20, top.y + 20); await page.mouse.down(); await page.mouse.move(0, 0, { steps: 8 }); await page.mouse.up();
    const bounded = await dock.boundingBox(); assert(bounded.x >= 0); assert(bounded.y >= 36);
    if (screenshots) await page.screenshot({ path: join(screenshots, 'drag-titlebar-1280-dark.png') });
    await dock.getByRole('button', { name: '结束语音通话', exact: true }).click(); await dock.waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => window.voiceSnapshot().mode), 'idle'); assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('collapsed call shows three live captions above work records and can keep captions hidden', { skip: !executablePath && 'Chromium/Edge required' }, async () => {
  const browser = await chromium.launch({ executablePath, headless: true }), screenshots = process.env.BENCHGO_DECISION_CALL_SCREENSHOTS;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  try {
    const page = await browser.newPage(), errors = []; page.setDefaultTimeout(6000); page.on('pageerror', failure => errors.push(failure.message));
    const html = await fixture(); await page.route('**/*', route => route.request().url() === 'http://localhost/' ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort()); await page.goto('http://localhost/');
    for (const width of [1280, 390, 320]) for (const dark of [false, true]) {
      await page.setViewportSize({ width, height: width === 320 ? 480 : 800 }); await page.evaluate(dark => document.documentElement.dataset.dark = dark, dark);
      await page.evaluate(() => window.renderScenario('active', 'enhanced'));
      const dock = page.locator('.voice-global-call'), captions = dock.getByRole('region', { name: '最近语音对话', exact: true });
      assert(await page.getByText('原会话与执行记录', { exact: true }).isVisible()); assert.equal(await page.locator('.voice-call-stage').count(), 0);
      assert.equal(await captions.count(), 0);
      await page.evaluate(() => window.patchCall({ transcriptId: 'spoken', transcript: '查一下' })); await captions.waitFor();
      await page.evaluate(() => { window.previewNode = document.querySelector('[data-preview-id]'); window.patchCall({ transcript: '查一下今天的热点。' }); });
      assert(await page.evaluate(() => window.previewNode === document.querySelector('[data-preview-id]')));
      await page.evaluate(() => window.patchCall({ transcript: '', conversationMessages: [{ id: 'u1', role: 'user', text: '查一下今天的热点。', transcriptIds: ['spoken'], time: 1 }] }));
      assert(await page.evaluate(() => window.previewNode === document.querySelector('[data-preview-id]')));
      await page.evaluate(() => window.patchCall({ conversationMessages: [{ id: 'u1', role: 'user', text: '查一下今天的热点。', transcriptIds: ['spoken'], time: 1 }, { id: 'a1', role: 'assistant', text: '我来查一下', partial: true, time: 2 }] }));
      await page.evaluate(() => { window.replyNode = document.querySelector('[data-preview-id="a1"]'); window.patchCall({ conversationMessages: [{ id: 'u1', role: 'user', text: '查一下今天的热点。', transcriptIds: ['spoken'], time: 1 }, { id: 'a1', role: 'assistant', text: '我来查一下，结果会直接告诉你。', partial: false, time: 2 }, { id: 'u2', role: 'user', text: '不要用那个插件。', time: 3 }, { id: 'a2', role: 'assistant', text: '明白，我会按这个要求查询。', time: 4 }] }); });
      assert(await page.evaluate(() => window.replyNode === document.querySelector('[data-preview-id="a1"]')));
      assert.equal(await captions.locator('[data-preview-id]').count(), 3);
      assert.deepEqual(await captions.locator('[data-preview-id] .voice-floating-text').allTextContents(), ['我来查一下，结果会直接告诉你。', '不要用那个插件。', '明白，我会按这个要求查询。']);
      await page.waitForFunction(() => !document.querySelector('[data-leaving]'));
      const surface = await captions.evaluate(node => {
        const container = getComputedStyle(node), text = getComputedStyle(node.querySelector('.voice-floating-text'));
        const probe = document.createElement('canvas').getContext('2d');
        probe.fillStyle = container.backgroundColor;
        probe.fillRect(0, 0, 1, 1);
        return { background: container.backgroundColor, alpha: probe.getImageData(0, 0, 1, 1).data[3] / 255, backdrop: container.backdropFilter, filter: container.filter, opacity: container.opacity, textFilter: text.filter, textOpacity: text.opacity, fontSize: text.fontSize };
      });
      assert.notEqual(surface.background, 'rgba(0, 0, 0, 0)');
      assert(Math.abs(surface.alpha - .5) < .01); assert.equal(surface.fontSize, '14px');
      assert.match(surface.backdrop, /blur\(/);
      assert.equal(surface.filter, 'none'); assert.equal(surface.opacity, '1');
      assert.equal(surface.textFilter, 'none'); assert.equal(surface.textOpacity, '1');
      const box = await dock.boundingBox(); assert(box.x >= 0 && box.y >= 0 && box.x + box.width <= width + 1);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (screenshots) await page.screenshot({ path: join(screenshots, `live-captions-${width}-${dark ? 'dark' : 'light'}.png`), animations: 'disabled' });
      await dock.getByRole('button', { name: '隐藏语音文字', exact: true }).click(); assert.equal(await captions.count(), 0);
      await page.evaluate(() => window.patchCall({ transcriptId: 'next', transcript: '还有一句补充。' })); assert.equal(await captions.count(), 0);
      await dock.locator('.voice-global-open').click(); await page.getByRole('button', { name: '收起通话', exact: true }).click(); assert.equal(await captions.count(), 0);
      await page.getByRole('button', { name: '切换设置', exact: true }).click(); assert.equal(await captions.count(), 0);
      await dock.getByRole('button', { name: '显示语音文字', exact: true }).click(); await captions.getByText('还有一句补充。', { exact: true }).waitFor();
      assert(await page.getByRole('heading', { name: '设置', exact: true }).isVisible());
    }
    await page.setViewportSize({ width: 1280, height: 800 }); await page.evaluate(() => window.renderScenario('active', 'enhanced'));
    await page.evaluate(() => window.patchCall({ conversationMessages: [{ id: 'one', role: 'user', text: '帮我检查一下页面。' }, { id: 'two', role: 'assistant', text: '我正在检查页面的交互和布局。' }] }));
    const dock = page.locator('.voice-global-call'), handle = dock.locator('.voice-global-open'); await dock.waitFor();
    const start = await handle.boundingBox(); await page.mouse.move(start.x + 18, start.y + 18); await page.mouse.down(); await page.mouse.move(start.x - 120, start.y - 30, { steps: 6 }); await page.mouse.up();
    const controls = dock.locator('.voice-global-controls'), before = await controls.boundingBox();
    await dock.getByRole('button', { name: '隐藏语音文字', exact: true }).click();
    await page.waitForFunction(y => Math.abs(document.querySelector('.voice-global-controls').getBoundingClientRect().y - y) < 2, before.y);
    await dock.getByRole('button', { name: '显示语音文字', exact: true }).click();
    await page.waitForFunction(y => Math.abs(document.querySelector('.voice-global-controls').getBoundingClientRect().y - y) < 2, before.y);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(() => window.patchCall({ conversationMessages: [{ id: 'last', role: 'assistant', text: '新的结果已经准备好。' }] }));
    assert.equal(await dock.locator('[data-leaving]').count(), 0);
    await dock.getByRole('button', { name: '隐藏语音文字', exact: true }).click();
    await dock.getByRole('button', { name: '结束语音通话', exact: true }).click();
    await page.evaluate(() => window.beginCall()); await page.getByRole('button', { name: '收起通话', exact: true }).click();
    assert(await dock.getByRole('button', { name: '隐藏语音文字', exact: true }).isVisible());
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
