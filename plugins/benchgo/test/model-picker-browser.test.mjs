import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url));
const { chromium } = require('playwright');
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || [chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);

test('model menu renders four states, reuses shared catalog reads and refreshes changed permissions', { skip: !executablePath }, async () => {
  const bundle = await build({ stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
    import {mountModelPicker} from './plugins/benchgo/client/model-picker.jsx';
    import {moduleSource} from './plugins/benchgo/client/modules.mjs';
    import hostCss from './plugins/benchgo/client/style.css';
    import tokens from './deepseek-harness/packages/client/ui-theme/src/styles/design-platform.css';
    const components={},events={},cleanups=[];
    const ctx={effect:fn=>cleanups.push(fn()),on:(event,fn)=>events[event]=fn,remote:{$on:(event,fn)=>events[event]=fn},slots:{inject:(_slot,fn)=>fn(),register:(entry,Component)=>components[entry.name]=Component}};
    mountModelPicker(ctx);moduleSource.update({base:true,harness:true});
    const groups=[{id:'Provider:Exact',name:'精确供应商',models:[{id:'Exact:Model/01',name:'测试模型',reasoning:{defaultEffort:'high',efforts:[{id:'off',name:'关闭'},{id:'low',name:'低'},{id:'high',name:'高'}]}}]}];
    const Picker=components['conversation.input.model'],Banner=components['conversation.input.dock'];
    window.selections=[];window.directoryReads=0;window.invalidate=()=>events['settings/document-updated']();
    function App(){const [directory,setDirectory]=useState({status:'ready',groups,failures:[],current:{provider:'Provider:Exact',model:'Exact:Model/01'}}),[visible,setVisible]=useState(true);
      window.empty=()=>setDirectory({status:'ready',groups:[],failures:[],current:null});
      window.showPicker=value=>flushSync(()=>setVisible(value));
      window.replaceModel=()=>flushSync(()=>setDirectory(current=>({...current,groups:[{...current.groups[0],models:[{...current.groups[0].models[0],id:'Exact/Model:02'}]}],current:{...current.current,model:'Exact/Model:02'}})));
      const props={available:true,useDirectory:()=>{window.directoryReads++;return directory},load:async()=>directory,binding:async()=>({bound:false}),select:async value=>{window.selections.push(value);if(window.failSelection){window.failSelection=false;return {ok:false,error:{message:'测试保存失败'}}}setDirectory(current=>({...current,current:value}));return {ok:true};},openSettingsSection(){}};
      return <><style>{tokens}{hostCss}</style><main><p>模型目录</p>{visible&&<Picker {...props}/>}<Banner {...props}/></main></>;
    }
    createRoot(document.getElementById('root')).render(<App/>);
  ` }, bundle: true, write: false, outdir: join(root, 'artifacts/unused-model-picker'), format: 'iife', jsx: 'automatic',
    nodePaths: [join(root, 'plugins/benchgo/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')],
    alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')) },
    loader: { '.css': 'text', '.svg': 'text' }, plugins: [{ name: 'official-picker-primitives', setup(build) {
      build.onResolve({ filter: /^@deepseek-ai\/dsh-client-ui-primitives$/ }, () => ({ path: 'primitives', namespace: 'official-source' }));
      build.onLoad({ filter: /.*/, namespace: 'official-source' }, () => ({ loader: 'ts', resolveDir: root, contents: `export {Tooltip} from './deepseek-harness/packages/client/ui-primitives/src/Tooltip.tsx';export * from './deepseek-harness/packages/client/ui-primitives/src/icons/index.tsx';` }));
    } }], define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>body{font-family:Arial,sans-serif;color:#202124;background:#fff;margin:0}main{padding:40px;max-width:600px}button,input{font:inherit}</style></head><body><div id="root"></div><script>${bundle.outputFiles.find(file => file.path.endsWith('.js')).text.replaceAll('</script', '<\\/script')}</script></body></html>`;
  const browser = await chromium.launch({ headless: true, executablePath });
  const screenshots = process.env.BENCHGO_MODEL_PICKER_SCREENSHOTS;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(7000);
    let requests = 0, fail = false, empty = false, release;
    let gate = new Promise(resolve => { release = resolve; });
    await page.route('**/*', async route => {
      if (route.request().url() === 'http://localhost/') return route.fulfill({ contentType: 'text/html', body: html });
      if (route.request().url().endsWith('/api/commander/tooling')) {
        requests++; await gate;
        return route.fulfill(fail ? { status: 503, json: { error: '目录服务暂时不可用' } } : { json: { tools: [], routes: [], providers: empty ? [] : [{ id: 'Provider:Exact', name: '精确供应商', tools: ['deepseek'] }] } });
      }
      return route.abort();
    });
    const shot = async name => { if (screenshots) await page.screenshot({ path: join(screenshots, `${name}.png`), animations: 'disabled' }); };
    await page.goto('http://localhost/');
    await page.locator('.cmd-model-trigger').click();
    await page.getByRole('status', { name: '正在加载模型目录' }).waitFor();
    assert.notEqual(await page.locator('.cmd-model-loading-overlay').evaluate(element => getComputedStyle(element).backgroundColor), 'rgba(0, 0, 0, 0)', 'initial loading surface does not overlap the pending options');
    assert.equal(requests, 1, 'picker and empty banner share the initial request'); await shot('loading');
    release();
    const dialog = page.getByRole('dialog', { name: '工具与模型' });
    await page.waitForFunction(() => document.querySelector('.cmd-model-popup')?.getAttribute('aria-busy') === 'false');
    await page.getByRole('button', { name: /精确供应商 1 个模型/ }).click();
    await page.getByRole('button', { name: '置顶模型', exact: true }).click();
    assert.equal(requests, 1, 'pinning is local');
    await page.keyboard.press('Escape'); await page.locator('.cmd-model-trigger').click();
    await page.waitForFunction(() => document.querySelector('.cmd-model-popup')?.getAttribute('aria-busy') === 'false');
    assert.equal(requests, 1, 'reopening reuses the successful catalog'); await shot('data');
    const cdp=await page.context().newCDPSession(page);await cdp.send('LayerTree.enable');await cdp.send('Performance.enable');
    await page.waitForTimeout(300);
    let paints=0;const painted=()=>paints++;cdp.on('LayerTree.layerPainted',painted);
    const idleStart=Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(item=>[item.name,item.value]));
    await page.waitForTimeout(700);
    const idleEnd=Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(item=>[item.name,item.value]));
    const idlePaints=paints;cdp.off('LayerTree.layerPainted',painted);
    await page.evaluate(()=>{window.directoryReads=0;window.effortGeometryReads=0;const read=Element.prototype.getBoundingClientRect;Element.prototype.getBoundingClientRect=function(){if(this.matches('.cmd-model-effort-track,.cmd-model-effort-rail'))window.effortGeometryReads++;return read.call(this)}});
    const track=page.getByRole('slider'),rect=await track.boundingBox(),y=rect.y+rect.height/2;
    await page.mouse.move(rect.x+16,y);await page.mouse.down();await page.mouse.move(rect.x+rect.width-16,y,{steps:30});
    assert.equal(await page.evaluate(()=>window.selections.length),0,'drag previews never submit intermediate protocol values');
    await page.mouse.up();
    assert.equal(await track.getAttribute('aria-valuenow'),'2');
    const drag=await page.evaluate(()=>({directoryReads:window.directoryReads,geometryReads:window.effortGeometryReads}));
    if(process.env.BENCHGO_MODEL_PICKER_PROBE){await writeFile(process.env.BENCHGO_MODEL_PICKER_PROBE,JSON.stringify({idlePaints,idleTaskMs:(idleEnd.TaskDuration-idleStart.TaskDuration)*1000,...drag},null,2))}
    else {assert(drag.directoryReads<=2,'drag preview stays out of the model directory render: '+JSON.stringify(drag));assert(drag.geometryReads<=3,'drag geometry is captured once: '+JSON.stringify(drag));assert.equal(await page.locator('.cmd-model-effort-ions').evaluateAll(nodes=>nodes.some(node=>node.getAnimations().some(animation=>animation.effect.getTiming().iterations===Infinity))),false,'decorative particles do not keep animating while idle');}
    gate = new Promise(resolve => { release = resolve; }); fail = true;
    await page.evaluate(() => window.invalidate());
    await page.getByText('正在更新模型目录…', { exact: true }).waitFor();
    assert.equal(await dialog.getByRole('button', { name: /精确供应商 1 个模型/ }).isDisabled(), true);
    assert.equal(await dialog.getByRole('slider').getAttribute('aria-disabled'), 'true');
    await shot('refreshing'); release();
    await page.getByRole('alert').filter({ hasText: '目录服务暂时不可用' }).waitFor(); await shot('error');
    fail = false;
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.cmd-model-popup')?.getAttribute('aria-busy') === 'false');
    assert.equal(requests, 3, 'one failed refresh and one explicit retry');
    await page.getByRole('button', { name: /精确供应商 1 个模型/ }).click();
    await page.getByRole('menuitemradio', { name: /测试模型/ }).click();
    assert.deepEqual(await page.evaluate(() => window.selections), [{ provider: 'Provider:Exact', model: 'Exact:Model/01', reasoningEffort: 'high' }]);
    await page.locator('.cmd-model-trigger').click();
    await page.waitForFunction(() => document.querySelector('.cmd-model-popup')?.getAttribute('aria-busy') === 'false');
    const slider=page.getByRole('slider'),bounds=await slider.boundingBox(),middle=bounds.x+bounds.width/2,center=bounds.y+bounds.height/2;
    await page.mouse.move(bounds.x+16,center);await page.mouse.down();await page.mouse.move(bounds.x+bounds.width-16,center,{steps:12});
    assert.equal(await page.evaluate(()=>window.selections.length),1,'preview never saves');
    await slider.evaluate(element=>{const box=element.getBoundingClientRect();element.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:1,clientX:box.left+16}));element.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:1,clientX:box.left+box.width/2}));});
    await page.mouse.up();
    await page.waitForFunction(()=>window.selections.length===2);
    assert.deepEqual(await page.evaluate(()=>window.selections.at(-1)),{provider:'Provider:Exact',model:'Exact:Model/01',reasoningEffort:'low'},'pointerup final position wins over a pending preview frame');
    await page.keyboard.press('Escape');await page.locator('.cmd-model-trigger').click();
    assert.equal(await slider.getAttribute('aria-valuetext'),'低','reopening retains the controlled saved effort');
    await slider.focus();await page.keyboard.press('Home');
    await page.waitForFunction(()=>window.selections.at(-1)?.reasoningEffort==='off');
    await page.keyboard.press('End');
    await page.waitForFunction(()=>window.selections.at(-1)?.reasoningEffort==='high');
    assert.deepEqual(await page.evaluate(()=>window.selections.slice(-2)),[{provider:'Provider:Exact',model:'Exact:Model/01',reasoningEffort:'off'},{provider:'Provider:Exact',model:'Exact:Model/01',reasoningEffort:'high'}]);
    await page.evaluate(()=>{window.failSelection=true});await page.keyboard.press('Home');
    await page.getByRole('alert').filter({hasText:'测试保存失败'}).waitFor();
    assert.equal(await slider.getAttribute('aria-valuetext'),'高','a failed save rolls back the preview');
    const savedCount=await page.evaluate(()=>window.selections.length);
    await page.mouse.move(middle,center);await page.mouse.down();
    await slider.evaluate(element=>{const id=1;element.dispatchEvent(new PointerEvent('pointercancel',{bubbles:true,pointerId:id}));window.cancelCaptured=element.hasPointerCapture(id)});
    await page.mouse.up();
    assert.equal(await page.evaluate(()=>window.cancelCaptured),false,'cancel releases pointer capture');
    assert.equal(await page.evaluate(()=>window.selections.length),savedCount,'cancel never submits');
    assert.equal(await slider.getAttribute('aria-valuetext'),'高');
    for(const [name,width,dark,reduced] of [['desktop-dark',1100,true,'no-preference'],['narrow-dark-reduced',390,true,'reduce'],['narrow-light',390,false,'no-preference']]){
      await page.setViewportSize({width,height:800});await page.emulateMedia({reducedMotion:reduced});
      await page.evaluate(dark=>{document.body.toggleAttribute('data-ds-dark-theme',dark);document.body.style.background=dark?'#19191b':'#fff';document.body.style.color=dark?'#ededee':'#202124'},dark);
      const surface=await dialog.boundingBox(),handle=await slider.boundingBox();
      assert(surface.x>=0&&surface.x+surface.width<=width+1,'model popup fits '+name);assert(handle.width>100,'effort control remains usable '+name);
      if(dark)assert.notEqual(await page.locator('.cmd-model-provider-card').evaluate(element=>getComputedStyle(element).backgroundColor),'rgb(255, 255, 255)','official dark tokens reach the popup');
      await shot(name);
    }
    await page.setViewportSize({width:1100,height:800});await page.emulateMedia({reducedMotion:'no-preference'});
    await page.evaluate(()=>{document.body.removeAttribute('data-ds-dark-theme');document.body.style.background='#fff';document.body.style.color='#202124';window.cancelledFrames=[];const cancel=window.cancelAnimationFrame;window.cancelAnimationFrame=id=>{window.cancelledFrames.push(id);cancel(id)}});
    const startPendingMove=async action=>{
      const box=await slider.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
      return slider.evaluate((element,action)=>{element.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:1,clientX:element.getBoundingClientRect().left+16}));const before=window.cancelledFrames.length;window[action](action==='showPicker'?false:undefined);return window.cancelledFrames.length-before},action);
    };
    assert.equal(await startPendingMove('showPicker'),1,'unmount cancels the queued drag frame');await page.mouse.up();
    assert.equal(await page.evaluate(()=>window.selections.length),savedCount,'unmount never submits a preview');
    await page.evaluate(()=>window.showPicker(true));await page.locator('.cmd-model-trigger').click();
    await page.waitForFunction(() => document.querySelector('.cmd-model-popup')?.getAttribute('aria-busy') === 'false');
    assert.equal(await startPendingMove('replaceModel'),1,'changing model identity cancels the queued drag frame');await page.mouse.up();
    assert.equal(await slider.getAttribute('aria-valuetext'),'高');assert.equal(await page.evaluate(()=>window.selections.length),savedCount);
    await page.keyboard.press('Escape');
    empty = true; await page.evaluate(() => { window.empty(); window.invalidate(); });
    await page.getByText('无模型可用，请先配置模型供应商', { exact: true }).waitFor();
    await page.locator('.cmd-model-trigger').click();
    await page.getByText('请先在模型设置中添加供应商', { exact: true }).waitFor(); await shot('empty');
    assert.equal(requests, 4); assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
