import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
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
    import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
    import {mountModelPicker} from './plugins/benchgo/client/model-picker.jsx';
    import {moduleSource} from './plugins/benchgo/client/modules.mjs';
    import hostCss from './plugins/benchgo/client/style.css';
    import tokens from './deepseek-harness/packages/client/ui-theme/src/styles/design-platform.css';
    const components={},events={},cleanups=[];
    const ctx={effect:fn=>cleanups.push(fn()),on:(event,fn)=>events[event]=fn,remote:{$on:(event,fn)=>events[event]=fn},slots:{inject:(_slot,fn)=>fn(),register:(entry,Component)=>components[entry.name]=Component}};
    mountModelPicker(ctx);moduleSource.update({base:true,harness:true});
    const groups=[{id:'Provider:Exact',name:'精确供应商',models:[{id:'Exact:Model/01',name:'测试模型',reasoning:{defaultEffort:'high',efforts:[{id:'high',name:'高'}]}}]}];
    const Picker=components['conversation.input.model'],Banner=components['conversation.input.dock'];
    window.selections=[];window.invalidate=()=>events['settings/document-updated']();
    function App(){const [directory,setDirectory]=useState({status:'ready',groups,failures:[],current:{provider:'Provider:Exact',model:'Exact:Model/01'}});
      window.empty=()=>setDirectory({status:'ready',groups:[],failures:[],current:null});
      const props={available:true,useDirectory:()=>directory,load:async()=>directory,binding:async()=>({bound:false}),select:async value=>{window.selections.push(value);return {ok:true};},openSettingsSection(){}};
      return <><style>{tokens}{hostCss}</style><main><p>模型目录</p><Picker {...props}/><Banner {...props}/></main></>;
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
    empty = true; await page.evaluate(() => { window.empty(); window.invalidate(); });
    await page.getByText('无模型可用，请先配置模型供应商', { exact: true }).waitFor();
    await page.locator('.cmd-model-trigger').click();
    await page.getByText('请先在模型设置中添加供应商', { exact: true }).waitFor(); await shot('empty');
    assert.equal(requests, 4); assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
