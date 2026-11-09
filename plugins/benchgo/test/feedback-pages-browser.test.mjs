import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { officialTooltipSource } from './official-tooltip-source.mjs';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url));
const { chromium } = require('playwright');
const { build } = createRequire(new URL('../package.json', import.meta.url))('esbuild');
const executablePath = [process.env.CHROMIUM_EXECUTABLE_PATH, chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(path => path && existsSync(path));

test('page tooltips retain exact selection values and SVG chart keyboard access across widths', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const result = await build({ stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React,{useState} from 'react';import{createRoot}from'react-dom/client';
    import{CustomSelect}from'./plugins/shared/client/custom-select.jsx';
    import{UsageCharts}from'./plugins/benchgo/client/usage-chart.jsx';
    import usageCss from'./plugins/benchgo/client/usage.css';
    const label='opaque:provider/model-with-complete-name-and-no-truncation-20261109';
    function App(){const[value,setValue]=useState('opaque:original');return <main><style>{usageCss}</style><div style={{width:180}}><CustomSelect aria-label='完整模型选择' value={value} onChange={value=>{window.chosen=value;setValue(value)}} options={[{value:'opaque:original',label},{value:'opaque:new/model',label:'另一个模型'}]}/></div><UsageCharts timeline={{interval:'day',buckets:[{time:'2026-11-08',calls:3,measuredCalls:2,totalTokens:1234}]}}/></main>}
    createRoot(document.getElementById('app')).render(<App/>);
  ` }, bundle: true, write: false, outdir: join(root, 'artifacts/unused-feedback-pages'), format: 'iife', jsx: 'automatic',
    alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')) },
    nodePaths: [join(root, 'plugins/benchgo/node_modules')], loader: { '.css': 'text', '.module.css': 'local-css' }, plugins: [officialTooltipSource()], define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  const browser = await chromium.launch({ headless: true, executablePath });
  const output = join(root, 'artifacts/feedback-pages-ui-20261109'); await mkdir(output, { recursive: true });
  try {
    const page = await browser.newPage(), errors = []; await page.emulateMedia({ reducedMotion: 'reduce' }); page.setDefaultTimeout(5000); page.on('pageerror', error => errors.push(error.message));
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 800 }); await page.goto('about:blank');
      await page.setContent('<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font:14px Arial,sans-serif;color:#202124;background:#fafafa;--dsw-radius-sm:6px;--dsw-alias-tooltip-bg:#303033;--dsw-static-neutral-bluish-00:#fff;--ds-ease-in-out:ease-in-out}main{max-width:1000px;padding:24px;margin:auto}</style><div id="app"></div>');
      await page.addStyleTag({ content: result.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n') });
      await page.addScriptTag({ content: result.outputFiles.find(file => file.path.endsWith('.js')).text });
      const picker = page.getByRole('button', { name: '完整模型选择' }); await picker.focus();
      await page.getByRole('tooltip').filter({ hasText: 'opaque:provider/model-with-complete-name-and-no-truncation-20261109' }).waitFor();
      await page.keyboard.press('ArrowDown'); await page.getByRole('listbox').waitFor();
      await page.keyboard.press('End'); await page.keyboard.press('Enter');
      assert.equal(await page.evaluate(() => window.chosen), 'opaque:new/model');
      await page.locator('.cmd-usage-chart-column').focus();
      await page.getByRole('tooltip').filter({ hasText: '2026-11-08：3 条记录，已知 Token 1,234，1 条未提供' }).waitFor();
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: join(output, `chart-tooltip-${width}.png`), fullPage: true });
      // Ordinary official focus tooltips close on blur; Escape is reserved for
      // openOnClick's pinned bubbles, which these chart hints do not request.
      await picker.focus(); await page.getByRole('tooltip').waitFor({ state: 'hidden' });
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
