import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sharedUiStyles } from '../scripts/shared-ui.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url));
const { chromium } = require('playwright');
const { build } = createRequire(new URL('../package.json', import.meta.url))('esbuild');
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || [chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);

test('vault keyboard flow reaches long-list editing, restores focus, recovers errors and cancels unmounted requests', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const bundle = await build({ stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React from 'react';import {createRoot} from 'react-dom/client';
    import {VaultSettingsSection} from './plugins/shared/client/vault-settings.jsx';
    import css from './plugins/superagent/client/style.css';import shellCss from './plugins/benchgo/client/style.css';
    const root=createRoot(document.getElementById('app'));let key=0;
    const originalFetch=window.fetch;window.signals=[];
    window.fetch=(url,options)=>{window.signals.push(options.signal);return originalFetch(url,options)};
    window.showVault=()=>root.render(<main className='ba-root'><style>{shellCss}{css}</style><section className='ba-studio-body'><VaultSettingsSection key={++key}/></section></main>);
    window.hideVault=()=>root.render(null);window.showVault();
  ` }, bundle: true, write: false, format: 'iife', jsx: 'automatic',
    nodePaths: [join(root, 'plugins/benchgo/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')],
    alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')) },
    loader: { '.css': 'text', '.svg': 'text' }, plugins: [sharedUiStyles()], define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  const browser = await chromium.launch({ headless: true, executablePath });
  const screenshots = process.env.BENCHGO_VAULT_SCREENSHOTS;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  try {
    const page = await browser.newPage();page.setDefaultTimeout(6000);await page.emulateMedia({ reducedMotion: 'reduce' });
    const errors = [];page.on('pageerror', error => errors.push(error.message));
    let mode = 'data', saveFails = false, pending;
    const entries = Array.from({ length: 18 }, (_, index) => ({ handle: `entry-${index}`, label: `项目凭据 ${index + 1}`, kind: 'key', target: `https://example.com/api/${index}`, method: 'POST', placement: 'header', field: 'Authorization', prefix: 'bearer', revision: 1, available: true }));
    await page.route('**/api/benchgo/vault', async route => {
      const input = route.request().postDataJSON();
      if (mode === 'loading' || mode === 'saving' && input.action === 'save') { pending = route;return; }
      if (mode === 'error' || saveFails && input.action === 'save') return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '保存连接暂时中断' }) });
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ entries: mode === 'empty' ? [] : entries }) });
    });
    await page.route('http://localhost/', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font-family:Arial,sans-serif}.ba-root{height:auto!important;min-width:0!important}.ba-studio-body{max-width:960px;margin:auto}body[data-ds-dark-theme]{--dsw-alias-label-primary:#ededee;--dsw-alias-label-secondary:#a3a3a8;--dsw-alias-bg-base:#19191b;background:#19191b;color:#ededee}</style></head><body><div id="app"></div></body></html>' }));
    await page.goto('http://localhost/');await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const add = page.getByRole('button', { name: '添加凭据', exact: true });
    const cancel = page.getByRole('button', { name: '取消', exact: true });
    const secret = page.locator('input[type=password]');
    const focused = locator => locator.evaluate(element => element === document.activeElement);
    const onscreen = locator => locator.evaluate(element => { const box = element.getBoundingClientRect();return box.top >= 0 && box.bottom <= innerHeight; });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 850 });
      await add.focus();await page.keyboard.press('Enter');
      const name = page.getByLabel('名称', { exact: true });await name.waitFor();
      assert(await focused(name));assert(await onscreen(name));
      await name.fill('未保存草稿');await cancel.click();
      assert(await focused(add));assert(await onscreen(add));
      const update = page.getByRole('button', { name: '更新', exact: true }).first();
      await update.focus();await page.keyboard.press('Enter');await secret.waitFor();
      assert(await focused(secret));assert(await onscreen(secret));assert.equal(await name.inputValue(), '项目凭据 1');
      await secret.fill('test-only-credential');saveFails = true;
      await page.getByRole('button', { name: '保存目标绑定' }).click();
      await page.getByRole('alert').waitFor();await page.waitForFunction(() => document.activeElement?.type === 'password');
      assert.equal(await secret.inputValue(), '');assert(await onscreen(secret));assert.equal(await name.inputValue(), '项目凭据 1');
      assert(await onscreen(page.getByRole('alert')));
      assert(await secret.getAttribute('aria-describedby').then(value => value.includes('error')));
      assert.equal(await page.locator('body').innerText().then(value => value.includes('test-only-credential')), false);
      if (screenshots) await page.screenshot({ path: join(screenshots, `vault-save-error-${width}.png`), animations: 'disabled' });
      await cancel.click();assert(await focused(update));assert(await onscreen(update));
      assert.equal(await page.getByRole('alert').count(), 0);saveFails = false;
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => theme === 'dark' ? document.body.setAttribute('data-ds-dark-theme', '') : document.body.removeAttribute('data-ds-dark-theme'), theme);
      for (const state of ['empty', 'loading', 'error', 'data']) {
        mode = state;await page.evaluate(() => window.showVault());
        if (state === 'loading') await page.getByLabel('正在加载凭据').waitFor();
        else if (state === 'error') await page.getByRole('alert').waitFor();
        else if (state === 'empty') await page.getByText('还没有凭据', { exact: true }).waitFor();
        else await page.getByText('项目凭据 1', { exact: true }).waitFor();
        assert.equal(await add.count(), 1);assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        if (screenshots) await page.screenshot({ path: join(screenshots, `vault-${theme}-${state}.png`), animations: 'disabled' });
        if (state === 'loading') { await page.evaluate(() => window.hideVault());assert(await page.evaluate(() => window.signals.at(-1).aborted));await pending.abort().catch(() => {}); }
      }
    }
    mode = 'data';await page.evaluate(() => window.showVault());
    const update = page.getByRole('button', { name: '更新', exact: true }).first();await update.click();await secret.fill('test-only-replacement');
    await page.getByRole('button', { name: '保存目标绑定' }).click();await page.getByText('凭据已保存，助手仅可使用绑定目标', { exact: true }).waitFor();
    assert(await focused(update));assert(await onscreen(update));assert.equal(await secret.count(), 0);
    await add.click();
    await page.getByLabel('名称', { exact: true }).fill('保存中卸载');await secret.fill('test-only-credential');await page.getByLabel('完整目标地址', { exact: false }).fill('https://example.com/exact');
    mode = 'saving';await page.getByRole('button', { name: '保存目标绑定' }).click();await page.getByRole('button', { name: '保存中…' }).waitFor();
    await page.evaluate(() => window.hideVault());assert(await page.evaluate(() => window.signals.at(-1).aborted));await pending.abort().catch(() => {});
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
