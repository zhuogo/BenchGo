import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sharedUiStyles } from '../../benchgo/scripts/shared-ui.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url));
const { chromium } = require('playwright');
const { build } = createRequire(new URL('../../benchgo/package.json', import.meta.url))('esbuild');
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || [chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);

test('execution summaries and timestamps use keyboard-accessible bubbles without native titles', { skip: !executablePath }, async () => {
  const result = await build({ stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React from 'react';import {createRoot} from 'react-dom/client';
    import {TaskExecution} from './plugins/superagent/client/task-execution.jsx';
    const summary='正在核对项目来源与构建状态。'.repeat(25);
    createRoot(document.getElementById('root')).render(<TaskExecution ticketStatus='open' execution={{observed:true,updatedAt:'2026-11-09T03:00:00Z',worker:{id:'worker',label:'核对项目来源与构建状态',status:'running',activity:summary,updatedAt:'2026-11-09T03:00:00Z'}}}/>);
  ` }, bundle: true, write: false, format: 'iife', jsx: 'automatic',
    nodePaths: [join(root, 'plugins/benchgo/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')],
    alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')) },
    loader: { '.css': 'text' }, plugins: [sharedUiStyles()], define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 700 }, reducedMotion: 'reduce' });
    await page.setContent('<!doctype html><html><body style="margin:0;font:14px/1.6 Arial,sans-serif"><main id="root" style="margin:18px"></main></body></html>');
    await page.addScriptTag({ content: result.outputFiles[0].text });
    const worker = page.locator('[data-worker-id=worker]');
    await worker.waitFor();
    assert.equal(await page.locator('.ba-task-execution [title]').count(), 0);
    await worker.focus();
    const bubble = page.getByRole('tooltip');
    await bubble.waitFor();
    assert.match(await bubble.innerText(), /正在核对项目来源与构建状态。.*最近活动：/s);
    const bounds = await bubble.boundingBox();
    assert(bounds.x >= 0 && bounds.x + bounds.width <= 391, 'long descriptions stay within the viewport');
    assert.equal(await worker.getAttribute('aria-describedby'), await bubble.getAttribute('id'));
    await page.keyboard.press('Escape');
    await bubble.waitFor({ state: 'hidden' });
    const timestamp = page.locator('.ba-execution-updated time');
    await timestamp.focus();
    await bubble.waitFor();
    assert.match(await bubble.innerText(), /2026/);
    await timestamp.blur();
    await bubble.waitFor({ state: 'hidden' });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  } finally { await browser.close(); }
});
