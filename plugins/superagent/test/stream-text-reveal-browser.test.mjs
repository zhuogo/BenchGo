import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sharedUiStyles } from '../../benchgo/scripts/shared-ui.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const webRequire = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url));
const { chromium } = webRequire('playwright');
const { build } = createRequire(new URL('../../benchgo/package.json', import.meta.url))('esbuild');
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || [chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const captureDir = process.env.BENCHGO_STREAM_TEXT_SCREENSHOTS;

async function fixture() {
  const result = await build({
    stdin: { resolveDir: root, loader: 'jsx', contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { flushSync } from 'react-dom';
      import { AssistantReply } from './plugins/superagent/client/reply-images.jsx';
      import chatCss from './plugins/superagent/client/quiet-chat.css';
      import typographyCss from './plugins/shared/client/chat-typography.css';
      const app = createRoot(document.getElementById('root'));
      let text = '正文马上显示，追加部分轻柔呈现。', streaming = true, history = 0, parallel = false;
      window.drawText = (value = text, options = {}) => {
        text = value; streaming = options.streaming ?? streaming; history = options.history ?? history; parallel = options.parallel ?? parallel;
        flushSync(() => app.render(<div className="ba-root ba-official-conversation" data-assistant-chat=""><style>{chatCss}{typographyCss}</style>
          <div className="ba-chat-viewport"><div className="ba-chat-feed" data-assistant-scroll=""><section className="ba-quiet-chat"><div className="ba-quiet-chat-column">
          {Array.from({length: history}, (_, i) => <article key={i} className="ba-chat-message" data-role="assistant"><div className="ba-chat-body"><div className="ba-chat-content"><p>历史消息 {i}</p></div></div></article>)}
          <article className="ba-chat-message" data-testid="reply" data-role="assistant" data-streaming={streaming}><div className="ba-chat-body"><AssistantReply text={text} streaming={streaming}/></div></article>
          {parallel && [1,2].map(id=><article key={'parallel-'+id} className="ba-chat-message" data-role="assistant" data-streaming={streaming}><div className="ba-chat-body"><AssistantReply text={'分段 '+id+'。'+text} streaming={streaming}/></div></article>)}
          </div></section></div></div></div>));
        document.querySelector('[data-assistant-scroll]').scrollTop = 1e7;
      };
      window.unmountText = () => flushSync(() => app.unmount());
      window.drawText();
    ` },
    bundle: true, write: false, outdir: join(root, 'artifacts/unused-stream-text-output'), format: 'iife', jsx: 'automatic',
    nodePaths: [join(root, 'plugins/benchgo/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')],
    alias: { react: dirname(webRequire.resolve('react/package.json')), 'react-dom': dirname(webRequire.resolve('react-dom/package.json')), '@deepseek-ai/dsh-client-ui-primitives': join(root, 'deepseek-harness/packages/client/ui-primitives/src/index.ts') },
    loader: { '.css': 'text', '.module.css': 'local-css', '.svg': 'text', '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
    plugins: [sharedUiStyles()], define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
  });
  const themeRoot = join(root, 'deepseek-harness/packages/client/ui-theme/src/styles');
  const theme = (await Promise.all(['base.css', 'design-platform.css', 'focus.css'].map(name => readFile(join(themeRoot, name), 'utf8')))).join('\n');
  const css = result.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n');
  const js = result.outputFiles.find(file => file.path.endsWith('.js')).text.replaceAll('</script', '<\\/script');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${theme}${css}
    *{box-sizing:border-box}body{margin:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:14px/1.6 var(--dsw-font-family)}
    #root,.ba-official-conversation{height:100vh;display:flex;flex-direction:column;min-height:0}.ba-root{--dsh-composer-side-clearance:16px}
    </style><div id="root"></div><script>${js}</script></html>`;
}

const bubble = '[data-testid="reply"] .ba-chat-content';
const masks = '[data-stream-text-mask]';
async function settled(page, text, options) {
  await page.evaluate(({text, options}) => window.drawText(text, options), {text, options});
  await page.waitForTimeout(180);
}

test('streaming prose softens only the appended range without delaying or replacing the official text', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const browser = await chromium.launch({headless:true, executablePath});
  try {
    const page = await browser.newPage({viewport:{width:1440,height:800}}), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent(await fixture());
    await page.waitForTimeout(180);
    const state = await page.evaluate(() => {
      const root = document.querySelector('[data-testid="reply"] .ba-chat-content');
      window.originalParagraph = root.querySelector('p');
      const mutations = [];
      const observer = new MutationObserver(records => records.forEach(record => mutations.push({type:record.type,oldValue:record.oldValue})));
      observer.observe(root,{subtree:true,characterData:true,characterDataOldValue:true,childList:true});
      window.drawText('正文马上显示，追加部分轻柔呈现。这里是新追加的文字。');
      return new Promise(resolve => queueMicrotask(() => {
        observer.disconnect();
        const layer = root.querySelector('[data-stream-text-mask]');
        resolve({text:root.innerText, same:root.querySelector('p')===window.originalParagraph, layers:root.querySelectorAll('[data-stream-text-mask]').length,
          masks:layer?.children.length, animation:layer?.getAnimations({subtree:true})[0]?.effect.getTiming(), keyframes:layer?.getAnimations({subtree:true})[0]?.effect.getKeyframes(), mutations,
          gradient:layer?.querySelector('i')?.style.background,
          pointerEvents:layer&&getComputedStyle(layer).pointerEvents, hidden:layer?.getAttribute('aria-hidden')});
      }));
    });
    assert.equal(state.text,'正文马上显示，追加部分轻柔呈现。这里是新追加的文字。');
    assert.equal(state.same,true,'React retains its paragraph and selectable official text');
    assert.equal(state.layers,1,JSON.stringify(state));
    assert(state.masks>0 && state.masks<=8);
    assert.equal(state.animation.duration,180);
    assert.equal(state.animation.easing,'linear');
    assert.equal(state.keyframes[0].transform,'translateX(-24px)');
    assert.match(state.keyframes[1].transform,/^translateX\([\d.]+px\)$/);
    assert.match(state.gradient,/linear-gradient\(to right, (?:transparent|rgba\(0, 0, 0, 0\)), .* 24px,/);
    assert.equal(state.pointerEvents,'none'); assert.equal(state.hidden,'true');
    const rapid = await page.evaluate(async () => {
      window.drawText('正文马上显示，追加部分轻柔呈现。这里是新追加的文字。更多');
      await new Promise(queueMicrotask);
      const layer = document.querySelector('[data-stream-text-mask]');
      const old = layer?.lastElementChild;
      const animation = old?.getAnimations({subtree:true})[0];
      const oldRect = old?.getBoundingClientRect();
      window.drawText('正文马上显示，追加部分轻柔呈现。这里是新追加的文字。更多内容');
      await new Promise(queueMicrotask);
      const next = document.querySelector('[data-stream-text-mask]');
      const rect = next?.lastElementChild.getBoundingClientRect();
      return {layers:document.querySelectorAll('[data-stream-text-mask]').length,masks:next?.children.length,oldRetained:old?.isConnected,sameAnimation:old?.getAnimations({subtree:true})[0]===animation,onlySuffix:rect?.left>=oldRect?.right-.5};
    });
    assert.deepEqual(rapid,{layers:1,masks:3,oldRetained:true,sameAnimation:true,onlySuffix:true});
    await page.waitForTimeout(260);
    assert.equal(await page.locator(masks).count(),0,'the final frame removes its helper DOM');
    assert.equal(await page.locator(bubble).evaluate(node=>node.getAnimations({subtree:true}).length),0,'idle has no continuing animation');
    assert.deepEqual(errors,[]);
  } finally { await browser.close(); }
});

test('the final suffix and normal completion share one reveal which drains before history and can restart cleanly', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const browser = await chromium.launch({headless:true, executablePath});
  try {
    const page = await browser.newPage({viewport:{width:1440,height:800}}), errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.setContent(await fixture());
    await settled(page,'最后一段保持原位。');
    const final = await page.evaluate(async () => {
      const root=document.querySelector('[data-testid="reply"] .ba-chat-content');
      window.finalParagraph=root.querySelector('p');
      window.drawText('最后一段保持原位。最后几个字。',{streaming:false});
      await new Promise(queueMicrotask);
      const layer=root.querySelector('[data-stream-text-mask]');
      window.finalVeil=layer?.querySelector('i');
      window.finalAnimation=window.finalVeil?.getAnimations()[0];
      return {same:root.querySelector('p')===window.finalParagraph,text:root.innerText,layers:root.querySelectorAll('[data-stream-text-mask]').length,duration:window.finalAnimation?.effect.getTiming().duration};
    });
    assert.deepEqual(final,{same:true,text:'最后一段保持原位。最后几个字。',layers:1,duration:180});
    const history=await page.evaluate(()=>{
      window.drawText('最后一段保持原位。最后几个字。',{streaming:false});
      const root=document.querySelector('[data-testid="reply"] .ba-chat-content');
      return {same:root.querySelector('p')===window.finalParagraph,sameVeil:root.querySelector('i')===window.finalVeil,sameAnimation:window.finalVeil.getAnimations()[0]===window.finalAnimation};
    });
    assert.deepEqual(history,{same:true,sameVeil:true,sameAnimation:true});
    await page.waitForTimeout(260);
    assert.equal(await page.locator(masks).count(),0);
    assert.equal(await page.locator(bubble).getAttribute('data-stream-revealing'),null,'finished presentation releases its lifecycle');
    assert.equal(await page.locator(bubble).evaluate(node=>node.getAnimations({subtree:true}).length),0);
    await settled(page,'重新接续。',{streaming:true});
    const bounded=await page.evaluate(async()=>{
      let text='重新接续。';
      for(let i=0;i<14;i++){text+='新';window.drawText(text);await new Promise(queueMicrotask);}
      const layer=document.querySelector('[data-stream-text-mask]');
      return {layers:document.querySelectorAll('[data-stream-text-mask]').length,rects:layer?.children.length,text:document.querySelector('[data-testid="reply"] .ba-chat-content').innerText};
    });
    assert.deepEqual(bounded,{layers:1,rects:8,text:'重新接续。'+'新'.repeat(14)},'rapid output keeps at most eight active rects without buffering text');
    await page.evaluate(()=>window.unmountText());
    assert.equal(await page.locator(masks).count(),0,'unmount cancels instead of draining');
    assert.deepEqual(errors,[]);
  } finally {await browser.close();}
});

test('stream reveal cancels for interaction, reflow and reduced motion; completion drains and structured content stays native', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const browser = await chromium.launch({headless:true, executablePath});
  try {
    const page = await browser.newPage({viewport:{width:390,height:800}}), errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.setContent(await fixture());
    let value='可直接选中并复制的正文。';
    async function append() {
      value+='新增内容';
      return page.evaluate(async value=>{window.drawText(value);await new Promise(queueMicrotask);return document.querySelectorAll('[data-stream-text-mask]').length;},value);
    }
    await settled(page,value);
    assert.equal(await append(),1);
    await page.locator(bubble).dispatchEvent('pointerdown');
    assert.equal(await page.locator(masks).count(),0);
    await page.evaluate(()=>{const range=document.createRange();range.selectNodeContents(document.querySelector('[data-testid="reply"] p'));getSelection().addRange(range);});
    assert.equal(await append(),0,'selected prose is never covered');
    await page.evaluate(()=>getSelection().removeAllRanges());
    await settled(page,value,{history:2});
    await page.evaluate(()=>{const range=document.createRange();range.setStartBefore(document.querySelector('article'));range.setEndAfter(document.querySelector('[data-testid="reply"]'));getSelection().addRange(range);});
    assert.equal(await append(),0,'a selection spanning messages with both endpoints outside the bubble is preserved');
    await page.evaluate(()=>getSelection().removeAllRanges());
    assert.equal(await append(),1);
    await page.setViewportSize({width:340,height:800});
    await page.waitForTimeout(30);
    assert.equal(await page.locator(masks).count(),0,'reflow removes stale geometry');
    assert.equal(await append(),1);
    await page.evaluate(value=>window.drawText(value,{streaming:false}),value);
    assert.equal(await page.locator(masks).count(),1,'ordinary completion retains its last unfinished reveal');
    await page.waitForTimeout(260);
    assert.equal(await page.locator(masks).count(),0,'completed reveal cleans itself without an idle loop');
    await settled(page,value,{streaming:true});
    await page.emulateMedia({reducedMotion:'reduce'});
    assert.equal(await append(),0);
    await page.emulateMedia({reducedMotion:'no-preference'});
    for(const [before,after] of [
      ['强调文字','**强调文字追加**'],
      ['`code`','`codeMore`'],
      ['```js\nconst x = 1;\n```','```js\nconst x = 12;\n```'],
      ['| A | B |\n|---|---|\n| x | 1 |','| A | B |\n|---|---|\n| x | 12 |'],
      ['旧正文。','改写后的正文。'],
    ]) {
      await settled(page,before);
      await page.evaluate(after=>window.drawText(after),after);
      assert.equal(await page.locator(masks).count(),0,after);
    }
    await settled(page,'首段。');
    const listEntry=await page.evaluate(async()=>{
      window.drawText('首段。\n\n- 新列表');await new Promise(queueMicrotask);
      window.drawText('首段。\n\n- 新列表追加');await new Promise(queueMicrotask);
      return {masks:document.querySelectorAll('[data-stream-text-mask]').length,blockEntering:document.querySelector('[data-testid="reply"] ul').getAnimations().some(animation=>animation.animationName==='ba-chat-reveal'&&animation.playState==='running')};
    });
    assert.deepEqual(listEntry,{masks:0,blockEntering:true},'a list item does not stack a veil over its entering parent block');
    await settled(page,'正文。\n\n![图片](https://files.test/picture.png)\n\n[资料.zip](https://files.test/files.zip)');
    assert.equal(await page.getByRole('img').count(),1);
    assert.equal(await page.getByRole('link',{name:'打开 资料.zip'}).count(),1);
    await settled(page,'正文。');
    value='正文。'; assert.equal(await append(),1);
    await settled(page,value,{history:0,parallel:true});
    const concurrent=await page.evaluate(async value=>{window.drawText(value+'三个分段分别追加');await new Promise(queueMicrotask);return document.querySelectorAll('[data-stream-text-mask]').length;},value);
    assert.equal(concurrent,3,'separate streaming bubbles reveal independently');
    await page.waitForTimeout(260);
    assert.equal(await page.locator(masks).count(),0);
    assert.equal(await page.locator('article').evaluateAll(nodes=>nodes.flatMap(node=>node.getAnimations({subtree:true})).length),0,'all streaming controllers are idle after their last append');
    await page.evaluate(async value=>{window.drawText(value+'三个分段分别追加更多');await new Promise(queueMicrotask);},value);
    await page.evaluate(()=>window.unmountText());
    assert.equal(await page.locator(masks).count(),0);
    assert.deepEqual(errors,[]);
  } finally { await browser.close(); }
});

test('long histories do not participate in the tail reveal; light and dark mobile and desktop render correctly', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const browser = await chromium.launch({headless:true, executablePath});
  try {
    const page = await browser.newPage({viewport:{width:1440,height:800}}), errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.setContent(await fixture());
    if(captureDir) await mkdir(captureDir,{recursive:true});
    for(const history of [200,600]) for(const dark of [false,true]) for(const width of [1440,390]) {
      await page.setViewportSize({width,height:800});
      await page.evaluate(dark=>document.body.toggleAttribute('data-ds-dark-theme',dark),dark);
      const text='正在梳理结果。所有内容都会即时进入正文，新追加的文字轻柔呈现。';
      await settled(page,text,{history});
      const result=await page.evaluate(async text=>{
        const historyNodes=[...document.querySelectorAll('article')].slice(0,-1), mutations=[];
        const observer=new MutationObserver(records=>mutations.push(...records));
        historyNodes.forEach(node=>observer.observe(node,{childList:true,subtree:true,characterData:true,attributes:true}));
        window.drawText(text+'现在可以继续阅读这一段文字。');
        await new Promise(queueMicrotask); observer.disconnect();
        const masks=document.querySelectorAll('[data-stream-text-mask]');
        masks.forEach(layer=>layer.getAnimations({subtree:true}).forEach(animation=>{animation.pause();animation.currentTime=70;}));
        return {mutations:mutations.length,layers:masks.length,historyAnimations:historyNodes.reduce((sum,node)=>sum+node.getAnimations({subtree:true}).length,0),overflow:document.documentElement.scrollWidth>innerWidth};
      },text);
      assert.deepEqual(result,{mutations:0,layers:1,historyAnimations:0,overflow:false});
      if(captureDir) await page.screenshot({path:join(captureDir,`tail-${history}-${dark?'dark':'light'}-${width}.png`),fullPage:true});
    }
    assert.deepEqual(errors,[]);
  } finally { await browser.close(); }
});
