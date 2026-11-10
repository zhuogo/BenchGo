import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sharedUiStyles } from '../scripts/shared-ui.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url));
const { chromium } = require('playwright');
const { build } = createRequire(new URL('../package.json', import.meta.url))('esbuild');
const executablePath = [process.env.CHROMIUM_EXECUTABLE_PATH, chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(path => path && existsSync(path));

async function fixture() {
  const bundle = await build({ stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React from 'react';import {createRoot} from 'react-dom/client';
    import {ArtifactPreview} from './plugins/shared/client/artifact-preview.jsx';
    import {installIconSprite} from './deepseek-harness/packages/client/ui-theme/src/client/icon-sprite.ts';
    installIconSprite({effect:fn=>fn(),on:()=>{}},undefined);
    const root=createRoot(document.getElementById('root'));let serial=0;
    window.renderScenario=(mode='data',kind='md')=>{
      window.previewClosed=false;
      const file={name:'版本交付与回归检查记录-保留完整名称用于确认当前文件-2026-11-08.'+kind,url:'/files/content.'+kind+'?mode='+mode};
      root.render(<main key={++serial}><ArtifactPreview file={file} onClose={()=>{window.previewClosed=true;}}/></main>);
    };
  ` }, bundle: true, write: false, outdir: join(root, 'artifacts', 'unused-preview-browser'), format: 'iife', jsx: 'automatic',
    nodePaths: [join(root, 'plugins/benchgo/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')],
    alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')) },
    loader: { '.css': 'text', '.svg': 'text' }, plugins: [sharedUiStyles()], define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font:14px/1.5 Arial,sans-serif;--dsw-alias-bg-base:#fff;--dsw-alias-label-primary:#202124;--dsw-alias-label-secondary:#6b6b70;--ba-line:#ddd;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}body[data-ds-dark-theme]{--dsw-alias-bg-base:#19191b;--dsw-alias-label-primary:#ededee;--dsw-alias-label-secondary:#a3a3a8;--ba-line:#3b3b40}main{padding:24px;max-width:1000px;margin:auto;box-sizing:border-box}</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script></body></html>`;
}

test('file previews keep theme, long names, four states and recoverable media errors in the real browser', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const screenshots = process.env.BENCHGO_PREVIEW_SCREENSHOTS;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  try {
    const page = await browser.newPage(), errors = [];
    page.setDefaultTimeout(7000);page.on('pageerror', error => errors.push(error.message));
    const html = await fixture(), markdown = await readFile(join(root, 'plugins/benchgo/lib/preview/markdown.js'), 'utf8');
    let mediaAttempts = 0, textAttempts = 0;
    await page.route('**/*', route => {
      const url = new URL(route.request().url()), mode = url.searchParams.get('mode');
      if (url.href === 'http://localhost/') return route.fulfill({ contentType: 'text/html', body: html });
      if (url.pathname.endsWith('/markdown.js')) return route.fulfill({ contentType: 'application/javascript', body: markdown });
      if (mode === 'loading') return;
      if (url.pathname.endsWith('.png')) {
        if (++mediaAttempts === 1) return route.fulfill({ status: 503, body: 'offline' });
        return route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR1kAAAAASUVORK5CYII=', 'base64') });
      }
      if (mode === 'error' && ++textAttempts === 1) return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"文件服务暂时不可用"}' });
      if (mode === 'empty') return route.fulfill({ contentType: 'text/plain', body: '' });
      if (url.pathname.endsWith('.json')) return route.fulfill({ contentType: 'application/json', body: '{"状态":"已保存","文件":["文档","图像"]}' });
      return route.fulfill({ contentType: 'text/markdown', body: '# 交付记录\n\n保留完整文件名，清晰查看内容。\n\n> 这是一条备注。\n\n| 项目 | 状态 |\n| --- | --- |\n| 页面检查 | 完成 |\n\n```text\n完整内容仍可切换原文查看。\n```' });
    });
    await page.goto('http://localhost/');
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const dark of [false, true]) {
        await page.evaluate(value => document.body.toggleAttribute('data-ds-dark-theme', value), dark);
        for (const mode of ['loading', 'empty', 'error', 'data']) {
          textAttempts = 0;
          await page.evaluate(mode => window.renderScenario(mode), mode);
          if (mode === 'data') {
            const frame = page.frameLocator('iframe');
            await frame.getByRole('heading', { name: '交付记录' }).waitFor();
            const color = await frame.locator('body').evaluate(node => getComputedStyle(node).backgroundColor);
            assert.equal(color, dark ? 'rgb(25, 25, 27)' : 'rgb(255, 255, 255)');
            assert.equal(await page.locator('iframe').getAttribute('sandbox'), '');
          } else await page.getByText({ loading: '正在打开文件…', empty: '这个文件还是空的', error: '暂时无法预览' }[mode], { exact: true }).waitFor();
          assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}/${dark}/${mode} overflows`);
          if (screenshots) await page.screenshot({ path: join(screenshots, `${dark ? 'dark' : 'light'}-${width}-${mode}.png`), fullPage: true });
          if (mode === 'error') {
            await page.getByRole('button', { name: '重试', exact: true }).click();
            await page.frameLocator('iframe').getByRole('heading', { name: '交付记录' }).waitFor();
          }
        }
      }
    }
    await page.evaluate(() => document.body.removeAttribute('data-ds-dark-theme'));
    await page.waitForFunction(() => document.querySelector('iframe')?.srcdoc.includes('data-theme="light"'));
    await page.evaluate(() => { document.documentElement.dataset.theme='dark';document.body.style.setProperty('--dsw-alias-bg-base','#19191b'); });
    await page.waitForFunction(() => document.querySelector('iframe')?.srcdoc.includes('data-theme="dark"'));
    await page.getByRole('button', { name: '查看原文', exact: true }).click();
    await page.locator('.bg-preview-text').filter({ hasText: '# 交付记录' }).waitFor();
    assert.equal(await page.getByRole('button', { name: '查看预览', exact: true }).getAttribute('aria-pressed'), 'true');
    await page.getByRole('button', { name: '查看预览', exact: true }).click();
    await page.frameLocator('iframe').getByRole('heading', { name: '交付记录' }).waitFor();
    await page.evaluate(() => window.renderScenario('data', 'json'));
    await page.getByText('已保存', { exact: false }).waitFor();
    await page.evaluate(() => window.renderScenario('data', 'png'));
    await page.getByText('暂时无法预览', { exact: true }).waitFor();
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.bg-preview-media')?.getAttribute('aria-busy') === 'false');
    assert.equal(mediaAttempts, 2);
    await page.getByRole('button', { name: '← 返回', exact: true }).focus();
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => window.previewClosed), true);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
