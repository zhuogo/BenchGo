import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { officialTooltipSource } from './official-tooltip-source.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url));
const { chromium } = require('playwright');
const executablePath = [process.env.CHROMIUM_EXECUTABLE_PATH, chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(path => path && existsSync(path));

test('shared selector scroll stays local, external reposition coalesces, and keyboard selection remains exact', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const result = await build({ stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React,{useState} from 'react';import{createRoot}from'react-dom/client';
    import{CustomSelect}from'./plugins/shared/client/custom-select.jsx';
    import{SegmentedControl}from'./plugins/shared/client/segmented-control.jsx';
    import{Disclosure}from'./plugins/shared/client/ui/collapsible.jsx';
    import tokens from './deepseek-harness/packages/client/ui-theme/src/styles/design-platform.css';
    import shellCss from './plugins/benchgo/client/style.css';
    const options=Array.from({length:600},(_,i)=>({value:'Opaque:Model/'+i,label:'模型 '+i}));
    function App(){const[value,setValue]=useState(options[0].value),[tab,setTab]=useState('a'),[mode,setMode]=useState('data'),[expanded,setExpanded]=useState(false);window.mode=setMode;
      return <main><style>{tokens}{shellCss}</style><SegmentedControl options={[{value:'a',label:'配置'},{value:'b',label:'操作记录'}]} value={tab} onChange={setTab} label='配置页面' panelId='settings'/>
        <section id='settings' role='tabpanel'>{mode==='error'&&<p role='alert'>读取失败，请重试</p>}
        <CustomSelect aria-label='模型' searchable allowCustom value={value} options={mode==='empty'?[]:options} disabled={mode==='loading'} onChange={next=>{window.chosen=next;setValue(next)}}/>
        {mode==='loading'&&<p role='status'>正在加载</p>}</section>
        <Disclosure title='高级选项'>{Array.from({length:100},(_,i)=><label key={i} style={{display:'block',padding:8}}>选项 {i}<input defaultValue={'值 '+i}/></label>)}</Disclosure>
        <button aria-expanded={expanded} onClick={()=>setExpanded(value=>!value)}>会话分组</button><div className='cmd-section-body' data-open={expanded} inert={expanded?undefined:''}><div className='cmd-section-inner'>{Array.from({length:100},(_,i)=><p key={i}>会话 {i}</p>)}</div></div><p>以下设置</p></main>}
    createRoot(document.getElementById('app')).render(<App/>);
  ` }, bundle: true, write: false, outdir: join(root, 'artifacts/unused-controls-test'), format: 'iife', jsx: 'automatic',
    alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')) },
    nodePaths: [join(root, 'plugins/benchgo/node_modules')], loader: { '.css': 'text', '.module.css': 'local-css' }, plugins: [officialTooltipSource()], define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  const browser = await chromium.launch({ headless: true, executablePath });
  const output = join(root, 'artifacts/performance-20261112/controls'); await mkdir(output, { recursive: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 850 } }), errors = [];
    page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(6000);
    await page.setContent('<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font:14px/1.5 Arial,sans-serif;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#222)}main{padding:24px;max-width:680px;margin:auto}body[data-dark]{--dsw-alias-bg-base:#19191b;--dsw-alias-label-primary:#ededee;--dsw-alias-label-tertiary:#aaa;--dsw-alias-border-l1:#666;--dsw-alias-interactive-bg-hover:#ffffff16}</style><div id="app"></div>');
    await page.addStyleTag({ content: result.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n') });
    await page.addScriptTag({ content: result.outputFiles.find(file => file.path.endsWith('.js')).text });
    const client=await page.context().newCDPSession(page);await client.send('Performance.enable');
    const readLayout=async()=>Object.fromEntries((await client.send('Performance.getMetrics')).metrics.map(item=>[item.name,item.value]));
    const before=await readLayout();await page.getByRole('button',{name:'高级选项',exact:true}).click();
    const disclosure=page.locator('.bg-ui-disclosure-content');await disclosure.waitFor();
    const animatedProperties=await disclosure.evaluate(async node=>{const animations=node.getAnimations(),properties=animations.flatMap(animation=>animation.effect.getKeyframes().flatMap(frame=>Object.keys(frame)));await Promise.allSettled(animations.map(animation=>animation.finished));return properties});
    const after=await readLayout();
    await writeFile(join(output,'disclosure-'+(process.env.BENCHGO_CONTROLS_VARIANT||'final')+'.json'),JSON.stringify({layoutCount:after.LayoutCount-before.LayoutCount,layoutMs:(after.LayoutDuration-before.LayoutDuration)*1000,animatedProperties:[...new Set(animatedProperties)]},null,2));
    assert(!animatedProperties.includes('height'),'expanding settings must not animate the layout of the entire page');
    await page.getByRole('button',{name:'高级选项',exact:true}).click();await disclosure.waitFor({state:'hidden'});
    const group=page.locator('.cmd-section-body'),toggle=page.getByRole('button',{name:'会话分组',exact:true});
    assert.equal(await group.evaluate(node=>getComputedStyle(node).transitionProperty),'opacity');
    await toggle.click();assert.equal(await toggle.getAttribute('aria-expanded'),'true');assert((await group.boundingBox()).height>1000);
    await toggle.click();assert.equal((await group.boundingBox()).height,0);
    const picker = page.getByRole('button', { name: '模型', exact: true }); await picker.click();
    await page.getByRole('option').last().waitFor();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const metrics = await page.evaluate(async () => {
      let reads=0;const original=Element.prototype.getBoundingClientRect;
      Element.prototype.getBoundingClientRect=function(){if(this.classList.contains('dowork-select'))reads++;return original.call(this)};
      try {
        const list=document.querySelector('.dowork-select-options');
        const started=performance.now();
        for(let i=0;i<30;i++){list.dispatchEvent(new Event('scroll'));await new Promise(requestAnimationFrame)}
        const internalReads=reads;reads=0;
        for(let i=0;i<30;i++)window.dispatchEvent(new Event('resize'));
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        return {internalReads,externalReads:reads,elapsedMs:performance.now()-started};
      } finally {Element.prototype.getBoundingClientRect=original}
    });
    await writeFile(join(output, (process.env.BENCHGO_CONTROLS_VARIANT || 'final') + '.json'), JSON.stringify(metrics,null,2));
    assert.equal(metrics.internalReads,0,'scrolling the menu must not remeasure its trigger or rerender all options');
    assert.equal(metrics.externalReads,1,JSON.stringify(metrics));
    const search = page.getByRole('combobox'); await search.press('End'); await search.press('Enter');
    assert.equal(await page.evaluate(()=>window.chosen),'Opaque:Model/599');
    await picker.click(); await page.getByRole('combobox').fill('Vendor:Exact / New'); await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(()=>window.chosen),'Vendor:Exact / New');
    await page.getByRole('tab',{name:'配置',exact:true}).focus(); await page.keyboard.press('ArrowRight');
    await page.getByRole('tab',{name:'操作记录',exact:true}).waitFor();
    assert.equal(await page.getByRole('tab',{name:'操作记录',exact:true}).getAttribute('aria-selected'),'true');
    assert.equal(await page.locator('.bg-segments-indicator').evaluate(node=>getComputedStyle(node).transitionProperty),'transform');
    for(const width of [1440,390])for(const dark of [false,true])for(const mode of ['empty','loading','error','data']){
      await page.setViewportSize({width,height:850});
      await page.evaluate(({dark,mode})=>{document.body.toggleAttribute('data-dark',dark);window.mode(mode)},{dark,mode});
      if(mode==='loading')await page.getByRole('status').waitFor();else if(mode==='error')await page.getByRole('alert').waitFor();else await picker.waitFor();
      if(mode!=='loading'){await picker.click();await page.getByRole('combobox').waitFor();await page.locator('.dowork-select-popup').evaluate(node=>Promise.allSettled(node.getAnimations().map(animation=>animation.finished)));}
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      await page.screenshot({path:join(output,`${dark?'dark':'light'}-${width}-${mode}.png`),fullPage:true});
      if(mode!=='loading'){await page.keyboard.press('Escape');await page.getByRole('combobox').waitFor({state:'hidden'});}
    }
    await page.emulateMedia({reducedMotion:'reduce'});await picker.click();await page.getByRole('combobox').waitFor();
    assert.equal(await page.locator('.dowork-select-popup').evaluate(node=>getComputedStyle(node).animationName),'none');
    await page.keyboard.press('Escape');assert.equal(await picker.evaluate(node=>document.activeElement===node),true);
    assert.deepEqual(errors,[]);
  } finally {await browser.close()}
});
