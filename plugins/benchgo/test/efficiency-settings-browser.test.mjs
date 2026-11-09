import { officialTooltipSource } from './official-tooltip-source.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { build } from 'esbuild';
import { sharedUiStyles } from '../scripts/shared-ui.mjs';

const require = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url));
const { chromium } = require('playwright');
const executablePath = existsSync(chromium.executablePath()) ? chromium.executablePath() : 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
test('execution settings render four states, save a single feature, reload, and surface conflicts', { skip: !existsSync(executablePath) }, async () => {
  const react = createRequire(new URL('../../../deepseek-harness/packages/client/ui-renderer/package.json', import.meta.url));
  const result = await build({ stdin: { contents: `
    import React from 'react';import {createRoot} from 'react-dom/client';
    import {EfficiencySettings} from './efficiency-settings.jsx';import css from './efficiency-settings.css';
    const style=document.createElement('style');style.textContent=css;document.head.append(style);
    window.calls=[];window.saved={revision:1,features:{ops:{enabled:true,available:true,state:'ready',shell:true},compaction:{enabled:true,available:false,state:'waiting_services'}}};
    async function read(body){window.calls.push(body);if(window.mode==='loading')return new Promise(()=>{});if(window.mode==='error')throw Error('服务不可用');if(window.mode==='empty')return {};
      if(body){if(window.conflict)throw Error('配置已变化，请刷新后重试');if(body.revision!==window.saved.revision)throw Error('stale revision');for(const [k,v] of Object.entries(body.features))Object.assign(window.saved.features[k],v,{available:v.enabled});window.saved.revision++;}
      return structuredClone(window.saved);}
    const root=createRoot(document.getElementById('app'));window.mount=key=>root.render(<EfficiencySettings key={key} read={read}/>);window.mount('first');
  `, resolveDir: fileURLToPath(new URL('../client/', import.meta.url)), loader: 'jsx' }, bundle: true, write: false, outdir: fileURLToPath(new URL('../../../artifacts/unused-feedback-test/', import.meta.url)), format: 'iife', jsx: 'automatic', loader: { '.css': 'text', '.module.css': 'local-css' }, nodePaths: [fileURLToPath(new URL('../node_modules/', import.meta.url))], alias: { react: dirname(react.resolve('react/package.json')), 'react-dom': dirname(react.resolve('react-dom/package.json')) }, plugins: [officialTooltipSource(), sharedUiStyles()], logLevel: 'silent' });
  const browser = await chromium.launch({ headless: true, executablePath });
  const output = fileURLToPath(new URL('../../../artifacts/efficiency-fusion/', import.meta.url)); await mkdir(output, { recursive: true });
  try {
    const page = await browser.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
    const open = async (mode, width = 1440) => {
      await page.setViewportSize({ width, height: 900 }); await page.goto('about:blank');
      await page.setContent('<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:Arial,sans-serif;padding:24px;margin:0}</style><div id="app"></div>');
      await page.evaluate(mode => { window.mode = mode; }, mode); await page.addStyleTag({content:result.outputFiles.filter(file=>file.path.endsWith('.css')).map(file=>file.text).join('\n')}); await page.addScriptTag({ content: result.outputFiles.find(file=>file.path.endsWith('.js')).text });
    };
    for (const [mode, text] of [['loading', '正在读取执行能力…'], ['empty', '宿主尚未提供执行增强状态。'], ['error', '服务不可用']]) {
      await open(mode); await page.getByText(text, { exact: true }).waitFor(); await page.screenshot({ path: output + mode + '.png', fullPage: true });
    }
    await open('data'); const ops = page.getByRole('switch', { name: '启用执行工具' }); await ops.waitFor();
    await ops.uncheck(); await page.getByText('设置已保存').waitFor();
    assert.deepEqual(await page.evaluate(() => window.calls.filter(Boolean)), [{ revision: 1, features: { ops: { enabled: false } } }]);
    assert.equal(await page.evaluate(() => window.saved.features.ops.shell), true);
    assert.equal(await page.getByRole('switch', { name: '启用上下文管理' }).isChecked(), true);
    await page.evaluate(() => window.mount('reload')); await ops.waitFor(); assert.equal(await ops.isChecked(), false);
    await page.evaluate(() => { window.conflict = true; }); await ops.click();
    await page.getByRole('alert').filter({ hasText: '配置已变化' }).waitFor(); assert.equal(await ops.isChecked(), false);
    await page.screenshot({ path: output + 'conflict-desktop.png', fullPage: true });
    await open('data', 390); await page.getByRole('switch', { name: '启用执行工具' }).waitFor();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: output + 'data-mobile.png', fullPage: true }); assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
