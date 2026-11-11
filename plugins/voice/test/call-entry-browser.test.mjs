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
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || [chromium.executablePath(),
  'C:/Users/DraftGo/AppData/Local/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-win64/chrome-headless-shell.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);

async function fixture() {
  const result = await build({ stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React,{useRef,useState} from 'react';import{createRoot}from'react-dom/client';
    import{CallEntry}from'./plugins/voice/client/call-entry.jsx';
    import{CallStage,CallStageIcon}from'./plugins/voice/client/call-stage.jsx';
    import{installIconSprite}from'./deepseek-harness/packages/client/ui-theme/src/client/icon-sprite.ts';
    installIconSprite({effect:fn=>fn(),on:()=>{}},undefined);
    const root=createRoot(document.getElementById('root'));let serial=0;
    window.renderEntry=(disabled=false)=>{window.starts=0;window.records=0;
      function App(){const[history,setHistory]=useState(false),returnFocus=useRef();return <div ref={returnFocus} className="voice-activity fixture-entry"><button id="before">前一个操作</button><CallEntry available={!disabled} disabled={disabled} hint="开始通话" onStart={()=>window.starts++} onHistory={()=>{window.records++;setHistory(true)}}><CallStageIcon name="curtain"/></CallEntry><button id="after">后一个操作</button><CallStage state={{mode:'idle',phase:'idle',sessionId:'session',conversationMessages:[]}} controller={{readConversationHistory:async()=>({items:[],hasMore:false})}} sessionId="session" open={history} historyOnly returnFocusRef={returnFocus} onMinimize={()=>setHistory(false)}/></div>};root.render(<App key={++serial}/>);return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    };
  ` }, bundle: true, write: false, outdir: join(root, 'artifacts/unused-call-entry'), format: 'iife', jsx: 'automatic',
    nodePaths: [join(root, 'plugins/benchgo/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')],
    alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')),
      '@deepseek-ai/dsh-client-ui-primitives': join(root, 'deepseek-harness/packages/client/ui-primitives/src/index.ts') },
    loader: { '.css': 'text', '.module.css': 'local-css', '.svg': 'text' }, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  const script = result.outputFiles.find(file => file.path.endsWith('.js')).text;
  const css = result.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n') + await readFile(new URL('../client/style.css', import.meta.url), 'utf8');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{--dsw-radius-md:8px;--dsw-radius-lg:12px;--dsw-menu-surface-fill:#fff;--dsw-menu-backdrop-filter:blur(20px);--dsw-elevation-prominent:0 4px 20px #0002;--dsw-alias-bg-base:#fafafa;--dsw-alias-bg-layer-2:#fff;--dsw-alias-label-primary:#242424;--dsw-alias-label-secondary:#797b83;--dsw-alias-state-business-primary:#4d6bfe}body{margin:0;min-height:100vh;font:13px Arial,"Microsoft YaHei",sans-serif;background:#fafafa}.fixture-entry svg{width:18px;height:18px}.voice-activity.fixture-entry{position:fixed;bottom:32px;right:32px;display:flex;gap:12px;padding:12px;border:1px solid #ddd;border-radius:16px;background:#fff}.fixture-entry>button{font:inherit;border:0;background:none;color:inherit}${css}</style></head><body><div id="root"></div><script>${script.replaceAll('</script', '<\\/script')}</script></body></html>`;
}

test('call entry shares hover menu and keeps touch tap, long hold and cancelled gestures distinct', { skip: !executablePath && 'Chromium/Edge required' }, async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  const screenshots = process.env.BENCHGO_VOICE_ENTRY_SCREENSHOTS;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  const html = await fixture(), errors = [];
  const setup = async options => {
    const context = await browser.newContext(options), page = await context.newPage();
    page.setDefaultTimeout(6000); page.on('pageerror', failure => errors.push(failure.message));
    await page.route('**/*', route => route.request().url() === 'http://localhost/' ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
    await page.goto('http://localhost/'); await page.evaluate(() => window.renderEntry());
    return { context, page };
  };
  try {
    const desktop = await setup({ viewport: { width: 1200, height: 800 } }), page = desktop.page;
    const trigger = page.getByRole('button', { name: '开始语音通话', exact: true }), records = page.getByRole('menuitem', { name: '语音记录', exact: true });
    await trigger.hover(); await records.waitFor();
    const anchor = await trigger.boundingBox(), popup = await records.boundingBox(); assert(popup.y + popup.height <= anchor.y,JSON.stringify({anchor,popup}));
    await records.hover(); await page.waitForTimeout(250); assert(await records.isVisible());
    if (screenshots) await page.screenshot({ path: join(screenshots, 'desktop-hover.png') });
    await records.click(); await page.getByRole('dialog', {name:'语音记录',exact:true}).waitFor(); assert.equal(await page.evaluate(() => window.starts), 0);
    await page.getByRole('button', {name:'关闭语音记录',exact:true}).click();
    await page.mouse.move(20, 20); await page.getByRole('button', {name:'前一个操作'}).focus(); await page.keyboard.press('Tab'); await records.waitFor();
    await page.keyboard.press('Tab'); assert(await records.evaluate(node => node === document.activeElement));
    await page.keyboard.press('Escape'); await records.waitFor({state:'hidden'}); assert(await trigger.evaluate(node=>node===document.activeElement));
    await page.keyboard.press('Enter'); assert.equal(await page.evaluate(() => window.starts), 1);
    await page.keyboard.press('ArrowUp'); await records.waitFor(); await page.keyboard.press('ArrowDown'); assert(await records.evaluate(node=>node===document.activeElement));
    await page.keyboard.press('Escape'); await records.waitFor({state:'hidden'}); await page.keyboard.press('Space'); assert.equal(await page.evaluate(()=>window.starts),2);
    await desktop.context.close();

    const mobile = await setup({ viewport: {width:390,height:800}, hasTouch:true, isMobile:true }), touch = mobile.page;
    const session = await mobile.context.newCDPSession(touch), call = touch.getByRole('button', {name:'开始语音通话',exact:true}), item = touch.getByRole('menuitem', {name:'语音记录',exact:true});
    const point = async () => { await call.waitFor({state:'visible'}); const r = await call.boundingBox(); return {x:r.x+r.width/2,y:r.y+r.height/2,id:1}; };
    const dispatch = (type, points) => session.send('Input.dispatchTouchEvent', {type,touchPoints:points});
    await call.tap(); assert.equal(await touch.evaluate(()=>window.starts),1); assert.equal(await item.count(),0);
    await touch.evaluate(()=>window.renderEntry()); let p=await point();
    await dispatch('touchStart',[p]); await touch.waitForTimeout(240);
    assert.equal(await call.evaluate(node=>node.classList.contains('is-holding')),true);
    const progress = await call.locator('circle').evaluate(node=>parseFloat(getComputedStyle(node).strokeDashoffset)); assert(progress>0 && progress<1);
    if(screenshots) await touch.screenshot({path:join(screenshots,'mobile-hold-progress.png')});
    await item.waitFor(); await dispatch('touchEnd',[]); await touch.waitForTimeout(100);
    assert.equal(await touch.evaluate(()=>window.starts),0);
    if(screenshots) await touch.screenshot({path:join(screenshots,'mobile-record-menu.png')});
    await item.tap(); await touch.getByRole('dialog',{name:'语音记录',exact:true}).waitFor(); assert.equal(await touch.evaluate(()=>window.records),1);
    await touch.getByRole('button',{name:'关闭语音记录',exact:true}).tap();
    for(const action of ['move','cancel','multitouch','unmount']) {
      await touch.evaluate(()=>window.renderEntry()); p=await point(); await dispatch('touchStart',[p]);
      if(action==='move') await dispatch('touchMove',[{...p,x:p.x+28}]);
      else if(action==='cancel') await dispatch('touchCancel',[]);
      else if(action==='multitouch') await dispatch('touchStart',[p,{...p,id:2,x:p.x+45}]);
      else await touch.evaluate(()=>window.renderEntry());
      if(action!=='cancel') await dispatch('touchEnd',[]); await touch.waitForTimeout(650);
      assert.equal(await item.count(),0,action); assert.equal(await touch.evaluate(()=>window.starts),0,action);
      await call.tap(); await touch.waitForTimeout(50); assert.equal(await touch.evaluate(()=>window.starts),1,action+' next tap');
    }
    await touch.evaluate(()=>window.renderEntry(true)); p=await point(); await dispatch('touchStart',[p]); await item.waitFor(); await dispatch('touchEnd',[]);
    await item.tap(); await touch.getByRole('dialog',{name:'语音记录',exact:true}).waitFor(); assert.equal(await touch.evaluate(()=>window.starts),0);
    await touch.getByRole('button',{name:'关闭语音记录',exact:true}).tap();
    await touch.emulateMedia({reducedMotion:'reduce'}); await touch.evaluate(()=>window.renderEntry()); p=await point(); await dispatch('touchStart',[p]);
    assert.equal(await call.locator('circle').evaluate(node=>getComputedStyle(node).animationName),'none');
    await dispatch('touchCancel',[]); await touch.waitForTimeout(650); assert.equal(await item.count(),0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
