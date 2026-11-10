import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { sharedUiStyles } from '../scripts/shared-ui.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url));
const { chromium } = require('playwright');
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || [chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);

test('shared loading centers a single accessible phrase and beats graphemes in sequence without motion when reduced', { skip: !executablePath }, async () => {
  const result = await build({ stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
    import {Loading} from './plugins/shared/client/ui/loading.jsx';
    import {ResourceState} from './plugins/superagent/client/resource-state.jsx';
    import {DeviceLoading} from './plugins/link/client/device-loading.jsx';
    function App(){const [mode,setMode]=useState('loading');window.mode=setMode;return <main><section aria-label="资源状态">{mode==='data'?<p>已同步 3 项任务</p>:<ResourceState kind={mode} title={mode==='loading'?'正在读取任务':mode==='empty'?'暂无任务':'读取失败'} description="请稍候" onAction={mode==='error'?()=>setMode('loading'):undefined}/>}</section><section aria-label="设备加载"><DeviceLoading label="正在连接设备"/></section><section aria-label="字素测试"><Loading label="加载👩🏽‍💻中" compact/></section></main>};createRoot(document.getElementById('root')).render(<App/>);
  ` }, bundle: true, write: false, format: 'iife', jsx: 'automatic',
    alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')) },
    nodePaths: [join(root, 'plugins/benchgo/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')],
    loader: { '.css': 'text', '.svg': 'text' }, plugins: [sharedUiStyles()], define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 900 } });
    await page.setContent('<!doctype html><html><head><style>body{margin:0;font-family:"Segoe UI",sans-serif;background:var(--paper,#fff);color:var(--ink,#202124)}main{max-width:700px;margin:auto;padding:24px}section{border-bottom:1px solid #8883;--ba-line:#8883;--ba-muted:#777;--ba-surface:#8881;--ba-hover:#8882}body[data-ds-dark-theme]{--paper:#19191b;--ink:#ededee;--dsw-alias-bg-base:#19191b;--dsw-alias-label-primary:#ededee;--link-ink:#ededee}</style></head><body><div id="root"></div></body></html>');
    await page.addScriptTag({ content: result.outputFiles[0].text });
    const resource = page.getByRole('region', { name: '资源状态' });
    await resource.getByRole('status', { name: '正在读取任务' }).waitFor();
    assert.equal(await page.getByText('正在读取任务', { exact: true }).count(), 1, 'one visible full phrase stays discoverable');
    const glyphs = page.getByRole('region', { name: '字素测试' }).locator('.bg-loading-character');
    assert.deepEqual(await glyphs.allTextContents(), ['加', '载', '👩🏽‍💻', '中'], 'joined emoji is never split into separate animated pieces');
    const sequence = await glyphs.evaluateAll(nodes => nodes.map(node => Number.parseFloat(getComputedStyle(node).animationDelay)));
    assert(sequence.every((delay, index) => index === 0 || delay > sequence[index - 1]), 'left-to-right offsets increase');
    await page.getByRole('region', { name: '设备加载' }).getByRole('status', { name: '正在连接设备' }).waitFor();
    for (const dark of [false, true]) for (const width of [960, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(dark => document.body.toggleAttribute('data-ds-dark-theme', dark), dark);
      await page.evaluate(() => window.mode('loading'));
      const loading = resource.locator('.bg-loading');
      await loading.waitFor();
      const geometry = await loading.evaluate(node => { const a = node.getBoundingClientRect(), b = node.querySelector('.bg-loading-text').getBoundingClientRect(); return { deltaX: Math.abs(a.x + a.width / 2 - b.x - b.width / 2), deltaY: Math.abs(a.y + a.height / 2 - b.y - b.height / 2), background: getComputedStyle(node).backgroundColor, icons: node.querySelectorAll('svg,i').length, overflow: document.documentElement.scrollWidth > innerWidth }; });
      assert(geometry.deltaX < 1 && geometry.deltaY < 4 && !geometry.overflow, JSON.stringify(geometry));
      assert.equal(geometry.background, 'rgba(0, 0, 0, 0)'); assert.equal(geometry.icons, 0);
      if (process.env.BENCHGO_LOADING_SCREENSHOTS) { await mkdir(process.env.BENCHGO_LOADING_SCREENSHOTS, { recursive: true }); await page.screenshot({ path: join(process.env.BENCHGO_LOADING_SCREENSHOTS, `${dark ? 'dark' : 'light'}-${width}.png`) }); }
      for (const [mode, label] of [['empty', '暂无任务'], ['error', '读取失败'], ['data', '已同步 3 项任务']]) { await page.evaluate(mode => window.mode(mode), mode); await resource.getByText(label, { exact: true }).waitFor(); assert.equal(await resource.locator('.bg-loading').count(), 0); }
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(() => window.mode('loading'));
    assert.equal(await resource.locator('.bg-loading-character').first().evaluate(node => getComputedStyle(node).animationName), 'none');
    assert.equal(await resource.getByRole('status').getAttribute('aria-label'), '正在读取任务');
    assert.equal(await resource.locator('.bg-loading-text').getAttribute('aria-hidden'), 'true');
  } finally { await browser.close(); }
});
