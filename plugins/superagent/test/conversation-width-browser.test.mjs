import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sharedUiStyles } from '../../benchgo/scripts/shared-ui.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url));
const { chromium } = require('playwright');
const { build } = createRequire(new URL('../../benchgo/package.json', import.meta.url))('esbuild');
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || [chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const captureDir = process.env.BENCHGO_WIDTH_SCREENSHOTS;

// Actual transcript, width adapter, native body/input styles and native theme.
async function fixture() {
  const result = await build({ stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
    import {QuietChat} from './plugins/superagent/client/quiet-chat.jsx';import {ConversationWidth} from './plugins/superagent/client/conversation-width.jsx';
    import native from './deepseek-harness/packages/client/ui-conversation/src/client/skeleton/ConversationRoot.module.css';
    import input from './deepseek-harness/packages/client/ui-conversation/src/client/skeleton/InputBar.module.css';
    const root=createRoot(document.getElementById('root'));
    function App({count,initialAxis}){
      const [container,setContainer]=useState(null),[adapter,setAdapter]=useState(true);
      window.toggleAdapter=enabled=>flushSync(()=>setAdapter(enabled));
      const home={sessionId:'width-'+count,history:{messages:Array.from({length:count},(_,i)=>({id:'m'+i,role:i%2?'assistant':'user',kind:i%2?'final':undefined,seq:i,text:'历史对话 '+i+'：'+'拖动侧栏时保留正文阅读位置并避免重复计算继承样式。'.repeat(4),time:1793700000000+i*1000}))}};
      return <div className="ba-root fixture-column"><header>BenchGo 主助手 · 对话与输入共享宽度</header><div ref={setContainer} className={native.body} data-conversation-content="" style={initialAxis?{'--dsh-chat-content-width':initialAxis}:undefined}><div className={native.scrollBody} data-conversation-scroll=""><div className="ba-official-conversation"><div className="ba-chat-viewport"><div className="ba-chat-feed" data-assistant-scroll="" tabIndex={0}><QuietChat home={home} session={{running:false}}/></div></div></div><div className={native.composerSeat}><div className={native.composerStack}><div className={input.root}><div className={input.card} data-fixture-input=""><textarea placeholder="发送消息" aria-label="消息草稿"/></div></div></div></div></div>{adapter&&<ConversationWidth container={container}/>}</div></div>;
    }
    window.prepareWidth=(count=200,initialAxis)=>flushSync(()=>root.render(<App key={count+':'+initialAxis} count={count} initialAxis={initialAxis}/>));
    window.resizeWidth=width=>document.querySelector('.fixture-column').style.width=width+'px';
    window.setPreference=value=>{if(value===null)localStorage.removeItem('dsh.conversation.contentWidth');else localStorage.setItem('dsh.conversation.contentWidth',value);window.dispatchEvent(new StorageEvent('storage',{key:'dsh.conversation.contentWidth'}));};
  ` }, bundle: true, write: false, outdir: join(root, 'artifacts/unused-width-test'), format: 'iife', jsx: 'automatic',
    nodePaths: [join(root, 'plugins/benchgo/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')],
    alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')), '@deepseek-ai/dsh-client-ui-primitives': join(root, 'deepseek-harness/packages/client/ui-primitives/src/index.ts') },
    loader: { '.css': 'text', '.module.css': 'local-css', '.svg': 'text', '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' }, plugins: [sharedUiStyles()], define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  const themeRoot = join(root, 'deepseek-harness/packages/client/ui-theme/src/styles');
  const theme = (await Promise.all(['base.css', 'design-platform.css', 'focus.css'].map(name => readFile(join(themeRoot, name), 'utf8')))).join('\n');
  const css = result.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n');
  const js = result.outputFiles.find(file => file.path.endsWith('.js')).text.replaceAll('</script', '<\\/script');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${theme}${css}
    *{box-sizing:border-box}body{margin:0;font:14px/1.6 var(--dsw-font-family);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}.fixture-column{height:900px;width:1500px;display:flex;flex-direction:column}.fixture-column header{height:50px;flex:none;padding:14px}.ba-official-conversation{display:flex;flex:1;min-height:0;flex-direction:column}.fixture-column textarea{width:100%;height:80px;resize:none;border:0;padding:12px;font:inherit;color:inherit;background:none}
  </style></head><body><div id="root"></div><script>${js}</script></body></html>`;
}

const settle = page => page.evaluate(async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); });
async function open(page, html) {
  await page.route('http://localhost/', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('http://localhost/');
  await page.evaluate(() => window.prepareWidth());
  await settle(page);
}

test('resolved conversation axis avoids clamped invalidation and preserves native width preferences and cleanup', { skip: !executablePath }, async () => {
  const html = await fixture(), browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage({ viewport: { width: 1800, height: 1000 }, reducedMotion: 'reduce' }), errors = [];
    page.on('pageerror', error => errors.push(error.message)); await open(page, html);
    for (const count of [200, 600]) for (const preference of [null, '700']) {
      await page.evaluate(({ count, preference }) => { window.prepareWidth(count); window.setPreference(preference); window.resizeWidth(1500); }, { count, preference }); await settle(page);
      const journal = await page.evaluate(async preference => {
        const body = document.querySelector('[data-conversation-content]'), before = body.style.cssText;
        let mutations = 0; const observer = new MutationObserver(records => mutations += records.length); observer.observe(body, { attributes: true, attributeFilter: ['style'] });
        for (let i = 0; i < 12; i++) { window.resizeWidth(i % 2 ? 1500 : preference === null ? 1660 : 1340); await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); }
        window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated.setting' })); await new Promise(requestAnimationFrame); observer.disconnect();
        return { mutations, before, after: body.style.cssText, content: document.querySelector('.ba-quiet-chat-column').getBoundingClientRect().width, input: document.querySelector('[data-fixture-input]').getBoundingClientRect().width, parent: body.parentElement.style.cssText, preference: localStorage.getItem('dsh.conversation.contentWidth') };
      }, preference);
      assert.equal(journal.mutations, 0, 'unchanged visible content width must cause no inherited style mutation');
      assert.equal(journal.before, journal.after); assert.equal(journal.content, preference === null ? 920 : 700); assert.equal(journal.input, journal.content + 32);
      assert.equal(journal.preference, preference); assert(!journal.parent.includes('--dsh-'), 'the adapter does not invalidate unrelated header siblings');
    }
    for (const [preference, width, expected] of [[null, 1200, 768], [null, 800, 680], ['2000', 1200, 1024], ['500', 800, 640], ['invalid', 1200, 768]]) {
      await page.evaluate(({ preference, width }) => { window.setPreference(preference); window.resizeWidth(width); }, { preference, width }); await settle(page);
      assert.equal(await page.locator('[data-conversation-content]').evaluate(body => body.style.getPropertyValue('--dsh-chat-content-width')), `${expected}px`);
      assert.equal(await page.evaluate(() => localStorage.getItem('dsh.conversation.contentWidth')), preference, 'viewport clamping never overwrites the stored preference');
    }
    await page.evaluate(() => { localStorage.setItem('dsh.conversation.contentWidth','900'); window.resizeWidth(1201); }); await settle(page);
    assert.equal(await page.locator('[data-conversation-content]').evaluate(body => body.style.getPropertyValue('--dsh-chat-content-width')), '900px', 'same-window native preference writes remain visible on resize without a storage event');
    for (const preference of [null, '2000']) {
      await page.evaluate(preference => { window.setPreference(preference); const body=document.querySelector('[data-conversation-content]'); body.style.paddingInline='32px'; document.querySelector('.fixture-column').style.fontSize='18px'; window.resizeWidth(1200); }, preference); await settle(page);
      const axes=await page.locator('[data-conversation-content]').evaluate(body => ({width:body.offsetWidth,axis:body.style.getPropertyValue('--dsh-chat-content-width')}));
      const expected=preference === null ? Math.max(680,Math.min(axes.width*.64,920)) : Math.max(640,axes.width-176);
      assert.equal(axes.axis,`${expected}px`,'font and padding changes keep the same native border-box width and preference clamp');
    }
    await page.evaluate(() => { window.prepareWidth(20, '812px'); window.resizeWidth(1500); window.toggleAdapter(false); const body=document.querySelector('[data-conversation-content]'); body.style.setProperty('--dsh-chat-content-width','812px','important'); window.toggleAdapter(true); }); await settle(page);
    await page.evaluate(() => window.toggleAdapter(false));
    assert.equal(await page.locator('[data-conversation-content]').evaluate(body => body.style.getPropertyValue('--dsh-chat-content-width')), '812px');
    assert.equal(await page.locator('[data-conversation-content]').evaluate(body => body.style.getPropertyPriority('--dsh-chat-content-width')), 'important', 'cleanup restores the original inline priority');
    await page.evaluate(() => { window.resizeWidth(1200); window.setPreference('700'); }); await settle(page);
    assert.equal(await page.locator('[data-conversation-content]').evaluate(body => body.style.getPropertyValue('--dsh-chat-content-width')), '812px', 'unmount removes both observer and storage listener');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('conversation resize retains bottom following, reading anchor, focus and draft across narrow and wide layouts', { skip: !executablePath }, async () => {
  const html = await fixture(), browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage({ viewport: { width: 1800, height: 1000 }, reducedMotion: 'reduce' }); await open(page, html);
    await page.evaluate(() => { window.setPreference(null); document.querySelector('.ba-chat-bottom-button').click(); }); await settle(page);
    for (const width of [1200, 1040, 1200, 800, 1500]) {
      await page.evaluate(width => window.resizeWidth(width), width); await settle(page);
      const distance = await page.locator('.ba-chat-feed').evaluate(feed => feed.scrollHeight - feed.clientHeight - feed.scrollTop);
      assert(distance <= 1, `resizing to ${width}px must retain the bottom lock; got ${distance}px`);
    }
    await page.locator('textarea').fill('保留草稿内容');
    await page.evaluate(() => { const row = document.querySelector('[data-chat-key="message:m100"]'); row.tabIndex = -1; row.scrollIntoView({ block: 'start' }); row.focus({ preventScroll: true }); }); await settle(page);
    const anchor = await page.locator('[data-chat-key="message:m100"]').evaluate(row => ({ top: row.getBoundingClientRect().top - row.closest('.ba-chat-feed').getBoundingClientRect().top }));
    for (const width of [1200, 1040, 800, 390, 1500]) {
      await page.evaluate(width => window.resizeWidth(width), width); await settle(page);
      const result = await page.locator('[data-chat-key="message:m100"]').evaluate(row => ({ top: row.getBoundingClientRect().top - row.closest('.ba-chat-feed').getBoundingClientRect().top, focused: document.activeElement === row }));
      assert(Math.abs(result.top - anchor.top) <= 1, `reading anchor moved at ${width}px: ${JSON.stringify({ result, anchor })}`); assert(result.focused);
      assert.equal(await page.locator('textarea').inputValue(), '保留草稿内容');
      if (captureDir && [390, 1500].includes(width)) {
        await mkdir(captureDir, { recursive: true });
        for (const dark of [false, true]) { await page.evaluate(dark => document.body.toggleAttribute('data-ds-dark-theme', dark), dark); await page.locator('.fixture-column').screenshot({ path: join(captureDir, `width-${width}-${dark ? 'dark' : 'light'}.png`) }); }
      }
    }
  } finally { await browser.close(); }
});
