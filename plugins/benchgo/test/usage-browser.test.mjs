import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UsageLedger } from '../src/usage.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url));
const { chromium } = require('playwright');
const { build } = createRequire(import.meta.url)('esbuild');
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || [chromium.executablePath(),
  'C:/Users/DraftGo/AppData/Local/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-win64/chrome-headless-shell.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);

async function fixture() {
  const result = await build({ stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React from 'react';import {createRoot} from 'react-dom/client';
    import {UsageDialog,UsageLauncher,mountUsageStyle} from './plugins/benchgo/client/usage.jsx';
    mountUsageStyle({effect:fn=>fn()});
    createRoot(document.getElementById('root')).render(<><UsageLauncher/><UsageDialog/></>);
  ` }, bundle: true, write: false, outdir: join(root, 'artifacts/unused-usage-browser'), format: 'iife', jsx: 'automatic',
    nodePaths: [join(root, 'plugins/benchgo/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')],
    alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')),
      '@deepseek-ai/dsh-client-ui-primitives': join(root, 'deepseek-harness/packages/client/ui-primitives/src/index.ts') },
    loader: { '.css': 'text', '.module.css': 'local-css', '.svg': 'text' }, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  const script = result.outputFiles.find(file => file.path.endsWith('.js')).text;
  const css = result.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
    :root{color-scheme:light;--dsw-alias-bg-base:#fafafa;--dsw-alias-bg-layer-1:#fff;--dsw-alias-label-primary:#242424;--dsw-alias-label-secondary:#797b83;--dsw-alias-state-business-primary:#4d6bfe}html[data-dark=true]{color-scheme:dark;--dsw-alias-bg-base:#191a1e;--dsw-alias-bg-layer-1:#202126;--dsw-alias-label-primary:#ededee;--dsw-alias-label-secondary:#a3a5af}body{margin:0;font-family:Arial,"Microsoft YaHei",sans-serif;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}${css}
    </style></head><body><div id="root"></div><script>${script.replaceAll('</script', '<\\/script')}</script></body></html>`;
}

test('usage dialog renders four states and every local-date preset keeps measured totals alongside missing history', { skip: !executablePath && 'Chromium/Edge required' }, async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  const screenshots = process.env.BENCHGO_USAGE_SCREENSHOTS;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  const ledger = new UsageLedger('/unused'), today = new Date(); today.setHours(0, 0, 0, 0);
  for (let day = 0; day < 30; day++) {
    const time = new Date(today); time.setDate(time.getDate() - day); time.setHours(12);
    ledger.put({ id: 'measured-' + day, tool: 'codex', model: 'Exact Model', time: time.toISOString(), inputTokens: 80, outputTokens: 20, totalTokens: 100, cacheReadTokens: 0 });
    if (day) ledger.put({ id: 'unknown-' + day, tool: 'other', time: time.toISOString() });
  }
  try {
    const html = await fixture(), errors = [];
    for (const width of [1440, 390]) for (const dark of [false, true]) for (const scenario of ['loading', 'error', 'empty', 'data']) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, timezoneId: 'Asia/Shanghai' });
      page.setDefaultTimeout(6000); page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', async route => {
        if (route.request().url() === 'http://localhost/') return route.fulfill({ contentType: 'text/html', body: html });
        if (route.request().url().endsWith('/api/commander/usage')) {
          if (scenario === 'loading') return;
          if (scenario === 'error') return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '用量服务暂不可用' }) });
          const data = (scenario === 'empty' ? new UsageLedger('/unused') : ledger).query(route.request().postDataJSON());
          return route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
        }
        return route.abort();
      });
      await page.goto('http://localhost/'); await page.evaluate(dark => document.documentElement.dataset.dark = dark, dark);
      await page.getByRole('button', { name: '用量统计', exact: true }).click();
      if (scenario === 'loading') await page.getByRole('status', { name: '正在加载用量统计…' }).waitFor();
      else if (scenario === 'error') { await page.getByRole('alert').filter({ hasText: '用量服务暂不可用' }).waitFor(); assert.equal(await page.getByRole('button', { name: '重试', exact: true }).count(), 1); }
      else if (scenario === 'empty') { await page.getByText('这个时间段还没有用量记录', { exact: true }).first().waitFor(); assert.equal(await page.locator('.cmd-usage-metric strong').first().innerText(), '未提供'); }
      else {
        for (const days of [1, 3, 7, 15, 30]) {
          await page.getByRole('button', { name: days === 1 ? '今天' : days + ' 天', exact: true }).click();
          await page.waitForFunction(expected => document.querySelector('.cmd-usage-metric strong')?.textContent === expected, new Intl.NumberFormat('zh-CN').format(days * 100));
          assert.equal(await page.locator('.cmd-usage-metric strong').nth(2).innerText(), '0.0%');
          if (days > 1) assert.equal(await page.getByText('部分记录未提供；仅汇总已知用量。', { exact: true }).count(), 1);
        }
        await page.getByRole('tab', { name: '详细使用记录', exact: true }).click();
        assert.equal(await page.getByRole('table', { name: '详细使用记录' }).locator('tbody tr').count(), 50);
        await page.getByRole('tab', { name: '概览', exact: true }).click();
      }
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (screenshots) {
        await page.evaluate(() => Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))));
        await page.screenshot({ path: join(screenshots, `${scenario}-${width}-${dark ? 'dark' : 'light'}.png`), fullPage: true });
      }
      await page.close();
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('usage loads cached ranges immediately, follows background import and stops requests when closed', { skip: !executablePath && 'Chromium/Edge required' }, async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  const ledger = new UsageLedger('/unused'), requests = [], pending = [];
  for (let index = 0; index < 123; index++) ledger.put({ id: 'usage-' + index, tool: 'codex', model: 'Exact Model', time: new Date().toISOString(), totalTokens: 100, inputTokens: 80, outputTokens: 20, cacheReadTokens: 0 });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, timezoneId: 'Asia/Shanghai' });
  page.setDefaultTimeout(6000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    const html = await fixture();
    await page.route('**/*', route => {
      if (route.request().url() === 'http://localhost/') return route.fulfill({ contentType: 'text/html', body: html });
      if (route.request().url().endsWith('/api/commander/usage')) { requests.push(route.request().postDataJSON()); pending.push(route); return; }
      return route.abort();
    });
    const response = async (coverage = {}, status = 200) => {
      await page.waitForFunction(() => document.querySelector('.cmd-usage')?.getAttribute('aria-busy') === 'true');
      for (let wait = 0; !pending.length && wait < 100; wait++) await page.waitForTimeout(20);
      const route = pending.shift(); assert(route, 'expected one pending usage request');
      return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(status === 200 ? { ...ledger.query(route.request().postDataJSON()), coverage } : { error: '暂时无法刷新' }) });
    };
    await page.goto('http://localhost/');
    await page.getByRole('button', { name: '用量统计', exact: true }).click();
    await response({ state: 'idle', historyState: 'scanning' });
    await page.getByText('正在同步历史用量，已采集数据会持续更新…', { exact: true }).waitFor();
    await page.waitForTimeout(1100);
    assert.equal(requests.length, 2);
    await response({ state: 'idle', historyState: 'complete' });
    await page.waitForFunction(() => !document.body.textContent.includes('正在同步历史用量，已采集数据会持续更新…'));
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '用量统计', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.cmd-usage-metric strong')?.textContent === '12,300');
    assert.equal(requests.length, 2, 'freshly cached complete range does not reload');
    await page.getByRole('tab', { name: '详细使用记录', exact: true }).click();
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    await response();
    await page.waitForFunction(() => document.querySelector('.cmd-usage-pagination span[aria-live]')?.textContent === '2 / 3');
    await page.getByRole('button', { name: '3 天', exact: true }).click();
    assert.equal(await page.locator('.cmd-usage-metric').count(), 0, 'a new range never displays totals from the previous range');
    await response();
    assert.equal(requests.length, 4, 'range change from page two requests page one only');
    assert.equal(requests.at(-1).page, 1);
    await page.getByRole('tab', { name: '概览', exact: true }).click();
    await page.getByRole('button', { name: '刷新用量统计', exact: true }).click();
    assert.equal(await page.locator('.cmd-usage-metric strong').first().textContent(), '12,300');
    await response({}, 503);
    await page.getByRole('alert').filter({ hasText: '暂时无法刷新' }).waitFor();
    assert.equal(requests.at(-1).refresh, true);
    assert.equal(await page.locator('.cmd-usage-metric strong').first().textContent(), '12,300');
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await response({ state: 'scanning' });
    assert.equal(requests.at(-1).refresh, undefined, 'retry reloads without triggering another full scan');
    await page.getByText('正在同步历史用量，已采集数据会持续更新…', { exact: true }).waitFor();
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    const beforeClose = requests.length;
    await page.waitForTimeout(1200);
    assert.equal(requests.length, beforeClose, 'closed dialogs stop background polling');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('an older range response cannot replace the active range even when transport ignores abort', { skip: !executablePath && 'Chromium/Edge required' }, async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, timezoneId: 'Asia/Shanghai' });
  page.setDefaultTimeout(6000);
  const ledger = new UsageLedger('/unused');
  ledger.put({ id: 'usage', tool: 'codex', time: new Date().toISOString(), totalTokens: 100 });
  let first, requestCount = 0;
  try {
    const html = await fixture();
    // Keep the old response deliverable to exercise the component's stale-result guard.
    await page.addInitScript(() => { const fetch = window.fetch; window.fetch = (url, options) => fetch(url, { ...options, signal: undefined }); });
    await page.route('**/*', route => {
      if (route.request().url() === 'http://localhost/') return route.fulfill({ contentType: 'text/html', body: html });
      if (route.request().url().endsWith('/api/commander/usage')) {
        requestCount++;
        if (requestCount === 1) { first = route; return; }
        const data = ledger.query(route.request().postDataJSON()); data.summary.totalTokens = 200;
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
      }
      return route.abort();
    });
    await page.goto('http://localhost/');
    await page.getByRole('button', { name: '用量统计', exact: true }).click();
    await page.getByRole('status', { name: '正在加载用量统计…' }).waitFor();
    for (let wait = 0; !first && wait < 100; wait++) await page.waitForTimeout(20);
    assert(first);
    await page.getByRole('button', { name: '3 天', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.cmd-usage-metric strong')?.textContent === '200');
    await first.fulfill({ contentType: 'application/json', body: JSON.stringify(ledger.query(first.request().postDataJSON())) });
    await page.waitForTimeout(150);
    assert.equal(await page.locator('.cmd-usage-metric strong').first().innerText(), '200');
    assert.equal(requestCount, 2);
  } finally { await browser.close(); }
});
