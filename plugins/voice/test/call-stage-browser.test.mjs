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
    import React,{useRef,useState} from 'react';import {createRoot} from 'react-dom/client';
    import {CallStage,mergeCallMessages} from './plugins/voice/client/call-stage.jsx';
    import {installIconSprite} from './deepseek-harness/packages/client/ui-theme/src/client/icon-sprite.ts';
    installIconSprite({effect:fn=>fn(),on:()=>{}},undefined);
    const root=createRoot(document.getElementById('root'));let serial=0;
    const user={id:'current-user',role:'user',text:'帮我看看这个页面，保持现在的模型。',callId:'call',requestId:'request'};
    const assistant={id:'current-assistant',role:'assistant',text:'好，我看一下。有进展就告诉你。',callId:'call',requestId:'request',messageId:'reply'};
    window.mergeCallMessages=mergeCallMessages;
    window.renderScenario=(scenario='data',patch={})=>{
      const key=++serial;window.actions=[];window.requests=[];
      const controller={readConversationHistory:async(_session,options)=>{
        window.requests.push(options.before||'latest');
        if(scenario==='loading')return new Promise(()=>{});
        if(scenario==='error')throw Error('连接暂时不可用');
        if(options.before)return {items:[{id:'older',role:'user',text:'这是更早的一次通话。',callId:'old',requestId:'old'}],hasMore:false};
        return {items:['empty','live'].includes(scenario)?[]:scenario==='native'?[{...user,id:'durable-user',sourceId:'user:one'},{...assistant,sourceId:'assistant:1:0'}]:[{...user,id:'durable-user'},assistant],hasMore:scenario==='data',nextBefore:20};
      }};
      function App(){const[open,setOpen]=useState(true),[muted,setMuted]=useState(false),[statePatch,setStatePatch]=useState(patch),returnFocus=useRef();window.patchCall=next=>setStatePatch(previous=>({...previous,...next}));return <div ref={returnFocus}><button id="restore" onClick={()=>setOpen(true)}>返回通话</button><CallStage state={{mode:'call',phase:'listening',conversationMode:scenario==='native'?'native':'enhanced',sessionId:'session',level:.35,muted,conversationMessages:scenario==='native'?[{...user,id:'live-user',sourceId:'user:one'},{...assistant,id:'live-reply',sourceId:'assistant:1:0',partial:true}]:scenario==='data'?[user,{...assistant,partial:true}]:[],...statePatch}} sessionId="session" controller={controller} returnFocusRef={returnFocus} open={open} historyOnly={!['stage','live'].includes(scenario)} origin={{x:120,y:740}} pending={false} error={statePatch.error||''} onMute={()=>{setMuted(!muted);window.actions.push('mute')}} onMinimize={()=>{setOpen(false);window.actions.push('minimize')}} onHangup={()=>{setOpen(false);window.actions.push('hangup')}} onRetry={()=>window.actions.push('retry')} onOpenSettings={()=>{if(window.settingsUnavailable)throw Error('请从侧栏设置 → 媒体 → 语音打开配置。');window.actions.push('settings')}}/></div>}
      root.render(<App key={key}/>);return key;
    };
  ` }, bundle: true, write: false, outdir: join(root, 'artifacts/unused-call-stage'), format: 'iife', jsx: 'automatic',
    nodePaths: [join(root, 'plugins/benchgo/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')],
    alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')), '@deepseek-ai/dsh-client-ui-primitives': join(root, 'deepseek-harness/packages/client/ui-primitives/src/index.ts') },
    loader: { '.css': 'text', '.module.css': 'local-css', '.svg': 'text' }, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  const script = result.outputFiles.find(file => file.path.endsWith('.js')).text;
  const css = (await readFile(new URL('../client/style.css', import.meta.url), 'utf8')) + result.outputFiles.filter(file=>file.path.endsWith('.css')).map(file=>file.text).join('\n');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{--dsw-alias-bg-base:#fafafa;--dsw-alias-bg-layer-2:#fff;--dsw-alias-label-primary:#242424;--dsw-alias-label-secondary:#797b83;--dsw-alias-state-business-primary:#4d6bfe}html[data-dark=true]{--dsw-alias-bg-base:#191a1e;--dsw-alias-bg-layer-2:#202126;--dsw-alias-label-primary:#ededee;--dsw-alias-label-secondary:#a3a5af}body{margin:0;font-family:Arial,"Microsoft YaHei",sans-serif;background:var(--dsw-alias-bg-base)}${css}</style></head><body><div id="root"></div><script>${script.replaceAll('</script', '<\\/script')}</script></body></html>`;
}

test('call stage renders four record states, theme, mobile, audio levels and usable controls', { skip: !executablePath && 'Chromium/Edge required' }, async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  const screenshots = process.env.BENCHGO_VOICE_STAGE_SCREENSHOTS;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  try {
    const page = await browser.newPage(), errors = []; page.setDefaultTimeout(6000); page.on('pageerror', failure => errors.push(failure.message));
    const html = await fixture(); await page.route('**/*', route => route.request().url() === 'http://localhost/' ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort()); await page.goto('http://localhost/');
    for (const width of [1440, 390]) for (const dark of [false, true]) {
      await page.setViewportSize({ width, height: 800 }); await page.evaluate(dark => document.documentElement.dataset.dark = dark, dark);
      for (const scenario of ['empty', 'loading', 'error', 'data']) {
        await page.evaluate(scenario => window.renderScenario(scenario), scenario);
        await page.getByRole('dialog').waitFor();
        await settleAnimations(page);
        assert.equal(await page.locator('.voice-stage-header').innerText(),'关闭');
        assert(await page.locator('.voice-stage-header button').evaluate(node=>{const button=node.getBoundingClientRect(),header=node.parentElement.getBoundingClientRect();return button.left>header.left+header.width/2;}));
        if (scenario === 'loading') await page.getByText('正在读取语音记录…').waitFor();
        if (scenario === 'empty') await page.getByText('对话从这里开始').waitFor();
        if (scenario === 'error') { await page.getByText('连接暂时不可用').waitFor(); await page.getByRole('button', { name: '重新加载', exact: true }).click(); }
        if (scenario === 'data') {
          await page.getByText(userText, { exact: true }).waitFor();
          assert.equal(await page.getByText(userText, { exact: true }).count(), 1);
          await page.getByRole('button', { name: '查看更早记录' }).click(); await page.getByText('这是更早的一次通话。').waitFor();
          assert.equal(await page.getByText('好，我看一下。有进展就告诉你。', { exact: true }).count(), 1);
        }
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        if (screenshots) { await settleAnimations(page); await page.screenshot({ path: join(screenshots, `${scenario}-${width}-${dark ? 'dark' : 'light'}.png`) }); }
      }
      await page.evaluate(() => window.renderScenario('stage')); await page.getByRole('heading', { name: '我在听' }).waitFor();
      assert.equal(await page.locator('.voice-call-orb').evaluate(node => node.style.getPropertyValue('--voice-level')), '0.35');
      const stageButtons = page.getByRole('dialog').getByRole('button');
      await stageButtons.last().focus(); await page.keyboard.press('Tab'); assert(await stageButtons.first().evaluate(node => node === document.activeElement));
      await page.keyboard.press('Shift+Tab'); assert(await stageButtons.last().evaluate(node => node === document.activeElement));
      await page.getByRole('button', { name: '关闭麦克风', exact: true }).click(); await page.getByRole('heading', { name: '麦克风已关闭' }).waitFor();
      await page.getByRole('button', { name: '开启麦克风', exact: true }).click();
      await page.getByRole('button', { name: '展开幕布', exact: true }).click(); await page.getByRole('complementary', { name: '完整语音记录' }).waitFor();
      const curtainLayout = await page.evaluate(() => {
        const records = document.querySelector('.voice-stage-records'), style = getComputedStyle(records);
        const controls = [...document.querySelectorAll('.voice-stage-controls button')].map(button => button.getBoundingClientRect());
        const area = records.getBoundingClientRect(), footer = document.querySelector('.voice-stage-controls').getBoundingClientRect();
        return { background: style.backgroundColor, border: style.borderTopWidth, aligned: controls.every(rect => Math.abs(rect.top - controls[0].top) <= 2), separated: area.bottom <= footer.top + 1 };
      });
      assert.equal(curtainLayout.background, 'rgba(0, 0, 0, 0)'); assert.equal(curtainLayout.border, '0px');
      assert(curtainLayout.aligned); assert(curtainLayout.separated);
      assert(await page.getByRole('heading', { name: '我在听', exact: true }).isVisible());
      assert.equal(await page.getByRole('button', { name: '收起通话', exact: true }).count(), 1);
      assert.equal(await page.getByRole('button', { name: '执行记录', exact: true }).count(), 0);
      await page.getByRole('button', { name: '关闭麦克风', exact: true }).click();
      await page.getByRole('button', { name: '开启麦克风', exact: true }).click();
      assert(await page.getByRole('button', {name:'结束语音通话',exact:true}).isVisible());
      if (screenshots) { await settleAnimations(page); await page.screenshot({ path: join(screenshots, `curtain-${width}-${dark ? 'dark' : 'light'}.png`) }); }
      await page.keyboard.press('Escape'); await page.getByRole('heading', { name: '我在听', exact: true }).waitFor();
      assert.equal(await page.getByRole('button', {name:'展开幕布',exact:true}).evaluate(node=>node===document.activeElement),true);
      if (screenshots) { await settleAnimations(page); await page.screenshot({ path: join(screenshots, `stage-${width}-${dark ? 'dark' : 'light'}.png`) }); }
      await page.getByRole('button', { name: '收起通话', exact: true }).click(); await page.getByRole('dialog').waitFor({state:'hidden'});
      await page.getByRole('button', { name: '返回通话', exact: true }).click(); await page.getByRole('dialog').waitFor();
      await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({state:'hidden'});
      assert.equal(await page.evaluate(() => document.activeElement.id), 'restore');
    }
    await page.setViewportSize({width: 1280, height: 720});
    await page.evaluate(() => { document.documentElement.setAttribute('data-windows-titlebar', ''); document.documentElement.style.setProperty('--dsh-windows-titlebar-height', '36px'); window.renderScenario('stage', { phase:'starting' }); });
    await page.getByRole('heading', {name:'正在连接',exact:true}).waitFor();
    assert(await page.getByRole('button',{name:'关闭麦克风',exact:true}).isDisabled());
    assert.equal(await page.locator('.voice-stage-header').innerText(),'收起');
    assert.equal(await page.getByRole('dialog').evaluate(node => node.getBoundingClientRect().top),36);
    assert((await page.getByRole('button', {name:'收起通话',exact:true}).boundingBox()).y >= 36);
    if(screenshots) { await settleAnimations(page); await page.screenshot({path:join(screenshots,'windows-connecting.png')}); }
    await page.getByRole('button', {name:'展开幕布',exact:true}).click();
    await page.evaluate(() => document.documentElement.removeAttribute('data-windows-titlebar'));
    await page.setViewportSize({width: 640, height: 400});
    assert(await page.getByRole('button',{name:'结束语音通话',exact:true}).evaluate(node => { const rect=node.getBoundingClientRect();return rect.top>=0&&rect.bottom<=innerHeight; }));
    assert(await page.getByRole('complementary',{name:'完整语音记录'}).evaluate(node => node.getBoundingClientRect().height > 100));
    for (const conversationMode of ['direct', 'native']) {
      await page.evaluate(conversationMode => window.renderScenario('loading', { conversationMode, conversationMessages: [{ id: 'live-only', sourceId: 'assistant:2:0', role: 'assistant', text: '实时回复先显示。', partial: true }] }), conversationMode);
      await page.getByText('实时回复先显示。', { exact: true }).waitFor();
      await page.evaluate(conversationMode => window.renderScenario('native', { conversationMode }), conversationMode);
      await page.getByText(userText, { exact: true }).waitFor();
      assert.equal(await page.getByText(userText, { exact: true }).count(), 1);
      assert.equal(await page.getByText('好，我看一下。有进展就告诉你。', { exact: true }).count(), 1);
      await page.waitForFunction(() => document.querySelectorAll('.voice-stage-message i').length === 0);
    }
    await page.emulateMedia({ reducedMotion: 'reduce' }); await page.evaluate(() => window.renderScenario('stage', { phase: 'speaking', playbackLevel: .72, muted: true }));
    await page.getByRole('heading', { name: '正在回应' }).waitFor();
    assert.equal(await page.locator('.voice-call-orb').evaluate(node => node.style.getPropertyValue('--voice-level')), '0.72');
    assert.equal(await page.locator('.voice-stage-orb-arrival').evaluate(node => getComputedStyle(node).animationName), 'none');
    await page.getByRole('button', {name:'展开幕布',exact:true}).click();
    await page.getByRole('button', { name: '结束语音通话', exact: true }).click(); await page.getByRole('dialog').waitFor({state:'hidden'});
    await page.evaluate(() => window.renderScenario('stage', { mode: 'idle', phase: 'idle', error: '麦克风暂不可用' }));
    await page.getByRole('button',{name:'展开幕布',exact:true}).click();
    assert(await page.getByText('麦克风暂不可用',{exact:true}).isVisible());
    await page.getByRole('button', { name: '重新连接', exact: true }).click();
    assert((await page.evaluate(() => window.actions)).includes('retry'));
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
const userText = '帮我看看这个页面，保持现在的模型。';
const settleAnimations = page => page.evaluate(() => Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))));

test('direct call explains the wait only while the session model is thinking', { skip: !executablePath && 'Chromium/Edge required' }, async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  const screenshots = process.env.BENCHGO_VOICE_STAGE_SCREENSHOTS;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  try {
    const page = await browser.newPage(), errors = []; page.setDefaultTimeout(6000); page.on('pageerror', failure => errors.push(failure.message));
    const html = await fixture(); await page.route('**/*', route => route.request().url() === 'http://localhost/' ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort()); await page.goto('http://localhost/');
    const reason = '未配置通话交互模型，当前直接使用原会话模型', direct = { conversationMode: 'direct', conversationReason: reason, conversationConfigurable: true, phase: 'thinking', transcript: '帮我看看这个页面。' };
    const hint = page.locator('.voice-stage-caption>p'), settings = page.getByRole('button', { name: '去设置', exact: true });
    const render = async (patch, heading) => { await page.evaluate(patch => window.renderScenario('stage', patch), patch); await page.getByRole('heading', { name: heading, exact: true }).waitFor(); };
    for (const width of [1440, 390]) for (const dark of [false, true]) {
      await page.setViewportSize({ width, height: 800 }); await page.evaluate(dark => document.documentElement.dataset.dark = dark, dark);
      await render(direct, '正在想一想');
      assert.equal((await hint.innerText()).replace(/\s+/g, ''), reason + '去设置');
      const colors = await page.evaluate(() => { const style = name => getComputedStyle(document.querySelector(name)).color; return { hint: style('.voice-stage-caption>p'), title: style('.voice-stage-caption h2'), muted: style('.voice-stage-controls>div>span') }; });
      assert.equal(colors.hint, colors.muted); assert.notEqual(colors.hint, colors.title);
      assert(await page.evaluate(() => { const hint = document.querySelector('.voice-stage-caption>p').getBoundingClientRect(), text = document.querySelector('.voice-stage-subtitle').getBoundingClientRect(); return hint.left >= 0 && hint.right <= innerWidth && hint.bottom <= text.top + 1; }));
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (screenshots) { await settleAnimations(page); await page.screenshot({ path: join(screenshots, `direct-thinking-${width}-${dark ? 'dark' : 'light'}.png`) }); }
      await page.getByRole('button', { name: '展开幕布', exact: true }).click(); await page.getByRole('complementary', { name: '完整语音记录' }).waitFor();
      assert(await settings.isVisible()); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (screenshots) { await settleAnimations(page); await page.screenshot({ path: join(screenshots, `direct-thinking-curtain-${width}-${dark ? 'dark' : 'light'}.png`) }); }
    }
    for (const [patch, heading] of [[{ ...direct, conversationMode: 'enhanced' }, '正在想一想'], [{ ...direct, conversationMode: 'native' }, '正在想一想'], [{ ...direct, conversationReason: '' }, '正在想一想'], [{ ...direct, phase: 'listening' }, '我在听'], [{ ...direct, phase: 'transcribing' }, '正在听清你的话'], [{ ...direct, phase: 'speaking' }, '正在回应'], [{ ...direct, phase: 'starting' }, '正在连接']]) {
      await render(patch, heading);
      assert.equal(await hint.count(), 0, JSON.stringify(patch)); assert.equal(await settings.count(), 0);
    }
    await render({ ...direct, phase: 'waiting' }, '等待你的确认'); assert.equal(await hint.innerText(), '请返回对话完成确认');
    await render({ ...direct, error: '麦克风暂不可用' }, '语音遇到问题'); assert.equal(await hint.innerText(), '麦克风暂不可用');
    // The hint follows the phase within one call instead of staying on screen.
    await render(direct, '正在想一想'); await settings.waitFor();
    await page.evaluate(() => window.patchCall({ phase: 'speaking', replyText: '好，我看一下。' })); await page.getByRole('heading', { name: '正在回应', exact: true }).waitFor(); assert.equal(await hint.count(), 0);
    await page.evaluate(() => window.patchCall({ phase: 'thinking' })); await settings.click();
    assert.deepEqual(await page.evaluate(() => window.actions), ['settings']);
    await page.evaluate(() => { window.settingsUnavailable = true; }); await settings.click();
    assert.equal((await hint.innerText()).replace(/\s+/g, ''), reason + '请从侧栏设置→媒体→语音打开配置。'); assert.equal(await settings.count(), 0);
    // A downgrade that settings cannot resolve is explained without the shortcut.
    const unsupported = '子 Agent 会话未启用通话交接，请从原工作会话进入';
    await render({ ...direct, conversationConfigurable: false, conversationReason: unsupported }, '正在想一想');
    assert.equal(await hint.innerText(), unsupported); assert.equal(await settings.count(), 0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('curtain hides its scrollbar while preserving wheel, keyboard and reading position', { skip: !executablePath && 'Chromium/Edge required' }, async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  const screenshots = process.env.BENCHGO_VOICE_DRAG_SCREENSHOTS;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  try {
    const page = await browser.newPage({ hasTouch: true }), errors = []; page.setDefaultTimeout(6000); page.on('pageerror', error => errors.push(error.message));
    const html = await fixture(); await page.route('**/*', route => route.request().url() === 'http://localhost/' ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort()); await page.goto('http://localhost/');
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await page.evaluate(() => window.renderScenario('live', { conversationMessages: Array.from({ length: 35 }, (_, i) => ({ id: 'record-' + i, role: i % 2 ? 'assistant' : 'user', text: '第' + (i + 1) + '条语音记录：保留真实对话内容，允许回看较早的信息。' })) }));
      await page.getByRole('button', { name: '展开幕布', exact: true }).click();
      const list = page.locator('.voice-stage-message-list'); await list.waitFor();
      await page.waitForFunction(() => { const node = document.querySelector('.voice-stage-message-list'); return node && node.scrollHeight > node.clientHeight + 300 && node.scrollTop > 100; });
      assert.equal(await list.evaluate(node => getComputedStyle(node).scrollbarWidth), 'none');
      assert.equal(await list.evaluate(node => getComputedStyle(node, '::-webkit-scrollbar').display), 'none');
      const before = await list.evaluate(node => node.scrollTop); await list.hover(); await page.mouse.wheel(0, -500);
      await page.waitForFunction(value => document.querySelector('.voice-stage-message-list').scrollTop < value - 100, before);
      const reading = await list.evaluate(node => node.scrollTop);
      await page.evaluate(() => window.patchCall({ conversationMessages: Array.from({ length: 36 }, (_, i) => ({ id: 'record-' + i, role: i % 2 ? 'assistant' : 'user', text: '第' + (i + 1) + '条语音记录：保留真实对话内容，允许回看较早的信息。' })) }));
      await page.getByText('第36条语音记录：保留真实对话内容，允许回看较早的信息。', { exact: true }).waitFor({ state: 'attached' });
      assert(Math.abs((await list.evaluate(node => node.scrollTop)) - reading) < 3);
      await list.focus(); await page.keyboard.press('PageUp');
      await page.waitForFunction(value => document.querySelector('.voice-stage-message-list').scrollTop < value - 50, reading);
      const up = await list.evaluate(node => node.scrollTop); await page.keyboard.press('PageDown');
      await page.waitForFunction(value => document.querySelector('.voice-stage-message-list').scrollTop > value + 50, up);
      if (width === 390) {
        await list.evaluate(node => { node.scrollTop = 800; });
        const touch = await page.context().newCDPSession(page), box = await list.boundingBox();
        const x = box.x + box.width / 2, y = box.y + box.height / 2 + 70;
        await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
        for (let step = 1; step <= 5; step++) await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - step * 25, id: 1 }] });
        await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await page.waitForFunction(() => document.querySelector('.voice-stage-message-list').scrollTop > 850);
      }
      for (const dark of [false, true]) {
        await page.evaluate(dark => document.documentElement.dataset.dark = dark, dark);
        if (screenshots) { await settleAnimations(page); await page.screenshot({ path: join(screenshots, `curtain-scroll-${width}-${dark ? 'dark' : 'light'}.png`) }); }
      }
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('curtain streams ASR in place and renders safe official Markdown', { skip: !executablePath && 'Chromium/Edge required' }, async () => {
  const browser = await chromium.launch({ executablePath, headless:true });
  try {
    const page=await browser.newPage(), errors=[]; page.setDefaultTimeout(6000); page.on('pageerror', error=>errors.push(error.message));
    const html=await fixture(); await page.route('**/*', route=>route.request().url()==='http://localhost/'?route.fulfill({contentType:'text/html',body:html}):route.abort()); await page.goto('http://localhost/');
    for(const width of [1440,390]) for(const dark of [false,true]) {
      await page.setViewportSize({width,height:800}); await page.evaluate(dark=>document.documentElement.dataset.dark=dark,dark);
      await page.evaluate(()=>window.renderScenario('live')); await page.getByRole('button',{name:'展开幕布',exact:true}).click();
      await page.evaluate(()=>window.patchCall({transcriptId:'utterance-1',transcript:'帮我查',phase:'transcribing'}));
      await page.getByText('帮我查',{exact:true}).waitFor();
      await page.evaluate(()=>{window.firstASR=document.querySelector('[data-voice-row="transcript:utterance-1"]'); window.patchCall({transcript:'帮我查一下项目'});});
      await page.getByText('帮我查一下项目',{exact:true}).waitFor();
      assert(await page.evaluate(()=>window.firstASR===document.querySelector('[data-voice-row="transcript:utterance-1"]')));
      // A final ASR sentence remains one provisional row during the continuation window.
      await page.evaluate(()=>window.patchCall({phase:'listening',turnPending:true,transcriptId:'utterance-1',transcript:'帮我查一下项目'}));
      await page.getByRole('heading',{name:'我在听',exact:true}).waitFor();
      assert.equal(await page.getByRole('heading',{name:'正在想一想',exact:true}).count(),0);
      assert.equal(await page.locator('.voice-stage-message.is-user').count(),1);
      assert(await page.evaluate(()=>window.firstASR===document.querySelector('[data-voice-row="transcript:utterance-1"]')));
      await page.evaluate(()=>window.patchCall({phase:'listening',turnPending:true,transcriptId:'utterance-1',transcript:'帮我查一下项目\n不要用官方插件'}));
      await page.waitForFunction(()=>document.querySelector('[data-voice-row="transcript:utterance-1"]')?.textContent.includes('不要用官方插件'));
      assert(await page.evaluate(()=>window.firstASR===document.querySelector('[data-voice-row="transcript:utterance-1"]')));
      assert.equal(await page.locator('.voice-stage-message.is-user').count(),1);
      assert(await page.locator('.voice-stage-message.is-user').evaluate(node=>node.classList.contains('is-transcribing')));
      assert(await page.getByRole('heading',{name:'我在听',exact:true}).isVisible());
      // Admission links every final transcript while keeping the first row's identity.
      await page.evaluate(()=>window.patchCall({phase:'thinking',turnPending:false,conversationMessages:[{id:'final-user',role:'user',requestId:'r1',transcriptIds:['utterance-1','utterance-2'],text:'帮我查一下项目\n不要用官方插件',partial:false}]}));
      await page.waitForFunction(()=>document.querySelector('[data-voice-row="transcript:utterance-1"]')?.classList.contains('is-transcribing')===false);
      assert(await page.evaluate(()=>window.firstASR===document.querySelector('[data-voice-row="transcript:utterance-1"]')));
      assert.equal(await page.locator('.voice-stage-message.is-user').count(),1);
      await page.getByRole('heading',{name:'正在想一想',exact:true}).waitFor();
      const markdown='## 项目概览\n\n**已检查**，可查看[说明](https://example.com/docs)。\n\n```js\nconst answer = 42;\n```\n\n[坏链接](javascript:alert(1))\n\n<img src=x onerror="window.xss=1"><script>window.xss=1</script>';
      await page.evaluate(markdown=>window.patchCall({conversationMessages:[{id:'final-user',role:'user',requestId:'r1',transcriptIds:['utterance-1','utterance-2'],text:'帮我查一下项目\n不要用官方插件'},{id:'reply',role:'assistant',text:markdown}]}),markdown);
      await page.getByRole('heading',{name:'项目概览',exact:true}).waitFor();
      assert.equal(await page.locator('.voice-stage-markdown strong').textContent(),'已检查');
      assert.match(await page.locator('.voice-stage-markdown pre').textContent(),/const answer = 42/);
      assert.equal(await page.getByRole('link',{name:'说明',exact:true}).getAttribute('href'),'https://example.com/docs');
      assert.equal(await page.locator('.voice-stage-markdown a[href^="javascript"],.voice-stage-markdown script,.voice-stage-markdown img').count(),0);
      assert.equal(await page.evaluate(()=>window.xss),undefined);
      assert.equal(await page.locator('.voice-stage-message').count(),2);
      await page.getByRole('button',{name:'结束语音通话',exact:true}).click(); await page.getByRole('dialog').waitFor({state:'hidden'});
    }
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
